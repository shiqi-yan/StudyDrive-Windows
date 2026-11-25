export class Selection {
  #scope;
  #account;
  #items = new Set();
  #anchor;

  use(account, directory, query) {
    const scope = JSON.stringify([account?.id, account?.driveId, directory, query]);
    if (this.#scope === scope) return;
    this.clear();
    this.#scope = scope;
    this.#account = account;
  }
  key(item) {
    return JSON.stringify([this.#account?.id, item.driveId || this.#account?.driveId, item.id]);
  }
  has(item) { return this.#items.has(this.key(item)); }
  get size() { return this.#items.size; }
  get ids() { return [...this.#items].map(key => JSON.parse(key)[2]); }
  clear() { this.#items.clear(); this.#anchor = null; }
  drop(item) {
    const key = this.key(item);
    this.#items.delete(key);
    if (this.#anchor === key) this.#anchor = null;
  }
  set(item, checked, range, rows) {
    const key = this.key(item);
    const start = range && this.#anchor ? rows.findIndex(row => this.key(row) === this.#anchor) : -1;
    const end = start >= 0 ? rows.findIndex(row => this.key(row) === key) : -1;
    if (end >= 0) this.setLoaded(rows.slice(Math.min(start, end), Math.max(start, end) + 1), checked);
    else {
      this.setLoaded([item], checked);
      this.#anchor = key;
    }
  }
  setLoaded(rows, checked) {
    for (const row of rows) {
      const key = this.key(row);
      if (checked) this.#items.add(key);
      else this.#items.delete(key);
    }
  }
  reconcile(rows, complete) {
    if (!complete || !this.#items.size) return;
    const available = new Set(rows.map(row => this.key(row)));
    for (const key of this.#items) if (!available.has(key)) this.#items.delete(key);
    if (!available.has(this.#anchor)) this.#anchor = null;
  }
}
