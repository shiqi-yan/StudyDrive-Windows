import { button, el, previewIssue } from './ui.mjs';
import { buildPlayer } from './player.mjs';
import { documentView } from './document-view.mjs';
import { sheetView } from './sheet-view.mjs';

function status(text) {
  return el('p', { class: 'preview-message', role: 'status' }, text);
}

function slideNavigator(doc, current, go) {
  const rowHeight = 94;
  const surface = el('div', { class: 'slide-thumbnails-surface' });
  const view = el('nav', { class: 'slide-thumbnails', tabindex: '0', 'aria-label': '幻灯片缩略图' }, surface);
  const visible = new Map();
  surface.style.height = doc.numPages * rowHeight + 'px';
  let rendering;
  let scheduled;
  let drawing = false;
  let closed = false;
  function schedule() {
    if (!closed && scheduled == null) scheduled = requestAnimationFrame(sync);
  }
  function sync() {
    scheduled = null;
    const first = Math.max(1, Math.floor(view.scrollTop / rowHeight));
    const last = Math.min(doc.numPages, first + Math.ceil(view.clientHeight / rowHeight) + 2);
    for (const [number, entry] of visible) if (number < first || number > last) {
      if (rendering?.entry === entry) rendering.task.cancel();
      entry.node.remove();
      visible.delete(number);
    }
    for (let number = first; number <= last; number += 1) {
      let entry = visible.get(number);
      if (!entry) {
        const canvas = el('canvas', { 'aria-hidden': 'true' });
        const node = button('幻灯片 ' + number, () => go(number), { className: 'slide-thumbnail' });
        node.prepend(canvas);
        node.style.top = (number - 1) * rowHeight + 'px';
        surface.append(node);
        entry = { node, canvas };
        visible.set(number, entry);
      }
      if (number === current) entry.node.setAttribute('aria-current', 'page');
      else entry.node.removeAttribute('aria-current');
    }
    drawNext();
  }
  async function drawNext() {
    if (drawing || closed) return;
    const next = [...visible.entries()].find(([, entry]) => !entry.started);
    if (!next) return;
    const [number, entry] = next;
    entry.started = true;
    drawing = true;
    try {
      const page = await doc.getPage(number);
      if (closed || visible.get(number) !== entry) return;
      const original = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(126 / original.width, 62 / original.height) });
      entry.canvas.width = Math.max(1, Math.ceil(viewport.width));
      entry.canvas.height = Math.max(1, Math.ceil(viewport.height));
      const task = page.render({ canvas: entry.canvas, viewport });
      rendering = { entry, task };
      await task.promise;
    } catch { /* A thumbnail error leaves the slide number available for navigation. */ }
    finally { rendering = null; drawing = false; drawNext(); }
  }
  const observer = new ResizeObserver(schedule);
  observer.observe(view);
  view.addEventListener('scroll', schedule);
  const select = number => {
    current = number;
    const top = (number - 1) * rowHeight;
    if (top < view.scrollTop) view.scrollTop = top;
    else if (top + rowHeight > view.scrollTop + view.clientHeight) view.scrollTop = top + rowHeight - view.clientHeight;
    schedule();
  };
  return { view, select, close() {
    closed = true;
    observer.disconnect();
    if (scheduled != null) cancelAnimationFrame(scheduled);
    rendering?.task.cancel();
  } };
}

async function pdfPreview(root, opened, viewer, setDisposer) {
  const api = window.study;
  const progress = status(opened.note || (opened.source === 'local' ? '正在准备本机 Office 预览…'
    : opened.converted ? '正在等待 OneDrive 转换为 PDF…' : '正在加载 PDF…'));
  root.replaceChildren(progress);
  const detach = opened.converted ? api.onOfficeStage((key, text) => {
    if (key === opened.key && viewer.active()) progress.textContent = text;
  }) : () => {};
  let source;
  try { source = opened.converted ? await api.preparePdf(opened.key) : null; }
  finally { detach(); }
  if (!viewer.active()) return;
  const pdfjs = await import('/pdf/pdf.min.mjs');
  if (!viewer.active()) return;
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf/pdf.worker.min.mjs';
  const task = pdfjs.getDocument({ url: opened.url, isEvalSupported: false, cMapUrl: '/pdf/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/pdf/standard_fonts/', wasmUrl: '/pdf/wasm/', iccUrl: '/pdf/iccs/',
    disableAutoFetch: true, disableStream: true, rangeChunkSize: 65536 });
  let rendering;
  let observer;
  let slides;
  let encrypted = false;
  setDisposer(() => {
    observer?.disconnect();
    slides?.close();
    rendering?.cancel();
    task.destroy().catch(() => {});
  });
  task.onPassword = () => { encrypted = true; task.destroy().catch(() => {}); };
  let doc;
  try { doc = await task.promise; }
  catch {
    if (encrypted) throw new Error('PDF 已加密，请下载原件后使用密码打开。');
    const failure = await api.mediaStatus(opened.key).catch(() => '');
    throw new Error(failure || 'PDF 文件数据无法解析或读取不完整，请重试。');
  }
  if (!viewer.active()) return;
  let current = Math.max(1, Math.min(doc.numPages, opened.documentPosition?.page || 1));
  let zoom = 1;
  let revision = 0;
  let width = 0;
  const paper = el('div', { class: 'pdf-paper', tabindex: '0', 'aria-label': 'PDF 页面区域' });
  const canvas = el('canvas');
  const counter = el('span', { class: 'pdf-counter', 'aria-live': 'polite' });
  const field = el('input', { type: 'number', min: 1, max: doc.numPages, 'aria-label': 'PDF 页码' });
  const form = el('form', { class: 'pdf-page-form', onsubmit: event => {
    event.preventDefault();
    if (field.valueAsNumber) go(field.valueAsNumber);
  } }, field, button('跳转', () => { if (field.valueAsNumber) go(field.valueAsNumber); }));
  const previous = button('上一页', () => go(current - 1), { symbol: 'back', compact: true });
  const next = button('下一页', () => go(current + 1), { symbol: 'next', compact: true });
  const zoomOut = button('缩小', () => adjust(-0.25));
  const zoomIn = button('放大', () => adjust(0.25));
  const zoomReset = button('适合宽度', () => { zoom = 1; redraw(); });
  const full = button('全屏', () => {
    const action = document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen();
    action.catch(() => viewer.toast('当前窗口无法进入全屏。'));
  }, { symbol: 'fullscreen', compact: true });
  const hint = el('span', { role: 'status' });
  const bar = el('div', { class: 'pdf-toolbar reader-toolbar' }, previous, counter, next, form, zoomOut, zoomIn, zoomReset, full, hint);
  if (source) bar.append(el('span', { class: 'pdf-source' }, source === 'local' ? '本机转换' : 'OneDrive 转换'));
  paper.append(canvas);
  const go = number => {
    current = Math.max(1, Math.min(doc.numPages, Math.floor(number)));
    slides?.select(current);
    paper.scrollTop = 0;
    redraw();
  };
  const adjust = amount => { zoom = Math.min(2, Math.max(0.5, zoom + amount)); redraw(); };
  async function redraw() {
    const job = ++revision;
    const number = current;
    counter.textContent = number + ' / ' + doc.numPages;
    field.value = number;
    canvas.setAttribute('aria-label', 'PDF 第 ' + number + ' 页');
    previous.disabled = number <= 1;
    next.disabled = number >= doc.numPages;
    zoomOut.disabled = zoom <= 0.5;
    zoomIn.disabled = zoom >= 2;
    zoomReset.textContent = zoom === 1 ? '适合宽度' : Math.round(zoom * 100) + '%';
    try {
      if (rendering) {
        rendering.cancel();
        await rendering.promise.catch(() => {});
      }
      const page = await doc.getPage(number);
      if (!viewer.active() || job !== revision) return;
      const available = Math.min(1100, Math.max(paper.clientWidth - 36, 200));
      const original = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: zoom * available / original.width });
      const dpi = Math.min(Math.max(1, window.devicePixelRatio), 2, 4096 / Math.max(viewport.width, viewport.height));
      canvas.width = Math.max(1, Math.ceil(viewport.width * dpi));
      canvas.height = Math.max(1, Math.ceil(viewport.height * dpi));
      canvas.style.width = viewport.width + 'px';
      rendering = page.render({ canvas, viewport, transform: dpi === 1 ? null : [dpi, 0, 0, dpi, 0, 0] });
      await rendering.promise;
      if (job === revision && viewer.active()) {
        hint.textContent = '';
        viewer.viewed();
        viewer.remember({ page: number });
      }
    } catch (error) {
      if (viewer.active() && job === revision && error.name !== 'RenderingCancelledException') {
        if (!await viewer.hasViewed()) viewer.error(new Error('无法渲染 PDF 页面，请重试或下载原件。'));
        else hint.textContent = '无法渲染此页';
      }
    }
  }
  if (/\.(?:pptx?|ppsx?|odp)$/i.test(opened.item.name)) slides = slideNavigator(doc, current, go);
  root.replaceChildren(bar, el('div', { class: 'pdf-layout' }, slides?.view, paper));
  slides?.select(current);
  observer = new ResizeObserver(() => {
    if (width === paper.clientWidth) return;
    width = paper.clientWidth;
    redraw();
  });
  width = paper.clientWidth;
  observer.observe(paper);
  await redraw();
}

export function buildPreview(opened, settings, toast, actions) {
  const api = window.study;
  let viewed;
  const markViewed = () => { viewed ||= api.viewed(opened.key).then(() => true, () => false); };
  if (['video', 'audio'].includes(opened.view)) {
    return buildPlayer(opened, settings, toast, actions);
  }
  const root = el('div', { class: 'document-preview', tabindex: '-1' });
  let available = true;
  let dispose;
  let pending;
  let timer;
  const flush = async () => {
    clearTimeout(timer);
    if (!pending) return;
    const position = pending;
    pending = null;
    if (await viewed) await api.position(opened.key, position).catch(() => {});
  };
  const viewer = {
    active: () => available,
    viewed: markViewed,
    hasViewed: () => viewed || false,
    onClose: close => { dispose = close; },
    toast,
    remember(position) {
      pending = position;
      clearTimeout(timer);
      timer = setTimeout(flush, 250);
    },
    error(error, target = root) {
      if (!available) return;
      actions.readFailure(error);
      const issue = previewIssue(error);
      target.replaceChildren(el('div', { class: 'preview-error', role: 'alert' },
        el('p', {}, issue.text),
        el('div', {}, issue.retry ? button('重试', actions.retry, { symbol: 'refresh' }) : null,
          issue.original ? [button('在 OneDrive 打开', actions.web), button('下载原件', actions.download, { symbol: 'download' })] : null)));
    }
  };
  if (opened.limit) {
    viewer.error(new Error(opened.limit));
  } else if (opened.view === 'image') {
    const image = el('img', { alt: opened.item.name, crossorigin: 'anonymous' });
    image.addEventListener('load', markViewed, { once: true });
    image.addEventListener('error', () => viewer.error(new Error('无法加载此图片。')));
    image.src = opened.url;
    root.append(image);
  } else {
    let start;
    if (opened.view === 'pdf') start = pdfPreview(root, opened, viewer, close => { dispose = close; });
    else if (opened.view === 'sheet') start = sheetView(root, opened, viewer);
    else start = documentView(root, opened, viewer);
    start.catch(viewer.error);
  }
  return {
    view: root,
    focus() { root.focus({ preventScroll: true }); },
    async close() {
      available = false;
      dispose?.();
      if (document.fullscreenElement === root) await document.exitFullscreen().catch(() => {});
      await flush();
    }
  };
}
