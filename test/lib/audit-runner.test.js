import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/org-query.js', () => ({
  query: vi.fn(),
  safeParse: (text) => {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  },
}));

import { query } from '../../src/lib/org-query.js';
import {
  runAudit,
  CHECK_IDS,
  AUDIT_DEFAULTS,
  checkAuditTrail,
  checkLicenses,
  checkMfa,
  checkUnusedApex,
  checkInactiveUsers,
  checkApiVersions,
} from '../../src/lib/audit-runner.js';

beforeEach(() => vi.resetAllMocks());

describe('AUDIT_DEFAULTS', () => {
  it('sources usage/age thresholds from the shared flow-core rulebook', () => {
    // licenseWarnThreshold is 0.75 (not the old 0.9) after the flow-core unification.
    expect(AUDIT_DEFAULTS).toMatchObject({
      auditTrailLookbackDays: 30,
      licenseWarnThreshold: 0.75,
      inactiveUserDays: 90,
      minApiVersion: 45,
    });
  });
});

describe('checkAuditTrail', () => {
  it('flags suspect actions and ignores benign ones', async () => {
    query.mockResolvedValueOnce([
      { Action: 'deactivateuser', Section: 'Manage Users', CreatedDate: '2026-06-01T00:00:00Z', CreatedBy: { Name: 'Admin' }, Display: 'x' },
      { Action: 'changedLayout', Section: 'Page Layouts', CreatedDate: '2026-06-01T00:00:00Z', CreatedBy: { Name: 'Admin' } },
    ]);
    const r = await checkAuditTrail('dev');
    expect(r.status).toBe('warn');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].action).toBe('deactivateuser');
  });

  it('returns ok when there are no suspect changes', async () => {
    query.mockResolvedValueOnce([
      { Action: 'changedLayout', Section: 'Page Layouts', CreatedDate: '2026-06-01T00:00:00Z', CreatedBy: { Name: 'Admin' } },
    ]);
    const r = await checkAuditTrail('dev');
    expect(r.status).toBe('ok');
  });

  it('returns error status when the query throws', async () => {
    query.mockRejectedValueOnce(new Error('boom'));
    const r = await checkAuditTrail('dev');
    expect(r.status).toBe('error');
    expect(r.summary).toContain('boom');
  });
});

describe('checkLicenses', () => {
  it('flags licenses at or above the warn threshold', async () => {
    query.mockResolvedValueOnce([
      { Name: 'Salesforce', TotalLicenses: 100, UsedLicenses: 95, Status: 'Active' },
      { Name: 'Chatter', TotalLicenses: 100, UsedLicenses: 10, Status: 'Active' },
    ]);
    const r = await checkLicenses('dev', { warnThreshold: 0.9 });
    expect(r.status).toBe('warn');
    expect(r.findings.map((f) => f.name)).toEqual(['Salesforce']);
  });
});

describe('checkMfa', () => {
  it('flags active users without a registered MFA method', async () => {
    query
      .mockResolvedValueOnce([{ UserId: 'u1' }]) // enrolled
      .mockResolvedValueOnce([
        { Id: 'u1', Username: 'a@x.com', Name: 'A' },
        { Id: 'u2', Username: 'b@x.com', Name: 'B' },
      ]);
    const r = await checkMfa('dev');
    expect(r.status).toBe('warn');
    expect(r.findings).toEqual([{ username: 'b@x.com', name: 'B', license: undefined }]);
  });
});

describe('checkUnusedApex', () => {
  it('flags non-test classes with no coverage', async () => {
    query
      .mockResolvedValueOnce([
        { Id: 'c1', Name: 'Service', ApiVersion: 58 },
        { Id: 'c2', Name: 'ServiceTest', ApiVersion: 58 },
        { Id: 'c3', Name: 'Helper', ApiVersion: 58 },
      ])
      .mockResolvedValueOnce([{ ApexClassOrTriggerId: 'c1', NumLinesCovered: 10, NumLinesUncovered: 0 }]);
    const r = await checkUnusedApex('dev');
    // c1 covered, c2 is a test, c3 uncovered → only c3 flagged
    expect(r.findings.map((f) => f.name)).toEqual(['Helper']);
  });

  it('skips detection (warn, no findings) when coverage data is empty', async () => {
    query
      .mockResolvedValueOnce([{ Id: 'c1', Name: 'Service', ApiVersion: 58 }])
      .mockResolvedValueOnce([]); // no ApexCodeCoverageAggregate rows
    const r = await checkUnusedApex('dev');
    expect(r.status).toBe('warn');
    expect(r.findings).toEqual([]);
    expect(r.summary).toMatch(/coverage data/i);
  });
});

describe('checkInactiveUsers', () => {
  it('maps inactive users to findings', async () => {
    query.mockResolvedValueOnce([
      { Username: 'old@x.com', Name: 'Old', LastLoginDate: null, Profile: { Name: 'Std' } },
    ]);
    const r = await checkInactiveUsers('dev', { lookbackDays: 90 });
    expect(r.status).toBe('warn');
    expect(r.findings[0]).toMatchObject({ username: 'old@x.com', lastLogin: null });
  });
});

describe('checkApiVersions', () => {
  it('aggregates deprecated classes and triggers', async () => {
    query
      .mockResolvedValueOnce([{ Name: 'OldClass', ApiVersion: 30 }]) // ApexClass
      .mockResolvedValueOnce([{ Name: 'OldTrigger', ApiVersion: 28 }]); // ApexTrigger
    const r = await checkApiVersions('dev', { minApiVersion: 45 });
    expect(r.status).toBe('warn');
    expect(r.findings).toHaveLength(2);
    expect(r.findings.map((f) => f.type)).toEqual(['ApexClass', 'ApexTrigger']);
  });
});

describe('runAudit', () => {
  it('runs all checks and builds a summary', async () => {
    query.mockResolvedValue([]); // every check sees no rows → ok
    const snapshot = await runAudit('dev');
    expect(snapshot.org).toBe('dev');
    expect(snapshot.checks).toHaveLength(CHECK_IDS.length);
    expect(snapshot.summary.total).toBe(CHECK_IDS.length);
    expect(snapshot.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('runs only the requested subset of checks', async () => {
    query.mockResolvedValue([]);
    const snapshot = await runAudit('dev', { checks: ['licenses'] });
    expect(snapshot.checks).toHaveLength(1);
    expect(snapshot.checks[0].id).toBe('licenses');
  });
});
