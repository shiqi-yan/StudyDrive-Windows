import { button, el, icon, previewIssue, time } from './ui.mjs';
import { clamp } from './player-math.mjs';

const rates = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export function buildPlayer(opened, settings, toast, actions) {
  const { item, key } = opened;
  const api = window.study;
  const video = item.kind === 'video';
  const lifecycle = new AbortController();
  const listen = (node, event, cb, options) => node.addEventListener(event, cb, { ...options, signal: lifecycle.signal });
  const stage = el('div', { class: 'player-stage', tabindex: '0', 'aria-label': item.name + ' 播放器', 'data-player': 'mpv' });
  const screen = el('div', { class: 'media-screen' });
  if (!video) screen.append(el('div', { class: 'audio-mark' }, icon('audio', 46), el('span', {}, item.name)));
  const status = el('div', { class: 'player-status', role: 'status' });
  const seek = el('input', { type: 'range', min: 0, max: 1, value: 0, step: 0.1, class: 'seek', 'aria-label': '播放进度' });
  const volume = el('input', { type: 'range', min: 0, max: 100, value: settings.volume ?? 100, step: 1, class: 'volume', 'aria-label': '音量' });
  const clock = el('span', { class: 'player-time' });
  const speed = el('select', { class: 'player-select', 'aria-label': '播放倍速' }, rates.map(rate => el('option', { value: rate }, rate + '×')));
  const audio = el('select', { class: 'player-select track-select', 'aria-label': '音轨' });
  const subtitle = el('select', { class: 'player-select track-select', 'aria-label': '字幕' });
  const play = button('播放', event => { toggle(); pointerFocus(event); }, { symbol: 'play', compact: true });
  const mute = button('静音', event => { control('mute', !state.muted); pointerFocus(event); }, { symbol: 'volume', compact: true });
  const full = button('全屏', event => { fullscreen(); pointerFocus(event); }, { symbol: 'fullscreen', compact: true });
  const subFile = button('外挂字幕', event => {
    api.playerSubtitle(key).catch(() => { if (!closed) toast('无法读取所选字幕。'); });
    pointerFocus(event);
  }, { className: 'subtitle-file' });
  stage.append(screen, status, el('div', { class: 'player-controls' }, seek, el('div', { class: 'player-buttons' },
    play, clock, mute, volume, el('span', { class: 'spacer' }), speed,
    el('label', { class: 'track-control' }, '音轨', audio), video ? el('label', { class: 'track-control' }, '字幕', subtitle) : null,
    video ? subFile : null, full)));

  let state = { ready: false, time: opened.position || 0, duration: 0, paused: true,
    rate: settings.rate || 1, volume: settings.volume ?? 100, muted: settings.muted === true, tracks: [] };
  let closed = false;
  let frame;
  let scrub;
  let desired;
  let trackSignature;
  let starting = false;

  function focus() { stage.focus({ preventScroll: true }); }
  function pointerFocus(event) { if (event.detail > 0) focus(); }
  function control(name, value) {
    if (!state.ready || closed) return;
    api.playerControl(key, name, value).catch(() => { if (!closed) toast('播放操作暂时不可用。'); });
  }
  function toggle() { control('pause', !state.paused); }
  function fullscreen() {
    if (!stage.isConnected) return;
    const request = document.fullscreenElement === stage ? document.exitFullscreen() : stage.requestFullscreen();
    request.catch(() => { if (!closed) toast('暂时无法切换全屏。'); });
  }
  function position(value) {
    if (!state.ready || !state.seekable || !(state.duration > 0)) return;
    desired = clamp(0, value, state.duration);
    control('seek', desired);
    drawTime();
  }
  function drawTime() {
    const position = scrub ?? desired ?? state.time;
    seek.max = String(state.duration || 1);
    seek.value = String(position || 0);
    clock.textContent = time(position) + ' / ' + time(state.duration);
  }
  function bounds(hidden = false) {
    const rect = screen.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height,
      visible: !hidden && video && stage.isConnected && !document.hidden && !document.querySelector('dialog[open]') };
  }
  function resize() {
    if (!stage.isConnected || closed || frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (stage.isConnected && !closed) api.playerBounds(key, bounds()).catch(() => {});
    });
  }
  function labelButton(control, text, symbol) {
    if (control.getAttribute('aria-label') === text) return;
    control.title = text;
    control.setAttribute('aria-label', text);
    control.replaceChildren(icon(symbol, 16));
  }
  function fillTracks() {
    const signature = JSON.stringify(state.tracks);
    if (signature === trackSignature) return;
    trackSignature = signature;
    for (const [select, type] of [[audio, 'audio'], [subtitle, 'sub']]) {
      const tracks = state.tracks.filter(track => track.type === type);
      const text = type === 'audio' ? (tracks.length ? '自动' : '无可选音轨') : '关闭字幕';
      select.replaceChildren(el('option', { value: 0, disabled: type === 'audio' ? '' : undefined }, text),
        ...tracks.map(track => el('option', { value: track.id }, (track.external ? '外挂 · ' : '') + (track.label || (type === 'audio' ? '音轨 ' : '字幕 ') + track.id))));
      select.value = String(tracks.find(track => track.selected)?.id || 0);
    }
  }
  let statusKey;
  function draw() {
    if (closed) return;
    stage.dataset.ready = String(!!state.ready);
    stage.dataset.time = String(state.time);
    stage.dataset.duration = String(state.duration);
    stage.dataset.paused = String(!!state.paused);
    stage.dataset.rate = String(state.rate);
    stage.dataset.volume = String(state.volume);
    stage.dataset.muted = String(!!state.muted);
    stage.dataset.seeking = String(!!state.seeking);
    labelButton(play, state.paused || state.ended ? '播放' : '暂停', state.paused || state.ended ? 'play' : 'pause');
    labelButton(mute, state.muted ? '取消静音' : '静音', state.muted ? 'muted' : 'volume');
    if (document.activeElement !== volume) volume.value = String(state.volume);
    speed.value = String(state.rate);
    fillTracks();
    for (const node of [play, mute, volume, speed, subFile]) node.disabled = !state.ready;
    audio.disabled = !state.ready || !state.tracks.some(track => track.type === 'audio');
    subtitle.disabled = !state.ready || !state.tracks.some(track => track.type === 'sub');
    seek.disabled = !state.ready || !state.seekable;
    drawTime();
    const issue = state.error ? previewIssue(state.error) : null;
    const message = issue?.text || state.notice || (!state.ready ? '正在打开媒体…'
      : state.seeking ? '正在跳转…' : state.buffering ? '正在缓冲…' : state.ended ? '播放结束' : '');
    if (message !== statusKey) {
      if (state.error) actions.readFailure(new Error(state.error));
      statusKey = message;
      status.hidden = !message;
      status.replaceChildren(message,
        ...(issue?.retry ? [button('重试', start)] : []),
        ...(issue?.original ? [button('下载原件', actions.download, { symbol: 'download' })] : []));
    }
  }
  const unsubscribe = api.onPlayerState((id, update) => {
    if (closed || key !== id) return;
    state = update;
    if (!update.seeking && desired != null && (update.error || update.notice || Math.abs(update.time - desired) <= .7)) desired = undefined;
    draw();
  });
  async function start() {
    if (starting || closed || !stage.isConnected) return;
    starting = true;
    state = { ...state, ready: false, error: '', notice: '' };
    desired = undefined;
    draw();
    try { state = await api.playerStart(key, bounds()); }
    catch (error) { if (!closed) state.error = error.message || '无法启动 mpv 播放器。'; }
    finally {
      starting = false;
      if (!closed) { draw(); resize(); }
    }
  }
  listen(screen, 'dblclick', fullscreen);
  listen(seek, 'input', () => { scrub = Number(seek.value); drawTime(); });
  listen(seek, 'change', () => { const value = Number(seek.value); scrub = undefined; position(value); });
  listen(seek, 'blur', () => { scrub = undefined; drawTime(); });
  listen(volume, 'change', () => { control('mute', false); control('volume', Number(volume.value)); });
  listen(speed, 'change', () => control('speed', Number(speed.value)));
  listen(audio, 'change', () => control('audio', Number(audio.value)));
  listen(subtitle, 'change', () => control('sub', Number(subtitle.value)));
  for (const control of [seek, volume, speed, audio, subtitle]) listen(control, 'pointerup', event => {
    if (event.pointerType === 'mouse' && control.tagName === 'INPUT') focus();
  });
  listen(document, 'keydown', event => {
    if (!stage.isConnected || event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
        document.querySelector('dialog[open]')) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.isContentEditable || target?.closest('input,textarea,select,[role="textbox"],[role="slider"],[role="menu"]')) return;
    const key = event.key.toLowerCase();
    if (key === ' ' && target?.closest('button,summary,a,[role="button"]')) return;
    const setVolume = step => { control('mute', false); control('volume', clamp(0, state.volume + step, 100)); };
    const commands = { ' ': toggle, arrowleft: () => position((desired ?? state.time) - 5),
      arrowright: () => position((desired ?? state.time) + 5), arrowup: () => setVolume(5),
      arrowdown: () => setVolume(-5), m: () => control('mute', !state.muted), f: fullscreen };
    if (!Object.hasOwn(commands, key)) return;
    event.preventDefault();
    if (!event.repeat) commands[key]();
  });
  const observer = new ResizeObserver(resize);
  observer.observe(screen);
  const dialogObserver = new MutationObserver(resize);
  dialogObserver.observe(document.querySelector('#dialog'), { attributes: true, attributeFilter: ['open'] });
  listen(window, 'resize', resize);
  listen(document, 'scroll', resize, { capture: true, passive: true });
  listen(document, 'fullscreenchange', resize);
  listen(document, 'visibilitychange', resize);
  draw();
  return {
    view: stage,
    focus() { focus(); start(); },
    async close() {
      closed = true;
      unsubscribe();
      lifecycle.abort();
      observer.disconnect();
      dialogObserver.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      await api.playerBounds(key, bounds(true)).catch(() => {});
      if (document.fullscreenElement === stage) await document.exitFullscreen().catch(() => {});
    }
  };
}
