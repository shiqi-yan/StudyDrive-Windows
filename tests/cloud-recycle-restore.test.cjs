const test = require('node:test');
const assert = require('node:assert/strict');
const { armRestoreRequest, classifyAcknowledgement } = require('../src/onedrive-recycle-restore.cjs');
const { canRestoreOriginal, restoreOriginals } = require('../src/cloud-recycle-restore.cjs');

const first = '11111111-2222-3333-4444-555555555555';
const second = '11111111-2222-3333-4444-555555555556';
const path = '/_api/v2.1/sites/opaque-site/recyclebin/items';
const url = 'https://my.microsoftpersonalcontent.com' + path + '/restore';
const upload = ids => [{ bytes: Buffer.from(JSON.stringify({ ids })) }];

test('official restore write gate is one use, same window/site and exact selected GUIDs only', () => {
  const request = { url, method: 'POST', webContentsId: 4, initiatorOrigin: 'https://onedrive.live.com',
    uploadData: upload([second, first]) };
  const gate = armRestoreRequest({ listPath: path, ids: [first, second], webContentsId: 4 });
  for (const extra of [
    { method: 'GET' }, { url: url.replace('opaque-site', 'another') }, { url: url + '?extra=1' },
    { webContentsId: 9 }, { initiatorOrigin: 'https://example.invalid' }, { uploadData: upload([first]) },
    { uploadData: upload([first, first]) }, { uploadData: [{ file: 'unexpected' }] }
  ]) assert.equal(gate.accept({ ...request, ...extra }), false);
  assert.equal(gate.accept(request), true);
  assert.equal(gate.accept(request), false);
});

test('real write acknowledgement must still be verified and errors are per item', () => {
  assert.deepEqual(classifyAcknowledgement(207, { value: [{ id: second, error: { message: 'internal detail' } }, { id: first }] }, [first, second]),
    [{ id: first, state: 'submitted' }, { id: second, state: 'rejected' }]);
  assert.deepEqual(classifyAcknowledgement(202, {}, [first]), [{ id: first, state: 'submitted' }]);
  assert.deepEqual(classifyAcknowledgement(200, { value: [] }, [first]), [{ id: first, state: 'unconfirmed' }]);
  assert.throws(() => classifyAcknowledgement(200, { value: [{ id: second }] }, [first]), /校验失败/);
});
test('cloud restore verifies destinations and completion before publishing usable state', async () => {
  const driveId = '0123456789abcdef';
  const account = { id: 'one', driveId, root: { id: 'root' } };
  const scope = { accountId: account.id, driveId };
  const parent = '/personal/' + driveId + '/Documents/';
  const selected = [
    { id: 'conflict', name: 'conflict.pdf', path: parent, kind: 'file' },
    { id: 'missing', name: 'missing.pdf', path: parent + 'gone', kind: 'file' },
    { id: 'success', name: 'a.txt', path: parent, kind: 'file' },
    { id: 'rejected', name: 'b.txt', path: parent, kind: 'file' }
  ];
  const posts = [];
  const applied = [];
  const provider = {
    getAccount: () => scope,
    listPage: () => ({ items: posts.length ? selected.filter(item => item.id !== 'success') : selected, next: null, done: true }),
    restoreGuids(_scope, ids) {
      posts.push(ids);
      return { status: 207, outcomes: [{ id: 'success', state: 'submitted' }, { id: 'rejected', state: 'rejected' }] };
    },
    finish() {}
  };
  const drive = {
    async namedChild(_account, folder, name) {
      if (name === 'conflict.pdf') return { id: 'exists' };
      if (posts.length && name === 'a.txt') return { id: 'confirmed', driveId, name, parentId: folder, kind: 'text' };
      return null;
    }
  };
  assert.ok(canRestoreOriginal(selected[0], driveId));
  for (const path of [parent + '%2e%2e', parent + '%2felse', parent.replace(driveId, 'abcdef0123456789'), '//else.test' + parent]) {
    assert.equal(canRestoreOriginal({ ...selected[0], path }, driveId), false);
  }
  const outcomes = await restoreOriginals({ provider, scope, selected, drive, account,
    signal: new AbortController().signal, applyRestored(item) { applied.push(item.id); } });
  assert.deepEqual(posts, [['success', 'rejected']]);
  assert.deepEqual(applied, ['confirmed']);
  assert.deepEqual(outcomes.map(item => item.state), ['conflict', 'parent-missing', 'restored', 'rejected']);
});

test('an unknown cloud write is reconciled without repeating it, while the wrong account cannot write', async () => {
  const driveId = '0123456789abcdef';
  const selected = [{ id: 'own', name: 'one.txt', path: '/personal/' + driveId + '/Documents', kind: 'file' }];
  const scope = { accountId: 'one', driveId };
  const account = { id: 'one', driveId, root: { id: 'root' } };
  let reads = 0;
  let posts = 0;
  const provider = {
    getAccount: () => scope,
    listPage: () => ({ items: ++reads === 1 ? selected : [], next: null, done: true }),
    restoreGuids() { posts += 1; throw Error('Unknown result'); },
    finish() {}
  };
  const options = { provider, scope, selected, account, drive: { async namedChild() { return null; } },
    signal: new AbortController().signal, applyRestored() { assert.fail('Unknown outcome'); } };
  assert.equal((await restoreOriginals(options))[0].state, 'unconfirmed');
  assert.equal(reads, 2);
  assert.equal(posts, 1);

  provider.getAccount = () => ({ accountId: 'other', driveId });
  assert.equal((await restoreOriginals(options))[0].state, 'mismatch');
  assert.equal(posts, 1);
});
