const { CloudRecycleError } = require('./cloud-recycle.cjs');
const { listOrigin, ownOrigin } = require('./onedrive-recycle-capture.cjs');

const listPath = /^\/_api\/v2\.1\/sites\/[^/]+\/recyclebin\/items$/;
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idsFor(values) {
  if (!Array.isArray(values) || !values.length || values.length > 100 ||
      values.some(value => typeof value !== 'string' || !guid.test(value))) return null;
  const ids = values.map(value => value.toLowerCase()).sort();
  return new Set(ids).size === ids.length ? ids : null;
}
function restorePath(capturedListPath) {
  if (typeof capturedListPath !== 'string' || !listPath.test(capturedListPath)) {
    throw new CloudRecycleError('schema');
  }
  return capturedListPath + '/restore';
}

function parseUpload(chunks) {
  if (!Array.isArray(chunks) || !chunks.length || chunks.length > 16) return null;
  const all = [];
  let bytes = 0;
  for (const chunk of chunks) {
    if (!Buffer.isBuffer(chunk?.bytes) && !(chunk?.bytes instanceof Uint8Array)) return null;
    bytes += chunk.bytes.byteLength;
    if (bytes > 8192) return null;
    all.push(Buffer.from(chunk.bytes));
  }
  try {
    const body = JSON.parse(Buffer.concat(all).toString());
    return Object.keys(body || {}).join(',') === 'ids' ? idsFor(body.ids) : null;
  } catch { return null; }
}

function armRestoreRequest({ listPath: verifiedListPath, ids, webContentsId }) {
  const expectedPath = restorePath(verifiedListPath);
  const allowed = idsFor(ids);
  if (!allowed || !Number.isSafeInteger(webContentsId) || webContentsId <= 0) throw new CloudRecycleError('schema');
  let accepted = false;
  const route = raw => {
    const url = ownOrigin(raw, listOrigin);
    return !!url && url.pathname === expectedPath && !url.search;
  };
  return {
    route,
    accept(details) {
      if (accepted || !route(details.url) || details.method !== 'POST' ||
          details.webContentsId !== webContentsId || details.initiatorOrigin !== 'https://onedrive.live.com') return false;
      const requested = parseUpload(details.uploadData);
      if (!requested || requested.length !== allowed.length || requested.some((id, i) => id !== allowed[i])) return false;
      accepted = true;
      return true;
    }
  };
}

// Acknowledgement is not completion. Verify the restored object and its
// absence in the fresh cloud list before reporting definitive success.
function classifyAcknowledgement(status, body, requestedIds) {
  const requested = idsFor(requestedIds);
  if (!requested) throw new CloudRecycleError('schema');
  if (status === 401) throw new CloudRecycleError('auth');
  if (status === 403) throw new CloudRecycleError('denied');
  if (status === 429) throw new CloudRecycleError('throttled');
  if (status === 202) return requested.map(id => ({ id, state: 'submitted' }));
  if (status !== 200 && status !== 207) throw new CloudRecycleError('failed');
  if (!Array.isArray(body?.value)) throw new CloudRecycleError('schema');
  const rows = new Map();
  for (const value of body.value) {
    const id = typeof value?.id === 'string' && value.id.toLowerCase();
    if (!id || !requested.includes(id) || rows.has(id)) throw new CloudRecycleError('schema');
    rows.set(id, value.error ? 'rejected' : 'submitted');
  }
  return requested.map(id => ({ id, state: rows.get(id) || 'unconfirmed' }));
}

module.exports = { armRestoreRequest, classifyAcknowledgement };
