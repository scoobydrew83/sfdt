/**
 * Pure helpers that turn sfdt audit/monitor JSON snapshots into a flat tree of
 * plain node descriptors. The tree provider (which imports `vscode`) maps these
 * to TreeItems. Keeping this logic here makes it unit-testable in isolation.
 */

import { describeFinding } from '@sfdt/flow-core';

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
    description: `${snap.summary.warn + snap.summary.fail + snap.summary.error} issue(s) · ${snap.org}`,
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

export interface ScanSnapshot {
  org?: string;
  summary?: { totalTypes?: number; totalMembers?: number };
}

export interface DriftSnapshot {
  org?: string;
  driftStatus?: string;
  components?: unknown[];
}

function scanNode(scan: ScanSnapshot | null): TreeNode {
  if (!scan) return { id: 'scan', label: 'Metadata Inventory', description: 'not run yet', command: ['scan'] };
  const s = scan.summary ?? {};
  const org = scan.org ? ` · ${scan.org}` : '';
  return {
    id: 'scan',
    label: 'Metadata Inventory',
    description: `${s.totalTypes ?? '?'} types · ${s.totalMembers ?? '?'} members${org}`,
    status: 'ok',
    command: ['scan'],
  };
}

function driftNode(drift: DriftSnapshot | null): TreeNode {
  if (!drift) return { id: 'drift', label: 'Drift', description: 'not run yet', command: ['drift'] };
  const count = Array.isArray(drift.components) ? drift.components.length : 0;
  const clean = (drift.driftStatus ?? '').toUpperCase() === 'PASS' || count === 0;
  return {
    id: 'drift',
    label: 'Drift',
    description: clean ? 'in sync' : `${count} drifted component(s)`,
    status: clean ? 'ok' : 'warn',
    command: ['drift'],
  };
}

/**
 * Build the full Org Health tree from the latest snapshots. `audit`/`monitor`
 * are always rendered; `scan`/`drift` sections are appended only when those
 * arguments are supplied (kept optional for back-compat with existing callers).
 */
export function buildHealthTree(
  audit: Snapshot | null,
  monitor: Snapshot | null,
  scan?: ScanSnapshot | null,
  drift?: DriftSnapshot | null,
): TreeNode[] {
  const nodes: TreeNode[] = [
    sectionFromSnapshot('diagnostics', 'Diagnostics & Audit', audit, ['audit', 'all']),
    sectionFromSnapshot('monitoring', 'Monitoring', monitor, ['monitor', 'all']),
  ];
  if (scan !== undefined) nodes.push(scanNode(scan));
  if (drift !== undefined) nodes.push(driftNode(drift));
  return nodes;
}

// describeFinding is the canonical renderer from @sfdt/flow-core (imported at
// the top of this file); re-exported so the tree provider and tests keep their
// import path. A local copy previously diverged — it dropped license findings
// (`total` vs `max`) to raw JSON.
export { describeFinding };
