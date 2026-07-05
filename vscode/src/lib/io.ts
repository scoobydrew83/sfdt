import { readFile } from 'node:fs/promises';
import * as fs from 'node:fs';
import path from 'node:path';
import type { Snapshot, ScanSnapshot, DriftSnapshot } from './snapshots.js';

/** Read and parse a JSON file, returning null if it is missing or invalid. */
export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const text = await readFile(filePath, 'utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Resolve the sfdt logs directory for a workspace root, honouring an optional
 * `logDir` in `.sfdt/config.json` (the CLI honours it via SFDT_LOG_DIR and the
 * GUI reads it too — a custom logDir would otherwise leave every snapshot
 * view permanently empty). Sync read, cached per root: called from tree
 * refresh paths that are already debounced.
 */
const logDirCache = new Map<string, { at: number; dir: string }>();
export function logsDir(projectRoot: string): string {
  const cached = logDirCache.get(projectRoot);
  if (cached && Date.now() - cached.at < 30_000) return cached.dir;
  let dir = path.join(projectRoot, 'logs');
  try {
    const raw = fs.readFileSync(path.join(projectRoot, '.sfdt', 'config.json'), 'utf8');
    const logDir: unknown = JSON.parse(raw).logDir;
    if (typeof logDir === 'string' && logDir.trim()) {
      dir = path.isAbsolute(logDir) ? logDir : path.join(projectRoot, logDir);
    }
  } catch {
    /* no config / unparseable — default logs/ */
  }
  logDirCache.set(projectRoot, { at: Date.now(), dir });
  return dir;
}

/** Read the latest audit and monitor snapshots from a workspace's logs dir. */
export async function readSnapshots(
  projectRoot: string,
): Promise<{ audit: Snapshot | null; monitor: Snapshot | null }> {
  const dir = logsDir(projectRoot);
  const [audit, monitor] = await Promise.all([
    readJsonIfExists<Snapshot>(path.join(dir, 'audit-latest.json')),
    readJsonIfExists<Snapshot>(path.join(dir, 'monitor-latest.json')),
  ]);
  return { audit, monitor };
}

/**
 * Read the latest quality log envelope (`logs/quality-latest.json`) — the
 * snapshot dashboard quality runs write and the MCP server reads. Returned
 * untyped: `qualityFromSnapshot` (lib/diagnostics) validates the shape.
 */
export async function readQualityLog(projectRoot: string): Promise<unknown> {
  return readJsonIfExists<unknown>(path.join(logsDir(projectRoot), 'quality-latest.json'));
}

/** Read the latest scan + drift snapshots (Org Health's secondary sections). */
export async function readScanDrift(
  projectRoot: string,
): Promise<{ scan: ScanSnapshot | null; drift: DriftSnapshot | null }> {
  const dir = logsDir(projectRoot);
  const [scan, drift] = await Promise.all([
    readJsonIfExists<ScanSnapshot>(path.join(dir, 'scan-latest.json')),
    readJsonIfExists<DriftSnapshot>(path.join(dir, 'drift-latest.json')),
  ]);
  return { scan, drift };
}
