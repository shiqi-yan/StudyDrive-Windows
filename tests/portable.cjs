const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { createServer } = require('node:net');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const assert = require('node:assert/strict');
const { directoryBuild } = require('../scripts/build-paths.cjs');

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function run() {
  const root = path.resolve(__dirname, '..');
  const results = process.env.STUDY_TEST_RESULTS || path.join(root, 'test-results');
  await fs.mkdir(results, { recursive: true });
  const profile = await fs.mkdtemp(path.join(results, 'portable-'));
  const { version } = require('../package.json');
  const demo = process.argv.includes('--demo');
  const office = !process.argv.includes('--lite');
  const staged = JSON.parse(await fs.readFile(path.join(directoryBuild(root, version, { demo, office }), 'resources', 'app', 'package.json'), 'utf8'));
  assert.equal(staged.studyDriveAuth?.mode === 'demo', demo);
  const exe = path.join(root, 'dist', 'StudyDrive-' + version + '-win-x64' + (office ? '-office' : '') + (demo ? '-demo' : '') + '-portable.exe');
  const port = await reservePort();
  const endpoint = 'http://127.0.0.1:' + port;
  const launcher = spawn(exe, ['--demo', '--test-driver', '--remote-debugging-port=' + port],
    { cwd: root, env: { ...process.env, STUDY_DRIVER: '1', STUDY_TEST_PROFILE: profile }, windowsHide: true, stdio: 'ignore' });
  let launchError;
  launcher.on('error', error => { launchError = error; });
  let browser;
  let debuggerSession;
  try {
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (launcher.exitCode !== null) throw new Error('Portable launcher exited with code ' + launcher.exitCode);
      try {
        const response = await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(1000) });
        if (response.ok) break;
      } catch { /* NSIS is extracting the bundled app. */ }
      await delay(300);
    }
    browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
    debuggerSession = await browser.newBrowserCDPSession();
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 10000 });
    await page.getByRole('heading', { name: '首页' }).waitFor({ timeout: 10000 });
    assert.equal(await page.title(), '课盘 ' + version);
    assert.equal(await page.locator('#build-version').innerText(), version);
    const hash = source => createHash('sha256').update(source).digest('hex');
    for (const name of ['app.mjs', 'player.mjs', 'preview.mjs', 'document-view.mjs', 'sheet-view.mjs']) {
      const packaged = await page.evaluate(file => fetch('/' + file).then(response => response.text()), name);
      assert.equal(hash(packaged), hash(await fs.readFile(path.join(root, 'src', 'renderer', name), 'utf8')), name + ' in the portable matches the checkout');
    }
    if (demo) {
      await page.getByLabel('账户设置').click();
      await page.getByRole('button', { name: '退出本地演示', exact: true }).click();
      await page.getByRole('button', { name: '用 Microsoft 登录', exact: true }).click();
      const login = page.getByRole('dialog');
      await login.getByText(/此版本为本地演示包/).waitFor();
      assert.equal(await login.locator('input,textarea,form').count(), 0);
      assert.ok(!(await login.innerText()).includes('null'));
      await login.getByRole('button', { name: '关闭窗口' }).click();
      await page.getByRole('button', { name: '打开本地演示', exact: true }).click();
      await page.getByText('演示账户', { exact: true }).waitFor();
      console.log('PASS actual demo EXE explains unavailable Microsoft login; local demo remains usable');
    }
    await page.locator('#index-status').filter({ hasText: '索引已更新' }).waitFor();
    await page.getByRole('searchbox').fill('课程成绩');
    await page.getByRole('button', { name: '课程成绩.xlsx', exact: true }).waitFor();
    assert.match(await page.locator('.selection-summary').innerText(), /共 1 项/);
    await page.getByRole('button', { name: '打开所在文件夹 /文档预览示例', exact: true }).waitFor();
    await page.screenshot({ path: path.join(results, 'portable-search.png') });
    await page.locator('#nav').getByRole('button', { name: '全部文件', exact: true }).click();
    await page.getByRole('button', { name: '高等数学', exact: true }).click();
    await page.getByRole('button', { name: '01 · 函数图像与变化.mp4', exact: true }).click();
    await page.locator('[data-player="mpv"][data-ready="true"]').waitFor();
    await page.locator('.player-stage').focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => {
      const video = document.querySelector('[data-player="mpv"]')?.dataset;
      return video?.seeking === 'false' && video.paused === 'true' && Number(video.time) >= 4.8;
    });
    await page.screenshot({ path: path.join(results, 'portable.png') });
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.getByRole('navigation', { name: '文件夹路径' }).getByRole('button', { name: '全部文件', exact: true }).click();
    await page.getByRole('button', { name: '课程计划.docx', exact: true }).click();
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.pdf-paper canvas');
      return canvas && canvas.getContext('2d').getImageData(10, 10, 1, 1).data[3] > 0;
    });
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.getByRole('button', { name: '文档预览示例', exact: true }).click();
    await page.getByRole('button', { name: '课程成绩.xlsx', exact: true }).click();
    await page.getByRole('gridcell', { name: '000172', exact: true }).waitFor();
    await page.screenshot({ path: path.join(results, 'portable-sheet.png') });
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.getByRole('button', { name: '课程导航.md', exact: true }).click();
    await page.getByRole('table').getByText('已上传').waitFor();
    await page.waitForFunction(() => document.querySelector('.markdown-reader img')?.naturalWidth > 0);
    const message = 'PASS Windows portable ' + version + ' extracted and opened; local index search, embedded H.264 playback seek, Office PDF, packaged SheetJS and Markdown with local image worked';
    console.log(message);
    await fs.writeFile(path.join(results, 'portable-evidence.txt'), message + '\n');
  } finally {
    await debuggerSession?.send('Browser.close').catch(() => {});
    await browser?.close().catch(() => {});
    if (launcher.exitCode === null) {
      const exited = new Promise(resolve => launcher.once('exit', () => resolve(true)));
      if (!await Promise.race([exited, delay(45000, false, { ref: false })])) {
        const killer = spawn('taskkill.exe', ['/pid', String(launcher.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => {});
      }
    }
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
