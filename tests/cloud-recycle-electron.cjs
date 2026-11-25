const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results', 'cloud-recycle-electron');

async function run() {
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(output, 'demo-'));
  // Reuse only the untouched compatible runtime for this Electron API probe.
  const running = await _electron.launch({ executablePath: path.join(root, 'dist/0.4.0-office/StudyDrive.exe'),
    args: ['--demo', '--test-driver'], cwd: root,
    env: { ...process.env, STUDY_DRIVER: '1', STUDY_TEST_PROFILE: profile } });
  try {
    await running.firstWindow();
    const result = await running.evaluate(async ({ BrowserWindow, session }) => {
      const { createServer } = process.getBuiltinModule('node:http');
      const server = createServer((request, response) => {
        if (request.url === '/fixture-list') {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ value: ['controlled'] }));
          return;
        }
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><script>fetch("/fixture-list")</script>');
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = 'http://127.0.0.1:' + server.address().port;
      const isolated = session.fromPartition('persist:cloud-recycle-api-probe');
      const window = new BrowserWindow({ show: false, webPreferences: {
        session: isolated, sandbox: true, nodeIntegration: false, contextIsolation: true, devTools: false
      } });
      const contents = window.webContents;
      const debug = contents.debugger;
      let webRequestMatched = false;
      let id;
      let primaryDocument = false;
      try {
        isolated.webRequest.onBeforeRequest({ urls: [origin + '/*'] }, (details, respond) => {
          if (details.url === origin + '/fixture-list') {
            webRequestMatched = details.initiatorOrigin === origin && details.webContentsId === contents.id && details.method === 'GET';
          }
          respond({ cancel: false });
        });
        debug.attach('1.3');
        const reading = new Promise(resolve => {
          debug.on('message', async (_event, method, params) => {
            if (method === 'Network.requestWillBeSent' && params.request.url === origin + '/fixture-list') {
              id = params.requestId;
              primaryDocument = params.documentURL === origin + '/';
            }
            if (method === 'Network.loadingFinished' && id && id === params.requestId) {
              try {
                const { body } = await debug.sendCommand('Network.getResponseBody', { requestId: id });
                resolve(JSON.parse(body)?.value?.[0] === 'controlled');
              } catch { resolve(false); }
            }
          });
        });
        const enabled = debug.sendCommand('Network.enable');
        const page = window.loadURL(origin + '/');
        await Promise.all([enabled, page]);
        const response = await Promise.race([reading, new Promise(resolve => setTimeout(() => resolve(false), 5000).unref())]);
        return { webRequestMatched, primaryDocument, response };
      } finally {
        isolated.webRequest.onBeforeRequest(null);
        if (debug.isAttached()) debug.detach();
        window.destroy();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    });
    assert.deepEqual(result, { webRequestMatched: true, primaryDocument: true, response: true });
    const note = 'PASS Windows Electron 45.4.1 isolated WebContents/GET initiator/Debugger receive-only loopback probe';
    console.log(note);
    await fs.writeFile(path.join(output, 'electron-evidence.txt'), note + '\n');
  } finally { await running.close(); }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
