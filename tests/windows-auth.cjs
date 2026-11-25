const { _electron: electron, chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { TEST_CLIENT_ID } = require('../src/login-config.cjs');
const { directoryBuild } = require('../scripts/build-paths.cjs');

const root = path.resolve(__dirname, '..');
const output = process.env.STUDY_TEST_RESULTS || path.join(root, 'test-results', 'auth-0.2.3');
const staged = process.env.STUDY_AUTH_DEMO_DIRECTORY || directoryBuild(root, require('../package.json').version, { office: true, demo: true });
const loginLabel = '用 Microsoft 登录';
const legacyId = '00000000-0000-0000-0000-000000000000';

function installFixture({ app }, { fixtureId, legacyId }) {
  const crypto = process.getBuiltinModule('node:crypto');
  const fs = process.getBuiltinModule('node:fs');
  const path = process.getBuiltinModule('node:path');
  const metadata = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'));
  const graphScope = 'https://graph.microsoft.com/Files.ReadWrite offline_access';
  const names = { a: '授权演示甲', b: '授权演示乙', legacy: '旧版授权演示' };
  const verify = (condition, reason) => { if (!condition) throw new Error(reason); };
  // Every value used to simulate the provider stays in this test process.
  const counts = { opens: 0, exchanges: 0, aborts: 0, legacyRefreshes: 0 };
  let latest;
  let responseAccount;
  let nullToken = false;
  const item = account => ({ id: 'root-' + account, name: '全部文件', folder: {}, size: 0 });
  const credentials = account => ({ access_token: 'fixture-access-' + account, refresh_token: 'fixture-refresh-' + account, expires_in: 3600 });
  const fixture = {
    counts, holdExchange: false, failBrowser: false, failIdentity: false,
    async openExternal(raw) {
      counts.opens += 1;
      const url = new URL(raw);
      const query = url.searchParams;
      const callback = new URL(query.get('redirect_uri'));
      verify(url.origin === 'https://login.microsoftonline.com' && url.pathname === '/consumers/oauth2/v2.0/authorize', 'Official consumer endpoint expected');
      verify(callback.protocol === 'http:' && callback.hostname === 'localhost' && callback.port && callback.pathname === '/study-drive/auth', 'Expected registered loopback');
      verify(metadata.studyDriveAuth.clientId === fixtureId && query.get('client_id') === fixtureId, 'Expected bundled fixture identity');
      verify(query.get('response_type') === 'code' && query.get('response_mode') === 'query' && query.get('prompt') === 'select_account', 'Public OAuth flow expected');
      verify(query.get('scope') === graphScope && !query.has('client_secret'), 'Original scopes required');
      verify(query.get('code_challenge_method') === 'S256' &&
        /^[\w-]{43}$/.test(query.get('code_challenge') || '') &&
        /^[\w-]{43}$/.test(query.get('state') || ''), 'S256 and state required');
      verify(!latest || latest.url.searchParams.get('state') !== query.get('state'), 'Each attempt requires fresh state');
      latest = { url, callback };
      if (fixture.failBrowser) throw new Error('Synthetic browser launch failure');
    },
    callbackUrl(kind, host = '127.0.0.1') {
      const callback = new URL(latest.callback);
      callback.hostname = host;
      callback.searchParams.set('state', kind === 'wrongState' ? 'ignored-state' : latest.url.searchParams.get('state'));
      if (kind === 'denied' || kind === 'serverError') {
        callback.searchParams.set('error', kind === 'denied' ? 'access_denied' : 'server_error');
        callback.searchParams.set('error_description', 'null');
      } else {
        responseAccount = kind === 'b' ? 'b' : 'a';
        nullToken = kind === 'nullToken';
        callback.searchParams.set('code', 'fixture-code-' + responseAccount);
      }
      return callback.href;
    },
    async respond(kind) {
      try {
        const response = await fetch(fixture.callbackUrl(kind));
        const message = await response.text();
        return { status: response.status, safe: !message.includes('null') && !message.includes('fixture-code-') };
      } catch { return { status: 0, safe: true }; }
    },
    async fetcher(raw, init) {
      const url = new URL(raw);
      if (url.origin === 'https://login.microsoftonline.com') {
        const form = init.body;
        verify(url.pathname === '/consumers/oauth2/v2.0/token' && !form.has('client_secret') && form.get('scope') === graphScope, 'Public token request expected');
        if (form.get('grant_type') === 'refresh_token') {
          verify(form.get('client_id') === legacyId && form.get('refresh_token') === 'fixture-refresh-legacy', 'Legacy credential must use its own application identity');
          counts.legacyRefreshes += 1;
          return Response.json(credentials('legacy'));
        }
        verify(form.get('grant_type') === 'authorization_code' && form.get('client_id') === fixtureId &&
          form.get('code') === 'fixture-code-' + responseAccount &&
          form.get('redirect_uri') === latest.callback.href, 'Authorization request must match the callback');
        verify(crypto.createHash('sha256').update(form.get('code_verifier')).digest('base64url') === latest.url.searchParams.get('code_challenge'), 'S256 verifier mismatch');
        counts.exchanges += 1;
        if (fixture.holdExchange) {
          return new Promise((_, reject) => {
            const stop = () => { counts.aborts += 1; reject(new Error('Synthetic exchange cancelled')); };
            if (init.signal.aborted) stop();
            else init.signal.addEventListener('abort', stop, { once: true });
          });
        }
        return nullToken ? Response.json(null, { status: 400 }) : Response.json(credentials(responseAccount));
      }
      verify(url.origin === 'https://graph.microsoft.com', 'External network disabled in the fixture');
      const authorization = new Headers(init.headers).get('authorization');
      const account = Object.keys(names).find(key => authorization === 'Bearer fixture-access-' + key);
      verify(account, 'Graph requests require their own simulated account');
      if (url.pathname === '/v1.0/me/drive') {
        if (fixture.failIdentity) return Response.json({}, { status: 403 });
        return Response.json({ id: 'drive-' + account, driveType: 'personal', owner: { user: { id: account, displayName: names[account] } } });
      }
      const drive = '/v1.0/drives/drive-' + account;
      if (url.pathname === drive + '/root') return Response.json(item(account));
      if (url.pathname === drive + '/items/root-' + account + '/children') {
        return Response.json({ value: [{ id: 'item-' + account, name: names[account] + '的讲义.txt', file: { mimeType: 'text/plain' }, size: 12 }] });
      }
      return Response.json({}, { status: 404 });
    },
    seedLegacy() {
      const { store } = globalThis.studyTest;
      const account = { id: JSON.stringify(['legacy', 'drive-legacy']), name: names.legacy, driveId: 'drive-legacy',
        root: { ...item('legacy'), kind: 'folder', driveId: 'drive-legacy' } };
      const vault = store.vault();
      vault[account.id] = { account, clientId: legacyId, credentials: { access: 'expired-fixture', refresh: 'fixture-refresh-legacy', expires: 0 } };
      store.saveVault(vault);
      store.data.active = account.id;
      store.data.clientId = legacyId;
      store.save();
    }
  };
  globalThis.studyTest.auth = fixture;
}

const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
const dialog = page => page.getByRole('dialog');
async function cleanDialog(page) {
  const modal = dialog(page);
  await modal.waitFor();
  assert.equal(await modal.locator('input,textarea,form').count(), 0);
  assert.ok(!(await modal.innerText()).includes('null'), 'dialog contains no raw null');
}

async function openWindow(executablePath, profile, testing) {
  const args = ['--demo', '--test-driver'];
  if (testing) args.push('--test-auth');
  const app = await electron.launch({ executablePath, args, cwd: root,
    env: { ...process.env, STUDY_DRIVER: '1', STUDY_TEST_PROFILE: profile }, timeout: 25000 });
  try {
    const page = await app.firstWindow();
    await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
    if (testing) await app.evaluate(installFixture, { fixtureId: TEST_CLIENT_ID, legacyId });
    return { app, page };
  } catch (error) { await app.close(); throw error; }
}

const counts = app => app.evaluate(() => globalThis.studyTest.auth.counts);
const respond = (app, kind) => app.evaluate((_, kind) => globalThis.studyTest.auth.respond(kind), kind);
async function opened(app, count) {
  for (let tries = 0; tries < 80; tries += 1) {
    if ((await counts(app)).opens === count) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('Expected one simulated browser handoff per login attempt');
}
async function accountFiles(page, name) {
  await page.locator('#nav').getByRole('button', { name: '全部文件', exact: true }).click();
  await page.getByRole('button', { name: name + '的讲义.txt', exact: true }).waitFor();
}

async function run() {
  await fs.mkdir(output, { recursive: true });
  const work = await fs.mkdtemp(path.join(output, 'offline-auth-fixture-'));
  const isolated = path.join(work, 'unpacked');
  await fs.cp(staged, isolated, { recursive: true });
  const manifest = path.join(isolated, 'resources', 'app', 'package.json');
  const metadata = JSON.parse(await fs.readFile(manifest, 'utf8'));
  assert.deepEqual(metadata.studyDriveAuth, { mode: 'demo' });
  await fs.writeFile(manifest, JSON.stringify({ ...metadata, studyDriveAuth: { mode: 'test', clientId: TEST_CLIENT_ID } }));
  const profile = path.join(work, 'profile');
  const exe = path.join(isolated, 'StudyDrive.exe');
  let app;
  let page;
  let systemBrowser;
  try {
    ({ app, page } = await openWindow(exe, profile, true));
    await page.getByRole('heading', { name: '连接 OneDrive 个人版' }).waitFor();
    assert.equal(await dialog(page).count(), 0);
    await page.getByRole('button', { name: loginLabel, exact: true }).evaluate(node => { node.click(); node.click(); });
    await opened(app, 1);
    await cleanDialog(page);
    await dialog(page).getByText(/Windows 默认浏览器/).waitFor();
    const duplicateRejected = await page.evaluate(() => window.study.login('ignored').then(() => false, error => /正在进行/.test(error.message)));
    assert.equal(duplicateRejected, true);
    assert.equal((await respond(app, 'wrongState')).status, 400);
    assert.equal((await counts(app)).exchanges, 0);
    assert.deepEqual(await respond(app, 'denied'), { status: 400, safe: true });
    await dialog(page).getByText(/被拒绝或取消/).waitFor();
    await cleanDialog(page);
    console.log('PASS first click, one official consumer browser request, bundled test ID, localhost and state; no ID field or raw null after denial');

    await click(page, '重试');
    await opened(app, 2);
    await click(page, '取消登录');
    await dialog(page).getByText('Microsoft 登录已取消。', { exact: true }).waitFor();
    assert.equal((await respond(app, 'a')).status, 410);
    await cleanDialog(page);
    await app.evaluate(() => { globalThis.studyTest.auth.holdExchange = true; });
    await click(page, '重试');
    await opened(app, 3);
    assert.deepEqual(await respond(app, 'a'), { status: 200, safe: true });
    await click(page, '取消登录');
    await dialog(page).getByText('Microsoft 登录已取消。', { exact: true }).waitFor();
    assert.equal((await counts(app)).aborts, 1);
    assert.equal(await page.evaluate(async () => (await window.study.initial()).accounts.length), 0);
    console.log('PASS user cancellation leaves a bounded branded result; cancelling during code exchange aborts it and stores no account');

    await app.evaluate(() => { globalThis.studyTest.auth.holdExchange = false; globalThis.studyTest.auth.failBrowser = true; });
    await click(page, '重试');
    await opened(app, 4);
    await dialog(page).getByText(/无法打开 Windows 默认浏览器/).waitFor();
    await app.evaluate(() => { globalThis.studyTest.auth.failBrowser = false; });
    await click(page, '重试');
    await opened(app, 5);
    assert.deepEqual(await respond(app, 'nullToken'), { status: 400, safe: true });
    await dialog(page).getByText(/Microsoft 未接受登录请求/).waitFor();
    await cleanDialog(page);
    await click(page, '重试');
    await opened(app, 6);
    const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
    systemBrowser = await chromium.launch({ executablePath: edge, headless: false, args: ['--no-first-run'] });
    const browserPage = await systemBrowser.newPage();
    async function browserCallback(kind, message, host = 'localhost') {
      const target = await app.evaluate((_, input) => globalThis.studyTest.auth.callbackUrl(input.kind, input.host), { kind, host });
      try { await browserPage.goto(target, { waitUntil: 'domcontentloaded' }); }
      catch { throw new Error('Windows Edge could not connect to the isolated loopback callback'); }
      await browserPage.getByText(message).waitFor();
      assert.equal(new URL(browserPage.url()).search, '');
      assert.equal(await browserPage.getByRole('heading', { name: '课盘', exact: true }).count(), 1);
      assert.ok(!(await browserPage.locator('body').innerText()).includes('fixture-'));
    }
    await browserCallback('serverError', /Microsoft 登录服务暂时无法完成授权/);
    await dialog(page).getByText(/Microsoft 登录服务暂时无法完成授权/).waitFor();
    await click(page, '重试');
    await opened(app, 7);
    await click(page, '取消登录');
    await dialog(page).getByText('Microsoft 登录已取消。', { exact: true }).waitFor();
    await browserCallback('a', /已取消登录/);
    await click(page, '重试');
    await opened(app, 8);
    await browserCallback('a', /已连接 OneDrive，可返回课盘/, '[::1]');
    await page.getByText('授权演示甲', { exact: true }).waitFor();
    assert.equal(await dialog(page).count(), 0);
    assert.ok(await page.evaluate(async () => {
      const data = await window.study.initial();
      return !('clientId' in data) && data.accounts.length === 1;
    }));
    console.log('PASS browser failure and null provider response are localized; retry redeems S256 and automatically shows the connected account');
    console.log('PASS system Edge with a fresh profile reaches localhost and IPv6 loopback; server_error, cancellation and verified success show branded query-free pages');

    await page.getByLabel('账户设置').click();
    await click(page, loginLabel);
    await opened(app, 9);
    await cleanDialog(page);
    assert.deepEqual(await respond(app, 'b'), { status: 200, safe: true });
    await page.getByText('授权演示乙', { exact: true }).waitFor();
    await accountFiles(page, '授权演示乙');
    await app.evaluate(() => { globalThis.studyTest.auth.failIdentity = true; });
    await page.getByLabel('账户设置').click();
    await click(page, loginLabel);
    await opened(app, 10);
    await browserCallback('a', /课盘未能连接 OneDrive/);
    await dialog(page).getByText(/OneDrive 拒绝访问/).waitFor();
    await dialog(page).getByRole('button', { name: '关闭窗口' }).click();
    assert.equal(await page.locator('#account').getByText('授权演示乙', { exact: true }).count(), 1);
    console.log('PASS branded success requires account association; Graph failure leaves the prior account active');
    await page.getByLabel('账户设置').click();
    await click(page, '授权演示甲');
    await accountFiles(page, '授权演示甲');
    assert.equal((await counts(app)).opens, 10);
    const encrypted = await fs.readFile(path.join(profile, 'credentials.bin'));
    assert.ok(encrypted.length > 0 && !encrypted.includes('fixture-refresh-'), 'Windows storage encrypts the mock credentials');
    await app.evaluate(() => globalThis.studyTest.auth.seedLegacy());
    await app.close();
    app = undefined;

    ({ app, page } = await openWindow(exe, profile, true));
    await page.getByText('旧版授权演示', { exact: true }).waitFor();
    await accountFiles(page, '旧版授权演示');
    assert.equal((await counts(app)).legacyRefreshes, 1);
    await page.getByLabel('账户设置').click();
    await click(page, '退出当前账户');
    await page.getByRole('heading', { name: '连接 OneDrive 个人版' }).waitFor();
    await page.getByLabel('账户设置').click();
    assert.equal(await dialog(page).getByRole('button', { name: '旧版授权演示' }).count(), 0);
    await click(page, '授权演示乙');
    await accountFiles(page, '授权演示乙');
    console.log('PASS account dialog uses the same flow; switching isolates files, restart refreshes the legacy registration, and sign-out only removes the active credential');
    await app.close();
    app = undefined;

    ({ app, page } = await openWindow(exe, path.join(work, 'test-config-without-switch'), false));
    assert.equal(await page.evaluate(async () => (await window.study.initial()).loginAvailable), false);
    console.log('PASS test-only manifest never enables online login outside the isolated test driver route');
    await app.close();
    app = undefined;

    ({ app, page } = await openWindow(path.join(staged, 'StudyDrive.exe'), path.join(work, 'demo-profile'), false));
    await page.getByLabel('账户设置').click();
    await click(page, '退出本地演示');
    await page.getByRole('heading', { name: '连接 OneDrive 个人版' }).waitFor();
    await click(page, loginLabel);
    await dialog(page).getByText(/此版本为本地演示包/).waitFor();
    await cleanDialog(page);
    const unavailable = await page.evaluate(() => window.study.login().then(() => false, error => /本地演示包/.test(error.message)));
    assert.equal(unavailable, true);
    await page.screenshot({ path: path.join(output, 'demo-login-notice.png') });
    console.log('PASS actual demo manifest has no ID; unconfigured Home and IPC explain that Microsoft login needs a configured release');
  } finally { await systemBrowser?.close(); await app?.close(); }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
