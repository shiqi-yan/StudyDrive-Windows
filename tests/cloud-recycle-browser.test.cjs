const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PersonalRecycleProvider, partitionKey } = require('../src/onedrive-recycle-browser.cjs');

const account = { accountId: 'scope', driveId: '0123456789abcdef' };
const site = 'https://my.microsoftpersonalcontent.com';
const prefix = site + '/_api/v2.1/sites/site-not-a-drive-id/recyclebin/items?orderby=deletedDateTime%20desc&$top=101';
const next = prefix + '&$skiptoken=fixture-opaque';
const third = prefix + '&$skiptoken=fixture-later';
const row = n => ({ id: '11111111-2222-3333-4444-' + String(n).padStart(12, '0'), name: '受控资料 ' + n });
const official = 'https://onedrive.live.com/recycle';

function fakeShell({ mismatch = false, needsLogin = false, automaticLogin = false, controlled = false } = {}) {
  const tracker = { windows: [], partitions: [], bodies: [], movements: [], blockedWrite: false };
  const sessions = {
    fromPartition(key) {
      tracker.partitions.push(key);
      return {
        setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, cookies: { async flushStore() {} },
        webRequest: { onBeforeRequest(filter, handler) { this.callback = handler || filter; }, onCompleted() {} }
      };
    }
  };
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.opts = options;
      this.dead = false;
      this.url = '';
      this.body = new Map();
      tracker.windows.push(this);
      const debuggerApi = Object.assign(new EventEmitter(), {
        attach() { this.attached = true; }, isAttached() { return this.attached; }, detach() { this.attached = false; },
        sendCommand: async (method, details) => {
          if (controlled && method === 'Input.dispatchMouseEvent') {
            const page = tracker.movements.push(details.deltaY);
            tracker.respond = page === 1
              ? this.feed('tail-1', next, { value: [row(2)], '@odata.nextLink': third }, { defer: true })
              : this.feed('tail-2', third, { value: [row(3)] }, { defer: true });
          }
          if (method !== 'Network.getResponseBody') return {};
          tracker.bodies.push(details.requestId);
          return { body: JSON.stringify(this.body.get(details.requestId)) };
        }
      });
      this.webContents = Object.assign(new EventEmitter(), {
        id: tracker.windows.length,
        debugger: debuggerApi,
        setWindowOpenHandler: handler => { this.openHandler = handler; },
        getURL: () => this.url,
        executeJavaScript: async () => {
          if (this.url === 'https://login.live.com/login.srf') return needsLogin;
          if (this.url === 'https://onedrive.live.com/') {
            this.url = official;
            this.webContents.emit('did-navigate', {}, this.url);
            this.firstPage();
          } else if (controlled) return { scrollable: true, offset: 160, max: 1500, viewport: 250, x: 50, y: 50 };
          else this.feed('tail', next, { value: [row(2)] });
          return true;
        }
      });
    }
    removeMenu() {}
    isDestroyed() { return this.dead; }
    destroy() { this.dead = true; this.emit('closed'); }
    hide() { this.hidden = true; }
    show() { this.hidden = false; }
    note(method, url, initiatorOrigin = 'https://onedrive.live.com') {
      let canceled;
      this.opts.webPreferences.session.webRequest.callback(
        { method, url, initiatorOrigin, webContentsId: this.webContents.id }, result => { canceled = result.cancel; });
      return canceled;
    }
    feed(requestId, url, data, options = {}) {
      this.body.set(requestId, data);
      const method = options.method || 'GET';
      if (this.note(method, url, options.initiatorOrigin)) return;
      const debug = this.webContents.debugger;
      debug.emit('message', {}, 'Network.requestWillBeSent', {
        requestId, documentURL: options.initiatorOrigin ? options.initiatorOrigin + '/frame' : official,
        request: { url, method, headers: { Authorization: 'synthetic-ignored' } }
      });
      const respond = () => {
        debug.emit('message', {}, 'Network.responseReceived', {
          requestId, response: { url, status: 200, mimeType: 'application/json',
            headers: { Authorization: 'synthetic-ignored' }, requestHeaders: { Cookie: 'synthetic-ignored' } }
        });
        debug.emit('message', {}, 'Network.loadingFinished', { requestId });
      };
      if (options.defer) return respond;
      respond();
    }
    async loadURL(url) {
      this.url = needsLogin || automaticLogin ? 'https://login.live.com/login.srf' : url;
      this.webContents.emit('did-navigate', {}, this.url);
      if (automaticLogin) {
        this.url = official;
        this.webContents.emit('did-navigate', {}, this.url);
      }
      if (this.url === official) this.firstPage();
      else this.webContents.emit('did-finish-load', {});
    }
    firstPage() {
      tracker.blockedWrite = this.note('POST', site + '/_api/v2.1/sites/site-not-a-drive-id/recyclebin/items');
      this.feed('untrusted-frame', prefix, { value: [row(999)] }, { initiatorOrigin: 'https://example.invalid' });
      this.feed('identity', site + '/personal/' + (mismatch ? '1111111111111111' : account.driveId) + '/_api/drive', {});
      this.feed('first', prefix, { value: [row(1)], '@odata.nextLink': next });
    }
  }
  return { tracker, provider: new PersonalRecycleProvider({ sessions, Window }) };
}

test('browser provider only consumes its official GET responses, processes the next page and detaches', async () => {
  const { tracker, provider } = fakeShell();
  const signal = AbortSignal.timeout(3500);
  await provider.connect(account, signal);
  assert.deepEqual(tracker.partitions, [partitionKey(account)]);
  assert.notEqual(partitionKey(account), partitionKey({ ...account, accountId: 'different' }));
  assert.equal(tracker.windows[0].opts.webPreferences.nodeIntegration, false);
  assert.equal(tracker.windows[0].opts.webPreferences.contextIsolation, true);
  assert.equal(tracker.windows[0].opts.webPreferences.sandbox, true);
  assert.ok(tracker.windows[0].hidden);
  assert.deepEqual(tracker.windows[0].openHandler(), { action: 'deny' });
  assert.ok(tracker.blockedWrite);
  assert.deepEqual(await provider.getAccount(account, signal), account);
  const first = await provider.listPage(account, null, signal);
  assert.equal(first.next, next);
  assert.equal(first.done, false);
  const last = await provider.listPage(account, first.next, signal);
  assert.equal(last.done, true);
  assert.equal(last.items[0].capability, null);
  assert.deepEqual(tracker.bodies, ['first', 'tail']);
  provider.finish(account);
  assert.ok(tracker.windows[0].dead);
  assert.equal(tracker.windows[0].opts.webPreferences.session.webRequest.callback, null);
});

test('background refresh allows a silent first-party sign-in redirect without presenting a login window', async () => {
  const { tracker, provider } = fakeShell({ automaticLogin: true });
  const signal = AbortSignal.timeout(3500);
  assert.deepEqual(await provider.getAccount(account, signal), account);
  assert.equal(tracker.windows[0].opts.show, false);
  assert.equal((await provider.listPage(account, null, signal)).done, false);
  provider.finish(account);
});

test('browser provider rejects wrong drive identity and does not open login UI on an expired background refresh', async () => {
  const signal = AbortSignal.timeout(3500);
  const mismatch = fakeShell({ mismatch: true });
  await assert.rejects(mismatch.provider.getAccount(account, signal), /不一致/);
  assert.deepEqual(mismatch.tracker.bodies, []);
  mismatch.provider.finish(account);
  const auth = fakeShell({ needsLogin: true });
  await assert.rejects(auth.provider.getAccount(account, signal), /失效/);
  assert.equal(auth.tracker.windows[0].opts.show, false);
  auth.provider.finish(account);
});

test('the next-page driver jumps to the loaded edge and stops moving while the exact GET is pending', async () => {
  const { tracker, provider } = fakeShell({ controlled: true });
  const signal = AbortSignal.timeout(3500);
  const waitForWheel = async total => {
    for (let tries = 0; tries < 12 && tracker.movements.length < total; tries += 1)
      await new Promise(resolve => setImmediate(resolve));
    assert.equal(tracker.movements.length, total);
  };
  try {
    await provider.getAccount(account, signal);
    const first = await provider.listPage(account, null, signal);
    assert.equal(first.next, next);
    const pendingSecond = provider.listPage(account, first.next, signal);
    await waitForWheel(1);
    assert.ok(tracker.movements[0] > 1500 - 160, 'one action advances to the rendered edge');
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(tracker.movements.length, 1);
    tracker.respond();
    const second = await pendingSecond;
    assert.equal(second.next, third);
    assert.equal(tracker.movements.length, 1, 'third request waits for the consumer to request the next cursor');
    const pendingThird = provider.listPage(account, second.next, signal);
    await waitForWheel(2);
    tracker.respond();
    const last = await pendingThird;
    assert.equal(last.done, true);
    assert.deepEqual(tracker.bodies, ['first', 'tail-1', 'tail-2']);
  } finally { provider.finish(account); }
});

test('a stalled continuation can time out without another scroll or accepting a late reply after close', async () => {
  const { tracker, provider } = fakeShell({ controlled: true });
  const signal = AbortSignal.timeout(1000);
  await provider.getAccount(account, signal);
  const first = await provider.listPage(account, null, signal);
  const pending = provider.listPage(account, first.next, AbortSignal.timeout(50));
  await assert.rejects(pending, error => error.name === 'TimeoutError' || error.cause?.name === 'TimeoutError');
  assert.equal(tracker.movements.length, 1);
  provider.finish(account);
  tracker.respond();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(tracker.bodies, ['first']);
});
