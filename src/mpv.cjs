const { join } = require('node:path');

const formats = { flag: 3, number: 5, node: 6 };
const events = { end: 7, loaded: 8, restart: 21, property: 22, command: 5 };
const stateFields = {
  'time-pos': ['time', formats.number], duration: ['duration', formats.number],
  pause: ['paused', formats.flag], volume: ['volume', formats.number], mute: ['muted', formats.flag],
  speed: ['rate', formats.number], seeking: ['seeking', formats.flag],
  'paused-for-cache': ['buffering', formats.flag], seekable: ['seekable', formats.flag],
  'track-list': ['tracks', formats.node], 'vo-configured': ['hasVideo', formats.flag],
  'eof-reached': ['ended', formats.flag]
};
const endFileError = 4;
const endOfFile = 0;
const seekCommand = 1;
const subtitleCommand = 2;
const loadCommand = 3;
let bindings;

function openBindings(applicationPath) {
  if (bindings) return bindings;
  const koffi = require('koffi');
  const lib = koffi.load(join(applicationPath, 'vendor', 'mpv', 'libmpv-2.dll'));
  const Event = koffi.struct({ id: 'int', error: 'int', reply: 'uint64_t', data: 'void *' });
  const Property = koffi.struct({ name: 'str', format: 'int', data: 'void *' });
  const Node = koffi.struct({ data: 'uint64_t', format: 'int' });
  const List = koffi.struct({ count: 'int', values: 'void *', keys: 'void *' });
  function tracks(data) {
    const array = koffi.decode(data, Node);
    if (array.format !== 7 || !array.data) return [];
    const list = koffi.decode(BigInt(array.data), List);
    if (list.count < 1 || list.count > 256) return [];
    return koffi.decode(list.values, Node, list.count).flatMap(entry => {
      if (entry.format !== 8 || !entry.data) return [];
      const map = koffi.decode(BigInt(entry.data), List);
      if (map.count < 1 || map.count > 128) return [];
      const names = koffi.decode(map.keys, koffi.array('str', map.count));
      const values = koffi.decode(map.values, Node, map.count);
      function field(name) {
        const value = values[names.indexOf(name)];
        if (value?.format === 1 && value.data) return koffi.decode.string(BigInt(value.data)).slice(0, 100);
        if (value?.format === 3) return !!(BigInt(value.data) & 0xffffffffn);
        if (value?.format === 4) return Number(value.data);
        return undefined;
      }
      const id = field('id');
      const type = field('type');
      if (!Number.isSafeInteger(id) || id < 1 || !['audio', 'sub'].includes(type)) return [];
      return [{ id, type, selected: !!field('selected'), label: [field('lang'), field('title'), field('codec')].filter(Boolean).join(' · '), external: !!field('external') }];
    });
  }
  bindings = {
    create: lib.func('void *mpv_create()'),
    option: lib.func('int mpv_set_option_string(void *, str, str)'),
    initialize: lib.func('int mpv_initialize(void *)'),
    observe: lib.func('int mpv_observe_property(void *, uint64_t, str, int)'),
    send: lib.func('int mpv_command_async(void *, uint64_t, const char **)'),
    wait: lib.func('void *mpv_wait_event(void *, double)'),
    destroy: lib.func('void mpv_terminate_destroy(void *)'),
    event: pointer => koffi.decode(pointer, Event),
    property: pointer => koffi.decode(pointer, Property),
    value(property) {
      if (property.format === formats.flag) return !!koffi.decode.int(property.data);
      if (property.format === formats.number) return koffi.decode.double(property.data);
      if (property.format === formats.node) return tracks(property.data);
    },
    code: pointer => koffi.decode.int(pointer),
    error: pointer => koffi.decode(pointer, 4, 'int')
  };
  return bindings;
}

class NativePlayer {
  constructor(applicationPath, host, source, preferences, onState) {
    this.api = openBindings(applicationPath);
    this.onState = onState;
    this.source = source;
    this.resume = preferences.position || 0;
    this.state = {
      ready: false, time: this.resume, duration: 0, paused: true,
      volume: preferences.volume ?? 100, muted: preferences.muted === true, rate: preferences.rate || 1,
      seeking: false, buffering: false, seekable: false, tracks: [], hasVideo: false, hasAudio: false, ended: false, error: ''
    };
    this.last = this.resume;
    const api = this.api;
    this.handle = api.create();
    try {
      if (!this.handle) throw new Error('无法初始化 mpv。');
      const options = {
        config: 'no', 'load-scripts': 'no', ytdl: 'no', 'autoload-files': 'no', 'sub-auto': 'no',
        'audio-file-auto': 'no', 'cover-art-auto': 'no', 'input-default-bindings': 'no',
        'input-vo-keyboard': 'no', 'input-cursor': 'no', 'input-cursor-passthrough': 'yes',
        'input-media-keys': 'no', osc: 'no', 'idle': 'yes', 'keep-open': 'yes', pause: 'yes',
        'terminal': 'no', 'load-unsafe-playlists': 'no', 'network-timeout': '15',
        'cache': 'yes', 'cache-on-disk': 'no', 'cache-secs': '6',
        'demuxer-max-bytes': '33554432', 'demuxer-max-back-bytes': '8388608',
        'http-header-fields': 'X-Study-Native: ' + source.secret,
        speed: String(this.state.rate), volume: String(this.state.volume), mute: this.state.muted ? 'yes' : 'no',
        ao: 'wasapi', 'audio-fallback-to-null': 'no',
        ...(host ? { wid: String(host), vo: 'gpu', 'gpu-api': 'd3d11', 'gpu-context': 'd3d11' } : { vid: 'no', vo: 'null' })
      };
      for (const [name, value] of Object.entries(options)) {
        if (api.option(this.handle, name, value) < 0) throw new Error('mpv 无法配置 ' + name + '。');
      }
      if (api.initialize(this.handle) < 0) throw new Error('无法初始化 mpv。');
      for (const [name, [, format]] of Object.entries(stateFields)) api.observe(this.handle, 0, name, format);
      this.timer = setInterval(() => this.pump(), 75);
      this.send(['loadfile', source.url, 'replace', '0', 'demuxer=lavf,demuxer-lavf-format=' + source.demuxer], loadCommand);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  send(command, request = 0) {
    if (!this.handle || this.api.send(this.handle, request, [...command, null]) < 0) throw new Error('mpv 未接受此操作。');
  }

  pump() {
    try {
      let updated = false;
      for (let i = 0; i < 100; i += 1) {
        const event = this.api.event(this.api.wait(this.handle, 0));
        if (!event.id) break;
        if (event.id === events.property) {
          const property = this.api.property(event.data);
          if (property.data && Object.hasOwn(stateFields, property.name)) this.state[stateFields[property.name][0]] = this.api.value(property);
        } else if (event.id === events.loaded) {
          if (this.resume > 0) this.seek(this.resume);
        } else if (event.id === events.restart) {
          this.state.ready = true;
        } else if (event.id === 18) {
          this.state.hasAudio = true;
        } else if (event.id === events.end) {
          const reason = this.api.code(event.data);
          if (reason === endOfFile) this.state.ended = this.state.paused = true;
          if (reason === endFileError || reason === 5) this.fail(this.api.error(event.data));
        } else if (event.id === events.command && event.error < 0) {
          if (Number(event.reply) === subtitleCommand) this.state.notice = '无法读取所选字幕。';
          if (Number(event.reply) === seekCommand) { this.pendingSeek = null; this.state.notice = '无法跳转到该位置。'; }
          if (Number(event.reply) === loadCommand) this.fail(event.error);
        }
        updated = true;
      }
      if (this.pendingSeek != null && !this.state.seeking && Math.abs(this.pendingSeek - this.state.time) <= 0.7) this.pendingSeek = null;
      if (this.pendingSeek == null && this.state.ready && !this.state.seeking && Number.isFinite(this.state.time)) this.last = this.state.time;
      if (updated) this.publish();
    } catch {
      this.fail();
      this.publish();
    }
  }

  fail(code) {
    this.state.error = code === -14 ? '无法启用 Windows 音频输出。'
      : code === -15 ? '当前设备无法初始化 mpv 视频输出。'
        : [-17, -18].includes(code) ? '此媒体的封装或编码无法解码，请下载原件查看。'
          : '媒体播放中断，请重试。';
    this.state.paused = true;
    this.state.ready = false;
  }

  publish() {
    this.onState({ ...this.state, seeking: this.state.seeking || this.pendingSeek != null, ...(this.pendingSeek != null ? { time: this.pendingSeek } : {}) });
  }

  seek(time) {
    const duration = this.state.duration;
    this.pendingSeek = Math.max(0, Math.min(time, duration || time));
    this.state.ended = false;
    this.send(['seek', String(this.pendingSeek), 'absolute+exact'], seekCommand);
    this.publish();
  }

  addSubtitle(filename) {
    this.state.notice = '';
    // The movie demuxer has already opened. Let libavformat sniff the chosen SRT/VTT.
    this.send(['set', 'demuxer-lavf-format', '']);
    this.send(['sub-add', filename, 'select'], subtitleCommand);
  }

  close() {
    clearInterval(this.timer);
    const handle = this.handle;
    this.handle = null;
    if (handle) this.api.destroy(handle);
  }
}

module.exports = { NativePlayer };
