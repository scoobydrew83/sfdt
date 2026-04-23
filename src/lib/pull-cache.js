import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs-extra';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS components (
    type          TEXT NOT NULL,
    name          TEXT NOT NULL,
    last_modified TEXT NOT NULL,
    PRIMARY KEY (type, name)
  );
  CREATE TABLE IF NOT EXISTS sync_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

export function initCache(cacheDir, orgAlias) {
  fs.ensureDirSync(cacheDir);
  const db = new Database(path.join(cacheDir, `${orgAlias}.db`));
  db.exec(SCHEMA);
  return db;
}

export function getLastSync(db) {
  const row = db.prepare('SELECT value FROM sync_meta WHERE key = ?').get('last_sync');
  return row ? row.value : null;
}

export function getDelta(db, freshInventory) {
  const delta = new Map();
  const query = db.prepare('SELECT last_modified FROM components WHERE type = ? AND name = ?');
  for (const [type, members] of freshInventory) {
    for (const [name, lastModified] of members) {
      const cached = query.get(type, name);
      if (!cached || cached.last_modified < lastModified) {
        if (!delta.has(type)) delta.set(type, new Set());
        delta.get(type).add(name);
      }
    }
  }
  return delta;
}

export function updateCache(db, freshInventory) {
  const upsert = db.prepare(
    'INSERT OR REPLACE INTO components (type, name, last_modified) VALUES (?, ?, ?)',
  );
  const setSync = db.prepare('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)');
  db.transaction(() => {
    for (const [type, members] of freshInventory) {
      for (const [name, lastModified] of members) {
        upsert.run(type, name, lastModified);
      }
    }
    setSync.run('last_sync', new Date().toISOString());
  })();
}

export function getCacheStatus(db, orgAlias) {
  const { count } = db.prepare('SELECT COUNT(*) as count FROM components').get();
  return { orgAlias, componentCount: count, lastSync: getLastSync(db) };
}
