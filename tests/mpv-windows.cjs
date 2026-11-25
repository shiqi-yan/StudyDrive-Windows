const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { directoryBuild } = require('../scripts/build-paths.cjs');
const { startMock } = require('../src/mock.cjs');
const { version } = require('../package.json');

const root = path.resolve(__dirname, '..');
const output = process.env.STUDY_TEST_RESULTS || path.join(root, 'test-results', 'mpv-' + version);
const extraVideo = '中文双音轨 · HEVC.mkv';
const subtitleFile = path.join(output, '额外讲义.vtt');

async function generateSamples() {
  const embedded = path.join(output, 'embedded.srt');
  const mkv = path.join(output, 'hevc-fixture.mkv');
  await fs.writeFile(embedded, '1\n00:00:00,000 --> 00:00:22,000\n中文合成字幕\n');
  await fs.writeFile(subtitleFile, 'WEBVTT\n\n00:00:00.000 --> 00:00:22.000\n课盘外挂字幕测试\n');
  if (await fs.stat(mkv).catch(() => null)) return;
  const result = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
    '-f', 'lavfi', '-i', 'testsrc2=duration=22:size=384x216:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=22', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=22',
    '-i', embedded, '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'pools=2:frame-threads=2:log-level=error',
    '-c:a', 'aac', '-c:s', 'srt', '-metadata:s:a:0', 'language=chi', '-metadata:s:a:1', 'language=eng', '-metadata:s:s:0', 'language=chi', mkv],
  { windowsHide: true, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Could not generate the synthetic HEVC fixture with FFmpeg');
}

async function prepare(profile) {
  const mock = await startMock(profile, path.join(root, 'fixtures'));
  await new Promise(resolve => mock.server.close(resolve));
  const data = path.join(profile, 'demo-files', 'mock.json');
  const state = JSON.parse(await fs.readFile(data, 'utf8'));
  const fixture = path.join(output, 'hevc-fixture.mkv');
  const size = (await fs.stat(fixture)).size;
  await fs.copyFile(fixture, path.join(profile, 'demo-files', 'hevc.bin'));
  state.items.push({ id: 'hevc', parentId: 'course', name: extraVideo, size,
    file: { mimeType: 'video/x-matroska' }, lastModifiedDateTime: '2026-11-22T10:00:00Z' });
  await fs.writeFile(data, JSON.stringify(state));
  await fs.writeFile(path.join(profile, 'library.json'), JSON.stringify({
    active: '', accounts: {}, settings: { rate: 1.25, volume: 85, contrast: 1.16, brightness: 1.06 }
  }));
}

async function capture(app, name) {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setAlwaysOnTop(true);
    win.focus();
  });
  const state = await app.evaluate(() => globalThis.studyTest.player());
  assert.ok(state.embedded && state.hasVideo);
  const [l, t, r, b] = state.bounds;
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'mpv-capture.ps1'), String(state.windowHandle), String(l), String(t), String(r), String(b), path.join(output, name)],
    { windowsHide: true, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || result.error);
    return JSON.parse(result.stdout);
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setAlwaysOnTop(false));
  }
}

async function run() {
  await fs.mkdir(output, { recursive: true });
  await generateSamples();
  const profile = await fs.mkdtemp(path.join(output, 'acceptance-'));
  await prepare(profile);
  const app = await electron.launch({
    executablePath: path.join(directoryBuild(root, version, { office: true }), 'StudyDrive.exe'), args: ['--demo', '--test-driver'],
    cwd: root, env: { ...process.env, STUDY_DRIVER: '1', STUDY_TEST_PROFILE: profile }
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(18000);
    const nav = name => page.locator('#nav').getByRole('button', { name, exact: true }).click();
    const btn = name => page.getByRole('button', { name, exact: true });
    const stage = page.locator('[data-player="mpv"]');
    const native = () => app.evaluate(() => globalThis.studyTest.player());
    const ready = () => page.locator('[data-player="mpv"][data-ready="true"]').waitFor();
    const state = () => stage.evaluate(node => node.dataset);
    const back = () => btn('返回').click();
    const key = async name => { await stage.focus(); await page.keyboard.press(name); };
    const rootFolder = () => page.getByRole('navigation', { name: '文件夹路径' }).getByRole('button', { name: '全部文件', exact: true }).click();
    assert.equal(await app.evaluate(() => Object.keys(process.getBuiltinModule('node:module')._cache).some(name => name.endsWith('mpv.cjs'))), false);
    assert.equal(await native(), null);
    await nav('全部文件');
    await btn('高等数学').click();
    await btn('01 · 函数图像与变化.mp4').click();
    await ready();
    const initial = await native();
    assert.ok(initial.embedded && initial.hasAudio && initial.hasVideo && initial.rate === 1.25 && initial.volume === 85);
    assert.equal(await stage.locator('video,audio,.video-sharpen-canvas').count(), 0);
    assert.doesNotMatch(await stage.innerText(), /实时锐化|恢复原画|基础增强/);
    await page.getByLabel('播放倍速').selectOption('1');
    await key('Space');
    await page.waitForFunction(() => Number(document.querySelector('.player-stage')?.dataset.time) >= 10.2);
    await key('Space');
    await page.locator('[data-player="mpv"][data-paused="true"]').waitFor();
    const point = Number((await state()).time);
    await key('ArrowRight');
    await page.waitForFunction(t => {
      const d = document.querySelector('.player-stage')?.dataset;
      return d.seeking === 'false' && Math.abs(Number(d.time) - t) < .8;
    }, point + 5);
    await key('ArrowLeft');
    await page.waitForFunction(t => Math.abs(Number(document.querySelector('.player-stage')?.dataset.time) - t) < .8 &&
      document.querySelector('.player-stage').dataset.seeking === 'false', point);
    await key('ArrowDown');
    await page.locator('[data-player="mpv"][data-volume="80"]').waitFor();
    await key('m');
    await page.locator('[data-player="mpv"][data-muted="true"]').waitFor();
    await key('m');
    await page.locator('[data-player="mpv"][data-muted="false"]').waitFor();
    const slider = await page.getByRole('slider', { name: '播放进度' }).boundingBox();
    await page.mouse.move(slider.x + slider.width * (.13), slider.y + slider.height / 2);
    await page.mouse.down();
    await page.mouse.move(slider.x + slider.width * .47, slider.y + slider.height / 2);
    await page.mouse.up();
    await page.waitForFunction(() => {
      const d = document.querySelector('.player-stage').dataset;
      return Number(d.time) > 34 && Number(d.time) < 45 && d.seeking === 'false';
    });
    await page.getByLabel('播放倍速').selectOption('1.5');
    await page.locator('[data-player="mpv"][data-rate="1.5"]').waitFor();
    const saved = Number((await state()).time);
    const oldBounds = (await native()).bounds;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 650));
    await page.waitForFunction(() => innerWidth < 960);
    await page.waitForTimeout(160);
    const resized = await native();
    assert.ok(resized.embedded && resized.bounds[2] - resized.bounds[0] < oldBounds[2] - oldBounds[0]);
    await key('f');
    await page.waitForFunction(() => document.fullscreenElement === document.querySelector('.player-stage'));
    await page.waitForTimeout(280);
    const fullscreen = await native();
    assert.ok(fullscreen.embedded && fullscreen.bounds[2] - fullscreen.bounds[0] > resized.bounds[2] - resized.bounds[0]);
    await key('f');
    await page.waitForFunction(() => !document.fullscreenElement);
    await nav('首页');
    await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
    assert.equal(await native(), null);
    await btn('继续观看').click();
    await ready();
    await page.waitForFunction(t => Math.abs(Number(document.querySelector('.player-stage')?.dataset.time) - t) < .8 &&
      document.querySelector('.player-stage').dataset.seeking === 'false', saved);
    assert.equal((await state()).rate, '1.5');
    assert.equal((await state()).volume, '80');
    const range = await app.evaluate(() => globalThis.studyTest.mock.ranges.filter(row => row.id === 'lesson').length);
    assert.ok(range > 0);
    console.log('PASS packaged MP4, 10 seconds played, seek/drag, WASAPI audio, shortcuts, 1.5×, native resize/fullscreen and Home resume', JSON.stringify({ range, dpi: resized.dpi }));

    await back();
    await nav('全部文件');
    await btn(extraVideo).click();
    await ready();
    const tracks = await native();
    assert.equal(tracks.tracks.filter(track => track.type === 'audio').length, 2);
    const second = tracks.tracks.filter(track => track.type === 'audio')[1].id;
    await page.getByLabel('音轨', { exact: true }).selectOption(String(second));
    const embedded = tracks.tracks.find(track => track.type === 'sub').id;
    await page.getByLabel('字幕').selectOption('0');
    await page.getByLabel('字幕').selectOption(String(embedded));
    await app.evaluate(({ dialog }, track) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [track] }); }, subtitleFile);
    await btn('外挂字幕').click();
    await page.getByLabel('字幕').locator('option').filter({ hasText: '外挂' }).waitFor({ state: 'attached' });
    const selected = await native();
    assert.ok(selected.tracks.some(track => track.type === 'audio' && track.id === second && track.selected));
    assert.ok(selected.tracks.some(track => track.type === 'sub' && track.external && track.selected));
    await key('Space');
    await page.waitForFunction(() => Number(document.querySelector('.player-stage')?.dataset.time) > 1);
    const image = await capture(app, 'mpv-hevc-window.png');
    console.log('PASS MKV HEVC + dual AAC, SRT track and Chinese-named external WebVTT, visible pixels in native child', JSON.stringify(image));
    await back();
    await page.locator('.player-stage').waitFor({ state: 'hidden' });
    assert.equal(await native(), null);
    await rootFolder();
    await btn('课程计划.docx').click();
    await page.waitForFunction(() => document.querySelector('.pdf-paper canvas')?.getContext('2d').getImageData(10, 10, 1, 1).data[3] > 0);
    await back();
    await btn('文档预览示例').click();
    await btn('课程成绩.xlsx').click();
    await page.getByRole('gridcell', { name: '000172', exact: true }).waitFor();
    console.log('PASS mock DOCX to PDF and XLSX still render; fixture player cleared on close.');
  } finally { await app.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
