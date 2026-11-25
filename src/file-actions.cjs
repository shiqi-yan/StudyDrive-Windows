const { safeError } = require('./resume-download.cjs');

async function selectedItems(drive, account, ids, signal) {
  const lookups = new Map([[account.root.id, Promise.resolve(account.root)]]);
  const lookup = id => {
    if (!lookups.has(id)) lookups.set(id, drive.get(account, id, signal));
    return lookups.get(id);
  };
  const selected = new Set(ids);
  if (selected.has(account.root.id)) throw safeError('请选择根目录中的项目。');
  const top = [];
  for (const id of selected) {
    signal?.throwIfAborted();
    let item;
    try { item = await lookup(id); }
    catch (error) {
      if (![404, 403].includes(error.status)) throw error;
      top.push({ id, name: '无法读取的选中项目', kind: 'unknown', driveId: account.driveId,
        selectionError: error.message });
      continue;
    }
    let parent = item.parentId;
    const seen = new Set([id]);
    while (parent && parent !== account.root.id && !selected.has(parent)) {
      if (seen.has(parent) || seen.size >= 128) throw safeError('文件夹路径无法核对。');
      seen.add(parent);
      parent = (await lookup(parent)).parentId;
    }
    if (!selected.has(parent)) top.push(item);
  }
  return top;
}
async function destination(drive, account, id, signal) {
  const item = id === account.root.id ? account.root : await drive.get(account, id, signal);
  if (item.kind !== 'folder') throw safeError('请选择 OneDrive 文件夹作为目标。');
  return item;
}
async function assertMove(drive, account, item, target, signal) {
  const folder = await destination(drive, account, target, signal);
  if (item.kind !== 'folder') return;
  const trail = await drive.trail(account, folder, id => drive.get(account, id, signal));
  if (trail.some(parent => parent.id === item.id)) throw safeError('不能移到自身或其子目录。');
}

class FileActions {
  constructor(index, changed) {
    this.index = index;
    this.changed = changed;
  }
  async delete(drive, account, item, signal) {
    const previous = (await this.index.trashRows(account, item.id))[0];
    let fresh;
    try { fresh = await drive.get(account, item.id, signal); }
    catch (error) {
      if (error.status === 404 && previous?.state === 'deleted') return;
      throw error;
    }
    const chain = await this.index.trail(account, fresh.parentId).catch(() => null)
      || await drive.trail(account, fresh, id => drive.get(account, id, signal)).then(rows => rows.slice(0, -1)).catch(() => null);
    const path = chain && chain.length ? '/' + chain.slice(1).map(parent => parent.name).join('/') : null;
    await this.index.trashRecord(account, fresh, path);
    try {
      await this.index.mutate(account, () => drive.remove(account, fresh.id, signal), () => fresh, true);
    } catch (error) {
      if (error.status >= 400 && error.status < 500 && error.status !== 404 && error.status !== 408) {
        await this.index.setTrash(account, fresh.id, 'abandoned', 'pending');
      }
      throw error;
    }
    await this.index.setTrash(account, fresh.id, 'deleted', 'pending');
    this.changed(account, fresh, 'delete');
  }
  async restore(drive, account, item, args, signal) {
    const recorded = (await this.index.trashRows(account, item.id))[0];
    if (recorded?.state === 'restored') return;
    if (!['deleted', 'unavailable', 'restoring'].includes(recorded?.state)) throw safeError('此记录没有已确认的删除结果。');
    if (!drive.restoreAvailable) throw safeError('请先在回收站授权还原权限。');
    if (recorded.state === 'restoring' || recorded.covered) {
      try {
        const restored = await drive.get(account, item.id, signal);
        await this.index.mutate(account, async () => restored, value => value);
        await this.index.setTrash(account, item.id, 'restored');
        this.changed(account, restored);
        return;
      } catch (error) { if (error.status !== 404) throw error; }
    }
    const parent = args?.parent || recorded.item.parentId;
    if (!parent) throw safeError('原位置未知，请选择新的还原位置。');
    try { await destination(drive, account, parent, signal); }
    catch (error) {
      if (error.status === 404) throw safeError('原文件夹不可用，请选择新的还原位置。');
      throw error;
    }
    const name = args?.name || recorded.item.name;
    if (await drive.namedChild(account, parent, name, signal)) throw safeError('目标已有同名项目，请改名或选择另一个文件夹。');
    await this.index.setTrash(account, item.id, 'restoring');
    let changed;
    try {
      changed = await this.index.mutate(account, () => drive.restore(account, item.id, { parent, name }, signal), value => value);
    } catch (error) {
      if (error.status === 404 || error.status === 410) {
        await this.index.setTrash(account, item.id, 'unavailable', 'restoring');
        throw safeError('OneDrive 找不到可还原的项目，可能已过保留期或已被永久删除。');
      }
      if (error.status === 400 || error.status === 409) {
        await this.index.setTrash(account, item.id, 'deleted', 'restoring');
        throw safeError('OneDrive 拒绝还原到该位置，请选择另一个文件夹或改名。');
      }
      if (error.status === 403) {
        await this.index.setTrash(account, item.id, 'deleted', 'restoring');
        throw safeError('OneDrive 未授予此项目的还原权限，可重新检查回收站授权。');
      }
      if (error.status === 429) await this.index.setTrash(account, item.id, 'deleted', 'restoring');
      throw error;
    }
    await this.index.setTrash(account, item.id, 'restored');
    this.changed(account, changed);
  }
  async run(drive, account, operation, item, args, signal) {
    signal?.throwIfAborted();
    if (item.id === account.root.id || item.driveId !== account.driveId) throw safeError('此项目不属于当前可操作的文件列表。');
    if (operation === 'restore') return this.restore(drive, account, item, args, signal);
    if (item.selectionError) throw safeError(item.selectionError);
    if (operation === 'remove') return this.delete(drive, account, item, signal);
    if (operation === 'move') {
      const fresh = await drive.get(account, item.id, signal);
      await assertMove(drive, account, fresh, args.parent, signal);
      if (fresh.parentId === args.parent) return;
      const changed = await this.index.mutate(account, () => drive.move(account, fresh.id, args.parent, signal), value => value);
      this.changed(account, changed);
      return changed;
    }
    throw safeError('文件操作无效。');
  }
}

module.exports = { FileActions, selectedItems, destination };
