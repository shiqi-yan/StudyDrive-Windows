const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash, randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listen, signIn } = require('../src/auth.cjs');
const { buildLoginConfig, releaseClientId, TEST_CLIENT_ID } = require('../src/login-config.cjs');
const { Drive, safeName, fileType } = require('../src/drive.cjs');
const { Store } = require('../src/store.cjs');
const { Media, origin, requestMedia, fetchContent } = require('../src/media.cjs');
const { nextPosition } = require('../src/transfers.cjs');

test('public-client PKCE uses S256, loopback state and a secretless token request', async () => {
  const clientId = TEST_CLIENT_ID;
  let authorization;
  let callback;
  const creds = await signIn(clientId, async value => {
    authorization = new URL(value);
    const redirect = new URL(authorization.searchParams.get('redirect_uri'));
    assert.equal(authorization.hostname, 'login.microsoftonline.com');
    assert.equal(redirect.hostname, 'localhost');
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.match(authorization.searchParams.get('scope'), /Files\.ReadWrite/);
    callback = new URL(redirect);
    callback.hostname = '127.0.0.1';
    callback.searchParams.set('state', 'wrong');
    callback.searchParams.set('code', 'local-code');
    assert.equal((await fetch(callback)).status, 400);
    callback.searchParams.set('state', authorization.searchParams.get('state'));
    assert.equal((await fetch(callback)).status, 200);
  }, {
    fetcher: async (url, request) => {
      assert.match(url, /^https:\/\/login\.microsoftonline\.com\/consumers\/.*\/token$/);
      assert.equal(request.body.get('client_secret'), null);
      assert.equal(request.body.get('client_id'), clientId);
      assert.ok(request.body.get('code') === 'local-code', 'simulated callback was redeemed');
      assert.ok(request.body.get('redirect_uri') === authorization.searchParams.get('redirect_uri'), 'redirect URI matches');
      assert.ok(createHash('sha256').update(request.body.get('code_verifier')).digest('base64url') === authorization.searchParams.get('code_challenge'), 'S256 matches');
      return Response.json({ access_token: 'mock', refresh_token: 'mock-refresh' });
    }
  });
  assert.ok(creds.refresh === 'mock-refresh', 'simulated refresh credential returned');
  const done = await fetch(callback);
  assert.equal(new URL(done.url).pathname, '/study-drive/auth/result');
  assert.equal(new URL(done.url).search, '');
  assert.match(await done.text(), /已收到 Microsoft 的授权响应/);
});

test('build requires a public Client ID or explicit isolated demo; the test configuration cannot become a release', () => {
  assert.throws(() => buildLoginConfig([], undefined), /缺少 STUDY_ENTRA_CLIENT_ID/);
  for (const invalid of ['wrong', TEST_CLIENT_ID, '00000000-0000-0000-0000-000000000000']) {
    assert.throws(() => buildLoginConfig([], invalid), /无效或为保留测试值/);
  }
  assert.throws(() => buildLoginConfig(['--test'], TEST_CLIENT_ID), /打包参数无效/);
  assert.deepEqual(buildLoginConfig(['--demo'], TEST_CLIENT_ID), { mode: 'demo' });
  assert.equal(releaseClientId({ mode: 'test', clientId: TEST_CLIENT_ID }), '');
  const syntaxOnly = randomUUID();
  assert.ok(releaseClientId(buildLoginConfig([], syntaxOnly)) === syntaxOnly, 'maintainer value preserved in the release manifest');
});

test('account and drive history use separate persistent keys and vault data stays separate', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'study-core-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const encryption = {
    isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).map(byte => byte ^ 19),
    decryptString: buffer => buffer.map(byte => byte ^ 19).toString()
  };
  const store = new Store(directory, encryption);
  const file = { id: 'same', driveId: 'first', name: 'Course', kind: 'video' };
  const other = { ...file, driveId: 'another' };
  store.touch('account-a', file);
  store.touch('account-a', other);
  store.watch('account-a', file, 18, 30);
  store.watch('account-b', file, 8, 30);
  store.favorite('account-a', { ...file, kind: 'folder' });
  store.saveVault({ current: { refresh: 'private-credential' } });
  assert.equal(fs.readFileSync(path.join(directory, 'library.json'), 'utf8').includes('private-credential'), false);
  const loaded = new Store(directory, encryption);
  assert.equal(loaded.account('account-a').recent.length, 2);
  assert.equal(loaded.account('account-b').recent.length, 0);
  assert.equal(Object.values(loaded.account('account-a').watching)[0].seconds, 18);
  assert.equal(Object.values(loaded.account('account-b').watching)[0].seconds, 8);
  assert.equal(loaded.account('account-a').favorites.length, 1);
  loaded.history('account-a', 'watching', file);
  loaded.history('account-a', 'recent', null);
  assert.equal(Object.keys(loaded.account('account-a').watching).length, 0);
  assert.equal(loaded.account('account-a').recent.length, 0);
  assert.equal(loaded.vault().current.refresh, 'private-credential');
});

test('Graph cursor and name are validated, active HTML and SVG are never served inline', async () => {
  const client = new Drive({ credentials: { access: 'demo' }, mock: true, fetcher: () => assert.fail('Must not forward Graph access token') });
  await assert.rejects(() => client.request('https://unknown.invalid/v1.0/foo'), /分页/);
  assert.throws(() => client.transferUrl('http://10.0.0.1/metadata'));
  assert.throws(() => safeName('..\\bad.txt'));
  assert.throws(() => safeName('NUL.txt'));
  assert.equal(safeName(' 函数图像.pdf '), '函数图像.pdf');
  assert.equal(fileType('danger.svg', 'image/svg+xml').kind, 'other');
  assert.equal(fileType('learn.mp4').type, 'video/mp4');
});

test('loopback capability rejects absent origin, refreshes expired upstream and preserves Range', async t => {
  const media = new Media();
  await media.start();
  t.after(() => { media.clear(); media.server.closeAllConnections(); media.server.close(); });
  const ranges = [];
  let index = 0;
  const drive = {
    content: async () => 'https://server.invalid/' + (++index),
    transferUrl: value => value,
    fetcher: async (url, { headers }) => {
      ranges.push(headers.Range);
      if (url.endsWith('/1')) return new Response('', { status: 403 });
      return new Response('abc', { status: 206, headers: { 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes 8-10/20', 'Content-Length': '3' } });
    }
  };
  const account = { id: 'account' };
  const issued = media.issue(drive, account, { id: 'video', type: 'video/mp4', size: 20 });
  assert.equal((await fetch(issued.url)).status, 404);
  assert.throws(() => media.ticket(issued.key, { id: 'other' }));
  const partial = await fetch(issued.url, { headers: { Origin: origin, Range: 'bytes=8-10' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 8-10/20');
  assert.equal(await partial.text(), 'abc');
  assert.deepEqual(ranges, ['bytes=8-10', 'bytes=8-10']);
  assert.throws(() => media.nativeSource(issued.key, account));
  media.ticket(issued.key, account).view = 'video';
  const native = media.nativeSource(issued.key, account);
  assert.equal((await fetch(native.url, { headers: { 'X-Study-Native': 'incorrect' } })).status, 404);
  const binary = await fetch(native.url, { headers: { 'X-Study-Native': native.secret, Range: 'bytes=8-10' } });
  assert.equal(binary.status, 206);
  assert.equal(await binary.text(), 'abc');
  media.release(issued.key);
  assert.equal((await fetch(issued.url, { headers: { Origin: origin } })).status, 404);
  assert.equal((await fetch(native.url, { headers: { 'X-Study-Native': native.secret } })).status, 404);
});

test('signed media transport cancels before headers and during the Range body', { timeout: 5000 }, async t => {
  const accepted = new Map();
  const server = createServer((req, res) => {
    const { resolve } = accepted.get(req.url);
    const closed = new Promise(resolve => res.once('close', resolve));
    resolve({ headers: req.headers, closed });
    if (req.url === '/body') {
      res.writeHead(206, { 'Content-Length': '100', 'Content-Range': 'bytes 20-119/120' });
      res.write('first');
    }
  });
  const port = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });

  const start = suffix => {
    const acceptedRequest = Promise.withResolvers();
    accepted.set(suffix, acceptedRequest);
    const controller = new AbortController();
    const response = requestMedia('http://127.0.0.1:' + port + suffix, {
      headers: { Range: 'bytes=20-119', 'Accept-Encoding': 'identity' }, signal: controller.signal
    });
    return { accepted: acceptedRequest.promise, controller, response };
  };
  const early = start('/headers');
  const actual = await early.accepted;
  assert.equal(actual.headers.range, 'bytes=20-119');
  assert.equal(actual.headers.authorization, undefined);
  early.controller.abort();
  await assert.rejects(early.response, { code: 'ABORT_ERR' });
  await actual.closed;

  const active = start('/body');
  const incoming = await active.response;
  assert.equal(incoming.status, 206);
  assert.equal(incoming.headers.get('content-range'), 'bytes 20-119/120');
  const reader = incoming.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), 'first');
  active.controller.abort();
  await assert.rejects(() => reader.read());
  await (await active.accepted).closed;
});

test('Graph content redirect renews a missing annotation and Range retries never send Graph credentials', async () => {
  let signedRequests = 0;
  const account = { id: 'local', driveId: 'drive' };
  const client = new Drive({ mock: false, credentials: { access: 'synthetic', expires: Date.now() + 600000 }, fetcher: async (raw, opts) => {
    const url = new URL(raw);
    if (url.hostname === 'graph.microsoft.com') {
      assert.ok(new Headers(opts.headers).has('Authorization'));
      if (!url.pathname.endsWith('/content')) return Response.json({ id: 'media' });
      return new Response(null, { status: 302, headers: { Location: 'https://files.onedrive.com/bytes/' + (++signedRequests) } });
    }
    assert.equal(url.hostname, 'files.onedrive.com');
    assert.equal(new Headers(opts.headers).has('Authorization'), false);
    assert.equal(new Headers(opts.headers).get('range'), 'bytes=4-6');
    if (signedRequests === 1) return new Response(null, { status: 410 });
    return new Response('abc', { status: 206, headers: { 'Content-Range': 'bytes 4-6/20', 'Content-Length': '3' } });
  } });
  const response = await fetchContent(client, account, { id: 'media' }, 'bytes=4-6', new AbortController().signal, {});
  assert.equal(await response.text(), 'abc');
  assert.equal(signedRequests, 2);
  assert.throws(() => client.transferUrl('https://onedrive.com.example.invalid/bytes'));
  assert.throws(() => client.transferUrl('https://127.0.0.1/bytes'));
  assert.throws(() => client.transferUrl('https://word.officeapps.live.com/converted'));
  assert.ok(client.transferUrl('https://word.officeapps.live.com/converted', 'conversion'));
  assert.ok(client.transferUrl('https://my.microsoftpersonalcontent.com/download'));
  assert.ok(client.transferUrl('https://media.svc.ms/converted', 'conversion'));
  assert.throws(() => client.transferUrl('https://media.svc.ms/download'));
});

test('Range validation rejects mismatched offsets and HTML, and retains a genuine unsatisfied range', async () => {
  let reply = () => new Response('abc', { status: 206, headers: { 'Content-Range': 'bytes 1-3/20', 'Content-Length': '3' } });
  const drive = { transferUrl: value => value, content: async () => 'https://files.1drv.com/sample', fetcher: async () => reply() };
  const request = () => fetchContent(drive, {}, { id: 'file' }, 'bytes=4-6', new AbortController().signal, {});
  await assert.rejects(request, /分段信息无效/);
  reply = () => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(request, /返回了网页/);
  reply = () => new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */4' } });
  assert.equal((await request()).status, 416);
});

test('upload resume accepts server offsets and rejects malformed ranges', async () => {
  assert.equal(await nextPosition(Response.json({ nextExpectedRanges: ['5242880-', '10485760-'] }), 12000000), 5242880);
  await assert.rejects(() => nextPosition(Response.json({ nextExpectedRanges: ['bad', 5] }), 12000000));
  await assert.rejects(() => nextPosition(Response.json({ nextExpectedRanges: ['12000000-'] }), 12000000));
});
test('file selection follows identities and drops missing items only after a complete listing', async () => {
  const { Selection } = await import('../src/renderer/selection.mjs');
  const picked = new Selection();
  picked.use({ id: 'account', driveId: 'drive-a' }, 'parent', '');
  const first = { id: 'one', driveId: 'drive-a' };
  const second = { id: 'two', driveId: 'drive-a' };
  picked.set(first, true, false, [first, second]);
  picked.set(second, true, true, [first, second]);
  assert.equal(picked.size, 2);
  assert.equal(picked.has({ ...first, driveId: 'drive-b' }), false);
  picked.reconcile([second], false);
  assert.ok(picked.has(first));
  picked.reconcile([second], true);
  assert.equal(picked.has(first), false);
  picked.use({ id: 'other-account', driveId: 'drive-a' }, 'parent', '');
  assert.equal(picked.size, 0);
});
