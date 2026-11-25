const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { startMock } = require('../src/mock.cjs');
const { directoryBuild } = require('../scripts/build-paths.cjs');
const { version } = require('../package.json');

const root = path.resolve(__dirname, '..');
const output = process.env.STUDY_TEST_RESULTS || path.join(root, 'test-results', 'search-' + version);
const title = '2027考研数学强化_%[X].pdf';

async function run() {
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(output, 'demo-'));
  const mock = await startMock(profile, path.join(root, 'fixtures'));
  await new Promise(resolve => mock.server.close(resolve));
  const file = path.join(profile, 'demo-files', 'mock.json');
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  const seed = data.items.find(item => item.id === 'pdf');
  const directory = data.items.find(item => item.id === 'exercises');
  data.items.push({ ...seed, id: 'deep-math', name: title, parentId: 'exercises' },
    { ...directory, id: 'song-prefix', name: '宋浩线代讲义' },
    { ...directory, id: 'song-middle', name: '2027考研宋浩全程班' },
    { ...seed, id: 'song-unrelated', name: '基础线代课01（手写板书）.pdf', description: '宋浩', parentId: 'exercises' },
    ...Array.from({ length: 70 }, (_, i) => ({ ...seed, id: 'search-' + i, name: '验收资料 ' + String(i).padStart(2, '0') + (i < 5 ? '.mp4' : '.pdf'),
      size: i + 1, parentId: 'reference' })));
  await fs.writeFile(file, JSON.stringify(data));

  const app = await electron.launch({
    executablePath: path.join(directoryBuild(root, version, { office: true }), 'StudyDrive.exe'),
    args: ['--demo', '--test-driver'], cwd: root,
    env: { ...process.env, STUDY_DRIVER: '1', STUDY_TEST_PROFILE: profile }
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(13000);
    const button = name => page.getByRole('button', { name, exact: true });
    const nav = name => page.locator('#nav').getByRole('button', { name, exact: true });
    const search = page.getByRole('searchbox');
    const status = page.locator('#index-status');
    const target = page.getByRole('button', { name: title, exact: true });
    const completed = () => status.filter({ hasText: '索引已更新' }).waitFor();
    await page.getByRole('heading', { name: '首页' }).waitFor();
    assert.equal(await page.locator('#build-version').innerText(), version);
    assert.equal(await page.title(), '课盘 ' + version);
    await completed();
    await search.fill('宋浩');
    await button('宋浩线代讲义').waitFor();
    await button('2027考研宋浩全程班').waitFor();
    assert.equal(await page.locator('[data-file-id]').count(), 2);
    await page.screenshot({ path: path.join(output, 'songhao-all.png') });
    const categories = page.getByRole('group', { name: '文件分类' });
    await categories.getByRole('button', { name: '文件夹', exact: true }).click();
    await page.locator('.file-table-panel[aria-busy="false"]').waitFor();
    assert.equal(await page.locator('[data-file-id]').count(), 2);
    assert.equal(await button('基础线代课01（手写板书）.pdf').count(), 0);
    await page.screenshot({ path: path.join(output, 'songhao-folders.png') });
    await categories.getByRole('button', { name: '全部', exact: true }).click();
    await search.fill('数学     强化 _%[x]');
    await target.waitFor();
    assert.match(await page.locator('.selection-summary').innerText(), /共 1 项/);
    await page.getByRole('button', { name: '打开所在文件夹 /高等数学/课后练习' }).waitFor();
    const boot = await app.evaluate(({ app }) => {
      const fs = process.getBuiltinModule('node:fs'), path = process.getBuiltinModule('node:path');
      const index = path.join(app.getPath('userData'), 'drive-index.sqlite');
      const db = new (process.getBuiltinModule('node:sqlite').DatabaseSync)(index, { readOnly: true });
      try {
        const fts = db.prepare('SELECT count(*) n FROM names WHERE names MATCH ?').get('考研数学').n;
        const fields = db.prepare('PRAGMA table_info(files)').all().map(row => row.name);
        return {
          electron: process.versions.electron, sqlite: db.prepare('SELECT sqlite_version() v').get().v,
          fts, fields, graphSearches: globalThis.studyTest.mock.listRequests.filter(row => row.id === 'search').length,
          visitedDeep: globalThis.studyTest.mock.listRequests.some(row => row.id === 'exercises'),
          deltaPages: globalThis.studyTest.mock.deltaRequests.length
        };
      } finally { db.close(); }
    });
    assert.ok(boot.fts > 0 && boot.deltaPages > 1 && !boot.visitedDeep && !boot.graphSearches);
    assert.ok(!boot.fields.some(field => /token|download/i.test(field)));
    await page.screenshot({ path: path.join(output, 'global-search.png') });
    await page.getByRole('button', { name: '打开所在文件夹 /高等数学/课后练习' }).click();
    await page.getByRole('heading', { name: '课后练习' }).waitFor();
    await search.fill('数学');
    await target.waitFor();
    await page.getByLabel('搜索范围').selectOption('folder');
    await page.locator('.selection-summary').getByText(/共 1 项/).waitFor();
    await page.getByLabel('搜索范围').selectOption('');
    await search.fill('验收资料');
    await page.getByLabel('文件类型').selectOption('pdf');
    await page.getByLabel('排序方式').selectOption('largest');
    await page.locator('.selection-summary').getByText(/共 65 项 · 已加载 50 项/).waitFor();
    await page.locator('.file-table').getByRole('button', { name: '验收资料 69.pdf', exact: true }).waitFor();
    await button('加载更多').click();
    await page.locator('.selection-summary').getByText(/共 65 项 · 已加载 65 项/).waitFor();
    await search.fill('数学 强化');
    await target.waitFor();
    await button(title + ' 的操作').click();
    await button('重命名').click();
    const renamed = '2027考研数学强化验收.pdf';
    await page.getByRole('dialog').getByRole('textbox').fill(renamed);
    await button('保存').click();
    await button(renamed).waitFor();
    await button(renamed + ' 的操作').click();
    await button('移动到…').click();
    await page.getByRole('dialog').getByRole('button', { name: '参考资料', exact: true }).click();
    await button('移到这里').click();
    await page.getByRole('button', { name: '打开所在文件夹 /参考资料', exact: true }).waitFor();
    await button(renamed + ' 的操作').click();
    await button('删除…').click();
    await button('移到回收站').click();
    await button(renamed).waitFor({ state: 'hidden' });
    await page.getByText('未找到匹配项', { exact: true }).waitFor();
    await nav('全部文件').click();
    await button('新建文件夹').click();
    await page.getByRole('dialog').getByRole('textbox').fill('本地索引新建验收');
    await page.getByRole('dialog').getByRole('button', { name: '新建', exact: true }).click();
    await page.getByText('已新建文件夹', { exact: true }).waitFor();
    await search.fill('索引新建');
    await button('本地索引新建验收').waitFor();
    const local = path.join(profile, '索引上传验收.txt');
    await fs.writeFile(local, 'fixture-only');
    await app.evaluate(({ dialog }, local) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [local] }); }, local);
    await button('上传文件').click();
    await page.getByRole('heading', { name: '传输', exact: true }).waitFor();
    await page.getByText('已完成', { exact: true }).last().waitFor();
    await search.fill('索引上传');
    await button('索引上传验收.txt').waitFor();
    await search.fill('资料');
    await nav('工具').click();
    await page.getByRole('heading', { name: '工具', exact: true }).waitFor();
    assert.equal(await nav('知识库').count(), 0);
    assert.equal(await page.getByRole('heading', { name: '搜索结果', exact: true }).count(), 0);
    assert.equal(await search.inputValue(), '');
    const message = 'PASS Windows quick-start EXE ' + version + '; ' + JSON.stringify(boot) +
      '; Song Hao prefix and middle in all/folders, exact filename-only search, path action, 50-item paging and local mutations.';
    console.log(message);
    await fs.writeFile(path.join(output, 'quick-start-evidence.txt'), message + '\n');
  } finally { await app.close(); }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
