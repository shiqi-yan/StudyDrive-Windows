const { token, canRestore, restoreScope } = require('./auth.cjs');

const select = 'id,name,size,folder,file,parentReference,lastModifiedDateTime,eTag,cTag,webUrl,remoteItem';
const deltaFields = select + ',deleted,package,root';
const encoded = value => encodeURIComponent(String(value)).replaceAll("'", '%27');
const itemPath = (driveId, id) => '/drives/' + encoded(driveId) + '/items/' + encoded(id);
const mediaTypes = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif', pdf: 'application/pdf' };
const documentTypes = {
  office: /^(docx?|pptx?|ppsx?|rtf|odt|odp)$/,
  sheet: /^(xlsx?|xlsm|ods|csv|tsv)$/,
  markdown: /^(md|markdown)$/,
  text: /^(txt|log|json|ya?ml|xml)$/
};
const extension = name => name.includes('.') ? name.split('.').at(-1).toLowerCase() : '';
const consumerHosts = ['1drv.com', 'onedrive.com', 'onedrive.live.com', 'microsoftpersonalcontent.com', 'storage.live.com', 'docs.live.net', 'livefilestore.com', 'storage.msn.com'];
const conversionHosts = [...consumerHosts, 'svc.ms', 'officeapps.live.com'];
const redirectCodes = new Set([301, 302, 303, 307, 308]);
function fileType(name, mime = '') {
  const ext = extension(name);
  for (const [kind, pattern] of Object.entries(documentTypes)) {
    if (pattern.test(ext)) return { kind, type: 'application/octet-stream' };
  }
  // Only a known safe raster image or a supported media extension is served inline.
  const type = mediaTypes[ext] || Object.values(mediaTypes).find(known => known === mime) || '';
  if (type) return { kind: type === 'application/pdf' ? 'pdf' : type.split('/')[0], type };
  return { kind: /^(one|vsdx?)$/.test(ext) ? 'online' : 'other', type: 'application/octet-stream' };
}

function itemInfo(raw, driveId) {
  if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') throw new Error('OneDrive 返回的文件资料不完整。');
  const { kind, type } = raw.remoteItem ? { kind: 'shortcut', type: '' }
    : raw.folder ? { kind: 'folder', type: '' } : raw.package ? { kind: 'online', type: '' } : fileType(raw.name, raw.file?.mimeType);
  return { id: raw.id, driveId, name: raw.name, parentId: raw.parentReference?.id || '', kind, type,
    size: Number(raw.size) || 0, modified: raw.lastModifiedDateTime || '', children: raw.folder?.childCount || 0,
    etag: raw.eTag || '', ctag: raw.cTag || '',
    version: raw.cTag || raw.eTag || JSON.stringify([raw.lastModifiedDateTime || '', Number(raw.size) || 0]) };
}

function safeName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 255 || /[. ]$/.test(name) || /[\\/:*?"<>|\u0000-\u001f]/.test(name) ||
      /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(name) || /_vti_|^(\.lock$|desktop\.ini$|~\$)/i.test(name)) {
    throw new Error('此名称不符合 Windows / OneDrive 文件命名规则。');
  }
  return name;
}

class Drive {
  constructor({ base = 'https://graph.microsoft.com/v1.0', clientId, credentials, save, fetcher = fetch, mock = false }) {
    Object.assign(this, { base, clientId, credentials, save, fetcher, mock });
  }
  async access(force = false) {
    if (this.mock) return this.credentials.access;
    if (!force && this.credentials.access && this.credentials.expires > Date.now() + 60000) return this.credentials.access;
    if (!this.credentials.refresh) throw new Error('请重新登录 Microsoft。');
    if (!this.refreshing) {
      this.refreshing = token(this.clientId, { grant_type: 'refresh_token', refresh_token: this.credentials.refresh,
        ...(canRestore(this.credentials) ? { scope: restoreScope } : {}) }, this.fetcher)
        .then(fresh => {
          this.credentials = { ...fresh, refresh: fresh.refresh || this.credentials.refresh,
            scope: fresh.scope || this.credentials.scope };
          this.save?.(this.credentials);
          return fresh.access;
        }).finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }
  async response(path, options = {}, redirect = 'error') {
    const url = new URL(path.startsWith('/') ? this.base + path : path);
    const base = new URL(this.base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname + '/')) throw new Error('OneDrive 返回了无效的分页地址。');
    const perform = async access => {
      const headers = new Headers(options.headers);
      headers.set('Authorization', 'Bearer ' + access);
      if (options.body && typeof options.body === 'string') headers.set('Content-Type', 'application/json');
      try {
        return await this.fetcher(url, { ...options, headers, redirect, signal: options.signal || AbortSignal.timeout(30000) });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        throw Object.assign(new Error('无法连接 OneDrive，请检查网络后重试。'), { network: true });
      }
    };
    let access = await this.access();
    let response = await perform(access);
    if (response.status === 401 && !this.mock) {
      response.body?.cancel().catch(() => {});
      access = this.credentials.access === access ? await this.access(true) : await this.access();
      response = await perform(access);
    }
    return response;
  }
  async request(path, options = {}) {
    const response = await this.response(path, options);
    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      const error = statusError(response.status);
      const retry = response.headers.get('retry-after');
      if (retry) error.retryAfter = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
      throw error;
    }
    return response.status === 204 ? {} : response.json();
  }
  async identity(signal) {
    const drive = await this.request('/me/drive?$select=id,driveType,owner', { signal });
    if (drive.driveType !== 'personal' || !drive.id) throw new Error('此版本支持 OneDrive 个人版。');
    const root = await this.request('/drives/' + encoded(drive.id) + '/root?$select=' + select, { signal });
    return {
      id: JSON.stringify([drive.owner?.user?.id || drive.id, drive.id]),
      name: drive.owner?.user?.displayName || 'Microsoft 个人账户',
      driveId: drive.id,
      root: itemInfo(root, drive.id)
    };
  }
  async quota(account, signal) {
    const { quota } = await this.request('/drives/' + encoded(account.driveId) + '?$select=quota', { signal });
    if (!Number.isSafeInteger(quota?.total) || quota.total <= 0 || !Number.isSafeInteger(quota.used) || quota.used < 0) return null;
    return { used: quota.used, total: quota.total };
  }
  async list(account, { id, query, sort, next, signal }) {
    const params = new URLSearchParams({ '$select': select, '$top': '40' });
    const sortFields = { name: 'name asc', newest: 'lastModifiedDateTime desc', oldest: 'lastModifiedDateTime asc', largest: 'size desc' };
    if (!query) params.set('$orderby', sortFields[sort] || sortFields.name);
    const stem = query ? '/drives/' + encoded(account.driveId) + "/root/search(q='" + encoded(query.replaceAll("'", "''")) + "')" : itemPath(account.driveId, id) + '/children';
    const data = await this.request(next || stem + '?' + params, { signal });
    return { items: (data.value || []).map(raw => itemInfo(raw, account.driveId)), next: data['@odata.nextLink'] || '' };
  }
  deltaStart(account) {
    return this.base + '/drives/' + encoded(account.driveId) + '/root/delta?' +
      new URLSearchParams({ '$select': deltaFields, '$top': '200' });
  }
  deltaLink(account, value) {
    if (typeof value !== 'string' || value.length > 32768) throw new Error('OneDrive 返回了无效的同步地址。');
    const base = new URL(this.base);
    const url = new URL(value);
    const suffix = url.pathname.indexOf('(');
    const pathname = decodeURIComponent(suffix < 0 ? url.pathname : url.pathname.slice(0, suffix));
    const paths = ['/drives/' + account.driveId + '/root/delta',
      '/drives/' + account.driveId + '/items/' + account.root.id + '/delta', '/me/drive/root/delta'];
    if (url.origin !== base.origin || url.username || url.password || url.hash ||
        suffix >= 0 && !/^\([^/]*\)$/.test(url.pathname.slice(suffix)) ||
        !paths.some(path => pathname === base.pathname + path)) {
      throw new Error('OneDrive 返回了无效的同步地址。');
    }
    return value;
  }
  async deltaPage(account, link, signal) {
    const response = await this.response(this.deltaLink(account, link), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)])
    });
    if (!response.ok) {
      const error = statusError(response.status);
      const retry = response.headers.get('retry-after');
      if (retry) error.retryAfter = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
      if (response.status === 410) {
        const location = response.headers.get('location');
        if (location) {
          try { error.restart = this.deltaLink(account, location); }
          catch { /* A new tokenless request is safe when the recovery link is invalid. */ }
        }
      }
      await response.body?.cancel().catch(() => {});
      throw error;
    }
    const result = await response.json();
    if (!Array.isArray(result.value) || !!result['@odata.nextLink'] === !!result['@odata.deltaLink']) {
      throw new Error('OneDrive 返回了不完整的同步资料。');
    }
    const next = result['@odata.nextLink'] ? this.deltaLink(account, result['@odata.nextLink']) : '';
    if (next === link) throw new Error('OneDrive 返回了重复的同步地址。');
    return { items: result.value, next, delta: next ? '' : this.deltaLink(account, result['@odata.deltaLink']) };
  }
  indexItem(account, id, signal) {
    return this.request(itemPath(account.driveId, id) + '?$select=' + deltaFields,
      { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  }
  async get(account, id, signal) {
    const raw = await this.request(itemPath(account.driveId, id) + '?$select=' + select, { signal });
    if (raw.remoteItem) throw new Error('此文件位于另一个 OneDrive，无法从当前目录预览。');
    return itemInfo(raw, account.driveId);
  }
  async relativeImage(account, parentId, name, signal) {
    const raw = await this.request(itemPath(account.driveId, parentId) + ':/' + encoded(name) + '?$select=' + select, { signal });
    if (raw.remoteItem || raw.parentReference?.id !== parentId || raw.parentReference?.driveId !== account.driveId) {
      throw new Error('图片不在当前 OneDrive 目录中。');
    }
    const item = itemInfo(raw, account.driveId);
    if (item.kind !== 'image' || item.size > 12 * 1024 ** 2) throw new Error('图片格式不受支持或文件过大。');
    return item;
  }
  async trail(account, item, lookup = id => this.get(account, id)) {
    const path = [];
    const seen = new Set();
    for (let current = item; current && current.id !== account.root.id; current = current.parentId ? await lookup(current.parentId) : null) {
      if (seen.has(current.id) || path.length >= 64) throw new Error('文件夹路径无效。');
      seen.add(current.id);
      path.unshift(current);
    }
    return [account.root, ...path];
  }
  async mkdir(account, parent, name, signal, conflict = 'rename') {
    const body = { name: safeName(name), folder: {}, '@microsoft.graph.conflictBehavior': conflict };
    return itemInfo(await this.request(itemPath(account.driveId, parent) + '/children', { method: 'POST', body: JSON.stringify(body), signal }), account.driveId);
  }
  async namedChild(account, parent, name, signal) {
    try {
      const raw = await this.request(itemPath(account.driveId, parent) + ':/' + encoded(name) + '?$select=' + select, { signal });
      if (raw.remoteItem || raw.parentReference?.id && raw.parentReference.id !== parent ||
          raw.parentReference?.driveId && raw.parentReference.driveId !== account.driveId) throw new Error('名称指向当前目录之外。');
      return itemInfo(raw, account.driveId);
    } catch (error) {
      if (error.status !== 404) throw error;
      return null;
    }
  }
  async ensureFolder(account, parent, name, signal) {
    const lookup = async () => {
      const item = await this.namedChild(account, parent, name, signal);
      if (item && item.kind !== 'folder') throw Object.assign(new Error('存在同名文件，请更改本地文件夹名称。'), { safe: true });
      return item;
    };
    const existing = await lookup();
    if (existing) return existing;
    try { return await this.mkdir(account, parent, name, signal, 'fail'); }
    catch (error) {
      if (signal?.aborted || error.status === 429) throw error;
      const found = await lookup();
      if (found) return found;
      throw error;
    }
  }
  async rename(account, id, name) {
    const body = JSON.stringify({ name: safeName(name) });
    const updated = await this.request(itemPath(account.driveId, id), { method: 'PATCH', body });
    return itemInfo(updated, account.driveId);
  }
  async move(account, id, target, signal) {
    const body = JSON.stringify({ parentReference: { id: target } });
    return itemInfo(await this.request(itemPath(account.driveId, id), { method: 'PATCH', body, signal }), account.driveId);
  }
  remove(account, id, signal) {
    return this.request(itemPath(account.driveId, id), { method: 'DELETE', signal });
  }
  get restoreAvailable() { return this.mock || canRestore(this.credentials); }
  async restore(account, id, { parent, name } = {}, signal) {
    if (!this.restoreAvailable) throw Object.assign(new Error('请先在回收站授权还原权限。'), { safe: true, status: 403 });
    const body = JSON.stringify({ ...(parent ? { parentReference: { id: parent } } : {}), ...(name ? { name: safeName(name) } : {}) });
    const raw = await this.request('/me/drive/items/' + encoded(id) + '/restore', { method: 'POST', body, signal });
    return itemInfo(raw, account.driveId);
  }
  async content(account, id, signal, version, preferRedirect = false) {
    const stem = itemPath(account.driveId, id);
    if (!preferRedirect || version) {
      const raw = await this.request(stem + '?$select=' + (version ? select : 'id') + ',@microsoft.graph.downloadUrl', { signal });
      if (version && (raw.remoteItem || itemInfo(raw, account.driveId).version !== version)) throw new Error('文件版本已更新，请重新打开预览。');
      if (!preferRedirect && raw['@microsoft.graph.downloadUrl']) {
        try { return this.transferUrl(raw['@microsoft.graph.downloadUrl']); } catch { /* Try the documented Graph content redirect. */ }
      }
    }
    const response = await this.response(stem + '/content', { signal }, 'manual');
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (redirectCodes.has(response.status)) return this.transferUrl(location);
    if (!response.ok) throw statusError(response.status);
    throw new Error('OneDrive 内容端点未返回临时下载地址。');
  }
  async webUrl(account, id) {
    const raw = await this.request(itemPath(account.driveId, id) + '?$select=id,webUrl');
    let url;
    try { url = new URL(raw.webUrl); } catch { throw new Error('OneDrive 没有返回可用的文件打开地址。'); }
    const host = url.hostname;
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !['onedrive.live.com', '1drv.ms', 'd.docs.live.net'].includes(host)) {
      throw new Error('OneDrive 没有返回可用的文件打开地址。');
    }
    return url.href;
  }
  uploadPath(account, parent, name) { return itemPath(account.driveId, parent) + ':/' + encoded(name) + ':'; }
  async createSession(account, parent, name, signal) {
    const body = JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename', name } });
    const data = await this.request(this.uploadPath(account, parent, name) + '/createUploadSession', { method: 'POST', body, signal });
    return { url: this.transferUrl(data.uploadUrl), expires: data.expirationDateTime || '' };
  }
  async uploadEmpty(account, parent, name, signal) {
    return this.request(this.uploadPath(account, parent, name) + '/content?%40microsoft.graph.conflictBehavior=rename', {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(0), signal
    });
  }
  transferUrl(value, purpose) {
    let url;
    try { url = new URL(value); } catch { throw new Error('OneDrive 没有返回可用的传输地址。'); }
    const safeMock = this.mock && url.origin === new URL(this.base).origin;
    const hosts = purpose === 'conversion' ? conversionHosts : consumerHosts;
    const safeCloud = url.protocol === 'https:' && !url.port && hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host));
    if ((!safeMock && !safeCloud) || url.username || url.password) throw new Error('OneDrive 返回了无效的传输地址。');
    return url.href;
  }
}

function statusError(status) {
  const common = { 400: 'OneDrive 无法处理此请求。', 401: '登录已过期，请重新登录。', 403: 'OneDrive 拒绝访问。', 404: 'OneDrive 文件或会话不存在。', 409: '已有同名文件或文件夹。', 429: 'OneDrive 正在限制请求，请稍后重试。', 507: 'OneDrive 空间不足。' };
  const error = new Error(common[status] || 'OneDrive 请求失败（' + status + '）。');
  error.status = status;
  return error;
}

module.exports = { Drive, itemInfo, safeName, statusError, fileType, extension, itemPath, redirectCodes };
