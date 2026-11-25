const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const asset = 'libmpv-v0.42.0-dev-gd11ffba25-44760162632-x86_64-w64-mingw32-lgpl.zip';
const archiveSha = 'a0474d5cd726c77e6d0c280b750a320d943d3960a7d03d61687d387b84f67b43';
const files = {
  'libmpv-2.dll': '3ac0bf3a6f863a6242c2741219d9ed1f89d1b24e5cad8aa799dea94db8239797',
  'LICENSE.LGPL': '72b672113d642cbb8ef5dcc76938db801983c56e50b1400ab930f1a64d6dc8d9'
};
function sha(filename) {
  const file = fs.openSync(filename, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  const hash = createHash('sha256');
  try {
    let bytes;
    while ((bytes = fs.readSync(file, buffer)) > 0) hash.update(buffer.subarray(0, bytes));
    return hash.digest('hex');
  } finally { fs.closeSync(file); }
}
function stageMpv(root, appDirectory) {
  const archive = path.join(root, '.runtime', 'mpv', asset);
  if (!fs.existsSync(archive) || sha(archive) !== archiveSha) throw new Error('Prepare the pinned LGPL libmpv ZIP in .runtime/mpv (see third-party/MPV-RUNTIME.md)');
  const destination = path.join(appDirectory, 'vendor', 'mpv');
  fs.mkdirSync(destination, { recursive: true });
  const names = Object.keys(files);
  const result = spawnSync('tar.exe', ['-xf', archive, '-C', destination, ...names], { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0 || names.some(name => sha(path.join(destination, name)) !== files[name])) {
    throw new Error('libmpv runtime extraction or integrity check failed');
  }
  for (const name of ['koffi', '@koromix/koffi-win32-x64']) {
    fs.cpSync(path.join(root, 'node_modules', name), path.join(appDirectory, 'node_modules', name), { recursive: true });
  }
  console.log('Verified pinned Windows x64 LGPL libmpv and accompanying license');
}

module.exports = { stageMpv };
