const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { startMock } = require('../src/mock.cjs');
const { directoryBuild } = require('../scripts/build-paths.cjs');
const { version } = require('../package.json');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results', 'integrated-' + version);
const executablePath = path.join(directoryBuild(root, version, { office: true }), 'StudyDrive.exe');
const label = n => '资料 ' + String(n).padStart(5, '0') + '.txt';

async function run() {
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(output, 'demo-'));
  const mock = await startMock(profile, path.join(root, 'fixtures'));
  await new Promise(resolve => mock.server.close(resolve));
  const fixture = path.join(profile, 'demo-files', 'mock.json');
  const data = JSON.parse(await fs.readFile(fixture, 'utf8'));
  const base = data.items.find(item => item.id === 'root');
  const text = data.items.find(item => item.id === 'text');
  data.items.push({ ...base, id: 'large', name: '万条验收目录', parentId: 'root' });
  for (let i = 1; i <= 10000; i += 1) data.items.push({ ...text, id: 'large-' + i, name: label(i),
    size: i === 4 ? text.size * 2 : text.size, parentId: 'large' });
  await fs.writeFile(fixture, JSON.stringify(data));
  const app = await electron.launch({ executablePath, args: ['--demo', '--test-driver'], cwd: root,
    env: { ...process.env, STUDY_DRIVER: '1', STUDY_TEST_PROFILE: profile } });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(24000);
    const button = name => page.getByRole('button', { name, exact: true });
    const checkbox = name => page.getByRole('checkbox', { name: '选择 ' + name, exact: true });
    const nav = name => page.locator('#nav').getByRole('button', { name, exact: true }).click();
    const back = async () => { await button('返回').click(); await page.locator('.preview-header').waitFor({ state: 'hidden' }); };
    const count = value => page.locator('.selection-count').filter({ hasText: new RegExp('^' + value + '$') });
    const shot = name => page.screenshot({ path: path.join(output, name), scale: 'css' });
    const rows = n => page.waitForFunction(n => document.querySelector('.file-table')?.getAttribute('aria-rowcount') === String(n + 1), n);
    const changeMock = values => app.evaluate((_, values) => Object.assign(globalThis.studyTest.mock, values), values);
    await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
    const boot = await app.evaluate(({ app }) => {
      const path = process.getBuiltinModule('node:path'), fs = process.getBuiltinModule('node:fs');
      const home = app.getAppPath();
      return { stages: globalThis.studyTest.startupStages,
        office: fs.existsSync(path.join(home, 'node_modules/@deepseek-ai/libreoffice-kit-win32-x64/bin/dsoffice.exe')),
        mpv: fs.existsSync(path.join(home, 'vendor/mpv/libmpv-2.dll')),
        eagerMpv: Object.keys(process.getBuiltinModule('node:module')._cache).some(key => key.endsWith('mpv-session.cjs')) };
    });
    assert.deepEqual(boot.stages, ['正在启动课盘…', '正在准备本地资料…', '正在恢复登录…']);
    assert.ok(boot.office && boot.mpv && !boot.eagerMpv);

    await changeMock({ listDelays: { large: 800 }, listPageSizes: { large: 9900 }, conversionUnavailable: 503 });
    await nav('全部文件');
    await button('万条验收目录').click();
    await page.getByText('正在读取文件…', { exact: true }).waitFor();
    assert.ok(await button('返回上一级').isEnabled());
    assert.ok(await page.getByRole('searchbox').isEnabled());
    await rows(9900);
    await checkbox(label(1)).press('Space');
    await checkbox(label(3)).click({ modifiers: ['Shift'] });
    await button(label(4)).click({ modifiers: ['Control'] });
    await count('已选 4 项').waitFor();
    await page.locator('#content').evaluate(node => { node.scrollTop = 349960; });
    await checkbox(label(5000)).waitFor();
    assert.equal(await checkbox(label(1)).count(), 0);
    await checkbox(label(5000)).click();
    await count('已选 5 项').waitFor();
    await button('加载更多').click();
    await rows(10000);
    await page.getByLabel('排序方式', { exact: true }).selectOption('largest');
    await rows(9900);
    await page.waitForFunction(() => document.querySelector('.file-table tr[data-file-id]')?.dataset.fileId === 'large-4');
    await page.locator('#content').evaluate(node => { node.scrollTop = 0; });
    assert.ok(await checkbox(label(1)).isChecked());
    const actions = button(label(3) + ' 的操作');
    await actions.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await actions.click();
    await button('重命名').click();
    await page.getByRole('dialog').getByRole('textbox').fill('资料 00003 改名.txt');
    await button('保存').click();
    await checkbox('资料 00003 改名.txt').waitFor();
    assert.ok(await checkbox('资料 00003 改名.txt').isChecked());
    await changeMock({ metadataStatuses: { 'large-4': 403 } });
    await button(label(4)).click();
    await page.getByText('OneDrive 拒绝访问。', { exact: true }).waitFor();
    await count('已选 4 项').waitFor();
    await button('刷新当前页面').click();
    await page.getByLabel('正在刷新当前目录', { exact: true }).waitFor({ state: 'hidden' });
    assert.ok(await checkbox(label(1)).isChecked());
    await shot('selection.png');
    const selectAll = page.getByRole('checkbox', { name: '全选已加载项目（当前筛选）' });
    await selectAll.check();
    await count('已选 9900 项').waitFor();
    await button('取消选择').click();
    await checkbox(label(1)).check();
    await changeMock({ accountOwner: { id: 'second-demo', displayName: '演示账户乙' }, metadataStatuses: {} });
    await button('账户设置').click();
    await button('退出本地演示').click();
    await button('打开本地演示').click();
    await page.getByText('演示账户乙', { exact: true }).waitFor();
    await nav('全部文件');
    await button('万条验收目录').click();
    await rows(9900);
    assert.equal(await checkbox(label(1)).isChecked(), false);
    console.log('PASS cold startup stages, responsive delayed directory, keyed selection across virtual scroll/page/sort/refresh, rename, 403 removal, loaded all and isolated demo accounts');

    await button('返回上一级').click();
    async function office(name, capture) {
      await button(name).click();
      await page.getByText('本机转换', { exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector('.pdf-paper canvas')?.getContext('2d').getImageData(10, 10, 1, 1).data[3] > 0);
      if (capture) await shot(capture);
      await back();
    }
    await office('课程计划.docx');
    await button('文档预览示例').click();
    await office('中文课程计划.doc');
    await office('中文课程演示.ppt');
    await office('课程演示.pptx', 'office-local.png');
    for (const name of ['旧成绩表.xls', '课程成绩.xlsx']) {
      await button(name).click();
      await page.getByRole('gridcell', { name: '000172', exact: true }).waitFor();
      if (name.endsWith('xlsx')) {
        assert.ok(await page.getByLabel('活动工作表').isVisible());
        assert.ok(await page.getByLabel('公式或单元格内容').isVisible());
        await page.getByRole('gridcell', { name: '92', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.sheet-formula input')?.value.startsWith('='));
        assert.ok(await button('复制单元格').isEnabled());
        await shot('excel-grid.png');
        await page.getByLabel('活动工作表').selectOption({ label: '课程明细' });
      }
      await back();
    }
    await changeMock({ contentStatuses: { doc: 403 } });
    await checkbox('中文课程计划.doc').check();
    await button('中文课程计划.doc').click();
    await page.getByRole('alert').getByText('OneDrive 拒绝访问。', { exact: true }).waitFor();
    await back();
    assert.equal(await checkbox('中文课程计划.doc').isChecked(), false);
    assert.equal(await app.evaluate(() => globalThis.studyTest.mock.conversions.length), 0);
    console.log('PASS DOC/DOCX/PPT/PPTX render local PDF with Graph disabled, XLS/XLSX grid, denied source never falls back');
    await button('返回上一级').click();
    await button('高等数学').click();
    await button('01 · 函数图像与变化.mp4').click();
    const stage = page.locator('[data-player="mpv"][data-ready="true"]');
    await stage.waitFor();
    assert.ok(await app.evaluate(() => globalThis.studyTest.player()?.embedded));
    await stage.press('Space');
    await page.waitForFunction(() => Number(document.querySelector('.player-stage')?.dataset.time) > 1);
    await back();
    assert.equal(await app.evaluate(() => globalThis.studyTest.player()), null);
    console.log('PASS mpv plays and releases in complete package');
  } finally { await app.close(); }

  const damaged = await fs.mkdtemp(path.join(output, 'startup-'));
  const library = path.join(damaged, 'library.json');
  await fs.writeFile(library, '{invalid fixture');
  const ordinary = await electron.launch({ executablePath, args: ['--user-data-dir=' + damaged], cwd: root });
  try {
    const page = await ordinary.firstWindow();
    await page.getByRole('heading', { name: '课盘启动未完成', exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'startup-retry.png'), scale: 'css' });
    await fs.writeFile(library, JSON.stringify({ active: '', accounts: {}, settings: { rate: 1 } }));
    await page.getByRole('button', { name: '重试启动', exact: true }).click();
    await page.getByRole('heading', { name: '连接 OneDrive 个人版' }).waitFor();
    assert.ok(await page.getByRole('button', { name: '用 Microsoft 登录', exact: true }).isEnabled());
    console.log('PASS actual startup failure converges to actionable retry and then normal disconnected login');
  } finally { await ordinary.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
