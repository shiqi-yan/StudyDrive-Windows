const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { startMock } = require('../src/mock.cjs');
const { Drive, itemInfo } = require('../src/drive.cjs');
const { DriveIndexDb } = require('../src/drive-index-db.cjs');
const { FileActions, selectedItems } = require('../src/file-actions.cjs');
const { Store } = require('../src/store.cjs');
const { Transfers } = require('../src/transfers.cjs');

const workspace = path.resolve(__dirname, '..');
const vault = { decryptString: value => value.toString(), encryptString: value => Buffer.from(value), isEncryptionAvailable: () => true };
const signal = AbortSignal.timeout(45000);
const waitFor = async read => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = read();
    if (result) return result;
    await delay(22);
  }
  throw new Error('Queue did not settle');
};

test('folders, per-item batches and Personal restore run against controlled Graph', async () => {
  const output = path.join(workspace, 'test-results');
  await fs.mkdir(output, { recursive: true });
  const dir = await fs.mkdtemp(path.join(output, 'group-'));
  const mock = await startMock(path.join(dir, 'remote'), path.join(workspace, 'fixtures'));
  const db = new DriveIndexDb(path.join(dir, 'index.sqlite'));
  const drive = new Drive({ base: mock.base, mock: true, credentials: { access: 'mock-account' } });
  const account = await drive.identity();
  const index = {
    mutate: async (account, run, metadata, deleted) => {
      const intent = db.intent(account);
      const result = await run();
      const item = metadata(result);
      if (item) db.mutation(account, intent, item, deleted);
      return result;
    },
    trail: async (...args) => db.trail(...args),
    setTrash: async (...args) => db.setTrash(...args),
    trashRows: async (...args) => db.trashRows(...args),
    trashRecord: async (...args) => db.trashRecord(...args)
  };
  const actions = new FileActions(index, () => {});
  let queue = new Transfers(new Store(dir, vault), () => {},
    (account, run, parentId) => index.mutate(account, run, raw => {
      const item = raw.kind ? raw : itemInfo(raw, account.driveId);
      return { ...item, parentId: item.parentId || parentId };
    }), (...args) => actions.run(...args));
  queue.attach(account, drive);
  const settle = id => waitFor(() => {
    const job = queue.list().find(row => row.id === id);
    return job && ['failed', 'done'].includes(job.state) ? job : null;
  });
  const find = async (parent, name) => await drive.namedChild(account, parent, name, signal);
  async function synchronize() {
    const first = drive.deltaStart(account);
    let cursor = db.begin(account, first);
    while (cursor) {
      const page = await drive.deltaPage(account, cursor, signal);
      db.page(account, cursor, page.items, page.next, page.delta);
      cursor = page.next;
    }
  }
  try {
    await synchronize();
    const source = path.join(dir, '课程资料');
    await fs.mkdir(path.join(source, '二级', '空目录'), { recursive: true });
    await fs.writeFile(path.join(source, '课件.txt'), '课程正文');
    await fs.writeFile(path.join(source, '二级', '手写笔记.txt'), '深层文件');
    const existing = await drive.mkdir(account, account.root.id, '课程资料');
    mock.test.mkdirLostResponse = true;
    const upload = await queue.folderUpload(account.root.id, source);
    assert.equal((await settle(upload)).summary.done, 5);
    assert.equal((await find(account.root.id, '课程资料')).id, existing.id);
    const nested = await find(existing.id, '二级');
    assert.equal((await find(nested.id, '空目录')).kind, 'folder');
    assert.equal(mock.test.mkdirCount, 3);

    const parentAndChild = await selectedItems(drive, account, [existing.id, nested.id], signal);
    assert.deepEqual(parentAndChild.map(item => item.id), [existing.id]);
    await assert.rejects(actions.run(drive, account, 'move', existing, { parent: nested.id }, signal), /自身或其子目录/);

    const out = path.join(dir, 'destination');
    await fs.mkdir(path.join(out, '课程资料'), { recursive: true });
    await fs.writeFile(path.join(out, '课程资料', '保留.txt'), '保留');
    const topFile = await find(existing.id, '课件.txt');
    const independent = await drive.get(account, 'text');
    mock.test.listPageSizes[existing.id] = 1;
    mock.test.contentStatuses[topFile.id] = 403;
    const download = await queue.folderDownload([existing, independent], out);
    const part = await settle(download);
    assert.equal(part.state, 'failed');
    assert.equal(part.summary.failed, 1);
    const failed = queue.entries(download, 0).items[0];
    assert.equal(failed.name, '课件.txt');
    assert.ok(mock.test.listRequests.some(row => row.id === existing.id && row.paged));
    assert.equal(await fs.readFile(path.join(out, '课程资料 (1)', '二级', '手写笔记.txt'), 'utf8'), '深层文件');
    assert.ok((await fs.stat(path.join(out, '课程资料 (1)', '二级', '空目录'))).isDirectory());
    queue.detach();
    queue = new Transfers(new Store(dir, vault), () => {}, (_account, run) => run(), (...args) => actions.run(...args));
    queue.attach(account, drive);
    delete mock.test.contentStatuses[topFile.id];
    await queue.action(download, 'retry-entry', failed.id);
    const done = await settle(download);
    assert.equal(done.summary.done, 6);
    assert.equal(await fs.readFile(path.join(out, '课程资料 (1)', '课件.txt'), 'utf8'), '课程正文');
    assert.equal(await fs.readFile(path.join(out, '课程资料', '保留.txt'), 'utf8'), '保留');
    assert.equal((await fs.readdir(out)).filter(value => value.startsWith('课程资料')).length, 2);

    const target = await drive.mkdir(account, account.root.id, '批量目标');
    mock.test.moveStatuses[independent.id] = 429;
    const move = queue.batch('move', [topFile, independent], { parent: target.id });
    const moved = await settle(move);
    assert.equal(moved.summary.done, 1);
    assert.equal(moved.summary.failed, 1);
    assert.match(queue.entries(move, 0).items[0].error, /限制/);
    await assert.rejects(queue.action(move, 'retry'), /限制/);
    delete mock.test.moveStatuses[independent.id];
    await delay(Math.max(0, moved.retryAt - Date.now() + 15));
    await queue.action(move, 'retry');
    assert.equal((await settle(move)).summary.done, 2);
    assert.equal((await drive.get(account, topFile.id)).parentId, target.id);

    const remove = queue.batch('remove', [topFile, independent], {});
    assert.equal((await settle(remove)).summary.done, 2);
    assert.equal(db.trashRows(account).length, 2);
    assert.equal(db.trashRows({ ...account, id: 'other-account' }).length, 0);
    await assert.rejects(new Drive({ base: mock.base, credentials: { access: 'unused' } }).restore(account, topFile.id), /授权/);

    const doomedFolder = await drive.get(account, target.id);
    await actions.run(drive, account, 'remove', doomedFolder, {}, signal);
    await assert.rejects(actions.run(drive, account, 'restore', topFile, {}, signal), /原文件夹不可用/);
    const elsewhere = await drive.mkdir(account, account.root.id, '另存位置');
    await drive.mkdir(account, elsewhere.id, '课件.txt');
    await assert.rejects(actions.run(drive, account, 'restore', topFile, { parent: elsewhere.id }, signal), /同名/);
    await actions.run(drive, account, 'restore', topFile, { parent: elsewhere.id, name: '课件恢复.txt' }, signal);
    assert.equal((await drive.get(account, topFile.id)).name, '课件恢复.txt');
    mock.test.restoreStatuses[independent.id] = 403;
    const restore = queue.batch('restore', [doomedFolder, independent], { parent: elsewhere.id });
    const mixed = await settle(restore);
    assert.equal(mixed.summary.done, 1);
    assert.equal(mixed.summary.failed, 1);
    assert.match(queue.entries(restore, 0).items[0].error, /还原权限/);
    assert.equal(db.trashRows(account, independent.id)[0].state, 'deleted');
    delete mock.test.restoreStatuses[independent.id];
    await queue.action(restore, 'retry');
    assert.equal((await settle(restore)).summary.done, 2);

    await synchronize();
    const active = await drive.get(account, 'course');
    const child = await drive.get(account, 'pdf');
    await drive.remove(account, active.id); // Simulated external change, bypassing FileActions.
    await synchronize();
    const rows = db.trashRows(account);
    assert.equal(rows.find(row => row.id === active.id).origin, 'delta');
    assert.ok(!rows.some(row => row.id === child.id));
    await actions.run(drive, account, 'restore', active, {}, signal);
    await synchronize();
    assert.ok(!db.trashRows(account).some(row => [active.id, child.id].includes(row.id)));
    assert.equal((await drive.get(account, child.id)).parentId, active.id);
  } finally {
    queue.detach();
    db.close();
    await new Promise(resolve => mock.server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('batch upload persists one queue and one private record, preserving order and hiding failed additions', async () => {
  const dir = await fs.mkdtemp(path.join(workspace, 'test-results', 'enqueue-durability-'));
  const store = new Store(dir, vault);
  const account = { id: 'batch-fixture' };
  let changes = 0;
  const queue = new Transfers(store, () => { changes++; });
  queue.attach(account, null);
  queue.run = () => {};
  const files = ['a.txt', 'b.txt', 'c.txt'].map(name => path.join(dir, name));
  await Promise.all(files.map(file => fs.writeFile(file, 'fixture')));
  const write = store.write.bind(store);
  const writes = [];
  store.write = (name, ...args) => { writes.push(name); return write(name, ...args); };
  changes = 0;
  assert.equal(await queue.uploads('root', files), 3);
  assert.deepEqual(writes, ['transfer-vault.bin', 'library.json']);
  assert.equal(changes, 1);
  const stored = new Store(dir, vault);
  const persisted = stored.account(account.id).transfers;
  assert.deepEqual(persisted.map(job => job.name), ['c.txt', 'b.txt', 'a.txt']);
  const privateRecords = stored.read('transfer-vault.bin', true)[account.id];
  assert.deepEqual(persisted.map(job => privateRecords[job.id].filename), [...files].reverse());
  store.write = (name, ...args) => {
    if (name === 'library.json') throw Error('simulated persistence failure');
    return write(name, ...args);
  };
  await assert.rejects(queue.uploads('root', [files[0]]), /persistence failure/);
  assert.deepEqual(queue.list().map(job => job.id), persisted.map(job => job.id));
  assert.deepEqual(Object.keys(queue.vault(account.id)).sort(), Object.keys(privateRecords).sort());
  assert.equal(changes, 1);
});
