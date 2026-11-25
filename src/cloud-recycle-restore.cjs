const { safeName } = require('./drive.cjs');
const { CloudRecycleError } = require('./cloud-recycle.cjs');

function originalFolder(path, driveId) {
  if (typeof path !== 'string' || !/^\/?personal\//i.test(path) || /[\\?#]/u.test(path)) return null;
  try {
    const parts = path.replace(/^\/|\/$/g, '').split('/').map(decodeURIComponent);
    if (parts.length < 3 || parts.length > 64 || parts[0].toLowerCase() !== 'personal' ||
        parts[1].toLowerCase() !== driveId.toLowerCase() || parts[2].toLowerCase() !== 'documents') return null;
    const segments = parts.slice(3);
    return segments.every(segment => segment !== '.' && segment !== '..' && safeName(segment) === segment) ? segments : null;
  } catch { return null; }
}

function canRestoreOriginal(row, driveId) {
  try {
    return (row.kind === 'file' || row.kind === 'folder') && safeName(row.name) === row.name &&
      originalFolder(row.path, driveId) !== null;
  } catch { return false; }
}

async function readSelected(provider, scope, selected, signal) {
  const actual = await provider.getAccount(scope, signal);
  if (actual?.accountId !== scope.accountId || actual?.driveId !== scope.driveId) throw new CloudRecycleError('mismatch');
  const wanted = new Set(selected.map(row => row.id.toLowerCase()));
  const found = new Map();
  const cursors = new Set();
  let cursor = null;
  do {
    signal.throwIfAborted();
    const page = await provider.listPage(scope, cursor, signal);
    for (const row of page.items) {
      const id = row.id.toLowerCase();
      if (!wanted.has(id)) continue;
      if (found.has(id)) throw new CloudRecycleError('schema');
      found.set(id, row);
    }
    cursor = page.next;
    if (page.done !== (cursor === null) || cursor !== null && cursors.has(cursor)) throw new CloudRecycleError('schema');
    cursors.add(cursor);
  } while (cursor !== null);
  return found;
}

async function targetFolder(drive, account, segments, signal) {
  let folder = account.root;
  for (const name of segments) {
    signal.throwIfAborted();
    folder = await drive.namedChild(account, folder.id, name, signal);
    if (folder?.kind !== 'folder' || folder.driveId !== account.driveId) return null;
  }
  return folder;
}

function sameDeleted(row, expected, driveId) {
  return row && row.name === expected.name && row.path === expected.path && row.kind === expected.kind &&
    row.deletedAt === expected.deletedAt && canRestoreOriginal(row, driveId);
}

// The service returns a multistatus acknowledgement. Completion also needs
// independent checks of the fresh recycle listing and the original folder.
async function restoreOriginals({ provider, scope, selected, drive, account, signal, applyRestored }) {
  const outcomes = new Map(selected.map(row => [row.id, { id: row.id, state: 'unconfirmed' }]));
  const set = (row, state) => outcomes.set(row.id, { id: row.id, state });
  try {
    let fresh = await readSelected(provider, scope, selected, signal);
    // Use at most the two items verified together in the live first-party contract.
    for (let start = 0; start < selected.length; start += 2) {
      signal.throwIfAborted();
      const eligible = [];
      const destinations = new Map();
      for (const row of selected.slice(start, start + 2)) {
        if (!sameDeleted(fresh.get(row.id.toLowerCase()), row, account.driveId)) { set(row, 'changed'); continue; }
        try {
          const folder = await targetFolder(drive, account, originalFolder(row.path, account.driveId), signal);
          if (!folder) { set(row, 'parent-missing'); continue; }
          if (await drive.namedChild(account, folder.id, row.name, signal)) { set(row, 'conflict'); continue; }
          const key = JSON.stringify([folder.id, row.name.normalize('NFC').toLowerCase()]);
          if (destinations.has(key)) { set(row, 'conflict'); continue; }
          destinations.set(key, row.id);
          eligible.push({ row, folder });
        } catch (error) {
          signal.throwIfAborted();
          set(row, error?.status === 403 ? 'denied' : error?.status === 429 ? 'throttled' : 'preflight-failed');
        }
      }
      if (!eligible.length) continue;
      signal.throwIfAborted();
      let reply;
      const writeSignal = AbortSignal.any([signal, AbortSignal.timeout(65_000)]);
      try { reply = await provider.restoreGuids(scope, eligible.map(({ row }) => row.id), writeSignal); }
      catch (error) {
        signal.throwIfAborted();
        if (error?.phase === 'denied' || error?.phase === 'throttled' || error?.phase === 'auth') {
          for (const { row } of eligible) set(row, error.phase);
        }
      } finally { provider.finish(scope); }
      // No automatic POST retry. Reconcile from a new verified run.
      fresh = await readSelected(provider, scope, selected, signal);
      for (const { row, folder } of eligible) {
        const accepted = reply?.outcomes.find(item => item.id === row.id.toLowerCase());
        if (accepted?.state === 'rejected') { set(row, 'rejected'); continue; }
        if (accepted?.state !== 'submitted' || fresh.has(row.id.toLowerCase())) continue;
        try {
          const live = await drive.namedChild(account, folder.id, row.name, signal);
          if (!live || (live.kind === 'folder') !== (row.kind === 'folder') || live.name !== row.name || live.parentId !== folder.id ||
              live.driveId !== account.driveId) continue;
          await applyRestored(live);
          set(row, 'restored');
        } catch { signal.throwIfAborted(); }
      }
      if (!reply) break;
    }
  } catch (error) {
    signal.throwIfAborted();
    if (error?.phase === 'denied' || error?.phase === 'auth' || error?.phase === 'mismatch') {
      for (const row of selected) if (outcomes.get(row.id).state === 'unconfirmed') set(row, error.phase);
    }
  } finally { provider.finish(scope); }
  return Array.from(outcomes.values());
}

module.exports = { canRestoreOriginal, restoreOriginals };
