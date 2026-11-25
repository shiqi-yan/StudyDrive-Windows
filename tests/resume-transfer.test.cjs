const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createServer } = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');

const exec = promisify(execFile);
const output = path.resolve(__dirname, '../test-results');
const child = `
  const path = require('node:path');
  const { Store } = require('./src/store.cjs');
  const { Transfers } = require('./src/transfers.cjs');
  const { Drive } = require('./src/drive.cjs');
  const { setTimeout: delay } = require('node:timers/promises');
  const [profile, base, phase] = process.argv.slice(1);
  const account = { id: 'fixture', driveId: 'drive', root: { id: 'root' } };
  const encryption = { decryptString: value => value.toString(), encryptString: value => Buffer.from(value), isEncryptionAvailable: () => true };
  const drive = new Drive({ base, mock: true, credentials: { access: 'fixture' } });
  const queue = new Transfers(new Store(profile, encryption), () => {});
  queue.attach(account, drive);
  (async () => {
    if (phase === 'begin') await queue.download(await drive.get(account, 'file'), path.join(profile, 'saved.txt'));
    else await queue.action(queue.list()[0].id, phase);
    for (let attempt = 0; attempt < 250; attempt += 1) {
      const [job] = queue.list();
      if (['failed', 'done'].includes(job.state)) {
        console.log(JSON.stringify(job));
        return;
      }
      await delay(30);
    }
    throw new Error('Download worker did not settle');
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
`;

test('restartable Windows download verifies bytes, CDN Range fallback, expiry, and version changes', async () => {
  await fs.mkdir(output, { recursive: true });
  const directory = await fs.mkdtemp(path.join(output, 'resume-'));
  const bytes = Buffer.alloc(750000);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
  const state = { bytes, etag: 'one', failed: false, failNext: false, ignore: false, expire: false, ranges: [], renewals: 0 };
  let base;
  const server = createServer((request, response) => {
    const auth = request.headers.authorization;
    const stem = '/v1.0/drives/drive/items/file';
    const target = new URL(request.url, base);
    if (target.pathname === '/cdn/file') {
      if (auth) { response.writeHead(400).end(); return; }
      const range = /^bytes=(\d+)-$/.exec(request.headers.range || '');
      const claimed = range ? Number(range[1]) : 0;
      if (range) state.ranges.push(claimed);
      if (state.expire) { state.expire = false; response.writeHead(403).end(); return; }
      const offset = state.ignore ? 0 : claimed;
      const headers = { 'Content-Type': 'text/plain', 'Content-Length': state.bytes.length - offset };
      if (offset) headers['Content-Range'] = 'bytes ' + offset + '-' + (state.bytes.length - 1) + '/' + state.bytes.length;
      response.writeHead(offset ? 206 : 200, headers);
      if (state.failNext) {
        state.failNext = false;
        response.write(state.bytes.subarray(0, 133333));
        setTimeout(() => response.destroy(), 125);
      } else response.end(state.bytes.subarray(offset));
    } else if (auth !== 'Bearer fixture') response.writeHead(401).end();
    else if (target.pathname === stem + '/content') {
      state.renewals += 1;
      response.writeHead(302, { Location: base + '/cdn/file' }).end();
    } else if (target.pathname === stem) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ id: 'file', name: '课程.txt', size: state.bytes.length,
        eTag: state.etag, file: { mimeType: 'text/plain' }, '@microsoft.graph.downloadUrl': base + '/cdn/file' }));
    } else response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  const run = async (profile, phase) => {
    const { stdout } = await exec(process.execPath, ['-e', child, profile, base + '/v1.0', phase],
      { cwd: path.resolve(__dirname, '..'), timeout: 14000, windowsHide: true });
    return JSON.parse(stdout);
  };
  try {
    for (const mode of ['renew', 'ignore', 'change']) {
      const profile = path.join(directory, mode);
      await fs.mkdir(profile);
      await fs.writeFile(path.join(profile, 'saved.txt'), 'existing');
      Object.assign(state, { failNext: true, ignore: false, expire: false, ranges: [], renewals: 0, bytes, etag: 'one' });
      const attempt = await run(profile, 'begin');
      assert.equal(attempt.state, 'failed');
      assert.ok(attempt.bytes > 0 && attempt.bytes < bytes.length);
      if (mode === 'renew') {
        const partial = path.join(profile, '.studydrive-' + attempt.id + '.part');
        await fs.appendFile(partial, '<unknown-after-checkpoint>');
        state.expire = true;
      }
      if (mode === 'ignore') state.ignore = true;
      if (mode === 'change') {
        state.etag = 'two';
        state.bytes = Buffer.from(bytes.map(value => 250 - value));
      }
      let result = await run(profile, 'retry');
      if (mode === 'change') {
        assert.equal(result.state, 'failed');
        assert.equal(result.restart, true);
        assert.equal(state.ranges.length, 0);
        result = await run(profile, 'restart');
      } else assert.equal(state.ranges.at(-1), attempt.bytes);
      if (mode === 'renew') assert.equal(state.renewals, 1);
      if (mode === 'ignore') assert.match(result.notice, /从头下载/);
      assert.equal(result.state, 'done');
      assert.equal(result.output, 'saved (1).txt');
      assert.deepEqual(await fs.readFile(path.join(profile, result.output)), state.bytes);
      assert.equal(await fs.readFile(path.join(profile, 'saved.txt'), 'utf8'), 'existing');
      assert.equal((await fs.readdir(profile)).some(name => name.endsWith('.part')), false);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
