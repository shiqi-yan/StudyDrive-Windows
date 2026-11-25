const path = require('node:path');
const { Worker } = require('node:worker_threads');

const interval = 5 * 60_000;
const cancelled = () => new Error('搜索已取消。');
const unavailable = () => new Error('本地索引暂时无法读取。');
const keyOf = account => JSON.stringify([account.id, account.driveId]);

class IndexWorker {
  constructor(filename) {
    this.filename = filename;
    this.requests = new Map();
    this.sequence = 0;
  }
  open() {
    const worker = new Worker(path.join(__dirname, 'drive-index-worker.cjs'), { workerData: this.filename });
    this.worker = worker;
    worker.unref();
    worker.on('message', ({ request, result, error }) => {
      const reply = this.requests.get(request);
      if (!reply) return;
      this.requests.delete(request);
      if (error) reply.reject(unavailable());
      else reply.resolve(result);
    });
    const failed = () => {
      if (this.worker !== worker) return;
      this.worker = null;
      for (const request of this.requests.values()) request.reject(unavailable());
      this.requests.clear();
    };
    worker.on('error', failed);
    worker.on('exit', failed);
    return worker;
  }
  call(operation, ...args) {
    return new Promise((resolve, reject) => {
      const worker = this.worker || this.open();
      const request = ++this.sequence;
      this.requests.set(request, { resolve, reject });
      try { worker.postMessage({ request, operation, args }); }
      catch { this.requests.delete(request); reject(unavailable()); }
    });
  }
  close() { return this.worker?.terminate(); }
}

class DriveIndex {
  constructor(filename, changed, { online = () => true, worker } = {}) {
    this.db = worker || new IndexWorker(filename);
    this.changed = changed;
    this.online = online;
    this.jobs = new Map();
    this.intents = new Map();
    this.states = new Map();
    this.statusAt = new Map();
  }
  select(account, drive) {
    clearTimeout(this.timer);
    this.cancelSearch();
    const previous = this.current;
    this.current = account ? { account, drive, key: keyOf(account) } : null;
    if (previous) this.jobs.get(previous.key)?.controller.abort();
  }
  schedule(delay, options) {
    clearTimeout(this.timer);
    if (!this.current) return;
    this.timer = setTimeout(() => this.refresh(options), Math.max(0, Math.min(delay, 2147483647)));
    this.timer.unref?.();
  }
  async publish(current, active = false) {
    const status = await this.db.call('status', current.account);
    this.states.set(current.key, status);
    const now = Date.now();
    if (this.current === current && (!active || now - (this.statusAt.get(current.key) || 0) >= 350)) {
      this.statusAt.set(current.key, now);
      this.changed(status);
    }
    return status;
  }
  status(account) { return this.db.call('status', account); }
  refresh({ manual = false, rebuild = false } = {}) {
    const current = this.current;
    if (!current) return;
    const job = this.jobs.get(current.key);
    if (job) {
      if (job.current !== current || rebuild || manual && this.states.get(current.key)?.dirty) {
        job.after = { manual: true, rebuild: rebuild || job.after?.rebuild };
        if (rebuild) job.controller.abort();
      }
      return job.task;
    }
    const controller = new AbortController();
    const running = { current, controller, task: null };
    running.task = this.sync(current, controller.signal, manual, rebuild).catch(() => {
      if (current !== this.current || controller.signal.aborted) return;
      this.changed({ phase: 'unavailable', complete: false, count: 0 });
      this.schedule(interval);
    }).finally(() => {
      this.jobs.delete(current.key);
      if (running.after && this.current?.key === current.key) this.refresh(running.after);
    });
    this.jobs.set(current.key, running);
    return running.task;
  }
  async sync(current, signal, manual, rebuild) {
    const { account, drive } = current;
    const initial = await this.status(account);
    signal.throwIfAborted();
    const now = Date.now();
    const online = this.online();
    // Retry-After also applies to a manual refresh and survives a restart.
    if (initial.retryAt > now && (initial.phase === 'throttled' || !manual && !rebuild)) {
      await this.publish(current);
      if (current === this.current) this.schedule(initial.retryAt - now);
      return;
    }
    if (online && !manual && !rebuild && !initial.dirty && initial.phase === 'ready' && initial.updated > now - interval) {
      if (current === this.current) this.schedule(initial.updated + interval - now);
      return;
    }
    let recovery = false;
    try {
      if (!online) throw Object.assign(new Error('Offline'), { offline: true });
      let checkpoint = await this.db.call('begin', account, drive.deltaStart(account), { force: rebuild, restart: rebuild });
      await this.publish(current);
      const visited = new Set();
      while (checkpoint) {
        signal.throwIfAborted();
        if (visited.has(checkpoint)) throw new Error('Repeated Delta page');
        visited.add(checkpoint);
        let page;
        try { page = await drive.deltaPage(account, checkpoint, signal); }
        catch (error) {
          if (error.status !== 410 || recovery) throw error;
          recovery = true;
          visited.clear();
          checkpoint = await this.db.call('begin', account, error.restart || drive.deltaStart(account), { restart: true });
          await this.publish(current);
          continue;
        }
        signal.throwIfAborted();
        await this.db.call('page', account, checkpoint, page.items, page.next, page.delta);
        checkpoint = page.next;
        if (checkpoint && Date.now() - (this.statusAt.get(current.key) || 0) >= 350) await this.publish(current, true);
      }
      const pending = await this.db.call('pending', account);
      for (const row of pending) {
        signal.throwIfAborted();
        let raw;
        try { raw = await drive.indexItem(account, row.id, signal); }
        catch (error) {
          if (error.status !== 404) throw error;
          raw = { id: row.id, deleted: {} };
        }
        await this.db.call('reconcile', account, row, raw);
      }
      if (!this.intents.get(current.key)) await this.db.call('recoverIntents', account);
      const finished = await this.publish(current);
      if (current === this.current) this.schedule(finished.dirty ? 15_000 : interval);
    } catch (error) {
      if (signal.aborted) return;
      const previous = this.states.get(current.key) || initial;
      const retryAfter = Number.isFinite(error.retryAfter) && error.retryAfter >= 0 ? error.retryAfter : 60_000;
      const delay = error.status === 429 ? Math.max(1_000, retryAfter)
        : Math.min(interval, 15_000 * 2 ** Math.min(previous.failures || 0, 5));
      const phase = error.status === 429 ? 'throttled' : error.offline || !this.online() ? 'offline' : 'failed';
      await this.db.call('fail', account, phase, Date.now() + delay);
      await this.publish(current);
      if (current === this.current) this.schedule(delay);
    }
  }
  async mutate(account, run, metadata, deleted = false) {
    const key = keyOf(account);
    this.intents.set(key, (this.intents.get(key) || 0) + 1);
    let sequence;
    try {
      // Durable intent precedes Graph. A failed local acknowledgement is recovered by Delta.
      sequence = await this.db.call('intent', account).catch(() => null);
      const result = await run();
      const item = metadata(result);
      if (sequence && item?.id) {
        try { await this.db.call('mutation', account, sequence, item, deleted); }
        catch { /* The next Delta pass will collect the already committed cloud change. */ }
      }
      return result;
    } finally {
      const count = this.intents.get(key) - 1;
      if (count) this.intents.set(key, count);
      else this.intents.delete(key);
      const current = this.current;
      if (current?.key === key) {
        this.publish(current).catch(() => {});
        // A just-confirmed mutation should trigger a pass even when the last one is fresh.
        this.schedule(1000, { manual: true });
      }
    }
  }
  cancelSearch() {
    if (this.query) this.query.reject(cancelled());
    if (this.queued) this.queued.reject(cancelled());
    this.queued = null;
  }
  search(account, input) {
    this.cancelSearch();
    return new Promise((resolve, reject) => {
      this.queued = { account, input, resolve, reject };
      this.drainQueries();
    });
  }
  drainQueries() {
    if (this.query || !this.queued) return;
    const next = this.query = this.queued;
    this.queued = null;
    this.db.call('search', next.account, next.input).then(next.resolve, next.reject).finally(() => {
      this.query = null;
      this.drainQueries();
    });
  }
  trashRecord(account, item, path) { return this.db.call('trashRecord', account, item, path); }
  setTrash(account, id, state, expected) { return this.db.call('setTrash', account, id, state, expected); }
  trashRows(account, id) { return this.db.call('trashRows', account, id); }
  trail(account, folder) { return this.db.call('trail', account, folder); }
  close() {
    this.select(null, null);
    return this.db.close();
  }
}

module.exports = { DriveIndex };
