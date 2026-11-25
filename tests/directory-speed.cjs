const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { directoryBuild } = require('../scripts/build-paths.cjs');

const root = path.resolve(__dirname, '..');
const output = process.env.STUDY_TEST_RESULTS || path.join(root, 'test-results', 'online-0.2.4');
const course = '高等数学';
const child = '01 · 函数图像与变化.mp4';
const latency = { folderDelay: 180, listDelay: 450 };
const counts = app => app.evaluate(() => ({ lists: globalThis.studyTest.mock.listRequests.length, lookups: globalThis.studyTest.mock.folderLookups }));

async function clickCourse(app, page) {
  const before = await counts(app);
  await page.evaluate(({ course, child }) => {
    window.directoryTiming = {};
    const button = [...document.querySelectorAll('.file-name')].find(node => node.textContent === course);
    button.addEventListener('click', () => {
      const start = performance.now();
      const watch = new MutationObserver(() => {
        if (document.querySelector('#content h1')?.textContent !== course) return;
        window.directoryTiming.feedback ??= performance.now() - start;
        if (document.querySelector('.directory-progress')) window.directoryTiming.loading = true;
        if (![...document.querySelectorAll('.file-name')].some(node => node.textContent === child)) return;
        window.directoryTiming.firstPage = performance.now() - start;
        watch.disconnect();
      });
      watch.observe(document.querySelector('#content'), { childList: true, subtree: true });
    }, { capture: true, once: true });
  }, { course, child });
  await page.getByRole('button', { name: course, exact: true }).click();
  await page.waitForFunction(() => Number.isFinite(window.directoryTiming.firstPage));
  const timing = await page.evaluate(() => window.directoryTiming);
  const after = await counts(app);
  return { ...timing, lists: after.lists - before.lists, lookups: after.lookups - before.lookups };
}

async function run() {
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(output, 'directory-'));
  const baseline = process.argv.includes('--baseline');
  const exe = baseline ? path.join(output, 'baseline-runtime', 'StudyDrive.exe') : path.join(directoryBuild(root, require('../package.json').version, { office: true }), 'StudyDrive.exe');
  const app = await electron.launch({ executablePath: exe, args: ['--demo', '--test-driver'], cwd: root,
    env: { ...process.env, STUDY_DRIVER: '1', STUDY_TEST_PROFILE: profile }, timeout: 25000 });
  try {
    const page = await app.firstWindow();
    await page.locator('#nav').getByRole('button', { name: '全部文件', exact: true }).click();
    await page.getByRole('button', { name: course, exact: true }).waitFor();
    await app.evaluate((_, latency) => Object.assign(globalThis.studyTest.mock, latency), latency);
    const cold = await clickCourse(app, page);
    const rootNav = () => page.getByRole('navigation', { name: '文件夹路径' }).getByRole('button', { name: '全部文件', exact: true }).click();
    await rootNav();
    await page.getByRole('button', { name: course, exact: true }).waitFor();
    const warm = await clickCourse(app, page);
    assert.equal(cold.lists, 1);
    if (!baseline) {
      assert.equal(cold.lookups, 0);
      assert.equal(cold.loading, true);
      assert.equal(warm.lists, 0);
      assert.equal(warm.lookups, 0);
      assert.ok(cold.feedback < cold.firstPage);
      await rootNav();
      await page.getByRole('button', { name: '参考资料', exact: true }).click();
      await page.getByRole('heading', { name: '参考资料', exact: true }).waitFor();
      await rootNav();
      await page.getByRole('button', { name: course, exact: true }).click();
      await page.getByRole('button', { name: child, exact: true }).waitFor();
      await page.waitForTimeout(latency.listDelay + 100);
      assert.equal(await page.getByRole('heading', { name: course, exact: true }).count(), 1);
      assert.equal(await page.locator('.directory-progress').count(), 0);
    }
    const evidence = { runtime: await app.evaluate(({ app }) => app.getVersion()), latency, cold, warm, staleNavigationChecked: !baseline };
    await fs.writeFile(path.join(output, baseline ? 'directory-baseline.json' : 'directory-fixed.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence));
    console.log('PASS controlled Windows directory timing and request counts');
  } finally { await app.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
