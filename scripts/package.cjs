const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { buildLoginConfig } = require('../src/login-config.cjs');
const { officeVersion, stageOffice } = require('./office-runtime.cjs');
const { directoryBuild, packageOptions, missingElectronRuntime } = require('./build-paths.cjs');
const { stageMpv } = require('./mpv-runtime.cjs');
const root = path.resolve(__dirname, '..');
const version = '45.4.1';
const filename = 'electron-v' + version + '-win32-x64.zip';
const runtime = path.join(root, '.runtime');
const output = path.join(root, 'dist');
const args = process.argv.slice(2);
const { office, loginFlags } = packageOptions(args);
const unpacked = directoryBuild(root, require('../package.json').version, { office, demo: args.includes('--demo') });
const zip = process.env.STUDY_ELECTRON_ZIP || path.join(runtime, filename);
const hashes = process.env.STUDY_ELECTRON_HASHES || path.join(runtime, 'SHASUMS256.txt');
const renamed = path.join(unpacked, 'StudyDrive.exe');
const executable = path.join(unpacked, 'electron.exe');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status) throw new Error(command + ' returned ' + result.status);
}
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Packaging expects x64 Windows');
let loginConfig;
try { loginConfig = buildLoginConfig(loginFlags, process.env.STUDY_ENTRA_CLIENT_ID); }
catch (error) { console.error(error.message); process.exit(1); }
const expected = fs.readFileSync(hashes, 'utf8').split(/\r?\n/).find(line => line.endsWith(' *' + filename) || line.endsWith('  ' + filename))?.split(' ')[0];
const actual = createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
if (!expected || actual !== expected) throw new Error('Electron SHA-256 verification failed');
if (!fs.existsSync(path.join(root, 'fixtures', 'lesson.mp4'))) run(process.execPath, ['scripts/make-fixtures.cjs']);
fs.mkdirSync(unpacked, { recursive: true });
const stamp = path.join(output, 'electron-runtime.sha256');
if (missingElectronRuntime(unpacked).length || !fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== actual) {
  console.log('Unpacking verified Electron ' + version);
  run('tar.exe', ['-xf', zip, '-C', unpacked]);
  if (!fs.existsSync(executable)) throw new Error('No Electron executable in runtime');
  const hash = name => createHash('sha256').update(fs.readFileSync(name)).digest('hex');
  if (fs.existsSync(renamed) && hash(executable) === hash(renamed)) fs.unlinkSync(executable);
  else fs.renameSync(executable, renamed);
  fs.writeFileSync(stamp, actual);
}
const runtimeMissing = missingElectronRuntime(unpacked);
if (runtimeMissing.length) throw new Error('Electron 运行时缺件：' + runtimeMissing.join(', '));
const defaultAsar = path.join(unpacked, 'resources', 'default_app.asar');
if (fs.existsSync(defaultAsar)) fs.unlinkSync(defaultAsar);
const app = path.join(unpacked, 'resources', 'app');
fs.mkdirSync(app, { recursive: true });
for (const file of ['src', 'fixtures', 'third-party', 'README.md', 'LICENSE']) {
  fs.cpSync(path.join(root, file), path.join(app, file), { recursive: true });
}
const metadata = require('../package.json');
delete metadata.scripts;
delete metadata.devDependencies;
metadata.studyDriveAuth = loginConfig;
metadata.studyDriveOffice = office ? officeVersion : false;
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(metadata));
const pdf = path.join(app, 'vendor', 'pdf');
fs.mkdirSync(pdf, { recursive: true });
for (const resource of ['cmaps', 'standard_fonts', 'wasm', 'iccs', 'LICENSE']) {
  fs.cpSync(path.join(root, 'node_modules', 'pdfjs-dist', resource), path.join(pdf, resource), { recursive: true });
}
for (const resource of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  fs.copyFileSync(path.join(root, 'node_modules', 'pdfjs-dist', 'build', resource), path.join(pdf, resource));
}
const { packages } = require('../package-lock.json');
for (const [name, dependency] of Object.entries(packages)) {
  if (!name.startsWith('node_modules/') || dependency.dev || dependency.optional) continue;
  fs.cpSync(path.join(root, name), path.join(app, name), {
    recursive: true, filter: source => source === path.join(root, name) || path.basename(source) !== 'node_modules'
  });
}
stageMpv(root, app);
if (office) stageOffice(root, app, packages);
console.log(loginConfig.mode === 'demo' ? '本地演示包解包版（Microsoft 登录停用）' : '正式包解包版（已写入公共客户端配置）');
console.log(renamed);
