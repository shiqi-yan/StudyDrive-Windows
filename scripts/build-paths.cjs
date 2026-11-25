const fs = require('node:fs');
const path = require('node:path');

function directoryBuild(root, version, { office = false, demo = false } = {}) {
  // Keep this name short for NSIS's Windows path limit when embedding Office files.
  return path.join(root, 'dist', version + (office ? '-office' : '') + (demo ? '-demo' : ''));
}

function packageOptions(args) {
  if (args.includes('--office') && args.includes('--lite')) throw new Error('不能同时选择含 Office 版与轻量版。');
  return { office: !args.includes('--lite'), loginFlags: args.filter(arg => !['--office', '--lite'].includes(arg)) };
}

function missingElectronRuntime(folder) {
  return ['StudyDrive.exe', 'd3dcompiler_47.dll', 'vulkan-1.dll'].filter(name => {
    try {
      const stat = fs.statSync(path.join(folder, name));
      return !stat.isFile() || stat.size === 0;
    } catch { return true; }
  });
}

module.exports = { directoryBuild, packageOptions, missingElectronRuntime };
