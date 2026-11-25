import { el, icon, button, badge, time, bytes, date, kindName } from './ui.mjs';
import { buildPreview } from './preview.mjs';
import { fileWindow } from './file-window.mjs';
import { Selection } from './selection.mjs';

const api = window.study;
const select = query => document.querySelector(query);
const shell = select('#shell');
const main = select('#main');
const content = select('#content');
const modal = select('#dialog');
const models = {};
let session;
let page = 'home';
let trail = [];
let files = [];
let folderQuery = '';
let sort = 'name';
let filter = '';
let searchSort = 'relevance';
let searchScope = '';
let searchTime = '';
let searchSince;
let searchTotal = null;
let searchRevision = 0;
let searchTimer;
let indexStatus = null;
let cursor = '';
let listKey = '';
let listBusy = '';
let listError;
let visibleFiles;
let revision = 0;
let transition = 0;
let currentPreview;
let transferTab = 'all';
let openMenu = null;
let jobList = [];
let quotaRequest = 0;
const favoriteFolders = new Set();
const folderViews = new Map();
const pendingActions = new Set();
const selection = new Selection();
const recycleSelected = new Set();
let recycleView = 'cloud';
let loginAttempt;
const loginLabel = '用 Microsoft 登录';
const demoLoginNotice = '此版本为本地演示包。请使用已配置的课盘正式版连接 Microsoft。';
const destinations = [
  ['home', '首页', 'home'], ['files', '全部文件', 'local-folder'], ['transfers', '传输', 'local-transfer'],
  ['recycle', '回收站', 'trash'], ['tools', '工具', 'local-tools']
];

function toast(message) {
  const panel = el('div', { class: 'toast' }, message);
  select('#toasts').append(panel);
  setTimeout(() => panel.remove(), 3900);
}
function safeMessage(error, fallback) {
  const message = String(error?.message || '操作未完成，请重试。').replace(/^Error invoking remote method '[^']+': Error: /, '');
  // SDK and filesystem exceptions can include private locations.
  return /^.{1,100}$/u.test(message) && !/[A-Za-z]+:\/\//.test(message) && /[\u3400-\u9fff]/u.test(message) ? message : fallback;
}
const failure = error => toast(safeMessage(error, '操作未完成，请重试。'));
const guarded = action => (...args) => {
  try { Promise.resolve(action(...args)).catch(failure); } catch (error) { failure(error); }
};

function parent() { return trail.at(-1) || session?.account?.root; }
const enabled = () => !!session?.account;

function modalPage(title, child, actions = []) {
  const heading = el('h2', { id: 'dialog-heading' }, title);
  modal.setAttribute('aria-labelledby', 'dialog-heading');
  const header = el('div', { class: 'dialog-top' }, heading,
    button('关闭窗口', dismissDialog, { symbol: 'close', compact: true, className: 'quiet' }));
  const footer = actions.length ? el('div', { class: 'dialog-actions' }, actions) : null;
  modal.replaceChildren(...[header, child, footer].filter(Boolean));
  if (modal.open) header.querySelector('button').focus();
  else modal.showModal();
}
function dismissDialog() {
  if (loginAttempt && modal.contains(loginAttempt.status)) cancelLogin(loginAttempt);
  modal.close();
}
modal.addEventListener('cancel', () => {
  if (loginAttempt && modal.contains(loginAttempt.status)) cancelLogin(loginAttempt);
});

function setup() {
  if (api.version) {
    select('#build-version').textContent = api.version;
    document.title = '课盘 ' + api.version;
  }
  select('.brand-icon').append(icon('logo', 21));
  const nav = select('#nav');
  for (const [key, label, symbol] of destinations) {
    const control = button(label, guarded(() => navigate(key)), { symbol, className: 'nav-button' });
    if (key === 'transfers') {
      models.count = el('span', { class: 'nav-count', hidden: '' });
      control.append(models.count);
    }
    models[key] = control;
    nav.append(control);
  }
  const search = el('input', { type: 'search', placeholder: '搜索网盘文件', 'aria-label': '搜索网盘文件', maxlength: '120', autocomplete: 'off' });
  const scheduleSearch = event => {
    if (event.isComposing) return;
    cancelSearch();
    searchTimer = setTimeout(guarded(() => searchFor(search.value)), 250);
  };
  search.addEventListener('input', scheduleSearch);
  search.addEventListener('compositionend', scheduleSearch);
  models.search = search;
  const form = el('form', { class: 'search-form', onsubmit: guarded(event => { event.preventDefault(); return searchFor(search.value); }) },
    button('搜索', undefined, { symbol: 'search', compact: true, className: 'search-submit' }), search, el('span', { class: 'search-key' }, '/'));
  form.querySelector('button').type = 'submit';
  const sendUpload = asFolder => guarded(async () => {
    const directory = parent().id;
    await runFileAction('upload:' + directory, async active => {
      models.upload.disabled = models.uploadMenu.disabled = true;
      try {
        const result = await api.upload(directory, asFolder);
        if (result && active === session) {
          folderViews.clear();
          transferTab = 'all';
          await navigate('transfers');
          toast(asFolder ? '文件夹已加入上传队列' : result + ' 个文件已加入上传队列');
        }
      } finally {
        if (active === session) models.upload.disabled = models.uploadMenu.disabled = !enabled();
      }
    });
  });
  models.upload = button('上传文件', sendUpload(false), { symbol: 'upload', className: 'primary' });
  models.uploadMenu = button('上传选项', () => {
    const choice = (label, folder) => button(label, () => { modal.close(); sendUpload(folder)(); });
    modalPage('上传', el('div', { class: 'dialog-actions' }, choice('上传文件', false), choice('上传文件夹', true)));
  }, { symbol: 'down', compact: true });
  models.uploadControls = el('div', { class: 'upload-controls' }, models.upload, models.uploadMenu);
  models.back = button('返回上一级', guarded(browseBack), { symbol: 'back', compact: true, className: 'quiet' });
  models.refresh = button('刷新当前页面', guarded(refreshView), { symbol: 'refresh', compact: true, className: 'quiet' });
  models.quota = el('div', { class: 'drive-quota', hidden: '' });
  select('#toolbar').append(el('div', { class: 'directory-navigation' }, models.back, models.refresh), form, models.quota);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (openMenu) { event.preventDefault(); closeMenu(true); }
      else if (currentPreview && !modal.open && !document.fullscreenElement && !event.defaultPrevented) {
        event.preventDefault();
        guarded(returnFromPreview)();
      }
    }
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || !enabled() || modal.open) return;
    if (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.closest('input,textarea,select'))) return;
    event.preventDefault();
    search.focus();
  });
  document.addEventListener('pointerdown', event => {
    if (openMenu && !openMenu.contains(event.target) && !event.target.closest('[data-row-menu]')) closeMenu();
  });
}

function updateShell() {
  const view = page === 'preview' ? 'files' : page;
  for (const [key] of destinations) {
    const active = key === view;
    models[key].classList.toggle('active', active);
    if (active) models[key].setAttribute('aria-current', 'page');
    else models[key].removeAttribute('aria-current');
    models[key].disabled = ['files', 'transfers', 'recycle'].includes(key) && !enabled();
  }
  const count = jobList.filter(row => ['running', 'queued'].includes(row.state)).length;
  models.count.hidden = !count;
  models.count.textContent = count;
  models.search.disabled = !enabled();
  models.upload.disabled = models.uploadMenu.disabled = !enabled() || rowBusy('upload:' + parent()?.id);
  models.back.disabled = page !== 'tools' && (!enabled() || page === 'home' && !folderQuery && trail.length < 2);
  models.refresh.disabled = !enabled() || page === 'preview' || page === 'tools';
  const info = session?.account;
  const accountBlock = el('button', { type: 'button', class: 'account-control', onclick: accountDialog, 'aria-label': '账户设置' },
    el('span', { class: 'avatar' }, info ? info.name.slice(0, 1) : icon('user', 17)),
    el('span', { class: 'account-text' }, el('strong', {}, info?.name || '未登录'), el('small', {}, session?.demo ? '本地演示' : 'OneDrive 个人版')),
    icon('down', 15));
  select('#account').replaceChildren(accountBlock);
  shell.classList.toggle('preview-active', page === 'preview');
  main.dataset.page = page;
}

async function refreshQuota() {
  const request = ++quotaRequest;
  const active = session;
  if (!enabled()) return;
  const quota = await api.quota().catch(() => null);
  if (active !== session || request !== quotaRequest) return;
  models.quota.hidden = false;
  if (!quota) {
    models.quota.textContent = '容量暂不可用';
    return;
  }
  models.quota.replaceChildren(el('span', {}, bytes(quota.used) + ' / ' + bytes(quota.total)),
    el('progress', { max: quota.total, value: Math.min(quota.used, quota.total), 'aria-label': 'OneDrive 已用容量' }));
}

async function applySession(next) {
  transition += 1;
  cancelSearch();
  selection.clear();
  recycleSelected.clear();
  recycleView = 'cloud';
  resetCloudView();
  await closePreview();
  clearFileWindow();
  closeMenu();
  session = next;
  page = 'home';
  trail = session.account ? [session.account.root] : [];
  folderQuery = '';
  models.search.value = '';
  files = [];
  cursor = '';
  filter = '';
  searchScope = searchTime = '';
  searchSince = undefined;
  searchSort = 'relevance';
  indexStatus = null;
  listKey = listBusy = '';
  listError = null;
  models.quota.hidden = true;
  models.quota.replaceChildren();
  favoriteFolders.clear();
  folderViews.clear();
  if (next.account) api.library().then(data => {
    if (session === next) for (const item of data.favorites) favoriteFolders.add(item.id);
  }).catch(() => {});
  jobList = enabled() ? await api.transfers() : [];
  if (session !== next) return;
  updateShell();
  refreshQuota();
  const home = renderHome({ load: true });
  if (next.account) requestAnimationFrame(() => requestAnimationFrame(() => {
    if (session !== next) return;
    api.indexStatus().then(status => { if (session === next && !indexStatus) receiveIndex(status); }).catch(() => {});
    api.indexRefresh().catch(() => {});
  }));
  await home;
}

function accountDialog() {
  if (!session || session.startupFailed) return;
  const list = el('div', { class: 'account-dialog-list' });
  for (const info of session?.accounts || []) {
    const chosen = info.id === session?.account?.id;
    const buttonNode = button(chosen ? info.name + ' · 当前' : info.name, guarded(async () => {
      modal.close();
      await currentPreview?.control.flush?.();
      await applySession(await api.switchAccount(info.id));
    }), { symbol: 'user' });
    buttonNode.disabled = chosen;
    list.append(buttonNode);
  }
  if (session?.account) list.append(button(session.demo ? '退出本地演示' : '退出当前账户', guarded(async () => {
    modal.close();
    await currentPreview?.control.flush?.();
    await applySession(await api.signOut());
  }), { className: 'quiet' }));
  modalPage('账户', list, [
    session?.demo ? null : button('本地演示', guarded(async () => {
      modal.close(); await currentPreview?.control.flush?.(); await applySession(await api.demo());
    })),
    button(loginLabel, startLogin, { className: 'primary' })
  ].filter(Boolean));
}

function cancelLogin(attempt) {
  if (attempt.cancelled) return;
  attempt.cancelled = true;
  attempt.status.textContent = '正在取消登录…';
  attempt.cancel.disabled = true;
  if (attempt.sent) api.cancelLogin().catch(() => {});
}
async function startLogin(mode) {
  const restoring = mode === 'restore';
  if (loginAttempt) return;
  if (!session?.loginAvailable) {
    modalPage(loginLabel, el('p', { class: 'dialog-note', role: 'status' }, demoLoginNotice));
    return;
  }
  const status = el('p', { class: 'dialog-note', role: 'status' }, '请在 Windows 默认浏览器中完成 Microsoft 登录。');
  const attempt = { status, cancelled: false, sent: false };
  attempt.cancel = button('取消登录', () => cancelLogin(attempt));
  loginAttempt = attempt;
  modalPage(loginLabel, status, [attempt.cancel]);
  try {
    await currentPreview?.control.flush?.();
    if (attempt.cancelled) throw new Error('Microsoft 登录已取消。');
    attempt.sent = true;
    const next = await api.login(restoring ? 'restore' : undefined);
    // A completed authorization is already committed by the main process.
    loginAttempt = null;
    if (modal.open && modal.contains(status)) modal.close();
    await applySession(next);
    if (restoring) await navigate('recycle');
  } catch (error) {
    if (!modal.open || !modal.contains(status)) return;
    status.textContent = safeMessage(error, 'Microsoft 登录未完成，请重试。');
    const retry = button('重试', () => startLogin(mode), { className: 'primary' });
    attempt.cancel.replaceWith(retry);
    retry.focus();
  } finally {
    if (loginAttempt === attempt) loginAttempt = null;
  }
}

async function closePreview() {
  if (!currentPreview) return;
  const old = currentPreview;
  currentPreview = null;
  await old.control.close();
  await api.release(old.key).catch(() => {});
}

async function navigate(destination, searching = false) {
  const fallback = !destinations.some(([key]) => key === destination);
  if (fallback) {
    destination = 'home';
    searching = false;
  }
  const token = ++transition;
  if (!searching) {
    cancelSearch();
    if (folderQuery) filter = '';
    folderQuery = '';
    models.search.value = '';
  }
  await closePreview();
  if (token !== transition) return;
  page = destination;
  closeMenu();
  clearFileWindow();
  updateShell();
  if (destination === 'home') {
    await renderHome({ load: true });
    if (fallback && token === transition) models.home.focus();
    return;
  }
  if (destination === 'tools') {
    const header = heading('工具');
    const home = guarded(async () => { await navigate('home'); if (page === 'home') models.home.focus(); });
    content.replaceChildren(header, el('section', { class: 'construction' }, empty('正在施工', null, 'local-tools'),
      button('返回首页', home, { symbol: 'back' })));
    content.scrollTop = 0;
    const headingNode = header.querySelector('h1');
    headingNode.tabIndex = -1;
    headingNode.focus();
    return;
  }
  if (destination === 'recycle') return renderRecycle();
  if (destination === 'transfers') {
    jobList = await api.transfers();
    if (token === transition) renderTransfers();
    return;
  }
  await loadFiles(false);
}

async function browseBack() {
  if (page === 'preview') return returnFromPreview();
  if (page === 'transfers' || page === 'recycle' || page === 'tools') return navigate('home');
  if (folderQuery) {
    models.search.value = '';
    return searchFor('');
  }
  if (trail.length > 1) return openFolder(trail.at(-2));
  return navigate('home');
}

async function refreshView() {
  refreshQuota();
  if (enabled()) api.indexRefresh('refresh').catch(() => {});
  if (page === 'home') return renderHome({ load: true, refresh: true });
  if (page === 'transfers') return navigate('transfers');
  if (page === 'recycle') {
    if (recycleView === 'cloud') await api.cloudTrashRefresh(false, session.accountRevision);
    return renderRecycle();
  }
  if (page === 'files') return loadFiles(false, true);
}

function heading(title, subtitle, actions = []) {
  return el('div', { class: 'page-heading' }, el('div', {}, el('h1', {}, title), subtitle ? el('p', {}, subtitle) : null),
    el('div', { class: 'heading-actions' }, actions));
}

function empty(label, detail, symbol = 'files') {
  return el('div', { class: 'empty' }, el('span', { class: 'empty-icon' }, icon(symbol, 24)),
    el('strong', {}, label), detail ? el('p', {}, detail) : null);
}

function removeHistory(kind, item) {
  const remove = guarded(async () => {
    modal.close();
    await api.history(kind, item?.id);
    if (page === 'home') await renderHome();
  });
  if (item) return remove();
  modalPage(kind === 'watching' ? '清空观看记录' : '清空浏览记录',
    el('p', { class: 'dialog-note' }, '将清空当前账户的这组本地记录。'), [
      button('取消', () => modal.close()), button('清空', remove, { className: 'danger' })
    ]);
}

function openAction(item, resume = true) {
  return guarded(async event => {
    const active = session;
    try {
      if (item.kind === 'shortcut') toast('此共享项目指向其他 OneDrive，请在 OneDrive 网页中打开。');
      else if (item.kind === 'folder') await openFolder(item, !!folderQuery);
      else await openFile(item, resume, { anchor: event?.currentTarget });
    } catch (error) {
      if (active === session) dropUnavailable(item, error);
      throw error;
    }
  });
}

async function renderHome({ load = false, refresh = false } = {}) {
  if (!enabled()) {
    const intro = el('section', { class: 'welcome' }, el('div', { class: 'welcome-mark' }, icon('logo', 36)),
      el('h2', {}, '连接 OneDrive 个人版'),
      el('p', {}, '在一个窗口里整理课程文件、继续播放并管理传输。'),
      el('div', { class: 'welcome-actions' },
        button(loginLabel, startLogin, { className: 'primary' }),
        button('打开本地演示', guarded(async () => applySession(await api.demo()))),
        session?.startupError ? button('重试恢复登录', () => startSession(true)) : null),
      session?.loginAvailable === false ? el('p', { class: 'dialog-note' }, demoLoginNotice) : null,
      session?.startupError ? el('p', { class: 'error-text' }, session.startupError) : null);
    content.replaceChildren(heading('首页'), intro);
    return;
  }
  const active = session;
  const token = transition;
  const library = await api.library();
  if (page !== 'home' || active !== session || token !== transition) return;
  favoriteFolders.clear();
  for (const item of library.favorites) favoriteFolders.add(item.id);
  const sections = el('div', { class: 'home-sections' });
  const recent = el('div', { class: 'activity-list' });
  const watch = el('div', { class: 'activity-list' });
  const favorites = el('div', { class: 'activity-list' });
  for (const record of library.watching) {
    const progress = el('progress', { max: record.duration, value: record.seconds, 'aria-label': '已观看进度' });
    watch.append(el('div', { class: 'activity-row watch-row' },
      el('button', { type: 'button', class: 'activity-hit', 'data-open-id': record.item.id, onclick: openAction(record.item, true) }, badge(record.item.kind, record.item.name),
        el('span', { class: 'activity-name' }, record.item.name, el('small', {}, '上次播放至 ' + time(record.seconds)))),
      el('div', { class: 'watch-time' }, progress, el('span', {}, time(record.seconds) + ' / ' + time(record.duration))),
      button('继续观看', openAction(record.item, true), { className: 'subtle', symbol: 'play' }),
      button('移除观看记录', () => removeHistory('watching', record.item), { symbol: 'close', compact: true, className: 'quiet' })));
  }
  for (const record of library.recent) {
    recent.append(el('div', { class: 'activity-row recent-row' },
      el('button', { type: 'button', class: 'activity-hit', 'data-open-id': record.item.id, onclick: openAction(record.item) }, badge(record.item.kind, record.item.name),
        el('span', { class: 'activity-name' }, record.item.name)),
      el('span', { class: 'item-date' }, date(record.at, true)),
      button('移除浏览记录', () => removeHistory('recent', record.item), { symbol: 'close', compact: true, className: 'quiet' })));
  }
  for (const item of library.favorites) {
    favorites.append(el('div', { class: 'activity-row' },
      el('button', { type: 'button', class: 'activity-hit', onclick: openAction(item) }, badge('folder'), el('span', { class: 'activity-name' }, item.name)),
      button('取消收藏', guarded(async () => { await api.favorite(item.id); await renderHome(); }), { symbol: 'star', compact: true, className: 'quiet starred' })));
  }
  function section(name, symbol, body, noItems, historyKind) {
    const count = body.childElementCount;
    const extra = count > 3 ? el('div', { class: 'activity-list' }, [...body.children].slice(3)) : null;
    const more = extra && el('details', { class: 'home-more' }, el('summary', {}, '查看更多'), extra);
    return el('section', { class: 'home-section' },
      el('div', { class: 'section-heading' }, el('h2', {}, icon(symbol, 19), name),
        historyKind && count ? button('清空', () => removeHistory(historyKind), { className: 'quiet' }) : null),
      count ? body : empty(noItems, null, symbol), more);
  }
  sections.append(section('继续观看', 'local-video', watch, '暂无观看进度', 'watching'),
    section('最近浏览', 'local-recent', recent, '暂无浏览记录', 'recent'),
    section('收藏课程目录', 'local-favorite', favorites, '暂无收藏目录'));
  const scroll = content.scrollTop;
  clearFileWindow();
  content.replaceChildren(el('h1', { class: 'sr-only' }, '首页'), sections, el('section', { id: 'home-files', 'aria-label': '网盘文件' }));
  if (load) await loadFiles(false, refresh);
  else renderFiles();
  if (page === 'home' && transition === token) content.scrollTop = scroll;
}

async function openFolder(item, indexed = false) {
  const from = page === 'files' && !folderQuery ? parent() : null;
  if (from && from.id !== item.id && listKey === listLocation() && !listBusy && !listError) {
    folderViews.delete(from.id);
    folderViews.set(from.id, { files, cursor, filter, sort, scroll: content.scrollTop, saved: Date.now() });
    if (folderViews.size > 4) folderViews.delete(folderViews.keys().next().value);
  }
  const token = ++transition;
  cancelSearch();
  await closePreview();
  if (token !== transition) return;
  const previousIndex = trail.findIndex(folder => folder.id === item.id);
  const returnedFrom = previousIndex >= 0 ? trail[previousIndex + 1] : null;
  const saved = returnedFrom ? folderViews.get(item.id) : null;
  const restore = saved && Date.now() - saved.saved < 30000 ? saved : null;
  if (indexed) {
    const resolved = await api.searchFolder(item.id);
    if (token !== transition) return;
    trail = resolved;
  } else trail = previousIndex >= 0 ? trail.slice(0, previousIndex + 1)
    : [...(item.parentId === parent()?.id ? trail : [session.account.root]), item];
  page = 'files';
  filter = '';
  folderQuery = '';
  models.search.value = '';
  updateShell();
  if (!indexed) api.openFolder(item.id).then(next => {
    if (token !== transition || page !== 'files' || parent()?.id !== item.id) return;
    if (next.map(item => item.id).join() !== trail.map(item => item.id).join()) {
      trail = next;
      renderFiles();
    }
  }).catch(() => {});
  if (restore) {
    revision += 1;
    ({ files, cursor, sort, filter } = restore);
    listKey = listLocation();
    listBusy = '';
    listError = null;
    renderFiles(restore.scroll);
  } else await loadFiles(false);
  if (token !== transition || page !== 'files') return;
  if (returnedFrom) visibleFiles?.focus(returnedFrom.id);
}
async function searchFor(query) {
  if (!enabled()) return;
  cancelSearch();
  const next = query.trim();
  if (!folderQuery && !next) return;
  if (!folderQuery) {
    filter = searchScope = searchTime = '';
    searchSince = undefined;
    searchSort = 'relevance';
  }
  if (!next) filter = '';
  folderQuery = next;
  await navigate('files', true);
}
function cancelSearch() {
  clearTimeout(searchTimer);
  searchTimer = null;
  if (folderQuery) {
    revision += 1;
    api.cancelSearch(session?.accountRevision).catch(() => {});
  }
}
function listLocation() {
  return JSON.stringify(folderQuery ? [session?.accountRevision, parent()?.id, folderQuery, searchSort, filter, searchScope, searchTime]
    : [session?.accountRevision, parent()?.id, sort]);
}
function clearFileWindow() {
  visibleFiles?.dispose();
  visibleFiles = null;
}
async function loadFiles(append, refresh = false) {
  const key = listLocation();
  if (append && (listBusy || !cursor || key !== listKey)) return;
  const request = ++revision;
  const view = page;
  const active = session;
  const query = folderQuery;
  let found = false;
  const current = () => request === revision && session === active &&
    (page === view || page === 'preview' && currentPreview?.previous.page === view);
  const newList = listKey !== key;
  if (newList) {
    files = [];
    cursor = '';
    searchTotal = null;
  }
  listKey = key;
  selection.use(session?.account, parent()?.id, folderQuery);
  listError = null;
  listBusy = append ? 'append' : files.length ? 'refresh' : 'first';
  renderFiles(newList ? 0 : content.scrollTop);
  try {
    const options = { id: parent().id, sort, cursor: append ? cursor : '', refresh };
    const find = offset => api.search({
      accountRevision: active.accountRevision, query, scope: searchScope ? parent().id : '',
      filter, sort: searchSort, since: searchSince,
      offset, revision: searchRevision
    });
    let result = query ? await find(append ? Number(cursor) : 0) : await api.list(options);
    if (!current()) return;
    if (result.reset) {
      append = false;
      result = await find(0);
    }
    if (!current()) return;
    if (query) {
      found = true;
      if (result.status.revision >= (indexStatus?.revision ?? -1)) indexStatus = result.status;
      searchRevision = result.status.revision;
      searchTotal = result.total;
    }
    const known = new Set(append ? files.map(item => item.id) : []);
    const incoming = result.items.filter(item => !known.has(item.id) && known.add(item.id));
    files = append ? files.concat(incoming) : incoming;
    cursor = result.cursor;
    if (result.stale && !append) {
      listBusy = 'refresh';
      renderFiles();
      result = await api.list({ ...options, refresh: true });
      if (!current()) return;
      files = result.items;
      cursor = result.cursor;
    }
    selection.reconcile(files, !cursor && (!query || result.status?.complete &&
      searchRevision === indexStatus?.revision && !filter && !searchTime));
  } catch (error) {
    if (current() && error.name !== 'AbortError' && !/账户已切换|已取消/.test(error.message)) {
      listError = { append, message: safeMessage(error, '无法读取文件，请重试。') };
    }
  } finally {
    if (current()) {
      listBusy = '';
      renderFiles();
      if (found && page === 'files' && !searchTimer && searchRevision < (indexStatus?.revision ?? -1)) {
        await loadFiles(false);
      }
    }
  }
}
function closeMenu(restoreFocus = false) {
  const rowId = openMenu?.dataset.id;
  openMenu?.remove();
  openMenu = null;
  if (restoreFocus && rowId) visibleFiles?.focus(rowId, 'menu');
}
const actionKey = id => JSON.stringify([session?.accountRevision, session?.account?.id, session?.account?.driveId, id]);
const rowBusy = id => pendingActions.has(actionKey(id));

function setBusy(row, busy) {
  row.setAttribute('aria-busy', String(busy));
  for (const control of row.querySelectorAll('[data-row-control]')) control.setAttribute('aria-disabled', String(busy));
  const checkbox = row.querySelector('[data-row-control="select"]');
  if (checkbox) checkbox.disabled = busy;
}

function dropUnavailable(item, error) {
  if (!selection.has(item) || !/拒绝访问|没有权限|无权|文件或会话不存在|文件已不存在/.test(error.message)) return;
  selection.drop(item);
  renderFiles();
}

async function runFileAction(id, work) {
  const key = actionKey(id);
  if (pendingActions.has(key)) return;
  const active = session;
  const paint = busy => {
    if (active !== session) return;
    const row = [...content.querySelectorAll('[data-file-id]')].find(node => node.dataset.fileId === id);
    if (row) setBusy(row, busy);
  };
  pendingActions.add(key);
  paint(true);
  try { await work(active); }
  catch (error) {
    if (active === session) {
      dropUnavailable({ id }, error);
      throw error;
    }
  }
  finally { pendingActions.delete(key); paint(false); }
}

function downloadItem(item) {
  return runFileAction(item.id, async active => {
    if (await api.download(item.id) && active === session) toast('已加入下载队列');
  });
}
function itemMenu(item, anchor, favoriteIds) {
  if (rowBusy(item.id)) return;
  const wasOpen = openMenu?.dataset.id === item.id;
  closeMenu();
  if (wasOpen) return;
  const menu = el('div', { class: 'action-menu', 'data-id': item.id });
  const command = (label, run, symbol) => menu.append(button(label, guarded(async () => { closeMenu(true); await run(); }), { symbol, className: 'quiet' }));
  command(item.kind === 'folder' ? '打开文件夹' : '打开', openAction(item), item.kind === 'folder' ? 'folder' : 'play');
  if (folderQuery && item.folder) command('打开所在文件夹', () => openFolder(item.folder, true), 'folder');
  if (item.kind === 'folder') command(favoriteIds.has(item.id) ? '取消收藏' : '收藏目录', () => runFileAction(item.id, async active => {
    const library = await api.favorite(item.id);
    if (active !== session) return;
    favoriteIds.clear();
    for (const folder of library.favorites) favoriteIds.add(folder.id);
    toast(favoriteIds.has(item.id) ? '已收藏目录' : '已取消收藏');
    renderFiles();
  }), 'star');
  else if (item.kind !== 'shortcut') command('下载文件', () => downloadItem(item), 'download');
  if (item.kind === 'folder') command('下载文件夹', () => selectBatch('download', [item.id]), 'download');
  if (item.kind !== 'shortcut') {
    command('重命名', () => nameDialog(item), 'other');
    command('移动到…', () => moveDialog(item), 'folder');
    command('删除…', () => removeDialog(item), 'close');
  }
  openMenu = menu;
  document.body.append(menu);
  const bounds = anchor.getBoundingClientRect();
  menu.style.right = Math.max(12, window.innerWidth - bounds.right) + 'px';
  menu.style.top = Math.min(bounds.bottom + 3, window.innerHeight - menu.offsetHeight - 10) + 'px';
  menu.querySelector('button').focus({ preventScroll: true });
}
function nameDialog(item) {
  const directory = parent().id;
  const location = listKey;
  const active = session;
  const input = el('input', { value: item?.name || '', placeholder: '文件夹名称', maxlength: '255', required: '', autocomplete: 'off' });
  const submit = el('button', { type: 'submit', class: 'button primary' }, item ? '保存' : '新建');
  const form = el('form', { class: 'dialog-form', onsubmit: guarded(async event => {
    event.preventDefault();
    if (submit.disabled || active !== session) return;
    submit.disabled = true;
    try {
      await runFileAction(item?.id || 'create:' + directory, async () => {
        if (item) await api.rename(item.id, input.value);
        else await api.mkdir(directory, input.value);
        if (active !== session) return;
        if (modal.contains(form)) modal.close();
        folderViews.clear();
        toast(item ? '已重命名' : '已新建文件夹');
        if (listLocation() === location && ['home', 'files'].includes(page)) await loadFiles(false, true);
      });
    } finally { submit.disabled = false; }
  }) }, el('label', {}, item ? '名称' : '文件夹名称', input), el('div', { class: 'dialog-actions' },
    button('取消', () => modal.close()), submit));
  modalPage(item ? '重命名' : '新建文件夹', form);
  input.focus();
  if (item) input.select();
}

async function finishChange(item, work, message) {
  const location = listKey;
  await runFileAction(item.id, async active => {
    await work();
    if (session !== active) return;
    modal.close();
    folderViews.clear();
    toast(message);
    if (listLocation() === location && ['home', 'files'].includes(page)) await loadFiles(false, true);
  });
}

function removeDialog(item) {
  modalPage('删除项目', el('p', { class: 'dialog-note' }, '将“' + item.name + '”移到 OneDrive 回收站。'), [
    button('取消', () => modal.close()),
    button('移到回收站', guarded(() => finishChange(item, () => api.remove(item.id), '已移到回收站')), { className: 'danger' })
  ]);
}

function folderPicker({ title, label, excluded = [], blocked, submit }) {
  const active = session;
  const root = active.account.root;
  const chain = [root];
  const body = el('div', { class: 'move-picker' });
  const accept = button(label, guarded(async () => {
    if (active !== session || accept.disabled) return;
    accept.disabled = true;
    try { await submit(chain.at(-1).id); }
    finally { if (active === session) accept.disabled = !!blocked?.(chain.at(-1)); }
  }), { className: 'primary' });
  let version = 0;
  function show(folder, cursor = '') {
    const token = ++version;
    const folders = cursor ? body.querySelector('.move-folders') : el('div', { class: 'move-folders' });
    const more = el('div', { role: 'status' }, '正在读取文件夹…');
    accept.disabled = !!blocked?.(folder);
    body.replaceChildren(el('div', { class: 'breadcrumbs' }, chain.length > 1
      ? button('返回上一级', () => { chain.pop(); show(chain.at(-1)); }, { symbol: 'back', compact: true }) : null,
    el('span', {}, '/' + chain.slice(1).map(entry => entry.name).join('/'))), folders, more);
    api.list({ id: folder.id, sort: 'name', cursor }).then(result => {
      if (token !== version || session !== active || !modal.open || !modal.contains(body)) return;
      for (const child of result.items) {
        if (child.kind === 'folder' && !excluded.includes(child.id)) {
          folders.append(button(child.name, () => { chain.push(child); show(child); }, { symbol: 'folder', className: 'quiet' }));
        }
      }
      if (result.cursor) more.replaceChildren(button('加载更多', () => show(folder, result.cursor)));
      else more.textContent = folders.childElementCount ? '' : '这里没有子文件夹';
    }).catch(error => {
      if (token === version) more.textContent = safeMessage(error, '无法读取文件夹。');
    });
  }
  modalPage(title, body, [button('取消', () => modal.close()), accept]);
  show(root);
}
function moveDialog(item) {
  folderPicker({ title: '移动“' + item.name + '”', label: '移到这里', excluded: [item.id],
    blocked: folder => folder.id === item.parentId || rowBusy(item.id),
    submit: folder => finishChange(item, () => api.move(item.id, folder), '已移动') });
}
async function launchBatch(plan, options = {}) {
  const active = session;
  if (!await api.batchStart(plan.ticket, options) || active !== session) return;
  if (modal.open) modal.close();
  selection.clear();
  recycleSelected.clear();
  folderViews.clear();
  transferTab = 'all';
  await navigate('transfers');
}
async function selectBatch(operation, ids) {
  const active = session;
  const plan = await api.batchPlan(operation, ids, active.accountRevision);
  if (active !== session) return;
  if (operation === 'download') return launchBatch(plan);
  if (operation === 'move') return folderPicker({ title: '批量移动 ' + plan.count + ' 项', label: '移到这里',
    excluded: ids, submit: parent => launchBatch(plan, { parent }) });
  const count = plan.count + ' 个项目（含 ' + plan.folders + ' 个文件夹）';
  const folded = plan.selected - plan.count;
  modalPage('移到 OneDrive 回收站',
    el('p', { class: 'dialog-note' }, '将 ' + count + ' 移到回收站。' + (folded ? ' 另有 ' + folded + ' 项包含在所选文件夹内。' : '')),
    [button('取消', () => modal.close()), button('全部移到回收站', guarded(event => submitOnce(event, () => launchBatch(plan))), { className: 'danger' })]);
}
async function submitOnce(event, action) {
  const control = event.currentTarget;
  if (control.disabled) return;
  control.disabled = true;
  try { return await action(); }
  finally { control.disabled = false; }
}
async function restoreDialog(rows) {
  const active = session;
  const plan = await api.batchPlan('restore', rows.map(row => row.id), active.accountRevision);
  if (active !== session) return;
  const input = rows.length === 1 ? el('input', { type: 'text', maxlength: '255', placeholder: rows[0].item.name }) : null;
  const name = () => input?.value || '';
  modalPage('还原 ' + plan.count + ' 项', el('div', { class: 'dialog-form' },
    el('p', { class: 'dialog-note' }, '默认还原到原文件夹。同名冲突可改名或另选位置。'),
    input ? el('label', {}, '还原名称（可选）', input) : null),
    [button('取消', () => modal.close()),
      button('选择还原位置', () => folderPicker({ title: '选择还原位置', label: '还原到这里',
        submit: parent => launchBatch(plan, { parent, name: name() }) })),
      button('还原到原位置', guarded(event => submitOnce(event, () => launchBatch(plan, { name: name() }))), { className: 'primary' })]);
}

const recycleTabs = () => el('div', { class: 'tab-list', 'aria-label': '回收站来源' },
  ...[['cloud', '云端回收站'], ['local', '本机删除记录']].map(([key, label]) => {
    const control = button(label, guarded(async () => { recycleView = key; await renderRecycle(); }),
      { className: 'quiet ' + (recycleView === key ? 'selected' : '') });
    control.setAttribute('aria-pressed', String(recycleView === key));
    return control;
  }));

const cloudSelected = new Set();
const recycleTypeLabels = { 'no-extension': '无扩展名', 'unknown-extension': '未知扩展名' };
function recycleName(name, kind) {
  return el('div', { class: 'recycle-name' }, badge(kind, name), el('span', {}, name));
}
function recycleType(kind, source) {
  const label = recycleTypeLabels[source] || (kind === 'other' ? '文件' : kindName[kind] || '文件');
  return el('td', { title: source === 'extension' ? '根据文件名扩展名推断' : undefined, 'data-type-source': source }, label);
}
const cloudRestoreStates = {
  restored: '已还原到原位置', changed: '云端记录已变化', conflict: '原位置有同名项目',
  'parent-missing': '原文件夹已不存在', 'preflight-failed': '无法核对原位置',
  rejected: 'OneDrive 未接受此项', unconfirmed: '结果待核对，请先刷新云端',
  denied: 'OneDrive 拒绝访问', auth: '云端会话已失效', throttled: 'OneDrive 暂时限制请求',
  mismatch: '云端登录与当前课盘账户不一致'
};
async function confirmCloudRestore(rows, generation, active) {
  if (!rows.length || !generation || active !== session) return;
  const confirm = guarded(event => submitOnce(event, async () => {
    const results = await api.cloudTrashRestore(generation, rows.map(row => row.id), active.accountRevision);
    if (active !== session || page !== 'recycle' || recycleView !== 'cloud') return;
    cloudSelected.clear();
    const names = new Map(rows.map(row => [row.id, row.name]));
    modalPage('云端还原结果',
      el('ul', { class: 'dialog-note' }, results.map(result => el('li', {},
        names.get(result.id) + ' · ' + (cloudRestoreStates[result.state] || cloudRestoreStates.unconfirmed)))),
      [button('关闭', () => modal.close(), { className: 'primary' })]);
  }));
  modalPage('从云端还原 ' + rows.length + ' 项',
    el('div', { class: 'dialog-form' }, el('p', { class: 'dialog-note' },
      '还原到原文件夹。原文件夹缺失或已有同名项目时会跳过。'),
    el('ul', { class: 'dialog-note' }, rows.map(row => el('li', {}, row.name)))),
    [button('取消', () => modal.close()), button('还原到原位置', confirm, { className: 'primary' })]);
}

let cloudItems = [];
let cloudSnapshot = null;
let cloudNext = null;
let cloudRead = 0;
function resetCloudView() {
  cloudSelected.clear();
  cloudRead += 1;
  cloudItems = [];
  cloudSnapshot = null;
  cloudNext = null;
}
async function renderRecycle() {
  if (recycleView === 'local') return renderLocalRecycle();
  return renderCloudRecycle();
}
async function renderCloudRecycle({ append = false, keepLoaded = false } = {}) {
  const active = session;
  if (!active?.account || page !== 'recycle' || recycleView !== 'cloud' || append && cloudNext === null) return;
  const token = ++cloudRead;
  const scroll = append || keepLoaded ? content.scrollTop : 0;
  const current = () => token === cloudRead && active === session && page === 'recycle' && recycleView === 'cloud';
  let result = await api.cloudTrash(append ? { offset: cloudNext, generation: cloudSnapshot?.generation } : {},
    active.accountRevision);
  if (!current()) return;
  if (result.reset) {
    result = await api.cloudTrash({}, active.accountRevision);
    if (!current()) return;
    append = keepLoaded = false;
  }
  const { snapshot, status } = result;
  const same = snapshot?.generation && snapshot.generation === cloudSnapshot?.generation;
  if (append && same) {
    const seen = new Set(cloudItems.map(item => item.id));
    cloudItems.push(...result.items.filter(item => !seen.has(item.id)));
    cloudNext = result.next;
  } else if (!keepLoaded || !same) {
    if (!same) cloudSelected.clear();
    cloudItems = result.items;
    cloudNext = result.next;
  }
  cloudSnapshot = snapshot;
  clearFileWindow();

  const controls = [];
  const waiting = ['idle', 'auth', 'mismatch', 'denied'].includes(status.phase);
  if (status.restoring) {
    controls.push(el('span', { class: 'index-note', role: 'status' }, '正在逐项还原并核对原位置…'));
  } else if (status.configured && status.busy) {
    controls.push(button('取消读取', guarded(() => api.cloudTrashCancel(active.accountRevision)), { symbol: 'close' }));
  } else if (status.configured) {
    const refresh = button(waiting ? '连接云回收站' : '刷新云端', guarded(() => api.cloudTrashRefresh(waiting, active.accountRevision)),
      { symbol: waiting ? 'user' : 'refresh', className: 'primary' });
    refresh.disabled = status.retryAt > Date.now();
    controls.push(refresh);
  }
  const statusText = status.message + (status.phase === 'loading' ? ' 已读取 ' + status.readCount + ' 条响应记录。' : '');
  const summary = snapshot ? (status.phase === 'ready' ? '完整快照 ' : '上次完整快照 ') + snapshot.total +
    ' 项 · ' + date(snapshot.at, true) : '';
  const actionable = status.phase === 'ready' && !status.busy && !status.restoring;
  const selectedRows = () => cloudItems.filter(item => item.canRestore && cloudSelected.has(item.id));
  const restoreSelected = button('还原所选', guarded(() => confirmCloudRestore(selectedRows(), snapshot?.generation, active)),
    { symbol: 'back', className: 'quiet' });
  const updateSelected = () => { restoreSelected.disabled = !actionable || selectedRows().length === 0; };
  updateSelected();
  if (cloudItems.some(item => item.mapped)) controls.push(restoreSelected);
  const columns = ['选择', '名称', '原位置', '大小', '类型', '删除时间', '还原状态'];
  const body = el('tbody');
  const table = el('table', { class: 'file-table cloud-recycle-table', 'aria-label': '云端回收站项目' },
    el('thead', {}, el('tr', {}, columns.map(label => el('th', { scope: 'col' }, label)))), body);
  const selectRow = item => {
    if (!item.mapped) return null;
    const input = el('input', { type: 'checkbox', 'aria-label': '选择 ' + item.name, 'data-row-control': 'select' });
    input.checked = cloudSelected.has(item.id);
    input.disabled = !actionable || !item.canRestore;
    input.onchange = () => {
      if (input.checked) cloudSelected.add(item.id);
      else cloudSelected.delete(item.id);
      updateSelected();
    };
    return input;
  };
  const restoreRow = item => {
    if (!item.mapped) return '原位置待核实';
    const restore = button('还原', guarded(() => confirmCloudRestore([item], snapshot?.generation, active)),
      { symbol: 'back', className: 'quiet' });
    restore.disabled = !actionable || !item.canRestore;
    restore.setAttribute('data-row-control', 'restore');
    return restore;
  };
  const makeRow = item => el('tr', { 'data-file-id': item.id },
    el('td', { class: 'select-cell' }, selectRow(item)),
    el('td', { title: item.name }, recycleName(item.name, item.displayKind)),
    el('td', { title: item.path || '原位置未提供' }, item.path || '原位置未提供'),
    el('td', {}, item.kind === 'folder' || item.size === null ? '—' : bytes(item.size)),
    recycleType(item.displayKind, item.typeSource),
    el('td', {}, item.deletedAt === null ? '未提供' : date(item.deletedAt, true)),
    el('td', {}, restoreRow(item)));
  content.replaceChildren(...[
    heading('回收站', status.configured ? '默认可见云端条目。不含个人保管库。文件类型按扩展名推断。' : '云端快照和本机删除记录按来源分开显示。'), recycleTabs(),
    el('div', { class: 'file-toolbar' }, controls),
    el('p', { class: 'index-note', role: 'status' }, statusText),
    summary ? el('p', { class: 'index-note' }, summary) : null,
    cloudItems.length ? table : snapshot ? empty(status.phase === 'ready' ? '完整云端快照为空' : '上次完整快照无记录', null, 'trash')
      : empty('尚无可显示的云端快照', '可切换到本机删除记录，查看已有记录。', 'trash'),
    cloudNext !== null ? el('div', { class: 'list-footer' },
      button('加载更多', guarded(() => renderCloudRecycle({ append: true })))) : null
  ].filter(Boolean));
  if (cloudItems.length) visibleFiles = fileWindow(content, table, body, cloudItems, makeRow, closeMenu);
  content.scrollTop = scroll;
  visibleFiles?.update();
  if (snapshot && status.phase === 'idle' && status.configured) await api.cloudTrashRefresh(false, active.accountRevision);
}

let recycleRead = 0;
async function renderLocalRecycle() {
  clearFileWindow();
  const token = ++recycleRead;
  const active = session;
  if (!active?.account || page !== 'recycle' || recycleView !== 'local') return;
  const { rows, canRestore, canAuthorize } = await api.trash();
  if (token !== recycleRead || active !== session || page !== 'recycle' || recycleView !== 'local') return;
  const actionable = rows.filter(row => row.state !== 'pending');
  const currentIds = new Set(actionable.map(row => row.id));
  for (const id of recycleSelected) if (!currentIds.has(id)) recycleSelected.delete(id);
  const restore = button('还原所选', guarded(() => restoreDialog(actionable.filter(row => recycleSelected.has(row.id)))),
    { symbol: 'back', className: 'primary' });
  const count = el('span', { role: 'status', class: 'selection-count' });
  const checked = new Map();
  function paint() {
    count.textContent = recycleSelected.size ? '已选 ' + recycleSelected.size + ' 项' : '已记录 ' + rows.length + ' 项';
    restore.disabled = !canRestore || !recycleSelected.size;
    for (const [id, box] of checked) box.checked = recycleSelected.has(id);
  }
  const columns = ['选择', '名称', '原位置', '大小', '删除或检测时间', '状态', '操作'];
  const states = { pending: '等待同步确认', deleted: '已记录删除', unavailable: '云端未找到可还原项', restoring: '待确认还原' };
  const table = el('table', { class: 'file-table recycle-table', 'aria-label': '已记录的回收站项目' },
    el('thead', {}, el('tr', {}, columns.map(label => el('th', { scope: 'col' }, label)))), el('tbody'));
  for (const row of rows) {
    const box = el('input', { type: 'checkbox', 'aria-label': '选择 ' + row.item.name, onchange: () => {
      if (box.checked) recycleSelected.add(row.id);
      else recycleSelected.delete(row.id);
      paint();
    } });
    box.disabled = row.state === 'pending';
    checked.set(row.id, box);
    const one = button('还原', guarded(() => restoreDialog([row])), { symbol: 'back', className: 'quiet' });
    one.disabled = !canRestore || row.state === 'pending';
    table.tBodies[0].append(el('tr', { 'data-recycle-id': row.id }, el('td', {}, box),
      el('td', { title: row.item.name }, recycleName(row.item.name, row.displayKind)),
      el('td', { title: row.path || '原位置未知' }, row.path || '原位置未知'),
      el('td', {}, row.item.kind === 'folder' ? '—' : bytes(row.item.size)),
      el('td', {}, (row.origin === 'delta' ? '检测于 ' : '记录于 ') + date(row.at, true)),
      el('td', {}, states[row.state]), el('td', {}, one)));
  }
  const note = '显示课盘记录的删除，以及索引启用后从 OneDrive 同步检测到的删除。索引建立前的历史不在此列，是否可还原由 OneDrive 确认。';
  content.replaceChildren(...[heading('回收站', note), recycleTabs(), el('div', { class: 'file-toolbar' }, restore, count,
    canAuthorize && !active.demo ? button(canRestore ? '重新授权还原' : '授权还原', () => startLogin('restore'), { symbol: 'user' }) : null),
    !canRestore ? el('p', { class: 'index-note' }, 'Microsoft 要求为课盘补充授权后才能在应用内还原。') : null,
    rows.length ? table : empty('暂无已记录的删除项', null, 'trash')].filter(Boolean));
  paint();
}

function indexMessage() {
  const status = indexStatus;
  if (!status) return '正在准备全盘索引';
  if (status.phase === 'offline') return status.complete ? '离线，使用本地索引' : '离线，使用本地索引 · 结果可能不完整';
  if (status.phase === 'unavailable') return '本地索引暂时无法读取';
  if (status.phase === 'failed' || status.phase === 'throttled') {
    const detail = status.complete ? '正在使用上次资料' : '已收录 ' + status.count + ' 项，结果可能不完整';
    return (status.phase === 'throttled' ? 'OneDrive 限制了同步请求' : '同步失败') + '，' + detail;
  }
  if (!status.complete) return '正在建立全盘索引 · 已收录 ' + status.count + ' 项，结果可能不完整';
  if (status.building) return '正在重建全盘索引 · 使用上次资料';
  if (status.phase === 'syncing') return '正在同步索引 · 使用上次资料';
  return '索引已更新 · ' + date(status.updated, true);
}

function receiveIndex(status) {
  const before = indexStatus;
  indexStatus = status;
  const label = select('#index-status');
  if (label) label.textContent = indexMessage();
  if (page === 'files' && folderQuery && !searchTimer && status.revision !== before?.revision &&
      status.revision !== searchRevision && !listBusy) loadFiles(false);
}

const categories = [['', '全部'], ['document', '文档'], ['image', '图片'], ['video', '视频'], ['audio', '音频'], ['folder', '文件夹'], ['other', '其他']];
const documents = new Set(['pdf', 'office', 'online', 'sheet', 'markdown', 'text']);
const filters = [['', '所有类型'], ['document', '全部文档'], ['folder', '文件夹'], ['video', '视频'], ['audio', '音频'], ['image', '图片'], ['pdf', 'PDF'],
  ['office', 'Office'], ['sheet', '表格'], ['markdown', 'Markdown'], ['text', '文本'], ['other', '其他']];
const sorts = [['name', '名称'], ['newest', '最新修改'], ['oldest', '最早修改'], ['largest', '文件大小']];
function dropdown(label, values, chosen, change) {
  const node = el('select', { 'aria-label': label, onchange: event => change(event.target.value) },
    values.map(([value, name]) => el('option', { value }, name)));
  node.value = chosen;
  return node;
}
function renderFiles(scroll = content.scrollTop) {
  const target = page === 'home' ? select('#home-files') : page === 'files' ? content : null;
  if (!target) return;
  closeMenu();
  clearFileWindow();
  const active = document.activeElement;
  const focusKey = target.contains(active) && active.dataset.listFocus;
  const focusRow = target.contains(active) && active.closest('[data-file-id]')?.dataset.fileId;
  const path = el('nav', { class: 'breadcrumbs', 'aria-label': '文件夹路径' });
  trail.forEach((item, index) => {
    if (index) path.append(icon('next', 14));
    path.append(index === trail.length - 1 && !folderQuery ? el('span', { 'aria-current': 'page' }, item.name)
      : button(item.name, guarded(() => openFolder(item)), { className: 'quiet' }));
  });
  if (folderQuery) path.append(icon('next', 14), el('span', { 'aria-current': 'page' }, '搜索结果'));
  const current = parent();
  selection.use(session?.account, current?.id, folderQuery);
  const title = folderQuery ? '搜索结果' : current?.name || '全部文件';
  const filterBy = value => {
    filter = value;
    if (folderQuery) return loadFiles(false);
    renderFiles(0);
  };
  const type = dropdown('文件类型', filters, filter, filterBy);
  type.dataset.listFocus = 'type';
  const order = dropdown('排序方式', folderQuery ? [['relevance', '相关度'], ...sorts] : sorts, folderQuery ? searchSort : sort,
    guarded(value => { if (folderQuery) searchSort = value; else sort = value; return loadFiles(false); }));
  order.dataset.listFocus = 'sort';
  const scope = folderQuery && dropdown('搜索范围', [['', '全盘'], ['folder', '当前文件夹及子文件夹']], searchScope,
    guarded(value => { searchScope = value; return loadFiles(false); }));
  if (scope) scope.dataset.listFocus = 'search-scope';
  const period = folderQuery && dropdown('修改时间', [['', '不限时间'], ['7', '最近 7 天'], ['30', '最近 30 天'], ['365', '最近一年']], searchTime,
    guarded(value => {
      searchTime = value;
      searchSince = value ? Date.now() - Number(value) * 86400000 : undefined;
      return loadFiles(false);
    }));
  if (period) period.dataset.listFocus = 'search-time';
  const tabs = el('div', { class: 'file-categories', role: 'group', 'aria-label': '文件分类' });
  for (const [kind, label] of categories) {
    const tab = button(label, guarded(() => filterBy(kind)), { className: 'category quiet' });
    tab.setAttribute('aria-pressed', String(filter === kind));
    tab.dataset.listFocus = 'category:' + kind;
    tabs.append(tab);
  }
  const rows = folderQuery ? files : files.filter(item => !filter || filter === item.kind || filter === 'document' && documents.has(item.kind) ||
    filter === 'office' && item.kind === 'online' || filter === 'other' && item.kind === 'shortcut');
  const selectedCount = el('span', { class: 'selection-count', role: 'status' });
  const batchBar = el('div', { class: 'file-toolbar batch-bar', 'aria-label': '批量操作', hidden: '' },
    button('批量下载', guarded(() => selectBatch('download', selection.ids)), { symbol: 'download' }),
    button('批量移动', guarded(() => selectBatch('move', selection.ids)), { symbol: 'folder' }),
    button('批量删除', guarded(() => selectBatch('remove', selection.ids)), { symbol: 'trash' }));
  const clearSelection = button('取消选择', () => { selection.clear(); paintSelection(); }, { className: 'quiet' });
  clearSelection.dataset.listFocus = 'clear-selection';
  const all = el('input', { type: 'checkbox', 'aria-label': '全选已加载项目（当前筛选）', 'data-list-focus': 'select-loaded',
    onchange: () => { selection.setLoaded(rows, all.checked); paintSelection(); } });
  all.disabled = rows.length === 0;
  const header = el('thead', {}, el('tr', {}, el('th', { scope: 'col', class: 'select-cell' }, all),
    ...['名称', '大小', '类型', '修改时间', '操作'].map(label => el('th', { scope: 'col' }, label))));
  const body = el('tbody');
  function paintSelection() {
    const visible = rows.reduce((n, item) => n + Number(selection.has(item)), 0);
    all.checked = rows.length > 0 && visible === rows.length;
    all.indeterminate = visible > 0 && visible < rows.length;
    selectedCount.textContent = selection.size
      ? '已选 ' + selection.size + ' 项' + (selection.size > visible ? '（' + (selection.size - visible) + ' 项未加载或不在当前筛选）' : '')
      : '全选仅限已加载项目';
    clearSelection.disabled = selection.size === 0;
    batchBar.hidden = selection.size === 0;
    for (const checkbox of body.querySelectorAll('[data-row-control="select"]')) {
      checkbox.checked = selection.has({ id: checkbox.closest('tr').dataset.fileId, driveId: checkbox.dataset.driveId });
      checkbox.closest('tr').dataset.selected = String(checkbox.checked);
    }
  }
  function makeRow(item) {
    const action = openAction(item);
    const pick = (checked, range) => { selection.set(item, checked, range, rows); paintSelection(); };
    const open = event => {
      if (rowBusy(item.id)) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey) pick(event.shiftKey || !selection.has(item), event.shiftKey);
      else action(event);
    };
    const options = button(item.name + ' 的操作', event => itemMenu(item, event.currentTarget, favoriteFolders), { symbol: 'more', compact: true, className: 'quiet' });
    options.dataset.rowMenu = item.id;
    options.dataset.rowControl = 'menu';
    const download = ['folder', 'shortcut'].includes(item.kind) ? null
      : button('下载 ' + item.name, guarded(() => downloadItem(item)), { symbol: 'download', compact: true, className: 'quiet' });
    if (download) download.dataset.rowControl = 'download';
    const checkbox = el('input', { type: 'checkbox', 'aria-label': '选择 ' + item.name, 'data-row-control': 'select',
      'data-drive-id': item.driveId, onclick: event => pick(checkbox.checked, event.shiftKey) });
    checkbox.checked = selection.has(item);
    const row = el('tr', { 'data-file-id': item.id, 'data-selected': String(checkbox.checked),
      ondblclick: event => { if (!event.target.closest('button,input,.select-cell')) open(event); },
      onclick: event => {
        if (!rowBusy(item.id) && (event.ctrlKey || event.metaKey || event.shiftKey) && !event.target.closest('button,input,.select-cell')) {
          pick(event.shiftKey || !selection.has(item), event.shiftKey);
        }
      } },
      el('td', { class: 'select-cell' }, checkbox),
      el('td', {}, el('div', { class: folderQuery ? 'search-file' : '' }, el('button',
        { type: 'button', class: 'file-name', 'data-open-id': item.id, 'data-row-control': 'open', onclick: open, title: item.name },
        badge(item.kind, item.name), el('span', {}, item.name)), folderQuery ? item.folder
          ? el('button', { type: 'button', class: 'search-path', title: item.path, 'aria-label': '打开所在文件夹 ' + item.path,
            onclick: guarded(() => openFolder(item.folder, true)) }, item.path)
          : el('small', { class: 'search-path' }, '所在路径暂不可用') : null)),
      el('td', {}, item.kind === 'folder' ? '—' : bytes(item.size)),
      el('td', {}, kindName[item.kind]),
      el('td', {}, date(item.modified, true)),
      el('td', { class: 'row-actions' }, download, options));
    setBusy(row, rowBusy(item.id));
    return row;
  }
  const table = el('table', { class: 'file-table', 'aria-label': '网盘文件' }, header, body);
  const errorNotice = listError && el('div', { class: 'list-error', role: 'alert' },
    el('span', {}, listError.message),
    button('重试读取', guarded(() => loadFiles(listError.append, !listError.append)), { symbol: 'refresh' }));
  const cold = listBusy === 'first';
  const list = el('div', { class: 'file-table-panel', 'aria-busy': String(!!listBusy) },
    el('div', { class: 'list-tools' },
      el('div', { class: 'selection-summary' },
        el('span', {}, folderQuery ? '“' + folderQuery + '” · ' + (searchTotal === null ? '结果总数未知'
          : (indexStatus?.complete ? '共 ' : '目前找到 ') + searchTotal + ' 项 · 已加载 ' + rows.length + ' 项')
          : '已加载 ' + rows.length + ' 项'),
        selectedCount, clearSelection),
      el('div', {}, scope, type, period, order)),
    table,
    cold ? el('div', { class: 'list-loading', role: 'status' }, icon('local-loading', 29),
      el('span', {}, '正在读取文件…'), el('div', { class: 'list-skeleton', 'aria-hidden': 'true' }, Array.from({ length: 3 }, () => el('i')))) : null,
    errorNotice,
    !rows.length && !listBusy && !listError ? folderQuery
      ? empty('未找到匹配项', indexStatus?.complete ? '当前索引没有符合条件的项目。' : '索引尚未完整，可能还有未收录项目。')
      : empty('暂无文件', cursor ? '已加载项目中没有符合筛选的文件，可继续加载。' : '当前列表没有符合条件的项目。') : null,
    cursor && !listError ? el('div', { class: 'list-footer' },
      el('button', { class: 'button', type: 'button', 'data-list-focus': 'append', 'aria-disabled': String(!!listBusy),
        onclick: guarded(() => loadFiles(true)) }, listBusy === 'append' ? '正在载入…' : '加载更多')) : null);
  const toolbar = el('div', { class: 'file-toolbar' }, models.uploadControls,
    folderQuery ? null : button('新建文件夹', () => nameDialog(), { symbol: 'folderPlus' }));
  const indexPanel = el('div', { class: 'index-panel' }, el('span', { id: 'index-status', role: 'status' }, indexMessage()),
    folderQuery || page === 'home' ? button('重建索引', guarded(() => api.indexRefresh('rebuild')), { className: 'quiet' }) : null);
  const scopeNote = folderQuery ? el('p', { class: 'index-note' },
    '按文件名搜索自己的 OneDrive。共享快捷方式仅显示入口。打开未缓存的文件需要联网。') : null;
  target.replaceChildren(...[path, page === 'files' ? heading(title) : null, indexPanel, scopeNote, tabs, toolbar, batchBar,
    ['first', 'refresh'].includes(listBusy) ? el('progress', { class: 'directory-progress',
      'aria-label': listBusy === 'refresh' ? '正在刷新当前目录' : '正在读取当前目录' }) : null, list].filter(Boolean));
  visibleFiles = fileWindow(content, table, body, rows, makeRow, closeMenu);
  visibleFiles.update();
  paintSelection();
  content.scrollTop = scroll;
  visibleFiles.update();
  if (focusKey) [...target.querySelectorAll('[data-list-focus]')].find(node => node.dataset.listFocus === focusKey)?.focus({ preventScroll: true });
  else if (focusRow) visibleFiles.focus(focusRow, active.dataset.rowControl);
}

async function returnFromPreview() {
  if (!currentPreview) return;
  const token = ++transition;
  const { previous, item } = currentPreview;
  await closePreview();
  if (token !== transition) return;
  page = previous.page;
  updateShell();
  if (page === 'home') await renderHome();
  else renderFiles();
  if (token !== transition) return;
  content.scrollTop = previous.scroll;
  visibleFiles?.update();
  const anchors = [...content.querySelectorAll('[data-open-id]')].filter(node => node.dataset.openId === item.id);
  const anchor = anchors.find(node => node.closest('.watch-row, .recent-row')?.className === previous.activity) || anchors[0];
  if (anchor) {
    const more = anchor.closest('details');
    if (more) more.open = true;
    anchor.focus({ preventScroll: true });
  } else visibleFiles?.focus(item.id);
  if (folderQuery && searchRevision !== indexStatus?.revision) {
    const scroll = content.scrollTop;
    await loadFiles(false);
    if (token === transition) {
      content.scrollTop = scroll;
      visibleFiles?.focus(item.id);
    }
  }
}
async function openFile(item, resume, { anchor, view } = {}) {
  const previous = currentPreview?.previous || {
    page: page === 'home' ? 'home' : 'files', scroll: content.scrollTop,
    activity: anchor?.closest('.watch-row, .recent-row')?.className
  };
  const token = ++transition;
  closeMenu();
  if (currentPreview) await closePreview();
  if (token !== transition) return;
  let opened;
  try { opened = await api.open(item.id, resume, view); }
  catch (error) {
    if (token !== transition) return;
    if (page === 'preview') await navigate('files');
    throw error;
  }
  if (token !== transition) {
    if (opened.key) await api.release(opened.key);
    return;
  }
  if (!opened.key) {
    if (page === 'home') await renderHome();
    return;
  }
  const active = session;
  const actions = {
    retry: guarded(() => openFile(item, resume, { view })),
    web: guarded(() => api.openWeb(opened.key)),
    download: guarded(() => downloadItem(item)),
    readFailure: error => { if (active === session) dropUnavailable(item, error); }
  };
  const control = buildPreview(opened, session.settings, toast, actions);
  currentPreview = { ...opened, control, previous };
  clearFileWindow();
  page = 'preview';
  updateShell();
  const header = el('div', { class: 'preview-header' },
    button('返回', guarded(returnFromPreview), { symbol: 'back' }),
    badge(opened.item.kind, opened.item.name),
    el('h1', { title: opened.item.name }, opened.item.name),
    el('span', { class: 'spacer' }),
    opened.pageView ? button(opened.view === 'pdf' ? '工作表视图' : '页面视图',
      guarded(() => openFile(item, resume, { view: opened.view === 'pdf' ? 'sheet' : 'pdf' }))) : null,
    ['pdf', 'sheet', 'markdown', 'text'].includes(opened.view) ? button('在 OneDrive 打开', actions.web) : null,
    button('下载', actions.download, { symbol: 'download' }));
  content.replaceChildren(header, control.view);
  content.scrollTop = 0;
  control.focus();
}

const transferState = { queued: '等待中', running: '进行中', paused: '已暂停', failed: '失败', done: '已完成', canceled: '已取消' };
const transferLabel = { upload: '上传', download: '下载', batch: '网盘操作' };
function transferDetail(job) {
  const active = session;
  const body = el('div', { class: 'task-detail' });
  const load = guarded(async offset => {
    const { items, next } = await api.transferEntries(job.id, offset);
    if (active !== session || !modal.open || !modal.contains(body)) return;
    body.querySelector('.task-more')?.remove();
    for (const row of items) {
      const retry = button(row.restart ? '下载新版' : '重试此项', guarded(async () => {
        await api.transferAction(job.id, row.restart ? 'restart-entry' : 'retry-entry', row.id);
        modal.close();
      }), { className: 'quiet' });
      body.append(el('div', { class: 'task-entry' }, el('strong', {}, row.name),
        el('small', {}, [transferState[row.state], row.error, row.output ? '已保存为 ' + row.output : ''].filter(Boolean).join(' · ')),
        row.state === 'failed' && !['running', 'queued'].includes(job.state) ? retry : null));
    }
    if (next !== null) body.append(el('div', { class: 'task-more' }, button('加载更多', () => load(next))));
  });
  modalPage(job.name, body, [button('关闭', () => modal.close())]);
  load(0);
}
function renderTransfers() {
  const scroll = content.scrollTop;
  const rows = jobList.filter(job => transferTab === 'all' || job.direction === transferTab);
  const tabs = el('div', { class: 'tab-list', 'aria-label': '传输类型' });
  for (const [key, label] of [['all', '全部'], ...Object.entries(transferLabel)]) {
    const tab = button(label, () => { transferTab = key; renderTransfers(); }, { className: 'quiet ' + (transferTab === key ? 'selected' : '') });
    tab.setAttribute('aria-pressed', String(transferTab === key));
    tabs.append(tab);
  }
  const list = el('div', { class: 'transfer-list' });
  for (const job of rows) {
    const actions = el('div', { class: 'transfer-actions' });
    const action = (name, label, symbol) => actions.append(button(label, guarded(() => api.transferAction(job.id, name)), { symbol, className: 'quiet' }));
    if (job.kind) actions.append(button('查看详情', () => transferDetail(job), { className: 'quiet' }));
    if (['queued', 'running'].includes(job.state)) {
      action('pause', '暂停', 'pause');
      action('cancel', '取消', 'close');
    } else {
      if (job.state !== 'done') {
        action(job.restart ? 'restart' : 'retry', job.restart ? '下载新版' : job.state === 'paused' ? '继续'
          : job.kind && job.state === 'failed' ? '重试未完成项' : '重试', 'refresh');
      }
      if (['paused', 'failed'].includes(job.state)) action('cancel', '取消', 'close');
      if (job.direction === 'download' && job.state !== 'done') {
        actions.append(button('移除', () => modalPage('移除下载任务', el('p', { class: 'dialog-note' },
          '此任务的未完成分段将清理，已保存的文件会保留。'), [button('取消', () => modal.close()),
          button('确认移除', guarded(async () => { await api.transferAction(job.id, 'remove'); modal.close(); }), { className: 'danger' })]),
        { symbol: 'trash', className: 'quiet' }));
      } else action('remove', '移除', 'trash');
    }
    const summary = job.summary;
    const detail = summary
      ? el('div', { class: 'transfer-progress' },
        el('small', {}, (summary.complete ? '共 ' : '已发现 ') + summary.discovered + ' 项 · 完成 ' + summary.done +
          ' · 失败 ' + summary.failed + ' · 取消 ' + summary.canceled),
        job.current ? el('small', {}, job.current.name + ' · ' + bytes(job.current.bytes) + ' / ' + bytes(job.current.total)) : null)
      : el('div', { class: 'transfer-progress' }, el('progress', { max: job.total || 1,
        value: job.total ? job.bytes : Number(job.state === 'done'), 'aria-label': job.name + ' 的进度' }),
      el('small', {}, bytes(job.bytes) + ' / ' + bytes(job.total)));
    const jobNote = job.error || job.notice || (job.output && job.output !== job.name ? '已保存为 ' + job.output : '');
    list.append(el('div', { class: 'transfer-row', 'data-state': job.state },
      el('span', { class: 'file-icon kind-' + (job.direction === 'upload' ? 'office' : 'audio') }, icon(job.kind === 'batch' ? 'files' : job.direction, 19)),
      el('div', { class: 'transfer-name' }, el('strong', { title: job.name }, job.name),
        el('small', { title: jobNote }, jobNote || transferLabel[job.direction] + ' · ' + date(job.started, true))),
      detail, el('span', { class: 'transfer-state' }, transferState[job.state]), actions));
  }
  content.replaceChildren(heading('传输', '上传、下载与批量任务', [models.uploadControls]), tabs,
    rows.length ? list : empty('暂无传输任务', '任务加入队列后会显示在这里。', 'transfer'));
  content.scrollTop = scroll;
}

setup();
let starting = false;
api.onStartupStage(text => {
  const status = select('#startup [role="status"]');
  if (status) status.textContent = text;
});
async function startSession(retry = false) {
  if (starting) return;
  starting = true;
  if (retry) content.replaceChildren(el('section', { class: 'welcome', id: 'startup' }, el('h2', {}, '课盘'),
    el('p', { role: 'status' }, '正在恢复登录…')));
  try {
    const next = await api.initial(retry);
    if (next.startupFailed) throw new Error('启动未完成');
    await applySession(next);
  } catch {
    session = null;
    updateShell();
    content.replaceChildren(el('section', { class: 'welcome', id: 'startup' }, el('h2', {}, '课盘启动未完成'),
      el('p', { role: 'status' }, '暂时无法准备本地资料。可在检查资料目录后重试。'),
      button('重试启动', () => startSession(true), { className: 'primary' })));
  } finally {
    starting = false;
  }
}
api.onTransfersChanged(guarded(async () => {
  jobList = await api.transfers();
  const count = jobList.filter(row => ['running', 'queued'].includes(row.state)).length;
  models.count.hidden = !count;
  models.count.textContent = count;
  if (page === 'transfers') renderTransfers();
}));
api.onCloudRecycleChanged(guarded((revision, status) => {
  if (session?.accountRevision !== revision || page !== 'recycle') return;
  if (status.reset) {
    resetCloudView();
    recycleRead += 1;
    recycleSelected.clear();
    clearFileWindow();
    content.replaceChildren(heading('回收站'), el('p', { role: 'status' }, '正在切换账户…'));
    return;
  }
  if (recycleView === 'cloud') return renderCloudRecycle({ keepLoaded: true });
}));
api.onRecycleChanged(guarded(() => { if (page === 'recycle' && recycleView === 'local') return renderLocalRecycle(); }));
api.onIndexChanged((accountRevision, status) => {
  if (session?.accountRevision !== accountRevision) return;
  receiveIndex(status);
  if (page === 'recycle' && recycleView === 'local' && status.phase === 'ready') guarded(renderLocalRecycle)();
});
window.addEventListener('online', () => { if (enabled()) api.indexRefresh('refresh').catch(() => {}); });
window.addEventListener('offline', () => { if (enabled()) api.indexRefresh('refresh').catch(() => {}); });
updateShell();
// Let the first compositor frame display the preloaded shell before starting recovery.
requestAnimationFrame(() => requestAnimationFrame(() => startSession()));
