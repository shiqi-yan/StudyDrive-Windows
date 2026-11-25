const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const results = process.env.STUDY_TEST_RESULTS || path.join(root, 'test-results', 'office-0.2.5');
const { version } = require('../package.json');
const officialId = 'b915bec7-5f50-46dc-a80f-544f7d35ea57';

async function port() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}

async function waitFor(endpoint, launcher) {
  const end = Date.now() + 300000;
  while (launcher.exitCode === null && Date.now() < end) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(700) });
      if (response.ok) return await response.json();
    } catch { /* Portable launchers extract before starting the app. */ }
    await delay(240);
  }
  throw new Error('The actual portable EXE did not expose its local test window');
}

async function mainInspector(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  return { socket, run(expression) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.removeEventListener('message', received); reject(new Error('Test inspector timed out')); }, 6000);
      function received({ data }) {
        const message = JSON.parse(data);
        if (message.id !== id) return;
        clearTimeout(timer);
        socket.removeEventListener('message', received);
        if (message.error || message.result?.exceptionDetails) reject(new Error('Test inspector failed'));
        else resolve(message.result.result.value);
      }
      socket.addEventListener('message', received);
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
  } };
}

async function withPortable(office, check, executable) {
  const profile = await fs.mkdtemp(path.join(results, office ? 'office-' : 'standard-'));
  const rendererPort = await port();
  const inspectorPort = await port();
  const endpoint = 'http://127.0.0.1:' + rendererPort;
  const exe = executable || path.join(root, 'dist', 'StudyDrive-' + version + '-win-x64' + (office ? '-office' : '') + '-portable.exe');
  const launcher = spawn(exe, ['--demo', '--test-driver', '--remote-debugging-port=' + rendererPort, '--inspect=127.0.0.1:' + inspectorPort],
    { cwd: root, env: { ...process.env, STUDY_DRIVER: '1', STUDY_TEST_PROFILE: profile }, windowsHide: false, stdio: 'ignore' });
  launcher.on('error', () => {});
  let browser;
  let debuggerSession;
  let main;
  try {
    await waitFor(endpoint + '/json/version', launcher);
    const [entry] = await waitFor('http://127.0.0.1:' + inspectorPort + '/json/list', launcher);
    main = await mainInspector(entry.webSocketDebuggerUrl);
    browser = await chromium.connectOverCDP(endpoint, { timeout: 8000 });
    debuggerSession = await browser.newBrowserCDPSession();
    const page = browser.contexts()[0].pages()[0];
    await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
    const manifest = await main.run(`(() => {
      const {app}=process.mainModule.require('electron');
      const fs=process.getBuiltinModule('node:fs');
      const path=process.getBuiltinModule('node:path');
      const pkg=JSON.parse(fs.readFileSync(path.join(app.getAppPath(),'package.json'),'utf8'));
      return {mode:pkg.studyDriveAuth.mode,id:pkg.studyDriveAuth.clientId,office:pkg.studyDriveOffice,
        native:fs.existsSync(path.join(app.getAppPath(),'node_modules/@deepseek-ai/libreoffice-kit-win32-x64/prebuilds.json'))};
    })()`);
    assert.deepEqual(manifest, { mode:'release', id:officialId, office:office ? '0.2.3' : false, native:office });
    await page.locator('#nav').getByRole('button', { name: '全部文件', exact: true }).click();
    await check(page, main.run, profile);
  } finally {
    if (main?.socket.readyState === WebSocket.OPEN) {
      const disconnected = new Promise(resolve => main.socket.addEventListener('close', resolve, { once:true }));
      main.socket.close();
      await Promise.race([disconnected, delay(1200)]);
    }
    await Promise.race([debuggerSession?.send('Browser.close').catch(() => {}), delay(1500)]);
    await Promise.race([browser?.close().catch(() => {}), delay(1500)]);
    if (launcher.exitCode === null) {
      await Promise.race([new Promise(resolve => launcher.once('exit', resolve)), delay(45000)]);
      if (launcher.exitCode === null) spawn('taskkill.exe', ['/pid', String(launcher.pid), '/t', '/f'], { windowsHide:true, stdio:'ignore' }).on('error', () => {});
    }
  }
}

const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
async function conversion(page, label) {
  const ready = page.getByText(label, { exact: true });
  const error = page.locator('.preview-error');
  await ready.or(error).first().waitFor({ timeout: 90000 });
  if (!(await ready.count())) throw new Error(await error.innerText());
}
async function painted(page, pageNumber) {
  await page.waitForFunction(number => {
    const canvas = document.querySelector('.pdf-paper canvas');
    return canvas?.getAttribute('aria-label') === 'PDF 第 ' + number + ' 页' &&
      canvas.width > 20 && canvas.getContext('2d').getImageData(10, 10, 1, 1).data[3] > 0;
  }, pageNumber, { timeout: 90000 });
}

async function run() {
  await fs.mkdir(results, { recursive: true });
  if (process.argv.includes('--lite')) return withPortable(false, async (page, main) => {
    await click(page, '课程计划.docx');
    await conversion(page, 'OneDrive 转换');
    await painted(page, 1);
    await click(page, '返回');
    await main('globalThis.studyTest.mock.conversionStatus.office = 422');
    await click(page, '课程计划.docx');
    await page.getByRole('alert').getByText(/本机 Office 组件暂不可用/).waitFor();
    console.log('PASS standard release EXE renders mock Graph PDF and clearly reports an absent local engine');
  });
  await withPortable(true, async (page, main, profile) => {
    await main('globalThis.studyTest.mock.conversionStatus.office = 422; globalThis.studyTest.mock.conversionStatus.pptx = 422; true');
    await click(page, '课程计划.docx');
    await conversion(page, '本机转换');
    await painted(page, 1);
    assert.ok(!(await fs.readdir(profile)).some(name => name.startsWith('office-preview-')));
    await click(page, '返回');
    console.log('PASS full release EXE paints native Word output with mock Graph unavailable; scratch removed');

    await click(page, '文档预览示例');
    await click(page, '课程演示.pptx');
    await conversion(page, '本机转换');
    await painted(page, 1);
    const slides = page.getByRole('navigation', { name: '幻灯片缩略图' });
    const second = slides.getByRole('button', { name: '幻灯片 2', exact: true });
    await second.click();
    await painted(page, 2);
    assert.equal(await second.getAttribute('aria-current'), 'page');
    await click(page, '返回');
    console.log('PASS actual Office EXE loads native PPT output and jumps to slide 2 from the selected thumbnail');

    await click(page, '格式与公式.xlsx');
    const merged = page.getByRole('gridcell', { name: '合并标题', exact: true });
    await merged.waitFor();
    assert.equal(await merged.getAttribute('aria-colspan'), '3');
    assert.deepEqual(await merged.evaluate(node => {
      const css = getComputedStyle(node);
      return [css.fontWeight, css.backgroundColor, css.borderBottomWidth, css.justifyContent];
    }), ['700', 'rgb(215, 234, 245)', '2px', 'center']);
    await page.getByRole('gridcell', { name: '17', exact: true }).click();
    const formula = page.getByLabel('公式或单元格内容');
    await page.waitForFunction(() => document.querySelector('.sheet-formula input').value === '=SUM(B2:C2)');
    assert.equal(await formula.inputValue(), '=SUM(B2:C2)');
    await page.screenshot({ path: path.join(results, 'styled-sheet.png') });
    await page.getByLabel('活动工作表').selectOption({ label: '归档' });
    await page.getByRole('gridcell', { name: '第二张工作表', exact: true }).waitFor();
    console.log('PASS actual Office EXE renders XLSX common styles and merges, cached formula value and text, and a worksheet switch');
  });
}

if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { withPortable, click, conversion, painted };
