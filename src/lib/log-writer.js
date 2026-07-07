// src/lib/log-writer.js
import fs from 'fs-extra';
import path from 'path';
import { recordRun } from './run-history.js';

const SCHEMA_VERSION = '1';
const LOG_TYPES = ['preflight', 'test-run', 'drift', 'quality'];

const LATEST_FILES = {
  preflight: 'preflight-latest.json',
  'test-run': path.join('test-results', 'latest.json'),
  drift: 'drift-latest.json',
  quality: 'quality-latest.json',
};

const ARCHIVE_DIRS = {
  preflight: 'preflight-results',
  'test-run': 'test-results',
  drift: 'drift-results',
  quality: 'quality-results',
};

/**
 * Parse SFDT_LOG: marker lines from script stdout into structured arrays.
 * Format: SFDT_LOG:kind:name:status-or-type:message (split on first 4 colons only)
 */
export function parseSfdtLogLines(lines) {
  if (!lines || !Array.isArray(lines)) return { checks: [], components: [] };

  const checks = [];
  const components = [];

  for (const line of lines) {
    if (!line.startsWith('SFDT_LOG:')) continue;
    const parts = line.split(':');
    // parts: ['SFDT_LOG', kind, field2, field3, ...rest]
    const kind = parts[1];
    if (kind === 'check') {
      const name = parts[2];
      const status = parts[3];
      const message = parts.slice(4).join(':');
      checks.push({ name, status, message });
    } else if (kind === 'component') {
      const name = parts[2];
      const type = parts[3];
      const drift = parts.slice(4).join(':');
      components.push({ name, type, drift });
    }
  }

  return { checks, components };
}

/**
 * Validate that an object conforms to the structured log envelope schema.
 */
export function validateLogSchema(log) {
  if (!log || typeof log !== 'object') return false;
  if (log.schemaVersion !== SCHEMA_VERSION) return false;
  if (!LOG_TYPES.includes(log.type)) return false;
  if (typeof log.timestamp !== 'string') return false;
  if (!log.data || typeof log.data !== 'object') return false;
  return true;
}

/**
 * Write a structured log for the given type.
 * Creates logs/{type}-latest.json and an archive copy.
 *
 * @param {string} logDir - Absolute path to the logs directory
 * @param {string} type - One of: preflight, test-run, drift, quality
 * @param {object} data - Type-specific payload
 * @param {object} [meta] - exitCode, durationMs, org, projectName, retention
 * @returns {object} The written envelope
 */
export async function writeLog(logDir, type, data, meta = {}) {
  if (!LOG_TYPES.includes(type)) throw new Error(`Unknown log type: ${type}. Must be one of: ${LOG_TYPES.join(', ')}`);
  if (data === undefined || data === null) throw new Error(`writeLog: data is required for type "${type}"`);
  const { org = '', projectName = '', exitCode = 0, durationMs = 0, retention = 50, status, summary } = meta;

  const timestamp = new Date().toISOString();
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    type,
    timestamp,
    durationMs,
    exitCode,
    org,
    projectName,
    data,
  };

  // Write latest
  const latestPath = path.join(logDir, LATEST_FILES[type]);
  await fs.outputJson(latestPath, envelope, { spaces: 2 });

  // Archive (timestamped filename — colons replaced so it's filesystem-safe)
  const archiveDir = path.join(logDir, ARCHIVE_DIRS[type]);
  await fs.ensureDir(archiveDir);
  const suffix = Math.random().toString(36).slice(2, 7);
  const archiveName = timestamp.replace(/:/g, '-').replace(/\./g, '-') + `-${suffix}` + '.json';
  await fs.outputJson(path.join(archiveDir, archiveName), envelope, { spaces: 2 });

  // Prune oldest archives beyond retention limit
  const entries = (await fs.readdir(archiveDir))
    .filter((f) => f.endsWith('.json') && f !== 'latest.json')
    .sort();
  if (entries.length > retention) {
    const toDelete = entries.slice(0, entries.length - retention);
    await Promise.all(toDelete.map((f) => fs.remove(path.join(archiveDir, f))));
  }

  // Index the run in the queryable history (best-effort; never throws).
  await recordRun(logDir, {
    type,
    timestamp,
    org,
    exitCode,
    durationMs,
    status: status ?? (exitCode === 0 ? 'pass' : 'fail'),
    summary: summary ?? null,
  });

  return envelope;
}

const RAW_ARCHIVE_DIRS = {
  deploy: 'deploy-results',
  rollback: 'rollback-results',
};

export async function writeRawLog(logDir, type, rawOutput, meta = {}) {
  const archiveDirName = RAW_ARCHIVE_DIRS[type];
  if (!archiveDirName) throw new Error(`writeRawLog: unknown type "${type}". Must be deploy or rollback.`);

  const { org = '', exitCode = 0, durationMs = 0, retention = 50 } = meta;
  const timestamp = new Date().toISOString();
  const envelope = {
    schemaVersion: 'raw-1',
    type,
    timestamp,
    org,
    exitCode,
    durationMs,
    rawOutput,
  };

  const archiveDir = path.join(logDir, archiveDirName);
  await fs.ensureDir(archiveDir);
  const suffix = Math.random().toString(36).slice(2, 7);
  const archiveName = timestamp.replace(/:/g, '-').replace(/\./g, '-') + `-${suffix}.json`;
  await fs.outputJson(path.join(archiveDir, archiveName), envelope, { spaces: 2 });

  const entries = (await fs.readdir(archiveDir))
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (entries.length > retention) {
    const toDelete = entries.slice(0, entries.length - retention);
    await Promise.all(toDelete.map((f) => fs.remove(path.join(archiveDir, f))));
  }

  await recordRun(logDir, {
    type,
    timestamp,
    org,
    exitCode,
    durationMs,
    status: meta.status ?? (exitCode === 0 ? 'pass' : 'fail'),
    summary: meta.summary ?? null,
  });

  return envelope;
}

/**
 * Archive a raw snapshot (kept in its native shape, e.g. logs/audit-latest.json)
 * as a timestamped copy under logs/<dirName>/, pruned to `retention`. Unlike
 * writeLog this does NOT wrap the payload in an envelope — the history files are
 * byte-identical to the `-latest.json` the GUI/VS Code already read. Used by
 * commands (audit/monitor) that keep a raw `-latest.json` snapshot.
 */
export async function archiveSnapshot(logDir, dirName, snapshot, meta = {}) {
  const { retention = 50 } = meta;
  const timestamp = new Date().toISOString();
  const archiveDir = path.join(logDir, dirName);
  await fs.ensureDir(archiveDir);
  const suffix = Math.random().toString(36).slice(2, 7);
  const archiveName = timestamp.replace(/:/g, '-').replace(/\./g, '-') + `-${suffix}.json`;
  await fs.outputJson(path.join(archiveDir, archiveName), snapshot, { spaces: 2 });

  const entries = (await fs.readdir(archiveDir)).filter((f) => f.endsWith('.json') && f !== 'latest.json').sort();
  if (entries.length > retention) {
    const toDelete = entries.slice(0, entries.length - retention);
    await Promise.all(toDelete.map((f) => fs.remove(path.join(archiveDir, f))));
  }
  return path.join(archiveDir, archiveName);
}

/**
 * Read and validate the latest structured log for the given type.
 * Returns the envelope object or null if missing, corrupt, or schema-invalid.
 */
export async function readLatestLog(logDir, type) {
  if (!LOG_TYPES.includes(type)) return null;
  const filePath = path.join(logDir, LATEST_FILES[type]);
  try {
    const log = await fs.readJson(filePath);
    if (!validateLogSchema(log)) return null;
    return log;
  } catch {
    return null;
  }
}
