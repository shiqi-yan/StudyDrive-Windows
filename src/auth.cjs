const { createServer } = require('node:http');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');

const authority = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const scope = 'https://graph.microsoft.com/Files.ReadWrite offline_access';
const restoreScope = 'https://graph.microsoft.com/Files.ReadWrite.All offline_access';
const canRestore = credentials => String(credentials?.scope || '').split(/\s+/).some(value => /(?:^|\/)Files\.ReadWrite\.All$/i.test(value));
const callbackPath = '/study-drive/auth';
const random = () => randomBytes(32).toString('base64url');
const validClientId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

async function listen(server, host = '127.0.0.1', port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server.address().port;
}

const cancelled = () => new Error('Microsoft 登录已取消。');

async function token(clientId, params, fetcher = fetch, signal) {
  if (signal?.aborted) throw cancelled();
  let response;
  try {
    const timeout = AbortSignal.timeout(30000);
    response = await fetcher(authority + '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, scope, ...params }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: 'error'
    });
  } catch {
    if (signal?.aborted) throw cancelled();
    throw new Error('无法连接 Microsoft 登录服务。');
  }
  const data = await response.json().catch(() => ({}));
  if (signal?.aborted) throw cancelled();
  if (!response.ok || typeof data?.access_token !== 'string' || !data.access_token) {
    const error = new Error(data?.error === 'invalid_grant' ? 'Microsoft 登录已失效，请重新登录。' : 'Microsoft 未接受登录请求，请重试。');
    error.reauth = data?.error === 'invalid_grant';
    throw error;
  }
  return { access: data.access_token, refresh: data.refresh_token, expires: Date.now() + Number(data.expires_in || 3600) * 1000,
    ...(typeof data.scope === 'string' && data.scope ? { scope: data.scope } : {}) };
}

async function signIn(rawClientId, openBrowser, options = {}) {
  const clientId = typeof rawClientId === 'string' ? rawClientId.trim() : '';
  if (!validClientId(clientId)) throw new Error('此版本尚未配置 Microsoft 登录。');
  const { signal } = options;
  const requestedScope = options.restore ? restoreScope : scope;
  if (signal?.aborted) throw cancelled();
  const state = random();
  const verifier = random();
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let port;
  let timer;
  let settle;
  let fail;
  let completed = false;
  let phase = 'waiting';
  const resultPath = callbackPath + '/result';
  const messages = {
    waiting: '请在 Microsoft 页面完成授权。',
    processing: '课盘正在验证授权并连接 OneDrive。',
    success: '已连接 OneDrive，可返回课盘。',
    received: '课盘已收到 Microsoft 的授权响应。',
    provider: 'Microsoft 登录服务暂时无法完成授权，请返回课盘重试。',
    refused: 'Microsoft 授权已被拒绝或取消，请返回课盘重试。',
    failed: '课盘未能连接 OneDrive，请返回课盘查看提示并重试。',
    cancelled: '已取消登录，可返回课盘重新登录。',
    expired: '这次登录已过期，请返回课盘重试。'
  };
  const result = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
  result.catch(() => {});
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Connection': 'close',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" };
  const respond = (response, status, message, refresh = false) => {
    response.writeHead(status, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      (refresh ? '<meta http-equiv="refresh" content="1">' : '') +
      '<title>课盘 · Microsoft 授权</title><style>body{margin:0;background:#f4f4ed;color:#262d28;font:16px "Microsoft YaHei UI",sans-serif}main{max-width:36rem;margin:14vh auto;padding:2rem;background:white;border:1px solid #dbe1d4;border-radius:12px}h1{color:#205942}</style>' +
      '<main><h1>课盘</h1><p>' + message + '</p><p>你可以切回课盘窗口。</p></main></html>');
  };
  const cleanRedirect = response => response.writeHead(303, { ...headers, Location: resultPath }).end();
  const serve = (request, response) => {
    if (request.method !== 'GET' || !['127.0.0.1:' + port, '[::1]:' + port, 'localhost:' + port].includes(request.headers.host)) {
      return respond(response, 404, '无效的回调。');
    }
    let url;
    try { url = new URL(request.url, 'http://127.0.0.1'); }
    catch { return respond(response, 400, '无效的回调。'); }
    if (url.origin !== 'http://127.0.0.1') return respond(response, 404, '无效的回调。');
    if (url.pathname === resultPath && !url.search) {
      const status = ['provider', 'refused', 'failed'].includes(phase) ? 400 : ['cancelled', 'expired'].includes(phase) ? 410 : 200;
      return respond(response, status, messages[phase], phase === 'processing');
    }
    if (url.pathname !== callbackPath) return respond(response, 404, '无效的回调。');
    const supplied = Buffer.from(url.searchParams.get('state') || '');
    if (supplied.length !== state.length || !timingSafeEqual(supplied, Buffer.from(state))) return respond(response, 400, '登录状态无效。请使用最初打开的登录页面。');
    if (completed || phase !== 'waiting' || signal?.aborted) return cleanRedirect(response);
    completed = true;
    const authorizationCode = url.searchParams.get('code');
    if (!authorizationCode || url.searchParams.has('error')) {
      phase = url.searchParams.get('error') === 'access_denied' ? 'refused'
        : url.searchParams.get('error') === 'server_error' ? 'provider' : 'failed';
      cleanRedirect(response);
      fail(new Error(messages[phase]));
      return;
    }
    phase = 'processing';
    cleanRedirect(response);
    settle(authorizationCode);
  };
  const createListener = () => createServer({ headersTimeout: 5000, requestTimeout: 5000, connectionsCheckingInterval: 1000 }, serve);
  const servers = [createListener(), createListener()];
  const close = () => { for (const server of servers) if (server.listening) { server.close(); server.closeAllConnections(); } };
  const cancel = () => { phase = 'cancelled'; fail(cancelled()); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    try {
      port = await listen(servers[0]);
      try { await listen(servers[1], '::1', port); }
      catch (error) { if (!['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes(error.code)) throw error; }
    } catch {
      close();
      throw new Error('Windows 无法启动本机登录回调，请重试。');
    }
    const redirect = 'http://localhost:' + port + callbackPath;
    const url = new URL(authority + '/authorize');
    url.search = new URLSearchParams({
      client_id: clientId, response_type: 'code', response_mode: 'query', redirect_uri: redirect,
      scope: requestedScope, state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account'
    });
    if (signal?.aborted) cancel();
    else {
      timer = setTimeout(() => { phase = 'expired'; fail(new Error('Microsoft 登录超时，请重试。')); }, options.timeoutMs ?? 180000);
      Promise.resolve().then(() => {
        if (!signal?.aborted) return openBrowser(url.href);
      }).catch(() => fail(new Error('无法打开 Windows 默认浏览器，请重试。')));
    }
    const code = await result;
    clearTimeout(timer);
    const credentials = await token(clientId, { grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, scope: requestedScope }, options.fetcher, signal);
    const value = options.complete ? await options.complete(credentials) : credentials;
    phase = options.complete ? 'success' : 'received';
    return value;
  } catch (error) {
    if (phase === 'waiting' || phase === 'processing') phase = 'failed';
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    if (options.graceMs === 0) close();
    else {
      for (const server of servers) server.unref();
      setTimeout(close, options.graceMs ?? 60000).unref();
    }
  }
}

module.exports = { listen, signIn, token, validClientId, restoreScope, canRestore };
