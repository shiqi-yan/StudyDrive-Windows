const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { directoryBuild } = require('../scripts/build-paths.cjs');
const { version } = require('../package.json');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results', 'blue-' + version);

async function run() {
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(output, 'profile-'));
  const app = await electron.launch({
    executablePath: path.join(directoryBuild(root, version, { office: true }), 'StudyDrive.exe'),
    args: ['--demo', '--test-driver'],
    env: { ...process.env, STUDY_DRIVER: '1', STUDY_TEST_PROFILE: profile },
    cwd: root
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(12000);
    const rendererErrors = [];
    page.on('pageerror', error => rendererErrors.push(error.message));
    const btn = (name, scope = page) => scope.getByRole('button', { name, exact: true });
    const nav = name => btn(name, page.locator('#nav'));
    const click = name => btn(name).click();
    const back = () => click('返回上一级');
    const fixture = '课程计划.docx';
    const video = '01 · 函数图像与变化.mp4';
    const visible = locator => locator.waitFor({ state: 'visible' });
    const isFocused = locator => locator.evaluate(node => node === document.activeElement);
    await visible(page.getByText('演示账户', { exact: true }));
    await visible(page.getByText('7 GB / 20 GB', { exact: true }));
    assert.equal(await page.getByLabel('OneDrive 已用容量').evaluate(node => node.position), .35);
    await app.evaluate(() => { globalThis.studyTest.mock.quota.used = 8 * 1024 ** 3; });
    await click('刷新当前页面');
    await visible(page.getByText('8 GB / 20 GB', { exact: true }));
    console.log('PASS OneDrive quota fetched and refreshed, progress matches the simulated byte counts');

    const overview = (name) => page.locator('.home-section').filter({ has: page.getByRole('heading', { name, exact: true }) });
    assert.equal(await nav('知识库').count(), 0);
    {
      const name = '工具';
      await nav(name).press('Enter');
      const title = page.getByRole('heading', { name, exact: true });
      await visible(title);
      await visible(page.getByText('正在施工', { exact: true }));
      assert.equal(await nav(name).getAttribute('aria-current'), 'page');
      assert.ok(await isFocused(title));
      await click('返回首页');
      await nav('首页').waitFor();
      await page.waitForFunction(() => document.activeElement === document.querySelector('#nav [aria-current]'));
    }
    await click('账户设置');
    await visible(btn('用 Microsoft 登录', page.getByRole('dialog')));
    await page.keyboard.press('Escape');
    console.log('PASS Tools page supports keyboard entry, active state and return focus, account dialog available');

    await nav('全部文件').click();
    await click('参考资料');
    await visible(btn('资料归档 01.txt'));
    await click('加载更多');
    await visible(btn('资料归档 16.txt'));
    await back();
    await visible(btn('参考资料'));
    await page.waitForFunction(() => document.activeElement?.textContent.trim() === '参考资料');
    const search = page.getByRole('searchbox');
    await search.fill('草图');
    await search.press('Enter');
    await visible(btn('函数草图.png'));
    const categories = page.getByRole('group', { name: '文件分类' });
    await btn('视频', categories).click();
    await btn('函数草图.png').waitFor({ state: 'hidden' });
    assert.ok(await isFocused(btn('视频', categories)));
    await btn('图片', categories).click();
    await visible(btn('函数草图.png'));
    await back();
    await click('新建文件夹');
    await page.getByRole('dialog').getByRole('textbox').fill('课程归档');
    await click('新建');
    await visible(btn('课程归档'));
    console.log('PASS browse, pagination, return focus, search, category and new-folder mutation');

    await btn(fixture).press('Enter');
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.pdf-paper canvas');
      return canvas?.getContext('2d').getImageData(10, 10, 1, 1).data[3] > 0;
    });
    await page.waitForFunction(async name => (await window.study.library()).recent.some(record => record.item.name === name), fixture);
    await page.keyboard.press('Escape');
    await visible(btn(fixture));
    assert.ok(await isFocused(btn(fixture)));
    await click('高等数学 的操作');
    await click('收藏目录');
    await click('高等数学');
    await click(video);
    await page.locator('[data-player="mpv"][data-ready="true"]').waitFor();
    await page.locator('.player-stage').press('ArrowRight');
    await page.waitForFunction(() => {
      const media = document.querySelector('[data-player="mpv"]')?.dataset;
      return Number(media?.time) >= 4.7 && media.seeking === 'false';
    });
    await nav('首页').click();
    const recent = overview('最近浏览');
    await visible(recent);
    if (!(await btn(fixture, recent).isVisible()) && await recent.locator('summary').isVisible()) await recent.locator('summary').click();
    await visible(btn(fixture, recent));
    await visible(btn('高等数学', overview('收藏课程目录')));
    await btn('继续观看', overview('继续观看')).click();
    await page.waitForFunction(() => {
      const media = document.querySelector('[data-player="mpv"]')?.dataset;
      return media?.ready === 'true' && Number(media.time) >= 4.7;
    });
    await click('返回');
    await nav('传输').click();
    await visible(page.getByRole('heading', { name: '传输', exact: true }));
    await visible(page.getByText('暂无传输任务', { exact: true }));
    console.log('PASS Office fixture paints PDF and restores focus, video keyboard seek and Home resume, recents, favorite and Transfers');

    await nav('全部文件').click();
    await back();
    await nav('首页').click();
    await visible(btn('课程归档'));
    await page.locator('#toasts .toast').first().waitFor({ state: 'hidden' });
    assert.doesNotMatch(await page.locator('#shell').innerText(), /库库AI|消息|团队空间|会员中心|¥0\.08|5\.5T|8\.0T/);
    for (const width of [1440, 860]) {
      await app.evaluate(({ BrowserWindow }, width) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setContentSize(width, 820);
        const [actualWidth, actualHeight] = win.getContentSize();
        if (actualWidth !== width || actualHeight !== 820) win.setContentSize(2 * width - actualWidth, 1640 - actualHeight);
      }, width);
      await page.waitForFunction(width => innerWidth === width, width);
      const layout = await page.evaluate(() => {
        const article = document.querySelector('#content');
        return { viewport: innerWidth, shell: document.documentElement.scrollWidth, content: article.clientWidth,
          scroll: article.scrollWidth, rail: document.querySelector('#rail').offsetWidth, surface: getComputedStyle(document.querySelector('#toolbar')).backgroundColor };
      });
      assert.equal(layout.viewport, layout.shell);
      assert.equal(layout.content, layout.scroll);
      assert.ok(layout.rail <= 84);
      assert.equal(layout.surface, 'rgb(255, 255, 255)');
      if (width === 1440) await page.screenshot({ path: path.join(output, 'home-1440.png'), scale: 'css' });
      console.log('PASS layout ' + JSON.stringify(layout));
    }
    assert.deepEqual(rendererErrors, []);
  } finally { await app.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
