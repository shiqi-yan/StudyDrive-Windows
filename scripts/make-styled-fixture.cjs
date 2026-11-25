const ExcelJS = require('exceljs');
const path = require('node:path');

async function run() {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('格式示例');
  sheet.mergeCells('A1:C1');
  const title = sheet.getCell('A1');
  title.value = '合并标题';
  title.font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FF174C73' } };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD7EAF5' } };
  title.border = { bottom: { style: 'medium', color: { argb: 'FF174C73' } } };
  title.alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.getCell('B2').value = 8;
  sheet.getCell('C2').value = 9;
  sheet.getCell('A2').value = { formula: 'SUM(B2:C2)', result: 17 };
  book.addWorksheet('归档').getCell('A1').value = '第二张工作表';
  await book.xlsx.writeFile(path.join(__dirname, '..', 'fixtures', 'styled-grades.xlsx'));
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });
