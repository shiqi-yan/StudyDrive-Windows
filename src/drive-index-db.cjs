const { DatabaseSync } = require('node:sqlite');
const { fileType, extension } = require('./drive.cjs');

const fold = value => value.normalize('NFC').toLowerCase().replaceAll('ς', 'σ');
const owns = (object, key) => Object.hasOwn(object, key);
const types = new Set(['audio', 'folder', 'image', 'markdown', 'office', 'online', 'other', 'pdf', 'sheet', 'shortcut', 'text', 'video']);
const sorts = {
  name: 'f.folded ASC', newest: 'f.modified_at DESC', oldest: 'f.modified_at ASC',
  largest: 'f.size DESC', relevance: 'CASE WHEN f.folded = ? THEN 0 WHEN instr(f.folded, ?) = 1 THEN 1 ELSE 2 END'
};

const schema = `
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=FULL;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS connections (
    connection TEXT NOT NULL, drive TEXT NOT NULL, root TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 0,
    mode TEXT, checkpoint TEXT, delta TEXT, synced INTEGER, batch_start INTEGER,
    revision INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'waiting',
    retry_at INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (connection, drive)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS files (
    rowid INTEGER PRIMARY KEY,
    connection TEXT NOT NULL, drive TEXT NOT NULL, generation INTEGER NOT NULL,
    id TEXT NOT NULL, parent TEXT, name TEXT, folded TEXT, kind TEXT, mime TEXT,
    extension TEXT, size INTEGER, modified TEXT, modified_at INTEGER, etag TEXT, ctag TEXT,
    web TEXT, children INTEGER, deleted INTEGER NOT NULL DEFAULT 0,
    UNIQUE (connection, drive, generation, id)
  );
  CREATE INDEX IF NOT EXISTS files_parent ON files(connection, drive, generation, parent);
  CREATE TABLE IF NOT EXISTS changes (
    connection TEXT NOT NULL, drive TEXT NOT NULL, id TEXT NOT NULL, patch TEXT NOT NULL,
    PRIMARY KEY (connection, drive, id)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS pending_changes (
    connection TEXT NOT NULL, drive TEXT NOT NULL, id TEXT NOT NULL, patch TEXT NOT NULL,
    sequence INTEGER NOT NULL, PRIMARY KEY (connection, drive, id)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS recycle (
    connection TEXT NOT NULL, drive TEXT NOT NULL, id TEXT NOT NULL,
    item TEXT NOT NULL, path TEXT, covered TEXT, origin TEXT NOT NULL, at INTEGER NOT NULL,
    state TEXT NOT NULL, PRIMARY KEY (connection,drive,id)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS mutation_intents (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, connection TEXT NOT NULL, drive TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS names USING fts5(folded, tokenize='trigram case_sensitive 1');
  CREATE TRIGGER IF NOT EXISTS files_insert AFTER INSERT ON files WHEN NEW.folded IS NOT NULL BEGIN
    INSERT INTO names(rowid, folded) VALUES(NEW.rowid, NEW.folded);
  END;
  CREATE TRIGGER IF NOT EXISTS files_update AFTER UPDATE OF folded ON files WHEN OLD.folded IS NOT NEW.folded BEGIN
    DELETE FROM names WHERE rowid=OLD.rowid;
    INSERT INTO names(rowid, folded) SELECT NEW.rowid, NEW.folded WHERE NEW.folded IS NOT NULL;
  END;
  CREATE TRIGGER IF NOT EXISTS files_delete AFTER DELETE ON files WHEN OLD.folded IS NOT NULL BEGIN
    DELETE FROM names WHERE rowid=OLD.rowid;
  END;
`;

function string(value, max = 400) {
  return typeof value === 'string' && value.length <= max && !value.includes('\0') ? value : undefined;
}

// Store only the fields used by the index. Delta may omit a field even on a tombstone.
function graphPatch(raw, driveId) {
  const id = string(raw?.id);
  if (!id) return null;
  if (raw.deleted) return { id, deleted: 1 };
  if (!raw.remoteItem && raw.parentReference?.driveId && raw.parentReference.driveId !== driveId) return null;
  const name = string(raw.name, 1024);
  const patch = { id, deleted: 0 };
  if (name) patch.name = name;
  if (string(raw.parentReference?.id)) patch.parent = raw.parentReference.id;
  if (raw.remoteItem) patch.kind = 'shortcut';
  else if (raw.folder) {
    patch.kind = 'folder';
    if (Number.isSafeInteger(raw.folder.childCount)) patch.children = raw.folder.childCount;
  } else if (raw.file) {
    patch.kind = 'file';
    patch.mime = string(raw.file.mimeType, 255) || '';
  } else if (raw.package) patch.kind = 'online';
  if (Number.isSafeInteger(raw.size) && raw.size >= 0) patch.size = raw.size;
  if (string(raw.lastModifiedDateTime) && Number.isFinite(Date.parse(raw.lastModifiedDateTime))) {
    patch.modified = raw.lastModifiedDateTime;
  }
  for (const [field, key] of [['etag', 'eTag'], ['ctag', 'cTag']]) {
    if (string(raw[key], 1024)) patch[field] = raw[key];
  }
  if (string(raw.webUrl, 4096)) {
    try {
      const url = new URL(raw.webUrl);
      if (url.protocol === 'https:' && !url.port && !url.username && !url.password &&
          ['onedrive.live.com', 'd.docs.live.net', '1drv.ms'].includes(url.hostname)) {
        const allowed = new URLSearchParams();
        for (const [key, value] of url.searchParams) {
          if (['cid', 'id', 'resid'].includes(key.toLowerCase())) allowed.append(key, value);
        }
        url.search = allowed.toString();
        url.hash = '';
        patch.web = url.href;
      }
    } catch {}
  }
  return patch;
}

function localPatch(item, deleted) {
  if (deleted) return { id: item.id, deleted: 1 };
  const patch = {
    id: item.id, parent: item.parentId || undefined, name: item.name,
    kind: item.kind, mime: item.type, size: item.size, modified: item.modified || undefined,
    children: item.children, etag: item.etag || undefined, ctag: item.ctag || undefined, deleted: 0
  };
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

function matchesChange(patch, expected) {
  if (!patch || patch.deleted !== expected.deleted) return false;
  if (expected.deleted) return true;
  if (expected.etag && patch.etag) return patch.etag === expected.etag;
  return patch.name === expected.name && (!expected.parent || patch.parent === expected.parent);
}

class DriveIndexDb {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(schema);
    this.statements = new Map();
  }
  close() { this.db.close(); }
  statement(sql) {
    if (!this.statements.has(sql)) {
      if (this.statements.size >= 160) this.statements.delete(this.statements.keys().next().value);
      this.statements.set(sql, this.db.prepare(sql));
    }
    return this.statements.get(sql);
  }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  connect({ id, driveId, root }) {
    this.statement('INSERT OR IGNORE INTO connections(connection, drive, root) VALUES (?,?,?)').run(id, driveId, root.id);
    return [id, driveId];
  }
  state(key) {
    return this.statement('SELECT * FROM connections WHERE connection=? AND drive=?').get(...key);
  }
  status(account) {
    const key = this.connect(account);
    const state = this.state(key);
    const visible = state.active || state.generation;
    const { count } = this.statement(`SELECT count(*) count FROM files
      WHERE connection=? AND drive=? AND generation=? AND id<>? AND name IS NOT NULL AND deleted=0`)
      .get(...key, visible, state.root);
    const dirty = this.statement(`SELECT EXISTS(SELECT 1 FROM mutation_intents WHERE connection=?1 AND drive=?2)
      OR EXISTS(SELECT 1 FROM pending_changes WHERE connection=?1 AND drive=?2) dirty`)
      .get({ 1: key[0], 2: key[1] }).dirty;
    return { phase: state.status, building: state.mode === 'full', complete: !!state.active, count,
      updated: state.synced, retryAt: state.retry_at, revision: state.revision, failures: state.failures, dirty: !!dirty };
  }
  begin(account, first, { force = false, restart = false } = {}) {
    const key = this.connect(account);
    return this.transaction(() => {
      const row = this.state(key);
      if (row.mode && !restart) {
        this.statement("UPDATE connections SET status='syncing' WHERE connection=? AND drive=?").run(...key);
        return row.checkpoint;
      }
      const full = restart || force || !row.delta;
      const generation = full ? row.generation + 1 : row.active;
      const checkpoint = full ? first : row.delta;
      this.statement('DELETE FROM changes WHERE connection=? AND drive=?').run(...key);
      this.statement('DELETE FROM files WHERE connection=? AND drive=? AND generation<>?').run(...key, row.active);
      this.statement(`UPDATE connections SET generation=?, mode=?, checkpoint=?, status='syncing',
        batch_start=(SELECT coalesce(seq,0) FROM sqlite_sequence WHERE name='mutation_intents')
        , revision=revision+? WHERE connection=? AND drive=?`)
        .run(generation, full ? 'full' : 'delta', checkpoint, full && !row.active ? 1 : 0, ...key);
      if (full && !row.active) {
        for (const pending of this.statement('SELECT patch FROM pending_changes WHERE connection=? AND drive=?').all(...key)) {
          this.write(key, generation, JSON.parse(pending.patch));
        }
      }
      return checkpoint;
    });
  }
  fail(account, phase, retryAt) {
    const key = this.connect(account);
    this.statement('UPDATE connections SET status=?, retry_at=?, failures=failures+1 WHERE connection=? AND drive=?')
      .run(phase, retryAt, ...key);
  }
  row(key, generation, id) {
    return this.statement('SELECT * FROM files WHERE connection=? AND drive=? AND generation=? AND id=?')
      .get(...key, generation, id);
  }
  write(key, generation, patch, fallback) {
    const old = this.row(key, generation, patch.id) || fallback;
    const value = { ...old, ...patch };
    const name = value.name || null;
    let kind = value.kind || null;
    let mime = value.mime || '';
    if (kind === 'file' || name && !['folder', 'shortcut', 'online'].includes(kind)) {
      ({ kind, type: mime } = fileType(name || '', mime));
    }
    this.statement(`INSERT INTO files(connection,drive,generation,id,parent,name,folded,kind,mime,extension,
        size,modified,modified_at,etag,ctag,web,children,deleted) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(connection,drive,generation,id) DO UPDATE SET
        parent=excluded.parent,name=excluded.name,folded=excluded.folded,kind=excluded.kind,mime=excluded.mime,
        extension=excluded.extension,size=excluded.size,modified=excluded.modified,modified_at=excluded.modified_at,
        etag=excluded.etag,ctag=excluded.ctag,web=excluded.web,children=excluded.children,deleted=excluded.deleted`)
      .run(...key, generation, patch.id, value.parent || null, name, name && !value.deleted ? fold(name) : null,
        kind, mime, name ? extension(name) : null, value.size ?? 0, value.modified || '',
        Date.parse(value.modified) || 0, value.etag || '', value.ctag || '', value.web || '', value.children ?? 0, value.deleted || 0);
  }
  page(account, expected, raws, next, delta) {
    const key = this.connect(account);
    return this.transaction(() => {
      const state = this.state(key);
      if (state.checkpoint !== expected || !state.mode) throw new Error('Unexpected delta checkpoint');
      const full = state.mode === 'full';
      const targets = this.statement('SELECT patch FROM changes WHERE connection=? AND drive=? AND id=?');
      const pending = this.statement('SELECT id, patch, sequence FROM pending_changes WHERE connection=? AND drive=?').all(...key);
      const protectedIds = new Set(pending.map(row => row.id));
      const save = this.statement(`INSERT INTO changes VALUES(?,?,?,?)
        ON CONFLICT(connection,drive,id) DO UPDATE SET patch=excluded.patch`);
      for (const raw of raws) {
        const patch = graphPatch(raw, account.driveId);
        if (!patch || patch.id === state.root) continue;
        if (full && (state.active || !protectedIds.has(patch.id))) {
          const fallback = state.active && this.row(key, state.active, patch.id);
          this.write(key, state.generation, patch, fallback);
        }
        if (!full || protectedIds.has(patch.id) || state.active && (patch.deleted || targets.get(...key, patch.id))) {
          const previous = targets.get(...key, patch.id);
          save.run(...key, patch.id, JSON.stringify({ ...(previous && JSON.parse(previous.patch)), ...patch }));
        }
      }
      if (next) {
        this.statement(`UPDATE connections SET checkpoint=?, revision=revision+?
          WHERE connection=? AND drive=?`).run(next, full && !state.active ? 1 : 0, ...key);
        return;
      }
      const changes = this.statement('SELECT id, patch FROM changes WHERE connection=? AND drive=?');
      if (state.active) this.observeTrash(account, key, state.active, changes.all(...key), protectedIds);
      let changed = full;
      if (!full) {
        for (const row of changes.iterate(...key)) {
          changed = true;
          if (!protectedIds.has(row.id)) this.write(key, state.generation, JSON.parse(row.patch));
        }
      }
      for (const row of pending) {
        const expected = JSON.parse(row.patch);
        const current = targets.get(...key, row.id);
        const server = current && JSON.parse(current.patch);
        if (row.sequence <= (state.batch_start || 0) && matchesChange(server, expected)) {
          this.write(key, state.generation, { ...expected, ...server });
          this.removePending(key, row.id);
        } else if (full) this.write(key, state.generation, expected, this.row(key, state.active, row.id));
      }
      if (full) for (const row of this.statement("SELECT id FROM recycle WHERE connection=? AND drive=? AND state IN ('deleted','unavailable')").all(...key)) {
        const found = this.row(key, state.generation, row.id);
        if (!protectedIds.has(row.id) && found?.name && !found.deleted) this.setTrash(account, row.id, 'restored');
      }
      this.prune(key, state.generation);
      this.statement('DELETE FROM files WHERE connection=? AND drive=? AND generation<>?').run(...key, state.generation);
      this.statement('DELETE FROM changes WHERE connection=? AND drive=?').run(...key);
      this.statement(`UPDATE connections SET active=generation, checkpoint=NULL, mode=NULL, delta=?,
        synced=?, revision=revision+?, status='ready', retry_at=0, failures=0 WHERE connection=? AND drive=?`)
        .run(delta, Date.now(), Number(changed), ...key);
    });
  }
  // Resolve final parent edges before deleting a folder's descendants. UNION also handles bad cycles.
  prune(key, generation) {
    this.statement(`WITH RECURSIVE doomed(id) AS (
      SELECT f.id FROM files f WHERE f.connection=?1 AND f.drive=?2 AND f.generation=?3 AND f.deleted=1
        AND NOT EXISTS(SELECT 1 FROM pending_changes p WHERE p.connection=?1 AND p.drive=?2 AND p.id=f.id)
      UNION
      SELECT f.id FROM files f JOIN doomed d ON f.parent=d.id
        WHERE f.connection=?1 AND f.drive=?2 AND f.generation=?3
        AND NOT EXISTS(SELECT 1 FROM pending_changes p WHERE p.connection=?1 AND p.drive=?2 AND p.id=f.id)
    ) DELETE FROM files WHERE connection=?1 AND drive=?2 AND generation=?3 AND id IN (SELECT id FROM doomed)`)
      .run({ 1: key[0], 2: key[1], 3: generation });
  }
  intent(account) {
    const key = this.connect(account);
    return Number(this.statement('INSERT INTO mutation_intents(connection,drive) VALUES(?,?)').run(...key).lastInsertRowid);
  }
  abandon(account, sequence) {
    this.statement('DELETE FROM mutation_intents WHERE sequence=? AND connection=? AND drive=?')
      .run(sequence, ...this.connect(account));
  }
  recoverIntents(account) {
    const key = this.connect(account);
    this.statement('DELETE FROM mutation_intents WHERE connection=? AND drive=? AND sequence<=?')
      .run(...key, this.state(key).batch_start || 0);
  }
  mutation(account, sequence, item, deleted) {
    const key = this.connect(account);
    return this.transaction(() => {
      const state = this.state(key);
      const patch = localPatch(item, deleted);
      // A Delta batch may begin after the intent but before Graph accepts the operation.
      // Only a batch beginning after this acknowledgement can confirm the local metadata.
      const acknowledged = this.intent(account);
      this.statement(`INSERT INTO pending_changes VALUES(?,?,?,?,?)
        ON CONFLICT(connection,drive,id) DO UPDATE SET patch=excluded.patch, sequence=excluded.sequence`)
        .run(...key, item.id, JSON.stringify(patch), acknowledged);
      this.write(key, state.active || state.generation, patch);
      if (deleted) this.setTrash(account, item.id, 'deleted', 'pending');
      else this.setTrash(account, item.id, 'restored', 'restoring');
      this.abandon(account, acknowledged);
      this.abandon(account, sequence);
      this.statement('UPDATE connections SET revision=revision+1 WHERE connection=? AND drive=?').run(...key);
    });
  }
  pending(account) {
    const key = this.connect(account);
    const cutoff = this.state(key).batch_start || 0;
    return this.statement(`SELECT id, sequence FROM pending_changes WHERE connection=? AND drive=? AND sequence<=?
      ORDER BY sequence LIMIT 20`).all(...key, cutoff);
  }
  removePending(key, id) {
    this.statement('DELETE FROM pending_changes WHERE connection=? AND drive=? AND id=?').run(...key, id);
  }
  reconcile(account, { id, sequence }, raw) {
    const key = this.connect(account);
    return this.transaction(() => {
      const row = this.statement('SELECT sequence FROM pending_changes WHERE connection=? AND drive=? AND id=?').get(...key, id);
      if (row?.sequence !== sequence) return;
      const generation = this.state(key).active;
      const patch = graphPatch(raw, account.driveId);
      if (!patch || patch.id !== id || (!patch.deleted && !patch.name)) return;
      this.write(key, generation, patch);
      this.removePending(key, id);
      if (patch.deleted) this.setTrash(account, id, 'deleted', 'pending');
      else this.setTrash(account, id, 'restored', 'restoring');
      if (patch.deleted) this.prune(key, generation);
      this.statement('UPDATE connections SET revision=revision+1 WHERE connection=? AND drive=?').run(...key);
    });
  }
  trashRecord(account, item, path, origin = 'client', covered = null) {
    const key = this.connect(account);
    const state = origin === 'client' ? 'pending' : 'deleted';
    const existing = this.statement('SELECT state FROM recycle WHERE connection=? AND drive=? AND id=?').get(...key, item.id);
    if (origin === 'delta' && ['pending', 'deleted', 'unavailable', 'restoring'].includes(existing?.state)) {
      if (existing.state === 'pending') this.setTrash(account, item.id, 'deleted', 'pending');
      return;
    }
    this.statement(`INSERT INTO recycle VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(connection,drive,id) DO UPDATE SET item=excluded.item,path=excluded.path,covered=excluded.covered,
        origin=excluded.origin,at=excluded.at,state=excluded.state`)
      .run(...key, item.id, JSON.stringify(item), path || null, covered, origin, Date.now(), state);
  }
  setTrash(account, id, state, expected) {
    const key = this.connect(account);
    const sql = 'UPDATE recycle SET state=? WHERE connection=? AND drive=? AND id=?';
    return expected ? this.statement(sql + ' AND state=?').run(state, ...key, id, expected)
      : this.statement(sql).run(state, ...key, id);
  }
  trashRows(account, id) {
    const key = this.connect(account);
    const select = 'SELECT id,item,path,covered,origin,at,state FROM recycle WHERE connection=?1 AND drive=?2';
    const rows = id
      ? this.statement(select + ' AND id=?3').all({ 1: key[0], 2: key[1], 3: id })
      : this.statement(select + ` AND state IN ('pending','deleted','unavailable','restoring')
        AND (covered IS NULL OR NOT EXISTS(SELECT 1 FROM recycle parent
          WHERE parent.connection=?1 AND parent.drive=?2 AND parent.id=recycle.covered
            AND parent.state IN ('pending','deleted','restoring'))) ORDER BY at DESC, id`)
        .all({ 1: key[0], 2: key[1] });
    return rows.map(row => ({ ...row, item: JSON.parse(row.item) }));
  }
  observeTrash(account, key, generation, entries, protectedIds) {
    const patches = entries.map(row => JSON.parse(row.patch));
    const deleted = new Set(patches.filter(patch => patch.deleted && !protectedIds.has(patch.id)).map(patch => patch.id));
    const known = new Map([[account.root.id, [account.root]]]);
    for (const patch of patches) {
      if (protectedIds.has(patch.id)) continue;
      if (!patch.deleted) {
        this.setTrash(account, patch.id, 'restored', 'deleted');
        this.setTrash(account, patch.id, 'restored', 'unavailable');
        this.setTrash(account, patch.id, 'restored', 'restoring');
        continue;
      }
      const old = this.row(key, generation, patch.id);
      if (!old?.name || old.kind === 'shortcut') continue;
      const trail = this.trail(account, old.parent, known, key, generation);
      const containing = trail?.find(folder => deleted.has(folder.id));
      this.trashRecord(account, this.item(account, old), trail && '/' + trail.slice(1).map(folder => folder.name).join('/'),
        'delta', containing?.id);
    }
  }
  item(account, row) {
    return { id: row.id, driveId: account.driveId, name: row.name, parentId: row.parent || '',
      kind: row.kind || 'other', type: row.mime || '', size: row.size, modified: row.modified,
      children: row.children, version: row.ctag || row.etag || JSON.stringify([row.modified, row.size]) };
  }
  trail(account, id, known = new Map([[account.root.id, [account.root]]]), key = this.connect(account), generation) {
    generation ??= this.state(key).active || this.state(key).generation;
    const seen = new Set();
    const path = [];
    while (id && !seen.has(id) && path.length < 512) {
      if (known.has(id)) {
        let trail = known.get(id);
        for (const item of path.reverse()) {
          trail = [...trail, item];
          known.set(item.id, trail);
        }
        return trail;
      }
      seen.add(id);
      const row = this.row(key, generation, id);
      if (!row?.name || row.deleted || row.kind !== 'folder') break;
      path.push(this.item(account, row));
      id = row.parent;
    }
    return null;
  }
  search(account, input) {
    const key = this.connect(account);
    const state = this.state(key);
    const generation = state.active || state.generation;
    const status = this.status(account);
    const offset = Number.isSafeInteger(input.offset) && input.offset > 0 ? input.offset : 0;
    if (offset && input.revision !== status.revision) return { reset: true, status };
    const query = fold(String(input.query || '').slice(0, 120).replaceAll('\0', '').trim());
    const terms = [...new Set(query.split(/\s+/u).filter(Boolean))];
    if (!terms.length) return { items: [], total: 0, cursor: '', status };
    const where = ['f.connection=?1', 'f.drive=?2', 'f.generation=?3', 'f.id<>?4', 'f.deleted=0', 'f.name IS NOT NULL'];
    const bindings = [...key, generation, state.root];
    let cte = `WITH RECURSIVE hidden(id) AS (
      SELECT f.id FROM files f JOIN pending_changes p ON p.connection=f.connection AND p.drive=f.drive AND p.id=f.id
      WHERE f.connection=?1 AND f.drive=?2 AND f.generation=?3 AND f.deleted=1
      UNION SELECT f.id FROM files f JOIN hidden h ON h.id=f.parent
      WHERE f.connection=?1 AND f.drive=?2 AND f.generation=?3
    )`;
    where.push('f.id NOT IN (SELECT id FROM hidden)');
    if (input.scope && input.scope !== state.root) {
      bindings.push(input.scope);
      cte += `, scope(id) AS (
        SELECT ?${bindings.length}
        UNION SELECT f.id FROM files f JOIN scope s ON s.id=f.parent
        WHERE f.connection=?1 AND f.drive=?2 AND f.generation=?3 AND f.deleted=0
      )`;
      where.push(`f.id IN (SELECT id FROM scope) AND f.id<>?${bindings.length}`);
    }
    if (input.filter === 'document') where.push("f.kind IN ('office','sheet','pdf','markdown','text','online')");
    else if (input.filter === 'office') where.push("f.kind IN ('office','online')");
    else if (input.filter === 'other') where.push("f.kind IN ('other','shortcut')");
    else if (types.has(input.filter)) {
      bindings.push(input.filter);
      where.push(`f.kind=?${bindings.length}`);
    }
    if (Number.isSafeInteger(input.since)) { bindings.push(input.since); where.push(`f.modified_at>=?${bindings.length}`); }
    const long = terms.filter(term => [...term].length >= 3);
    if (long.length) {
      bindings.push(long.map(term => '"' + term.replaceAll('"', '""') + '"').join(' AND '));
      where.push(`f.rowid IN (SELECT rowid FROM names WHERE names MATCH ?${bindings.length})`);
    }
    for (const term of terms) {
      bindings.push(term);
      where.push(`instr(f.folded, ?${bindings.length})>0`);
    }
    const from = cte + ' SELECT % FROM files f WHERE ' + where.join(' AND ');
    const numbered = values => Object.fromEntries(values.map((value, i) => [i + 1, value]));
    const { total } = this.statement(from.replace('%', 'count(*) total')).get(numbered(bindings));
    let order = owns(sorts, input.sort) ? sorts[input.sort] : sorts.relevance;
    if (order === sorts.relevance) {
      bindings.push(query, terms[0]);
      order = order.replace('?', '?' + (bindings.length - 1)).replace('instr(f.folded, ?)', 'instr(f.folded, ?' + bindings.length + ')');
    }
    bindings.push(offset);
    const rows = this.statement(from.replace('%', 'f.*') + ` ORDER BY ${order}, f.modified_at DESC, f.id ASC LIMIT 50 OFFSET ?${bindings.length}`)
      .all(numbered(bindings));
    const known = new Map([[account.root.id, [account.root]]]);
    const items = rows.map(row => {
      const chain = this.trail(account, row.parent, known, key, generation);
      return { ...this.item(account, row), path: chain ? '/' + chain.slice(1).map(folder => folder.name).join('/') : null,
        folder: chain?.at(-1) || null };
    });
    return { items, total, cursor: offset + rows.length < total ? String(offset + rows.length) : '', status };
  }
}

module.exports = { DriveIndexDb, graphPatch };
