const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { _electron: electron } = require('playwright');
const { startMock } = require('../src/mock.cjs');
const { itemInfo } = require('../src/drive.cjs');
const { directoryBuild } = require('../scripts/build-paths.cjs');
const { version } = require('../package.json');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results', 'list-' + version);
const large = '大目录验收';
const sample = number => '资料 ' + String(number).padStart(5, '0') + (number === 5000 ? '' : '.txt');

async function launch(targetVersion, run) {
  const profile = await fs.mkdtemp(path.join(output, targetVersion + '-'));
  const mock = await startMock(profile, path.join(root, 'fixtures'));
  await new Promise(resolve => mock.server.close(resolve));
  const fixture = path.join(profile, 'demo-files', 'mock.json');
  const state = JSON.parse(await fs.readFile(fixture, 'utf8'));
  const base = state.items.find(item => item.id === 'root');
  const text = state.items.find(item => item.id === 'text');
  state.items.push({ ...base, id: 'large', parentId: 'root', name: large });
  for (let n = 1; n <= 10000; n += 1) {
    state.items.push({ ...(n === 5000 ? base : text), id: 'large-' + n, parentId: 'large', name: sample(n) });
  }
  await fs.writeFile(fixture, JSON.stringify(state));
  const app = await electron.launch({
    executablePath: path.join(directoryBuild(root, targetVersion, { office: targetVersion === version }), 'StudyDrive.exe'),
    args: ['--demo', '--test-driver'], cwd: root,
    env: { ...process.env, STUDY_DRIVER: '1', STUDY_TEST_PROFILE: profile }
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(12000);
    const btn = name => page.getByRole('button', { name, exact: true });
    const nav = name => page.locator('#nav').getByRole('button', { name, exact: true });
    await nav('全部文件').click();
    await btn(large).waitFor();
    await run({ app, page, btn, nav, state });
  } finally { await app.close(); }
}

async function baseline({ app, page, btn, state }) {
  // The 0.2.8 mock has a fixed small page. Use one isolated IPC fixture to
  // compare an equal-sized dataset without clicking Load More hundreds of times.
  const fixture = state.items.filter(item => item.parentId === 'large')
    .map(item => itemInfo(item, 'study-drive-demo'));
  await app.evaluate(({ ipcMain }, fixture) => {
    ipcMain.removeHandler('drive:list');
    ipcMain.handle('drive:list', () => ({ data: { items: fixture, cursor: '', stale: false } }));
  }, fixture);
  await btn(large).click();
  const rows = page.locator('.file-table tbody tr');
  await rows.last().waitFor({ state: 'attached' });
  const before = await rows.count();
  assert.equal(before, 10000);
  console.log('BASE 0.2.8, 10000-item isolated IPC fixture, mounted rows=' + before);
}

async function updated({ app, page, btn, nav }) {
  const changeMock = (values) => app.evaluate((_, values) => Object.assign(globalThis.studyTest.mock, values), values);
  await changeMock({ listPageSizes: { large: 9900 }, listDelays: { large: 450 }, listStatuses: { large: 503 } });
  await btn(large).click();
  await page.locator('.list-skeleton').waitFor();
  assert.equal(await page.getByText('暂无文件', { exact: true }).count(), 0);
  const error = page.getByRole('alert');
  await error.getByText(/OneDrive 请求失败/).waitFor();
  await changeMock({ listStatuses: {}, listDelays: {} });
  await btn('重试读取').click();
  const table = page.getByRole('table', { name: '网盘文件' });
  await page.waitForFunction(() => document.querySelector('.file-table')?.getAttribute('aria-rowcount') === '9901');
  const initial = await table.locator('[data-file-id]').count();
  assert.ok(initial < 45);
  await btn('加载更多').click();
  await page.waitForFunction(() => document.querySelector('.file-table')?.getAttribute('aria-rowcount') === '10001');
  console.log('PASS cold skeleton, failed request retry, explicit append from 9900 to 10000; first DOM=' + initial);

  await page.locator('#content').evaluate(node => { node.scrollTop = 349960; });
  await btn(sample(5000)).waitFor();
  const middle = await table.locator('[data-file-id]').count();
  assert.ok(middle < 45);
  await page.screenshot({ path: path.join(output, 'large-directory.png'), scale: 'css' });
  await btn(sample(5000)).locator('xpath=ancestor::tr').getByRole('cell').nth(2).dblclick();
  await page.getByRole('heading', { name: sample(5000), exact: true }).waitFor();
  await page.getByRole('navigation', { name: '文件夹路径' }).getByRole('button', { name: large, exact: true }).click();
  await btn(sample(5000)).waitFor();
  await page.waitForFunction(() => document.activeElement?.dataset.openId === 'large-5000');
  assert.equal(await table.getAttribute('aria-rowcount'), '10001');
  await btn(sample(5000)).press('ArrowDown');
  await page.waitForFunction(() => document.activeElement?.dataset.openId === 'large-5001');
  await btn(sample(5001)).press('Enter');
  await page.locator('.text-line').first().waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.dataset.openId === 'large-5001');
  await btn(sample(5001)).press('End');
  await page.waitForFunction(() => document.activeElement?.dataset.openId === 'large-10000');
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setContentSize(900, 700);
    win.webContents.setZoomFactor(1.15);
  });
  await page.waitForFunction(() => devicePixelRatio > 2 || innerWidth < 880);
  const resized = await table.locator('[data-file-id]').count();
  assert.ok(resized < 45);
  const categories = page.getByRole('group', { name: '文件分类' });
  await categories.getByRole('button', { name: '文件夹', exact: true }).click();
  await btn(sample(5000)).waitFor();
  assert.equal(await table.getAttribute('aria-rowcount'), '2');
  assert.ok(await categories.getByRole('button', { name: '文件夹', exact: true }).evaluate(node => node === document.activeElement));
  console.log('PASS deep-scroll double-click, breadcrumb snapshot and focus, row keyboard navigation and filter at resize/zoom; middle DOM=' + middle + ', resized DOM=' + resized);

  const top = () => page.getByRole('navigation', { name: '文件夹路径' }).getByRole('button', { name: '全部文件', exact: true }).click();
  await top();
  await changeMock({ listDelays: { reference: 600 }, listStatuses: { reference: 403 } });
  await btn('参考资料').click();
  await page.locator('.list-skeleton').waitFor();
  await btn('返回上一级').click();
  await btn('高等数学').click();
  const video = '01 · 函数图像与变化.mp4';
  await btn(video).click();
  await page.locator('[data-player="mpv"][data-ready="true"]').waitFor();
  assert.equal(await page.getByText('OneDrive 拒绝访问。', { exact: true }).count(), 0);
  await page.getByLabel('播放倍速').selectOption('1.5');
  await page.locator('.player-stage').press('ArrowDown');
  await page.locator('[data-player="mpv"][data-volume="95"]').waitFor();
  await page.locator('.player-stage').press('ArrowRight');
  await page.waitForFunction(() => {
    const media = document.querySelector('[data-player="mpv"]')?.dataset;
    return Number(media?.time) >= 4.8 && media.seeking === 'false';
  });
  await nav('首页').click();
  await btn('继续观看').click();
  await page.waitForFunction(() => {
    const media = document.querySelector('[data-player="mpv"]')?.dataset;
    return Number(media?.time) >= 4.8 && media.ready === 'true' && media.paused === 'true' && media.rate === '1.5';
  });
  await btn('返回').click();
  await nav('全部文件').click();
  await top();
  await btn('课程计划.docx').click();
  await page.waitForFunction(() => document.querySelector('.pdf-paper canvas')?.getContext('2d').getImageData(10, 10, 1, 1).data[3] > 0);
  console.log('PASS stale denied request ignored after quick switch, native video seek/volume and Home resume at 1.5×, Office fixture paints PDF');
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  if (process.argv.includes('--baseline')) await launch('0.2.8', baseline);
  else await launch(version, updated);
})().catch(error => { console.error(error); process.exitCode = 1; });
