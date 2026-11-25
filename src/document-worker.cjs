const { parentPort, workerData } = require('node:worker_threads');
const { decodeText } = require('./text-decoder.cjs');

const { buffer, count, truncated, kind, ext } = workerData;
const source = new Uint8Array(buffer);
const delimited = ext === 'csv' || ext === 'tsv';
const maxLines = 200000;
const maxCells = 500000;
let lines;
let sheets;
let xlsx;
let styles;

function loadLines(text) {
  lines = [];
  let start = 0;
  for (const lineBreak of text.matchAll(/\r\n|\n|\r/g)) {
    if (lines.length === maxLines) break;
    lines.push(text.slice(start, lineBreak.index));
    start = lineBreak.index + lineBreak[0].length;
  }
  if (lines.length < maxLines) lines.push(text.slice(start));
}

function markdown(text) {
  const md = require('markdown-it')({ html: false, linkify: false, maxNesting: 30 });
  const escape = md.utils.escapeHtml;
  md.renderer.rules.image = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    const alt = renderer.renderInlineAsText(token.children, options, env);
    const src = token.attrGet('src') || '';
    if (!src || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(src)) {
      return '<span class="blocked-image">' + escape(alt || '外部图片') + '（未加载）</span>';
    }
    return '<span class="markdown-image" data-source="' + escape(src) + '">' + escape(alt || '图片') + '</span>';
  };
  const tokens = md.parse(text, {});
  if (tokens.length > 24000) throw new Error('Markdown 段落过多，请下载原件。');
  const headings = [];
  const used = new Set();
  for (const [index, token] of tokens.entries()) {
    if (token.type === 'heading_open') {
      const inline = tokens[index + 1];
      const title = md.renderer.renderInlineAsText(inline.children, md.options, {});
      const slug = title.toLowerCase().trim().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ +/g, '-') || 'section';
      let id = 'md-' + slug;
      for (let suffix = 2; used.has(id); suffix += 1) id = 'md-' + slug + '-' + suffix;
      used.add(id);
      token.attrSet('id', id);
      headings.push({ id, title, level: Number(token.tag[1]) });
    }
    for (const child of token.children || []) {
      if (child.type !== 'link_open') continue;
      const href = child.attrGet('href') || '';
      let fragment = '';
      try { if (href.startsWith('#')) fragment = decodeURIComponent(href.slice(1)); } catch {}
      child.attrs = fragment ? [['href', '#md-' + fragment]] : [];
    }
  }
  return { html: md.renderer.render(tokens, md.options, {}), headings };
}

function checkZip() {
  const bytes = Buffer.from(buffer);
  let end = bytes.length - 22;
  const earliest = Math.max(0, end - 65535);
  while (end >= earliest && (bytes.readUInt32LE(end) !== 0x06054b50 || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length)) end -= 1;
  if (end < earliest) throw new Error('表格压缩包已损坏，请下载原件。');
  const count = bytes.readUInt16LE(end + 10);
  const start = bytes.readUInt32LE(end + 16);
  const stop = start + bytes.readUInt32LE(end + 12);
  const large = '表格解压规模过大或格式不受支持，请下载原件。';
  if (count > 8192 || stop > end) throw new Error(large);
  let total = 0;
  let at = start;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > stop || bytes.readUInt32LE(at) !== 0x02014b50) throw new Error('表格压缩包已损坏，请下载原件。');
    if (bytes.readUInt16LE(at + 8) & 1) throw new Error('表格已加密，请下载原件后使用密码打开。');
    total += bytes.readUInt32LE(at + 24);
    if (total > 96 * 1024 ** 2) throw new Error(large);
    at += 46 + bytes.readUInt16LE(at + 28) + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  if (at !== stop) throw new Error('表格压缩包已损坏，请下载原件。');
  return total;
}

function sheetInfo(name, worksheet) {
  const range = worksheet['!ref'] ? xlsx.utils.decode_range(worksheet['!ref']) : { e: { r: 0, c: 0 } };
  const merges = (worksheet['!merges'] || []).filter(({ s, e }) => e.r < 1048576 && e.c < 16384 && s.r >= 0 && s.c >= 0 &&
    e.r >= s.r && e.c >= s.c && (e.r > s.r || e.c > s.c)).slice(0, 5000);
  const rows = Math.max(range.e.r + 1, ...merges.map(merge => merge.e.r + 1));
  const cols = Math.max(range.e.c + 1, ...merges.map(merge => merge.e.c + 1));
  if (rows > 1048576 || cols > 16384) throw new Error('工作表范围超出预览上限，请下载原件。');
  const cells = [];
  const data = worksheet['!data'];
  if (data) {
    data.forEach((row, r) => row?.forEach((cell, c) => { if (cell?.v != null || cell?.f) cells.push([r, c]); }));
  }
  return { name, rows, cols, cells, merges, get: (r, c) => data?.[r]?.[c] };
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let width = 1;
  let fields = 0;
  let row = [];
  let segments = [];
  let start = 0;
  let quoted = false;
  let ended = false;
  const cell = end => {
    if (++fields > maxCells || row.length >= 16384) throw new Error('分隔文本单元格过多，请下载原件。');
    segments.push(text.slice(start, end));
    row.push(segments.join(''));
    segments = [];
    ended = false;
  };
  const line = () => {
    width = Math.max(width, row.length);
    rows.push(row);
    row = [];
  };
  if (text.startsWith('"')) { quoted = true; start = 1; }
  for (let at = start; at < text.length; at += 1) {
    const char = text[at];
    if (quoted) {
      if (char !== '"') continue;
      segments.push(text.slice(start, at));
      if (text[at + 1] === '"') { segments.push('"'); at += 1; }
      else { quoted = false; ended = true; }
      start = at + 1;
      continue;
    }
    if (char === delimiter || char === '\r' || char === '\n') {
      cell(at);
      if (char !== delimiter) {
        line();
        if (char === '\r' && text[at + 1] === '\n') at += 1;
      }
      if (text[at + 1] === '"') { quoted = true; at += 1; }
      start = at + 1;
    } else if (ended) throw new Error('分隔文本的引号格式无效，请检查分隔符。');
  }
  if (quoted) throw new Error('分隔文本的引号未闭合，请检查分隔符。');
  if (row.length || start < text.length || ended) { cell(text.length); line(); }
  const cells = [];
  rows.forEach((values, r) => values.forEach((value, c) => { if (value) cells.push([r, c]); }));
  return { name: ext.toUpperCase(), rows: Math.max(1, rows.length), cols: width, cells,
    get: (r, c) => ({ v: rows[r]?.[c] }) };
}

async function loadSheets(encoding, delimiter) {
  styles = null;
  if (delimited) return [parseDelimited(decodeText(source, encoding, truncated).text, delimiter || (ext === 'tsv' ? '\t' : ','))];
  const zip = source[0] === 80 && source[1] === 75;
  const ole = source[0] === 0xd0 && source[1] === 0xcf;
  const legacy = ext === 'xls' && (source[0] === 9 || source[0] === 60 || source[0] === 0xef);
  if (!zip && !ole && !legacy) throw new Error('文件内容与表格格式不符，可能已损坏。');
  const expandedSize = zip ? checkZip() : 0;
  xlsx ||= require('xlsx');
  let workbook;
  try {
    workbook = xlsx.read(source, { type: 'array', dense: true, cellDates: false, cellText: true, cellNF: true,
      cellFormula: true, cellHTML: false, bookVBA: false, bookFiles: false, sheetStubs: true });
  } catch (error) {
    if (/password|encrypt/i.test(error.message)) throw new Error('表格已加密，请下载原件后使用密码打开。');
    throw new Error('无法解析表格，文件可能已损坏或格式不受支持。');
  }
  if (!workbook.SheetNames.length || workbook.SheetNames.length > 120) throw new Error('工作表数量超出预览范围，请下载原件。');
  const result = workbook.SheetNames.map(name => sheetInfo(name, workbook.Sheets[name]));
  const count = result.reduce((sum, sheet) => sum + sheet.cells.length, 0);
  if (count > maxCells) throw new Error('表格单元格过多，请下载原件。');
  if (ext === 'xlsx' && zip && expandedSize <= 16 * 1024 ** 2 && count <= 75000) {
    try { styles = await require('./sheet-styles.cjs').sheetStyles(buffer); }
    catch { /* Keep the primary reader available when supplemental styles cannot be read. */ }
  }
  return result;
}

function cellValue(sheet, row, col) {
  const cell = sheet.get(row, col);
  const value = cell?.w ?? (cell?.v == null ? '' : String(cell.v));
  return { value, formula: cell?.f || '' };
}

const integer = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
function viewportCell(sheet, row, col, styled) {
  const cell = cellValue(sheet, row, col);
  const result = { value: cell.value.slice(0, 512), formula: cell.formula.slice(0, 256) };
  if (styled) result.style = styles?.(sheet.name, row, col) || null;
  return result;
}

async function dispatch(operation, input = {}) {
  if (operation === 'parse') {
    const encoding = ['auto', 'utf-8', 'utf-16le', 'utf-16be', 'gbk', 'gb18030'].includes(input.encoding) ? input.encoding : 'auto';
    if (kind === 'sheet') {
      sheets = await loadSheets(encoding, [',', '\t', ';', '|'].includes(input.delimiter) ? input.delimiter : '');
      return { sheets: sheets.map(({ name, rows, cols }) => ({ name, rows, cols })) };
    }
    const decoded = decodeText(source, encoding, truncated);
    const { text } = decoded;
    loadLines(text);
    return { lines: lines.length, count, encoding: decoded.encoding, truncated: truncated || lines.length === maxLines,
      ...(kind === 'markdown' ? markdown(text) : {}) };
  }
  if (operation === 'lines' && lines && integer(input.start, lines.length)) {
    return lines.slice(input.start, input.start + 180).map(value => value.length > 12000 ? value.slice(0, 12000) + ' …（此行预览已截断）' : value);
  }
  const query = typeof input.query === 'string' ? input.query.slice(0, 200).toLowerCase() : '';
  if (operation === 'find' && query && lines) {
    const start = integer(input.start, lines.length - 1) ? input.start : 0;
    for (let step = 0; step < lines.length; step += 1) {
      const index = (start + step) % lines.length;
      if (lines[index].toLowerCase().includes(query)) return { index };
    }
    return null;
  }
  const sheet = sheets && integer(input.sheet, sheets.length - 1) ? sheets[input.sheet] : null;
  if (['cells', 'viewport'].includes(operation) && sheet && integer(input.row, sheet.rows - 1) && integer(input.col, sheet.cols - 1)) {
    const height = integer(input.height, 100) ? input.height : 0;
    const width = integer(input.width, 36) ? input.width : 0;
    const bottom = Math.min(sheet.rows, input.row + height);
    const right = Math.min(sheet.cols, input.col + width);
    const styled = operation === 'viewport';
    const cells = [];
    for (let row = input.row; row < bottom; row += 1) {
      const values = [];
      for (let col = input.col; col < right; col += 1) values.push(viewportCell(sheet, row, col, styled));
      cells.push(values);
    }
    if (!styled) return cells;
    const merges = (sheet.merges || []).filter(({ s, e }) => s.r < bottom && s.c < right && e.r >= input.row && e.c >= input.col)
      .slice(0, 600)
      .map(({ s, e }) => ({ row: s.r, col: s.c, bottom: e.r, right: e.c, cell: viewportCell(sheet, s.r, s.c, true) }));
    return { cells, merges };
  }
  if (operation === 'cell' && sheet && integer(input.row, sheet.rows - 1) && integer(input.col, sheet.cols - 1)) {
    return cellValue(sheet, input.row, input.col);
  }
  if (operation === 'find' && query && sheet) {
    const cursor = sheet.cells.findIndex(([row, col]) => row > input.row || row === input.row && col > input.col);
    const start = Math.max(0, cursor);
    for (let step = 0; step < sheet.cells.length; step += 1) {
      const [row, col] = sheet.cells[(start + step) % sheet.cells.length];
      const cell = cellValue(sheet, row, col);
      if (cell.value.toLowerCase().includes(query) || cell.formula.toLowerCase().includes(query)) return { row, col };
    }
    return null;
  }
  throw new Error('无效的文档预览操作。');
}

let queued = Promise.resolve();
parentPort.on('message', ({ seq, operation, input }) => {
  queued = queued.then(async () => {
    try { parentPort.postMessage({ seq, result: await dispatch(operation, input) }); }
    catch (error) {
      const message = /^[\u3400-\u9fff]/u.test(error.message) ? error.message : '无法读取文件，文件可能过大、已加密或已损坏。';
      parentPort.postMessage({ seq, error: message });
    }
  });
});
