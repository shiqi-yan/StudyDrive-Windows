const fs = require('node:fs');
const path = require('node:path');

const empty = () => ({ recent: [], watching: {}, favorites: [], transfers: [] });
const itemKey = (item) => JSON.stringify([item.driveId, item.id]);

class Store {
  constructor(directory, encryption) {
    this.directory = directory;
    this.encryption = encryption;
    fs.mkdirSync(directory, { recursive: true });
    this.data = this.read('library.json') || { active: '', accounts: {}, settings: { rate: 1, volume: 100, muted: false } };
  }
  read(name, encrypted = false) {
    try {
      const buffer = fs.readFileSync(path.join(this.directory, name));
      return JSON.parse(encrypted ? this.encryption.decryptString(buffer) : buffer.toString());
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error(encrypted ? 'Windows 无法解密登录或传输资料，请重新登录。' : '无法读取课盘资料。');
    }
  }
  write(name, data, encrypted = false) {
    const target = path.join(this.directory, name);
    if (encrypted && !this.encryption.isEncryptionAvailable()) throw new Error('Windows 凭据加密不可用。');
    const encoded = JSON.stringify(data);
    fs.writeFileSync(target + '.tmp', encrypted ? this.encryption.encryptString(encoded) : encoded, { mode: 0o600 });
    fs.renameSync(target + '.tmp', target);
  }
  save() { this.write('library.json', this.data); }
  vault() { return this.read('credentials.bin', true) || {}; }
  saveVault(vault) { this.write('credentials.bin', vault, true); }
  account(id) { return this.data.accounts[id] ||= empty(); }
  touch(id, item) {
    const library = this.account(id);
    const key = itemKey(item);
    const previous = library.recent.find(row => itemKey(row.item) === key);
    const positions = item.version && previous?.item.version === item.version ? previous.positions : undefined;
    library.recent = [{ item, at: Date.now(), positions }, ...library.recent.filter(row => itemKey(row.item) !== key)].slice(0, 80);
    this.save();
  }
  position(id, item, view) {
    const row = this.account(id).recent.find(row => itemKey(row.item) === itemKey(item) && item.version && row.item.version === item.version);
    return row?.positions?.[view] || null;
  }
  setPosition(id, item, view, position) {
    const row = this.account(id).recent.find(row => itemKey(row.item) === itemKey(item) && item.version && row.item.version === item.version);
    if (!row || JSON.stringify(row.positions?.[view]) === JSON.stringify(position)) return;
    (row.positions ||= {})[view] = position;
    this.save();
  }
  watch(id, item, seconds, duration) {
    if (!Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(duration) || duration <= 0) return;
    const library = this.account(id);
    const key = itemKey(item);
    if (seconds < 0.8 && !library.watching[key]) return;
    library.watching[key] = { item, seconds: duration - seconds < 0.7 ? 0 : seconds, duration, at: Date.now() };
    const rows = Object.entries(library.watching).sort((a, b) => b[1].at - a[1].at).slice(0, 80);
    library.watching = Object.fromEntries(rows);
    this.save();
  }
  history(id, kind, item) {
    const library = this.account(id);
    if (kind === 'recent') library.recent = item ? library.recent.filter(row => itemKey(row.item) !== itemKey(item)) : [];
    else if (kind === 'watching') {
      if (item) delete library.watching[itemKey(item)];
      else library.watching = {};
    } else throw new Error('无效的历史类别。');
    this.save();
  }
  favorite(id, item) {
    const library = this.account(id);
    const index = library.favorites.findIndex(row => itemKey(row) === itemKey(item));
    if (index === -1) library.favorites.unshift(item);
    else library.favorites.splice(index, 1);
    this.save();
  }
  markDeleted(id, item) {
    const library = this.account(id);
    const key = itemKey(item);
    for (const row of [...library.recent, ...Object.values(library.watching)]) {
      if (itemKey(row.item) === key) row.item.trashed = true;
    }
    const favorite = library.favorites.find(row => itemKey(row) === key);
    if (favorite) favorite.trashed = true;
    this.save();
  }
  rename(id, item) {
    const library = this.account(id);
    const matches = row => itemKey(row) === itemKey(item);
    for (const row of library.recent) if (matches(row.item)) {
      if (row.item.version !== item.version || row.item.kind !== item.kind) delete row.positions;
      row.item = item;
    }
    for (const row of Object.values(library.watching)) if (matches(row.item)) row.item = item;
    library.favorites = library.favorites.map(row => matches(row) ? item : row);
    this.save();
  }
}

module.exports = { Store, itemKey };
