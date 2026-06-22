/**
 * Pure helpers that turn sfdt audit/monitor JSON snapshots into a flat tree of
 * plain node descriptors. The tree provider (which imports `vscode`) maps these
 * to TreeItems. Keeping this logic here makes it unit-testable in isolation.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'error';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  summary: string;
  findings: Array<Record<string, unknown>>;
}

export interface Snapshot {
  timestamp: string;
  org: string;
  checks: CheckResult[];
  summary: { total: number; ok: number; warn: number; fail: number; error: number };
}

export interface TreeNode {
  id: string;
  label: string;
  description?: string;
  status?: CheckStatus;
  /** A run-able sfdt command (palette/inline), e.g. ['audit','mfa']. */
  command?: string[];
  children?: TreeNode[];
}

const STATUS_ICON: Record<CheckStatus, string> = {
  ok: 'pass',
  warn: 'warning',
  fail: 'error',
  error: 'error',
};

/** Map a check status to a VS Code ThemeIcon id (consumed by the tree layer). */
export function statusIcon(status?: CheckStatus): string {
  return status ? STATUS_ICON[status] : 'circle-outline';
}

/** Worst status across a set of checks, for rolling up to a section node. */
export function rollupStatus(checks: CheckResult[]): CheckStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'error')) return 'error';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'ok';
}

function sectionFromSnapshot(id: string, label: string, snap: Snapshot | null, runAll: string[]): TreeNode {
  if (!snap) {
    return {
      id,
      label,
      description: 'not run yet',
      command: runAll,
      children: [{ id: `${id}.empty`, label: 'Run to populate…', command: runAll }],
    };
  }
  return {
    id,
    label,
    description: `${snap.summary.warn + snap.summary.fail} issue(s) · ${snap.org}`,
    status: rollupStatus(snap.checks),
    children: snap.checks.map((c) => ({
      id: `${id}.${c.id}`,
      label: c.title,
      description: c.summary,
      status: c.status,
      command: [...runAll.slice(0, 1), c.id],
      children: c.findings.slice(0, 25).map((f, i) => ({
        id: `${id}.${c.id}.${i}`,
        label: describeFinding(f),
      })),
    })),
  };
}

/**
 * Build the full Org Health tree from the latest audit and monitor snapshots
 * (either may be null when not yet run).
 */
export function buildHealthTree(audit: Snapshot | null, monitor: Snapshot | null): TreeNode[] {
  return [
    sectionFromSnapshot('diagnostics', 'Diagnostics & Audit', audit, ['audit', 'all']),
    sectionFromSnapshot('monitoring', 'Monitoring', monitor, ['monitor', 'all']),
  ];
}

/** Best-effort one-line description for an arbitrary finding object. */
export function describeFinding(f: Record<string, unknown>): string {
  if (f.name && f.apiVersion != null) return `${f.type ? `${f.type} ` : ''}${f.name} (API ${f.apiVersion})`;
  if (f.username) return `${f.name ?? f.username} <${f.username}>${f.lastLogin ? ` — last login ${f.lastLogin}` : ''}`;
  if (f.action) return `${f.date}: ${f.action} (${f.section}) by ${f.user}`;
  if (f.job) return `${f.date}: ${f.job} (${f.type}) — ${f.errors} error(s)`;
  if (f.name && f.max != null) return `${f.name}: ${f.used}/${f.max}`;
  if (f.score != null) return `score ${f.score}% (floor ${f.floor}%)`;
  if (f.name) return String(f.name);
  return JSON.stringify(f);
}
