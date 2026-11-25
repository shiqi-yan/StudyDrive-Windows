const { CloudRecycleError } = require('./cloud-recycle.cjs');

function observedDeletedAt(value) {
  if (value == null) return null;
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(time) || time <= 0) throw new CloudRecycleError('schema');
  return time;
}

// This translates observed list fields only. The authenticated capture layer
// must validate where the response came from and independently prove the end.
function personalRecyclePage(payload) {
  if (!Array.isArray(payload?.value) || payload.value.length > 10000) throw new CloudRecycleError('schema');
  const nextLink = payload['@odata.nextLink'] ?? null;
  if (nextLink !== null && (typeof nextLink !== 'string' || !nextLink || nextLink.length > 32768 ||
      /[\u0000-\u001f]/u.test(nextLink))) throw new CloudRecycleError('schema');
  return {
    items: payload.value.map(row => {
      if (!row || typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || !row.name) {
        throw new CloudRecycleError('schema');
      }
      let kind = 'unknown';
      if (typeof row.itemType === 'string') {
        const type = row.itemType.toLowerCase();
        if (type === 'file' || type === 'folder') kind = type;
      }
      return { id: row.id, name: row.name, kind,
        size: Number.isSafeInteger(row.size) && row.size >= 0 ? row.size : null,
        deletedAt: observedDeletedAt(row.deletedDateTime),
        path: typeof row.deletedFromLocation === 'string' ? row.deletedFromLocation : null,
        driveItemId: null, parentId: null, capability: null };
    }),
    nextLink
  };
}

module.exports = { personalRecyclePage };
