const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Drive } = require('../src/drive.cjs');
const { DriveIndex } = require('../src/drive-index.cjs');
const { DriveIndexDb } = require('../src/drive-index-db.cjs');

const account = { id: 'account-a', driveId: 'drive', root: { id: 'root', name: '全部文件', kind: 'folder' } };
const date = new Date(2026, 10, 4).toISOString();
const file = (id, name, parent = 'root', extra) => ({
  id, name, file: {}, parentReference: { id: parent, driveId: 'drive' }, lastModifiedDateTime: date, ...extra
});
const folder = (id, name, parent) => file(id, name, parent, { file: undefined, folder: {} });
const ids = result => result.items.map(item => item.id);

test('index search uses literal Unicode substrings, SQLite filters, global ranking and stable pages', () => {
  const db = new DriveIndexDb(':memory:');
  try {
    const search = (query, options) => db.search(account, { query, ...options });
    db.begin(account, 'initial');
    db.page(account, 'initial', [folder('a', 'a'), folder('ab', 'ab'), folder('deep', '复习', 'a'),
      file('math', '2027考研数学强化_%[X] 📘文档.pdf', 'deep'), file('phrase', '数学', 'ab'),
      file('prefix', '数学入门.txt'), file('astral', '附录📘文档', 'missing'),
      file('shortcut', '数学共享', 'a', { remoteItem: { id: 'external', parentReference: { driveId: 'foreign' } } }),
      file('foreign', '数学海外', 'a', { parentReference: { driveId: 'foreign', id: 'a' } }),
      ...Array.from({ length: 72 }, (_, i) => file('archive-' + i, '归档 资料 ' + i + (i < 10 ? '.mp4' : '.pdf'), 'a', { size: i + 1 }))],
    'more', '');
    assert.equal(search('研数学').status.complete, false);
    db.page(account, 'more', [], '', 'cursor');
    for (const query of ['研', '数学 强化', '研数学', '_%[x]', '2027  📘文档']) {
      assert.deepEqual(ids(search(query)), ['math']);
    }
    assert.deepEqual(ids(search('"%[')), []);
    assert.deepEqual(ids(search('📘文档')), ['astral', 'math']);
    assert.equal(search('📘文档').items[0].path, null);
    assert.deepEqual(ids(search('数学')).slice(0, 2), ['phrase', 'prefix']);
    assert.deepEqual(ids(search('数学', { scope: 'a', filter: 'pdf' })), ['math']);
    assert.equal(search('数学', { filter: 'shortcut' }).items[0].kind, 'shortcut');
    assert.equal(search('数学', { filter: 'pdf' }).items[0].path, '/a/复习');
    assert.equal(search('归档', { since: Date.parse(date) + 1 }).total, 0);
    const options = { filter: 'pdf', sort: 'largest', scope: 'a' };
    const first = search('归档 资料', options);
    const next = search('归档 资料', { ...options, offset: Number(first.cursor), revision: first.status.revision });
    assert.equal(first.total, 62);
    assert.equal(first.items.length, 50);
    assert.equal(next.items.length, 12);
    assert.equal(new Set([...ids(first), ...ids(next)]).size, 62);
    assert.deepEqual([first.items[0].size, first.items[49].size, next.items[0].size], [72, 23, 22]);
    assert.equal(search('归档', { offset: 50, revision: 0 }).reset, true);
    for (const other of [{ ...account, id: 'account-b' }, { ...account, driveId: 'other-drive' }]) {
      db.begin(other, 'initial');
      db.page(other, 'initial', [{ ...file('math', '同ID私有资料.txt'), parentReference: { id: 'root', driveId: other.driveId } }], '', 'delta');
      assert.deepEqual(ids(db.search(other, { query: '数学' })), []);
      assert.deepEqual(ids(db.search(other, { query: '同ID' })), ['math']);
    }
    assert.deepEqual(ids(search('同ID')), []);
  } finally { db.close(); }
});

test('in-flight Delta preserves successful local writes and applies tombstones after final moves', () => {
  const db = new DriveIndexDb(':memory:');
  try {
    db.begin(account, 'initial');
    db.page(account, 'initial', [folder('old', '旧路径'), folder('kept', '新路径'), file('survivor', '移动笔记.pdf', 'old'),
      file('deleted', '被删笔记.pdf', 'old'), file('local', '旧名笔记.pdf', 'kept'), file('fixed', '固定笔记.pdf', 'kept')], '', 'delta1');
    const sequence = db.intent(account);
    db.begin(account, 'ignored');
    db.mutation(account, sequence, { id: 'local', name: '本地笔记.pdf', size: 9, parentId: 'kept', kind: 'pdf', etag: 'local-etag' });
    db.page(account, 'delta1', [{ id: 'old', deleted: {} }, file('local', '旧名笔记.pdf', 'kept', { eTag: 'old-etag' }),
      { id: 'survivor', deleted: {} }], 'more', '');
    assert.deepEqual(ids(db.search(account, { query: '本地' })), ['local']);
    assert.deepEqual(ids(db.search(account, { query: '被删' })), ['deleted']);
    db.page(account, 'more', [{ id: 'kept', name: '路径改名' }, { id: 'survivor', parentReference: { id: 'kept' } },
      file('added', '外部新增.pdf', 'kept')], '', 'delta2');
    assert.equal(db.search(account, { query: '移动' }).items[0].path, '/路径改名');
    assert.equal(db.search(account, { query: '固定' }).items[0].path, '/路径改名');
    assert.equal(db.search(account, { query: '被删' }).total, 0);
    assert.equal(db.search(account, { query: '外部' }).total, 1);
    assert.equal(db.search(account, { query: '旧名' }).total, 0);
    assert.equal(db.pending(account).length, 0);
    db.begin(account, 'ignored');
    db.page(account, 'delta2', [file('local', '本地笔记.pdf', 'kept', { eTag: 'local-etag' })], '', 'delta3');
    assert.equal(db.status(account).dirty, false);
    const deleting = db.intent(account);
    db.mutation(account, deleting, { id: 'kept' }, true);
    assert.equal(db.search(account, { query: '笔记' }).total, 0);
    db.begin(account, 'ignored');
    db.page(account, 'delta3', [{ id: 'kept', deleted: {} }, { id: 'survivor', parentReference: { id: 'root' } }], '', 'delta4');
    assert.equal(db.search(account, { query: '移动' }).items[0].path, '/');
    assert.equal(db.search(account, { query: '固定' }).total, 0);
  } finally { db.close(); }
});

test('an interrupted local acknowledgement leaves a durable intent for Delta and never retries the remote mutation', async () => {
  const db = new DriveIndexDb(':memory:');
  const base = 'https://graph.microsoft.com/v1.0/drives/drive/root/delta';
  let remoteChanged = false;
  let attempts = 0;
  let interrupt = false;
  let lastStatus;
  const worker = {
    async call(name, ...args) {
      if (interrupt && name === 'mutation') throw new Error('Simulated local write failure');
      return db[name](...args);
    },
    close() {}
  };
  const drive = new Drive({ mock: true, credentials: { access: 'fixture' }, fetcher: async () => Response.json({
    value: remoteChanged ? [file('uploaded', '云端已保存.txt')] : [],
    '@odata.deltaLink': base + '?cursor=latest-applied'
  }) });
  const create = () => {
    const index = new DriveIndex('', status => { lastStatus = status; }, { worker });
    index.select(account, drive);
    return index;
  };
  let index = create();
  try {
    await index.refresh({ manual: true });
    interrupt = true;
    await index.mutate(account, async () => {
      attempts += 1;
      remoteChanged = true;
      return { id: 'uploaded', name: '云端已保存.txt', kind: 'text', parentId: 'root' };
    }, item => item);
    assert.equal(db.status(account).dirty, true);
    assert.equal((await index.search(account, { query: '云端' })).total, 0);
    index.close();
    interrupt = false;
    index = create();
    await index.refresh();
    assert.equal((await index.search(account, { query: '云端' })).total, 1);
    assert.equal(attempts, 1);
    assert.equal(lastStatus.dirty, false);
  } finally { index.close(); db.close(); }
});

test('Graph pagination checkpoints survive a worker restart, 429 and offline, and 410 keeps the old generation until complete', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-index-'));
  const dbPath = path.join(dir, 'index.sqlite');
  const base = 'https://graph.microsoft.com/v1.0';
  const stem = base + '/drives/drive/root/delta';
  const next = stem + '?$skiptoken=abc%2Bopaque';
  const expired = stem + '?$deltatoken=one';
  const restart = stem + '?$skiptoken=restart';
  const last = stem + '?$deltatoken=two';
  const sent = [];
  let scenario = 'break';
  let online = true;
  const drive = new Drive({ base, mock: true, credentials: { access: 'fixture' }, fetcher: async (url, options) => {
    assert.equal(options.headers.get('authorization'), 'Bearer fixture');
    assert.equal(options.redirect, 'error');
    sent.push(url.href);
    const page = (value, link, address) => Response.json({ value, ['@odata.' + link]: address });
    if (url.href === next) {
      if (scenario === 'break') throw new Error('fixture disconnected');
      return page([file('deep', '未曾浏览数学.pdf')], 'deltaLink', expired);
    }
    if (url.href === expired) {
      if (scenario === 'throttle') return new Response(null, { status: 429, headers: { 'Retry-After': '120' } });
      return new Response(null, { status: 410, headers: { Location: restart } });
    }
    if (url.href === restart) {
      if (scenario === 'bad-rebuild') return page([file('replacement', '替换资料.txt')], 'nextLink', 'https://example.com/collect');
      return page([file('replacement', '替换资料.txt')], 'deltaLink', last);
    }
    assert.equal(url.pathname, new URL(stem).pathname);
    assert.ok(!url.searchParams.has('token'));
    return page([file('original', '上次资料.pdf')], 'nextLink', next);
  } });
  const create = () => {
    const index = new DriveIndex(dbPath, () => {}, { online: () => online });
    index.select(account, drive);
    return index;
  };
  let index = create();
  const search = query => index.search(account, { query });
  try {
    await index.refresh({ manual: true });
    assert.equal((await search('上次')).status.complete, false);
    await index.close();
    scenario = 'resume';
    index = create();
    await index.refresh({ manual: true });
    assert.equal(sent.filter(link => link === next).length, 2);
    assert.equal((await search('数学')).items[0].id, 'deep');
    assert.equal((await search('上次')).status.complete, true);
    online = false;
    const sentBefore = sent.length;
    await index.refresh({ manual: true });
    assert.equal((await search('数学')).status.phase, 'offline');
    assert.equal(sent.length, sentBefore);
    online = true;
    scenario = 'throttle';
    await index.refresh({ manual: true });
    assert.equal((await search('数学')).status.phase, 'throttled');
    const retryBefore = sent.length;
    await index.refresh({ manual: true });
    assert.equal(sent.length, retryBefore);

    await index.close();
    const db = new DriveIndexDb(dbPath);
    assert.ok(db.status(account).retryAt >= Date.now() + 115000);
    db.fail(account, 'failed', 0); // Simulate elapsed Retry-After without sleeping.
    db.close();
    index = create();
    scenario = 'bad-rebuild';
    await index.refresh({ manual: true });
    assert.equal((await search('上次')).status.phase, 'failed');
    assert.equal((await search('上次')).total, 1);
    assert.equal((await search('替换')).total, 0);
    assert.ok(!sent.some(link => link.includes('example.com')));
    scenario = 'finish-rebuild';
    await index.refresh({ manual: true });
    assert.equal((await search('替换')).total, 1);
    assert.equal((await search('上次')).total, 0);
    assert.equal(sent.filter(link => link === expired).length, 2);
  } finally {
    await index.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
