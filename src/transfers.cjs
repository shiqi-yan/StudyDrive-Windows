const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const resume = require('./resume-download.cjs');
const group = require('./transfer-group.cjs');
const { safeName, statusError } = require('./drive.cjs');

const chunkSize = 16 * 320 * 1024;
const maxSize = 250 * 1024 ** 3;
const clone = job => ({
  id: job.id, direction: job.direction, name: job.name, bytes: job.bytes,
  total: job.total, state: job.state, error: job.error || '', started: job.started,
  ...(job.kind ? { kind: job.kind, summary: job.summary, current: job.current, operation: job.operation } : {}),
  notice: job.notice, restart: job.restart, retryAt: job.retryAt, output: job.output
});

class Transfers {
  constructor(store, changed, indexUpload = (_account, run) => run(), operate) {
    this.store = store;
    this.changed = changed;
    this.indexUpload = indexUpload;
    this.operate = operate;
    this.running = new Map();
    try { this.private = this.store.read('transfer-vault.bin', true) || {}; } catch { this.private = {}; }
  }
  attach(account, drive) {
    this.account = account;
    this.drive = drive;
    const library = this.store.account(account.id);
    for (const job of library.transfers) if (['queued', 'running'].includes(job.state)) job.state = 'paused';
    this.notify();
  }
  detach() {
    if (!this.account) return;
    const active = this.running.get(this.account.id);
    if (active) active.controller.abort('pause');
    this.account = null;
    this.drive = null;
  }
  list() { return this.account ? this.store.account(this.account.id).transfers.map(clone) : []; }
  notify() { this.store.save(); this.changed(); }
  vault(id) { return this.private[id] ||= {}; }
  savePrivate() { this.store.write('transfer-vault.bin', this.private, true); }
  add(job, details) {
    this.addJobs([{ job, details }]);
  }
  addJobs(entries) {
    if (!entries.length) return;
    const accountId = this.account.id;
    const library = this.store.account(accountId);
    const previous = library.transfers;
    const vault = this.vault(accountId);
    for (const { job, details } of entries) vault[job.id] = details;
    try {
      this.savePrivate();
      library.transfers = entries.map(({ job }) => job).reverse().concat(previous);
      this.store.save();
    } catch (error) {
      library.transfers = previous;
      for (const { job } of entries) delete vault[job.id];
      throw error;
    }
    this.changed();
  }
  async uploads(parent, paths) {
    const account = this.account;
    const list = [];
    for (const filename of paths) {
      const stat = await fsp.stat(filename).catch(() => null);
      if (!stat?.isFile()) throw new Error('无法读取选择的本地文件。');
      if (stat.size > maxSize) throw new Error('单个文件超过 250 GB。');
      list.push({ filename, stat, name: safeName(path.basename(filename)) });
    }
    if (account !== this.account) throw new Error('账户已切换。');
    this.addJobs(list.map(({ filename, stat, name }) => ({
      job: { id: randomUUID(), direction: 'upload', name, bytes: 0, total: stat.size, state: 'queued', started: Date.now() },
      details: { filename, parent, mtime: stat.mtimeMs }
    })));
    this.run();
    return list.length;
  }
  async download(item, filename) {
    const account = this.account;
    const approvedDir = await fsp.realpath(path.dirname(filename));
    if (account !== this.account) throw new Error('账户已切换。');
    filename = path.join(approvedDir, path.basename(filename));
    const id = randomUUID();
    this.add({ id, direction: 'download', name: item.name, bytes: 0, total: item.size, state: 'queued', started: Date.now() }, { item, filename, approvedDir });
    this.run();
  }
  async folderUpload(parent, directory) {
    const account = this.account;
    const details = await group.uploadTree(directory, parent);
    if (account !== this.account) throw new Error('账户已切换。');
    return this.addGroup('upload', details.entries[0].name, details);
  }
  async folderDownload(items, directory) {
    const account = this.account;
    const details = await group.downloadTree(directory, items);
    if (account !== this.account) throw new Error('账户已切换。');
    return this.addGroup('download', items.length === 1 ? items[0].name : '批量下载', details);
  }
  batch(operation, items, args) {
    const titles = { move: '批量移动', remove: '批量删除', restore: '还原项目' };
    return this.addGroup('batch', titles[operation], { mode: 'batch', operation, args, discovered: true,
      entries: items.map(item => group.entry(item)) });
  }
  addGroup(direction, name, details) {
    const id = randomUUID();
    this.add({ id, direction, kind: details.mode === 'batch' ? 'batch' : 'tree',
      operation: details.operation, name, bytes: 0, total: 0, state: 'queued', started: Date.now(),
      summary: group.counts(details) }, details);
    this.run();
    return id;
  }
  entries(id, offset) {
    const rows = this.account && this.vault(this.account.id)[id]?.entries;
    if (!rows) return { items: [], next: null };
    const ordered = [...rows.filter(row => row.state === 'failed'), ...rows.filter(row => row.state !== 'failed')];
    const canceled = this.store.account(this.account.id).transfers.find(job => job.id === id)?.state === 'canceled';
    const items = ordered.slice(offset, offset + 40).map(row => ({ id: row.key, name: row.name, kind: row.kind,
      state: canceled && row.state === 'queued' ? 'canceled' : row.state, error: row.error,
      restart: row.restartNeeded, output: row.output, retryAt: row.retryAt }));
    return { items, next: offset + items.length < rows.length ? offset + items.length : null };
  }
  async discard(drive, job, details) {
    if (!details) return;
    if (details.entries) {
      for (const row of details.entries) {
        if (!row.transfer) continue;
        if (job.direction === 'upload') await this.abandon(drive, row.transfer);
        if (job.direction === 'download') await resume.removePart({ id: row.key }, row.transfer);
      }
    } else if (job.direction === 'upload') await this.abandon(drive, details);
    else if (job.direction === 'download') await resume.removePart(job, details);
  }
  async action(id, action, entryId) {
    const account = this.account;
    const drive = this.drive;
    const library = this.store.account(account.id);
    const job = library.transfers.find(row => row.id === id);
    if (!job) throw new Error('传输任务不存在。');
    const running = this.running.get(account.id);
    const details = this.vault(account.id)[id];
    if (running?.job.id === id && running.controller.signal.aborted) return;
    if (['retry', 'restart', 'retry-entry', 'restart-entry'].includes(action) &&
        ['paused', 'failed', 'canceled'].includes(job.state) && details) {
      if (job.retryAt > Date.now()) throw new Error('OneDrive 正在限制请求，请稍后重试。');
      if (action === 'restart') {
        if (details.entries || job.direction !== 'download' || !job.restart) return;
        details.restart = true;
      }
      if (details.entries) {
        const failed = details.entries.filter(row => row.state === 'failed' && (!entryId || row.key === entryId));
        for (const row of failed) {
          if (row.problem || row.restartNeeded && action !== 'restart-entry') continue;
          row.state = 'queued';
          row.error = '';
          row.restart = action === 'restart-entry';
          if (row.restart) row.restartNeeded = false;
        }
      }
      delete job.retryAt;
      this.savePrivate();
      job.state = 'queued';
    } else if (action === 'pause' && ['queued', 'running'].includes(job.state)) {
      if (running?.job.id === id) running.controller.abort('pause');
      else job.state = 'paused';
    } else if (action === 'cancel' && job.state !== 'done') {
      if (running?.job.id === id) running.controller.abort('cancel');
      else {
        job.state = 'canceled';
        if (details?.session) await this.abandon(drive, details);
        if (details?.entries) job.summary = group.counts(details, true);
      }
    } else if (action === 'remove' && ['done', 'failed', 'paused', 'canceled'].includes(job.state) && running?.job.id !== id) {
      await this.discard(drive, job, details);
      delete this.vault(account.id)[id];
      this.savePrivate();
      library.transfers = library.transfers.filter(row => row.id !== id);
    }
    this.notify();
    this.run();
  }
  async abandon(drive, details) {
    const session = details.session;
    if (!session || details.sendingFinalPart && !details.uploaded) return;
    delete details.session;
    delete details.sendingFinalPart;
    this.savePrivate();
    try {
      const response = await drive.fetcher(drive.transferUrl(session.url), { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(4000) });
      await response.body?.cancel();
    } catch { /* An unreachable server session will expire automatically. */ }
  }
  run() {
    const account = this.account;
    const drive = this.drive;
    if (!account || this.running.has(account.id)) return;
    const job = this.store.account(account.id).transfers.findLast(row => row.state === 'queued');
    if (!job) return;
    const controller = new AbortController();
    this.running.set(account.id, { job, controller });
    const details = this.vault(account.id)[job.id];
    job.state = 'running';
    job.error = '';
    this.notify();
    this.perform(drive, account, job, details, controller.signal).finally(() => {
      this.running.delete(account.id);
      this.notify();
      this.run();
    }).catch(() => {});
  }
  async perform(drive, account, job, details, signal) {
    try {
      if (!details) throw new Error('本地传输资料无法恢复，请重新选择文件。');
      if (details.entries) await group.runGroup(this, drive, account, job, details, signal);
      else if (job.direction === 'upload') {
        if (!details.uploaded) await this.indexUpload(account, async () => {
          const result = await this.upload(drive, account, job, details, signal);
          details.uploaded = true;
          delete details.session;
          this.savePrivate();
          return result;
        }, details.parent);
      } else {
        if (details.restart) {
          await this.restartDownload(drive, account, job, details, signal);
          details.restart = false;
          this.savePrivate();
        }
        await this.get(drive, account, job, details, signal);
      }
      job.bytes = job.total;
      job.state = 'done';
      this.notify();
      if (!details.entries) {
        delete this.vault(account.id)[job.id];
        this.savePrivate();
      }
    } catch (error) {
      if (details?.entries) job.current = null;
      if (signal.reason === 'cancel') {
        if (details?.session) await this.abandon(drive, details);
        job.state = 'canceled';
        if (details?.entries) job.summary = group.counts(details, true);
      } else if (signal.reason === 'pause') job.state = 'paused';
      else {
        job.state = 'failed';
        job.error = error.safe || error.status ? error.message : '传输失败，请检查网络或本地文件后重试。';
        job.restart = !!error.restart;
        if (error.status === 429) job.retryAt = Date.now() + (error.retryAfter || 30000);
      }
    }
  }
  async upload(drive, account, job, details, signal) {
    const file = await fsp.open(details.filename, 'r');
    try {
      const stat = await file.stat();
      if (stat.size !== job.total || stat.mtimeMs !== details.mtime) {
        const error = new Error('源文件已更改，请重新选择上传。');
        error.safe = true;
        throw error;
      }
      if (!job.total) {
        if (details.sendingEmpty) throw resume.safeError('空文件上传结果未知，请先刷新目录核对。');
        details.sendingEmpty = true;
        this.savePrivate();
        try { return await drive.uploadEmpty(account, details.parent, job.name, signal); }
        catch (error) {
          if (error.status >= 400 && error.status < 500) { delete details.sendingEmpty; this.savePrivate(); }
          throw error;
        }
      }
      const fetchSession = async options => {
        signal.throwIfAborted();
        return drive.fetcher(drive.transferUrl(details.session.url), { ...options, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]) });
      };
      let position = 0;
      if (details.session) {
        const response = await fetchSession({ method: 'GET' });
        if ([404, 410].includes(response.status)) {
          await response.body?.cancel();
          if (details.sendingFinalPart) {
            const error = new Error('最终分片结果未知。请刷新目录核对，必要时重新选择文件。');
            error.safe = true;
            throw error;
          }
          delete details.session;
          this.savePrivate();
        } else position = await nextPosition(response, job.total);
      }
      if (!details.session) {
        delete details.sendingFinalPart;
        details.session = await drive.createSession(account, details.parent, job.name, signal);
        this.savePrivate();
      }
      job.bytes = position;
      this.notify();
      while (position < job.total) {
        signal.throwIfAborted();
        const length = Math.min(chunkSize, job.total - position);
        const part = Buffer.allocUnsafe(length);
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await file.read(part, filled, length - filled, position + filled);
          if (!bytesRead) throw new Error('Source ended during upload');
          filled += bytesRead;
        }
        if (position + length === job.total) {
          details.sendingFinalPart = true;
          this.savePrivate();
        }
        const put = await fetchSession({ method: 'PUT', headers: {
          'Content-Length': String(length), 'Content-Type': 'application/octet-stream',
          'Content-Range': 'bytes ' + position + '-' + (position + length - 1) + '/' + job.total
        }, body: part });
        if ([200, 201].includes(put.status)) {
          return await put.json().catch(() => null);
        }
        if ([404, 410].includes(put.status)) {
          delete details.sendingFinalPart;
          delete details.session;
          this.savePrivate();
        }
        const status = put.status === 416 ? await fetchSession({ method: 'GET' }) : put;
        if (status !== put) await put.body?.cancel();
        const next = await nextPosition(status, job.total);
        if (next <= position) throw new Error('Server upload position did not advance');
        position = next;
        job.bytes = position;
        this.notify();
      }
      throw new Error('OneDrive did not confirm upload completion');
    } finally { await file.close(); }
  }
  get(drive, account, job, details, signal, notify = () => this.notify()) {
    return resume.download(drive, account, job, details, signal, () => this.savePrivate(), notify);
  }
  restartDownload(drive, account, job, details, signal) {
    return resume.restart(drive, account, job, details, signal, () => this.savePrivate());
  }
}

async function nextPosition(response, total) {
  if (!response.ok) {
    await response.body?.cancel();
    const error = statusError(response.status);
    error.safe = true;
    throw error;
  }
  const data = await response.json();
  // Adapted from ilist's validatedNextExpectedRanges (MIT, copyright 2026 Chius).
  const ranges = data?.nextExpectedRanges;
  if (!Array.isArray(ranges) || ranges.some(range => typeof range !== 'string')) throw new Error('Invalid OneDrive upload ranges');
  const positions = ranges.map(range => /^\d+-\d*$/.test(range) ? Number(range.split('-')[0]) : NaN);
  if (positions.some(position => !Number.isSafeInteger(position))) throw new Error('Invalid OneDrive upload ranges');
  const next = Math.min(...positions);
  if (next < 0 || next >= total) throw new Error('Invalid OneDrive upload offset');
  return next;
}

module.exports = { Transfers, chunkSize, nextPosition };
