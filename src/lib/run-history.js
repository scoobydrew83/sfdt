// Run history — a compact, queryable index of every sfdt command run, backed by
// the same node:sqlite (DatabaseSync) already used by pull-cache.js. This is the
// index; the full per-run snapshots still live as timestamped JSON archives
// under logs/<type>-results/ (see log-writer.js). Recording is always
// best-effort: a history failure must never fail the command that produced it.
//
// node:sqlite (DatabaseSync) is experimental/stability-1 in Node 22.x.
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs-extra';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    org TEXT,
    exit_code INTEGER,
    duration_ms INTEGER,
    status TEXT,
    summary TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_runs_type_ts ON runs(type, id);
`;

/** Rows kept per run type before the oldest are pruned. */
const RETENTION_PER_TYPE = 200;

function dbPathFor(logDir) {
  return path.join(logDir, 'history.db');
}

function openDb(logDir) {
  const db = new DatabaseSync(dbPathFor(logDir));
  db.exec(SCHEMA);
  return db;
}

/**
 * Record one run. Best-effort — any error (missing sqlite, locked db, bad
 * logDir) is swallowed so history never breaks a command.
 *
 * @param {string} logDir - absolute path to the project's logs directory
 * @param {object} run
 * @param {string} run.type - e.g. 'audit' | 'monitor' | 'quality' | 'test' | 'deploy' | 'agent-test'
 * @param {string} [run.timestamp] - ISO; defaults to now
 * @param {string} [run.org]
 * @param {number} [run.exitCode]
 * @param {number} [run.durationMs]
 * @param {string} [run.status] - short verdict, e.g. 'pass' | 'fail' | 'warn' | 'error'
 * @param {object} [run.summary] - small JSON-serialisable summary (counts etc.)
 */
export async function recordRun(logDir, run) {
  if (!logDir || !run || !run.type) return;
  try {
    await fs.ensureDir(logDir);
    const db = openDb(logDir);
    try {
      db.prepare(
        'INSERT INTO runs (type, timestamp, org, exit_code, duration_ms, status, summary) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        String(run.type),
        run.timestamp ?? new Date().toISOString(),
        run.org ?? null,
        Number.isInteger(run.exitCode) ? run.exitCode : null,
        Number.isFinite(run.durationMs) ? Math.round(run.durationMs) : null,
        run.status ?? null,
        run.summary != null ? JSON.stringify(run.summary) : null,
      );
      // Prune oldest rows of this type beyond the retention cap.
      db.prepare(
        `DELETE FROM runs WHERE type = ? AND id NOT IN (
           SELECT id FROM runs WHERE type = ? ORDER BY id DESC LIMIT ${RETENTION_PER_TYPE}
         )`,
      ).run(String(run.type), String(run.type));
    } finally {
      db.close();
    }
  } catch {
    // History is best-effort — never throw.
  }
}

/**
 * Query recent runs, newest first. Returns [] on any failure or missing db.
 *
 * @param {string} logDir
 * @param {object} [opts]
 * @param {string} [opts.type] - filter to one run type
 * @param {number} [opts.limit=50]
 * @returns {Array<{id,type,timestamp,org,exitCode,durationMs,status,summary}>}
 */
export function queryRuns(logDir, { type, limit = 50 } = {}) {
  if (!logDir) return [];
  try {
    if (!fs.existsSync(dbPathFor(logDir))) return [];
    const db = openDb(logDir);
    try {
      const cap = Number.isInteger(limit) && limit > 0 ? limit : 50;
      const rows = type
        ? db.prepare('SELECT * FROM runs WHERE type = ? ORDER BY id DESC LIMIT ?').all(String(type), cap)
        : db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(cap);
      return rows.map((r) => ({
        id: r.id,
        type: r.type,
        timestamp: r.timestamp,
        org: r.org ?? null,
        exitCode: r.exit_code ?? null,
        durationMs: r.duration_ms ?? null,
        status: r.status ?? null,
        summary: r.summary ? safeParse(r.summary) : null,
      }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
