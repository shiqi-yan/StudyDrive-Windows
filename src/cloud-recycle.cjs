const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { describeRecycleType } = require('./recycle-kind.cjs');

const phases = {
  blocked: '尚未连接云回收站。当前数据源仍待验证。',
  idle: '尚未连接云回收站。',
  connecting: '正在连接并核对账户…',
  loading: '正在逐页读取云端回收站…',
  ready: '已读取完整云端快照。',
  canceled: '已取消读取。',
  auth: '云端会话已失效，请重新连接。',
  denied: 'OneDrive 拒绝访问此云回收站。',
  mismatch: '云端登录与当前课盘账户不一致。',
  schema: '云端响应格式或分页校验失败。',
  throttled: '云端暂时限制读取，请稍后重试。',
  failed: '暂时无法读取云端回收站。'
};

class CloudRecycleError extends Error {
  constructor(phase, options) {
    super(phases[phase] || phases.failed, options);
    this.phase = phase;
  }
}

function text(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f]/u.test(value);
}
function normalizedItem(item, observedAt) {
  if (!item || !text(item.id, 1024) || !text(item.name, 1024) ||
      item.size != null && (!Number.isSafeInteger(item.size) || item.size < 0) ||
      item.deletedAt != null && (!Number.isSafeInteger(item.deletedAt) || item.deletedAt <= 0)) {
    throw new CloudRecycleError('schema');
  }
  const driveItemId = text(item.driveItemId, 400) ? item.driveItemId : null;
  const parentId = text(item.parentId, 400) ? item.parentId : null;
  const graph = item.capability?.mode === 'graph-personal' && item.capability.verified === true && driveItemId;
  const own = item.capability?.mode === 'provider' && item.capability.verified === true;
  return { id: item.id, name: item.name, path: text(item.path, 4096) ? item.path : null,
    kind: text(item.kind, 40) ? item.kind : 'unknown', size: item.size ?? null,
    driveItemId, parentId, deletedAt: item.deletedAt ?? null, observedAt,
    capability: graph || own ? { mode: item.capability.mode } : null };
}

function classify(error) {
  if (error instanceof CloudRecycleError) return error.phase;
  if ([401, 403].includes(error?.status)) return 'auth';
  if (error?.status === 429) return 'throttled';
  return 'failed';
}

// Even if an adapter does not abort its underlying request, late data never
// advances a generation or leaks through the account's UI.
function interruptible(signal, work) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

class CloudRecycle {
  constructor(database, { provider = null, onChange = () => {}, onRestore = null,
    wait = delay, now = Date.now } = {}) {
    if (provider && (!/^[a-z0-9-]{1,64}$/.test(provider.id) ||
        typeof provider.getAccount !== 'function' || typeof provider.listPage !== 'function')) {
      throw new Error('Invalid cloud recycle provider');
    }
    this.db = database;
    this.provider = provider;
    this.onChange = onChange;
    this.onRestore = onRestore;
    this.wait = wait;
    this.now = now;
  }
  select(account) {
    this.cancel();
    const enabled = !!account && !!this.provider && (!this.provider.available || this.provider.available(account));
    this.current = account ? {
      scope: Object.freeze({ accountId: account.id, driveId: account.driveId }),
      key: [account.id, account.driveId, this.provider?.id],
      enabled,
      phase: enabled ? 'idle' : 'blocked',
      readCount: 0, retryAt: 0
    } : null;
  }
  cancel() { this.current?.controller?.abort(new CloudRecycleError('canceled')); }
  state(subject) {
    const phase = subject?.phase || 'blocked';
    return { configured: !!subject?.enabled, phase, message: phases[phase],
      provider: this.provider?.id || null, readCount: subject?.readCount || 0,
      busy: !!subject?.busy, restoring: !!subject?.restoring, retryAt: subject?.retryAt || 0 };
  }
  notify(subject) {
    if (this.current === subject) this.onChange(this.state(subject));
  }
  async page(account, { offset, generation } = {}) {
    const subject = this.current;
    if (!subject || subject.scope.accountId !== account.id || subject.scope.driveId !== account.driveId) {
      throw new CloudRecycleError('mismatch');
    }
    const status = this.state(subject);
    if (!subject.enabled) return { status, snapshot: null, items: [], next: null };
    const start = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
    const expected = text(generation, 128) ? generation : null;
    const result = await this.db.call('cloud:page', subject.key, start, 100, expected);
    if (this.current !== subject) throw new CloudRecycleError('mismatch');
    const enabled = !!this.onRestore && subject.phase === 'ready' && !subject.restoring;
    return { ...result, status: this.state(subject), items: result.items.map(({ capability, driveItemId, parentId, ...item }) =>
      ({ ...item, ...describeRecycleType(item.name, item.kind), canRestore: enabled && !!capability, mapped: !!capability })) };
  }
  refresh({ connect = false } = {}) {
    const subject = this.current;
    if (!subject?.enabled) return null;
    if (subject.task || subject.restoring) return subject.task || null;
    if (subject.retryAt > this.now()) return null;
    const controller = new AbortController();
    subject.controller = controller;
    subject.busy = true;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]);
    subject.task = this.load(subject, connect, signal).finally(() => {
      subject.busy = false;
      subject.task = null;
      subject.controller = null;
      this.notify(subject);
    });
    return subject.task;
  }
  async request(signal, work, subject) {
    let retries = 0;
    for (;;) {
      const call = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
      try { return await interruptible(call, () => work(call)); }
      catch (error) {
        signal.throwIfAborted();
        const status = error?.status;
        if (status !== 429 && !(status >= 500 && status <= 599)) throw error;
        const pause = Number.isFinite(error.retryAfter) && error.retryAfter >= 0
          ? error.retryAfter : 500 * (2 ** retries);
        if (++retries > 2 || pause > 5000) {
          if (status === 429) subject.retryAt = this.now() + pause;
          throw error;
        }
        await this.wait(pause, undefined, { signal });
      }
    }
  }
  async verify(subject, signal) {
    const identity = await this.request(signal, step => this.provider.getAccount(subject.scope, step), subject);
    if (identity?.accountId !== subject.scope.accountId || identity?.driveId !== subject.scope.driveId) {
      throw new CloudRecycleError('mismatch');
    }
  }
  async load(subject, connect, signal) {
    const generation = randomUUID();
    let staged = false;
    subject.phase = 'connecting';
    subject.readCount = 0;
    subject.retryAt = 0;
    this.notify(subject);
    try {
      if (connect && this.provider.connect) await interruptible(signal, () => this.provider.connect(subject.scope, signal));
      await this.verify(subject, signal);
      signal.throwIfAborted();
      await this.db.call('cloud:begin', subject.key, generation);
      staged = true;
      subject.phase = 'loading';
      this.notify(subject);
      let cursor = null;
      let expected = null;
      let lastUpdate = this.now();
      const cursors = new Set();
      for (let page = 0; page < 100000; page += 1) {
        const result = await this.request(signal, step => this.provider.listPage(subject.scope, cursor, step), subject);
        if (!result || !Array.isArray(result.items) || result.items.length > 10000 ||
            typeof result.done !== 'boolean' || (result.done ? result.next != null : !text(result.next, 32768)) ||
            result.total != null && (!Number.isSafeInteger(result.total) || result.total < 0 ||
              expected != null && expected !== result.total)) throw new CloudRecycleError('schema');
        expected = result.total ?? expected;
        if (!result.done && cursors.has(result.next)) throw new CloudRecycleError('schema');
        signal.throwIfAborted();
        const observed = this.now();
        const items = result.items.map(item => normalizedItem(item, observed));
        try { await this.db.call('cloud:append', subject.key, generation, items); }
        catch (error) { throw new CloudRecycleError('schema', { cause: error }); }
        subject.readCount += result.items.length;
        signal.throwIfAborted();
        if (result.done) {
          await this.verify(subject, signal);
          signal.throwIfAborted();
          try { await this.db.call('cloud:publish', subject.key, generation, expected, this.now()); }
          catch (error) { throw new CloudRecycleError('schema', { cause: error }); }
          subject.phase = 'ready';
          return true;
        }
        if (observed - lastUpdate >= 350) { lastUpdate = observed; this.notify(subject); }
        cursor = result.next;
        cursors.add(cursor);
      }
      throw new CloudRecycleError('schema');
    } catch (error) {
      subject.phase = signal.aborted ? classify(signal.reason) : classify(error);
      return false;
    } finally {
      try { this.provider.finish?.(subject.scope); } catch { /* Scope still prevents publication to another account. */ }
      if (staged && subject.phase !== 'ready') await this.db.call('cloud:discard', subject.key, generation).catch(() => {});
    }
  }
  async restore(account, generation, values, drive, applyRestored) {
    const subject = this.current;
    if (!subject || subject.busy || subject.restoring) throw new CloudRecycleError('failed');
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(240000)]);
    subject.controller = controller;
    subject.restoring = true;
    this.notify(subject);
    try {
      const selected = await this.resolveRestore(account, generation, values);
      if (selected.some(item => item.capability.mode !== 'provider')) throw new CloudRecycleError('schema');
      signal.throwIfAborted();
      return await this.onRestore({ provider: this.provider, scope: subject.scope, selected, drive, account, signal, applyRestored });
    } finally {
      subject.restoring = false;
      subject.controller = null;
      this.notify(subject);
      if (this.current === subject && !controller.signal.aborted) this.refresh();
    }
  }
  async resolveRestore(account, generation, values) {
    const subject = this.current;
    if (!this.onRestore || !this.provider || !subject || subject.phase !== 'ready' ||
        subject.scope.accountId !== account.id || subject.scope.driveId !== account.driveId) {
      throw new CloudRecycleError('auth');
    }
    const ids = Array.isArray(values) ? [...new Set(values)] : [];
    if (!text(generation, 128) || !ids.length || ids.length > 10000 || ids.some(id => !text(id, 1024))) {
      throw new CloudRecycleError('schema');
    }
    const items = await this.db.call('cloud:restoreRows', subject.key, generation, ids);
    if (this.current !== subject || items.length !== ids.length || items.some(item => !item.capability)) {
      throw new CloudRecycleError('schema');
    }
    return items;
  }
}
module.exports = { CloudRecycle, CloudRecycleError };
