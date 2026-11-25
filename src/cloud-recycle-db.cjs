// Cloud snapshots are separate from the local delete journal. No session data is stored here.
class CloudRecycleDb {
  constructor(index) {
    this.index = index;
    index.db.exec(`
      CREATE TABLE IF NOT EXISTS cloud_recycle_snapshots (
        connection TEXT NOT NULL, drive TEXT NOT NULL, provider TEXT NOT NULL,
        active TEXT, staging TEXT, observed_at INTEGER, total INTEGER,
        PRIMARY KEY(connection, drive, provider)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS cloud_recycle_items (
        connection TEXT NOT NULL, drive TEXT NOT NULL, provider TEXT NOT NULL, generation TEXT NOT NULL,
        cloud_id TEXT NOT NULL, drive_item_id TEXT, parent_id TEXT, name TEXT NOT NULL, original_path TEXT,
        size INTEGER, kind TEXT NOT NULL, deleted_at INTEGER, observed_at INTEGER NOT NULL, capability TEXT,
        PRIMARY KEY(connection, drive, provider, generation, cloud_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS cloud_recycle_order ON cloud_recycle_items(
        connection, drive, provider, generation, deleted_at DESC, cloud_id
      );
    `);
  }
  statement(sql) { return this.index.statement(sql); }
  row(key) {
    return this.statement('SELECT * FROM cloud_recycle_snapshots WHERE connection=? AND drive=? AND provider=?').get(...key);
  }
  begin(key, generation) {
    return this.index.transaction(() => {
      this.statement(`INSERT INTO cloud_recycle_snapshots(connection, drive, provider, staging)
        VALUES(?,?,?,?) ON CONFLICT(connection,drive,provider) DO UPDATE SET staging=excluded.staging`)
        .run(...key, generation);
      this.statement(`DELETE FROM cloud_recycle_items WHERE connection=? AND drive=? AND provider=?
        AND generation<>coalesce(?, '')`).run(...key, this.row(key).active);
    });
  }
  append(key, generation, rows) {
    return this.index.transaction(() => {
      if (this.row(key)?.staging !== generation) throw new Error('Cloud recycle generation changed');
      const insert = this.statement(`INSERT INTO cloud_recycle_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(connection,drive,provider,generation,cloud_id) DO UPDATE SET
        drive_item_id=excluded.drive_item_id,parent_id=excluded.parent_id,name=excluded.name,
        original_path=excluded.original_path,size=excluded.size,kind=excluded.kind,deleted_at=excluded.deleted_at,
        observed_at=excluded.observed_at,capability=excluded.capability`);
      const previous = this.statement(`SELECT drive_item_id,parent_id,capability
        FROM cloud_recycle_items WHERE connection=? AND drive=? AND provider=? AND generation=? AND cloud_id=?`);
      for (const item of rows) {
        const capability = item.capability ? JSON.stringify(item.capability) : null;
        const known = previous.get(...key, generation, item.id);
        if (known && (known.drive_item_id !== item.driveItemId || known.parent_id !== item.parentId ||
            known.capability !== capability)) {
          throw new Error('Conflicting cloud recycle identity across pages');
        }
        insert.run(...key, generation, item.id, item.driveItemId, item.parentId, item.name,
          item.path, item.size, item.kind, item.deletedAt, item.observedAt, capability);
      }
    });
  }
  publish(key, generation, expectedCount, observedAt) {
    return this.index.transaction(() => {
      if (this.row(key)?.staging !== generation) throw new Error('Cloud recycle generation changed');
      const summary = this.statement(`SELECT count(*) total FROM cloud_recycle_items
        WHERE connection=? AND drive=? AND provider=? AND generation=?`).get(...key, generation);
      if (expectedCount != null && expectedCount !== summary.total) throw new Error('Cloud recycle item count changed');
      this.statement(`UPDATE cloud_recycle_snapshots SET active=?,staging=NULL,observed_at=?,total=?
        WHERE connection=? AND drive=? AND provider=?`).run(generation, observedAt, summary.total, ...key);
      this.statement(`DELETE FROM cloud_recycle_items WHERE connection=? AND drive=? AND provider=?
        AND generation<>?`).run(...key, generation);
      return summary.total;
    });
  }
  discard(key, generation) {
    return this.index.transaction(() => {
      if (this.row(key)?.staging !== generation) return;
      this.statement('DELETE FROM cloud_recycle_items WHERE connection=? AND drive=? AND provider=? AND generation=?')
        .run(...key, generation);
      this.statement('UPDATE cloud_recycle_snapshots SET staging=NULL WHERE connection=? AND drive=? AND provider=?').run(...key);
    });
  }
  page(key, offset, limit, expectedGeneration) {
    const state = this.row(key);
    if (!state?.active) return { snapshot: null, items: [], next: null, reset: !!expectedGeneration };
    const snapshot = { generation: state.active, at: state.observed_at, total: state.total };
    if (expectedGeneration && expectedGeneration !== state.active) return { snapshot, items: [], next: null, reset: true };
    const items = this.statement(`SELECT * FROM cloud_recycle_items WHERE connection=? AND drive=? AND provider=? AND generation=?
      ORDER BY deleted_at DESC, cloud_id LIMIT ? OFFSET ?`).all(...key, state.active, limit, offset).map(toItem);
    return { snapshot, items, next: offset + items.length < state.total ? offset + items.length : null };
  }
  restoreRows(key, generation, ids) {
    if (this.row(key)?.active !== generation) throw new Error('Cloud recycle generation changed');
    const select = this.statement(`SELECT * FROM cloud_recycle_items WHERE connection=? AND drive=? AND provider=?
      AND generation=? AND cloud_id=?`);
    return ids.map(id => select.get(...key, generation, id)).filter(Boolean).map(toItem);
  }
}
function toItem(row) {
  return { id: row.cloud_id, driveItemId: row.drive_item_id, parentId: row.parent_id,
    name: row.name, path: row.original_path, kind: row.kind, size: row.size, source: row.provider,
    deletedAt: row.deleted_at, observedAt: row.observed_at,
    capability: row.capability ? JSON.parse(row.capability) : null };
}

module.exports = { CloudRecycleDb };
