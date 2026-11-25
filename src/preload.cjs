const { contextBridge, ipcRenderer } = require('electron');
const operations = [
  'initial', 'demo', 'login', 'cancelLogin', 'switchAccount', 'signOut', 'library', 'quota',
  'list', 'openFolder', 'rename', 'mkdir', 'move', 'remove', 'favorite', 'history', 'open', 'release',
  'search', 'cancelSearch', 'searchFolder', 'indexStatus', 'indexRefresh',
  'transfers', 'transferAction', 'transferEntries', 'upload', 'download', 'batchPlan', 'batchStart', 'trash', 'cloudTrash', 'cloudTrashRefresh', 'cloudTrashCancel', 'cloudTrashRestore',
  'viewed', 'position', 'preparePdf', 'mediaStatus', 'document', 'markdownImage', 'openWeb', 'copyText',
  'playerStart', 'playerBounds', 'playerControl', 'playerSubtitle'
];
const api = Object.fromEntries(operations.map(name => [name, async (...args) => {
  const result = await ipcRenderer.invoke('drive:' + name, ...args);
  if (result.error) throw new Error(result.error);
  return result.data;
}]));
const versionFlag = '--study-build-version=';
api.version = process.argv.find(arg => arg.startsWith(versionFlag))?.slice(versionFlag.length) || '';
api.onTransfersChanged = callback => {
  const listener = () => callback();
  ipcRenderer.on('drive:transfers-changed', listener);
  return () => ipcRenderer.removeListener('drive:transfers-changed', listener);
};
api.onRecycleChanged = callback => {
  const listener = () => callback();
  ipcRenderer.on('drive:recycle-changed', listener);
  return () => ipcRenderer.removeListener('drive:recycle-changed', listener);
};
api.onCloudRecycleChanged = callback => {
  const listener = (_event, revision, status) => callback(revision, status);
  ipcRenderer.on('drive:cloud-recycle-changed', listener);
  return () => ipcRenderer.removeListener('drive:cloud-recycle-changed', listener);
};
api.onIndexChanged = callback => {
  const listener = (_event, revision, status) => callback(revision, status);
  ipcRenderer.on('drive:index-changed', listener);
  return () => ipcRenderer.removeListener('drive:index-changed', listener);
};
api.onStartupStage = callback => {
  ipcRenderer.on('drive:startup-stage', (_event, text) => callback(text));
};
api.onOfficeStage = callback => {
  const listener = (_event, key, text) => callback(key, text);
  ipcRenderer.on('drive:office-stage', listener);
  return () => ipcRenderer.removeListener('drive:office-stage', listener);
};
api.onPlayerState = callback => {
  const listener = (_event, key, state) => callback(key, state);
  ipcRenderer.on('drive:player-state', listener);
  return () => ipcRenderer.removeListener('drive:player-state', listener);
};
contextBridge.exposeInMainWorld('study', api);
