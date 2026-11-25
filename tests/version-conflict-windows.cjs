const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { _electron } = require('playwright');
const koffi = require('koffi');
const { version } = require('../package.json');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const results = path.join(root, 'test-results', 'version-conflict-' + version);
const title = '课盘 ' + version + ' 尚未启动';
const quick = ver => path.join(dist, ver + '-office', 'StudyDrive.exe');
const exec = promisify(execFile);
const user32 = koffi.load('user32.dll');
const findWindow = user32.func('uintptr_t FindWindowW(str16, str16)');
const nextWindow = user32.func('uintptr_t FindWindowExW(uintptr_t, uintptr_t, str16, str16)');
const windowText = user32.func('int GetWindowTextW(uintptr_t, void *, int)');
const windowOwner = user32.func('uint32_t GetWindowThreadProcessId(uintptr_t, void *)');
const postMessage = user32.func('int PostMessageW(uintptr_t, uint32_t, uintptr_t, intptr_t)');

function launch(exe, profile) {
  const child = spawn(exe, ['--user-data-dir=' + profile], { cwd: root, stdio: 'ignore' });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  return { child, exited };
}

async function dismissNotice(child, portable) {
  const pid = child.pid;
  const owner = Buffer.alloc(4);
  const limit = Date.now() + (portable ? 45000 : 7000);
  do {
    const window = findWindow(null, title);
    if (window) {
      windowOwner(window, owner);
      const ownerId = owner.readUInt32LE();
      if (portable) {
        const command = '(Get-CimInstance Win32_Process -Filter "ProcessId=' + ownerId + '").ParentProcessId';
        const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true, timeout: 8000 });
        assert.equal(Number(stdout.trim()), pid, 'Notice belongs to this test portable launcher');
      } else {
        assert.equal(ownerId, pid, 'Notice belongs to this test executable');
      }
      assert.ok(postMessage(window, 0x0010, 0, 0), 'Dismiss test-owned dialog');
      return;
    }
    if (child.exitCode !== null) throw new Error('Version conflict process exited before showing notice, exit=' + child.exitCode);
    await delay(120);
  } while (Date.now() < limit);
  const titles = [];
  const buffer = Buffer.alloc(512);
  for (let hwnd = nextWindow(0, 0, null, null); hwnd; hwnd = nextWindow(0, hwnd, null, null)) {
    windowOwner(hwnd, owner);
    if (owner.readUInt32LE() !== pid) continue;
    const len = windowText(hwnd, buffer, buffer.length / 2);
    if (len > 0) titles.push(buffer.subarray(0, len * 2).toString('utf16le'));
  }
  throw new Error('Version conflict dialog not found for the test process ' + pid + ', titles=' + JSON.stringify(titles));
}

async function run() {
  await fs.mkdir(results, { recursive: true });
  const profile = await fs.mkdtemp(path.join(results, 'profile-'));
  const old = await _electron.launch({ executablePath: quick('0.3.1'), args: ['--user-data-dir=' + profile], cwd: root });
  const open = [];
  try {
    const window = await old.firstWindow();
    await window.getByRole('heading', { name: '连接 OneDrive 个人版' }).waitFor();
    assert.equal(await old.evaluate(({ app }) => app.getPath('userData')), profile);
    const oldDuplicate = launch(quick('0.3.2'), profile);
    open.push(oldDuplicate.child);
    assert.equal(await Promise.race([oldDuplicate.exited, delay(8000, 'timeout', { ref: false })]), 0);
    const candidates = [
      [quick(version), false],
      [path.join(dist, 'StudyDrive-' + version + '-win-x64-office-portable.exe'), true]
    ];
    if (process.argv.includes('--quick-only')) candidates.pop();
    for (const [exe, portable] of candidates) {
      const started = launch(exe, profile);
      open.push(started.child);
      await dismissNotice(started.child, portable);
      const exit = await Promise.race([started.exited, delay(portable ? 30000 : 8000, 'timeout', { ref: false })]);
      assert.equal(exit, 0, 'Exit after dismissing the ' + (portable ? 'portable' : 'quick') + ' version warning');
      assert.ok(await window.getByRole('heading', { name: '连接 OneDrive 个人版' }).isVisible());
      assert.equal(await old.evaluate(({ app }) => app.getVersion()), '0.3.1');
    }
    const message = 'PASS 0.3.2 silently exited behind 0.3.1; ' + version +
      (candidates.length === 1 ? ' quick entry' : ' quick and portable entries') +
      ' showed a version conflict; the isolated 0.3.1 instance stayed open.';
    console.log(message);
    if (candidates.length === 2) await fs.writeFile(path.join(results, 'evidence.txt'), message + '\n');
  } finally {
    for (const child of open) {
      if (child.exitCode === null) {
        await exec('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }).catch(() => {});
      }
    }
    await old.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
