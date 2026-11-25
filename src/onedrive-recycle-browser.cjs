const { createHash } = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { CloudRecycleError } = require('./cloud-recycle.cjs');
const { armRestoreRequest, classifyAcknowledgement } = require('./onedrive-recycle-restore.cjs');
const { canRestoreOriginal } = require('./cloud-recycle-restore.cjs');
const { PersonalRecycleCapture, recyclePage, listOrigin, looksLikeRecycleRequest, actualLoginPage, ownOrigin } =
  require('./onedrive-recycle-capture.cjs');

const navigation = new Set(['https://onedrive.live.com', 'https://login.live.com',
  'https://login.microsoftonline.com', 'https://account.live.com']);
const followOfficialRecycle = `(() => {
  const link = Array.from(document.querySelectorAll('a[href]')).find(anchor => {
    const url = new URL(anchor.href);
    return url.origin === location.origin && (url.pathname === '/recycle' || url.pathname === '/recycle/');
  });
  if (!link) return false;
  link.click();
  return true;
})()`;
const visibleLoginForm = `(() => Array.from(document.querySelectorAll(
  'input[type="password"], input[name="loginfmt"], input[type="email"], input[autocomplete="one-time-code"]'
)).some(field => field.getClientRects().length > 0))()`;
const officialGridScrollTarget = `(() => {
  const marker = document.querySelector('[aria-rowcount="-1"]');
  const rows = Array.from((marker || document).querySelectorAll('[role="row"], tr'))
    .filter(row => !row.querySelector('[role="columnheader"], th'));
  let target;
  for (const anchor of [rows.at(-1), rows[0], marker]) {
    for (let node = anchor; node && node !== document.body; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight + 2 &&
          /auto|scroll|overlay/.test(getComputedStyle(node).overflowY)) {
        target = node;
        break;
      }
    }
    if (target) break;
  }
  if (!target && marker) target = Array.from(marker.querySelectorAll('[data-is-scrollable="true"]'))
    .find(node => node.scrollHeight > node.clientHeight + 2);
  if (!target) return { grid: !!marker, rows: rows.length, visibility: document.visibilityState, scrollable: false };
  const rect = target.getBoundingClientRect();
  return { grid: !!marker, rows: rows.length, visibility: document.visibilityState, scrollable: true,
    x: Math.max(1, Math.min(innerWidth - 1, Math.round(rect.left + rect.width / 2))),
    y: Math.max(1, Math.min(innerHeight - 1, Math.round(rect.top + rect.height / 2))),
    offset: Math.round(target.scrollTop), max: Math.round(target.scrollHeight - target.clientHeight),
    viewport: Math.round(target.clientHeight) };
})()`;

// The official list grows in chunks before it reaches its own next-page
// trigger. Wait for its DOM to expose the next chunk, or for the exact GET.
// The page-side observer always detaches, even if the network event wins.
async function waitForGridProgress(run, before, hasProgress, signal) {
  const stop = new AbortController();
  const wait = AbortSignal.any([signal, stop.signal]);
  const previous = JSON.stringify(before && { max: before.max, rows: before.rows });
  try {
    const network = run.until(hasProgress, wait).then(() => null);
    const dom = run.window.webContents.executeJavaScript(`new Promise(resolve => {
      const previous = ${previous};
      const inspect = () => ${officialGridScrollTarget};
      const marker = document.querySelector('[aria-rowcount="-1"]') || document.body;
      const finish = state => {
        clearTimeout(timer);
        observer.disconnect();
        resolve(state);
      };
      const check = () => {
        const state = inspect();
        if (state.scrollable && (!previous || !Number.isFinite(previous.max) ||
            state.max > previous.max + 2 || state.rows > previous.rows)) finish(state);
      };
      const observer = new MutationObserver(check);
      const timer = setTimeout(() => finish(inspect()), 650);
      if (marker) observer.observe(marker, { childList: true, subtree: true });
      check();
    })`);
    return await Promise.race([network, dom]);
  } finally { stop.abort(); }
}

function allowedNavigation(raw) {
  try {
    const url = new URL(raw);
    return navigation.has(url.origin) && !url.username && !url.password;
  } catch { return false; }
}
function officialRecycle(raw) {
  const url = ownOrigin(raw, 'https://onedrive.live.com');
  return url?.pathname === '/recycle' || url?.pathname === '/recycle/';
}
function officialHome(raw) {
  return ownOrigin(raw, 'https://onedrive.live.com')?.pathname === '/';
}
function identityCandidate(raw) {
  return ownOrigin(raw, listOrigin)?.pathname.startsWith('/personal/') === true;
}
function routeInfo(raw) {
  try {
    const url = new URL(raw);
    if (looksLikeRecycleRequest(raw)) return 'list';
    if (url.pathname.startsWith('/personal/')) {
      if (url.origin === listOrigin) return 'personal-content';
      if (url.hostname.endsWith('.microsoftpersonalcontent.com')) return 'personal-content-other-host';
      if (url.hostname.endsWith('.sharepoint.com')) return 'personal-sharepoint';
    }
    if (officialRecycle(raw)) return 'onedrive/recycle';
    if (actualLoginPage(raw)) return 'microsoft-sign-in';
    if (url.origin === 'https://onedrive.live.com') return url.pathname === '/' ? 'onedrive/' : 'onedrive/other';
    if (url.origin === listOrigin) return 'content/other';
    return 'other';
  } catch { return 'invalid'; }
}
function errorKind(error) {
  const type = error?.name;
  return ['CloudRecycleError', 'TimeoutError', 'AbortError', 'SyntaxError', 'Error', 'TypeError'].includes(type) ? type : 'unknown';
}

function identityShapes(payload, scope) {
  const expected = scope.driveId.toLowerCase();
  const summarize = (input, counters) => {
    if (typeof input !== 'string' || !input) return;
    const absolute = /^https?:\/\//i.test(input);
    let parsed;
    try { parsed = new URL(input, listOrigin); } catch { return; }
    const prefix = parsed.pathname.match(/^\/personal\/([0-9a-f]{16,64})(?:\/|$)/i);
    if (!prefix) { counters.withoutPersonal += 1; return; }
    if (/^\/?personal\//i.test(input.trim())) counters.startsWithPersonal += 1;
    if (/^\/\/my\.microsoftpersonalcontent\.com\/personal\//i.test(input.trim())) counters.siteNetworkPath += 1;
    if (!absolute) counters.relative += 1;
    else if (parsed.origin === listOrigin) counters.trustedAbsolute += 1;
    else counters.otherAbsolute += 1;
    if (prefix[1].toLowerCase() === expected) counters.matches += 1;
    else counters.different += 1;
  };
  const initial = () => ({ relative: 0, trustedAbsolute: 0, otherAbsolute: 0, matches: 0, different: 0, withoutPersonal: 0, startsWithPersonal: 0, siteNetworkPath: 0 });
  const locations = initial();
  const context = initial();
  if (Array.isArray(payload?.value)) for (const item of payload.value) summarize(item?.deletedFromLocation, locations);
  summarize(payload?.['@odata.context'], context);
  return { locations, context };
}

function partitionKey(scope) {
  return 'persist:study-cloud-one-drive-v2-' +
    createHash('sha256').update(JSON.stringify([scope.accountId, scope.driveId])).digest('hex');
}

class WebRecycleRun {
  constructor({ window, browserSession, scope, visible, onClose, trace }) {
    this.window = window;
    this.session = browserSession;
    this.capture = new PersonalRecycleCapture(scope);
    this.scope = scope;
    this.interactive = visible;
    this.onClose = onClose;
    this.trace = trace;
    this.events = new EventEmitter();
    this.pending = new Map();
    this.requests = new Map();
    this.gets = new Set();
    this.lane = Promise.resolve();
  }
  update() { this.events.emit('change'); }
  fail(error) {
    if (this.failure) return;
    this.failure = error instanceof CloudRecycleError ? error : new CloudRecycleError('failed');
    this.trace('web-failure', { phase: this.failure.phase, kind: errorKind(error), at: routeInfo(this.window.isDestroyed() ? '' : this.window.webContents.getURL()) });
    this.update();
  }
  assertOpen() {
    if (this.failure) throw this.failure;
    if (this.window.isDestroyed()) throw new CloudRecycleError('canceled');
  }
  async until(test, signal) {
    for (;;) {
      if (signal.aborted) this.trace('wait-aborted', { kind: errorKind(signal.reason), listSeen: !!this.capture.path, identitySeen: !!this.capture.identity });
      signal.throwIfAborted();
      this.assertOpen();
      const value = test();
      if (value) return value;
      try { await once(this.events, 'change', { signal }); }
      catch (error) {
        this.trace('wait-ended', { kind: errorKind(signal.reason || error), listSeen: !!this.capture.path, identitySeen: !!this.capture.identity });
        throw error;
      }
    }
  }
  async start() {
    const contents = this.window.webContents;
    const debug = contents.debugger;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.session.setPermissionCheckHandler(() => false);
    this.session.webRequest.onBeforeRequest({ urls: [listOrigin + '/*'] }, (details, callback) => {
      const method = details.method;
      const ownRequest = details.webContentsId === contents.id && details.initiatorOrigin === 'https://onedrive.live.com';
      const route = routeInfo(details.url);
      if (route !== 'content/other' || method !== 'GET') this.trace('web-request', { route, method, sameWindow: details.webContentsId === contents.id, origin: routeInfo(details.initiatorOrigin), accepted: ownRequest && method === 'GET' });
      if (ownRequest && method === 'GET') {
        this.gets.add(details.url);
        if (this.gets.size > 1024) this.gets.delete(this.gets.values().next().value);
      }
      if (method === 'POST' && this.restoreIntent?.gate.route(details.url)) {
        const allowed = this.restoreIntent.ready === true && this.restoreIntent.gate.accept(details);
        if (allowed) {
          this.restoreIntent.sent = details.url;
          this.restoreIntent.requestId = details.id;
        }
        this.trace('restore-request-gate', { allowed });
        callback({ cancel: !allowed });
        return;
      }
      callback({ cancel: !['GET', 'HEAD', 'OPTIONS'].includes(method) });
    });
    this.session.webRequest.onCompleted({ urls: [listOrigin + '/*'] }, details => {
      const intent = this.restoreIntent;
      if (intent?.sent === details.url && intent.requestId === details.id && details.method === 'POST') {
        this.trace('restore-http-complete', { status: details.statusCode });
      }
    });
    const handleNavigation = (event, value, _inPlace, isMainFrame) => {
      const url = typeof value === 'string' ? value : value?.url || event?.url;
      const frame = isMainFrame ?? value?.isMainFrame ?? event?.isMainFrame ?? true;
      if (!frame) return;
      if (!allowedNavigation(url)) {
        this.trace('navigation-blocked', { route: routeInfo(url) });
        event.preventDefault();
        this.fail(new CloudRecycleError('schema'));
      }
    };
    contents.on('will-navigate', handleNavigation);
    contents.on('will-redirect', handleNavigation);
    contents.on('will-frame-navigate', (event, value, _inPlace, isMainFrame) => {
      const main = isMainFrame ?? value?.isMainFrame ?? event?.isMainFrame;
      if (main !== false) return;
      const url = typeof value === 'string' ? value : value?.url || event?.url;
      if (!allowedNavigation(url) && !ownOrigin(url, listOrigin)) event.preventDefault();
    });
    contents.on('did-navigate', (_event, page) => {
      this.trace('navigated', { route: routeInfo(page) });
      if (!allowedNavigation(page)) this.fail(new CloudRecycleError('schema'));
      else if (actualLoginPage(page)) {
        if (this.interactive) this.window.show();
      }
    });
    contents.on('did-fail-load', (_event, code, _description, url, main) => {
      if (main && Number.isInteger(code)) this.trace('navigation-failed', { code, route: routeInfo(url) });
    });
    contents.on('did-finish-load', () => {
      this.trace('navigation-loaded', { route: routeInfo(contents.getURL()) });
      if (!this.interactive && actualLoginPage(contents.getURL())) this.inspectSilentLogin(contents);
      if (officialHome(contents.getURL()) && !this.homeTask) {
        this.homeTask = this.followHome(contents).catch(error => this.fail(error));
      }
    });
    this.window.on('closed', () => {
      this.fail(new CloudRecycleError('canceled'));
      this.onClose();
    });
    debug.on('detach', () => { if (!this.closing) this.fail(new CloudRecycleError('failed')); });
    debug.on('message', (_event, method, params) => this.message(method, params));
    try {
      debug.attach('1.3');
      const enabled = debug.sendCommand('Network.enable', { maxTotalBufferSize: 12 * 1024 * 1024, maxResourceBufferSize: 4 * 1024 * 1024 });
      this.window.loadURL(recyclePage).catch(error => {
        if (!this.closing && !this.failure && error?.code !== 'ERR_ABORTED') this.fail(new CloudRecycleError('failed'));
      });
      await enabled;
      this.trace('debugger-enabled');
    } catch (error) { this.trace('debugger-start-failed', { kind: errorKind(error) }); this.fail(error); }
  }
  async inspectSilentLogin(contents) {
    for (let attempt = 0; attempt < 15 && !this.failure && !this.closing; attempt += 1) {
      if (!actualLoginPage(contents.getURL())) return;
      let needsInput;
      try { needsInput = await contents.executeJavaScript(visibleLoginForm); } catch { return; }
      if (needsInput && actualLoginPage(contents.getURL())) {
        this.trace('sign-in-form-visible', { route: routeInfo(contents.getURL()) });
        this.fail(new CloudRecycleError('auth'));
        return;
      }
      await delay(250);
    }
  }
  async followHome(contents) {
    for (let attempt = 0; attempt < 40 && !this.failure && !this.closing; attempt += 1) {
      if (!officialHome(contents.getURL())) return;
      if (await contents.executeJavaScript(followOfficialRecycle)) {
        this.trace('official-recycle-navigation');
        return;
      }
      await delay(250);
    }
    if (!this.closing && !this.failure && officialHome(contents.getURL())) {
      this.fail(new CloudRecycleError('auth'));
    }
  }
  message(method, params) {
    if (this.failure || this.closing) return;
    if (method === 'Network.requestWillBeSent') {
      const { request, requestId, documentURL } = params;
      const route = routeInfo(request.url);
      if (route === 'list' || route.startsWith('personal-')) this.trace('debugger-request', { route, method: request.method, document: routeInfo(documentURL), type: params.type || null });
      const direct = officialRecycle(documentURL) && ownOrigin(request.url, listOrigin);
      const homeIdentity = officialHome(documentURL) && identityCandidate(request.url);
      if (direct && request.method === 'GET' && route === 'list' && this.capture.next) {
        const match = this.capture.continuationEvidence(request.url);
        if (match.samePath && match.sameQuery && !match.alreadySeen) {
          this.requestedContinuation = this.capture.next;
          this.update();
        }
      }
      const restore = request.method === 'POST' && this.restoreIntent?.gate.route(request.url);
      if (restore) this.trace('restore-debugger-request', { document: routeInfo(documentURL) });
      if ((request.method === 'GET' && (direct || homeIdentity)) || restore) {
        this.requests.set(requestId, request.url);
        if (this.requests.size > 1024) this.requests.delete(this.requests.keys().next().value);
      } else this.requests.delete(requestId);
    } else if (method === 'Network.responseReceived') {
      const { response, requestId } = params;
      const route = routeInfo(response.url);
      const restore = this.restoreIntent;
      if (restore?.gate.route(response.url)) {
        const bound = restore.sent === response.url && this.requests.get(requestId) === response.url &&
          officialRecycle(this.window.webContents.getURL());
        this.trace('restore-debugger-response', { bound, status: response.status });
        if (bound) this.pending.set(requestId, { restore, status: response.status, mimeType: response.mimeType });
        return;
      }
      if (route === 'list' || route.startsWith('personal-')) this.trace('debugger-response', { route, code: response.status, json: /^application\/json/i.test(response.mimeType), top: routeInfo(this.window.webContents.getURL()), originAccepted: this.gets.has(response.url), requestAccepted: this.requests.get(requestId) === response.url });
      const top = this.window.webContents.getURL();
      if ((!officialRecycle(top) && !(officialHome(top) && identityCandidate(response.url))) ||
          !this.gets.has(response.url) || this.requests.get(requestId) !== response.url) return;
      try {
        const hadIdentity = !!this.capture.identity;
        this.capture.observeIdentity(response.url, response.status);
        if (!hadIdentity && this.capture.identity) this.trace('matched-drive');
        this.update();
        if (looksLikeRecycleRequest(response.url)) {
          // Keep only endpoint metadata, never request or response headers.
          this.pending.set(requestId, { url: response.url, status: response.status, mimeType: response.mimeType });
        }
      } catch (error) { this.fail(error); }
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      this.requests.delete(params.requestId);
      const response = this.pending.get(params.requestId);
      if (!response) return;
      this.pending.delete(params.requestId);
      if (method === 'Network.loadingFailed') { this.fail(new CloudRecycleError('failed')); return; }
      this.lane = this.lane.then(async () => {
        if (this.failure || this.closing) return;
        if (response.restore) {
          try { await this.readRestoreResult(params.requestId, response); }
          catch (error) {
            this.trace('restore-response-unconfirmed', { kind: errorKind(error) });
            throw error;
          }
          return;
        }
        this.trace('list-link-check', this.capture.continuationEvidence(response.url));
        const url = this.capture.prepareResponse(response.url, 'GET', response.status, response.mimeType);
        if (!url) return;
        const result = await this.window.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId });
        if (this.failure || this.closing) return;
        if (typeof result.body !== 'string' || result.body.length > 6 * 1024 * 1024) throw new CloudRecycleError('schema');
        let payload;
        try { payload = JSON.parse(result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body); }
        catch { throw new CloudRecycleError('schema'); }
        this.trace('list-body-shape', { count: Array.isArray(payload?.value) ? payload.value.length : null,
          nextPresent: Object.hasOwn(payload || {}, '@odata.nextLink'), nextNull: payload?.['@odata.nextLink'] === null });
        const hadIdentity = !!this.capture.identity;
        this.capture.observePage(url, payload);
        if (!hadIdentity && this.capture.identity) this.trace('matched-drive', { source: 'server-relative-recycle-namespace' });
        else if (!this.capture.identity) this.trace('identity-shapes', identityShapes(payload, this.scope));
        this.trace('accepted-page', { count: Array.isArray(payload.value) ? payload.value.length : null, terminal: this.capture.done });
        this.update();
      }).catch(error => this.fail(error));
    }
  }
  async readRestoreResult(requestId, response) {
    const intent = this.restoreIntent;
    if (!intent || intent !== response.restore) return;
    const status = response.status;
    let payload = null;
    if (status === 200 || status === 207) {
      if (!/^application\/json(?:;|$)/i.test(response.mimeType || '')) throw new CloudRecycleError('schema');
      const { body, base64Encoded } = await this.window.webContents.debugger.sendCommand('Network.getResponseBody', { requestId });
      if (typeof body !== 'string' || body.length > 1024 * 1024) throw new CloudRecycleError('schema');
      try { payload = JSON.parse(base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body); }
      catch { throw new CloudRecycleError('schema'); }
    }
    this.trace('restore-response-shape', { status, count: Array.isArray(payload?.value) ? payload.value.length : null,
      matched: Array.isArray(payload?.value) ? payload.value.filter(row => typeof row?.id === 'string' &&
        intent.ids.some(id => id.toLowerCase() === row.id.toLowerCase())).length : null });
    const outcomes = classifyAcknowledgement(status, payload, intent.ids);
    intent.result = { status, outcomes };
    this.trace('restore-acknowledgement', { status, submitted: outcomes.filter(row => row.state === 'submitted').length,
      rejected: outcomes.filter(row => row.state === 'rejected').length });
    this.update();
  }
  async restoreGuids(ids, signal) {
    this.assertOpen();
    if (this.restoreIntent || !officialRecycle(this.window.webContents.getURL()) ||
        !this.capture.account() || !this.capture.done || !Array.isArray(ids)) throw new CloudRecycleError('schema');
    const offered = new Set();
    for (const page of this.capture.pages.values()) for (const row of page.items) offered.add(row.id.toLowerCase());
    if (ids.some(id => typeof id !== 'string' || !offered.has(id.toLowerCase()))) throw new CloudRecycleError('schema');
    const contents = this.window.webContents;
    const intent = { ids, gate: armRestoreRequest({ listPath: this.capture.path, ids, webContentsId: contents.id }) };
    const wanted = JSON.stringify(ids.map(id => id.toLowerCase()));
    const selectedIds = new Set();
    this.restoreIntent = intent;
    try {
      signal.throwIfAborted();
      await contents.executeJavaScript(`(() => {
        const marker = document.querySelector('[aria-rowcount="-1"]');
        const rows = Array.from((marker || document).querySelectorAll('[role="row"][data-selection-index]'));
        for (const anchor of [rows[0], marker]) {
          for (let node = anchor; node && node !== document.body; node = node.parentElement) {
            if (node.scrollHeight > node.clientHeight + 2 &&
                /auto|scroll|overlay/.test(getComputedStyle(node).overflowY)) node.scrollTop = 0;
          }
        }
      })()`);
      let lastOffset = null;
      let sameOffset = 0;
      while (selectedIds.size < ids.length) {
        signal.throwIfAborted();
        this.assertOpen();
        const checked = await contents.executeJavaScript(`(() => {
          const wanted = new Set(${wanted});
          const accounted = new Set(${JSON.stringify([...selectedIds])});
          const rows = Array.from(document.querySelectorAll('[role="row"][data-selection-index]'));
          const id = row => row.getAttribute('data-selection-index').toLowerCase();
          if (rows.some(row => row.getAttribute('aria-selected') === 'true' && !wanted.has(id(row)))) return null;
          const targets = rows.filter(row => wanted.has(id(row)) && !accounted.has(id(row)));
          if (new Set(targets.map(id)).size !== targets.length) return null;
          let clicked = false;
          for (const row of targets) {
            if (row.getAttribute('aria-selected') === 'true') continue;
            const control = row.querySelector('[role="checkbox"],input[type="checkbox"]');
            (control || row).click();
            clicked = true;
          }
          return { selected: rows.filter(row => row.getAttribute('aria-selected') === 'true').map(id), clicked };
        })()`);
        if (!checked) throw new CloudRecycleError('schema');
        for (const id of checked.selected) selectedIds.add(id);
        if (selectedIds.size === ids.length) break;
        if (!checked.clicked) {
          const target = await contents.executeJavaScript(officialGridScrollTarget);
          if (!target?.scrollable) throw new CloudRecycleError('schema');
          sameOffset = target.offset === lastOffset ? sameOffset + 1 : 0;
          if (sameOffset >= 4) throw new CloudRecycleError('schema');
          lastOffset = target.offset;
          await contents.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: target.x, y: target.y, deltaX: 0,
            deltaY: Math.max(80, Math.floor(target.viewport / 2))
          });
        }
        await delay(250, undefined, { signal });
      }
      signal.throwIfAborted();
      intent.ready = true;
      const pressed = await contents.executeJavaScript(`(() => {
        const wanted = new Set(${wanted});
        const selected = Array.from(document.querySelectorAll('[role="row"][data-selection-index][aria-selected="true"]'));
        if (!selected.length || selected.length > wanted.size ||
            selected.some(row => !wanted.has(row.getAttribute('data-selection-index').toLowerCase()))) return false;
        const controls = Array.from(document.querySelectorAll('[data-automationid="RestoreBinCommand"]'))
          .filter(node => node.getClientRects().length && !node.disabled && node.getAttribute('aria-disabled') !== 'true');
        if (controls.length !== 1) return false;
        controls[0].click();
        return true;
      })()`);
      if (!pressed) throw new CloudRecycleError('schema');
      return await this.until(() => intent.result, signal);
    } finally {
      if (this.restoreIntent === intent) this.restoreIntent = null;
    }
  }
  close() {
    if (this.closing) return;
    this.closing = true;
    this.onClose();
    this.fail(new CloudRecycleError('canceled'));
    if (!this.window.isDestroyed()) {
      const debug = this.window.webContents.debugger;
      if (debug.isAttached()) debug.detach();
      this.window.destroy();
    }
  }
}

class PersonalRecycleProvider {
  constructor({ sessions, Window, parent = () => undefined, trace = () => {}, writable = false }) {
    this.id = 'onedrive-personal-web-v2';
    this.sessions = sessions;
    this.Window = Window;
    this.parent = parent;
    this.trace = trace;
    this.writable = writable;
    this.runs = new WeakMap();
    this.partitions = new Map();
  }
  available(account) { return /^[0-9a-f]{16,64}$/i.test(account.driveId); }
  async open(scope, visible) {
    this.partitions.get(partitionKey(scope))?.close();
    const partition = partitionKey(scope);
    const browserSession = this.sessions.fromPartition(partition);
    const win = new this.Window({ show: visible, width: 980, height: 720, title: '连接 Microsoft OneDrive',
      ...(visible && this.parent() ? { parent: this.parent() } : {}),
      webPreferences: { session: browserSession, nodeIntegration: false, contextIsolation: true, sandbox: true,
        backgroundThrottling: false, webSecurity: true, devTools: false } });
    win.removeMenu();
    this.trace('opening-partition', { interactive: visible });
    const run = new WebRecycleRun({ window: win, browserSession, scope, visible, trace: this.trace, onClose: () => {
      if (this.partitions.get(partition) === run) {
        browserSession.webRequest.onBeforeRequest(null);
        browserSession.webRequest.onCompleted(null);
        this.partitions.delete(partition);
      }
      if (this.runs.get(scope) === run) this.runs.delete(scope);
    } });
    this.partitions.set(partition, run);
    this.runs.set(scope, run);
    await run.start();
    return run;
  }
  async connect(scope, signal) {
    const run = await this.open(scope, true);
    await run.until(() => run.capture.path && run.capture.account(), signal);
    await run.session.cookies.flushStore();
    if (!run.window.isDestroyed()) run.window.hide();
  }
  async getAccount(scope, signal) {
    const run = this.runs.get(scope) || await this.open(scope, false);
    return run.until(() => run.capture.path && run.capture.account(), signal);
  }
  async listPage(scope, cursor, signal) {
    const run = this.runs.get(scope);
    if (!run) throw new CloudRecycleError('auth');
    if (cursor === null) return this.capabilities(scope, await run.until(() => run.capture.page(null), signal));
    signal.throwIfAborted();
    const debuggerClient = run.window.webContents.debugger;
    await debuggerClient.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    const contents = run.window.webContents;
    const hasRequest = () => run.requestedContinuation === cursor;
    const hasProgress = () => run.capture.page(cursor) || hasRequest();
    let stalledAtEdge = 0;
    let nudged = false;
    let target;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      signal.throwIfAborted();
      run.assertOpen();
      if (hasProgress()) {
        return this.capabilities(scope, await run.until(() => run.capture.page(cursor), signal));
      }
      if (!officialRecycle(contents.getURL())) throw new CloudRecycleError('auth');
      target ??= await contents.executeJavaScript(officialGridScrollTarget);
      signal.throwIfAborted();
      run.assertOpen();
      if (hasProgress()) continue;
      if (!officialRecycle(contents.getURL())) throw new CloudRecycleError('auth');
      run.trace('next-page-scroll', { ...target, attempt });
      let deltaY = 0;
      if (target?.scrollable) {
        const remaining = target.max - target.offset;
        if (remaining > 2) {
          stalledAtEdge = 0;
          deltaY = Math.max(300, remaining + target.viewport);
        } else if (++stalledAtEdge === 3 && !nudged) {
          nudged = true;
          deltaY = -Math.max(100, Math.floor(target.viewport / 3));
        }
        if (deltaY) {
          run.trace('next-page-trigger', { attempt, remaining });
          await debuggerClient.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: target.x, y: target.y, deltaX: 0, deltaY
          });
        }
      }
      if (!hasProgress()) target = await waitForGridProgress(run, target, hasProgress, signal);
    }
    if (hasProgress()) return this.capabilities(scope, await run.until(() => run.capture.page(cursor), signal));
    throw new CloudRecycleError('schema');
  }
  capabilities(scope, page) {
    if (!this.writable) return page;
    return { ...page, items: page.items.map(row => canRestoreOriginal(row, scope.driveId)
      ? { ...row, capability: { mode: 'provider', verified: true } } : row) };
  }
  async restoreGuids(scope, ids, signal) {
    const run = this.runs.get(scope);
    if (!run) throw new CloudRecycleError('auth');
    return run.restoreGuids(ids, signal);
  }
  finish(scope) { this.runs.get(scope)?.close(); }
}

module.exports = { PersonalRecycleProvider, WebRecycleRun, allowedNavigation, partitionKey };
