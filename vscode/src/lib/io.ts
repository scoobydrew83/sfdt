import { readFile } from 'node:fs/promises';
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

/** Resolve the sfdt logs directory for a workspace root. */
export function logsDir(projectRoot: string): string {
  return path.join(projectRoot, 'logs');
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
