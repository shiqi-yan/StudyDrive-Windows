const { NativePlayer } = require('./mpv.cjs');

let player;
const send = (state, last) => process.parentPort.postMessage({ type: 'state', state, last });
process.parentPort.on('message', ({ data }) => {
  try {
    if (data.type === 'close') {
      player?.close();
      process.exit(0);
    }
    if (data.type === 'start' && !player) player = new NativePlayer(data.directory, data.host, data.source, data.preferences,
      state => send(state, player?.last || 0));
    if (!player) return;
    if (data.type === 'seek') player.seek(data.time);
    if (data.type === 'set') player.send(data.args);
    if (data.type === 'subtitle') player.addSubtitle(data.file);
  } catch {
    send({ ...player?.state, ready: false, paused: true, tracks: [], error: '媒体播放器无法完成此操作，请重试。' }, player?.last || 0);
  }
});
