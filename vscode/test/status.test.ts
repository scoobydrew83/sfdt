import { describe, it, expect } from 'vitest';
import { isOutdated, overallHealth, buildStatusTree, type StatusInput } from '../src/lib/status.js';
import type { Snapshot } from '../src/lib/snapshots.js';

function snap(partial: Partial<Snapshot>): Snapshot {
  return {
    timestamp: '2026-06-26T00:00:00Z',
    org: 'dev',
    checks: [],
    summary: { total: 0, ok: 0, warn: 0, fail: 0, error: 0 },
    ...partial,
  };
}

describe('isOutdated', () => {
  it('detects an older current version', () => {
    expect(isOutdated('0.14.0', '0.14.1')).toBe(true);
    expect(isOutdated('0.13.5', '0.14.0')).toBe(true);
  });
  it('returns false when current is equal or newer', () => {
    expect(isOutdated('0.14.1', '0.14.1')).toBe(false);
    expect(isOutdated('0.15.0', '0.14.1')).toBe(false);
  });
  it('ignores a leading v and prerelease suffix', () => {
    expect(isOutdated('v0.14.0', '0.14.1-beta.1')).toBe(true);
  });
  it('returns false when either version is missing', () => {
    expect(isOutdated(undefined, '0.14.1')).toBe(false);
    expect(isOutdated('0.14.0', undefined)).toBe(false);
  });
});

describe('overallHealth', () => {
  it('returns null when nothing has run', () => {
    expect(overallHealth(null, null)).toBeNull();
  });
  it('rolls up the worst status across audit + monitor', () => {
    const audit = snap({ checks: [{ id: 'a', title: 'A', status: 'warn', summary: '', findings: [] }] });
    const monitor = snap({ checks: [{ id: 'm', title: 'M', status: 'fail', summary: '', findings: [] }] });
    expect(overallHealth(audit, monitor)).toBe('fail');
  });
});

describe('buildStatusTree', () => {
  const base: StatusInput = { audit: null, monitor: null };

  it('shows an org picker prompt when no org is set', () => {
    const tree = buildStatusTree(base);
    const org = tree.find((n) => n.id === 'status.org')!;
    expect(org.description).toMatch(/select/i);
    expect(org.command).toEqual(['__pickOrg']);
    expect(org.status).toBe('warn');
  });

  it('reflects a connected org', () => {
    const tree = buildStatusTree({ ...base, orgAlias: 'DevHub', connected: true, instanceUrl: 'https://x.my.salesforce.com' });
    const org = tree.find((n) => n.id === 'status.org')!;
    expect(org.description).toBe('DevHub');
    expect(org.status).toBe('ok');
    expect(org.children?.some((c) => c.label === 'https://x.my.salesforce.com')).toBe(true);
  });

  it('surfaces an update hint when the CLI is outdated', () => {
    const tree = buildStatusTree({ ...base, sfdtVersion: '0.14.0', latestSfdtVersion: '0.14.1' });
    const versions = tree.find((n) => n.id === 'status.versions')!;
    expect(versions.status).toBe('warn');
    const sfdt = (versions.children ?? []).find((c) => c.id === 'status.ver.sfdt');
    expect(sfdt?.command).toEqual(['update']);
    expect(sfdt?.description).toMatch(/update available/);
  });

  it('counts issues from both snapshots in the health node', () => {
    const audit = snap({ summary: { total: 3, ok: 1, warn: 2, fail: 0, error: 0 } });
    const monitor = snap({ summary: { total: 2, ok: 1, warn: 0, fail: 1, error: 0 } });
    const tree = buildStatusTree({ ...base, audit, monitor });
    const health = tree.find((n) => n.id === 'status.health')!;
    expect(health.description).toBe('3 issue(s)');
  });

  it('omits the Test Runs section when no runs are supplied (back-compat)', () => {
    const tree = buildStatusTree(base);
    expect(tree.find((n) => n.id === 'status.tests')).toBeUndefined();
  });

  it('renders the Test Runs section when runs are supplied', () => {
    const tree = buildStatusTree({
      ...base,
      testRuns: [{ file: 'r.json', date: '2026-07-01T10:00:00Z', passed: 7, failed: 0, errors: 0 }],
      testResultsDir: '/proj/logs/test-results',
    });
    const tests = tree.find((n) => n.id === 'status.tests')!;
    expect(tests.status).toBe('ok');
    expect(tests.description).toContain('last: PASS');
    expect(tests.children).toHaveLength(1);
  });

  it('renders the Test Runs empty state when runs is an empty array', () => {
    const tests = buildStatusTree({ ...base, testRuns: [] }).find((n) => n.id === 'status.tests')!;
    expect(tests.description).toBe('none yet');
  });
});
