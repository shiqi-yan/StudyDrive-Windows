const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const directory = path.join(__dirname, '..', 'fixtures');
const file = name => path.join(directory, name);
const workbook = XLSX.utils.book_new();
const summary = XLSX.utils.aoa_to_sheet([
  ['学号', '日期', '成绩', '缓存公式', '空白', '百分比'],
  ['000172', { t: 'n', v: 46345, z: 'yyyy-mm-dd' }, 82, { t: 'n', v: 92, f: 'C2+10' }, undefined, { t: 'n', v: 0.82, z: '0.0%' }]
]);
const details = XLSX.utils.aoa_to_sheet([
  ['课程', '状态'], ['高等数学', '待复习']
]);
const target = XLSX.utils.encode_cell({ r: 77, c: 15 });
details[target] = { t: 's', v: '教学目标定位' };
details.AZ145 = { t: 's', v: '表格尾部' };
details['!ref'] = 'A1:AZ145';
XLSX.utils.book_append_sheet(workbook, summary, '成绩摘要');
XLSX.utils.book_append_sheet(workbook, details, '课程明细');
for (const [bookType, name] of [['xlsx', 'grades.xlsx'], ['biff8', 'grades.xls'], ['xlsm', 'grades.xlsm'], ['ods', 'grades.ods']]) {
  XLSX.writeFile(workbook, file(name), { bookType, compression: true });
}
fs.writeFileSync(file('student-ids.csv'), '学号,姓名,备注,空列\r\n000123,"张,同学","去""复习""",\r\n000009,李同学,"多行\n备注",\r\n');
fs.writeFileSync(file('student-ids.tsv'), '学号\t姓名\n000007\t王同学\n');
fs.writeFileSync(file('gbk.txt'), Buffer.concat([Buffer.from('d6d0cec4b2e2cad4', 'hex'), Buffer.from(
  '\r\n' + Array.from({ length: 360 }, (_, i) => i === 223 ? 'TARGET LINE 225' : 'Log entry ' + (i + 2)).join('\r\n')
)]));
fs.writeFileSync(file('guide.md'), [
  '# 课程导航', '', '学习资料与原件可从文件列表打开。', '',
  '| 项目 | 状态 |', '| --- | --- |', '| 课程资料 | 已上传 |', '',
  '## 函数草图', '', '![同目录草图](./%E8%AF%BE%E7%A8%8B%E5%9B%BE%E7%89%87.png)', '',
  '![外部图片](https://example.invalid/unused.png)', '', '<strong>原样显示 HTML</strong>', '',
  '```js', 'const label = "仅供阅读";', '```', '', ...Array.from({ length: 24 }, (_, i) => '阅读段落 ' + (i + 1) + '\n'),
  '## 第二章笔记', '', '按标题定位并恢复阅读位置。', '', ...Array.from({ length: 24 }, (_, i) => '课后笔记 ' + (i + 1) + '\n')
].join('\n'));
console.log('Generated spreadsheets, CSV/TSV, GBK and Markdown fixtures');
