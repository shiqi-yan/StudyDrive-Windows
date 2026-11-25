import { button, bytes, el } from './ui.mjs';

export function encodingSelect() {
  return el('select', { 'aria-label': '文本编码' },
    [['auto', '自动检测'], ['utf-8', 'UTF-8'], ['utf-16le', 'UTF-16 LE'], ['utf-16be', 'UTF-16 BE'],
      ['gbk', 'GBK'], ['gb18030', 'GB18030']].map(([value, label]) => el('option', { value }, label)));
}

export function findForm(label, action) {
  const input = el('input', { type: 'search', placeholder: label, 'aria-label': label, maxlength: 200 });
  const submit = el('button', { type: 'submit', class: 'button' }, '查找下一个');
  const form = el('form', { class: 'reader-find', onsubmit: event => {
    event.preventDefault();
    if (input.value && !submit.disabled) {
      submit.disabled = true;
      Promise.resolve(action(input.value)).finally(() => { submit.disabled = false; });
    }
  } }, input, submit);
  return form;
}

export async function documentView(root, opened, viewer) {
  const api = window.study;
  const ask = (operation, input) => api.document(opened.key, operation, input);
  const md = opened.view === 'markdown';
  const saved = opened.documentPosition || {};
  let source = !md || !!saved.source;
  let wrap = true;
  let data;
  let first = 0;
  let focused = saved.line || 0;
  let currentHeading = saved.heading || 0;
  let found = -1;
  let lastQuery;
  let busy = false;
  let renderId = 0;
  let headingNodes = [];
  const encoding = encodingSelect();
  encoding.value = saved.encoding || 'auto';
  const details = el('span', { class: 'reader-status', role: 'status' }, '正在读取文件…');
  const body = el('div', { class: 'reader-body text-reader', tabindex: '0', 'aria-label': '文档内容' });
  const toc = el('nav', { class: 'markdown-toc', 'aria-label': '标题目录', hidden: '' });
  const layout = el('div', { class: 'reader-layout' }, toc, body);
  const mode = button(source ? '排版' : '源码', () => switchMode());
  const wrapping = button('自动换行', () => {
    wrap = !wrap;
    body.classList.toggle('wrap-lines', wrap);
    wrapping.setAttribute('aria-pressed', String(wrap));
  });
  wrapping.setAttribute('aria-pressed', 'true');
  const prev = button('上一段', () => renderLines(first - 180).catch(error => viewer.error(error, body)));
  const next = button('下一段', () => renderLines(first + 180).catch(error => viewer.error(error, body)));
  const go = el('input', { type: 'number', min: 1, 'aria-label': '行号' });
  const jump = el('form', { class: 'pdf-page-form', onsubmit: event => {
    event.preventDefault();
    if (data && go.valueAsNumber) renderLines(go.valueAsNumber - 1).catch(error => viewer.error(error, body));
  } }, go, el('button', { type: 'submit', class: 'button' }, '跳到行'));
  const find = findForm('查找文字', async query => {
    if (!data || busy) return;
    try {
      const result = await ask('find', { query, start: lastQuery === query && found >= 0 ? found + 1 : 0 });
      if (!viewer.active()) return;
      lastQuery = query;
      if (!result) { details.textContent = '在已读范围内未找到'; return; }
      found = result.index;
      if (!source) { source = true; syncMode(); }
      await renderLines(found);
    } catch (error) { viewer.error(error, body); }
  });
  root.replaceChildren(el('div', { class: 'reader-toolbar' }, md ? mode : null, encoding, find, wrapping,
    prev, next, jump, details), layout);
  body.classList.toggle('wrap-lines', wrap);
  encoding.addEventListener('change', () => parse());
  body.addEventListener('scroll', () => remember());
  body.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (!link) return;
    event.preventDefault();
    if (link.hash) scrollHeading(document.getElementById(link.getAttribute('href').slice(1)));
  });

  function syncMode() {
    for (const control of [wrapping, prev, next, jump]) control.hidden = !source;
    mode.textContent = source ? '排版' : '源码';
    body.classList.toggle('markdown-reader', !source);
    toc.hidden = source || !data?.headings.length;
  }
  function remember() {
    if (!data || !viewer.active()) return;
    const top = body.getBoundingClientRect().top;
    if (source) {
      const visible = [...body.querySelectorAll('[data-line]')].find(node => node.getBoundingClientRect().bottom > top + 2);
      if (visible) focused = Number(visible.dataset.line);
    } else if (headingNodes.length) {
      currentHeading = Math.max(0, headingNodes.findLastIndex(node => node.getBoundingClientRect().top <= top + 32));
    }
    const position = { line: focused, encoding: encoding.value };
    viewer.remember(md ? { ...position, source: Number(source), heading: currentHeading } : position);
  }
  function rangeStatus(label) {
    const detected = encoding.value === 'auto' ? '自动识别 ' + data.encoding.toUpperCase() + ' · ' : '';
    details.textContent = detected + label + (data.truncated ? ' · 仅预览前 ' + bytes(data.count) + ' 内的最多 20 万行' : '');
  }
  async function renderLines(line) {
    const request = ++renderId;
    const index = Math.max(0, Math.min(data.lines - 1, line));
    first = Math.floor(index / 180) * 180;
    const values = await ask('lines', { start: first });
    if (!viewer.active() || request !== renderId) return;
    const rows = values.map((value, offset) => {
      const original = first + offset;
      return el('div', { 'data-line': original, class: 'text-line' + (original === found ? ' found-line' : '') },
        el('span', { class: 'line-number', 'aria-hidden': 'true' }, String(original + 1)),
        el('span', { class: 'line-content' }, value || '\u200b'));
    });
    body.replaceChildren(...rows);
    const target = rows[index - first];
    body.scrollTop = target ? target.offsetTop - rows[0].offsetTop : 0;
    go.value = index + 1;
    go.max = data.lines;
    prev.disabled = first === 0;
    next.disabled = first + values.length >= data.lines;
    rangeStatus('第 ' + (first + 1) + '–' + (first + values.length) + ' 行 / ' + data.lines);
    viewer.viewed();
    remember();
  }
  function scrollHeading(node) {
    if (!node || !body.contains(node)) return;
    body.scrollTop += node.getBoundingClientRect().top - body.getBoundingClientRect().top - 12;
    currentHeading = headingNodes.indexOf(node);
    viewer.remember({ source: 0, line: focused, heading: Math.max(0, currentHeading), encoding: encoding.value });
  }
  async function renderMarkdown() {
    const request = ++renderId;
    body.innerHTML = data.html;
    headingNodes = data.headings.map(heading => document.getElementById(heading.id));
    toc.replaceChildren(...data.headings.map(({ id, title, level }) => button(title || '未命名标题',
      () => scrollHeading(document.getElementById(id)), { className: 'quiet toc-level-' + level })));
    body.scrollTop = 0;
    viewer.viewed();
    scrollHeading(headingNodes[currentHeading]);
    remember();
    rangeStatus(bytes(data.count));
    // Resolve images in order to limit concurrent Graph and local image requests.
    for (const placeholder of [...body.querySelectorAll('.markdown-image')].slice(0, 48)) {
      if (!viewer.active() || request !== renderId) break;
      try {
        const url = await api.markdownImage(opened.key, placeholder.dataset.source);
        if (!url || request !== renderId || !viewer.active()) continue;
        const image = el('img', { alt: placeholder.textContent, crossorigin: 'anonymous', loading: 'lazy', src: url });
        image.addEventListener('error', () => { image.replaceWith(placeholder); }, { once: true });
        placeholder.replaceWith(image);
      } catch { /* Keep the image description visible if the file cannot be read. */ }
    }
  }
  function switchMode() {
    if (!data || busy) return;
    source = !source;
    syncMode();
    const shown = source ? renderLines(focused) : renderMarkdown();
    shown.catch(error => viewer.error(error, body));
  }
  async function parse() {
    if (busy) return;
    busy = true;
    encoding.disabled = true;
    details.textContent = '正在读取文件…';
    try {
      data = await ask('parse', { encoding: encoding.value });
      if (!viewer.active()) return;
      syncMode();
      if (source) await renderLines(focused);
      else renderMarkdown().catch(error => viewer.error(error, body));
    } catch (error) {
      data = null;
      details.textContent = '';
      viewer.error(error, body);
    } finally { busy = false; encoding.disabled = false; }
  }
  syncMode();
  await parse();
}
