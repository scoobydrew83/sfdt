// src/lib/log-writer.js
import fs from 'fs-extra';
import path from 'path';

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
      const drift = parts[4];
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
  const { org = '', projectName = '', exitCode = 0, durationMs = 0, retention = 50 } = meta;

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

  return envelope;
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
