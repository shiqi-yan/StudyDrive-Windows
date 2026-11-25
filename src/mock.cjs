const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { extension, fileType } = require('./drive.cjs');

const fixtures = {
  lesson: ['01 · 函数图像与变化.mp4', 'lesson.mp4', 'course'],
  second: ['02 · 图像的平移.mp4', 'lesson.mp4', 'course'],
  audio: ['课后复习音频.m4a', 'review.m4a', 'course'],
  image: ['函数草图.png', 'diagram.png', 'course'],
  pdf: ['第一章讲义.pdf', 'notes.pdf', 'course'],
  text: ['阅读清单.txt', 'reading.txt', 'root']
};
const documentFixtures = {
  office: ['课程计划.docx', 'fixture.docx', 'root'],
  doc: ['中文课程计划.doc', 'fixture.doc', 'documents'],
  ppt: ['中文课程演示.ppt', 'fixture.ppt', 'documents'],
  pptx: ['课程演示.pptx', 'fixture.pptx', 'documents'],
  xlsx: ['课程成绩.xlsx', 'grades.xlsx', 'documents'],
  styled: ['格式与公式.xlsx', 'styled-grades.xlsx', 'documents'],
  xls: ['旧成绩表.xls', 'grades.xls', 'documents'],
  xlsm: ['带宏格式.xlsm', 'grades.xlsm', 'documents'],
  ods: ['开放表格.ods', 'grades.ods', 'documents'],
  csv: ['学号名单.csv', 'student-ids.csv', 'documents'],
  tsv: ['学号分隔表.tsv', 'student-ids.tsv', 'documents'],
  gbk: ['旧中文文本.txt', 'gbk.txt', 'documents'],
  markdown: ['课程导航.md', 'guide.md', 'documents'],
  inlineImage: ['课程图片.png', 'diagram.png', 'documents']
};
const driveId = 'study-drive-demo';
const now = Date.UTC(2026, 9, 16);
const timestamp = i => new Date(now - i * 3600000).toISOString();
const body = async request => {
  const parts = [];
  for await (const chunk of request) parts.push(chunk);
  return Buffer.concat(parts);
};

async function startMock(profile, fixtureDir) {
  const directory = path.join(profile, 'demo-files');
  const stateFile = path.join(directory, 'mock.json');
  fs.mkdirSync(directory, { recursive: true });
  const folder = (id, name, parentId = '') => ({ id, name, parentId, folder: {}, size: 0, lastModifiedDateTime: timestamp(0) });
  const makeFile = (id, name, source, parentId, index) => ({
    id, name, source, parentId, size: fs.statSync(path.join(fixtureDir, source)).size,
    file: { mimeType: fileType(name).type }, lastModifiedDateTime: timestamp(index)
  });
  const seed = () => ({
    port: 0,
    items: [folder('root', '全部文件'), folder('course', '高等数学', 'root'), folder('programming', '程序设计', 'root'),
      folder('reference', '参考资料', 'root'), folder('exercises', '课后练习', 'course'),
      ...Object.entries(fixtures).map(([id, [name, source, parent]], index) => makeFile(id, name, source, parent, index)),
      ...Array.from({ length: 43 }, (_, index) => makeFile('archive-' + index, '资料归档 ' + String(index + 1).padStart(2, '0') + '.txt', 'reading.txt', 'reference', index))],
    sessions: {}
  });
  let data;
  try { data = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    data = seed();
  }
  data.trash ||= {};
  if (!data.documentFixtures) {
    data.items.push(folder('documents', '文档预览示例', 'root'));
    for (const [id, [name, source, parent]] of Object.entries(documentFixtures)) {
      const existing = data.items.find(item => item.id === id);
      const fixture = makeFile(id, name, source, parent, 5);
      if (existing) Object.assign(existing, { ...fixture, name: existing.name });
      else data.items.push(fixture);
    }
    data.documentFixtures = true;
  }
  if (!data.items.some(item => item.id === 'lecture-360p')) {
    data.items.push(makeFile('lecture-360p', '03 · 低清课程样片.mp4', 'lecture-360p-low.mp4', 'course', 5));
  }
  const persist = () => {
    const tmp = stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, stateFile);
  };
  let rootUrl;
  const tokens = new Map();
  const deltaSnapshots = new Map();
  const deltaPages = new Map();
  const test = { ranges: [], metadata: 0, expired: 0, expireNextRange: false, uploadOffsets: [], uploadStatusReads: 0, canceled: 0, failAt: -1, throttle: 0,
    accountOwner: { id: 'local-demo', displayName: '演示账户' }, metadataStatuses: {}, contentStatuses: {},
    quota: { used: 7 * 1024 ** 3, total: 20 * 1024 ** 3 },
    listDelay: 0, listRequests: [], listStatuses: {}, listDelays: {}, listPageSizes: {},
    folderDelay: 0, folderLookups: 0, omitDownloadUrl: false,
    conversions: [], convertedDownloads: 0, convertedExpired: 0, conversionStatus: {}, conversionUnavailable: 0,
    pendingConversions: {}, expireNextConversion: false, relativeImages: [], deltaStatus: 0, deltaRequests: [], restoreStatuses: {}, moveStatuses: {}, deleteStatuses: {},
    mkdirCount: 0, mkdirLostResponse: false, rangeIgnored: false };
  const json = (response, status, data) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
  const raw = item => {
    const { source, parentId, ...safe } = item;
    return { ...safe, eTag: JSON.stringify([item.id, item.lastModifiedDateTime]), webUrl: item.file ? 'https://onedrive.live.com/' : undefined,
      parentReference: { id: parentId, driveId } };
  };
  const itemById = id => data.items.find(item => item.id === id);
  function delta(url, response) {
    test.deltaRequests.push({ next: url.searchParams.has('next'), incremental: url.searchParams.has('token') });
    if (test.deltaStatus) {
      response.writeHead(test.deltaStatus, { 'Retry-After': '1' }).end();
      return;
    }
    const fresh = () => new Map(data.items.map(item => [item.id, raw(item)]));
    const next = url.searchParams.get('next');
    const token = url.searchParams.get('token');
    const previous = token && deltaSnapshots.get(token);
    let page = next && deltaPages.get(next);
    if ((next && !page) || (token && !previous)) {
      response.writeHead(410, { Location: rootUrl + url.pathname }).end();
      return;
    }
    if (!page) {
      const snapshot = fresh();
      const changes = [...snapshot.values()].filter(item => JSON.stringify(item) !== JSON.stringify(previous?.get(item.id)));
      if (previous) {
        for (const id of previous.keys()) if (!snapshot.has(id)) changes.push({ id, deleted: {} });
      }
      page = { snapshot, changes, offset: 0 };
    }
    const link = key => rootUrl + url.pathname + '?' + key + '=' + randomUUID();
    const end = page.offset + 20;
    const value = page.changes.slice(page.offset, end);
    if (end < page.changes.length) {
      const cursor = link('next');
      deltaPages.set(new URL(cursor).searchParams.get('next'), { ...page, offset: end });
      if (deltaPages.size > 500) deltaPages.delete(deltaPages.keys().next().value);
      return json(response, 200, { value, '@odata.nextLink': cursor });
    }
    const cursor = link('token');
    deltaSnapshots.set(new URL(cursor).searchParams.get('token'), page.snapshot);
    if (deltaSnapshots.size > 100) deltaSnapshots.delete(deltaSnapshots.keys().next().value);
    return json(response, 200, { value, '@odata.deltaLink': cursor });
  }
  test.bumpVersion = id => {
    const item = itemById(id);
    item.lastModifiedDateTime = new Date(Date.parse(item.lastModifiedDateTime) + 1000).toISOString();
    persist();
  };
  const unique = (parentId, name) => {
    let candidate = name;
    const suffix = path.extname(name);
    const stem = suffix ? name.slice(0, -suffix.length) : name;
    for (let i = 1; data.items.some(item => item.parentId === parentId && item.name.toLowerCase() === candidate.toLowerCase()); i += 1) {
      candidate = stem + ' (' + i + ')' + suffix;
    }
    return candidate;
  };
  const complete = (parentId, requested, id, total) => {
    const name = unique(parentId, requested);
    const item = { id, name, parentId, size: total, lastModifiedDateTime: new Date().toISOString(), file: { mimeType: fileType(name).type } };
    data.items.push(item);
    persist();
    return item;
  };

  async function serve(request, response) {
    const url = new URL(request.url, rootUrl);
    const method = request.method;
    const pathname = url.pathname;
    if (pathname.startsWith('/cdn/')) {
      if (request.headers.authorization) { response.writeHead(400).end(); return; }
      const value = pathname.split('/').at(-1);
      const item = tokens.get(value);
      if (item && !item.converted && test.contentStatuses[item.id]) {
        response.writeHead(test.contentStatuses[item.id]).end();
        return;
      }
      if (item?.converted && test.expireNextConversion) {
        test.expireNextConversion = false;
        test.convertedExpired += 1;
        tokens.delete(value);
        response.writeHead(403).end();
        return;
      }
      if (!item || (test.expireNextRange && request.headers.range)) {
        if (item) {
          test.expireNextRange = false;
          test.expired += 1;
          tokens.delete(value);
        }
        response.writeHead(403).end();
        return;
      }
      const file = item.source ? path.join(fixtureDir, item.source) : path.join(directory, item.id + '.bin');
      if (item.converted) test.convertedDownloads += 1;
      let start = 0;
      let end = item.size - 1;
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range || '');
      if (range && !test.rangeIgnored) {
        if (!range[1]) start = Math.max(0, item.size - Number(range[2]));
        else {
          start = Number(range[1]);
          if (range[2]) end = Math.min(end, Number(range[2]));
        }
        if (start > end) {
          response.writeHead(416, { 'Content-Range': 'bytes */' + item.size }).end();
          return;
        }
        test.ranges.push({ id: item.id, start, end });
      }
      const headers = { 'Content-Type': item.file.mimeType, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
      if (range) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + item.size;
      response.writeHead(range && !test.rangeIgnored ? 206 : 200, headers);
      if (method === 'HEAD' || !item.size) response.end();
      else {
        const stream = fs.createReadStream(file, { start, end, highWaterMark: test.throttle ? 32 * 1024 : 256 * 1024 });
        if (test.throttle) {
          for await (const part of stream) {
            if (response.destroyed) break;
            response.write(part);
            await new Promise(resolve => setTimeout(resolve, test.throttle));
          }
          if (!response.destroyed) response.end();
        } else await pipeline(stream, response).catch(() => {});
      }
      return;
    }
    if (pathname.startsWith('/upload/')) {
      const id = pathname.split('/').at(-1);
      const session = data.sessions[id];
      if (!session) return json(response, 404, {});
      const transfer = path.join(directory, id + '.upload');
      const progress = () => ({ nextExpectedRanges: [session.offset + '-'], expirationDateTime: session.expires });
      if (method === 'GET') {
        test.uploadStatusReads += 1;
        return json(response, 200, progress());
      }
      if (method === 'DELETE') {
        test.canceled += 1;
        delete data.sessions[id];
        fs.rmSync(transfer, { force: true });
        persist();
        response.writeHead(204).end();
        return;
      }
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(request.headers['content-range'] || '');
      if (method !== 'PUT' || !range) return json(response, 400, {});
      const [, startText, endText, totalText] = range;
      const [start, end, total] = [startText, endText, totalText].map(Number);
      if (start !== session.offset || end >= total) return json(response, 416, {});
      const bytes = await body(request);
      if (bytes.length !== end - start + 1) return json(response, 400, {});
      test.uploadOffsets.push(start);
      if (test.failAt === start) {
        test.failAt = -1;
        return json(response, 503, {});
      }
      fs.appendFileSync(transfer, bytes);
      session.offset = end + 1;
      if (session.offset !== total) {
        persist();
        return json(response, 202, progress());
      }
      fs.renameSync(transfer, path.join(directory, id + '.bin'));
      delete data.sessions[id];
      return json(response, 201, raw(complete(session.parent, session.name, id, total)));
    }
    if (request.headers.authorization !== 'Bearer mock-account') return json(response, 401, {});
    if (pathname === '/v1.0/me/drive') return json(response, 200, { id: driveId, driveType: 'personal', owner: { user: test.accountOwner } });
    const restore = /^\/v1\.0\/me\/drive\/items\/([^/]+)\/restore$/.exec(pathname);
    if (method === 'POST' && restore) {
      const id = decodeURIComponent(restore[1]);
      if (test.restoreStatuses[id]) {
        response.setHeader('Retry-After', '1');
        return json(response, test.restoreStatuses[id], {});
      }
      if (!Object.hasOwn(data.trash, id)) return json(response, 404, {});
      const removed = data.trash[id];
      const item = removed.find(row => row.id === id);
      const options = JSON.parse(await body(request));
      const parent = options.parentReference?.id || item.parentId;
      const name = options.name || item.name;
      if (!itemById(parent)?.folder) return json(response, 400, {});
      if (unique(parent, name) !== name) return json(response, 409, {});
      item.parentId = parent;
      item.name = name;
      delete data.trash[id];
      data.items.push(...removed);
      persist();
      return json(response, 200, raw(item));
    }
    const stem = '/v1.0/drives/' + driveId;
    if (method === 'GET' && pathname === stem + '/root/delta') return delta(url, response);
    if (method === 'GET' && pathname === stem) return json(response, 200, { id: driveId, quota: test.quota });
    if (pathname === stem + '/root') return json(response, 200, raw(itemById('root')));
    const itemSpec = new RegExp('^' + stem + '/items/([^/:]+)(.*)$').exec(pathname);
    const search = /^\/root\/search\(q='(.*)'\)$/.exec(pathname.slice(stem.length));
    const node = itemSpec && itemById(decodeURIComponent(itemSpec[1]));
    const suffix = itemSpec?.[2];
    if (method === 'GET' && (search || node?.folder && suffix === '/children')) {
      const id = node?.id || 'search';
      test.listRequests.push({ id, paged: url.searchParams.has('offset') });
      const delay = test.listDelays[id] ?? test.listDelay;
      const status = test.listStatuses[id];
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (status) return json(response, status, {});
      const query = search ? decodeURIComponent(search[1]).replaceAll("''", "'").toLowerCase() : '';
      const source = data.items.filter(item => search ? item.id !== 'root' && item.name.toLowerCase().includes(query) : item.parentId === node.id);
      const order = url.searchParams.get('$orderby') || '';
      source.sort((a, b) => order.startsWith('size') ? b.size - a.size
        : order.endsWith('DateTime desc') ? b.lastModifiedDateTime.localeCompare(a.lastModifiedDateTime)
          : order.endsWith('DateTime asc') ? a.lastModifiedDateTime.localeCompare(b.lastModifiedDateTime)
            : a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
      const offset = Number(url.searchParams.get('offset')) || 0;
      const limit = test.listPageSizes[id] || Math.min(15, Number(url.searchParams.get('$top')) || 15);
      const result = { value: source.slice(offset, offset + limit).map(raw) };
      if (offset + limit < source.length) {
        url.searchParams.set('offset', offset + limit);
        result['@odata.nextLink'] = url.href;
      }
      return json(response, 200, result);
    }
    if (!node) return json(response, 404, {});
    if (method === 'GET' && suffix === '' && test.metadataStatuses[node.id]) return json(response, test.metadataStatuses[node.id], {});
    if (method === 'GET' && node.folder && /^:\/[^/]+$/.test(suffix)) {
      const name = decodeURIComponent(suffix.slice(2));
      test.relativeImages.push(name);
      const image = data.items.find(item => item.parentId === node.id && item.name.toLowerCase() === name.toLowerCase());
      return image ? json(response, 200, raw(image)) : json(response, 404, {});
    }
    if (method === 'GET' && suffix === '/content' && url.searchParams.get('format') === 'pdf') {
      test.conversions.push({ path: pathname + url.search, version: raw(node).eTag });
      if (test.conversionUnavailable) return json(response, test.conversionUnavailable, {});
      if (test.conversionStatus[node.id]) return json(response, test.conversionStatus[node.id], {});
      if (test.pendingConversions[node.id] > 0) {
        test.pendingConversions[node.id] -= 1;
        response.writeHead(202, { 'Retry-After': '1' }).end();
        return;
      }
      if (!['doc', 'docx', 'ppt', 'pptx', 'pps', 'ppsx', 'rtf', 'odt', 'odp', 'xls', 'xlsx'].includes(extension(node.name))) return json(response, 400, {});
      const key = randomUUID();
      const fixture = makeFile(node.id, '转换结果.pdf', 'notes.pdf', node.parentId, 0);
      tokens.set(key, { ...fixture, converted: true });
      if (tokens.size > 500) tokens.delete(tokens.keys().next().value);
      response.writeHead(302, { Location: rootUrl + '/cdn/' + key }).end();
      return;
    }
    if (method === 'GET' && suffix === '/content' && node.file) {
      const key = randomUUID();
      tokens.set(key, node);
      if (tokens.size > 500) tokens.delete(tokens.keys().next().value);
      test.metadata += 1;
      response.writeHead(302, { Location: rootUrl + '/cdn/' + key }).end();
      return;
    }
    if (method === 'GET' && !suffix) {
      if (node.folder) {
        test.folderLookups += 1;
        if (test.folderDelay) await new Promise(resolve => setTimeout(resolve, test.folderDelay));
      }
      const result = raw(node);
      if (node.file && !test.omitDownloadUrl) {
        const key = randomUUID();
        tokens.set(key, node);
        if (tokens.size > 500) tokens.delete(tokens.keys().next().value);
        result['@microsoft.graph.downloadUrl'] = rootUrl + '/cdn/' + key;
        test.metadata += 1;
      }
      return json(response, 200, result);
    }
    if (method === 'PATCH' && !suffix) {
      const patch = JSON.parse(await body(request));
      if (patch.parentReference && test.moveStatuses[node.id]) {
        response.setHeader('Retry-After', '1');
        return json(response, test.moveStatuses[node.id], {});
      }
      const name = patch.name ?? node.name;
      const parent = patch.parentReference?.id ?? node.parentId;
      if (!itemById(parent)?.folder || node.id === 'root') return json(response, 400, {});
      for (let current = itemById(parent); current; current = itemById(current.parentId)) {
        if (current.id === node.id) return json(response, 400, {});
      }
      if (data.items.some(item => item !== node && item.parentId === parent && item.name.toLowerCase() === name.toLowerCase())) return json(response, 409, {});
      node.name = name;
      node.parentId = parent;
      node.lastModifiedDateTime = new Date().toISOString();
      persist();
      return json(response, 200, raw(node));
    }
    if (method === 'DELETE' && !suffix && node.id !== 'root') {
      if (test.deleteStatuses[node.id]) {
        response.setHeader('Retry-After', '1');
        return json(response, test.deleteStatuses[node.id], {});
      }
      const deleted = new Set([node.id]);
      let lastSize;
      do {
        lastSize = deleted.size;
        for (const item of data.items) if (deleted.has(item.parentId)) deleted.add(item.id);
      } while (lastSize !== deleted.size);
      data.trash[node.id] = data.items.filter(item => deleted.has(item.id));
      data.items = data.items.filter(item => !deleted.has(item.id));
      persist();
      response.writeHead(204).end();
      return;
    }
    if (method === 'POST' && suffix === '/children') {
      const options = JSON.parse(await body(request));
      const name = unique(node.id, options.name);
      if (options['@microsoft.graph.conflictBehavior'] === 'fail' && name !== options.name) return json(response, 409, {});
      const created = folder(randomUUID(), name, node.id);
      data.items.push(created);
      test.mkdirCount += 1;
      persist();
      if (test.mkdirLostResponse) { test.mkdirLostResponse = false; response.destroy(); return; }
      return json(response, 201, raw(created));
    }
    const upload = /^:\/([^/]+):\/(createUploadSession|content)$/.exec(suffix);
    if (upload && node.folder) {
      const name = decodeURIComponent(upload[1]);
      const id = randomUUID();
      if (upload[2] === 'content' && method === 'PUT') {
        fs.writeFileSync(path.join(directory, id + '.bin'), await body(request));
        return json(response, 201, raw(complete(node.id, name, id, 0)));
      }
      if (method === 'POST') {
        const info = JSON.parse(await body(request));
        if (info.item?.['@microsoft.graph.conflictBehavior'] !== 'rename') return json(response, 400, {});
        const expires = new Date(Date.now() + 3600000).toISOString();
        data.sessions[id] = { parent: node.id, name, offset: 0, expires };
        persist();
        return json(response, 200, { uploadUrl: rootUrl + '/upload/' + id, expirationDateTime: expires });
      }
    }
    return json(response, 404, {});
  }
  const server = http.createServer((request, response) => serve(request, response).catch(() => {
    if (!response.headersSent) json(response, 500, {});
    else response.destroy();
  }));
  async function bind(port) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  }
  await bind(data.port).catch(error => {
    if (error.code !== 'EADDRINUSE') throw error;
    return bind(0);
  });
  data.port = server.address().port;
  persist();
  rootUrl = 'http://127.0.0.1:' + data.port;
  return { base: rootUrl + '/v1.0', test, server };
}

module.exports = { startMock };
