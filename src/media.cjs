const { createServer, request: httpRequest } = require('node:http');
const { request: httpsRequest } = require('node:https');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { listen } = require('./auth.cjs');
const { statusError, redirectCodes } = require('./drive.cjs');

const origin = 'study://desktop';
const revalidate = new Set([401, 403, 404, 410]);
const validRange = /^bytes=(?:\d+-\d*|-\d+)$/;
const numberHeader = value => value !== null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value));
function transportError(error, proxied) {
  const certificate = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|TLS/.test(error?.code || '');
  return Object.assign(new Error(certificate ? '无法验证 OneDrive 文件服务器的 TLS 连接。'
    : proxied ? '无法连接 OneDrive 文件服务器，请检查网络或系统代理。'
      : '无法连接 OneDrive 文件服务器，请检查网络。'), { retryLink: true });
}

async function validateContent(response, range) {
  const contentType = response.headers.get('content-type') || '';
  const contentRange = response.headers.get('content-range') || '';
  const length = response.headers.get('content-length');
  const encoding = response.headers.get('content-encoding');
  let problem;
  if (response.ok && /^\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)) problem = 'OneDrive 返回了网页，未提供文件数据。';
  else if (response.ok && encoding && encoding.toLowerCase() !== 'identity') problem = 'OneDrive 返回了无法用于预览的压缩传输。';
  else if (response.status === 206) {
    const actual = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange);
    const expected = /^bytes=(\d*)-(\d*)$/.exec(range || '');
    if (!actual || !actual.slice(1, 3).every(numberHeader) || Number(actual[1]) > Number(actual[2]) ||
      actual[3] !== '*' && (!numberHeader(actual[3]) || Number(actual[2]) >= Number(actual[3])) ||
      length !== null && (!numberHeader(length) || Number(length) !== Number(actual[2]) - Number(actual[1]) + 1) ||
      expected?.[1] && Number(expected[1]) !== Number(actual[1]) ||
      expected?.[1] && expected[2] && Number(actual[2]) > Number(expected[2])) {
      problem = 'OneDrive 返回的文件分段信息无效。';
    }
  } else if (response.status === 416 && !/^bytes \*\/\d+$/i.test(contentRange)) {
    problem = 'OneDrive 未返回有效的文件范围。';
  }
  if (problem) {
    await response.body?.cancel().catch(() => {});
    throw new Error(problem);
  }
}

// A superseded Range or closed window can cancel a signed request at any stage.
// Keep this transport off Undici's fetch abort listener in Electron's Node.
function requestMedia(url, { headers, signal }) {
  const endpoint = new URL(url);
  const request = endpoint.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = request(endpoint, { headers, signal }, message => {
      const status = message.statusCode;
      const noBody = [204, 205, 304].includes(status);
      if (noBody) message.resume();
      try { resolve(new Response(noBody ? null : Readable.toWeb(message), { status, headers: message.headers })); }
      catch (error) { message.destroy(); reject(error); }
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
}

async function fetchContent(drive, account, item, range, signal, cache, linkSignal = signal) {
  async function fetchOnce(stale) {
    if (stale && cache.url === stale) cache.until = 0;
    if (!cache.url || cache.until < Date.now()) {
      if (!cache.pending) {
        const getLink = cache.getLink || ((signal, stale) => drive.content(account, item.id, signal, undefined, !!stale));
        const pending = getLink(linkSignal, stale).then(url => {
          cache.url = url;
          cache.until = Date.now() + 25000;
          return url;
        }).finally(() => { if (cache.pending === pending) cache.pending = null; });
        cache.pending = pending;
      }
      await cache.pending;
    }
    const headers = { 'Accept-Encoding': 'identity' };
    if (range) headers.Range = range;
    const signed = cache.url;
    let url = drive.transferUrl(signed, cache.purpose);
    for (let hop = 0; hop < 4; hop += 1) {
      const timeout = new AbortController();
      const deadline = setTimeout(() => timeout.abort(), 25000);
      let response;
      try {
        const fetcher = cache.fetcher || drive.fetcher;
        const requestSignal = AbortSignal.any([signal, timeout.signal]);
        try {
          response = await fetcher(url, { headers, signal: requestSignal, redirect: 'manual' });
        } catch (error) {
          if (requestSignal.aborted) throw error;
          if (!drive.proxyFetcher || fetcher === drive.proxyFetcher) throw transportError(error, false);
          try { response = await drive.proxyFetcher(url, { headers, signal: requestSignal, redirect: 'manual' }); }
          catch (error) {
            if (requestSignal.aborted) throw error;
            throw transportError(error, true);
          }
        }
      } catch (error) {
        if (timeout.signal.aborted && !signal.aborted) throw Object.assign(new Error('读取 OneDrive 文件响应超时。'), { retryLink: true });
        throw error;
      } finally { clearTimeout(deadline); }
      if (!redirectCodes.has(response.status)) return { response, signed };
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) break;
      url = drive.transferUrl(new URL(location, url).href, cache.purpose);
    }
    throw new Error('OneDrive 内容重定向无效。');
  }
  let refreshed = false;
  let { response, signed } = await fetchOnce().catch(error => {
    if (!error.retryLink || signal.aborted) throw error;
    refreshed = true;
    return fetchOnce(cache.url);
  });
  if (!refreshed && revalidate.has(response.status)) {
    await response.body?.cancel();
    ({ response } = await fetchOnce(signed));
  }
  await validateContent(response, range);
  return response;
}

class Media {
  constructor(fetcher) { this.tickets = new Map(); this.fetcher = fetcher; }
  async start() {
    this.server = createServer((request, response) => this.handle(request, response));
    const port = await listen(this.server);
    this.host = '127.0.0.1:' + port;
  }
  issue(drive, account, item, { type = item.type, getLink, purpose } = {}) {
    const key = randomUUID();
    this.tickets.set(key, { drive, account, item, type, cache: { getLink, fetcher: this.fetcher, purpose }, controller: new AbortController(), children: new Map() });
    return { key, url: 'http://' + this.host + '/media/' + key };
  }
  ticket(key, account) {
    const ticket = this.tickets.get(key);
    if (!ticket || ticket.account.id !== account.id) throw new Error('当前预览已关闭。');
    return ticket;
  }
  nativeSource(key, account) {
    const ticket = this.ticket(key, account);
    if (!['audio', 'video'].includes(ticket.view)) throw new Error('当前文件不是可播放媒体。');
    ticket.nativeSecret ||= randomUUID();
    return { url: 'http://' + this.host + '/media/' + key, secret: ticket.nativeSecret };
  }
  release(key) {
    const ticket = this.tickets.get(key);
    ticket?.controller.abort();
    ticket?.document?.close();
    this.tickets.delete(key);
    for (const child of ticket?.children.values() || []) this.release(child.key);
  }
  clear() { for (const key of this.tickets.keys()) this.release(key); }
  async handle(request, response) {
    const key = /^\/media\/([a-f0-9-]{36})$/.exec(request.url)?.[1];
    const ticket = this.tickets.get(key);
    const native = ticket?.nativeSecret && request.headers['x-study-native'] === ticket.nativeSecret &&
      request.headers.origin === undefined && ['GET', 'HEAD'].includes(request.method);
    if (request.headers.host !== this.host || !ticket || !(native || request.headers.origin === origin)) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Headers', 'Range');
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    response.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405).end();
      return;
    }
    const range = request.headers.range;
    if (range && !validRange.test(range)) {
      response.writeHead(416, { 'Content-Range': 'bytes */' + (ticket.localPdf?.length ?? ticket.item.size) }).end();
      return;
    }
    if (ticket.localPdf) {
      sendLocalPdf(request, response, ticket.localPdf, range);
      return;
    }
    const client = new AbortController();
    response.once('close', () => { if (!response.writableFinished) client.abort(); });
    const signal = AbortSignal.any([client.signal, ticket.controller.signal]);
    try {
      const upstream = await fetchContent(ticket.drive, ticket.account, ticket.item, range, signal, ticket.cache, ticket.controller.signal);
      if (!upstream.ok && upstream.status !== 416) {
        await upstream.body?.cancel();
        throw statusError(upstream.status);
      }
      ticket.failure = '';
      if (upstream.status === 416) {
        await upstream.body?.cancel().catch(() => {});
        response.writeHead(416, { 'Content-Range': upstream.headers.get('content-range'), 'Content-Length': '0' }).end();
        return;
      }
      const headers = { 'Content-Type': ticket.type };
      for (const name of ['content-length', 'content-range', 'accept-ranges']) {
        const value = upstream.headers.get(name);
        if (value && !(name === 'accept-ranges' && range && upstream.status === 200)) headers[name] = value;
      }
      response.writeHead(upstream.status, headers);
      if (request.method === 'HEAD' || !upstream.body) {
        await upstream.body?.cancel();
        response.end();
      } else await pipeline(Readable.fromWeb(upstream.body), response, { signal });
    } catch (error) {
      if (!signal.aborted) {
        const safe = typeof error?.message === 'string' && /^(?:OneDrive |Windows )?[\u3400-\u9fff]/u.test(error.message) && !/[:/\\\r\n]/.test(error.message);
        ticket.failure = safe ? error.message : 'OneDrive 文件连接已中断，请重试。';
      }
      if (!response.destroyed && !response.headersSent) response.writeHead(502).end();
      else if (!response.destroyed) response.destroy();
    }
  }
}

function sendLocalPdf(request, response, pdf, range) {
  const total = pdf.length;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range || '');
  const start = !match ? 0 : match[1] ? Number(match[1]) : Math.max(0, total - Number(match[2]));
  const end = Math.min(total - 1, match?.[1] && match[2] ? Number(match[2]) : total - 1);
  if (start > end) {
    response.writeHead(416, { 'Content-Range': 'bytes */' + total, 'Content-Length': '0' }).end();
    return;
  }
  const headers = { 'Content-Type': 'application/pdf', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
  response.writeHead(range ? 206 : 200, headers).end(request.method === 'HEAD' ? undefined : pdf.subarray(start, end + 1));
}

module.exports = { Media, fetchContent, origin, requestMedia };
