const ExcelJS = require('exceljs');

const themeNames = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
const standardTheme = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72'];
const borders = {
  hair: '1px solid', thin: '1px solid', medium: '2px solid', thick: '3px solid', double: '3px double',
  dotted: '1px dotted', dashed: '1px dashed', dashDot: '1px dashed', dashDotDot: '1px dashed',
  mediumDashed: '2px dashed', mediumDashDot: '2px dashed', mediumDashDotDot: '2px dashed', slantDashDot: '2px dashed'
};

function parseTheme(xml = '') {
  return themeNames.map((name, index) => {
    const section = new RegExp('<(?:\\w+:)?' + name + '(?=[\\s>])[^>]*>([^<]*<[^>]+)', 'i').exec(xml)?.[1] || '';
    return /\blastClr="([0-9a-f]{6})"/i.exec(section)?.[1] ||
      /\bval="([0-9a-f]{6})"/i.exec(section)?.[1] || standardTheme[index];
  });
}

function color(style, theme) {
  const rgb = /^(?:[0-9a-f]{2})?([0-9a-f]{6})$/i.exec(style?.argb || '')?.[1] || (Number.isInteger(style?.theme) ? theme[style.theme] : undefined);
  if (!rgb) return undefined;
  const tint = Math.min(1, Math.max(-1, Number(style.tint) || 0));
  if (!tint) return '#' + rgb;
  const painted = rgb.match(/.{2}/g).map(pair => {
    const channel = parseInt(pair, 16);
    const output = tint < 0 ? channel * (1 + tint) : channel + (255 - channel) * tint;
    return Math.round(output).toString(16).padStart(2, '0');
  });
  return '#' + painted.join('');
}

function cellStyle(cell, theme) {
  if (!cell) return null;
  const { font, fill, alignment, border } = cell;
  const result = {};
  if (/^[\p{L}\p{N} ._-]{1,48}$/u.test(font?.name || '')) result.fontFamily = '"' + font.name + '"';
  if (Number.isFinite(font?.size)) result.fontSize = Math.min(42, Math.max(6, font.size)) + 'pt';
  if (font?.bold) result.fontWeight = '700';
  if (font?.italic) result.fontStyle = 'italic';
  if (font?.underline || font?.strike) result.textDecoration = [font.underline && 'underline', font.strike && 'line-through'].filter(Boolean).join(' ');
  const ink = color(font?.color, theme);
  if (ink) result.color = ink;
  if (fill?.type === 'pattern' && fill.pattern === 'solid') {
    const background = color(fill.fgColor, theme);
    if (background) result.backgroundColor = background;
  }
  const horizontal = { left: 'flex-start', center: 'center', right: 'flex-end', centerContinuous: 'center' }[alignment?.horizontal];
  const vertical = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[alignment?.vertical];
  if (typeof horizontal === 'string') result.justifyContent = horizontal;
  if (typeof vertical === 'string') result.alignItems = vertical;
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const edge = border?.[side];
    if (edge && Object.hasOwn(borders, edge.style)) {
      result['border' + side[0].toUpperCase() + side.slice(1)] = borders[edge.style] + ' ' + (color(edge.color, theme) || '#505650');
    }
  }
  return Object.keys(result).length ? result : null;
}

async function sheetStyles(buffer) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(buffer), {
    ignoreNodes: ['drawing', 'picture', 'conditionalFormatting', 'dataValidations', 'hyperlinks', 'legacyDrawing', 'tableParts', 'extLst', 'mergeCells']
  });
  const theme = parseTheme(book.model.themes?.theme1);
  return (name, row, col) => cellStyle(book.getWorksheet(name)?.findRow(row + 1)?.findCell(col + 1), theme);
}

module.exports = { sheetStyles };
