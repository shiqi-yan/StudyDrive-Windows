const { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol, safeStorage, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { Store, itemKey } = require('./store.cjs');
const { signIn, canRestore } = require('./auth.cjs');
const { releaseClientId, TEST_CLIENT_ID } = require('./login-config.cjs');
const { Drive, itemInfo } = require('./drive.cjs');
const { DriveIndex } = require('./drive-index.cjs');
const { CloudRecycle } = require('./cloud-recycle.cjs');
const { PersonalRecycleProvider } = require('./onedrive-recycle-browser.cjs');
const { restoreOriginals } = require('./cloud-recycle-restore.cjs');
const { describeRecycleType } = require('./recycle-kind.cjs');
const { recordInstance, runningVersion } = require('./instance-version.cjs');
const { Media, origin, requestMedia } = require('./media.cjs');
const { Transfers } = require('./transfers.cjs');
const { FileActions, selectedItems, destination } = require('./file-actions.cjs');
const { startMock } = require('./mock.cjs');
const { convertedLink, warmPdf, originalLink, localDocument, DocumentSession, imageName } = require('./documents.cjs');
const { LocalOffice } = require('./local-office.cjs');
const { previewCapability } = require('./preview-capability.cjs');

const startDemo = process.argv.includes('--demo');
const testDriver = startDemo && process.argv.includes('--test-driver') && process.env.STUDY_DRIVER === '1';
const packagedLogin = require('../package.json').studyDriveAuth;
const buildVersion = app.getVersion();
const verifyCloudRead = app.isPackaged && buildVersion.endsWith('-cloud-preview') &&
  process.argv.includes('--verify-cloud-recycle-read-only');
const cloudRelease = app.isPackaged && !buildVersion.endsWith('-cloud-preview') && packagedLogin?.mode === 'release' && !startDemo;
const windowTitle = '课盘 ' + buildVersion;
const testLogin = testDriver && process.argv.includes('--test-auth') &&
  packagedLogin?.mode === 'test' && packagedLogin.clientId === TEST_CLIENT_ID;
const loginClientId = testLogin ? TEST_CLIENT_ID : releaseClientId(packagedLogin);
const demoBuild = !loginClientId;
const defaultProfile = app.getPath('userData');
const profile = testDriver && process.env.STUDY_TEST_PROFILE ? process.env.STUDY_TEST_PROFILE
  : startDemo ? path.join(defaultProfile, 'demo') : demoBuild ? path.join(defaultProfile, 'local-demo-build') : defaultProfile;
app.setPath('userData', profile);
protocol.registerSchemesAsPrivileged([{ scheme: 'study', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true
} }]);

const pageUrl = origin + '/index.html';
const rates = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const mediaDemuxers = { 'video/mp4': 'mov', 'video/webm': 'matroska', 'video/x-matroska': 'matroska',
  'audio/mp4': 'mov', 'audio/mpeg': 'mp3', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac' };
let win;
let store;
let drive;
let account;
let pendingLogin;
let demo;
let startupError = '';
let startupTask;
let startupReady = false;
let libraryRevision = 0;
const pages = new Map();
const directories = new Map();
const knownFolders = new Map();
let listLifetime = new AbortController();
let completedUploads = new Set();
const media = new Media(requestMedia);
const localOffice = new LocalOffice(profile, require('../package.json').studyDriveOffice);
let transfers;
let fileActions;
let cloudRecycle;
const batchPlans = new Map();
let driveIndex;
const newIndex = () => new DriveIndex(path.join(profile, 'drive-index.sqlite'), state => {
  if (win && !win.isDestroyed()) win.webContents.send('drive:index-changed', libraryRevision, state);
}, { online: () => !!drive?.mock || net.isOnline() });
let player;
let requestedPlayer = '';
let playerRevision = 0;
let playerClosing;
const mime = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.gif': 'image/gif', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream', '.wasm': 'application/wasm' };

function staticAssets() {
  return async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'desktop' || request.method !== 'GET') return new Response('', { status: 404 });
    let target;
    const pathname = url.pathname;
    if (/^\/(?:index\.html|style\.css|(?:app|ui|player|preview|player-math|document-view|sheet-view|file-window|selection)\.mjs|mark\.png)$/.test(pathname)) {
      target = path.join(__dirname, 'renderer', pathname.slice(1));
    } else if (/^\/icons\/[a-z]+\.(?:svg|png|gif)$/.test(pathname)) {
      target = path.join(__dirname, 'renderer', 'icons', pathname.slice('/icons/'.length));
    } else if (/^\/pdf\/(?:pdf(?:\.worker)?\.min\.mjs|(?:cmaps|standard_fonts|wasm|iccs)\/[A-Za-z0-9_.-]+)$/.test(pathname)) {
      const name = pathname.slice('/pdf/'.length);
      const vendor = app.isPackaged ? path.join(app.getAppPath(), 'vendor', 'pdf') : path.join(app.getAppPath(), 'node_modules', 'pdfjs-dist');
      target = path.join(vendor, app.isPackaged || name.includes('/') ? '' : 'build', name);
    }
    if (!target) return new Response('', { status: 404 });
    try {
      return new Response(await fs.readFile(target), { headers: { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data: http://127.0.0.1:*; media-src http://127.0.0.1:*; connect-src 'self' http://127.0.0.1:*; worker-src 'self' blob:; font-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" } });
    } catch { return new Response('', { status: 404 }); }
  };
}

function assertAccount() {
  if (!account || !drive) throw new Error('请先登录或打开本地演示。');
  return { account, drive };
}
function id(value) {
  if (typeof value !== 'string' || !value.length || value.length > 400 || /[\u0000-\u001f]/.test(value)) throw new Error('文件标识无效。');
  return value;
}
function same(session) {
  if (session.account !== account || session.drive !== drive) throw new Error('账户已切换。');
}
const documentPositions = {
  pdf: ['page'], sheet: ['sheet', 'row', 'col'], markdown: ['heading', 'line', 'source'], text: ['line']
};
function lookupTicket(key) {
  assertAccount();
  return media.ticket(key, account);
}
function playerBounds(value) {
  if (!['x', 'y', 'width', 'height'].every(field => Number.isFinite(value?.[field]) && Math.abs(value[field]) < 32000)) {
    throw new Error('视频区域无效。');
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height, visible: value.visible === true };
}
function mediaSettings() {
  const data = store.data.settings || {};
  return { rate: rates.includes(data.rate) ? data.rate : 1,
    volume: Number.isFinite(data.volume) ? Math.min(100, Math.max(0, data.volume)) : 100, muted: data.muted === true };
}
function savePlayer(active) {
  const { engine, ticket } = active;
  if (!ticket.opened || ticket.account !== account || !(engine.state.duration > 0)) return;
  store.watch(account.id, ticket.item, engine.state.ended ? engine.state.duration : engine.last, engine.state.duration);
  active.saved = Date.now();
}
function stopPlayer(key) {
  if (key && player?.key !== key && requestedPlayer !== key) return playerClosing;
  playerRevision += 1;
  requestedPlayer = '';
  if (!player) return playerClosing;
  const old = player;
  player = null;
  try { savePlayer(old); } catch {}
  old.ticket.resumePosition = old.engine.last;
  const result = old.engine.close().finally(() => { if (playerClosing === result) playerClosing = null; });
  playerClosing = result;
  return result;
}
function currentPlayer(key) {
  const ticket = lookupTicket(key);
  if (player?.key !== key || player.ticket !== ticket) throw new Error('当前预览已关闭。');
  return player;
}
function activeTransfers() {
  for (const job of transfers?.list() || []) {
    if (job.direction !== 'upload' || job.state !== 'done' || completedUploads.has(job.id)) continue;
    completedUploads.add(job.id);
    invalidateDirectories();
  }
  if (win && !win.isDestroyed()) win.webContents.send('drive:transfers-changed');
}
function invalidateDirectories() {
  listLifetime.abort();
  listLifetime = new AbortController();
  directories.clear();
  pages.clear();
}
function rememberFolder(item) {
  if (item.kind !== 'folder') return;
  knownFolders.set(item.id, item);
  if (knownFolders.size > 512) knownFolders.delete(knownFolders.keys().next().value);
}
function initial() {
  const vault = demoBuild ? {} : (() => { try { return store.vault(); } catch { return {}; } })();
  return {
    account, demo: !!drive?.mock, canRestore: !!drive?.restoreAvailable, startupError, settings: mediaSettings(), loginAvailable: !!loginClientId,
    accounts: Object.values(vault).map(record => ({ id: record.account.id, name: record.account.name })),
    accountRevision: libraryRevision
  };
}
function library() {
  if (!account) return { recent: [], watching: [], favorites: [] };
  const data = store.account(account.id);
  return { recent: data.recent.filter(row => !row.item.trashed),
    watching: Object.values(data.watching).filter(row => row.seconds > 0 && !row.item.trashed).sort((a, b) => b.at - a.at),
    favorites: data.favorites.filter(item => !item.trashed) };
}
async function activate(next, nextDrive) {
  cloudRecycle.select(null);
  if (win && !win.isDestroyed()) win.webContents.send('drive:cloud-recycle-changed', libraryRevision, { reset: true });
  transfers.detach();
  const stopped = stopPlayer();
  media.clear();
  await stopped;
  localOffice.clear();
  invalidateDirectories();
  knownFolders.clear();
  batchPlans.clear();
  account = next;
  drive = nextDrive;
  libraryRevision += 1;
  driveIndex.select(next, nextDrive);
  cloudRecycle.select(next);
  completedUploads = new Set(next ? store.account(next.id).transfers.filter(job => job.direction === 'upload' && job.state === 'done').map(job => job.id) : []);
  if (next) rememberFolder(next.root);
  if (next) transfers.attach(next, nextDrive);
  else activeTransfers();
}
function authFixture() {
  const fixture = globalThis.studyTest?.auth;
  if (!fixture) throw new Error('模拟授权服务尚未就绪。');
  return fixture;
}
const authFetcher = testLogin ? (...args) => authFixture().fetcher(...args) : undefined;
function signedViaWindows(url, { headers, signal }) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const request = net.request({ url, redirect: 'manual', credentials: 'omit' });
    for (const name of ['Range', 'Accept-Encoding']) if (headers[name]) request.setHeader(name, headers[name]);
    const abort = () => { request.abort(); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    request.once('close', () => signal.removeEventListener('abort', abort));
    request.once('error', reject);
    request.once('redirect', (status, _method, location) => resolve(new Response(null, { status, headers: { Location: location } })));
    request.once('response', message => {
      const status = message.statusCode;
      const noBody = [204, 205, 304].includes(status);
      if (noBody) message.resume();
      try {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(message.headers)) responseHeaders.set(name, String(value));
        const body = noBody ? null : Readable.toWeb(message);
        message.once('aborted', () => message.destroy(new Error('OneDrive 文件连接已中断。')));
        resolve(new Response(body, { status, headers: responseHeaders }));
      } catch (error) { request.abort(); reject(error); }
    });
    request.end();
  });
}
function authDrive(record) {
  const key = record.account.id;
  let previous = record.credentials;
  const sessionDrive = new Drive({ credentials: record.credentials, clientId: record.clientId, fetcher: authFetcher, save(credentials) {
    const vault = store.vault();
    const saved = vault[key];
    if (saved?.clientId === record.clientId && saved.credentials.access === previous.access && saved.credentials.refresh === previous.refresh) {
      saved.credentials = credentials;
      store.saveVault(vault);
      previous = credentials;
    }
  } });
  if (!testLogin) sessionDrive.proxyFetcher = signedViaWindows;
  return sessionDrive;
}
async function activateDemo() {
  if (!demo) demo = await startMock(profile, path.join(app.getAppPath(), 'fixtures'));
  const mockDrive = new Drive({ base: demo.base, credentials: { access: 'mock-account' }, mock: true });
  const mockAccount = await mockDrive.identity();
  await activate(mockAccount, mockDrive);
  startupError = '';
}
async function initialize() {
  if (startDemo && !testLogin) return activateDemo();
  if (demoBuild) return;
  try {
    const record = store.vault()[store.data.active];
    if (record) await activate(record.account, authDrive(record));
  } catch { startupError = 'Windows 无法读取保存的登录，请重新登录。'; }
}
function startupStage(text) {
  if (testDriver) globalThis.studyTest.startupStages.push(text);
  if (win && !win.isDestroyed()) win.webContents.send('drive:startup-stage', text);
}
function ensureStartup(retry = false) {
  if (startupTask) return startupTask;
  if (startupReady && !(retry && startupError && !account)) return initial();
  startupReady = false;
  startupError = '';
  startupTask = (async () => {
    startupStage('正在准备本地资料…');
    store ||= new Store(profile, safeStorage);
    driveIndex ||= newIndex();
    cloudRecycle ||= new CloudRecycle(driveIndex.db, {
      provider: verifyCloudRead || cloudRelease ? new PersonalRecycleProvider({
        sessions: session, Window: BrowserWindow, parent: () => win, writable: cloudRelease,
        trace: process.env.STUDY_CLOUD_RECYCLE_DIAGNOSTICS === '1'
          ? (event, details) => console.info('STUDY_CLOUD_DIAGNOSTIC ' + JSON.stringify({ event, ...details })) : undefined
      }) : null,
      onRestore: cloudRelease ? restoreOriginals : null,
      onChange: state => {
        if (win && !win.isDestroyed()) win.webContents.send('drive:cloud-recycle-changed', libraryRevision, state);
      }
    });
    fileActions ||= new FileActions(driveIndex, (owner, item, method) => {
      if (method === 'delete') store.markDeleted(owner.id, item);
      else store.rename(owner.id, item);
      if (owner !== account) return;
      invalidateDirectories();
      knownFolders.clear();
      if (method !== 'delete') rememberFolder(item);
      if (win && !win.isDestroyed()) win.webContents.send('drive:recycle-changed');
    });
    transfers ||= new Transfers(store, activeTransfers, async (owner, run, parentId) => {
      const result = await driveIndex.mutate(owner, run, raw => {
        try {
          const item = raw?.kind && raw.driveId === owner.driveId ? raw : itemInfo(raw, owner.driveId);
          return { ...item, parentId: item.parentId || parentId };
        } catch { return null; }
      });
      if (owner === account) invalidateDirectories();
      return result;
    }, (...args) => fileActions.run(...args));
    if (!media.host) await media.start();
    if (!win || win.isDestroyed()) return { startupFailed: true };
    startupStage('正在恢复登录…');
    try { await initialize(); }
    catch { startupError = '暂时无法恢复登录或载入演示，可重试。'; }
    if (testDriver) Object.assign(globalThis.studyTest, { mock: demo?.test, store });
    startupReady = true;
    return initial();
  })().catch(() => ({ startupFailed: true })).finally(() => { startupTask = null; });
  return startupTask;
}
function invoke(name, handler) {
  ipcMain.handle('drive:' + name, async (event, ...args) => {
    if (event.sender !== win?.webContents || event.senderFrame?.url !== pageUrl || event.senderFrame !== win.webContents.mainFrame) return { error: '操作来源无效。' };
    if (!startupReady && name !== 'initial') return { error: '正在准备课盘，请稍后重试。' };
    try { return { data: await handler(...args) }; }
    catch (error) {
      const message = error?.message || '';
      const safe = /^(?:(?:Microsoft|OneDrive|Windows) )?[\u3400-\u9fff]/u.test(message) && !/[:/\\\r\n]/.test(message) && message.length <= 100;
      return { error: safe ? message : '操作未完成，请重试。' };
    }
  });
}
function bind() {
  invoke('initial', retry => ensureStartup(retry === true));
  invoke('quota', async () => {
    const session = assertAccount();
    const quota = await session.drive.quota(session.account, AbortSignal.timeout(10000));
    same(session);
    return quota;
  });
  invoke('demo', async () => { pendingLogin?.abort(); await activateDemo(); return initial(); });
  invoke('login', async action => {
    const restoring = action === 'restore';
    const existing = restoring ? assertAccount() : null;
    if (!loginClientId) throw new Error('此版本为本地演示包。请使用已配置的正式版连接 Microsoft。');
    if (pendingLogin) throw new Error('登录正在进行中。');
    const controller = new AbortController();
    pendingLogin = controller;
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 凭据加密不可用。');
      const openBrowser = testLogin ? url => authFixture().openExternal(url) : url => shell.openExternal(url);
      const nextState = await signIn(loginClientId, openBrowser, { signal: controller.signal, fetcher: authFetcher, restore: restoring, complete: async credentials => {
      if (controller.signal.aborted) throw new Error('Microsoft 登录已取消。');
      const candidate = new Drive({ credentials, clientId: loginClientId, fetcher: authFetcher });
      const next = await candidate.identity(controller.signal);
      if (controller.signal.aborted) throw new Error('Microsoft 登录已取消。');
      if (existing) {
        same(existing);
        if (next.id !== existing.account.id) throw new Error('还原授权须使用当前课盘账户。');
        if (!canRestore(credentials)) throw new Error('Microsoft 未授予还原权限，原登录仍可使用。');
      }
      const vault = store.vault();
      const record = { account: next, clientId: candidate.clientId, credentials };
      vault[next.id] = record;
      store.saveVault(vault);
      store.data.active = next.id;
      startupError = '';
      store.save();
      await activate(next, authDrive(record));
      return initial();
      } });
      if (!win?.isDestroyed()) { if (win?.isMinimized()) win.restore(); win?.focus(); }
      return nextState;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Microsoft 登录已取消。');
      throw error;
    } finally { pendingLogin = null; }
  });
  invoke('cancelLogin', () => pendingLogin?.abort());
  invoke('switchAccount', async key => {
    if (demoBuild) throw new Error('此版本仅支持本地演示。');
    const vault = store.vault();
    const record = Object.hasOwn(vault, key) && vault[key];
    if (!record) throw new Error('此账户需要重新登录。');
    pendingLogin?.abort();
    store.data.active = key;
    store.save();
    await activate(record.account, authDrive(record));
    return initial();
  });
  invoke('signOut', async () => {
    pendingLogin?.abort();
    if (account && !drive.mock) {
      const vault = store.vault();
      delete vault[account.id];
      store.saveVault(vault);
      store.data.active = '';
      store.save();
    }
    await activate(null, null);
    return initial();
  });
  invoke('library', library);
  invoke('indexStatus', async () => {
    const current = assertAccount();
    const status = await driveIndex.status(current.account);
    same(current);
    return status;
  });
  invoke('indexRefresh', action => {
    assertAccount();
    driveIndex.refresh({ manual: action === 'refresh', rebuild: action === 'rebuild' });
  });
  invoke('cancelSearch', revision => { if (revision === libraryRevision) driveIndex.cancelSearch(); });
  invoke('search', async (input = {}) => {
    const current = assertAccount();
    if (input.accountRevision !== libraryRevision) throw new Error('账户已切换。');
    const result = await driveIndex.search(current.account, {
      query: typeof input.query === 'string' ? input.query : '', scope: input.scope ? id(input.scope) : '',
      sort: input.sort, filter: input.filter, since: input.since, offset: input.offset, revision: input.revision
    });
    same(current);
    return result;
  });
  invoke('list', async (input = {}) => {
    const current = assertAccount();
    const folderId = id(input.id);
    const sort = ['name', 'newest', 'oldest', 'largest'].includes(input.sort) ? input.sort : 'name';
    const page = input.cursor ? pages.get(input.cursor) : null;
    const signature = JSON.stringify([folderId, sort]);
    if (input.cursor && page?.signature !== signature) throw new Error('分页已失效，请刷新列表。');
    const signal = listLifetime.signal;
    const load = async () => {
      const value = await current.drive.list(current.account, { id: folderId, sort, next: page?.next, signal });
      same(current);
      signal.throwIfAborted();
      for (const item of value.items) rememberFolder(item);
      return value;
    };
    let stale = false;
    let result;
    if (input.cursor) result = await load();
    else {
      let entry = directories.get(signature);
      if (!entry) {
        entry = { at: 0 };
        directories.set(signature, entry);
        if (directories.size > 100) directories.delete(directories.keys().next().value);
      }
      const age = Date.now() - entry.at;
      if (entry.value && !input.refresh && age < 120000) {
        result = entry.value;
        stale = age >= 15000;
      } else {
        entry.pending ||= load().then(value => {
          entry.at = Date.now();
          entry.value = value;
          return value;
        }).finally(() => { entry.pending = null; });
        result = await entry.pending;
      }
    }
    same(current);
    const cursor = result.next ? randomUUID() : '';
    if (cursor) {
      pages.set(cursor, { signature, next: result.next });
      if (pages.size > 160) pages.delete(pages.keys().next().value);
    }
    return { items: result.items, cursor, stale };
  });
  invoke('openFolder', async itemId => {
    const current = assertAccount();
    const folderId = id(itemId);
    const lookup = async id => knownFolders.get(id) || current.drive.get(current.account, id, listLifetime.signal);
    const item = await lookup(folderId);
    if (item.kind !== 'folder') throw new Error('请选择一个文件夹。');
    const trail = await current.drive.trail(current.account, item, lookup);
    same(current);
    for (const folder of trail) rememberFolder(folder);
    store.touch(account.id, item);
    return trail;
  });
  invoke('searchFolder', async itemId => {
    const current = assertAccount();
    const trail = await driveIndex.trail(current.account, id(itemId));
    same(current);
    if (!trail) throw new Error('索引暂时无法确认此文件夹的路径。');
    return trail;
  });
  invoke('rename', async (itemId, name) => {
    const current = assertAccount();
    const changed = await driveIndex.mutate(current.account, () => current.drive.rename(current.account, id(itemId), name), item => item);
    same(current);
    store.rename(account.id, changed);
    invalidateDirectories();
    rememberFolder(changed);
    return changed;
  });
  invoke('mkdir', async (parent, name) => {
    const current = assertAccount();
    const folder = await driveIndex.mutate(current.account, () => current.drive.mkdir(current.account, id(parent), name), item => item);
    same(current);
    invalidateDirectories();
    rememberFolder(folder);
    return folder;
  });
  invoke('move', async (itemId, folderId) => {
    const current = assertAccount();
    const result = await fileActions.run(current.drive, current.account, 'move',
      { id: id(itemId), driveId: current.account.driveId }, { parent: id(folderId) });
    same(current);
    return result;
  });
  invoke('remove', async itemId => {
    const current = assertAccount();
    await fileActions.run(current.drive, current.account, 'remove', { id: id(itemId), driveId: current.account.driveId });
    same(current);
  });
  invoke('trash', async () => {
    const current = assertAccount();
    const rows = await driveIndex.trashRows(current.account);
    same(current);
    return { rows: rows.map(row => ({ ...row, ...describeRecycleType(row.item.name, row.item.kind) })),
      canRestore: current.drive.restoreAvailable, canAuthorize: !!loginClientId };
  });
  invoke('cloudTrash', async (input, revision) => {
    const current = assertAccount();
    if (revision !== libraryRevision) throw new Error('账户已切换。');
    const result = await cloudRecycle.page(current.account, input || {});
    same(current);
    return result;
  });
  invoke('cloudTrashRefresh', (connect, revision) => {
    assertAccount();
    if (revision !== libraryRevision) throw new Error('账户已切换。');
    cloudRecycle.refresh({ connect: connect === true });
  });
  invoke('cloudTrashRestore', async (generation, values, revision) => {
    const current = assertAccount();
    if (revision !== libraryRevision) throw new Error('账户已切换。');
    const results = await cloudRecycle.restore(current.account, generation, values, current.drive, async item => {
      same(current);
      await driveIndex.mutate(current.account, async () => item, value => value);
      await driveIndex.setTrash(current.account, item.id, 'restored');
      same(current);
    });
    same(current);
    if (results.some(item => item.state === 'restored')) {
      invalidateDirectories();
      knownFolders.clear();
      driveIndex.refresh({ manual: true });
      if (win && !win.isDestroyed()) win.webContents.send('drive:recycle-changed');
    }
    return results;
  });
  invoke('cloudTrashCancel', revision => {
    assertAccount();
    if (revision === libraryRevision) cloudRecycle.cancel();
  });
  invoke('batchPlan', async (operation, values, revision) => {
    const current = assertAccount();
    if (revision !== libraryRevision || !Array.isArray(values) || !values.length || values.length > 10000 ||
      !['move', 'remove', 'download', 'restore'].includes(operation)) throw new Error('请选择当前账户下的项目。');
    const ids = [...new Set(values.map(id))];
    let items;
    if (operation === 'restore') {
      if (!current.drive.restoreAvailable) throw new Error('请先在回收站授权还原权限。');
      const choices = new Map((await driveIndex.trashRows(current.account)).filter(row => row.state !== 'pending')
        .map(row => [row.id, row.item]));
      items = ids.map(key => choices.get(key));
      if (items.some(item => !item)) throw new Error('部分回收站项目已变化，请刷新后重试。');
    } else items = await selectedItems(current.drive, current.account, ids, AbortSignal.timeout(120000));
    same(current);
    const ticket = randomUUID();
    batchPlans.set(ticket, { current, items, operation, expires: Date.now() + 15 * 60_000 });
    if (batchPlans.size > 32) batchPlans.delete(batchPlans.keys().next().value);
    return { ticket, count: items.length, folders: items.filter(item => item.kind === 'folder').length, selected: ids.length };
  });
  invoke('batchStart', async (ticket, options = {}) => {
    const plan = batchPlans.get(id(ticket));
    if (!plan || plan.expires <= Date.now()) throw new Error('选择已过期，请重新选择项目。');
    batchPlans.delete(ticket);
    const { current, items, operation } = plan;
    same(current);
    if (operation === 'download') {
      const target = await dialog.showOpenDialog(win, { title: '选择下载保存到的文件夹', properties: ['openDirectory', 'createDirectory'] });
      if (target.canceled || !target.filePaths[0]) return '';
      same(current);
      return transfers.folderDownload(items, target.filePaths[0]);
    }
    const parent = options.parent ? id(options.parent) : '';
    const name = typeof options.name === 'string' && options.name.trim() ? options.name.trim().slice(0, 255) : '';
    if (operation === 'move' && !parent) throw new Error('请选择目标文件夹。');
    if (operation === 'restore' && name && items.length !== 1) throw new Error('批量还原请保留原名称。');
    if (parent) await destination(current.drive, current.account, parent);
    same(current);
    return transfers.batch(operation, items, { parent, name });
  });
  invoke('favorite', async itemId => {
    const current = assertAccount();
    const item = await current.drive.get(current.account, id(itemId));
    if (item.kind !== 'folder') throw new Error('请选择课程文件夹。');
    same(current);
    store.favorite(account.id, item);
    return library();
  });
  invoke('history', (kind, itemId) => {
    assertAccount();
    store.history(account.id, kind, itemId ? { id: id(itemId), driveId: account.driveId } : null);
    return library();
  });
  invoke('open', async (itemId, resume, requestedView) => {
    const current = assertAccount();
    const item = await current.drive.get(current.account, id(itemId));
    if (item.kind === 'online') {
      if (current.drive.mock) throw new Error('本地演示中的 Office 项仅用于展示。');
      const url = await current.drive.webUrl(current.account, item.id);
      same(current);
      await shell.openExternal(url);
      same(current);
      store.touch(account.id, item);
      return { item };
    }
    const capability = previewCapability(item, requestedView, localOffice);
    const { view, source, pageView, limit } = capability;
    const converted = Boolean(source);
    same(current);
    const watched = store.account(account.id).watching[itemKey(item)];
    const getLink = converted ? signal => convertedLink(current.drive, current.account, item, signal)
      : ['audio', 'video'].includes(view) ? undefined : originalLink(current.drive, current.account, item);
    const issued = media.issue(current.drive, account, item, { getLink, type: view === 'pdf' ? 'application/pdf' : item.type, purpose: converted ? 'conversion' : undefined });
    const ticket = lookupTicket(issued.key);
    const position = resume ? watched?.seconds || 0 : 0;
    Object.assign(ticket, { view, converted, source, localLimit: capability.localLimit, resumePosition: position });
    if (!converted && !limit && localDocument(item)) ticket.document = new DocumentSession(ticket);
    const access = ['audio', 'video'].includes(view) ? { key: issued.key } : issued;
    return { item, ...access, ...capability, converted, pageView, position, documentPosition: store.position(account.id, item, view) };
  });
  invoke('release', async key => {
    if (typeof key !== 'string') return;
    const closed = stopPlayer(key);
    media.release(key);
    await closed;
  });
  invoke('playerStart', async (key, value) => {
    const bounds = playerBounds(value);
    const ticket = lookupTicket(key);
    const source = media.nativeSource(key, account);
    const demuxer = mediaDemuxers[ticket.item.type];
    if (!demuxer) throw new Error('此媒体的封装或编码无法解码，请下载原件查看。');
    const stopped = stopPlayer();
    const generation = ++playerRevision;
    requestedPlayer = key;
    await stopped;
    if (generation !== playerRevision || lookupTicket(key) !== ticket) throw new Error('当前预览已关闭。');
    requestedPlayer = '';
    const { PlayerSession } = require('./mpv-session.cjs');
    const active = { key, ticket, saved: 0 };
    const failure = () => ticket.failure || '';
    active.engine = new PlayerSession(app.getAppPath(), win, { ...source, video: ticket.view === 'video', demuxer, failure },
      { ...mediaSettings(), position: ticket.resumePosition }, bounds, state => {
        if (player !== active || ticket.account !== account || !win || win.isDestroyed()) return;
        if (state.ready && !ticket.opened) {
          try { store.touch(account.id, ticket.item); ticket.opened = true; } catch {}
        }
        if (!state.seeking && Date.now() - active.saved >= 4000) {
          try { savePlayer(active); } catch {}
        }
        win.webContents.send('drive:player-state', key, state);
      });
    player = active;
    active.engine.resize(bounds);
    return active.engine.state;
  });
  invoke('playerBounds', (key, value) => {
    if (key === player?.key) currentPlayer(key).engine.resize(playerBounds(value));
  });
  invoke('playerControl', (key, operation, value) => {
    const { engine } = currentPlayer(key);
    if (!engine.state.ready || engine.state.error) return;
    if (operation === 'seek' && Number.isFinite(value) && engine.state.seekable) engine.seek(value);
    else if (operation === 'pause' && typeof value === 'boolean') {
      if (!value && engine.state.ended) engine.seek(0);
      engine.send(['set', 'pause', value ? 'yes' : 'no']);
    } else if ((operation === 'volume' && Number.isFinite(value) && value >= 0 && value <= 100) ||
      (operation === 'mute' && typeof value === 'boolean') || (operation === 'speed' && rates.includes(value))) {
      engine.send(['set', operation, operation === 'mute' ? (value ? 'yes' : 'no') : String(value)]);
      store.data.settings[operation === 'mute' ? 'muted' : operation === 'speed' ? 'rate' : 'volume'] = value;
      store.save();
    } else if (operation === 'audio' || operation === 'sub') {
      const off = operation === 'sub' && value === 0;
      if (off || engine.state.tracks.some(track => track.type === operation && track.id === value)) {
        engine.send(['set', operation === 'audio' ? 'aid' : 'sid', off ? 'no' : String(value)]);
      }
    }
  });
  invoke('playerSubtitle', async key => {
    const active = currentPlayer(key);
    if (active.ticket.view !== 'video' || !active.engine.state.ready) return;
    const selected = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: '字幕', extensions: ['srt', 'vtt'] }] });
    if (selected.canceled || player !== active) return;
    const file = selected.filePaths[0];
    if (!file || !/\.(?:srt|vtt)$/i.test(file)) throw new Error('请选择 SRT 或 VTT 字幕。');
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 4 * 1024 ** 2) throw new Error('字幕必须是小于 4 MB 的文本文件。');
    if (player === active) active.engine.addSubtitle(file);
  });
  invoke('mediaStatus', key => lookupTicket(key).failure || '');
  invoke('viewed', key => {
    const ticket = lookupTicket(key);
    if (ticket.opened || !ticket.view) return;
    store.touch(account.id, ticket.item);
    ticket.opened = true;
  });
  invoke('position', (key, input) => {
    const ticket = lookupTicket(key);
    const fields = documentPositions[ticket.view];
    if (!ticket.opened || !fields || !input) return;
    const position = {};
    for (const field of fields) {
      const value = input[field];
      if (Number.isInteger(value) && value >= 0 && value <= 1048576) position[field] = value;
    }
    if (ticket.view !== 'pdf' && ['auto', 'utf-8', 'utf-16le', 'utf-16be', 'gbk', 'gb18030'].includes(input.encoding)) position.encoding = input.encoding;
    if (ticket.view === 'sheet' && ['', ',', '\t', ';', '|'].includes(input.delimiter)) position.delimiter = input.delimiter;
    if (Object.keys(position).length) store.setPosition(account.id, ticket.item, ticket.view, position);
  });
  invoke('preparePdf', key => {
    const ticket = lookupTicket(key);
    if (!ticket.converted) return;
    ticket.preparing ||= (async () => {
      const announce = text => {
        if (!ticket.controller.signal.aborted && win && !win.isDestroyed()) win.webContents.send('drive:office-stage', key, text);
      };
      if (ticket.source === 'local') {
        try {
          const pdf = await localOffice.prepare(ticket, announce);
          ticket.controller.signal.throwIfAborted();
          ticket.localPdf = pdf;
          return 'local';
        } catch (error) {
          ticket.controller.signal.throwIfAborted();
          if (!error.officeOnlineFallback) throw error;
          announce('本机转换暂不可用，正在尝试 OneDrive 转换…');
          try { await warmPdf(ticket); }
          catch (backup) {
            ticket.controller.signal.throwIfAborted();
            if ([401, 403, 404, 410].includes(backup.status)) throw backup;
            throw error;
          }
          return 'graph';
        }
      }
      try { await warmPdf(ticket); }
      catch (error) {
        ticket.controller.signal.throwIfAborted();
        if (!ticket.localLimit || [401, 403, 404, 410].includes(error.status)) throw error;
        throw new Error(ticket.localLimit + '，OneDrive 转换也未完成。');
      }
      return 'graph';
    })();
    return ticket.preparing;
  });
  invoke('document', (key, operation, input) => {
    const ticket = lookupTicket(key);
    if (!ticket.document || !['parse', 'lines', 'cells', 'viewport', 'cell', 'find'].includes(operation)) throw new Error('此文件没有文档预览。');
    return ticket.document.request(operation, input);
  });
  invoke('markdownImage', async (key, source) => {
    const ticket = lookupTicket(key);
    const name = imageName(source);
    if (ticket.view !== 'markdown' || !name || !ticket.item.parentId || ticket.children.size >= 48) return '';
    const previous = ticket.children.get(name);
    if (previous) return previous.url;
    const item = await ticket.drive.relativeImage(ticket.account, ticket.item.parentId, name, ticket.controller.signal);
    if (lookupTicket(key) !== ticket || ticket.children.size >= 48) return '';
    const issued = ticket.children.get(name) || media.issue(ticket.drive, ticket.account, item,
      { getLink: originalLink(ticket.drive, ticket.account, item) });
    ticket.children.set(name, issued);
    return issued.url;
  });
  invoke('openWeb', async key => {
    const ticket = lookupTicket(key);
    const url = await ticket.drive.webUrl(ticket.account, ticket.item.id);
    if (lookupTicket(key) === ticket) await shell.openExternal(url);
  });
  invoke('copyText', (key, text) => {
    lookupTicket(key);
    if (typeof text === 'string' && text.length <= 8 * 1024 ** 2) clipboard.writeText(text);
  });
  invoke('transfers', () => transfers.list());
  invoke('transferEntries', (key, offset) => {
    assertAccount();
    return transfers.entries(id(key), Number.isSafeInteger(offset) && offset > 0 ? offset : 0);
  });
  invoke('transferAction', (key, action, entryId) => {
    assertAccount();
    return transfers.action(id(key), action, entryId ? id(entryId) : undefined);
  });
  invoke('upload', async (parent, asFolder) => {
    const current = assertAccount();
    const parentId = id(parent);
    const folder = asFolder === true;
    const result = await dialog.showOpenDialog(win, folder
      ? { title: '选择要上传的文件夹', properties: ['openDirectory'] }
      : { title: '选择上传到课盘的文件', properties: ['openFile', 'multiSelections'] });
    if (result.canceled || !result.filePaths.length) return 0;
    same(current);
    return folder ? transfers.folderUpload(parentId, result.filePaths[0]) : transfers.uploads(parentId, result.filePaths);
  });
  invoke('download', async itemId => {
    const current = assertAccount();
    const item = await current.drive.get(current.account, id(itemId));
    if (item.kind === 'folder') throw new Error('请选择要下载的文件。');
    same(current);
    const suggested = item.name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_');
    const result = await dialog.showSaveDialog(win, { title: '下载到本地（遇同名另存）', defaultPath: path.join(app.getPath('downloads'), suggested) });
    if (result.canceled || !result.filePath) return false;
    same(current);
    await transfers.download(item, result.filePath);
    return true;
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 860, minHeight: 560, autoHideMenuBar: true,
    backgroundColor: '#f4f3ec', title: windowTitle,
    icon: path.join(__dirname, 'renderer', 'mark.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, spellcheck: false, devTools: testDriver,
      additionalArguments: ['--study-build-version=' + buildVersion]
    }
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.on('focus', () => { if (startupReady) driveIndex?.refresh(); });
  win.on('closed', () => { stopPlayer(); win = null; media.clear(); pendingLogin?.abort(); });
  win.loadURL(pageUrl);
}

if (!testDriver && !app.requestSingleInstanceLock({ version: buildVersion })) {
  const activeVersion = runningVersion(profile);
  if (activeVersion === buildVersion) app.quit();
  else {
    const active = activeVersion ? '课盘 ' + activeVersion : '另一个版本的课盘';
    // Older builds focus themselves on a duplicate launch and cannot show this notice.
    const notice = windowTitle + ' 尚未启动';
    app.whenReady().then(() => dialog.showMessageBox({
      type: 'warning', title: notice, message: notice,
      detail: active + '正在使用同一份资料。\n\n退出已打开的课盘后，重新双击 ' +
        buildVersion + ' 的快启或便携入口。已打开的窗口保持运行。'
    })).finally(() => app.quit());
  }
} else {
  if (!testDriver) recordInstance(profile, buildVersion);
  app.on('second-instance', (_event, _args, _cwd, launch) => {
    if (launch?.version && launch.version !== buildVersion) return;
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
      callback(contents === win?.webContents && permission === 'fullscreen');
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission, requestOrigin) => contents === win?.webContents && permission === 'fullscreen' && requestOrigin === origin);
    session.defaultSession.protocol.handle('study', staticAssets());
    bind();
    if (testDriver) globalThis.studyTest = { startupStages: ['正在启动课盘…'], player: () => player?.engine.diagnostic() || null };
    createWindow();
  }).catch(() => {
    dialog.showErrorBox('课盘', '无法启动课盘，请检查应用文件和 Windows 用户资料目录。');
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  let joiningOffice = false;
  app.on('before-quit', event => {
    const stopped = stopPlayer();
    media.clear();
    localOffice.clear();
    transfers?.detach();
    cloudRecycle?.select(null);
    driveIndex?.close();
    if (!localOffice.pending && !stopped) return;
    event.preventDefault();
    if (!joiningOffice) {
      joiningOffice = true;
      Promise.all([localOffice.queue, stopped]).then(() => app.quit());
    }
  });
}
