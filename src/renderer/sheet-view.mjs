import { button, el } from './ui.mjs';
import { encodingSelect, findForm } from './document-view.mjs';

const rowHeight = 28;
const colWidth = 144;
const rowLabel = 54;
function columnName(col) {
  let label = '';
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + (n - 1) % 26) + label;
  return label;
}
const address = ({ row, col }) => columnName(col) + (row + 1);

export async function sheetView(root, opened, viewer) {
  const api = window.study;
  const ask = (operation, input) => api.document(opened.key, operation, input);
  const saved = opened.documentPosition || {};
  let index = saved.sheet || 0;
  let info;
  let selection;
  let selectedValue;
  let queryBefore;
  let working;
  let queued;
  let pendingFrame;
  let shown;
  let visibleMerges = [];
  const placements = new Map();
  placements.set(index, { row: saved.row || 0, col: saved.col || 0 });
  const separated = /\.(csv|tsv)$/i.test(opened.item.name);
  const sheetSelect = el('select', { 'aria-label': '活动工作表' });
  const encoding = encodingSelect();
  const delimiter = el('select', { 'aria-label': '分隔符' }, [['', '按扩展名'], [',', '逗号'], ['\t', '制表符'], [';', '分号'], ['|', '竖线']]
    .map(([value, name]) => el('option', { value }, name)));
  encoding.value = saved.encoding || 'auto';
  delimiter.value = saved.delimiter || '';
  const status = el('span', { class: 'reader-status', role: 'status' }, '正在后台读取表格…');
  const cellAddress = el('span', { class: 'sheet-address' }, '—');
  const formula = el('input', { type: 'text', readonly: '', 'aria-label': '公式或单元格内容', placeholder: '选择单元格以查看内容和公式' });
  const copy = button('复制单元格', () => copyCell());
  copy.disabled = true;
  const viewport = el('div', { class: 'sheet-scroll', role: 'grid', tabindex: '0', 'aria-label': '工作表数据', 'aria-readonly': 'true' });
  const surface = el('div', { class: 'sheet-surface' });
  const cells = el('div', { class: 'sheet-cells' });
  const mergedCells = el('div', { class: 'sheet-merged-cells', role: 'rowgroup' });
  const topHeaders = el('div', { class: 'sheet-column-labels', 'aria-hidden': 'true' });
  const leftHeaders = el('div', { class: 'sheet-row-labels', 'aria-hidden': 'true' });
  const corner = el('div', { class: 'sheet-corner', 'aria-hidden': 'true' });
  surface.append(cells, mergedCells, topHeaders, leftHeaders, corner);
  viewport.append(surface);
  const body = el('div', { class: 'sheet-body' }, viewport);
  const find = findForm('查找单元格', async query => {
    if (!info || working) return;
    const sheet = index;
    const start = query === queryBefore && selection ? selection : { row: -1, col: -1 };
    try {
      const match = await ask('find', { sheet, query, ...start });
      if (sheet !== index || !viewer.active()) return;
      if (!match) { status.textContent = '此工作表未找到'; return; }
      queryBefore = query;
      status.textContent = '找到 ' + address(match);
      activate(match);
    } catch (error) { viewer.toast(error.message); }
  });
  root.replaceChildren(el('div', { class: 'reader-toolbar' }, sheetSelect, separated ? encoding : null, separated ? delimiter : null, find, status),
    el('div', { class: 'sheet-formula' }, cellAddress, el('span', { class: 'sheet-formula-symbol', 'aria-hidden': 'true' }, 'ƒx'), formula, copy), body);

  sheetSelect.addEventListener('change', () => {
    remember();
    index = Number(sheetSelect.value);
    mount();
  });
  encoding.addEventListener('change', () => parse());
  delimiter.addEventListener('change', () => parse());
  const observer = new ResizeObserver(() => schedule());
  observer.observe(viewport);
  if (!viewer.active()) observer.disconnect();
  viewer.onClose(() => observer.disconnect());
  viewport.addEventListener('scroll', () => {
    placeHeaders();
    remember();
    schedule();
  });
  viewport.addEventListener('click', event => {
    const cell = event.target.closest('[data-row][data-col]');
    if (cell) activate({ row: Number(cell.dataset.row), col: Number(cell.dataset.col) }, false);
  });
  viewport.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      copyCell();
      return;
    }
    const delta = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[event.key];
    if (!delta || !info) return;
    event.preventDefault();
    const base = selection || position();
    const merge = mergeAt(base);
    activate(clamp({
      row: delta[0] === 1 && merge ? merge.bottom + 1 : base.row + delta[0],
      col: delta[1] === 1 && merge ? merge.right + 1 : base.col + delta[1]
    }));
  });

  function clamp({ row, col }) {
    return { row: Math.max(0, Math.min(info.rows - 1, row)), col: Math.max(0, Math.min(info.cols - 1, col)) };
  }
  function position() {
    return clamp({ row: Math.floor(viewport.scrollTop / rowHeight), col: Math.floor(viewport.scrollLeft / colWidth) });
  }
  function remember() {
    if (!info || !viewer.active()) return;
    const coordinate = position();
    placements.set(index, coordinate);
    viewer.remember({ sheet: index, ...coordinate, ...(separated ? { encoding: encoding.value, delimiter: delimiter.value } : {}) });
  }
  function showSelection() {
    for (const node of surface.querySelectorAll('[aria-selected="true"]')) node.setAttribute('aria-selected', 'false');
    if (!selection) return;
    const node = surface.querySelector('[data-row="' + selection.row + '"][data-col="' + selection.col + '"]');
    if (node) node.setAttribute('aria-selected', 'true');
  }
  function mergeAt({ row, col }) {
    return visibleMerges.find(merge => row >= merge.row && row <= merge.bottom && col >= merge.col && col <= merge.right);
  }
  async function activate(cell, scroll = true) {
    const merge = mergeAt(cell);
    if (merge) cell = { row: merge.row, col: merge.col };
    const sheet = index;
    selection = cell;
    selectedValue = null;
    cellAddress.textContent = address(cell);
    formula.value = '';
    copy.disabled = true;
    if (scroll) {
      const x = cell.col * colWidth;
      const y = cell.row * rowHeight;
      if (x < viewport.scrollLeft || x + colWidth > viewport.scrollLeft + viewport.clientWidth - rowLabel) viewport.scrollLeft = x;
      if (y < viewport.scrollTop || y + rowHeight * 2 > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = y;
    }
    showSelection();
    try {
      const value = await ask('cell', { sheet, ...cell });
      if (!viewer.active() || index !== sheet || selection !== cell) return;
      selectedValue = value.value;
      formula.value = value.formula ? '=' + value.formula : value.value;
      copy.disabled = false;
    } catch (error) { if (viewer.active() && selection === cell) viewer.toast(error.message); }
  }
  function gridCell(row, col, { value, formula, style }, merge) {
    const node = el('div', {
      role: 'gridcell', title: formula ? '=' + formula : value, 'data-row': row, 'data-col': col,
      'aria-colindex': col + 1, 'aria-selected': 'false', class: 'sheet-cell' + (formula ? ' formula-cell' : '')
    }, el('span', {}, value));
    if (style) Object.assign(node.style, style);
    if (merge) {
      node.setAttribute('aria-rowindex', String(row + 1));
      node.setAttribute('aria-rowspan', String(merge.bottom - row + 1));
      node.setAttribute('aria-colspan', String(merge.right - col + 1));
      node.style.left = rowLabel + col * colWidth + 'px';
      node.style.top = (row + 1) * rowHeight + 'px';
      node.style.width = (merge.right - col + 1) * colWidth + 'px';
      node.style.height = (merge.bottom - row + 1) * rowHeight + 'px';
    }
    return node;
  }
  function copyCell() {
    if (selectedValue === null || selectedValue === undefined) return;
    api.copyText(opened.key, selectedValue).then(() => viewer.toast('已复制单元格'), error => viewer.toast(error.message));
  }
  function placeHeaders() {
    topHeaders.style.top = viewport.scrollTop + 'px';
    leftHeaders.style.left = viewport.scrollLeft + 'px';
    corner.style.top = viewport.scrollTop + 'px';
    corner.style.left = viewport.scrollLeft + 'px';
  }
  function schedule() {
    if (pendingFrame || !info || !viewer.active()) return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = null;
      draw();
    });
  }
  async function draw() {
    if (!info || !viewer.active()) return;
    if (working) { queued = true; return; }
    const { row, col } = position();
    const height = Math.min(100, Math.ceil(viewport.clientHeight / rowHeight) + 2);
    const width = Math.min(36, Math.ceil(viewport.clientWidth / colWidth) + 2);
    const signature = [index, row, col, height, width].join('-');
    if (shown === signature) return;
    const details = info;
    const sheet = index;
    working = true;
    try {
      const { cells: data, merges } = await ask('viewport', { sheet, row, col, height, width });
      if (!viewer.active() || details !== info || sheet !== index) return;
      shown = signature;
      const actualWidth = Math.min(width, info.cols - col);
      cells.style.left = rowLabel + col * colWidth + 'px';
      cells.style.top = (row + 1) * rowHeight + 'px';
      cells.style.setProperty('--sheet-cols', actualWidth);
      topHeaders.style.left = rowLabel + col * colWidth + 'px';
      leftHeaders.style.top = (row + 1) * rowHeight + 'px';
      topHeaders.replaceChildren(...Array.from({ length: actualWidth }, (_, offset) => el('span', {}, columnName(col + offset))));
      leftHeaders.replaceChildren(...data.map((_, offset) => el('span', {}, String(row + offset + 1))));
      const covered = new Set();
      for (const merge of merges) {
        for (let y = Math.max(row, merge.row); y <= Math.min(row + data.length - 1, merge.bottom); y += 1) {
          for (let x = Math.max(col, merge.col); x <= Math.min(col + actualWidth - 1, merge.right); x += 1) covered.add(y + ':' + x);
        }
      }
      visibleMerges = merges;
      cells.replaceChildren(...data.map((values, y) => el('div', { role: 'row', 'aria-rowindex': row + y + 1 },
        values.map((value, x) => covered.has((row + y) + ':' + (col + x))
          ? el('div', { class: 'sheet-cell sheet-covered', 'aria-hidden': 'true' }) : gridCell(row + y, col + x, value)))));
      mergedCells.replaceChildren(...merges.map(merge => el('div', { role: 'row', 'aria-rowindex': merge.row + 1 },
        gridCell(merge.row, merge.col, merge.cell, merge))));
      showSelection();
      placeHeaders();
      viewer.viewed();
      remember();
    } catch (error) { if (viewer.active() && details === info) viewer.error(error, body); }
    finally {
      working = false;
      if (queued) { queued = false; schedule(); }
    }
  }
  let sheets;
  function mount() {
    info = sheets[index];
    shown = null;
    selection = null;
    queryBefore = null;
    selectedValue = null;
    formula.value = '';
    cellAddress.textContent = '—';
    copy.disabled = true;
    status.textContent = info.rows + ' 行 × ' + info.cols + ' 列';
    body.replaceChildren(viewport);
    cells.replaceChildren();
    mergedCells.replaceChildren();
    visibleMerges = [];
    topHeaders.replaceChildren();
    leftHeaders.replaceChildren();
    viewport.setAttribute('aria-rowcount', info.rows);
    viewport.setAttribute('aria-colcount', info.cols);
    surface.style.height = (info.rows + 1) * rowHeight + 'px';
    surface.style.width = rowLabel + info.cols * colWidth + 'px';
    const restored = clamp(placements.get(index) || { row: 0, col: 0 });
    viewport.scrollTop = restored.row * rowHeight;
    viewport.scrollLeft = restored.col * colWidth;
    schedule();
  }
  async function parse() {
    info = null;
    const controls = [encoding, delimiter, sheetSelect];
    for (const element of controls) element.disabled = true;
    status.textContent = '正在后台读取表格…';
    body.replaceChildren(el('p', { class: 'preview-message', role: 'status' }, '正在解析工作表…'));
    try {
      ({ sheets } = await ask('parse', { encoding: encoding.value, delimiter: delimiter.value }));
      if (!viewer.active()) return;
      index = Math.min(index, sheets.length - 1);
      sheetSelect.replaceChildren(...sheets.map(({ name }, offset) => el('option', { value: offset }, name)));
      sheetSelect.value = index;
      mount();
    } catch (error) {
      status.textContent = '';
      viewer.error(error, body);
    } finally { for (const element of controls) element.disabled = false; }
  }
  await parse();
}
