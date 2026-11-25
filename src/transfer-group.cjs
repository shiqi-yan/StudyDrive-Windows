const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { safeName } = require('./drive.cjs');
const { safeError, targetName } = require('./resume-download.cjs');

const at = async value => fs.lstat(value).catch(error => { if (error.code !== 'ENOENT') throw error; });
const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (first, second) => canonical(first) === canonical(second);
const problem = error => error.safe || error.status ? error.message : '无法处理此项目，请检查连接或本地文件后重试。';
const maxFile = 250 * 1024 ** 3;

function nameSegment(value) {
  const name = safeName(value);
  if (name !== value || name === '.' || name === '..') throw safeError('名称不能作为本地路径使用。');
  return name;
}
function within(base, ...parts) {
  const result = path.join(base, ...parts.map(nameSegment));
  const relative = path.relative(base, result);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw safeError('路径超出了所选目录。');
  }
  if (process.platform === 'win32' && result.length > 240) throw safeError('本地路径过长，请选择更短的目标路径。');
  return result;
}
async function plainDirectory(directory) {
  const stat = await at(directory);
  if (!stat?.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(directory), directory)) {
    throw safeError('本地目录已变化或含链接，已跳过该路径。');
  }
}
async function plainSource(filename, directory) {
  const stat = await at(filename);
  if (!stat || stat.isSymbolicLink() || !samePath(await fs.realpath(filename), filename) ||
      (directory ? !stat.isDirectory() : !stat.isFile())) throw safeError('本地项目已变化或是链接，已跳过。');
  return stat;
}
function entry(item, parent = null) {
  return { key: randomUUID(), parent, kind: item.kind, name: item.name, item, state: 'queued' };
}
const uploadEntry = (name, parent, parts, kind, stat) => ({
  key: randomUUID(), parent, parts, kind, name, state: 'queued',
  size: kind === 'file' ? stat.size : 0, mtime: stat.mtimeMs
});

async function uploadTree(directory, parent) {
  const root = await fs.realpath(directory);
  // A user-chosen starting folder may have ancestors with aliases, but the
  // selected entry itself must be an ordinary directory.
  const selected = await at(directory);
  if (!selected?.isDirectory() || selected.isSymbolicLink() || path.parse(root).root === root) {
    throw safeError('请选择普通文件夹作为上传根目录。');
  }
  const name = nameSegment(path.basename(root));
  return { mode: 'tree-upload', root, parent, entries: [uploadEntry(name, null, [], 'folder', selected)] };
}

async function downloadTree(directory, items) {
  const root = await fs.realpath(directory);
  await plainDirectory(root);
  return { mode: 'tree-download', root, entries: items.map(item => entry(item)) };
}

function counts(details, stopped = false) {
  const entries = details.entries;
  const result = { discovered: entries.length, complete: !!details.discovered, done: 0, failed: 0, canceled: 0 };
  for (const row of entries) {
    if (row.state === 'done') result.done += 1;
    else if (row.state === 'failed') result.failed += 1;
    else if (stopped) result.canceled += 1;
  }
  return result;
}

async function discover(details, drive, account, signal, update) {
  if (details.discovered) return;
  const upload = details.mode === 'tree-upload';
  const known = new Set(details.entries.map(row => upload ? JSON.stringify(row.parts) : row.item.id));
  for (let i = 0; i < details.entries.length; i += 1) {
    const row = details.entries[i];
    if (row.kind !== 'folder' || row.expanded || row.state === 'failed') continue;
    signal.throwIfAborted();
    if (upload) {
      const filename = within(details.root, ...row.parts);
      await plainDirectory(filename);
      const stream = await fs.opendir(filename);
      let added = 0;
      for await (const child of stream) {
        signal.throwIfAborted();
        const parts = [...row.parts, child.name];
        const key = JSON.stringify(parts);
        if (known.has(key)) continue;
        let local;
        try {
          const file = within(details.root, ...parts);
          const stat = await plainSource(file, child.isDirectory());
          local = uploadEntry(child.name, row.key, parts, stat.isDirectory() ? 'folder' : 'file', stat);
          if (stat.isFile() && stat.size > maxFile) throw safeError('文件超过 250 GB。');
        } catch (error) {
          local = { ...entry({ name: child.name, kind: 'unsupported' }, row.key), parts, problem: problem(error), state: 'failed', error: problem(error) };
        }
        details.entries.push(local);
        known.add(key);
        if (++added % 32 === 0) update();
      }
    } else {
      const visited = new Set();
      do {
        if (visited.has(row.next)) throw safeError('目录分页地址重复，已停止枚举。');
        visited.add(row.next);
        let result;
        try { result = await drive.list(account, { id: row.item.id, sort: 'name', next: row.next, signal }); }
        catch (error) {
          if (row.next && [400, 410].includes(error.status)) { row.next = null; update(); }
          throw error;
        }
        for (const item of result.items) {
          if (known.has(item.id)) continue;
          const found = entry(item, row.key);
          try {
            nameSegment(item.name);
            if (item.parentId && item.parentId !== row.item.id) throw safeError('目录结果不属于所选上级。');
            if (item.kind === 'shortcut') throw safeError('共享快捷方式不属于当前个人盘。');
          } catch (error) {
            found.state = 'failed';
            found.problem = found.error = problem(error);
          }
          details.entries.push(found);
          known.add(item.id);
        }
        row.next = result.next || null;
        if (!row.next) row.expanded = true;
        update();
        signal.throwIfAborted();
      } while (row.next);
    }
    row.expanded = true;
    update();
  }
  details.discovered = true;
  update();
}

async function localFolder(base, row, persist) {
  await plainDirectory(base);
  if (!row.localName) {
    for (let attempt = 0; attempt < 10000; attempt += 1) {
      const target = targetName(within(base, row.name), attempt);
      if (await at(target)) continue;
      row.localName = path.basename(target);
      persist();
      break;
    }
  }
  if (!row.localName) throw safeError('同名目录过多，请选择另一保存位置。');
  const folder = within(base, row.localName);
  await fs.mkdir(folder).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await plainDirectory(folder);
  return folder;
}

async function runGroup(queue, drive, account, job, details, signal) {
  const update = () => {
    job.summary = counts(details, job.state === 'canceled');
    queue.savePrivate();
    queue.notify();
  };
  const upload = details.mode === 'tree-upload';
  const batch = details.mode === 'batch';
  if (batch) details.discovered = true;
  else await discover(details, drive, account, signal, update);
  const byKey = new Map(details.entries.map(row => [row.key, row]));
  for (const row of details.entries) {
    signal.throwIfAborted();
    if (row.state !== 'queued') continue;
    const parent = row.parent && byKey.get(row.parent);
    try {
      if (row.problem || row.item?.selectionError) throw safeError(row.problem || row.item.selectionError);
      if (parent && parent.state !== 'done') throw safeError('上级文件夹未完成。');
      if (batch) {
        await queue.operate(drive, account, details.operation, row.item, details.args, signal);
      } else if (upload) {
        const filename = within(details.root, ...row.parts);
        const target = parent?.remote || details.parent;
        await plainSource(filename, row.kind === 'folder');
        if (row.kind === 'folder') {
          const existing = await queue.indexUpload(account, () => drive.ensureFolder(account, target, row.name, signal), target);
          row.remote = existing.id;
        } else {
          const task = { id: row.key, name: row.name, total: row.size, bytes: 0 };
          row.transfer ||= { filename, parent: target, mtime: row.mtime };
          if (!row.transfer.uploaded) {
            await queue.indexUpload(account, async () => {
              const result = await queue.upload(drive, account, task, row.transfer, signal);
              row.transfer.uploaded = true;
              delete row.transfer.session;
              update();
              return result;
            }, target);
          }
        }
      } else {
        const base = parent?.local || details.root;
        await plainDirectory(base);
        if (row.kind === 'folder') {
          row.local = await localFolder(base, row, update);
        } else {
          row.transfer ||= { filename: within(base, row.name), approvedDir: base, item: row.item };
          const task = { id: row.key, name: row.name, total: row.item.size, bytes: row.transfer.offset || 0 };
          if (row.restart) {
            await queue.restartDownload(drive, account, task, row.transfer, signal);
            row.restart = false;
          }
          await queue.get(drive, account, task, row.transfer, signal, () => {
            job.current = { name: row.name, bytes: task.bytes, total: task.total, notice: task.notice };
            queue.notify();
          });
          row.output = task.output;
        }
      }
      row.state = 'done';
      row.error = '';
      row.retryAt = 0;
    } catch (error) {
      signal.throwIfAborted();
      row.state = 'failed';
      row.error = problem(error);
      row.restartNeeded = !!error.restart;
      if (error.status === 429) {
        row.retryAt = job.retryAt = Date.now() + (error.retryAfter || 30000);
        update();
        break;
      }
    }
    job.current = null;
    update();
  }
  job.current = null;
  if (details.entries.some(row => row.state === 'failed')) throw safeError('部分项目未完成，可查看原因并重试。');
}

module.exports = { uploadTree, downloadTree, entry, counts, runGroup, problem, plainSource };
