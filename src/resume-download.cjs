const fs = require('node:fs/promises');
const path = require('node:path');
const { fetchContent } = require('./media.cjs');
const { statusError } = require('./drive.cjs');

const checkpointStep = 4 * 1024 ** 2;
const safeError = (message, fields = {}) => Object.assign(new Error(message), { safe: true, ...fields });
const ownFile = stat => stat.isFile() && !stat.isSymbolicLink();
const identity = stat => stat.dev.toString() + ':' + stat.ino.toString();
const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
const statPath = value => fs.lstat(value, { bigint: true }).catch(error => { if (error.code !== 'ENOENT') throw error; });
const resolvedParent = async filename => fs.realpath(path.dirname(filename));

function partPath(job, details) {
  if (!/^[0-9a-f-]{36}$/i.test(job.id) || !path.isAbsolute(details.filename)) throw safeError('本地传输目标无效。');
  return path.join(path.dirname(details.filename), '.studydrive-' + job.id + '.part');
}
async function validateParent(details) {
  const actual = await resolvedParent(details.filename);
  if (!details.approvedDir || comparable(actual) !== comparable(details.approvedDir)) {
    throw safeError('保存目录已变化，已停止写入。');
  }
}
async function removePart(job, details) {
  if (!details?.partialIdentity) return;
  await validateParent(details);
  const part = partPath(job, details);
  const stat = await statPath(part);
  if (stat && ownFile(stat) && identity(stat) === details.partialIdentity) await fs.unlink(part);
}
function sameVersion(expected, found) {
  return found.id === expected.id && found.driveId === expected.driveId &&
    found.size === expected.size && found.version === expected.version &&
    (!expected.etag || !found.etag || found.etag === expected.etag);
}
async function verifyRemote(drive, account, details, signal) {
  const item = await drive.get(account, details.item.id, signal);
  if (!sameVersion(details.item, item)) throw safeError('云端文件版本已改变，旧分段已保留。请重启下载以获取新版。', { restart: true });
  return item;
}
function targetName(filename, attempt) {
  if (!attempt) return filename;
  const parsed = path.parse(filename);
  const stem = Array.from(parsed.name).slice(0, Math.max(1, 200 - parsed.ext.length)).join('');
  return path.join(parsed.dir, stem + ' (' + attempt + ')' + parsed.ext);
}
async function publish(job, details, partial, save) {
  await validateParent(details);
  for (let attempt = details.publishAttempt || 0; attempt < 10000; attempt += 1) {
    const target = targetName(details.filename, attempt);
    const existing = await statPath(target);
    if (existing && !ownFile(existing)) continue;
    // Save the chosen destination before the atomic no-replace link. A crash on
    // either side of link() is recoverable by comparing the file identities.
    details.publishAttempt = attempt;
    save();
    try {
      if (!existing) await fs.link(partial, target);
      else if (identity(existing) !== details.partialIdentity) continue;
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      if (['EPERM', 'ENOTSUP', 'EXDEV', 'EOPNOTSUPP'].includes(error.code)) {
        throw safeError('此目标不支持安全的原子下载，请改用另一保存位置。');
      }
      throw error;
    }
    details.published = true;
    job.output = path.basename(target);
    save();
    await removePart(job, details).catch(() => {});
    return;
  }
  throw safeError('同名文件过多，请选择另一保存位置。');
}

async function download(drive, account, job, details, signal, save, notify) {
  if (details.item.driveId !== account.driveId) throw safeError('下载项目不属于当前账户。');
  details.approvedDir ||= await resolvedParent(details.filename);
  await validateParent(details);
  if (details.published) {
    const target = await statPath(targetName(details.filename, details.publishAttempt || 0));
    if (target && ownFile(target) && identity(target) === details.partialIdentity && target.size === BigInt(details.item.size)) {
      job.output = path.basename(targetName(details.filename, details.publishAttempt || 0));
      await removePart(job, details).catch(() => {});
      return;
    }
    throw safeError('已完成的文件在本机被移动或更改，请重新选择下载。');
  }
  const item = await verifyRemote(drive, account, details, signal);
  const partial = partPath(job, details);
  let existing = await statPath(partial);
  if (existing && (!ownFile(existing) || identity(existing) !== details.partialIdentity)) {
    throw safeError('临时文件无法确认归属，请重新选择下载。');
  }
  const handle = await fs.open(partial, existing ? 'r+' : 'wx+');
  let offset = Number.isSafeInteger(details.offset) ? details.offset : 0;
  let written = 0;
  async function checkpoint() {
    await handle.sync();
    details.offset = written;
    save();
    job.bytes = written;
    notify();
    offset = written;
  }
  try {
    const file = await handle.stat({ bigint: true });
    if (!ownFile(file) || existing && identity(file) !== details.partialIdentity) throw safeError('临时文件已变化。');
    if (!existing) { details.partialIdentity = identity(file); save(); }
    if (offset < 0 || offset > item.size || file.size < BigInt(offset)) offset = 0;
    if (file.size !== BigInt(offset)) await handle.truncate(offset);
    written = offset;
    job.bytes = offset;
    if (details.offset !== offset) await checkpoint();
    job.total = item.size;
    notify();

    while (written < item.size) {
      signal.throwIfAborted();
      const response = await fetchContent(drive, account, item, written ? 'bytes=' + written + '-' : undefined, signal,
        { getLink: (nextSignal, stale) => drive.content(account, item.id, nextSignal, item.version, !!stale) });
      let end = item.size - 1;
      try {
        if (response.status === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') || '');
          if (!range || Number(range[1]) !== written || Number(range[3]) !== item.size ||
              Number(range[2]) < written || Number(range[2]) >= item.size) {
            throw safeError('下载分段起点或总大小与记录不一致。');
          }
          end = Number(range[2]);
        } else if (response.status === 200) {
          const length = response.headers.get('content-length');
          if (length !== null && Number(length) !== item.size) throw safeError('下载长度与云端文件大小不一致。');
          if (written) {
            await handle.truncate(0);
            written = 0;
            job.notice = '服务器未接受断点请求，已从头下载。';
            await checkpoint();
          }
        } else if (response.status === 416) {
          throw safeError('服务器拒绝了现有断点，分段已保留供重试。');
        } else throw Object.assign(statusError(response.status), { safe: true });

        if (!response.body) throw safeError('下载没有返回可写入的数据。');
        for await (const chunk of response.body) {
          signal.throwIfAborted();
          if (written + chunk.byteLength > end + 1) throw safeError('服务器返回了超出分段的数据。');
          let cursor = 0;
          while (cursor < chunk.byteLength) {
            const { bytesWritten } = await handle.write(chunk, cursor, chunk.byteLength - cursor, written);
            if (!bytesWritten) throw safeError('无法继续写入临时文件。');
            written += bytesWritten;
            cursor += bytesWritten;
          }
          if (written - offset >= checkpointStep) await checkpoint();
        }
        if (written !== end + 1) throw safeError('下载提前中断，可从已写入位置继续。');
        await checkpoint();
      } finally { await response.body?.cancel().catch(() => {}); }
    }

    await verifyRemote(drive, account, details, signal);
    if ((await handle.stat()).size !== item.size) throw safeError('已下载文件大小有误。');
  } catch (error) {
    if (written > offset) await checkpoint();
    throw error;
  } finally {
    await handle.close();
  }
  signal.throwIfAborted();
  await publish(job, details, partial, save);
}

async function restart(drive, account, job, details, signal, save) {
  const item = await drive.get(account, details.item.id, signal);
  await removePart(job, details);
  for (const field of ['partialIdentity', 'offset', 'publishAttempt', 'published']) delete details[field];
  details.item = item;
  job.bytes = 0;
  job.total = item.size;
  delete job.restart;
  save();
}

module.exports = { download, removePart, restart, safeError, targetName };
