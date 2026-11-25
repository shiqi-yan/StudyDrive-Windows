const { CloudRecycleError } = require('./cloud-recycle.cjs');
const { personalRecyclePage } = require('./onedrive-recycle-page.cjs');

const listOrigin = 'https://my.microsoftpersonalcontent.com';
const recyclePage = 'https://onedrive.live.com/recycle';
const listPath = /^\/_api\/v2\.1\/sites\/[^/]+\/recyclebin\/items$/;
const driveIdentity = /^[0-9a-f]{16,64}$/i;
const recycleId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ownOrigin(raw, origin) {
  try {
    const parsed = new URL(raw);
    return parsed.origin === origin && !parsed.username && !parsed.password && !parsed.hash ? parsed : null;
  } catch { return null; }
}
function recycleRequest(raw, continuation) {
  const url = ownOrigin(raw, listOrigin);
  if (!url || !listPath.test(url.pathname)) return null;
  const keys = [...url.searchParams.keys()].sort().join(',');
  const required = continuation ? '$skiptoken,$top,orderby' : '$top,orderby';
  if (keys !== required || url.searchParams.get('orderby') !== 'deletedDateTime desc' ||
      url.searchParams.get('$top') !== '101' || continuation && !url.searchParams.get('$skiptoken')) return null;
  return url;
}
function observedRequestKey(url) {
  const pairs = [...url.searchParams.entries()].sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([url.origin, url.pathname, pairs]);
}
function looksLikeRecycleRequest(raw) {
  const url = ownOrigin(raw, listOrigin);
  return !!url && listPath.test(url.pathname);
}
function observedPersonalIdentity(raw) {
  const url = ownOrigin(raw, listOrigin);
  const path = url?.pathname.match(/^\/personal\/([^/]+)(?:\/|$)/);
  return path && driveIdentity.test(path[1]) ? path[1].toLowerCase() : null;
}
function actualLoginPage(raw) {
  return ['https://login.live.com', 'https://login.microsoftonline.com', 'https://account.live.com']
    .some(origin => ownOrigin(raw, origin));
}

function locationIdentity(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (value.includes('\\') || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(value)) return null;
  if (!/^\/?personal\//i.test(value) && !/^\/\/my\.microsoftpersonalcontent\.com\/personal\//i.test(value)) return null;
  try {
    const path = new URL(value, listOrigin);
    if (path.origin !== listOrigin || path.username || path.password || path.hash || path.search) return null;
    const part = path.pathname.match(/^\/personal\/([0-9a-f]{16,64})(?:\/|$)/i);
    return part?.[1].toLowerCase() || null;
  } catch { return null; }
}

class PersonalRecycleCapture {
  constructor(scope) {
    this.scope = scope;
    this.identity = null;
    this.pages = new Map();
    this.visited = new Set();
    this.path = null;
    this.next = null;
    this.nextKey = null;
    this.done = false;
  }
  observeIdentity(url, status) {
    if (status !== 200) return;
    const observed = observedPersonalIdentity(url);
    if (!observed) return;
    if (!driveIdentity.test(this.scope.driveId) || observed !== this.scope.driveId.toLowerCase()) {
      throw new CloudRecycleError('mismatch');
    }
    this.identity = observed;
  }
  account() {
    if (!this.identity) return null;
    // The scope is already from a Graph-authenticated account. Only use its key
    // after independently verifying the matching drive in this browsing session.
    return { accountId: this.scope.accountId, driveId: this.scope.driveId };
  }
  continuationEvidence(raw) {
    const loose = ownOrigin(raw, listOrigin);
    const verified = recycleRequest(raw, !!this.path);
    return {
      following: !!this.path,
      keysMatch: !!verified,
      samePath: !this.path || loose?.pathname === this.path,
      sameLiteral: this.next === loose?.href,
      sameQuery: !!verified && this.nextKey === observedRequestKey(verified),
      alreadySeen: !!verified && this.visited.has(observedRequestKey(verified))
    };
  }
  prepareResponse(url, method, status, mimeType) {
    if (!looksLikeRecycleRequest(url)) return null;
    if (method !== 'GET') return null;
    const parsed = recycleRequest(url, !!this.path);
    if (!parsed) {
      // The page can request its already seen first page again while rendering.
      const first = recycleRequest(url, false);
      if (first && this.visited.has(observedRequestKey(first))) return null;
      throw new CloudRecycleError('schema');
    }
    const key = observedRequestKey(parsed);
    if (this.visited.has(key)) return null;
    if (this.path && (parsed.pathname !== this.path || this.nextKey !== key)) throw new CloudRecycleError('schema');
    if (status === 401) throw new CloudRecycleError('auth');
    if (status === 403) throw new CloudRecycleError('denied');
    if (status === 429) throw Object.assign(new CloudRecycleError('throttled'), { status: 429 });
    if (status !== 200) throw new CloudRecycleError('failed');
    if (/^text\/html(?:;|$)/i.test(mimeType || '')) throw new CloudRecycleError('auth');
    if (!/^application\/json(?:;|$)/i.test(mimeType || '')) throw new CloudRecycleError('schema');
    return parsed;
  }
  observeDeletedLocations(items) {
    const expected = this.scope.driveId.toLowerCase();
    let matched = 0;
    for (const item of items) {
      const personal = locationIdentity(item.path);
      if (!personal) continue;
      if (!driveIdentity.test(this.scope.driveId) || personal !== expected) {
        throw new CloudRecycleError('mismatch');
      }
      matched += 1;
    }
    // This is the server-relative site namespace emitted by the authenticated
    // recycle endpoint, not a Graph item ID or a parent ID.
    if (matched > 0 && matched === items.length) this.identity = expected;
  }
  observePage(url, payload) {
    const received = observedRequestKey(url);
    if (this.visited.has(received)) return;
    if (this.done || this.path && (url.pathname !== this.path || this.nextKey !== received)) {
      throw new CloudRecycleError('schema');
    }
    const page = personalRecyclePage(payload);
    // Orca observed absence (not a JSON null) as terminal.
    if (Object.hasOwn(payload, '@odata.nextLink') && page.nextLink === null ||
        page.items.some(item => !recycleId.test(item.id))) throw new CloudRecycleError('schema');
    const next = page.nextLink ? recycleRequest(page.nextLink, true) : null;
    const nextKey = next ? observedRequestKey(next) : null;
    if (page.nextLink && (!next || next.pathname !== url.pathname ||
        this.visited.has(nextKey) || nextKey === received)) throw new CloudRecycleError('schema');
    this.observeDeletedLocations(page.items);
    const key = this.path ? this.next : null;
    this.path = url.pathname;
    this.next = page.nextLink;
    this.nextKey = nextKey;
    this.done = !next;
    this.visited.add(received);
    this.pages.set(key, { items: page.items, next: page.nextLink, done: this.done });
  }
  page(cursor) {
    if (!this.identity) throw new CloudRecycleError('mismatch');
    return this.pages.get(cursor);
  }
}

module.exports = { PersonalRecycleCapture, recyclePage, listOrigin, looksLikeRecycleRequest, actualLoginPage, ownOrigin };
