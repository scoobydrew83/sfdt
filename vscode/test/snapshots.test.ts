import { describe, it, expect } from 'vitest';
import {
  buildHealthTree,
  rollupStatus,
  statusIcon,
  describeFinding,
  type Snapshot,
} from '../src/lib/snapshots.js';
import { COMMAND_CATALOG, findCommand } from '../src/lib/commands.js';

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

describe('COMMAND_CATALOG', () => {
  it('marks deploy as destructive and audit as not', () => {
    expect(findCommand('deploy')?.destructive).toBe(true);
    expect(findCommand('audit')?.destructive).toBeFalsy();
  });
  it('every entry has args', () => {
    for (const c of COMMAND_CATALOG) expect(c.args.length).toBeGreaterThan(0);
  });
});
