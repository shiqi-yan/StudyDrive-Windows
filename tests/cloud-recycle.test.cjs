const test = require('node:test');
const assert = require('node:assert/strict');
const { DriveIndexDb } = require('../src/drive-index-db.cjs');
const { CloudRecycleDb } = require('../src/cloud-recycle-db.cjs');
const { CloudRecycle } = require('../src/cloud-recycle.cjs');

const { personalRecyclePage } = require('../src/onedrive-recycle-page.cjs');
const { PersonalRecycleCapture } = require('../src/onedrive-recycle-capture.cjs');

test('the official read capture verifies web identity independently and accepts only the exact continuation', () => {
  const ids = { accountId: 'account-id', driveId: '0123456789abcdef' };
  const subject = new PersonalRecycleCapture(ids);
  const domain = 'https://my.microsoftpersonalcontent.com';
  const stem = domain + '/_api/v2.1/sites/unrelated-opaque-site-value/recyclebin/items';
  const first = stem + '?orderby=deletedDateTime%20desc&$top=101';
  const next = first + '&$skiptoken=opaque-test-value';
  const json = n => ({ value: [{ id: '11111111-2222-3333-4444-' + String(n).padStart(12, '0'),
    name: '合成资料 ' + n, itemType: 'File' }] });
  const response = subject.prepareResponse(first, 'GET', 200, 'application/json');
  subject.observePage(response, { ...json(1), '@odata.nextLink': next });
  assert.throws(() => subject.page(null), /不一致/);
  assert.equal(subject.prepareResponse(first, 'GET', 200, 'application/json'), null);
  assert.throws(() => subject.observeIdentity(domain + '/personal/1111111111111111/_api/drive', 200), /不一致/);
  subject.observeIdentity('https://example.invalid/personal/0123456789abcdef/_api/drive', 200);
  assert.equal(subject.account(), null);
  subject.observeIdentity(domain + '/personal/0123456789ABCDEF/_api/drive', 200);
  assert.deepEqual(subject.account(), ids);
  assert.equal(subject.page(null).next, next);
  assert.throws(() => subject.prepareResponse(next.replace('opaque-test-value', 'different'), 'GET', 200, 'application/json'), /校验失败/);
  assert.equal(subject.prepareResponse(next.replace(domain, 'https://example.invalid'), 'GET', 200, 'application/json'), null);
  assert.equal(subject.prepareResponse(next, 'POST', 200, 'application/json'), null);
  assert.throws(() => subject.prepareResponse(next, 'GET', 403, 'application/json'), /拒绝/);
  const tail = subject.prepareResponse(next.replace('deletedDateTime%20desc', 'deletedDateTime+desc'), 'GET', 200, 'application/json;charset=UTF-8');
  assert.throws(() => subject.observePage(tail, { ...json(2), '@odata.nextLink': null }), /校验失败/);
  subject.observePage(tail, json(2));
  assert.equal(subject.page(next).done, true);
  assert.equal(subject.page(next).items[0].driveItemId, null);
});

test('authenticated server-relative site namespace binds a nonempty page and rejects a different account', () => {
  const scope = { accountId: 'own-graph-scope', driveId: '0123456789abcdef' };
  const stem = 'https://my.microsoftpersonalcontent.com/_api/v2.1/sites/opaque/recyclebin/items?orderby=deletedDateTime%20desc&$top=101';
  const body = loc => ({ value: [{ id: '11111111-2222-3333-4444-123456789012', name: 'fixture', deletedFromLocation: loc }] });
  const legit = new PersonalRecycleCapture(scope);
  legit.observePage(legit.prepareResponse(stem, 'GET', 200, 'application/json'), body('personal/0123456789ABCDEF/Documents'));
  assert.deepEqual(legit.account(), scope);
  assert.equal(legit.page(null).items[0].parentId, null);
  assert.equal(legit.page(null).items[0].driveItemId, null);
  const other = new PersonalRecycleCapture(scope);
  assert.throws(() => other.observePage(other.prepareResponse(stem, 'GET', 200, 'application/json'),
    body('/personal/fedcba9876543210/Documents')), /不一致/);
  const empty = new PersonalRecycleCapture(scope);
  empty.observePage(empty.prepareResponse(stem, 'GET', 200, 'application/json'), { value: [] });
  assert.equal(empty.account(), null);
  assert.throws(() => empty.page(null), /不一致/);
});

test('observed personal recycle payload keeps continuation and never translates a cloud row ID into a Graph ID', () => {
  const link = 'https://example.invalid/list?opaque=next';
  const value = [{ id: 'same-shape-as-graph-id', name: '历史项目.pdf', size: 416,
    itemType: 'File', deletedDateTime: '2026-11-20T00:00:00Z', deletedFromLocation: '/课程',
    deletedBy: { user: { displayName: 'ignored' } }, title: 'ignored' }];
  const full = personalRecyclePage({ value, '@odata.nextLink': link });
  assert.deepEqual(full, { nextLink: link, items: [{ id: 'same-shape-as-graph-id', name: '历史项目.pdf',
    kind: 'file', size: 416, deletedAt: Date.parse('2026-11-20T00:00:00Z'), path: '/课程',
    driveItemId: null, parentId: null, capability: null }] });
  assert.deepEqual(personalRecyclePage({ value: [] }), { nextLink: null, items: [] });
  assert.throws(() => personalRecyclePage('<html>Login</html>'), /校验失败/);
  assert.throws(() => personalRecyclePage({ value, '@odata.nextLink': {} }), /校验失败/);
});

const a = { id: 'account-a', driveId: 'drive-a' };
const b = { id: 'account-b', driveId: 'drive-b' };
const gate = () => {
  let open;
  const promise = new Promise(resolve => { open = resolve; });
  return { promise, open };
};
const account = async scope => ({ accountId: scope.accountId, driveId: scope.driveId });
function fixture(provider, options = {}) {
  const index = new DriveIndexDb(':memory:');
  const snapshots = new CloudRecycleDb(index);
  const db = { call: async (method, ...args) => snapshots[method.slice(6)](...args) };
  const recycle = new CloudRecycle(db, { provider, ...options });
  return { recycle, close: () => index.close() };
}

test('cloud snapshot is not published until the final verified page and preserves known history on errors', async () => {
  const arrived = gate();
  const release = gate();
  const rows = Array.from({ length: 230 }, (_, id) => ({ id: 'cloud-item-' + id, name: '云回收 ' + id, deletedAt: 300 + id }));
  rows[0] = { id: 'older-cloud-id', name: '历史项', kind: 'folder', size: null };
  let scenario = 'full';
  const provider = { id: 'controlled', getAccount: account, async listPage(scope, cursor) {
    assert.equal(scope.accountId, a.id);
    if (scenario === 'offline') throw Object.assign(new Error('simulated network unavailable'), { code: 'ENETDOWN' });
    if (scenario === 'auth-lost') throw Object.assign(new Error('response details not displayed'), { status: 401 });
    if (scenario === 'html') return '<html>Sign in</html>';
    if (scenario === 'count-changed') return { items: [rows[0]], done: true, total: 2 };
    if (scenario === 'repeated-cursor') return { items: [rows[0]], next: 'same', done: false };
    if (scenario === 'changed-mapping') return cursor
      ? { items: [{ ...rows[0], driveItemId: 'different-item' }], done: true }
      : { items: [rows[0]], next: 'changed', done: false };
    if (!cursor) return { items: rows.slice(0, 100), next: 'second', done: false, total: 230 };
    if (cursor === 'second') return { items: [rows[99], ...rows.slice(100, 200)], next: 'third', done: false, total: 230 };
    arrived.open();
    await release.promise;
    return { items: rows.slice(200), done: true, total: 230 };
  } };
  const { recycle, close } = fixture(provider);
  try {
    recycle.select(a);
    const loading = recycle.refresh();
    await Promise.race([arrived.promise, loading.then(() => assert.fail('Snapshot finished before the final page'))]);
    assert.equal((await recycle.page(a)).snapshot, null);
    release.open();
    assert.equal(await loading, true);
    const complete = await recycle.page(a);
    assert.equal(complete.snapshot.total, 230);
    assert.equal(complete.items.length, 100);
    assert.equal(complete.status.phase, 'ready');
    const tail = await recycle.page(a, { offset: 200, generation: complete.snapshot.generation });
    assert.equal(tail.items.length, 30);
    assert.equal(tail.items.at(-1).id, 'older-cloud-id');
    assert.equal(tail.items.at(-1).deletedAt, null);
    assert.equal(tail.next, null);
    for (const [failure, phase] of [['offline', 'failed'], ['auth-lost', 'auth'], ['html', 'schema'], ['count-changed', 'schema'], ['repeated-cursor', 'schema'], ['changed-mapping', 'schema']]) {
      scenario = failure;
      assert.equal(await recycle.refresh(), false);
      const current = await recycle.page(a);
      assert.equal(current.status.phase, phase);
      assert.deepEqual(current.snapshot, complete.snapshot);
      assert.deepEqual(current.items, complete.items);
    }
  } finally { close(); }
});

test('legacy recycle records preserve provider structure and derive display types without claiming MIME', async () => {
  const { describeRecycleType } = require('../src/recycle-kind.cjs');
  for (const [name, kind, displayKind, typeSource] of [
    ['课程.pdf', 'folder', 'folder', 'folder'],
    ['旧版.DOCX', 'file', 'office', 'extension'],
    ['演示.PPTX', 'file', 'office', 'extension'],
    ['统计.XLSX', 'file', 'sheet', 'extension'],
    ['说明.PDF', 'file', 'pdf', 'extension'],
    ['视频.MKV', 'file', 'video', 'extension'],
    ['音频.FLAC', 'file', 'audio', 'extension'],
    ['归档.TAR.GZ', 'file', 'archive', 'extension'],
    ['笔记.TXT', 'file', 'text', 'extension'],
    ['README', 'file', 'other', 'no-extension'],
    ['.TXT', 'file', 'other', 'no-extension'],
    ['未知.GXQ', 'file', 'other', 'unknown-extension'],
    ['文件无后缀', 'pdf', 'pdf', 'recorded']
  ]) {
    assert.deepEqual(describeRecycleType(name, kind), { displayKind, typeSource });
  }

  const { recycle, close } = fixture({ id: 'controlled', getAccount: account, listPage: async () => ({
    done: true, items: [{ id: 'same-provider-guid', name: '原记录.XLSX', kind: 'file' }]
  }) });
  try {
    recycle.select(a);
    await recycle.refresh();
    const { items } = await recycle.page(a);
    assert.deepEqual(items.map(({ id, kind, displayKind, typeSource }) => ({ id, kind, displayKind, typeSource })),
      [{ id: 'same-provider-guid', kind: 'file', displayKind: 'sheet', typeSource: 'extension' }]);
    assert.equal(Object.hasOwn(items[0], 'mimeType'), false);
  } finally { close(); }
});

test('switching account cancels late work, isolates generations and refuses mismatched cloud identity', async () => {
  const entered = gate();
  const late = gate();
  let wrongUser = false;
  let readB = 0;
  const { recycle, close } = fixture({ id: 'controlled', getAccount: async scope => wrongUser ? account({ ...scope, driveId: 'wrong' }) : account(scope),
    async listPage(scope) {
      if (scope.accountId === a.id) { entered.open(); return late.promise; }
      readB += 1;
      return { items: [{ id: 'same-id', name: '乙账户资料' }], done: true };
    }
  });
  try {
    recycle.select(a);
    const old = recycle.refresh();
    await Promise.race([entered.promise, old.then(() => assert.fail('Account A finished before its delayed page'))]);
    recycle.select(b);
    assert.equal(await old, false);
    assert.equal(await recycle.refresh(), true);
    late.open({ items: [{ id: 'same-id', name: '甲账户资料' }], done: true });
    assert.deepEqual((await recycle.page(b)).items.map(row => row.name), ['乙账户资料']);
    await assert.rejects(recycle.page(a), /不一致/);
    recycle.select(a);
    assert.equal((await recycle.page(a)).snapshot, null);
    recycle.select(b);
    wrongUser = true;
    assert.equal(await recycle.refresh(), false);
    assert.equal(readB, 1);
    assert.equal((await recycle.page(b)).status.phase, 'mismatch');
    assert.equal((await recycle.page(b)).snapshot.total, 1);
  } finally { close(); }
});

test('cloud access stays off without a provider and a verified mapping is separate from the cloud recycle ID', async () => {
  {
    const { recycle, close } = fixture(null);
    try {
      recycle.select(a);
      assert.equal(recycle.refresh({ connect: true }), null);
      const result = await recycle.page(a);
      assert.equal(result.status.configured, false);
      assert.equal(result.snapshot, null);
    } finally { close(); }
  }
  const { recycle, close } = fixture({ id: 'controlled', getAccount: account, listPage: async () => ({
    done: true, items: [
      { id: 'not-a-graph-id', name: '已有映射', driveItemId: 'file-a', capability: { mode: 'graph-personal', verified: true } },
      { id: 'pretend-id', name: '未经核对', driveItemId: 'file-b', capability: { mode: 'graph-personal' } },
      { id: 'file-c', name: 'ID 未核对', capability: { mode: 'graph-personal', verified: true } }
    ]
  }) }, { onRestore: () => {} });
  try {
    recycle.select(a);
    await recycle.refresh();
    const { items, snapshot } = await recycle.page(a);
    assert.deepEqual(items.filter(row => row.canRestore).map(row => row.id), ['not-a-graph-id']);
    const result = await recycle.resolveRestore(a, snapshot.generation, ['not-a-graph-id']);
    assert.equal(result[0].driveItemId, 'file-a');
    await assert.rejects(recycle.resolveRestore(a, snapshot.generation, ['pretend-id']), /分页校验失败/);
    await assert.rejects(recycle.resolveRestore(a, snapshot.generation, ['file-c']), /分页校验失败/);
  } finally { close(); }
});

test('transient page reads retry a bounded number and explicit cancel preserves the stable snapshot', async () => {
  let failures = 0;
  let sleeps = 0;
  let hang = false;
  const entered = gate();
  const stall = gate();
  const { recycle, close } = fixture({ id: 'controlled', getAccount: account, listPage: async () => {
    if (hang) { entered.open(); return stall.promise; }
    if (++failures < 3) throw Object.assign(new Error('throttled'), { status: 429, retryAfter: 10 });
    return { done: true, items: [{ id: 'id', name: '云记录' }] };
  } }, { wait: async () => { sleeps += 1; } });
  try {
    recycle.select(a);
    assert.equal(await recycle.refresh(), true);
    assert.equal(sleeps, 2);
    hang = true;
    const run = recycle.refresh();
    await entered.promise;
    recycle.cancel();
    assert.equal(await run, false);
    assert.equal((await recycle.page(a)).status.phase, 'canceled');
    assert.equal((await recycle.page(a)).snapshot.total, 1);
  } finally { close(); }
});
