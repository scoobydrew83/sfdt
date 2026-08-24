import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

vi.mock('../../src/lib/org-query.js', () => ({ query: vi.fn() }));

import { query } from '../../src/lib/org-query.js';
import {
  parsePermissionXml,
  resolveUserParents,
  runPermissionMatrix,
  runOfflinePermissionMatrix,
  comparePermissionSets,
} from '../../src/lib/permissions-runner.js';

// The model is flow-core's and tested there. What is asserted here is what this
// layer decides: the two-hop group walk (skipping it silently loses every grant
// a group carries), the repo parse, and a drift comparison that never invents a
// match between an org id and a filename.

let root;
let config;

const write = async (rel, body) => {
  const file = path.join(root, rel);
  await fs.ensureDir(path.dirname(file));
  await fs.writeFile(file, body, 'utf8');
};

const permXml = (object, fields, objectFlags = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
  <objectPermissions>
    <object>${object}</object>
    <allowRead>${objectFlags.read ? 'true' : 'false'}</allowRead>
    <allowEdit>${objectFlags.edit ? 'true' : 'false'}</allowEdit>
  </objectPermissions>
${fields
  .map(
    (f) => `  <fieldPermissions>
    <field>${object}.${f.name}</field>
    <readable>${f.readable ? 'true' : 'false'}</readable>
    <editable>${f.editable ? 'true' : 'false'}</editable>
  </fieldPermissions>`,
  )
  .join('\n')}
</PermissionSet>`;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-perms-'));
  config = { _projectRoot: root, defaultSourcePath: 'force-app/main/default' };
  vi.mocked(query).mockReset().mockResolvedValue([]);
});

afterEach(async () => {
  await fs.remove(root);
});

describe('parsePermissionXml', () => {
  it('reads field and object grants for the requested object only', () => {
    const xml = permXml('Account', [{ name: 'Region__c', readable: true, editable: true }], { read: true });
    const { fields, objectGrant } = parsePermissionXml(xml, 'Account');

    expect(fields).toEqual({ Region__c: 'edit' });
    expect(objectGrant).toMatchObject({ read: true, edit: false });
  });

  it('ignores another object entirely', () => {
    const xml = permXml('Contact', [{ name: 'Region__c', readable: true }]);
    expect(parsePermissionXml(xml, 'Account')).toEqual({ fields: {}, objectGrant: null });
  });

  it('treats editable as implying read', () => {
    const xml = permXml('Account', [{ name: 'X__c', readable: false, editable: true }]);
    expect(parsePermissionXml(xml, 'Account').fields.X__c).toBe('edit');
  });

  it('does not throw on an unrelated file', () => {
    expect(() => parsePermissionXml('<Profile></Profile>', 'Account')).not.toThrow();
  });
});

describe('resolveUserParents', () => {
  it('walks permission set GROUPS to their member sets', async () => {
    // Skipping the second hop would silently drop every grant a group carries —
    // and groups are where large orgs put most of their access, so the answer
    // would look plausible and be badly incomplete.
    vi.mocked(query).mockImplementation(async (_org, soql) => {
      if (/PermissionSetAssignment/.test(soql)) {
        return [
          { PermissionSetId: '0PS_direct' },
          { PermissionSetGroupId: '0PG1', PermissionSetGroup: { DeveloperName: 'Sales_Bundle' } },
        ];
      }
      if (/PermissionSetGroupComponent/.test(soql)) return [{ PermissionSetId: '0PS_from_group' }];
      return [];
    });

    const { parentIds, notes } = await resolveUserParents('dev', 'ana@example.com');
    expect([...parentIds].sort()).toEqual(['0PS_direct', '0PS_from_group']);
    // And says so, naming the group, because a group is where muting lives.
    expect(notes.some((n) => n.includes('Sales_Bundle'))).toBe(true);
    expect(notes.some((n) => n.includes('MUTING'))).toBe(true);
  });

  it('reports a failed group hop as MISSING data, not as an empty group', async () => {
    vi.mocked(query).mockImplementation(async (_org, soql) => {
      if (/PermissionSetAssignment/.test(soql)) return [{ PermissionSetGroupId: '0PG1' }];
      throw new Error('QUERY_TIMEOUT');
    });

    const { notes } = await resolveUserParents('dev', 'ana@example.com');
    expect(notes.some((n) => n.includes('MISSING from this result'))).toBe(true);
  });

  it('errors clearly on an unknown username instead of returning an empty matrix', async () => {
    // Every active user has at least their profile's implicit set, so zero
    // assignments means the username is wrong — a much more useful thing to say
    // than "this user has no access".
    vi.mocked(query).mockResolvedValue([]);
    await expect(resolveUserParents('dev', 'typo@example.com')).rejects.toThrow(/Check the username/);
  });
});

describe('runPermissionMatrix --user', () => {
  it('narrows the matrix to the resolved parents and labels the scope', async () => {
    vi.mocked(query).mockImplementation(async (_org, soql) => {
      if (/PermissionSetAssignment/.test(soql)) return [{ PermissionSetId: '0PS2' }];
      if (/FROM ObjectPermissions/.test(soql)) {
        return [
          { ParentId: '0PS1', Parent: { IsOwnedByProfile: true, Profile: { Name: 'Admin' } }, PermissionsRead: true },
          { ParentId: '0PS2', Parent: { IsOwnedByProfile: false, Label: 'Sales Ops' }, PermissionsRead: true },
        ];
      }
      return [];
    });

    const vm = await runPermissionMatrix('dev', 'Account', { user: 'ana@example.com' });
    expect(vm.parents.map((p) => p.id)).toEqual(['0PS2']);
    expect(vm.user).toBe('ana@example.com');
    expect(vm.notes.some((n) => n.includes('Scoped to ana@example.com'))).toBe(true);
  });
});

describe('runOfflinePermissionMatrix', () => {
  beforeEach(async () => {
    const base = 'force-app/main/default';
    await write(
      `${base}/profiles/Admin.profile-meta.xml`,
      permXml('Account', [{ name: 'Region__c', readable: true, editable: true }], { read: true, edit: true }),
    );
    await write(
      `${base}/permissionsets/Sales_Ops.permissionset-meta.xml`,
      permXml('Account', [{ name: 'Region__c', readable: true }]),
    );
    // Mentions a different object only — must not become a column.
    await write(
      `${base}/permissionsets/Unrelated.permissionset-meta.xml`,
      permXml('Contact', [{ name: 'X__c', readable: true }]),
    );
  });

  it('builds the matrix from source with no org call at all', async () => {
    const vm = await runOfflinePermissionMatrix(config, 'Account');

    expect(query).not.toHaveBeenCalled();
    expect(vm.parents.map((p) => p.label)).toEqual(['Admin', 'Sales_Ops']);
    expect(vm.fields.find((f) => f.field === 'Region__c').granted).toBe('edit');
  });

  it('excludes a file that never mentions the object', async () => {
    // Including it would fill the matrix with empty rows that read as "denied".
    const vm = await runOfflinePermissionMatrix(config, 'Account');
    expect(vm.parents.map((p) => p.label)).not.toContain('Unrelated');
  });

  it('states that source is only what is COMMITTED', async () => {
    const vm = await runOfflinePermissionMatrix(config, 'Account');
    expect(vm.notes.some((n) => n.includes('may carry grants that were never put in the repo'))).toBe(true);
    expect(vm.notes.some((n) => n.includes('Muting permission sets'))).toBe(true);
  });

  it('says so plainly when no file mentions the object', async () => {
    const vm = await runOfflinePermissionMatrix(config, 'Opportunity');
    expect(vm.parents).toEqual([]);
    expect(vm.notes.some((n) => n.includes('a fact about the repository'))).toBe(true);
  });
});

describe('comparePermissionSets', () => {
  const vm = (parents, fields) => ({ object: 'Account', parents, fields });

  it('flags a grant present in the org but absent from source', async () => {
    // The verdict a security review actually cares about.
    const org = vm(
      [{ id: '0PS1', label: 'Sales Ops', isProfile: false }],
      [{ field: 'Secret__c', byParent: { '0PS1': 'edit' }, granted: 'edit' }],
    );
    const repo = vm(
      [{ id: 'permset:Sales Ops', label: 'Sales Ops', isProfile: false }],
      [{ field: 'Secret__c', byParent: {}, granted: 'none' }],
    );

    const drift = comparePermissionSets(org, repo);
    expect(drift.rows[0]).toMatchObject({ parent: 'Sales Ops', field: 'Secret__c', verdict: 'extra-in-org' });
    expect(drift.counts.extraInOrg).toBe(1);
  });

  it('flags a grant declared in source but missing from the org', () => {
    const org = vm([{ id: '0PS1', label: 'Sales Ops', isProfile: false }], []);
    const repo = vm(
      [{ id: 'permset:Sales Ops', label: 'Sales Ops', isProfile: false }],
      [{ field: 'Region__c', byParent: { 'permset:Sales Ops': 'read' }, granted: 'read' }],
    );
    expect(comparePermissionSets(org, repo).rows[0].verdict).toBe('missing-in-org');
  });

  it('reports a parent present on one side only, rather than dropping it', () => {
    // The org knows parents by id and the repo by filename, so they can only be
    // matched on label — a real limitation that must be visible.
    const drift = comparePermissionSets(
      vm([{ id: '0PS1', label: 'Only In Org', isProfile: false }], []),
      vm([{ id: 'permset:Only In Repo', label: 'Only In Repo', isProfile: false }], []),
    );
    const verdicts = drift.rows.map((r) => r.verdict).sort();
    expect(verdicts).toEqual(['only-in-org', 'only-in-repo']);
    expect(drift.counts.unmatchedParents).toBe(2);
    expect(drift.notes.some((n) => n.includes('matched by LABEL'))).toBe(true);
  });

  it('reports no rows when the two sides agree', () => {
    const drift = comparePermissionSets(
      vm([{ id: '0PS1', label: 'Sales Ops', isProfile: false }],
        [{ field: 'Region__c', byParent: { '0PS1': 'read' }, granted: 'read' }]),
      vm([{ id: 'permset:Sales Ops', label: 'Sales Ops', isProfile: false }],
        [{ field: 'Region__c', byParent: { 'permset:Sales Ops': 'read' }, granted: 'read' }]),
    );
    expect(drift.rows).toEqual([]);
    expect(drift.counts.total).toBe(0);
  });

  it('names a changed grant as changed, not as extra or missing', () => {
    const drift = comparePermissionSets(
      vm([{ id: '0PS1', label: 'Sales Ops', isProfile: false }],
        [{ field: 'Region__c', byParent: { '0PS1': 'edit' }, granted: 'edit' }]),
      vm([{ id: 'permset:Sales Ops', label: 'Sales Ops', isProfile: false }],
        [{ field: 'Region__c', byParent: { 'permset:Sales Ops': 'read' }, granted: 'read' }]),
    );
    expect(drift.rows[0]).toMatchObject({ verdict: 'changed', org: 'edit', repo: 'read' });
  });
});
