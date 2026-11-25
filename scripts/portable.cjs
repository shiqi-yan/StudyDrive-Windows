const path = require('node:path');
const fs = require('node:fs');
const { build, Platform, Arch } = require('electron-builder');
const { buildLoginConfig } = require('../src/login-config.cjs');
const { officeVersion } = require('./office-runtime.cjs');
const { directoryBuild, packageOptions, missingElectronRuntime } = require('./build-paths.cjs');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const { office, loginFlags } = packageOptions(args);
const { version } = require('../package.json');
const unpacked = directoryBuild(root, version, { office, demo: args.includes('--demo') });
let auth;
try {
  auth = buildLoginConfig(loginFlags, process.env.STUDY_ENTRA_CLIENT_ID);
  const missing = missingElectronRuntime(unpacked);
  if (missing.length) throw new Error('快启目录的 Electron 运行时缺件：' + missing.join(', '));
  const staged = JSON.parse(fs.readFileSync(path.join(unpacked, 'resources', 'app', 'package.json'), 'utf8'));
  if (staged.version !== version || staged.studyDriveAuth?.mode !== auth.mode || staged.studyDriveAuth?.clientId !== auth.clientId ||
      staged.studyDriveOffice !== (office ? officeVersion : false)) {
    throw new Error('解包版版本或登录配置与本次打包不一致，请先以相同参数运行 pack:dir。');
  }
} catch (error) {
  console.error(error.code === 'ENOENT' ? '缺少解包版，请先运行 pack:dir。' : error.message);
  process.exit(1);
}
const demoSuffix = auth.mode === 'demo' ? '-demo' : '';
process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL ||= '3';
process.env.ELECTRON_BUILDER_CACHE ||= path.join(root, '.runtime', 'builder');
build({
  projectDir: root,
  prepackaged: unpacked,
  publish: 'never',
  targets: Platform.WINDOWS.createTarget('portable', Arch.x64),
  config: {
    appId: 'local.studydrive.desktop',
    productName: 'StudyDrive',
    electronVersion: '45.4.1',
    artifactName: 'StudyDrive-' + version + '-win-x64' + (office ? '-office' : '') + demoSuffix + '-portable.exe',
    directories: { output: 'dist' },
    win: { icon: 'src/renderer/mark.ico', signAndEditExecutable: false },
    portable: {
      requestExecutionLevel: 'user',
      useZip: false,
      // Builder 26.18.0 leaves UNPACK_DIR_NAME undefined for true, using the
      // launcher's unique plugin directory. A string or false is build-wide.
      unpackDirName: true
    }
  }
}).catch(error => { console.error(error.message); process.exitCode = 1; });
