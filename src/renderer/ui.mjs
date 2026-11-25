const paths = {
  logo: '<path d="M3 5.5C5.8 4.1 8.6 4.4 12 6.4c3.4-2 6.2-2.3 9-0.9v13c-2.7-1.1-5.7-.8-9 1-3.3-1.8-6.3-2.1-9-1z"/><path d="M12 6.5v13M6.3 10l2.6.6m6.2 0 2.6-.6"/>',
  home: '<path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z"/>',
  files: '<path d="M3 6h7l2 2h9v12H3z"/>',
  transfer: '<path d="M7 21V3M3 7l4-4 4 4m6-4v18m-4-4 4 4 4-4"/>',
  tools: '<rect x="4" y="7" width="16" height="14" rx="3"/><path d="M8 7V4h8v3m-7 5c2 2 4 2 6 0"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  upload: '<path d="M12 16V4m-4 4 4-4 4 4M4 15v5h16v-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folderPlus: '<path d="M3 6h7l2 2h9v12H3zM12 11v6m-3-3h6"/>',
  back: '<path d="m14 6-6 6 6 6"/>',
  next: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  folder: '<path d="M2.5 7a2 2 0 0 1 2-2h5l2 2h8a2 2 0 0 1 2 2v9.5a1.5 1.5 0 0 1-1.5 1.5h-16a1.5 1.5 0 0 1-1.5-1.5Z" fill="#f1b629" stroke="none"/><path d="M2.5 10.5a1 1 0 0 1 1-1h17a1 1 0 0 1 1 1v7.7a1.8 1.8 0 0 1-1.8 1.8H4.3a1.8 1.8 0 0 1-1.8-1.8Z" fill="#ffd460" stroke="none"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3z" fill="currentColor"/>',
  audio: '<path d="M9 18V6l10-2v12M9 8l10-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="16" cy="16" rx="3" ry="2"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.4"/><path d="m3 17 5-4 3 2 4-5 6 7"/>',
  pdf: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M8 13h8m-8 4h5"/>',
  office: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M8 13h8m-8 4h5"/>',
  sheet: '<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M5 9h14M5 14h14m-7-5v11"/>',
  markdown: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M6 15V9l3 3 3-3v6m5-6v6m-2-2 2 2 2-2"/>',
  archive: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M12 3v3m-2 0h2v3h2v3h-2v3"/><rect x="9.5" y="15" width="5" height="3" rx="1"/>',
  other: '<path d="M6 3h8l4 4v14H6zM14 3v5h4"/>',
  play: '<path d="m8 5 12 7-12 7z" fill="currentColor"/>',
  pause: '<path d="M9 5v14m6-14v14" stroke-width="3"/>',
  time: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  star: '<path d="m12 3 2.7 5.6 6.2.9-4.5 4.3 1.1 6.2-5.5-3-5.5 3 1.1-6.2L3 9.5l6.2-.9z"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2 6m2-6V5m0 6h-6"/>',
  download: '<path d="M12 4v12m-4-4 4 4 4-4M4 17v3h16v-3"/>',
  user: '<circle cx="12" cy="8" r="3.2"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  volume: '<path d="M3 9h4l4-4v14l-4-4H3zm12-1a6 6 0 0 1 0 8m3-10a9 9 0 0 1 0 12"/>',
  muted: '<path d="M3 9h4l4-4v14l-4-4H3zm12 1 6 5m0-5-6 5"/>',
  fullscreen: '<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/>',
  sliders: '<path d="M4 7h16M4 17h16M9 4v6m6 4v6"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13m-8 3v7m4-7v7"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>'
};
const localPaths = {
  'local-folder': 'folder.svg', 'local-pdf': 'pdf.svg', 'local-word': 'word.svg',
  'local-slides': 'slides.svg', 'local-sheet': 'sheet.svg', 'local-text': 'text.svg',
  'local-audio': 'audio.svg', 'local-video': 'video.svg', 'local-image': 'image.svg',
  'local-file': 'file.svg', 'local-tools': 'tools.svg',
  'local-recent': 'recent.svg', 'local-favorite': 'favorite.svg',
  'local-transfer': 'transfer.svg', 'local-loading': 'loading.svg'
};
export function icon(name, size = 19) {
  if (Object.hasOwn(localPaths, name)) {
    return el('img', { class: 'asset-icon' + (name === 'local-loading' ? ' asset-loading' : ''),
      src: './icons/' + localPaths[name], width: size, height: size, alt: '', 'aria-hidden': 'true', decoding: 'async' });
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.65');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths[name] || paths.other;
  return svg;
}

export function el(tag, attrs = {}, ...content) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name === 'class') node.className = value;
    else if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(name, value);
  }
  node.append(...content.flat().filter(value => value !== undefined && value !== null && value !== false));
  return node;
}

export function button(text, onClick, { symbol, className = '', compact = false, id } = {}) {
  const children = symbol ? [icon(symbol, compact ? 16 : 18)] : [];
  if (text && !compact) children.push(el('span', {}, text));
  return el('button', { type: 'button', class: 'button ' + className, id, title: compact ? text : undefined,
    'aria-label': compact ? text : undefined, onclick: onClick }, ...children);
}

export const kindName = { folder: '文件夹', video: '视频', audio: '音频', image: '图片', pdf: 'PDF',
  office: 'Office', online: 'Office', sheet: '表格', markdown: 'Markdown', text: '文本', archive: '压缩包', shortcut: '共享快捷方式', other: '其他' };
export function badge(kind, name = '') {
  const symbol = kind === 'office' ? (/\.(?:pp[ts][xm]?|pot[xm]?|odp)$/i.test(name) ? 'slides' : 'word')
    : kind === 'markdown' ? 'text' : kind;
  const key = 'local-' + symbol;
  return el('span', { class: 'file-icon kind-' + kind, 'aria-hidden': 'true' },
    icon(symbol === 'archive' ? 'archive' : Object.hasOwn(localPaths, key) ? key : 'local-file', symbol === 'archive' ? 22 : 30));
}

export function previewIssue(error, fallback = '无法读取预览，请重试。') {
  const message = typeof error === 'string' ? error : error?.message || '';
  const safe = /^(?:(?:OneDrive|Windows|Microsoft|PDF|Markdown) )?[\u3400-\u9fff]/u.test(message) &&
    !/[:\\/\r\n]/.test(message) && message.length <= 100;
  const text = safe ? message : fallback;
  if (error?.name === 'AbortError' || /已取消|预览已关闭/.test(message)) return { text: '预览已取消。', retry: false, original: false };
  if (/拒绝访问|没有权限|无权|登录已过期|账户已切换|文件或会话不存在|文件已不存在/.test(message)) {
    return { text, retry: false, original: false };
  }
  const fixed = /无法解码|已加密，请|超出预览|预览上限|超过 (?:16 MB|384 KB)|不是文本|含有二进制|此格式可下载|引擎不可用/.test(message);
  return { text, retry: !fixed, original: true };
}

export function time(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = String(Math.floor(total / 60) % 60).padStart(2, '0');
  return (hours ? hours + ':' : '') + minutes + ':' + String(total % 60).padStart(2, '0');
}

export function bytes(value) {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const order = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return Number((value / 1024 ** order).toFixed(order ? 1 : 0)) + ' ' + units[order];
}

export function date(value, full = false) {
  if (!value) return '—';
  const stamp = new Date(value);
  if (!Number.isFinite(stamp.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit',
    ...(full ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) }).format(stamp);
}
