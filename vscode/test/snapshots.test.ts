import { describe, it, expect } from 'vitest';
import {
  buildHealthTree,
  rollupStatus,
  statusIcon,
  describeFinding,
  type Snapshot,
} from '../src/lib/snapshots.js';

function snap(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    timestamp: '2026-06-22T00:00:00Z',
    org: 'dev',
    checks: [
      { id: 'mfa', title: 'MFA coverage', status: 'warn', summary: '2 users without MFA', findings: [{ username: 'a@x.com', name: 'A' }] },
      { id: 'licenses', title: 'License usage', status: 'ok', summary: 'fine', findings: [] },
    ],
    summary: { total: 2, ok: 1, warn: 1, fail: 0, error: 0 },
    ...overrides,
  };
}

describe('rollupStatus', () => {
  it('prefers fail over warn/error/ok', () => {
    expect(rollupStatus([{ status: 'ok' }, { status: 'warn' }, { status: 'fail' }] as never)).toBe('fail');
  });
  it('returns ok when all ok', () => {
    expect(rollupStatus([{ status: 'ok' }, { status: 'ok' }] as never)).toBe('ok');
  });
});

describe('statusIcon', () => {
  it('maps statuses to theme icon ids', () => {
    expect(statusIcon('ok')).toBe('pass');
    expect(statusIcon('warn')).toBe('warning');
    expect(statusIcon('fail')).toBe('error');
    expect(statusIcon(undefined)).toBe('circle-outline');
  });
});

describe('buildHealthTree', () => {
  it('builds diagnostics and monitoring sections from snapshots', () => {
    const tree = buildHealthTree(snap(), null);
    expect(tree).toHaveLength(2);
    const [diag, mon] = tree;
    expect(diag.label).toMatch(/Diagnostics/);
    expect(diag.status).toBe('warn');
    expect(diag.children?.[0].label).toBe('MFA coverage');
    expect(diag.children?.[0].command).toEqual(['audit', 'mfa']);
    // monitoring not run yet → placeholder
    expect(mon.description).toMatch(/not run/);
    expect(mon.command).toEqual(['monitor', 'all']);
  });

  it('nests findings under each check', () => {
    const [diag] = buildHealthTree(snap(), null);
    const mfaNode = diag.children?.find((c) => c.label === 'MFA coverage');
    expect(mfaNode?.children?.[0].label).toContain('a@x.com');
  });

  it('gives each check a tooltip carrying title, status, and summary', () => {
    const [diag] = buildHealthTree(snap(), null);
    const mfaNode = diag.children?.find((c) => c.label === 'MFA coverage');
    expect(mfaNode?.tooltip).toContain('MFA coverage');
    expect(mfaNode?.tooltip).toContain('[warn]');
    expect(mfaNode?.tooltip).toContain('2 users without MFA');
    expect(mfaNode?.tooltip).toContain('sfdt audit mfa');
  });

  it('tags rendered sections with their snapshot type for snapshot actions', () => {
    const [diag, mon] = buildHealthTree(snap(), snap());
    expect(diag.snapshotType).toBe('audit');
    expect(mon.snapshotType).toBe('monitor');
  });

  it('omits snapshotType on placeholder sections (no snapshot to send)', () => {
    const [, mon] = buildHealthTree(snap(), null);
    expect(mon.snapshotType).toBeUndefined();
  });

  it('appends a scan section only when the scan arg is supplied', () => {
    expect(buildHealthTree(snap(), null)).toHaveLength(2);
    const tree = buildHealthTree(snap(), null, null);
    expect(tree).toHaveLength(3);
    const scan = tree[2];
    expect(scan.id).toBe('scan');
    expect(scan.description).toMatch(/not run yet/);
    expect(scan.command).toEqual(['scan']);
  });

  it('renders scan summary counts and org when present', () => {
    const tree = buildHealthTree(snap(), null, { org: 'prod', summary: { totalTypes: 12, totalMembers: 340 } });
    const scan = tree[2];
    expect(scan.description).toBe('12 types · 340 members · prod');
    expect(scan.status).toBe('ok');
  });

  it('falls back to ? for missing scan counts and omits org', () => {
    const tree = buildHealthTree(snap(), null, {});
    expect(tree[2].description).toBe('? types · ? members');
  });

  it('appends a drift section only when the drift arg is supplied', () => {
    const tree = buildHealthTree(snap(), null, null, null);
    expect(tree).toHaveLength(4);
    const drift = tree[3];
    expect(drift.id).toBe('drift');
    expect(drift.description).toMatch(/not run yet/);
    expect(drift.command).toEqual(['drift']);
  });

  it('marks drift clean when status is PASS or there are no components', () => {
    expect(buildHealthTree(snap(), null, undefined, { driftStatus: 'pass', components: [{}] })[2].description).toBe('in sync');
    const empty = buildHealthTree(snap(), null, undefined, { components: [] })[2];
    expect(empty.description).toBe('in sync');
    expect(empty.status).toBe('ok');
  });

  it('counts drifted components and flags a warn status', () => {
    const drift = buildHealthTree(snap(), null, undefined, { components: [{}, {}, {}] })[2];
    expect(drift.description).toBe('3 drifted component(s)');
    expect(drift.status).toBe('warn');
  });
});

describe('describeFinding', () => {
  it('renders an audit-trail finding', () => {
    expect(describeFinding({ action: 'deactivateuser', section: 'Users', user: 'Admin', date: '2026-06-01' }))
      .toContain('deactivateuser');
  });
  it('renders a limit finding', () => {
    expect(describeFinding({ name: 'DailyApiRequests', used: 95, max: 100 })).toBe('DailyApiRequests: 95/100');
  });
});
