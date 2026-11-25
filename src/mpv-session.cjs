const { utilityProcess } = require('electron');
const { join } = require('node:path');

let windows;
function nativeWindows() {
  if (windows) return windows;
  const lib = require('koffi').load('user32.dll');
  windows = {
    host: lib.func('uintptr_t CreateWindowExW(uint32_t, str16, str16, uint32_t, int, int, int, int, uintptr_t, uintptr_t, uintptr_t, void *)'),
    position: lib.func('int SetWindowPos(uintptr_t, uintptr_t, int, int, int, int, uint32_t)'),
    show: lib.func('int ShowWindow(uintptr_t, int)'),
    rect: lib.func('int GetClientRect(uintptr_t, void *)'),
    screenRect: lib.func('int GetWindowRect(uintptr_t, void *)'),
    dpi: lib.func('uint32_t GetDpiForWindow(uintptr_t)'),
    parent: lib.func('uintptr_t GetParent(uintptr_t)'),
    child: lib.func('uintptr_t GetWindow(uintptr_t, uint32_t)'),
    destroy: lib.func('int DestroyWindow(uintptr_t)')
  };
  return windows;
}

class VideoWindow {
  constructor(window) {
    this.window = window;
    this.api = nativeWindows();
    this.parent = window.getNativeWindowHandle().readBigUInt64LE();
    // The disabled child does not take focus away from the HTML controls.
    this.handle = this.api.host(0, 'STATIC', 'StudyDrive Media', 0x4c000000, 0, 0, 1, 1, this.parent, 0, 0, null);
    if (!this.handle) throw new Error('无法创建内置视频区域。');
  }
  hide() { if (this.handle) this.api.show(this.handle, 0); }
  resize({ x, y, width, height, visible }) {
    if (!this.handle || this.window.isDestroyed()) return;
    if (!visible || this.window.isMinimized()) { this.hide(); return; }
    const size = Buffer.alloc(16);
    if (!this.api.rect(this.parent, size)) return;
    const factor = this.api.dpi(this.parent) / 96 * this.window.webContents.getZoomFactor();
    const left = Math.max(0, Math.round(x * factor));
    const top = Math.max(0, Math.round(y * factor));
    const right = Math.min(size.readInt32LE(8), Math.round((x + width) * factor));
    const bottom = Math.min(size.readInt32LE(12), Math.round((y + height) * factor));
    if (right <= left || bottom <= top) { this.hide(); return; }
    this.api.position(this.handle, 0, left, top, right - left, bottom - top, 0x50);
  }
  diagnostic() {
    const child = this.handle && this.api.child(this.handle, 5);
    const bounds = Buffer.alloc(16);
    if (child) this.api.screenRect(child, bounds);
    return { embedded: !!child && this.api.parent(child) === this.handle &&
      this.api.parent(this.handle) === Number(this.parent), dpi: this.api.dpi(this.parent),
    windowHandle: Number(this.parent), bounds: [0, 4, 8, 12].map(offset => bounds.readInt32LE(offset)) };
  }
  close() { if (this.handle) this.api.destroy(this.handle); this.handle = 0; }
}

class PlayerSession {
  constructor(directory, window, source, preferences, bounds, onState) {
    this.video = source.video ? new VideoWindow(window) : null;
    this.last = preferences.position || 0;
    this.state = { ready: false, paused: true, time: this.last, duration: 0, tracks: [],
      rate: preferences.rate, volume: preferences.volume, muted: preferences.muted };
    try {
      this.video?.resize(bounds);
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:http|https|all)_proxy$/i.test(key)));
      env.no_proxy = env.NO_PROXY = '127.0.0.1,localhost';
      this.process = utilityProcess.fork(join(__dirname, 'mpv-worker.cjs'), [], { serviceName: 'StudyDrive Media', stdio: 'ignore', env });
      this.exited = new Promise(resolve => this.process.once('exit', resolve));
      this.exited.then(() => {
        this.dead = true;
        this.video?.hide();
        if (!this.closing && !this.state.error) {
          this.state = { ...this.state, ready: false, paused: true, error: source.failure() || '媒体播放进程中断，请重试。' };
          onState(this.state);
        }
      });
      this.process.on('message', message => {
        if (this.closing || message?.type !== 'state') return;
        this.last = message.last;
        this.state = message.state;
        if (this.state.error) {
          this.state.error = source.failure() || this.state.error;
          this.video?.hide();
        }
        onState(this.state);
      });
      this.process.postMessage({ type: 'start', directory, host: this.video?.handle || 0,
        source: { url: source.url, secret: source.secret, demuxer: source.demuxer }, preferences });
    } catch (error) {
      this.process?.kill();
      this.video?.close();
      throw error;
    }
  }
  resize(bounds) { if (!this.state.error && !this.closing) this.video?.resize(bounds); }
  diagnostic() { return { ...this.state, ...this.video?.diagnostic() }; }
  seek(time) { if (!this.dead) this.process.postMessage({ type: 'seek', time }); }
  send(args) { if (!this.dead) this.process.postMessage({ type: 'set', args }); }
  addSubtitle(file) { if (!this.dead) this.process.postMessage({ type: 'subtitle', file }); }
  close() {
    if (this.closing) return this.closing;
    this.video?.hide();
    this.closing = this.exited.finally(() => { clearTimeout(timeout); this.video?.close(); });
    const timeout = setTimeout(() => { if (!this.dead) this.process.kill(); }, 4000);
    if (!this.dead) this.process.postMessage({ type: 'close' });
    return this.closing;
  }
}

module.exports = { PlayerSession };
