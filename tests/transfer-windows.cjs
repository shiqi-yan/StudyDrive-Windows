const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron } = require('playwright');
const { version } = require('../package.json');

const root = path.resolve(__dirname, '..');
const evidence = path.join(root, 'test-results', 'transfer-' + version);
const exe = path.join(root, 'dist', version + '-office', 'StudyDrive.exe');

async function run() {
  await fs.mkdir(evidence, { recursive: true });
  const profile = await fs.mkdtemp(path.join(evidence, 'profile-'));
  const upload = path.join(profile, '整套课程');
  const download = path.join(profile, '接收');
  await fs.mkdir(path.join(upload, '二级', '空文件夹'), { recursive: true });
  await fs.mkdir(download);
  await fs.writeFile(path.join(upload, '二级', '练习.txt'), '仅验收数据');
  const app = await _electron.launch({ executablePath: exe, cwd: root, args: ['--demo', '--test-driver'],
    env: { ...process.env, STUDY_DRIVER: '1', STUDY_TEST_PROFILE: profile }, timeout: 25000 });
  try {
    const page = await app.firstWindow();
    const exact = name => page.getByRole('button', { name, exact: true });
    const nav = name => page.locator('#nav').getByRole('button', { name, exact: true });
    const checkbox = name => page.getByRole('checkbox', { name: '选择 ' + name, exact: true });
    const job = (name, state) => page.locator('.transfer-row' + (state ? '[data-state="' + state + '"]' : '')).filter({
      has: page.locator('.transfer-name strong').getByText(name, { exact: true })
    }).first();
    const setPicker = filename => app.evaluate(({ dialog }, value) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [value] });
    }, filename);
    page.setDefaultTimeout(18000);
    await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
    assert.equal(await page.title(), '课盘 ' + version);
    assert.equal(await nav('知识库').count(), 0);
    await setPicker(upload);
    await exact('上传选项').click();
    await page.getByRole('dialog').getByRole('button', { name: '上传文件夹', exact: true }).click();
    await job('整套课程', 'done').waitFor();
    assert.match(await job('整套课程', 'done').innerText(), /共 4 项 · 完成 4/);

    await nav('全部文件').click();
    await checkbox('整套课程').check();
    await checkbox('阅读清单.txt').check();
    await page.screenshot({ path: path.join(evidence, 'batch-toolbar.png') });
    await setPicker(download);
    await exact('批量下载').click();
    await job('批量下载', 'done').waitFor();
    assert.equal(await fs.readFile(path.join(download, '整套课程', '二级', '练习.txt'), 'utf8'), '仅验收数据');
    assert.ok((await fs.stat(path.join(download, '整套课程', '二级', '空文件夹'))).isDirectory());
    assert.deepEqual(await fs.readFile(path.join(download, '阅读清单.txt')), await fs.readFile(path.join(root, 'fixtures', 'reading.txt')));
    await job('批量下载', 'done').getByRole('button', { name: '查看详情', exact: true }).click();
    await page.getByRole('dialog').getByText('空文件夹', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(evidence, 'group-detail.png') });
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();

    await nav('全部文件').click();
    await checkbox('整套课程').check();
    await checkbox('阅读清单.txt').check();
    await exact('批量移动').click();
    await page.getByRole('dialog').getByRole('button', { name: '参考资料', exact: true }).click();
    await exact('移到这里').click();
    await job('批量移动', 'done').waitFor();

    await nav('全部文件').click();
    await exact('参考资料').click();
    await checkbox('整套课程').check();
    await checkbox('阅读清单.txt').check();
    await exact('批量删除').click();
    await page.getByRole('dialog').getByText(/2 个项目（含 1 个文件夹）/).waitFor();
    await exact('全部移到回收站').click();
    await job('批量删除', 'done').waitFor();

    await nav('回收站').click();
    await page.getByRole('heading', { name: '回收站', exact: true }).waitFor();
    await exact('本机删除记录').click();
    const trash = page.getByRole('table', { name: '已记录的回收站项目' });
    await trash.getByText('整套课程', { exact: true }).waitFor();
    await trash.getByText('阅读清单.txt', { exact: true }).waitFor();
    assert.ok(await trash.getByText('/参考资料', { exact: true }).count() >= 2);
    assert.doesNotMatch(await page.locator('#content').innerText(), /\bnull\b/);
    await page.screenshot({ path: path.join(evidence, 'recycle.png') });
    await checkbox('整套课程').check();
    await checkbox('阅读清单.txt').check();
    await exact('还原所选').click();
    await page.getByRole('dialog').getByRole('button', { name: '还原到原位置', exact: true }).click();
    await job('还原项目', 'done').waitFor();
    await nav('回收站').click();
    await page.getByText('暂无已记录的删除项', { exact: true }).waitFor();
    await nav('全部文件').click();
    await exact('整套课程').waitFor();
    await exact('阅读清单.txt').waitFor();
    const result = 'PASS ' + version + ' Windows release window: nested/empty upload, batch folder+file download, move, confirmed recycle and batch restore';
    console.log(result);
    await fs.writeFile(path.join(evidence, 'windows-evidence.txt'), result + '\n');
  } finally { await app.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
