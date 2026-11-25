const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Drive, fileType } = require('../src/drive.cjs');
const { Media } = require('../src/media.cjs');
const { Store } = require('../src/store.cjs');
const { LocalOffice } = require('../src/local-office.cjs');
const { previewCapability } = require('../src/preview-capability.cjs');
const { decodeText } = require('../src/text-decoder.cjs');
const { convertedLink, warmPdf, originalLink, DocumentSession, imageName } = require('../src/documents.cjs');

const fixture = name => fs.readFile(path.join(__dirname, '..', 'fixtures', name));

test('local Office cache still requires current original-content permission and rejects an aborted preview', async () => {
  const office = new LocalOffice(os.tmpdir(), '0.2.3');
  office.installed = true; // Exercise authorization without loading native code.
  const account = { id: 'a', driveId: 'd' };
  const item = { id: 'file', driveId: 'd', version: 'version', name: 'fixture.docx' };
  const pdf = Buffer.from('%PDF-test');
  office.saved = { key: JSON.stringify(['a', 'd', 'file', 'version', '0.2.3']), pdf };
  let reads = 0;
  let allowed = false;
  const drive = {
    get: async () => item,
    content: async () => 'https://files.1drv.com/synthetic',
    transferUrl: value => value,
    fetcher: async (_url, options) => {
      reads += 1;
      assert.equal(options.headers.Range, 'bytes=0-0');
      return allowed ? new Response('x', { status: 206, headers: { 'Content-Range': 'bytes 0-0/10' } }) : new Response(null, { status: 403 });
    }
  };
  const controller = new AbortController();
  const ticket = { drive, account, item, controller, cache: {} };
  await assert.rejects(office.prepare(ticket), { status: 403 });
  allowed = true;
  assert.equal(await office.prepare(ticket), pdf);
  const before = reads;
  controller.abort();
  await assert.rejects(office.prepare(ticket), { name: 'AbortError' });
  assert.equal(reads, before);
});

test('preview capabilities choose local Office when present and keep spreadsheet interaction by default', () => {
  const word = { kind: 'office', name: '合成.docx', size: 256 };
  const sheet = { kind: 'sheet', name: '合成.xlsx', size: 256 };
  assert.equal(previewCapability(word, undefined, { readiness: 'ready' }).source, 'local');
  assert.equal(previewCapability(word, undefined, { readiness: 'missing' }).source, 'graph');
  assert.match(previewCapability(word, undefined, { readiness: 'runtime' }).note, /VC\+\+/);
  assert.equal(previewCapability({ ...word, size: 40 * 1024 ** 2 }, undefined, { readiness: 'ready' }).source, 'graph');
  assert.equal(previewCapability(sheet, undefined, { readiness: 'ready' }).view, 'sheet');
  assert.equal(previewCapability(sheet, 'pdf', { readiness: 'ready' }).source, 'graph');
  assert.match(previewCapability({ ...sheet, size: 18 * 1024 ** 2 }, undefined, { readiness: 'ready' }).limit, /16 MB/);
});

test('routes file extensions before fallback media MIME and matches only direct Markdown image names', () => {
  for (const [kind, extensions] of Object.entries({
    office: ['doc', 'docx', 'ppt', 'pptx', 'rtf', 'odt', 'odp'],
    sheet: ['xls', 'xlsx', 'xlsm', 'ods', 'csv', 'tsv'],
    markdown: ['md', 'markdown'], text: ['txt', 'log', 'json', 'yaml', 'yml', 'xml']
  })) for (const ext of extensions) assert.equal(fileType('中文.' + ext.toUpperCase(), 'image/png').kind, kind);
  assert.equal(imageName('./%E5%9B%BE.png'), '图.png');
  for (const src of ['../pic.png', 'sub/pic.png', '%2fpic.png', 'https://e.invalid/a', '//e.invalid/a', '%2e%2e', 'x.png?q=1']) {
    assert.equal(imageName(src), '');
  }
});

test('Graph PDF uses exact URL, times out while pending, isolates versions and reissues expired links without forwarding authorization', async () => {
  const account = { id: 'account', driveId: 'drive#1' };
  const source = { id: 'item 1', name: '中文.doc', size: 50, eTag: 'v1' };
  const version = '/v1.0/drives/drive%231/items/item%201';
  const route = version + '/content?format=pdf';
  const requests = [];
  let issued = 0;
  let state = 'pending';
  const drive = new Drive({
    credentials: { access: 'private-token', expires: Date.now() + 300000 },
    fetcher: async (target, init) => {
      const url = new URL(target);
      const headers = new Headers(init.headers);
      requests.push([url.origin, url.pathname + url.search, headers.has('authorization')]);
      if (url.origin === 'https://graph.microsoft.com') {
        assert.equal(headers.get('authorization'), 'Bearer private-token');
        if (url.pathname + url.search === route) {
          assert.equal(init.redirect, 'manual');
          if (state === 'pending') return new Response(null, { status: 202 });
          if (state === 'protected') return new Response(null, { status: 400 });
          if (state === 'forbidden') return new Response(null, { status: 403 });
          if (state === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://example.invalid/signed' } });
          return new Response(null, { status: 302, headers: { Location: 'https://files.1drv.com/test/' + (++issued) } });
        }
        assert.equal(url.pathname, version);
        return Response.json(source);
      }
      assert.equal(url.origin, 'https://files.1drv.com');
      assert.equal(headers.has('authorization'), false);
      assert.equal(headers.get('range'), 'bytes=0-4');
      if (url.pathname.endsWith('/1')) return new Response(null, { status: 403 });
      return new Response('%PDF-', { status: 206, headers: { 'Content-Range': 'bytes 0-4/100', 'Content-Length': '5' } });
    }
  });
  const item = await drive.get(account, source.id);
  const signal = new AbortController().signal;
  await assert.rejects(convertedLink(drive, account, item, signal, 20), /转换超时/);
  state = 'protected';
  await assert.rejects(convertedLink(drive, account, item, signal), /可能已加密/);
  state = 'forbidden';
  await assert.rejects(convertedLink(drive, account, item, signal), /拒绝访问/);
  state = 'redirect';
  await assert.rejects(convertedLink(drive, account, item, signal), /无效的传输地址/);
  state = 'ready';
  const media = new Media();
  const ticket = media.issue(drive, account, item, { type: 'application/pdf', getLink: abort => convertedLink(drive, account, item, abort) });
  await warmPdf(media.ticket(ticket.key, account));
  assert.equal(issued, 2);
  assert.ok(requests.some(([host, pathname, auth]) => host === 'https://graph.microsoft.com' && pathname === route && auth));
  media.clear();
  assert.throws(() => media.ticket(ticket.key, account), /关闭/);
  source.eTag = 'v2';
  await assert.rejects(convertedLink(drive, account, item, signal), /版本已更新/);
  const updated = await drive.get(account, item.id);
  assert.match(await convertedLink(drive, account, updated, signal), /test\/3$/);
});

test('document positions use account, drive, item, version and view, with old recent library records readable', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'study-doc-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const old = { driveId: 'D', id: '1', name: 'report.xlsx' };
  store.touch('A', old);
  const item = { ...old, version: 'v1' };
  assert.equal(store.position('A', item, 'sheet'), null);
  store.touch('A', item);
  const grid = { sheet: 1, row: 80, col: 40 };
  store.setPosition('A', item, 'sheet', grid);
  store.setPosition('A', item, 'pdf', { page: 3 });
  store.touch('A', item);
  const next = new Store(root);
  assert.deepEqual(next.position('A', item, 'sheet'), grid);
  assert.deepEqual(next.position('A', item, 'pdf'), { page: 3 });
  assert.equal(next.position('B', item, 'sheet'), null);
  assert.equal(next.position('A', { ...item, driveId: 'E' }, 'sheet'), null);
  assert.equal(next.position('A', { ...item, version: 'v2' }, 'sheet'), null);
  next.touch('A', { ...item, version: 'v2' });
  assert.equal(next.position('A', item, 'sheet'), null);
});

async function document(t, name, bytes, fileSize = bytes.length, response = {}) {
  const account = { id: 'A' };
  const item = { ...fileType(name), name, size: fileSize, version: '1' };
  const drive = {
    content: async () => 'https://test.1drv.com/synthetic',
    transferUrl: url => url,
    fetcher: async () => new Response(bytes, response)
  };
  const controller = new AbortController();
  const doc = new DocumentSession({ drive, account, item, controller, cache: { getLink: originalLink(drive, account, item) } });
  t.after(() => { controller.abort(); doc.close(); });
  return (operation, input) => doc.request(operation, input);
}

test('spreadsheet worker supports XLSX, legacy XLS, XLSM and ODS with cached values, sheet ranges and numeric formats', async t => {
  for (const ext of ['xlsx', 'xls', 'xlsm', 'ods']) {
    const name = 'grades.' + ext;
    const request = await document(t, name, await fixture(name));
    const { sheets } = await request('parse');
    assert.equal(sheets.length, 2, ext);
    const [row] = await request('cells', { sheet: 0, row: 1, col: 0, height: 1, width: 6 });
    assert.equal(row[0].value, '000172', ext);
    assert.equal(row[3].value, '92', ext);
    if (ext === 'xlsx' || ext === 'xlsm') {
      assert.match(row[1].value, /^2026-\d{2}-\d{2}$/);
      assert.equal(row[3].formula, 'C2+10');
      assert.equal(row[4].value, '');
      assert.equal(row[5].value, '82.0%');
    }
    assert.deepEqual(await request('find', { sheet: 1, query: '教学目标', row: -1, col: -1 }), { row: 77, col: 15 });
  }
});

test('delimited text preserves zeros, spaces, empty cells, quotes and multiline strings', async t => {
  const request = await document(t, 'student-ids.csv', await fixture('student-ids.csv'));
  assert.equal((await request('parse')).sheets[0].cols, 4);
  assert.deepEqual((await request('cells', { sheet: 0, row: 1, col: 0, height: 2, width: 4 })).map(row => row.map(cell => cell.value)),
    [['000123', '张,同学', '去"复习"', ''], ['000009', '李同学', '多行\n备注', '']]);
  const tsv = await document(t, 'student-ids.tsv', await fixture('student-ids.tsv'));
  await tsv('parse');
  assert.equal((await tsv('cell', { sheet: 0, row: 1, col: 0 })).value, '000007');
  const alternate = await document(t, 'alternate.csv', Buffer.from(' X  ;"0012";=1+2'));
  await alternate('parse', { delimiter: ';' });
  assert.deepEqual((await alternate('cells', { sheet: 0, row: 0, col: 0, height: 1, width: 3 }))[0],
    [{ value: ' X  ', formula: '' }, { value: '0012', formula: '' }, { value: '=1+2', formula: '' }]);
});

test('document worker detects GBK and UTF-16 BOM, bounds large text and emits inert Markdown HTML', async t => {
  const gbk = await document(t, 'gbk.txt', await fixture('gbk.txt'));
  assert.equal((await gbk('parse')).encoding, 'gb18030');
  await gbk('parse', { encoding: 'gbk' });
  assert.equal((await gbk('lines', { start: 0 }))[0], '中文测试');
  for (const [name, bom, content] of [['le.txt', [255, 254], [45, 78]], ['be.txt', [254, 255], [78, 45]]]) {
    const utf16 = await document(t, name, Buffer.from([...bom, ...content]));
    await utf16('parse');
    assert.deepEqual(await utf16('lines', { start: 0 }), ['中']);
  }
  const large = await document(t, 'big.txt', Buffer.alloc(9 * 1024 ** 2, 65));
  const result = await large('parse');
  assert.equal(result.count, 8 * 1024 ** 2);
  assert.equal(result.truncated, true);
  assert.match((await large('lines', { start: 0 }))[0], /此行预览已截断/);
  const tooLarge = await document(t, 'huge.xlsx', Buffer.alloc(0), 17 * 1024 ** 2);
  await assert.rejects(tooLarge('parse'), /超过 16 MB/);
  const corrupt = await document(t, 'bad.xlsx', Buffer.from('wrong input'));
  await assert.rejects(corrupt('parse'), /文件内容与表格格式不符/);
  const md = await document(t, 'guide.md', await fixture('guide.md'));
  const rendered = await md('parse');
  assert.match(rendered.html, /<table>/);
  assert.match(rendered.html, /<pre><code/);
  assert.match(rendered.html, /&lt;strong&gt;原样显示 HTML&lt;\/strong&gt;/);
  assert.match(rendered.html, /data-source="\.\//);
  assert.doesNotMatch(rendered.html, /example\.invalid|<img/);
  assert.equal(rendered.headings.at(-1).title, '第二章笔记');
});

test('TXT detection accepts meaningful UTF-16 layouts and only drops a partial terminal codepoint', () => {
  const text = '攻略\n常见说明\n操作步骤\n';
  const le = Buffer.from(text, 'utf16le');
  const be = Buffer.from(le).swap16();
  assert.deepEqual(decodeText(le, 'auto', false), { text, encoding: 'utf-16le' });
  assert.deepEqual(decodeText(be, 'auto', false), { text, encoding: 'utf-16be' });
  const prefix = Buffer.concat([Buffer.from('中'), Buffer.from([0xe6, 0x96])]);
  assert.deepEqual(decodeText(prefix, 'auto', true), { text: '中', encoding: 'utf-8' });
  assert.throws(() => decodeText(prefix, 'utf-8', false), /所选编码/);
  const gb = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x95, 0x32, 0x82]);
  assert.deepEqual(decodeText(gb, 'auto', true), { text: '中文', encoding: 'gb18030' });
  const wide = Buffer.concat([Buffer.from([0xff, 0xfe]), le, Buffer.from([0x2d])]);
  assert.deepEqual(decodeText(wide, 'auto', true), { text, encoding: 'utf-16le' });
  const fourByte = Buffer.from([0x95, 0x32, 0x82, 0x36]);
  assert.deepEqual(decodeText(fourByte, 'auto', false), { text: '𠀀', encoding: 'gb18030' });
  for (const wrong of [Buffer.from('%PDF-1.7\n'), Buffer.from([0x33, 0, 0xa0, 0, 0, 1, 4, 0])]) {
    assert.throws(() => decodeText(wrong, 'auto', false), /二进制/);
  }
});

test('TXT worker distinguishes actual HTTP ranges, a short transfer, HTTP errors and non-text content', async t => {
  const prefix = Buffer.concat([Buffer.from('中'), Buffer.from([0xe6, 0x96])]);
  const partial = await document(t, '样本笔记.txt', prefix, 8, { status: 206, headers: { 'Content-Range': 'bytes 0-4/8' } });
  assert.equal((await partial('parse')).truncated, true);
  assert.deepEqual(await partial('lines', { start: 0 }), ['中']);
  const full = await document(t, '样本笔记.txt', Buffer.from('中'), 3, { status: 206, headers: { 'Content-Range': 'bytes 0-2/3' } });
  assert.equal((await full('parse')).truncated, false);
  const misaligned = await document(t, '样本笔记.txt', Buffer.from('中'), 6, { status: 206, headers: { 'Content-Range': 'bytes 3-5/6' } });
  await assert.rejects(misaligned('parse'), /从文件开头/);
  const early = await document(t, '样本笔记.txt', Buffer.from('中'), 6, { headers: { 'Content-Length': '6' } });
  await assert.rejects(early('parse'), /传输提前结束/);
  const mime = await document(t, '样本笔记.txt', Buffer.from('hello'), 5, { headers: { 'Content-Type': 'image/png' } });
  await assert.rejects(mime('parse'), /文件类型不是文本/);
  const unavailable = await document(t, '样本笔记.txt', Buffer.from('denied'), 6, { status: 403 });
  await assert.rejects(unavailable('parse'), /拒绝访问/);
});
