const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createServer } = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright');
const { version } = require('../package.json');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results', 'transfer-' + version);

async function run() {
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(output, 'portable-profile-'));
  const temp = await fs.mkdtemp(path.join(root, '..', 'portable-tmp-'));
  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
  const endpoint = 'http://127.0.0.1:' + port;
  const exe = path.join(root, 'dist', 'StudyDrive-' + version + '-win-x64-office-portable.exe');
  const child = spawn(exe, ['--user-data-dir=' + profile, '--remote-debugging-port=' + port], {
    cwd: root, env: { ...process.env, TEMP: temp, TMP: temp }, stdio: 'ignore'
  });
  let launchError;
  child.on('error', error => { launchError = error; });
  let browser;
  let session;
  try {
    const deadline = Date.now() + 70000;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (child.exitCode != null) throw new Error('Portable exited ' + child.exitCode);
      try { if ((await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
      await delay(300);
    }
    browser = await chromium.connectOverCDP(endpoint, { timeout: 25000 });
    session = await browser.newBrowserCDPSession();
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 10000 });
    await page.getByRole('button', { name: '打开本地演示', exact: true }).click();
    assert.equal(await page.locator('#build-version').innerText(), version);
    await page.locator('#nav').getByRole('button', { name: '回收站', exact: true }).click();
    await page.getByRole('heading', { name: '回收站', exact: true }).waitFor();
    await page.getByText('尚未连接云回收站。当前数据源仍待验证。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '连接云回收站', exact: true }).count(), 0);
    await page.screenshot({ path: path.join(output, 'cloud-unavailable.png') });
    await page.getByRole('button', { name: '本机删除记录', exact: true }).click();
    await page.getByText('暂无已记录的删除项', { exact: true }).waitFor();
    const entries = await fs.readdir(temp, { recursive: true, withFileTypes: true });
    const files = entries.filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name));
    const assets = ['dsoffice.exe', 'pdf.min.mjs', 'xlsx.js', 'libmpv-2.dll'];
    for (const name of assets) assert.ok(files.some(file => path.basename(file) === name), 'Extracted asset: ' + name);
    const longest = Math.max(...files.map(file => file.length));
    await page.screenshot({ path: path.join(output, 'portable-recycle.png') });
    const note = 'PASS ' + version + ' portable normal launch and recycle; D: temp root length ' + temp.length +
      ', longest observed extracted file path ' + longest + ', Office/PDF.js/Excel/mpv present';
    console.log(note);
    await fs.writeFile(path.join(output, 'portable-evidence.txt'), note + '\n');
  } finally {
    await session?.send('Browser.close').catch(() => {});
    await browser?.close().catch(() => {});
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', () => resolve(true)));
      if (!await Promise.race([exited, delay(30000, false, { ref: false })])) {
        spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      }
    }
    await fs.rmdir(temp).catch(() => {});
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
