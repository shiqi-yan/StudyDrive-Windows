const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { directoryBuild, packageOptions, missingElectronRuntime } = require('./build-paths.cjs');
const { buildLoginConfig } = require('../src/login-config.cjs');
const { officeVersion } = require('./office-runtime.cjs');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const args = process.argv.slice(2);
const { office, loginFlags } = packageOptions(args);
const { version } = require('../package.json');
const demo = args.includes('--demo');
const stage = directoryBuild(root, version, { office, demo });
const artifact = path.join(dist, 'StudyDrive-' + version + '-win-x64' + (office ? '-office' : '') + (demo ? '-demo' : '') + '.zip');
const runtime = path.join(root, '.runtime', '7zip-26.06');
const installer = path.resolve(process.env.STUDY_7ZIP_INSTALLER || path.join(runtime, '7z2606-x64.exe'));
const installerSha = '9b697f65ecc2d9b0152f5ee96d72dde522a7827690349d9307935dacf40f42ec';
const bootstrap = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', '7z.exe');

function run(executable, arguments_, cwd = root) {
  const result = spawnSync(executable, arguments_, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(path.basename(executable) + ' exited with ' + result.status);
}

try {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Requires Windows x64.');
  const config = buildLoginConfig(loginFlags, process.env.STUDY_ENTRA_CLIENT_ID);
  const missing = missingElectronRuntime(stage);
  if (missing.length) throw new Error('Run pack:dir first. Missing: ' + missing.join(', '));
  const staged = JSON.parse(fs.readFileSync(path.join(stage, 'resources', 'app', 'package.json'), 'utf8'));
  if (staged.version !== version || staged.studyDriveOffice !== (office ? officeVersion : false) ||
      staged.studyDriveAuth?.mode !== config.mode || staged.studyDriveAuth?.clientId !== config.clientId) {
    throw new Error('The staged app and requested build options differ.');
  }
  if (fs.existsSync(artifact)) throw new Error('Artifact already exists: ' + artifact);
  if (createHash('sha256').update(fs.readFileSync(installer)).digest('hex') !== installerSha) {
    throw new Error('The pinned 7-Zip distribution did not match its SHA-256.');
  }
  const work = fs.mkdtempSync(path.join(runtime, 'build-'));
  run(bootstrap, ['e', '-y', '-o' + work, '--', installer, '7z.exe', '7z.dll']);
  const sevenZip = path.join(work, '7z.exe');
  console.log('Building a standard ZIP containing the complete Windows app directory.');
  const draft = path.join(work, path.basename(artifact));
  run(sevenZip, ['a', '-tzip', '-mx=3', '-mcu=on', '--', draft, path.basename(stage)], dist);
  run(sevenZip, ['t', '--', draft]);
  fs.copyFileSync(draft, artifact, fs.constants.COPYFILE_EXCL);
  fs.unlinkSync(draft);
  console.log(artifact);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
