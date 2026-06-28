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
  checkAuditTrail,
  checkLicenses,
  checkMfa,
  checkUnusedApex,
  checkInactiveUsers,
  checkApiVersions,
  checkInactiveFlows,
  checkUnusedPermsets,
  checkConnectedApps,
  checkFieldDescriptions,
  checkApexUnreferenced,
  checkLintAccess,
} from '../../src/lib/audit-runner.js';

beforeEach(() => vi.resetAllMocks());

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

describe('checkInactiveFlows', () => {
  it('flags flow definitions with no active version', async () => {
    query.mockResolvedValueOnce([
      { DeveloperName: 'Old_Flow', ActiveVersionId: null },
      { DeveloperName: 'Draft_Flow', ActiveVersionId: null },
    ]);
    const r = await checkInactiveFlows('dev');
    expect(r.status).toBe('warn');
    expect(r.findings.map((f) => f.name)).toEqual(['Old_Flow', 'Draft_Flow']);
  });

  it('returns ok when all flows are active', async () => {
    query.mockResolvedValueOnce([]);
    const r = await checkInactiveFlows('dev');
    expect(r.status).toBe('ok');
  });
});

describe('checkUnusedPermsets', () => {
  it('flags permission sets with no direct or group assignment', async () => {
    query
      .mockResolvedValueOnce([{ PermissionSetId: 'PS_ASSIGNED' }]) // PermissionSetAssignment
      .mockResolvedValueOnce([{ PermissionSetId: 'PS_IN_GROUP' }]) // PermissionSetGroupComponent
      .mockResolvedValueOnce([
        { Id: 'PS_ASSIGNED', Name: 'Assigned', Label: 'Assigned' },
        { Id: 'PS_IN_GROUP', Name: 'Grouped', Label: 'Grouped' },
        { Id: 'PS_ORPHAN', Name: 'Orphan', Label: 'Orphan PS' },
      ]);
    const r = await checkUnusedPermsets('dev');
    expect(r.status).toBe('warn');
    expect(r.findings.map((f) => f.name)).toEqual(['Orphan PS']);
  });
});

describe('checkConnectedApps', () => {
  it('flags apps that permit all users when flagPermissive is on', async () => {
    query.mockResolvedValueOnce([
      { Name: 'Open App', OptionsAllowAdminApprovedUsersOnly: false },
      { Name: 'Locked App', OptionsAllowAdminApprovedUsersOnly: true },
    ]);
    const r = await checkConnectedApps('dev', { flagPermissive: true });
    expect(r.status).toBe('warn');
    expect(r.findings.map((f) => f.name)).toEqual(['Open App']);
  });

  it('flags nothing when flagPermissive is off', async () => {
    query.mockResolvedValueOnce([{ Name: 'Open App', OptionsAllowAdminApprovedUsersOnly: false }]);
    const r = await checkConnectedApps('dev', { flagPermissive: false });
    expect(r.status).toBe('ok');
    expect(r.findings).toHaveLength(0);
  });
});

describe('checkFieldDescriptions', () => {
  it('warns when missing descriptions exceed the threshold', async () => {
    query.mockResolvedValueOnce([
      { DeveloperName: 'Foo', TableEnumOrId: 'Account' },
      { DeveloperName: 'Bar', TableEnumOrId: 'Contact' },
    ]);
    const r = await checkFieldDescriptions('dev', { maxMissing: 0 });
    expect(r.status).toBe('warn');
    expect(r.findings).toHaveLength(2);
  });

  it('stays ok within the threshold', async () => {
    query.mockResolvedValueOnce([{ DeveloperName: 'Foo', TableEnumOrId: 'Account' }]);
    const r = await checkFieldDescriptions('dev', { maxMissing: 5 });
    expect(r.status).toBe('ok');
  });
});

describe('checkApexUnreferenced', () => {
  it('flags non-test classes absent from the dependency graph', async () => {
    query
      .mockResolvedValueOnce([{ Name: 'UsedClass' }, { Name: 'OrphanClass' }, { Name: 'MyTest' }]) // ApexClass
      .mockResolvedValueOnce([{ RefMetadataComponentName: 'UsedClass' }]); // MetadataComponentDependency
    const r = await checkApexUnreferenced('dev');
    expect(r.status).toBe('warn');
    expect(r.findings.map((f) => f.name)).toEqual(['OrphanClass']);
  });

  it('skips (warn) when no dependency data is available', async () => {
    query
      .mockResolvedValueOnce([{ Name: 'AnyClass' }])
      .mockResolvedValueOnce([]);
    const r = await checkApexUnreferenced('dev');
    expect(r.status).toBe('warn');
    expect(r.summary).toContain('No dependency data');
  });
});

describe('checkLintAccess', () => {
  it('flags custom objects with no Read grant and matches __c literally', async () => {
    query.mockResolvedValueOnce([
      { SobjectType: 'Visible__c', PermissionsRead: true },
      { SobjectType: 'Visible__c', PermissionsRead: false },
      { SobjectType: 'Hidden__c', PermissionsRead: false },
      { SobjectType: 'Account', PermissionsRead: false }, // standard object ignored
    ]);
    const r = await checkLintAccess('dev');
    expect(r.status).toBe('warn');
    expect(r.findings.map((f) => f.name)).toEqual(['Hidden__c']);
  });

  it('returns ok when there are no custom-object permission entries', async () => {
    query.mockResolvedValueOnce([{ SobjectType: 'Account', PermissionsRead: true }]);
    const r = await checkLintAccess('dev');
    expect(r.status).toBe('ok');
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
