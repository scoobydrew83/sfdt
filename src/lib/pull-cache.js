import { DatabaseSync } from 'node:sqlite';
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

// Convert ISO 8601 date string to milliseconds for reliable numeric comparison.
// Returns 0 for null/undefined/invalid dates so they are treated as "oldest possible"
// rather than NaN (which makes every comparison false, silently skipping changed detection).
function toMs(dateStr) {
  if (!dateStr) return 0;
  const ms = new Date(dateStr).getTime();
  return isNaN(ms) ? 0 : ms;
}

export function initCache(cacheDir, orgAlias) {
  fs.ensureDirSync(cacheDir);
  // Sanitize orgAlias before using it as a filename component to prevent
  // path traversal attacks (e.g. aliases containing "../" or other unsafe chars).
  const safeAlias = orgAlias.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  const dbPath = path.join(cacheDir, `${safeAlias}.db`);
  const db = new DatabaseSync(dbPath);
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
      if (!cached || toMs(cached.last_modified) < toMs(lastModified)) {
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
  const deleteStale = db.prepare(
    'DELETE FROM components WHERE type = ? AND name NOT IN (SELECT value FROM json_each(?))',
  );
  const setSync = db.prepare('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)');
  db.exec('BEGIN');
  try {
    for (const [type, members] of freshInventory) {
      // Upsert every component present in the fresh inventory.
      for (const [name, lastModified] of members) {
        upsert.run(type, name, lastModified);
      }
      // Prune any cached rows for this type whose names are no longer in the org.
      const freshNames = JSON.stringify([...members.keys()]);
      deleteStale.run(type, freshNames);
    }
    setSync.run('last_sync', new Date().toISOString());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getCacheStatus(db, orgAlias) {
  const { count } = db.prepare('SELECT COUNT(*) as count FROM components').get();
  return { orgAlias, componentCount: count, lastSync: getLastSync(db) };
}
