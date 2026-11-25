const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { directoryBuild } = require('../scripts/build-paths.cjs');
const { startMock } = require('../src/mock.cjs');
const { Drive, itemInfo } = require('../src/drive.cjs');
const { Store } = require('../src/store.cjs');
const { version } = require('../package.json');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results', 'assets-' + version);
const rows = [
  ['exercises', '01 课程笔记', 'folder.svg'],
  ['pdf', '02 课堂讲义.pdf', 'pdf.svg'],
  ['doc', '03 实验计划.doc', 'word.svg'],
  ['pptx', '04 课程演示.pptx', 'slides.svg'],
  ['xlsx', '05 课程成绩.xlsx', 'sheet.svg'],
  ['gbk', '06 阅读说明.txt', 'text.svg'],
  ['audio', '07 课后音频.m4a', 'audio.svg'],
  ['lesson', '08 习题视频.mp4', 'video.svg'],
  ['inlineImage', '09 课程插图.png', 'image.svg']
];

async function seed(profile) {
  const mock = await startMock(profile, path.join(root, 'fixtures'));
  let account;
  try {
    account = await new Drive({ base: mock.base, credentials: { access: 'mock-account' }, mock: true }).identity();
  } finally { await new Promise(resolve => mock.server.close(resolve)); }
  const file = path.join(profile, 'demo-files', 'mock.json');
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const item of state.items) if (item.parentId === 'documents') item.parentId = 'reference';
  for (const [id, name] of rows) Object.assign(state.items.find(item => item.id === id), { name, parentId: 'documents' });
  await fs.writeFile(file, JSON.stringify(state));
  const item = id => {
    const entry = state.items.find(item => item.id === id);
    return itemInfo({ ...entry, parentReference: { id: entry.parentId } }, account.driveId);
  };
  const store = new Store(profile);
  for (const id of ['gbk', 'pptx', 'pdf']) store.touch(account.id, item(id));
  store.watch(account.id, item('lesson'), 12, 82);
  for (const id of ['reference', 'documents']) store.favorite(account.id, item(id));
}

async function resize(app, page, width, height) {
  await app.evaluate(({ BrowserWindow }, [width, height]) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setContentSize(width, height);
    const [actualWidth, actualHeight] = win.getContentSize();
    if (actualWidth !== width || actualHeight !== height) win.setContentSize(2 * width - actualWidth, 2 * height - actualHeight);
  }, [width, height]);
  await page.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height, [width, height]);
}

async function checkIcons(page) {
  const icons = page.locator('img.asset-icon:visible');
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('img.asset-icon')].filter(node => node.getBoundingClientRect().width > 0);
    return images.length > 0 && images.every(node => node.complete && node.naturalWidth > 0);
  });
  const result = await icons.evaluateAll(images => images.map(img => {
    const rect = img.getBoundingClientRect();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 40;
    const context = canvas.getContext('2d');
    context.drawImage(img, 0, 0, 40, 40);
    const rgba = context.getImageData(0, 0, 40, 40).data;
    return { source: img.getAttribute('src'), fit: getComputedStyle(img).objectFit,
      square: rect.width === rect.height && img.naturalWidth === img.naturalHeight,
      decorative: img.alt === '' && img.getAttribute('aria-hidden') === 'true',
      artwork: rgba.some((value, index) => index % 4 === 3 && value > 120),
      // The source star carries a 1% alpha rectangle. It has no visible plate.
      transparent: rgba[3] <= 3 && rgba.at(-1) <= 3 };
  }));
  assert.ok(result.every(row => row.source.startsWith('./icons/') && row.fit === 'contain' && row.square && row.decorative && row.artwork && row.transparent),
    JSON.stringify(result.filter(row => !(row.square && row.artwork && row.transparent))));
  return new Set(result.map(row => row.source));
}

async function run() {
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(output, 'profile-'));
  await seed(profile);
  const app = await electron.launch({
    executablePath: path.join(directoryBuild(root, version, { office: true }), 'StudyDrive.exe'),
    args: ['--demo', '--test-driver'],
    env: { ...process.env, STUDY_DRIVER: '1', STUDY_TEST_PROFILE: profile },
    cwd: root
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(12000);
    const button = name => page.getByRole('button', { name, exact: true });
    const nav = name => page.locator('#nav').getByRole('button', { name, exact: true });
    await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
    assert.equal(await page.title(), '课盘 ' + version);
    const examples = page.locator('#home-files').getByRole('button', { name: '文档预览示例', exact: true });
    await examples.waitFor();
    await resize(app, page, 1440, 820);
    const home = await checkIcons(page);
    assert.ok(['recent.svg', 'favorite.svg', 'video.svg', 'tools.svg', 'transfer.svg'].every(file => home.has('./icons/' + file)));
    await page.screenshot({ path: path.join(output, 'home-1440.png'), scale: 'css' });
    console.log('PASS packaged Home icons use local transparent assets, original StudyDrive identity and controls');

    await app.evaluate(() => { globalThis.studyTest.mock.listDelay = 1800; });
    await examples.click();
    const loading = page.locator('.asset-loading');
    await loading.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('.asset-loading')?.naturalWidth === 54);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loading.waitFor({ state: 'hidden' });
    assert.ok(await page.getByText('正在读取文件…', { exact: true }).isVisible());
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await button(rows.at(-1)[1]).waitFor();
    await app.evaluate(() => { globalThis.studyTest.mock.listDelay = 0; });
    for (const [, name, file] of rows) {
      assert.equal(await button(name).locator('img').getAttribute('src'), './icons/' + file);
    }
    for (const [width, height] of [[1440, 1020], [860, 700]]) {
      await resize(app, page, width, height);
      const icons = await checkIcons(page);
      assert.ok(rows.every(([, , file]) => icons.has('./icons/' + file)));
      assert.ok(await page.locator('#content').evaluate(node => node.scrollWidth === node.clientWidth));
      await page.screenshot({ path: path.join(output, 'files-' + width + '.png'), scale: 'css' });
      console.log('PASS file icons at ' + width + ' CSS px have correct role, alpha, size and aspect ratio');
    }
    await button('03 实验计划.doc').press('Enter');
    await page.waitForFunction(() => document.querySelector('.pdf-paper canvas')?.getContext('2d').getImageData(10, 10, 1, 1).data[3] > 0);
    await page.keyboard.press('Escape');
    await button('03 实验计划.doc').waitFor();
    assert.equal(await nav('知识库').count(), 0);
    {
      const name = '工具';
      await nav(name).press('Enter');
      await page.getByRole('heading', { name, exact: true }).waitFor();
      await page.getByText('正在施工', { exact: true }).waitFor();
      assert.equal(await nav(name).getAttribute('aria-current'), 'page');
      await button('返回首页').click();
      await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
    }
    assert.doesNotMatch(await page.locator('#shell').innerText(), /库库AI|消息|团队空间|会员中心|¥0\.08/);
    console.log('PASS loading and reduced-motion behavior, mock DOC preview, and keyboard entry to Tools');
  } finally { await app.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
