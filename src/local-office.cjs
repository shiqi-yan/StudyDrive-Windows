const fs = require('node:fs/promises');
const { createWriteStream, existsSync } = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { extension, statusError } = require('./drive.cjs');
const { fetchContent } = require('./media.cjs');

const enginePackage = '@deepseek-ai/libreoffice-kit-win32-x64';
const crtFiles = ['msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'msvcp140_atomic_wait.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
const formats = new Set(['doc', 'docx', 'ppt', 'pptx', 'odt', 'odp']);
const maxInput = 32 * 1024 ** 2;
const maxPdf = 32 * 1024 ** 2;
const tooLarge = () => new Error('此文件超过本机 Office 预览的大小限制。');
const canTryOnline = message => Object.assign(new Error(message), { officeOnlineFallback: true });

function supportsLocal(item) { return formats.has(extension(item.name)); }

class LocalOffice {
  constructor(profile, version) {
    this.profile = path.resolve(profile);
    this.installed = version === '0.2.3' && process.platform === 'win32' && process.arch === 'x64';
    this.queue = Promise.resolve();
    this.pending = 0;
    this.version = version;
  }
  get readiness() {
    if (!this.installed) return 'missing';
    try {
      const root = path.dirname(require.resolve(enginePackage + '/package.json'));
      const bin = path.join(root, 'bin');
      if (!existsSync(path.join(bin, 'dsoffice.exe')) || !existsSync(path.join(root, 'program', 'program'))) return 'missing';
      const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
      return crtFiles.every(file => existsSync(path.join(bin, file)) || existsSync(path.join(system, file))) ? 'ready' : 'runtime';
    } catch { return 'missing'; }
  }
  clear() {
    clearTimeout(this.expiry);
    this.saved = null;
  }
  prepare(ticket, stage = () => {}) {
    this.pending += 1;
    const pending = this.queue.then(() => this.convert(ticket, stage)).finally(() => { this.pending -= 1; });
    this.queue = pending.catch(() => {});
    return pending;
  }
  async convert(ticket, stage = () => {}) {
    const { drive, account, item, controller, cache } = ticket;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(85000)]);
    signal.throwIfAborted();
    if (!this.installed) throw new Error('此版本未包含本机 Office 引擎。');
    if (item.size > maxInput) throw tooLarge();
    const assertVersion = async () => {
      const actual = await drive.get(account, item.id, signal);
      if (actual.version !== item.version) throw new Error('文件版本已更新，请重新打开预览。');
    };
    const key = JSON.stringify([account.id, item.driveId, item.id, item.version, this.version]);
    stage('正在读取 Office 原件…');
    await assertVersion();
    const cached = this.saved?.key === key ? this.saved.pdf : null;
    const original = await fetchContent(drive, account, item, cached ? 'bytes=0-0' : undefined, signal, {
      fetcher: cache.fetcher,
      getLink: (signal, stale) => drive.content(account, item.id, signal, item.version, !!stale)
    });
    if (!original.ok || !original.body) {
      await original.body?.cancel().catch(() => {});
      throw statusError(original.ok ? 502 : original.status);
    }
    if (cached) {
      await original.body.cancel().catch(() => {});
      signal.throwIfAborted();
      return cached;
    }
    if (Number(original.headers.get('content-length')) > maxInput) {
      await original.body.cancel().catch(() => {});
      throw tooLarge();
    }
    const dir = await fs.mkdtemp(path.join(this.profile, 'office-preview-')).catch(async error => {
      await original.body.cancel().catch(() => {});
      throw error;
    });
    let converter;
    const inputPath = path.join(dir, 'original.' + extension(item.name));
    let reading = true;
    try {
      const outputPath = path.join(dir, 'preview.pdf');
      let bytes = 0;
      const limit = new Transform({ transform(chunk, _encoding, done) {
        bytes += chunk.length;
        done(bytes > maxInput ? tooLarge() : null, chunk);
      } });
      await pipeline(Readable.fromWeb(original.body), limit, createWriteStream(inputPath, { flags: 'wx', mode: 0o600 }), { signal });
      reading = false;
      stage('正在本机转换为 PDF…');
      const { createConverter } = await import('@deepseek-ai/libreoffice-kit');
      const native = require.resolve(enginePackage + '/package.json');
      converter = await createConverter({
        resolveEnginePackage(name) {
          if (name !== enginePackage) throw new Error('Windows native engine required');
          return native;
        },
        fontMetadataCacheDirectory: false, timeoutMs: 45000, maxInputBytes: maxInput, maxOutputBytes: maxPdf
      });
      signal.throwIfAborted();
      await converter.render({ inputPath, outputPath }, signal);
      if ((await fs.stat(outputPath)).size > maxPdf) throw tooLarge();
      const pdf = await fs.readFile(outputPath);
      if (pdf.length > maxPdf) throw tooLarge();
      if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('本机未生成有效的 PDF。');
      await assertVersion();
      signal.throwIfAborted();
      this.clear();
      this.saved = { key, pdf };
      this.expiry = setTimeout(() => this.clear(), 90000);
      this.expiry.unref();
      return pdf;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('当前预览已关闭。');
      if (error.status) throw error;
      if (reading && signal.aborted) throw new Error('读取 Office 原件超时，请重试。');
      if (reading && !/^[\u3400-\u9fff]/u.test(error.message || '')) throw new Error('读取 Office 原件时连接中断，请重试。');
      if (signal.aborted || error.code === 'timeout') throw canTryOnline('本机 Office 转换超时，请重试。');
      if (['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(error.code)) throw canTryOnline('本机 Office 运行组件缺失，请重新获取课盘。');
      const nativeMessage = (error.message || '') + ' ' + (error.cause?.message || '');
      if (error.code === 'unavailable' || /c0000135|1073741515|vcruntime|msvcp140/i.test(nativeMessage)) {
        throw canTryOnline('本机 Office 引擎不可用，请检查 Windows VC++ v14 x64 运行库。');
      }
      if (error.code === 'unsupported-format') throw canTryOnline('本机 Office 引擎不支持此文档类型。');
      if (!reading) {
        const bytes = await fs.readFile(inputPath).catch(() => null);
        const encryptedPackage = bytes?.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])) &&
          bytes.includes(Buffer.from('EncryptionInfo', 'utf16le')) && bytes.includes(Buffer.from('EncryptedPackage', 'utf16le'));
        if (encryptedPackage || /password required|password.protected|encrypted document|请输入密码/i.test(nativeMessage)) {
          throw new Error('Office 文件已加密，请下载原件后使用密码打开。');
        }
      }
      if (/^[\u3400-\u9fff]/u.test(error.message || '')) throw error;
      throw new Error('本机 Office 无法解析此文档，文件可能损坏。');
    } finally {
      try { await converter?.dispose(); }
      finally {
        if (path.dirname(dir) === this.profile && path.basename(dir).startsWith('office-preview-')) {
          await fs.rm(dir, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
        }
      }
    }
  }
}

module.exports = { LocalOffice, supportsLocal, maxInput };
