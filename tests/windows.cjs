const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chunkSize } = require('../src/transfers.cjs');

const root = path.resolve(__dirname, '..');
const outputs = process.env.STUDY_TEST_RESULTS || path.join(root, 'test-results');
const { directoryBuild } = require('../scripts/build-paths.cjs');
const executablePath = process.env.STUDY_E2E_EXE || path.join(
  directoryBuild(root, require('../package.json').version, { demo: process.argv.includes('--demo') }), 'StudyDrive.exe');
const results = [];
let app;
let window;
let profile;
let mainProcessId;

function pass(message) {
  results.push(message);
  console.log('PASS ' + message);
}
async function start() {
  app = await electron.launch({
    executablePath, args: ['--demo', '--test-driver'], cwd: root,
    env: { ...process.env, STUDY_DRIVER: '1', STUDY_TEST_PROFILE: profile },
    timeout: 25000
  });
  window = await app.firstWindow({ timeout: 15000 });
  window.on('pageerror', error => console.log('RENDERER ERROR ' + error.message));
  await window.getByRole('heading', { name: '首页' }).waitFor();
  assert.equal(await window.title(), '课盘 ' + require('../package.json').version);
  mainProcessId = await app.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    if (!p.sandbox || !p.contextIsolation || p.nodeIntegration) throw Error('Unexpected webPreferences');
    return process.pid;
  });
  assert.deepEqual(await window.evaluate(() => [typeof globalThis.require, typeof globalThis.process, typeof window.study]), ['undefined', 'undefined', 'object']);
  await window.getByText('演示账户').waitFor();
  return window;
}
async function nav(name) { await window.locator('#nav').getByRole('button', { name, exact: true }).click(); }
async function screenshot(name) { await window.screenshot({ path: path.join(outputs, name + '.png') }); }
async function ready() {
  await window.locator('[data-player="mpv"][data-ready="true"]').waitFor();
}
async function value(property) {
  return app.evaluate((_, name) => globalThis.studyTest.player()?.[name], property);
}
async function near(property, expected, tolerance = .4) {
  await window.waitForFunction(({ property, expected, tolerance }) => {
    const media = document.querySelector('[data-player="mpv"]')?.dataset;
    return media?.seeking === 'false' && Math.abs(Number(media[property]) - expected) <= tolerance;
  }, { property, expected, tolerance }, { timeout: 10000 });
}
async function stats() { return app.evaluate(() => JSON.parse(JSON.stringify(globalThis.studyTest.mock))); }
async function chooseFiles(paths) {
  await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, paths);
}
async function close() {
  await app.close();
  app = null;
}

async function documents(runDir) {
  const click = name => window.getByRole('button', { name, exact: true }).click();
  const fileRow = name => window.getByRole('button', { name, exact: true });
  const back = () => click('返回');
  const recentPanel = () => window.locator('.home-section').filter({ has: window.getByRole('heading', { name: '最近浏览' }) });
  const docFolder = async () => {
    await nav('全部文件');
    if (await window.getByRole('navigation', { name: '文件夹路径' }).getByRole('button', { name: '全部文件', exact: true }).count()) {
      await window.getByRole('navigation', { name: '文件夹路径' }).getByRole('button', { name: '全部文件', exact: true }).click();
    }
    await click('文档预览示例');
  };
  const pdf = async page => {
    await window.getByLabel('PDF 第 ' + page + ' 页').waitFor();
    await window.waitForFunction(() => {
      const canvas = document.querySelector('.pdf-paper canvas');
      return canvas && canvas.getContext('2d').getImageData(10, 10, 1, 1).data[3] > 0;
    });
  };
  const stored = (item, view, field, expected) => window.waitForFunction(async ({ item, view, field, expected }) => {
    const row = (await window.study.library()).recent.find(row => row.item.id === item);
    return row?.positions?.[view]?.[field] === expected;
  }, { item, view, field, expected });

  await nav('全部文件');
  await app.evaluate(() => {
    const mock = globalThis.studyTest.mock;
    mock.pendingConversions.office = 1;
    mock.expireNextConversion = true;
  });
  const word = '课程计划.docx';
  await fileRow(word).focus();
  await fileRow(word).press('Enter');
  await window.getByText('正在等待 OneDrive 转换为 PDF…').waitFor();
  await pdf(1);
  const page = window.getByLabel('PDF 页码');
  await page.fill('2');
  await page.press('Enter');
  await pdf(2);
  const initialSize = await window.locator('.pdf-paper canvas').evaluate(node => node.style.width);
  await click('放大');
  await window.waitForFunction(width => document.querySelector('.pdf-paper canvas').style.width !== width, initialSize);
  await click('全屏');
  await window.waitForFunction(() => !!document.fullscreenElement);
  await window.evaluate(() => document.exitFullscreen());
  await stored('office', 'pdf', 'page', 2);
  await screenshot('preview-pdf');
  await window.keyboard.press('Escape');
  await fileRow(word).waitFor();
  assert.equal(await fileRow(word).evaluate(node => node === document.activeElement), true);
  await nav('首页');
  await recentPanel().getByRole('button', { name: word, exact: true }).click();
  await pdf(2);
  await back();
  await app.evaluate(() => globalThis.studyTest.mock.bumpVersion('office'));
  await recentPanel().getByRole('button', { name: word, exact: true }).click();
  await pdf(1);
  const graph = await stats();
  const conversions = graph.conversions.filter(row => row.path === '/v1.0/drives/study-drive-demo/items/office/content?format=pdf');
  assert.ok(conversions.length >= 4);
  assert.equal(new Set(conversions.map(row => row.version)).size, 2);
  assert.equal(graph.convertedExpired, 1);
  assert.ok(graph.convertedDownloads >= 3);
  await back();
  pass('DOCX PDF jump, zoom, fullscreen, Escape focus, Home page restore, 202 wait, expired 302 renewal and fresh conversion for new version');

  await docFolder();
  const ppt = '中文课程演示.ppt';
  const doc = '中文课程计划.doc';
  const modern = '课程演示.pptx';
  await app.evaluate(({ shell }) => {
    globalThis.openedExternalFixture = '';
    shell.openExternal = async url => { globalThis.openedExternalFixture = url; };
    globalThis.studyTest.mock.conversionStatus.ppt = 400;
  });
  await fileRow(ppt).locator('xpath=ancestor::tr').getByRole('cell').nth(2).dblclick();
  const error = window.getByRole('alert');
  await error.getByText('OneDrive 无法转换此文档，文件可能已加密、损坏或格式不受支持。').waitFor();
  assert.equal((await window.evaluate(() => window.study.library())).recent.some(row => row.item.id === 'ppt'), false);
  await error.getByRole('button', { name: '在 OneDrive 打开', exact: true }).click();
  assert.equal(await app.evaluate(() => globalThis.openedExternalFixture), 'https://onedrive.live.com/');
  const original = path.join(runDir, 'original.ppt');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, original);
  await error.getByRole('button', { name: '下载原件', exact: true }).click();
  await window.getByText('已加入下载队列').waitFor();
  await app.evaluate(() => { globalThis.studyTest.mock.conversionStatus.ppt = 0; });
  await error.getByRole('button', { name: '重试' }).click();
  await pdf(1);
  await back();
  for (const name of [doc, modern]) {
    await click(name);
    await pdf(1);
    await back();
  }
  await nav('传输');
  await window.locator('.transfer-row[data-state="done"]').filter({ hasText: ppt }).waitFor();
  assert.deepEqual(await fs.readFile(original), await fs.readFile(path.join(root, 'fixtures', 'fixture.ppt')));
  pass('legacy Chinese DOC and PPT and PPTX opened via simulated Graph; failed preview excluded from history; retry, OneDrive handoff and byte-identical original download');

  await nav('全部文件');
  await click('课程成绩.xlsx');
  await window.getByRole('gridcell', { name: '000172', exact: true }).waitFor();
  await window.getByRole('gridcell', { name: /^2026-/ }).waitFor();
  await window.getByRole('gridcell', { name: '92', exact: true }).click();
  await window.waitForFunction(() => document.querySelector('.sheet-formula input').value === '=C2+10');
  await click('复制单元格');
  await window.getByText('已复制单元格').waitFor();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), '92');
  await window.getByLabel('活动工作表').selectOption({ label: '课程明细' });
  const cellSearch = window.getByRole('searchbox', { name: '查找单元格' });
  await cellSearch.fill('教学目标');
  await cellSearch.press('Enter');
  await window.getByRole('gridcell', { name: '教学目标定位' }).waitFor();
  const scroll = () => window.getByRole('grid').evaluate(node => [node.scrollTop, node.scrollLeft]);
  const location = await scroll();
  assert.ok(location[0] > 1200 && location[1] > 1500);
  assert.ok(await window.getByRole('gridcell').count() < 300);
  await stored('xlsx', 'sheet', 'col', 15);
  await screenshot('preview-sheet');
  await click('页面视图');
  await pdf(1);
  await click('下一页');
  await pdf(2);
  await stored('xlsx', 'pdf', 'page', 2);
  await click('工作表视图');
  await window.getByRole('gridcell', { name: '教学目标定位' }).waitFor();
  assert.deepEqual(await scroll(), location);
  await back();
  for (const name of ['旧成绩表.xls', '带宏格式.xlsm', '开放表格.ods']) {
    await click(name);
    await window.getByRole('gridcell', { name: '000172', exact: true }).waitFor();
    await back();
  }
  await click('学号名单.csv');
  await window.getByRole('gridcell', { name: '000123', exact: true }).waitFor();
  await window.getByLabel('文本编码').selectOption('utf-8');
  await window.getByLabel('分隔符').selectOption(',');
  await window.getByRole('gridcell', { name: '000009', exact: true }).waitFor();
  await back();
  await click('学号分隔表.tsv');
  await window.getByRole('gridcell', { name: '000007', exact: true }).waitFor();
  await back();
  pass('XLSX dates, cached formula and clipboard, virtual sheet search and two-axis scroll restoration, PDF page view, XLS/XLSM/ODS, CSV/TSV zeros');

  await click('旧中文文本.txt');
  await window.getByText(/自动识别 GB18030/).waitFor();
  await window.getByLabel('文本编码').selectOption('gbk');
  await window.getByText('中文测试', { exact: true }).waitFor();
  await click('自动换行');
  assert.equal(await fileRow('自动换行').getAttribute('aria-pressed'), 'false');
  const textSearch = window.getByRole('searchbox', { name: '查找文字' });
  await textSearch.fill('TARGET LINE');
  await textSearch.press('Enter');
  await window.locator('.found-line').getByText('TARGET LINE 225').waitFor();
  await stored('gbk', 'text', 'line', 224);
  await back();
  await click('旧中文文本.txt');
  await window.getByText('TARGET LINE 225', { exact: true }).waitFor();
  assert.equal(await window.getByLabel('文本编码').inputValue(), 'gbk');
  await back();
  await click('课程导航.md');
  const toc = window.getByRole('navigation', { name: '标题目录' });
  await window.getByRole('table').getByText('已上传').waitFor();
  assert.match(await window.locator('.markdown-reader pre').innerText(), /仅供阅读/);
  assert.equal(await window.locator('.markdown-reader strong').count(), 0);
  await window.waitForFunction(() => document.querySelector('.markdown-reader img')?.naturalWidth > 0);
  assert.deepEqual((await stats()).relativeImages, ['课程图片.png']);
  await window.getByText('外部图片（未加载）').waitFor();
  await screenshot('preview-markdown');
  await click('源码');
  await window.locator('.line-content').getByText('# 课程导航', { exact: true }).waitFor();
  await click('排版');
  await toc.getByRole('button', { name: '第二章笔记' }).click();
  await stored('markdown', 'markdown', 'heading', 2);
  await back();
  await click('课程导航.md');
  await window.waitForFunction(() => {
    const heading = [...document.querySelectorAll('.markdown-reader h2')].find(node => node.textContent === '第二章笔记');
    return heading && Math.abs(heading.getBoundingClientRect().top - heading.parentElement.getBoundingClientRect().top) < 48;
  });
  await back();
  pass('GBK decode, word wrap, search and line restore; Markdown table, code, inert HTML, same-folder PNG, blocked external image and heading restore');

  await close();
  await start();
  await recentPanel().getByRole('button', { name: '课程成绩.xlsx', exact: true }).click();
  await window.getByRole('gridcell', { name: '教学目标定位' }).waitFor();
  assert.deepEqual(await scroll(), location);
  await click('页面视图');
  await pdf(2);
  await back();
  const plain = await fs.readFile(path.join(profile, 'library.json'), 'utf8');
  assert.doesNotMatch(plain, /https?:\/\/|mock-account|\/cdn\/|\/media\//);
  pass('new Windows process restored saved worksheet and PDF page from Home; history contains no signed link, local capability or authorization');
}

async function run() {
  await fs.mkdir(outputs, { recursive: true });
  const runDir = await fs.mkdtemp(path.join(outputs, 'run-'));
  profile = path.join(runDir, 'profile');
  await fs.mkdir(profile);
  await start();
  pass('Windows Electron sandboxed window, process ' + mainProcessId + ', Home and local account');
  await nav('全部文件');
  await window.getByRole('button', { name: '参考资料', exact: true }).click();
  await window.getByRole('button', { name: '资料归档 01.txt', exact: true }).waitFor();
  await window.getByRole('button', { name: '加载更多' }).click();
  await window.getByRole('button', { name: '资料归档 16.txt', exact: true }).waitFor();
  const search = window.getByRole('searchbox', { name: '搜索网盘文件' });
  await search.fill('函数图像');
  await search.press('Enter');
  await window.getByRole('heading', { name: '搜索结果' }).waitFor();
  await window.getByLabel('文件类型').selectOption('image');
  await window.getByText('当前列表没有符合条件的项目。').waitFor();
  await window.getByLabel('文件类型').selectOption('video');
  const first = '01 · 函数图像与变化.mp4';
  await window.getByRole('button', { name: first, exact: true }).waitFor();
  await window.getByLabel('排序方式').selectOption('largest');
  await window.getByRole('button', { name: first, exact: true }).waitFor();
  pass('Graph-shaped mock browsing, pagination, search, type filter and sort');

  await search.fill('高等数学');
  await search.press('Enter');
  await window.getByRole('button', { name: '高等数学', exact: true }).click();
  await window.getByRole('button', { name: '课后练习 的操作' }).click();
  await window.getByRole('button', { name: '收藏目录' }).click();
  await window.getByRole('button', { name: '新建文件夹' }).click();
  await window.getByLabel('文件夹名称').fill('E2E 新目录');
  await window.getByRole('button', { name: '新建', exact: true }).click();
  await window.getByRole('button', { name: 'E2E 新目录 的操作' }).click();
  await window.getByRole('button', { name: '重命名' }).click();
  await window.getByLabel('名称', { exact: true }).fill('E2E 已改名');
  await window.getByRole('button', { name: '保存' }).click();
  await window.getByRole('button', { name: 'E2E 已改名', exact: true }).waitFor();
  await screenshot('files');
  pass('create folder, rename, favorite and path navigation');

  await app.evaluate(() => { globalThis.studyTest.mock.omitDownloadUrl = true; });
  await window.getByRole('button', { name: first, exact: true }).click();
  await ready();
  assert.ok(await value('duration') >= 81);
  assert.equal(await value('embedded'), true);
  await window.locator('.player-stage').press('ArrowRight');
  await near('time', 5);
  await window.locator('.player-stage').press('ArrowLeft');
  await near('time', 0);
  await window.getByLabel('播放倍速').selectOption('1.75');
  await near('rate', 1.75, .001);
  await window.locator('.player-stage').press('ArrowRight');
  await near('time', 5);
  const resume = await value('time');
  await screenshot('player-controls');
  await nav('首页');
  await window.getByRole('button', { name: '继续观看', exact: true }).click();
  await ready();
  await near('time', resume);
  await near('rate', 1.75, .001);
  await nav('首页');
  await window.locator('.home-section').filter({ has: window.getByRole('heading', { name: '收藏课程目录' }) }).getByRole('button', { name: '课后练习' }).waitFor();
  await screenshot('home');
  await close();
  await start();
  await window.getByRole('button', { name: '继续观看', exact: true }).click();
  await ready();
  await near('time', resume);
  await near('rate', 1.75, .001);
  pass('mpv H.264/AAC Range and Home reopen, including persisted position and rate in a fresh process');

  await nav('全部文件');
  await window.getByRole('button', { name: '高等数学', exact: true }).click();
  await window.getByRole('button', { name: '02 · 图像的平移.mp4', exact: true }).click();
  await ready();
  await near('time', 0, .25);
  await near('rate', 1.75, .001);
  await window.getByRole('button', { name: '返回' }).click();
  await window.getByRole('button', { name: '课后复习音频.m4a', exact: true }).click();
  await ready();
  assert.ok(await value('duration') > 14);
  await window.getByRole('button', { name: '返回' }).click();
  await window.getByRole('button', { name: '函数草图.png', exact: true }).click();
  await window.waitForFunction(() => document.querySelector('.document-preview img')?.naturalWidth > 0);
  await window.getByRole('button', { name: '返回' }).click();
  await window.getByRole('button', { name: '第一章讲义.pdf', exact: true }).click();
  await window.getByLabel('PDF 第 1 页').waitFor();
  await window.waitForFunction(() => {
    const canvas = document.querySelector('canvas');
    return canvas && canvas.getContext('2d').getImageData(canvas.width / 2, 15, 1, 1).data[3] > 0;
  });
  await window.getByRole('button', { name: '下一页' }).click();
  await window.getByLabel('PDF 第 2 页').waitFor();
  pass('second video, AAC audio, PNG image, rendered PDF canvas and page navigation');

  await window.getByRole('button', { name: '返回' }).click();
  const saved = path.join(runDir, 'downloaded.txt');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, saved);
  await nav('全部文件');
  await window.getByRole('button', { name: '全部文件', exact: true }).last().click();
  await window.getByRole('button', { name: '下载 阅读清单.txt', exact: true }).click();
  await nav('传输');
  await window.locator('.transfer-row').filter({ hasText: '阅读清单.txt' }).filter({ hasText: '已完成' }).waitFor();
  assert.deepEqual(await fs.readFile(saved), await fs.readFile(path.join(root, 'fixtures', 'reading.txt')));
  const large = path.join(runDir, 'large.bin');
  const small = path.join(runDir, '阅读清单.txt');
  await fs.writeFile(large, Buffer.alloc(chunkSize + 180000, 27));
  await fs.writeFile(small, 'new data');
  await chooseFiles([large, small]);
  await app.evaluate((_, offset) => { globalThis.studyTest.mock.failAt = offset; }, chunkSize);
  await window.getByRole('button', { name: '上传文件', exact: true }).click();
  await window.locator('.transfer-row').filter({ hasText: 'large.bin' }).filter({ hasText: '失败' }).waitFor();
  await window.locator('.transfer-row[data-state="done"]').filter({ hasText: '阅读清单.txt' }).last().waitFor();
  const beforeRestart = await stats();
  assert.ok(beforeRestart.uploadOffsets.includes(chunkSize));
  await close();
  await start();
  await nav('传输');
  await window.locator('.transfer-row').filter({ hasText: 'large.bin' }).getByRole('button', { name: '重试' }).click();
  await window.locator('.transfer-row[data-state="done"]').filter({ hasText: 'large.bin' }).waitFor();
  const afterRestart = await stats();
  assert.equal(afterRestart.uploadStatusReads, 1);
  assert.deepEqual(afterRestart.uploadOffsets, [chunkSize]);
  await screenshot('transfers');
  await nav('全部文件');
  await window.getByRole('button', { name: '阅读清单.txt', exact: true }).waitFor();
  await window.getByRole('button', { name: '阅读清单 (1).txt', exact: true }).waitFor();
  pass('download byte equality, multiselect upload, duplicate rename and cross-process resume from ' + chunkSize + ' bytes');

  const canceled = path.join(runDir, 'cancel.bin');
  await fs.writeFile(canceled, Buffer.alloc(chunkSize + 100, 13));
  await chooseFiles([canceled]);
  await app.evaluate((_, offset) => { globalThis.studyTest.mock.failAt = offset; }, chunkSize);
  await window.getByRole('button', { name: '上传文件', exact: true }).click();
  const interrupted = window.locator('.transfer-row').filter({ hasText: 'cancel.bin' });
  await interrupted.filter({ hasText: '失败' }).waitFor();
  await interrupted.getByRole('button', { name: '取消', exact: true }).click();
  await interrupted.filter({ hasText: '已取消' }).waitFor();
  assert.equal((await stats()).canceled, 1);
  await interrupted.getByRole('button', { name: '重试' }).click();
  await interrupted.filter({ hasText: '已完成' }).waitFor();
  assert.deepEqual((await stats()).uploadOffsets.slice(-2), [0, chunkSize]);
  pass('cancel deleted a resumable upload session and explicit retry started a fresh upload');

  await nav('首页');
  await window.getByRole('button', { name: '移除浏览记录' }).first().click();
  const recent = window.locator('.home-section').filter({ has: window.getByRole('heading', { name: '最近浏览' }) });
  await recent.getByRole('button', { name: '清空' }).click();
  await window.locator('dialog').getByRole('button', { name: '清空', exact: true }).click();
  await recent.getByText('暂无浏览记录').waitFor();
  const plain = await fs.readFile(path.join(profile, 'library.json'), 'utf8');
  assert.doesNotMatch(plain, /https?:\/\/|mock-account|\/cdn\/|\/upload\//);
  pass('history removal and clear, no signed URL or token in library data');
  await documents(runDir);
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (process.exitCode && window && app) {
    await screenshot('failure').catch(() => {});
    console.log('FAILURE WINDOW ' + await window.locator('body').innerText().then(s => s.slice(0, 1000)).catch(() => 'unavailable'));
    console.log('FAILURE MEDIA ' + await app.evaluate(() => globalThis.studyTest.player()).then(JSON.stringify).catch(() => 'unavailable'));
    await fs.writeFile(path.join(outputs, 'windows-evidence.txt'), results.join('\n') + '\nFAILED\n');
  }
  if (app) await close().catch(() => {});
  if (!process.exitCode) await fs.writeFile(path.join(outputs, 'windows-evidence.txt'), results.join('\n') + '\n');
});
