const { fileType } = require('./drive.cjs');

const extras = {
  archive: /^(?:7z|zip|rar|tar|tgz|tbz2?|txz|gz|bz2|xz|zst|cab|iso)$/,
  sheet: /^(?:xlsb|xltx?|xltm)$/,
  office: /^(?:docm|dotx?|dotm|pptm|potx?|potm|ppsm)$/,
  audio: /^(?:aiff?|ape|alac|mka|opus|wma|mid|midi)$/,
  video: /^(?:avi|mov|mpeg|mpg|m2ts|ts|wmv|flv|3gp|ogv|rmvb)$/,
  text: /^(?:ini|cfg|conf|toml|nfo|srt|vtt|ass|sql)$/
};
const recorded = new Set(['sheet', 'office', 'online', 'markdown', 'text', 'pdf', 'audio', 'video', 'image', 'archive', 'shortcut']);

function describeRecycleType(name, structuralKind) {
  if (structuralKind === 'folder') return { displayKind: 'folder', typeSource: 'folder' };
  if (recorded.has(structuralKind)) return { displayKind: structuralKind, typeSource: 'recorded' };
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return { displayKind: 'other', typeSource: 'no-extension' };
  const suffix = name.slice(dot + 1).toLowerCase();
  const extra = Object.keys(extras).find(kind => extras[kind].test(suffix));
  const found = extra || fileType(name).kind;
  return { displayKind: found, typeSource: found === 'other' ? 'unknown-extension' : 'extension' };
}

module.exports = { describeRecycleType };
