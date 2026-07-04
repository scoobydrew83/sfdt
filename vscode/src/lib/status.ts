/**
 * Pure helpers that turn org / git / version / snapshot facts into the Status
 * view's tree of plain node descriptors. Free of any `vscode` import.
 */

import { rollupStatus, type CheckStatus, type Snapshot, type TreeNode } from './snapshots.js';
import { testRunsSection, type TestRunSummary } from './test-runs.js';

export interface StatusInput {
  orgAlias?: string;
  instanceUrl?: string;
  connected?: boolean;
  gitBranch?: string;
  audit: Snapshot | null;
  monitor: Snapshot | null;
  sfdtVersion?: string;
  sfVersion?: string;
  /** Latest sfdt version known (from `sfdt update`/registry); enables an "update" hint. */
  latestSfdtVersion?: string;
  /**
   * Recent Apex test runs (newest first, from logs/test-results). Omit to skip
   * the "Test Runs" section entirely (back-compat with existing callers).
   */
  testRuns?: TestRunSummary[];
  /** Absolute test-results dir; enables click-to-open on run nodes. */
  testResultsDir?: string;
}

/** Compare two semver-ish strings; true when `current` is behind `latest`. */
export function isOutdated(current?: string, latest?: string): boolean {
  if (!current || !latest) return false;
  const norm = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const a = norm(current);
  const b = norm(latest);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}

/** Worst status across the audit + monitor snapshots, or null when neither ran. */
export function overallHealth(audit: Snapshot | null, monitor: Snapshot | null): CheckStatus | null {
  const checks = [...(audit?.checks ?? []), ...(monitor?.checks ?? [])];
  if (checks.length === 0) return null;
  return rollupStatus(checks);
}

/** Build the Status view tree. */
export function buildStatusTree(input: StatusInput): TreeNode[] {
  const nodes: TreeNode[] = [];

  // ── Org ──
  const orgChildren: TreeNode[] = [];
  if (input.instanceUrl) orgChildren.push({ id: 'status.org.url', label: input.instanceUrl });
  orgChildren.push({
    id: 'status.org.conn',
    label: input.connected === false ? 'Not connected' : input.orgAlias ? 'Connected' : 'No default org',
    status: input.connected === false ? 'fail' : input.orgAlias ? 'ok' : 'warn',
  });
  nodes.push({
    id: 'status.org',
    label: 'Org',
    description: input.orgAlias ?? 'click to select…',
    status: input.orgAlias ? (input.connected === false ? 'fail' : 'ok') : 'warn',
    command: ['__pickOrg'],
    children: orgChildren,
  });

  // ── Git ──
  nodes.push({
    id: 'status.git',
    label: 'Branch',
    description: input.gitBranch ?? 'no git repo',
  });

  // ── Health rollup ──
  const ran = input.audit !== null || input.monitor !== null;
  const health = overallHealth(input.audit, input.monitor);
  const issues = ['warn', 'fail', 'error'].reduce((sum, k) => {
    const key = k as 'warn' | 'fail' | 'error';
    return sum + (input.audit?.summary[key] ?? 0) + (input.monitor?.summary[key] ?? 0);
  }, 0);
  nodes.push({
    id: 'status.health',
    label: 'Org Health',
    description: !ran ? 'not run yet' : issues === 0 ? 'all clear' : `${issues} issue(s)`,
    status: health ?? undefined,
    command: ['audit', 'all'],
  });

  // ── Test runs ──
  if (input.testRuns !== undefined) {
    nodes.push(testRunsSection(input.testRuns, input.testResultsDir));
  }

  // ── Versions ──
  const versionChildren: TreeNode[] = [];
  const outdated = isOutdated(input.sfdtVersion, input.latestSfdtVersion);
  if (input.sfdtVersion) {
    versionChildren.push({
      id: 'status.ver.sfdt',
      label: `sfdt ${input.sfdtVersion}`,
      description: outdated ? `update available → ${input.latestSfdtVersion}` : undefined,
      status: outdated ? 'warn' : 'ok',
      command: outdated ? ['update'] : undefined,
    });
  }
  if (input.sfVersion) {
    versionChildren.push({ id: 'status.ver.sf', label: input.sfVersion });
  }
  if (versionChildren.length > 0) {
    nodes.push({
      id: 'status.versions',
      label: 'Versions',
      description: outdated ? 'update available' : undefined,
      status: outdated ? 'warn' : undefined,
      children: versionChildren,
    });
  }

  return nodes;
}
