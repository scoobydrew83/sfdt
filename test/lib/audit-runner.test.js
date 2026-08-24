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
  toSoqlDate: (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z'),
}));

// checkApiVersions dynamically imports org-release.js for the best-effort org
// ceiling — mock it so tests never spawn a real `sf` subprocess.
vi.mock('../../src/lib/org-release.js', () => ({
  detectOrgRelease: vi.fn().mockResolvedValue(null),
}));

import { query } from '../../src/lib/org-query.js';
import { detectOrgRelease } from '../../src/lib/org-release.js';
import {
  runAudit,
  CHECK_IDS,
  AUDIT_DEFAULTS,
  checkAuditTrail,
  classifyAuditAction,
  detectVelocityAnomalies,
  checkLicenses,
  checkMfa,
  checkMfaReadiness,
  checkSoapLogins,
  checkUnusedApex,
  checkInactiveUsers,
  checkApiVersions,
  checkInactiveFlows,
  checkUnusedPermsets,
  checkConnectedApps,
  checkFieldDescriptions,
  checkApexUnreferenced,
  checkLintAccess,
  checkInactiveValidations,
  checkInactiveWorkflows,
  checkLintAccessFields,
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
      soapLoginLookbackDays: 30,
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

  it('degrades to warn (not error) when TwoFactorMethodsInfo is not queryable', async () => {
    query.mockRejectedValueOnce(new Error("sObject type 'TwoFactorMethodsInfo' is not supported"));
    const r = await checkMfa('dev');
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/unavailable/);
    expect(r.findings).toEqual([]);
  });
});

describe('checkMfaReadiness', () => {
  it('is ok when every active user has a phishing-resistant method', async () => {
    query
      .mockResolvedValueOnce([
        { UserId: 'u1', HasTotp: false, HasU2F: true, HasBuiltInAuthenticator: false, HasSalesforceAuthenticator: false },
        { UserId: 'u2', HasTotp: false, HasU2F: false, HasSecurityKey: true, HasBuiltInAuthenticator: false, HasSalesforceAuthenticator: false },
      ])
      .mockResolvedValueOnce([
        { Id: 'u1', Username: 'a@x.com', Name: 'A' },
        { Id: 'u2', Username: 'b@x.com', Name: 'B' },
      ]);
    const r = await checkMfaReadiness('dev');
    expect(r.status).toBe('ok');
    expect(r.findings).toHaveLength(0);
    expect(r.summary).toMatch(/July 2026/);
  });

  it('flags unregistered users and TOTP-only users with distinct details', async () => {
    query
      .mockResolvedValueOnce([
        { UserId: 'u1', HasTotp: true, HasU2F: false, HasBuiltInAuthenticator: false, HasSalesforceAuthenticator: false },
        { UserId: 'u3', HasTotp: false, HasU2F: true, HasBuiltInAuthenticator: false, HasSalesforceAuthenticator: false },
      ])
      .mockResolvedValueOnce([
        { Id: 'u1', Username: 'totp@x.com', Name: 'Totp Only' },
        { Id: 'u2', Username: 'none@x.com', Name: 'No Mfa' },
        { Id: 'u3', Username: 'key@x.com', Name: 'Key User' },
      ]);
    const r = await checkMfaReadiness('dev');
    expect(r.status).toBe('warn');
    expect(r.findings).toHaveLength(2);
    expect(r.findings.find((f) => f.username === 'none@x.com').detail).toMatch(/No MFA method/);
    expect(r.findings.find((f) => f.username === 'totp@x.com').detail).toMatch(/non-phishing-resistant/);
    expect(r.summary).toMatch(/phishing-resistant MFA enforcement \(July 2026\)/);
  });

  it('aggregates multiple method rows per user', async () => {
    query
      .mockResolvedValueOnce([
        { UserId: 'u1', HasTotp: true, HasU2F: false, HasBuiltInAuthenticator: false, HasSalesforceAuthenticator: false },
        { UserId: 'u1', HasTotp: false, HasU2F: true, HasBuiltInAuthenticator: false, HasSalesforceAuthenticator: false },
      ])
      .mockResolvedValueOnce([{ Id: 'u1', Username: 'a@x.com', Name: 'A' }]);
    const r = await checkMfaReadiness('dev');
    expect(r.status).toBe('ok');
  });

  it('degrades to warn (not error) when TwoFactorMethodsInfo is not queryable', async () => {
    query.mockRejectedValueOnce(new Error("sObject type 'TwoFactorMethodsInfo' is not supported"));
    const r = await checkMfaReadiness('dev');
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/unavailable/);
    expect(r.findings).toEqual([]);
  });
});

describe('checkSoapLogins', () => {
  it('flags SOAP login() traffic in the retiring 31.0-64.0 band, aggregated per client', async () => {
    query.mockResolvedValueOnce([
      { UserId: 'u1', LoginTime: '2026-06-20T00:00:00Z', ApiType: 'SOAP Partner', ApiVersion: '54.0', Application: 'DataLoader' },
      { UserId: 'u1', LoginTime: '2026-06-21T00:00:00Z', ApiType: 'SOAP Partner', ApiVersion: '54.0', Application: 'DataLoader' },
      { UserId: 'u2', LoginTime: '2026-06-19T00:00:00Z', ApiType: 'SOAP Enterprise', ApiVersion: '31.0', Application: 'LegacyBot' },
    ]);
    const r = await checkSoapLogins('dev', { lookbackDays: 30 });
    expect(r.status).toBe('warn');
    expect(r.findings).toHaveLength(2);
    const dl = r.findings.find((f) => f.application === 'DataLoader');
    expect(dl).toMatchObject({ userId: 'u1', apiVersion: 54, logins: 2, lastLogin: '2026-06-21T00:00:00Z' });
    expect(r.summary).toMatch(/SOAP login\(\)/);
    expect(r.summary).toMatch(/31\.0–64\.0/);
  });

  it('ignores SOAP logins outside the retirement band', async () => {
    query.mockResolvedValueOnce([
      { UserId: 'u1', LoginTime: '2026-06-20T00:00:00Z', ApiType: 'SOAP Partner', ApiVersion: '65.0', Application: 'Modern' },
      { UserId: 'u2', LoginTime: '2026-06-20T00:00:00Z', ApiType: 'SOAP Partner', ApiVersion: '30.0', Application: 'Ancient' },
    ]);
    const r = await checkSoapLogins('dev');
    expect(r.status).toBe('ok');
    expect(r.findings).toHaveLength(0);
    expect(r.summary).toMatch(/No SOAP login\(\)/);
  });

  it('is ok when there is no SOAP traffic at all', async () => {
    query.mockResolvedValueOnce([]);
    const r = await checkSoapLogins('dev');
    expect(r.status).toBe('ok');
  });

  it('degrades to warn (not error) when LoginHistory is not accessible', async () => {
    query.mockRejectedValueOnce(new Error('INSUFFICIENT_ACCESS: LoginHistory'));
    const r = await checkSoapLogins('dev');
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/unavailable/);
  });

  it('degrades to warn on a non-numeric configured lookback', async () => {
    const r = await checkSoapLogins('dev', { lookbackDays: 'soon' });
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/must be a number/);
    expect(query).not.toHaveBeenCalled();
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
  it('aggregates deprecated classes, triggers, and flows with below-floor reasons', async () => {
    detectOrgRelease.mockResolvedValueOnce(null);
    query
      .mockResolvedValueOnce([{ Name: 'OldClass', ApiVersion: 30 }]) // ApexClass
      .mockResolvedValueOnce([{ Name: 'OldTrigger', ApiVersion: 28 }]) // ApexTrigger
      .mockResolvedValueOnce([{ Definition: { DeveloperName: 'Old_Flow' }, ApiVersion: 33 }]); // Flow
    const r = await checkApiVersions('dev', { minApiVersion: 45 });
    expect(r.status).toBe('warn');
    expect(r.findings).toHaveLength(3);
    expect(r.findings.map((f) => f.type)).toEqual(['ApexClass', 'ApexTrigger', 'Flow']);
    expect(r.findings.every((f) => f.reason === 'below-floor')).toBe(true);
    expect(r.summary).toContain('below API v45');
  });

  it('adds the org ceiling to the summary when detectable', async () => {
    detectOrgRelease.mockResolvedValueOnce({ release: "Summer '26", apiVersion: 67, preview: false });
    query.mockResolvedValue([]);
    const r = await checkApiVersions('dev', { minApiVersion: 45 });
    expect(r.status).toBe('ok');
    expect(r.summary).toContain("org max: v67, Summer '26");
  });

  it('raises the floor to ceiling - warnBehind and tags behind-ceiling findings', async () => {
    detectOrgRelease.mockResolvedValueOnce({ release: "Summer '26", apiVersion: 67, preview: false });
    query
      .mockResolvedValueOnce([{ Name: 'Lagging', ApiVersion: 58 }]) // ApexClass: >= minApi, < 67-5=62
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const r = await checkApiVersions('dev', { minApiVersion: 45, warnBehind: 5 });
    expect(r.status).toBe('warn');
    expect(r.findings[0]).toMatchObject({ name: 'Lagging', reason: 'behind-ceiling' });
    expect(r.summary).toContain('below API v62');
    // the effective floor reached the queries too
    expect(query.mock.calls[0][1]).toContain('ApiVersion < 62');
  });

  it('warnBehind without a detectable ceiling falls back to the plain floor', async () => {
    detectOrgRelease.mockResolvedValueOnce(null);
    query.mockResolvedValue([]);
    const r = await checkApiVersions('dev', { minApiVersion: 45, warnBehind: 5 });
    expect(r.status).toBe('ok');
    expect(query.mock.calls[0][1]).toContain('ApiVersion < 45');
  });

  it('degrades to an Apex-only result when the Flow query is rejected', async () => {
    detectOrgRelease.mockResolvedValueOnce(null);
    query.mockImplementation(async (org, soql) => {
      if (soql.includes('FROM ApexClass')) return [{ Name: 'OldClass', ApiVersion: 30 }];
      if (soql.includes('FROM Flow')) throw new Error('sObject type Flow is not supported');
      return [];
    });
    const r = await checkApiVersions('dev', { minApiVersion: 45 });
    expect(r.status).toBe('warn'); // never errors the whole check
    expect(r.findings).toHaveLength(1);
    // Only the type that actually failed is named — LWC/Aura succeeded.
    expect(r.summary).toContain('Flow not queryable on this org');
    expect(r.summary).not.toContain('LWC');
  });

  it('reports below-floor LWC and Aura bundles alongside Apex and Flows', async () => {
    detectOrgRelease.mockResolvedValueOnce(null);
    query.mockImplementation(async (org, soql) => {
      if (soql.includes('FROM ApexClass')) return [{ Name: 'OldClass', ApiVersion: 30 }];
      if (soql.includes('LightningComponentBundle')) return [{ DeveloperName: 'oldCmp', ApiVersion: 41 }];
      if (soql.includes('AuraDefinitionBundle')) return [{ DeveloperName: 'oldAura', ApiVersion: 40 }];
      return [];
    });
    const r = await checkApiVersions('dev', { minApiVersion: 45 });
    expect(r.status).toBe('warn');
    // Apex first, then the optional types in declaration order.
    expect(r.findings.map((f) => [f.type, f.name])).toEqual([
      ['ApexClass', 'OldClass'],
      ['LWC', 'oldCmp'],
      ['Aura', 'oldAura'],
    ]);
    expect(r.summary).toContain('3 component(s) below API v45');
    expect(r.summary).not.toContain('not queryable');
  });

  it('degrades each optional type independently', async () => {
    detectOrgRelease.mockResolvedValueOnce(null);
    query.mockImplementation(async (org, soql) => {
      if (soql.includes('AuraDefinitionBundle')) throw new Error('no aura');
      if (soql.includes('LightningComponentBundle')) throw new Error('no lwc');
      return [];
    });
    const r = await checkApiVersions('dev', { minApiVersion: 45 });
    expect(r.status).toBe('ok');
    // Named in declaration order regardless of which rejected first.
    expect(r.summary).toContain('LWC/Aura not queryable on this org');
  });

  it('a detectOrgRelease failure never affects the result', async () => {
    detectOrgRelease.mockRejectedValueOnce(new Error('no sf api request on this CLI'));
    query.mockResolvedValue([]);
    const r = await checkApiVersions('dev', { minApiVersion: 45 });
    expect(r.status).toBe('ok');
    expect(r.summary).not.toContain('org max');
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

  it('recommends External Client Apps migration whenever connected apps exist (additive, status unchanged)', async () => {
    query.mockResolvedValueOnce([
      { Name: 'Open App', OptionsAllowAdminApprovedUsersOnly: false },
      { Name: 'Locked App', OptionsAllowAdminApprovedUsersOnly: true },
    ]);
    const r = await checkConnectedApps('dev', { flagPermissive: true });
    expect(r.status).toBe('warn'); // banding unchanged
    expect(r.summary).toMatch(/External Client Apps/);
    expect(r.findings[0].recommendation).toMatch(/External Client App/);

    // Locked-only org: status stays ok, note still present.
    query.mockResolvedValueOnce([{ Name: 'Locked App', OptionsAllowAdminApprovedUsersOnly: true }]);
    const r2 = await checkConnectedApps('dev', { flagPermissive: true });
    expect(r2.status).toBe('ok');
    expect(r2.summary).toMatch(/External Client Apps/);
  });

  it('omits the migration note when the org has no connected apps', async () => {
    query.mockResolvedValueOnce([]);
    const r = await checkConnectedApps('dev', { flagPermissive: true });
    expect(r.status).toBe('ok');
    expect(r.summary).not.toMatch(/External Client Apps/);
  });

  it('degrades to warn (not error) when the query is rejected', async () => {
    query.mockRejectedValueOnce(new Error('No such column'));
    const r = await checkConnectedApps('dev');
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/unavailable/);
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

  it('degrades to warn (not error) when the Beta dependency API is rejected', async () => {
    query.mockRejectedValueOnce(new Error('MetadataComponentDependency is not supported'));
    const r = await checkApexUnreferenced('dev');
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/unavailable/);
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

describe('checkInactiveValidations', () => {
  it('flags inactive validation rules with object qualifier', async () => {
    query.mockResolvedValueOnce([
      { ValidationName: 'Rule1', EntityDefinition: { QualifiedApiName: 'Account' } },
      { ValidationName: 'Rule2', EntityDefinition: { QualifiedApiName: 'My__c' } },
    ]);
    const r = await checkInactiveValidations('dev');
    expect(r.status).toBe('warn');
    expect(r.findings.map((f) => f.name)).toEqual(['Account.Rule1', 'My__c.Rule2']);
  });

  it('is ok when all validation rules are active', async () => {
    query.mockResolvedValueOnce([]);
    const r = await checkInactiveValidations('dev');
    expect(r.status).toBe('ok');
  });

  it('degrades to warn when ValidationRule is not queryable', async () => {
    query.mockRejectedValueOnce(new Error('No such column Active'));
    const r = await checkInactiveValidations('dev');
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/unavailable/);
  });
});

describe('checkInactiveWorkflows', () => {
  it('flags inactive workflow rules', async () => {
    query.mockResolvedValueOnce([{ Name: 'WF1', TableEnumOrId: 'Account', Active: false }]);
    const r = await checkInactiveWorkflows('dev');
    expect(r.status).toBe('warn');
    expect(r.findings[0].name).toBe('Account.WF1');
  });

  it('reports ok (not warn) when the org has no workflow feature', async () => {
    query.mockRejectedValueOnce(new Error('INVALID_TYPE: Cannot use: WorkflowRule in this organization'));
    const r = await checkInactiveWorkflows('dev');
    expect(r.status).toBe('ok');
    expect(r.summary).toMatch(/No workflow rules/);
  });

  it('degrades to warn on other query errors', async () => {
    query.mockRejectedValueOnce(new Error('No such column Active on WorkflowRule'));
    const r = await checkInactiveWorkflows('dev');
    expect(r.status).toBe('warn');
  });
});

describe('checkLintAccessFields', () => {
  it('flags custom fields with no Read grant', async () => {
    query.mockResolvedValueOnce([
      { Field: 'Account.Visible__c', PermissionsRead: true },
      { Field: 'Account.Visible__c', PermissionsRead: false },
      { Field: 'Account.Hidden__c', PermissionsRead: false },
      { Field: 'Account.Industry', PermissionsRead: false }, // standard field ignored
    ]);
    const r = await checkLintAccessFields('dev');
    expect(r.status).toBe('warn');
    expect(r.findings.map((f) => f.name)).toEqual(['Account.Hidden__c']);
  });

  it('is ok when there are no custom-field permission entries', async () => {
    query.mockResolvedValueOnce([{ Field: 'Account.Industry', PermissionsRead: true }]);
    const r = await checkLintAccessFields('dev');
    expect(r.status).toBe('ok');
  });

  it('degrades to warn on query error', async () => {
    query.mockRejectedValueOnce(new Error('boom'));
    const r = await checkLintAccessFields('dev');
    expect(r.status).toBe('warn');
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

// ---------------------------------------------------------------------------
// Setup Audit Trail: classification, velocity, truncation honesty
// ---------------------------------------------------------------------------

describe('classifyAuditAction', () => {
  it('rates identity and access changes critical', () => {
    for (const action of [
      'changedpasswordpolicy', 'changedsessionsettings', 'manageipranges',
      'suOrgAdminLogin', 'changedProfile', 'PermSetAssign', 'connectedapp',
      'namedcredential', 'certificate',
    ]) {
      expect(classifyAuditAction({ Action: action })?.severity, action).toBe('critical');
    }
  });

  it('rates routine-but-notable changes elevated', () => {
    for (const action of ['deleted', 'frozeUser', 'deactivateuser', 'resetpassword']) {
      expect(classifyAuditAction({ Action: action })?.severity, action).toBe('elevated');
    }
  });

  it('prefers the more specific match — a policy change is not just a password change', () => {
    const c = classifyAuditAction({ Action: 'changedpasswordpolicy' });
    expect(c).toEqual({ severity: 'critical', category: 'Password policy' });
  });

  it('matches on Section as well as Action, case-insensitively', () => {
    expect(classifyAuditAction({ Action: 'x', Section: 'Certificate and Key Management' })?.category)
      .toBe('Certificate or key');
  });

  it('returns null for benign rows and tolerates empty ones', () => {
    expect(classifyAuditAction({ Action: 'changedLayout', Section: 'Page Layouts' })).toBeNull();
    expect(classifyAuditAction({})).toBeNull();
    expect(classifyAuditAction(null)).toBeNull();
  });
});

describe('detectVelocityAnomalies', () => {
  const NOW = Date.parse('2026-08-22T12:00:00Z');
  const opts = { now: NOW, lookbackDays: 30, windowHours: 24, factor: 3, minEvents: 10 };
  const rowsAt = (user, count, hoursAgo) =>
    Array.from({ length: count }, () => ({
      CreatedBy: { Name: user },
      CreatedDate: new Date(NOW - hoursAgo * 3600_000).toISOString(),
    }));

  it('flags a user well above their own baseline, reporting both rates', () => {
    const rows = [...rowsAt('Mallory', 40, 2), ...rowsAt('Mallory', 29, 24 * 10)];
    const [a] = detectVelocityAnomalies(rows, opts);
    expect(a.user).toBe('Mallory');
    expect(a.observed).toBe(40);
    // 40/day observed against ~1/day baseline.
    expect(a.baselinePerDay).toBeCloseTo(1, 1);
    expect(a.ratio).toBeGreaterThanOrEqual(3);
  });

  it('does not flag a small absolute burst — 1 to 3 changes is not an incident', () => {
    const rows = [...rowsAt('Quiet', 3, 2), ...rowsAt('Quiet', 29, 24 * 10)];
    expect(detectVelocityAnomalies(rows, opts)).toEqual([]);
  });

  it('does not flag a first-seen user — no baseline is not a spike', () => {
    const rows = rowsAt('Newcomer', 50, 2);
    expect(detectVelocityAnomalies(rows, opts)).toEqual([]);
  });

  it('leaves a steady heavy user alone', () => {
    // 20/day now, ~20/day for the previous 29 days.
    const rows = [...rowsAt('Busy', 20, 2), ...rowsAt('Busy', 580, 24 * 10)];
    expect(detectVelocityAnomalies(rows, opts)).toEqual([]);
  });

  it('attributes delegated (Login-As) work to the delegate', () => {
    const rows = [
      ...Array.from({ length: 40 }, () => ({
        DelegateUser: 'contractor@x.com',
        CreatedDate: new Date(NOW - 2 * 3600_000).toISOString(),
      })),
      ...Array.from({ length: 29 }, () => ({
        DelegateUser: 'contractor@x.com',
        CreatedDate: new Date(NOW - 240 * 3600_000).toISOString(),
      })),
    ];
    expect(detectVelocityAnomalies(rows, opts)[0].user).toBe('contractor@x.com');
  });

  it('ignores rows with an unparseable date rather than throwing', () => {
    const rows = [{ CreatedBy: { Name: 'X' }, CreatedDate: 'not-a-date' }, ...rowsAt('X', 40, 2), ...rowsAt('X', 29, 240)];
    expect(() => detectVelocityAnomalies(rows, opts)).not.toThrow();
    expect(detectVelocityAnomalies(rows, opts)[0].observed).toBe(40);
  });

  it('sorts the loudest spike first', () => {
    const rows = [
      ...rowsAt('Small', 12, 2), ...rowsAt('Small', 90, 240),
      ...rowsAt('Huge', 60, 2), ...rowsAt('Huge', 29, 240),
    ];
    const out = detectVelocityAnomalies(rows, opts);
    expect(out[0].user).toBe('Huge');
  });
});

describe('checkAuditTrail severity and truncation', () => {
  const row = (over) => ({
    Action: 'changedLayout', Section: 'Page Layouts',
    CreatedDate: new Date().toISOString(), CreatedBy: { Name: 'Admin' }, ...over,
  });

  it('FAILS on a critical change, so it gates CI and clears the notify threshold', async () => {
    query.mockResolvedValueOnce([row({ Action: 'changedpasswordpolicy' })]);
    const r = await checkAuditTrail('dev');
    expect(r.status).toBe('fail');
    expect(r.findings[0].severity).toBe('critical');
    expect(r.findings[0].category).toBe('Password policy');
    expect(r.summary).toMatch(/1 critical/);
  });

  it('only warns when everything found is elevated', async () => {
    query.mockResolvedValueOnce([row({ Action: 'deleted' })]);
    const r = await checkAuditTrail('dev');
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/1 elevated/);
  });

  it('fails on a velocity anomaly even with no suspect action at all', async () => {
    const now = Date.now();
    const rows = [
      ...Array.from({ length: 40 }, () => row({ CreatedDate: new Date(now - 3600_000).toISOString() })),
      ...Array.from({ length: 29 }, () => row({ CreatedDate: new Date(now - 240 * 3600_000).toISOString() })),
    ];
    query.mockResolvedValueOnce(rows);
    const r = await checkAuditTrail('dev');
    expect(r.status).toBe('fail');
    const anomaly = r.findings.find((f) => f.anomaly === 'velocity');
    expect(anomaly.user).toBe('Admin');
    expect(anomaly.ratio).toBeGreaterThanOrEqual(3);
    expect(r.summary).toMatch(/above 3× their own baseline/);
  });

  it('reports truncation instead of presenting a partial scan as clean', async () => {
    query.mockResolvedValueOnce(Array.from({ length: 5 }, () => row()));
    const r = await checkAuditTrail('dev', { maxRows: 5 });
    expect(r.summary).toMatch(/TRUNCATED at 5 rows/);
    // The baseline half is exactly what a truncated window loses, so velocity
    // must not be claimed off it.
    expect(r.summary).toMatch(/velocity was skipped/);
    expect(r.findings.some((f) => f.anomaly === 'velocity')).toBe(false);
  });

  it('puts the row cap into the query', async () => {
    query.mockResolvedValueOnce([]);
    await checkAuditTrail('dev', { maxRows: 1234 });
    expect(query.mock.calls[0][1]).toContain('LIMIT 1234');
  });
});
