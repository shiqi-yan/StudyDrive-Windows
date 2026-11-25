const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { directoryBuild } = require('../scripts/build-paths.cjs');

const root = path.resolve(__dirname, '..');
const results = process.env.STUDY_TEST_RESULTS || path.join(root, 'test-results', 'startup-0.2.6');
const version = process.argv[2] || require('../package.json').version;

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function exists(target) { try { await fs.access(target); return true; } catch { return false; } }

async function measure(exe, base, temp, direct, trial, checkDuplicate) {
  const profile = path.join(base, 'profile');
  const control = path.join(base, 'control-' + trial + '.json');
  await fs.mkdir(profile, { recursive: true });
  const port = await reservePort();
  const endpoint = 'http://127.0.0.1:' + port;
  const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'startup-window.ps1'), '-Control', control],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  ps.stdout.on('data', chunk => { output += chunk.toString(); });
  const exited = new Promise(resolve => ps.once('exit', resolve));
  for (let n = 0; n < 100 && !output.includes('READY'); n += 1) await delay(40);
  assert.ok(output.includes('READY'), 'window monitor initialized');
  const start = Date.now();
  const launch = spawn(exe, ['--user-data-dir=' + profile, '--remote-debugging-port=' + port],
    { cwd: root, env: { ...process.env, TEMP: temp, TMP: temp }, windowsHide: false, stdio: 'ignore' });
  let launchError;
  launch.on('error', error => { launchError = error; });
  const appExited = new Promise(resolve => launch.once('exit', resolve));
  await fs.writeFile(control + '.new', JSON.stringify({ pid: launch.pid, start, direct }));
  await fs.rename(control + '.new', control);
  let browser;
  let close;
  let visible;
  let headingMs;
  let state;
  let duplicate;
  let integrated;
  try {
    let available = false;
    for (let n = 0; n < 1000 && launch.exitCode === null; n += 1) {
      if (launchError) throw launchError;
      try { if ((await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(400) })).ok) { available = true; break; } } catch {}
      await delay(125);
    }
    assert.ok(available, 'isolated normal launch diagnostic port, launcher exit=' + launch.exitCode);
    browser = await chromium.connectOverCDP(endpoint, { timeout: 7000 });
    close = await browser.newBrowserCDPSession();
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page');
    await page.getByRole('heading', { name: '连接 OneDrive 个人版', exact: true }).waitFor({ timeout: 10000 });
    headingMs = Date.now() - start;
    state = await page.evaluate(async () => {
      const info = await window.study.initial();
      return { loginAvailable: info.loginAvailable, connected: !!info.account, demo: info.demo };
    });
    assert.deepEqual(state, { loginAvailable: true, connected: false, demo: false });
    await exited;
    visible = JSON.parse(output.split(/\r?\n/).find(line => line.startsWith('{')));
    assert.ok(visible.electronMs != null && visible.visibleMs != null, 'observed a physical main window');
    if (process.env.STUDY_EXPECT_INTEGRATED === '1') {
      const assets = path.join(path.dirname(visible.exe), 'resources', 'app');
      integrated = {
        office: await exists(path.join(assets, 'node_modules/@deepseek-ai/libreoffice-kit-win32-x64/bin/dsoffice.exe')),
        pdf: await exists(path.join(assets, 'vendor/pdf/pdf.min.mjs')),
        mpv: await exists(path.join(assets, 'vendor/mpv/libmpv-2.dll')),
        launchShell: await page.evaluate(async () => (await (await fetch('/index.html')).text()).includes('正在启动课盘…'))
      };
      assert.deepEqual(integrated, { office: true, pdf: true, mpv: true, launchShell: true });
    }
    if (checkDuplicate) {
      const other = spawn(exe, ['--user-data-dir=' + profile], {
        cwd: root, env: { ...process.env, TEMP: temp, TMP: temp }, windowsHide: false, stdio: 'ignore'
      });
      const otherExited = new Promise((resolve, reject) => { other.once('exit', resolve); other.once('error', reject); });
      const code = await Promise.race([otherExited, delay(45000, 'timeout', { ref: false })]);
      if (code === 'timeout') {
        spawn('taskkill.exe', ['/pid', String(other.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      }
      const heading = page.getByRole('heading', { name: '连接 OneDrive 个人版', exact: true });
      const stillVisible = browser.isConnected() && await heading.isVisible().catch(() => false);
      assert.equal(code, 0, 'second packed launch exited normally through the single-instance lock');
      assert.ok(stillVisible, 'first isolated window remains usable');
      duplicate = { exitCode: code, originalWindowRemained: stillVisible };
    }
  } finally {
    if (ps.exitCode === null) ps.kill();
    await Promise.race([close?.send('Browser.close').catch(() => {}), delay(1300)]);
    await Promise.race([browser?.close().catch(() => {}), delay(1300)]);
    if (launch.exitCode === null) await Promise.race([appExited, delay(18000, undefined, { ref: false })]);
    if (launch.exitCode === null) {
      spawn('taskkill.exe', ['/pid', String(launch.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      await Promise.race([appExited, delay(1600)]);
    }
  }
  const removed = direct ? false : !(await exists(path.dirname(visible.exe)));
  return { trial, electronMs: visible.electronMs, firstVisibleWindowMs: visible.visibleMs,
    launcherVisibleMs: visible.launcherVisibleMs, firstRenderedHomeMs: headingMs, usingPackedLauncher: !direct,
    extractedDirectoryRemovedOnExit: removed, state, ...(duplicate ? { duplicate } : {}), ...(integrated ? { integrated } : {}) };
}

async function run() {
  await fs.mkdir(results, { recursive: true });
  const evidenceFile = path.join(results, 'startup-' + version + '.json');
  const selection = process.env.STUDY_STARTUP_SELECTION;
  const evidence = selection && await exists(evidenceFile)
    ? JSON.parse(await fs.readFile(evidenceFile, 'utf8')) : { version, rounds: [] };
  for (const office of [false, true]) {
    for (const direct of [false, true]) {
      const variant = office ? 'office' : 'standard';
      const mode = direct ? 'directory' : 'single';
      if (selection && selection !== variant && selection !== variant + '-' + mode) continue;
      evidence.rounds = evidence.rounds.filter(row => row.variant !== variant || row.mode !== mode);
      const dir = version === '0.2.5' ? path.join(root, 'dist', 'win-unpacked' + (office ? '-office' : '')) : directoryBuild(root, version, { office });
      const exe = direct ? path.join(dir, 'StudyDrive.exe')
        : path.join(root, 'dist', 'StudyDrive-' + version + '-win-x64' + (office ? '-office' : '') + '-portable.exe');
      const base = await fs.mkdtemp(path.join(results, version + '-' + variant + '-' + mode + '-'));
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sdb-'));
      const count = Number(process.env.STUDY_STARTUP_ROUNDS || 2);
      try {
        for (let trial = 1; trial <= count; trial += 1) {
          const duplicate = !!process.env.STUDY_STARTUP_DUPLICATE && !office && !direct && trial === 1;
          const result = { variant, mode, ...await measure(exe, base, temp, direct, trial, duplicate) };
          evidence.rounds.push(result);
          console.log(JSON.stringify(result));
          await fs.writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + '\n');
        }
      } finally {
        if (path.dirname(temp) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('sdb-')) {
          await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
        }
      }
    }
  }
  console.log(selection ? 'PASS visible Windows startup for ' + selection :
    'PASS visible Windows startup and repeat timings for both single-file and directory variants');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
