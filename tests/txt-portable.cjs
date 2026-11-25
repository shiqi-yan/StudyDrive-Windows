const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { withPortable, click, conversion, painted } = require('./office-portable.cjs');

async function run() {
  const results = process.env.STUDY_TEST_RESULTS || path.join(__dirname, '..', 'test-results', 'startup-' + require('../package.json').version);
  await fs.mkdir(results, { recursive: true });
  if (process.argv.includes('--baseline')) {
    await withPortable(false, async page => {
      await click(page, '文档预览示例');
      await click(page, '旧中文文本.txt');
      await page.getByRole('alert').getByText(/无法用所选编码解码/).waitFor();
      await page.getByLabel('文本编码').selectOption('gbk');
      await page.getByText('中文测试', { exact: true }).waitFor();
      console.log('PASS 0.2.5 directory executable rejects the GBK fixture in auto mode and only opens it with manual GBK');
    }, path.join(__dirname, '..', 'dist', 'win-unpacked', 'StudyDrive.exe'));
    return;
  }
  await withPortable(true, async page => {
    await click(page, '文档预览示例');
    await click(page, '旧中文文本.txt');
    await page.getByText(/自动识别 GB18030/).waitFor();
    await page.getByText('中文测试', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(results, 'gbk-preview.png') });
    await page.getByLabel('文本编码').selectOption('gbk');
    await page.getByText(/^第 .* 行 \/ \d+$/).waitFor();
    await page.getByText('中文测试', { exact: true }).waitFor();
    console.log('PASS actual standard EXE opens a GBK TXT automatically, identifies GB18030 and still accepts manual GBK');
  });
  await withPortable(true, async (page, main, profile) => {
    await main('globalThis.studyTest.mock.conversionStatus.office = 422');
    await click(page, '课程计划.docx');
    await conversion(page, '本机转换');
    await painted(page, 1);
    assert.ok(!(await fs.readdir(profile)).some(name => name.startsWith('office-preview-')));
    console.log('PASS actual Office EXE initializes the native engine on Word fallback and renders the mock fixture');
  });
}
run().catch(error => { console.error(error); process.exitCode = 1; });
