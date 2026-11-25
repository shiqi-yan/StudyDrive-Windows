const { Worker } = require('node:worker_threads');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { extension, itemPath, statusError, redirectCodes } = require('./drive.cjs');
const { fetchContent } = require('./media.cjs');

const mib = 1024 ** 2;
const limits = { sheet: 16 * mib, markdown: 384 * 1024, text: 8 * mib };
function documentLimit(item) {
  if (item.kind === 'sheet' && item.size > limits.sheet) return '表格超过 16 MB，可下载原件。';
  if (item.kind === 'markdown' && item.size > limits.markdown) return 'Markdown 超过 384 KB，可下载原件。';
  return '';
}
const sheetPageView = item => item.kind === 'sheet' && /^(xls|xlsx)$/.test(extension(item.name));
const localDocument = item => Object.hasOwn(limits, item.kind);
const originalLink = (drive, account, item) => (signal, stale) => drive.content(account, item.id, signal, item.version, !!stale);
const conversionFailure = message => Object.assign(new Error(message), { officeFallback: true });

async function convertedLink(drive, account, item, lifetime, deadline = 60000) {
  const timeout = AbortSignal.timeout(deadline);
  const signal = AbortSignal.any([lifetime, timeout]);
  const assertVersion = async () => {
    if ((await drive.get(account, item.id, signal)).version !== item.version) {
      throw new Error('文件版本已更新，请重新打开预览。');
    }
  };
  const route = itemPath(account.driveId, item.id) + '/content?format=pdf';
  try {
    await assertVersion();
    for (;;) {
      const response = await drive.response(route, { signal }, 'manual');
      await response.body?.cancel();
      if (redirectCodes.has(response.status)) {
        const signed = drive.transferUrl(response.headers.get('location'), 'conversion');
        await assertVersion();
        return signed;
      }
      if ([400, 405, 406, 413, 415, 422, 501].includes(response.status)) throw conversionFailure('OneDrive 无法转换此文档，文件可能已加密、损坏或格式不受支持。');
      if (response.status === 500) throw conversionFailure('OneDrive 转换服务暂时不可用。');
      if (![202, 429, 502, 503, 504].includes(response.status)) throw statusError(response.status);
      const retryAfter = response.headers.get('retry-after');
      const retryMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
      await delay(Math.min(deadline, Math.max(500, retryMs || 1500)), undefined, { signal });
    }
  } catch (error) {
    if (timeout.aborted && !lifetime.aborted) throw conversionFailure('等待 OneDrive 转换超时，请重试或下载原件。');
    throw error;
  }
}

async function warmPdf(ticket) {
  const { drive, account, item, controller, cache } = ticket;
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(95000)]);
  try {
    const response = await fetchContent(drive, account, item, 'bytes=0-4', signal, cache, signal);
    if (!response.ok) {
      await response.body?.cancel();
      const error = statusError(response.status);
      if ([429, 500, 502, 503, 504].includes(response.status)) error.officeFallback = true;
      throw error;
    }
    const reader = response.body?.getReader();
    let header = Buffer.alloc(0);
    try {
      while (reader && header.length < 5) {
        const { done, value } = await reader.read();
        if (done) break;
        header = Buffer.concat([header, value.subarray(0, 5 - header.length)]);
      }
    } finally { await reader?.cancel().catch(() => {}); }
    if (header.toString() !== '%PDF-') throw conversionFailure('OneDrive 未返回可用的 PDF，请重试或下载原件。');
  } catch (error) {
    if (!controller.signal.aborted && signal.aborted) throw conversionFailure('等待 OneDrive PDF 预览超时，请重试。');
    throw error;
  }
}

async function loadBytes(ticket) {
  const { drive, account, item, controller, cache } = ticket;
  const limit = limits[item.kind];
  const partial = item.kind === 'text';
  const tooLarge = () => new Error(item.kind === 'sheet' ? '表格超过 16 MB，请下载原件或在 OneDrive 中打开。' : 'Markdown 超过 384 KB，请下载原件。');
  if (!partial && item.size > limit) throw tooLarge();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(55000)]);
  try {
    const response = await fetchContent(drive, account, item, partial && item.size > limit ? 'bytes=0-' + (limit - 1) : undefined, signal, cache, signal);
    if (!response.ok) {
      await response.body?.cancel();
      throw statusError(response.status);
    }
    const contentType = response.headers.get('content-type') || '';
    if (partial && /^(?:image\/|video\/|audio\/|application\/(?:pdf|zip|gzip|x-msdownload)(?:[;\s]|$))/i.test(contentType)) {
      await response.body?.cancel().catch(() => {});
      throw new Error('OneDrive 返回的文件类型不是文本。');
    }
    const range = response.status === 206 ? /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(response.headers.get('content-range') || '') : null;
    if (range && (Number(range[1]) !== 0 || !partial && range[3] !== String(Number(range[2]) + 1))) {
      await response.body?.cancel().catch(() => {});
      throw new Error('OneDrive 未返回从文件开头开始的完整预览数据，请重试。');
    }
    const declaredLength = range ? Number(range[2]) - Number(range[1]) + 1 : Number(response.headers.get('content-length'));
    const reader = response.body?.getReader();
    const parts = [];
    let count = 0;
    let truncated = partial && (declaredLength > limit || !!range && (range[3] === '*' || Number(range[3]) > declaredLength));
    try {
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        const available = limit - count;
        if (value.length > available) {
          if (!partial) throw tooLarge();
          parts.push(value.subarray(0, available));
          count += available;
          truncated = true;
          break;
        }
        parts.push(value);
        count += value.length;
        if (truncated && count === limit) break;
      }
    } finally { await reader?.cancel().catch(() => {}); }
    if (declaredLength > 0 && count < Math.min(declaredLength, limit)) throw new Error('OneDrive 文件传输提前结束，请重试。');
    return { buffer: Uint8Array.from(Buffer.concat(parts, count)).buffer, count, truncated };
  } catch (error) {
    if (!controller.signal.aborted && signal.aborted) throw new Error('读取预览内容超时，请重试。');
    if (error instanceof Error && !/^(?:(?:OneDrive|Windows|Microsoft) )?[\u3400-\u9fff]/u.test(error.message) && !controller.signal.aborted) {
      throw new Error('读取 OneDrive 文件时连接中断，请重试。');
    }
    throw error;
  }
}

class DocumentSession {
  constructor(ticket) {
    this.ticket = ticket;
    this.pending = new Map();
    this.sequence = 0;
  }
  async request(operation, input) {
    if (this.closed) throw new Error('当前预览已关闭，请重试。');
    this.ready ||= this.start();
    await this.ready;
    if (this.closed) throw new Error('当前预览已关闭，请重试。');
    return this.send(operation, input);
  }
  async start() {
    const { item, controller } = this.ticket;
    const data = await loadBytes(this.ticket);
    controller.signal.throwIfAborted();
    this.worker = new Worker(join(__dirname, 'document-worker.cjs'), {
      workerData: { ...data, kind: item.kind, ext: extension(item.name) },
      transferList: [data.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 }
    });
    this.worker.on('message', ({ seq, result, error }) => {
      const entry = this.pending.get(seq);
      if (!entry) return;
      this.pending.delete(seq);
      clearTimeout(entry.timer);
      if (error) entry.reject(new Error(error));
      else entry.resolve(result);
    });
    this.worker.on('error', error => this.close(error.code === 'ERR_WORKER_OUT_OF_MEMORY'
      ? '此文件超过本机预览资源上限，请下载原件。' : 'Windows 文档预览工作进程意外退出，请重试。'));
    this.worker.on('exit', () => this.close('文档解析已结束，请重试。'));
  }
  send(operation, input) {
    if (this.pending.size >= 6) throw new Error('文档处理繁忙，请稍后重试。');
    const seq = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close('文档处理超时，请重试或下载原件。'), 15000);
      this.pending.set(seq, { resolve, reject, timer });
      this.worker.postMessage({ seq, operation, input });
    });
  }
  close(message = '当前预览已关闭。') {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    this.pending.clear();
    this.worker?.terminate().catch(() => {});
  }
}

function imageName(source) {
  if (typeof source !== 'string' || source.length > 1024) return '';
  let name;
  try { name = decodeURIComponent(source.replace(/^\.\//, '')); } catch { return ''; }
  if (!name || name.length > 255 || ['.', '..'].includes(name) || /[\\/:?#\u0000-\u001f]/.test(name)) return '';
  return name;
}

module.exports = { convertedLink, warmPdf, originalLink, localDocument, sheetPageView, documentLimit, DocumentSession, imageName };
