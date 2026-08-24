import { describe, it, expect } from 'vitest';
import {
  objectPermissionsQuery,
  fieldPermissionsQuery,
  userAssignmentsQuery,
  groupComponentsQuery,
  unqualifyField,
  grantFromFlags,
  maxGrant,
  unionObjectGrants,
  parentFromRow,
  buildPermissionMatrix,
  MUTING_NOTE,
  NO_OBJECT_GRANT,
  type PermissionQueries,
} from '../src/permissions.js';
import { describeFinding } from '../src/health-findings.js';

// The failure this module is shaped against is not a crash — it is a confident
// number that is too HIGH. Muting permission sets subtract access and cannot be
// queried, so a union of grants is an upper bound. Most of what follows checks
// that the answer never claims otherwise, and that the queries carry the parent
// axis the existing audit checks throw away.

function fakeQueries(handlers: Array<[RegExp, unknown[] | Error]>): PermissionQueries & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    async query<T>(soql: string): Promise<{ records: T[] }> {
      seen.push(soql);
      for (const [pattern, response] of handlers) {
        if (pattern.test(soql)) {
          if (response instanceof Error) throw response;
          return { records: response as T[] };
        }
      }
      return { records: [] };
    },
  };
}

const profileRow = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  ParentId: id,
  Parent: { IsOwnedByProfile: true, Label: 'X00e-internal', Profile: { Name: name } },
  ...extra,
});

const permsetRow = (id: string, label: string, extra: Record<string, unknown> = {}) => ({
  ParentId: id,
  Parent: { IsOwnedByProfile: false, Label: label },
  ...extra,
});

describe('query builders', () => {
  it('scope every query to ONE object', () => {
    // A bare `SELECT … FROM FieldPermissions` is 100k–1M rows through sf stdout
    // into JSON.parse. Scoping makes the matrix bounded by construction rather
    // than by a cap that has to be explained.
    expect(objectPermissionsQuery('Account')).toContain("WHERE SobjectType = 'Account'");
    expect(fieldPermissionsQuery('Account')).toContain("WHERE SobjectType = 'Account'");
  });

  it('select the parent axis the existing audit checks drop', () => {
    // checkLintAccess selects SobjectType + PermissionsRead only, so it can
    // answer "does ANYONE have read?" and nothing else. A matrix needs ParentId.
    for (const q of [objectPermissionsQuery('Account'), fieldPermissionsQuery('Account')]) {
      expect(q).toContain('ParentId');
      expect(q).toContain('Parent.IsOwnedByProfile');
    }
    expect(objectPermissionsQuery('Account')).toContain('PermissionsEdit');
  });

  it('escape the object name', () => {
    expect(fieldPermissionsQuery("Acc'ount")).toContain("\\'");
    expect(userAssignmentsQuery("o'brien@x.com")).toContain("\\'");
    expect(groupComponentsQuery(["0PG'1"])).toContain("\\'");
  });
});

describe('the fold', () => {
  it('treats edit as implying read', () => {
    // A parent that can write a field can necessarily see it; reporting edit
    // without read would produce impossible cells.
    expect(grantFromFlags(false, true)).toBe('edit');
    expect(grantFromFlags(true, false)).toBe('read');
    expect(grantFromFlags(false, false)).toBe('none');
  });

  it('accepts the string booleans a JSON envelope may carry', () => {
    expect(grantFromFlags('true', 'false')).toBe('read');
  });

  it('takes the stronger of two grants', () => {
    expect(maxGrant('read', 'edit')).toBe('edit');
    expect(maxGrant('edit', 'none')).toBe('edit');
    expect(maxGrant('none', 'none')).toBe('none');
  });

  it('unions object grants across parents', () => {
    const a = { ...NO_OBJECT_GRANT, read: true };
    const b = { ...NO_OBJECT_GRANT, edit: true, delete: true };
    expect(unionObjectGrants([a, b])).toMatchObject({ read: true, edit: true, delete: true, create: false });
    expect(unionObjectGrants([])).toEqual(NO_OBJECT_GRANT);
  });

  it('unqualifies the Field column', () => {
    expect(unqualifyField('Account.Region__c')).toBe('Region__c');
    expect(unqualifyField('Region__c')).toBe('Region__c');
  });
});

describe('parentFromRow', () => {
  it("uses a profile's NAME, not its implicit permission set's internal label", () => {
    // Parent.Label for a profile's implicit set is an internal string; a matrix
    // whose columns are those is unreadable.
    expect(parentFromRow(profileRow('0PS1', 'System Administrator'))).toEqual({
      id: '0PS1',
      label: 'System Administrator',
      isProfile: true,
    });
  });

  it('uses the label for a real permission set', () => {
    expect(parentFromRow(permsetRow('0PS2', 'Sales Ops'))).toMatchObject({
      label: 'Sales Ops',
      isProfile: false,
    });
  });

  it('returns null for a row with no parent id', () => {
    expect(parentFromRow({})).toBeNull();
  });
});

describe('buildPermissionMatrix', () => {
  const OBJ = [
    profileRow('0PS1', 'System Administrator', { PermissionsRead: true, PermissionsEdit: true }),
    permsetRow('0PS2', 'Sales Ops', { PermissionsRead: true }),
  ];
  const FLD = [
    { ...profileRow('0PS1', 'System Administrator'), Field: 'Account.Region__c', PermissionsRead: true, PermissionsEdit: true },
    { ...permsetRow('0PS2', 'Sales Ops'), Field: 'Account.Region__c', PermissionsRead: true, PermissionsEdit: false },
    { ...permsetRow('0PS2', 'Sales Ops'), Field: 'Account.Secret__c', PermissionsRead: false, PermissionsEdit: false },
  ];

  it('builds a per-parent grid and the union across parents', async () => {
    const vm = await buildPermissionMatrix(
      fakeQueries([[/FROM ObjectPermissions/, OBJ], [/FROM FieldPermissions/, FLD]]),
      { object: 'Account' },
    );

    const region = vm.fields.find((f) => f.field === 'Region__c')!;
    expect(region.byParent['0PS1']).toBe('edit');
    expect(region.byParent['0PS2']).toBe('read');
    expect(region.granted).toBe('edit');

    const secret = vm.fields.find((f) => f.field === 'Secret__c')!;
    expect(secret.granted).toBe('none');
    expect(vm.objectGranted).toMatchObject({ read: true, edit: true });
  });

  it('orders profiles before permission sets, for a stable comparable grid', async () => {
    const vm = await buildPermissionMatrix(
      fakeQueries([[/FROM ObjectPermissions/, OBJ], [/FROM FieldPermissions/, FLD]]),
      { object: 'Account' },
    );
    expect(vm.parents.map((p) => p.label)).toEqual(['System Administrator', 'Sales Ops']);
  });

  it('ALWAYS carries the muting caveat', async () => {
    // The one claim that could be wrong, on every single result.
    const vm = await buildPermissionMatrix(fakeQueries([]), { object: 'Account' });
    expect(vm.notes).toContain(MUTING_NOTE);
    expect(MUTING_NOTE).toContain('may be LESS than shown');
  });

  it('never labels any DATA "effective" — only the caveat may say the word', async () => {
    const vm = await buildPermissionMatrix(
      fakeQueries([[/FROM ObjectPermissions/, OBJ], [/FROM FieldPermissions/, FLD]]),
      { object: 'Account' },
    );
    // The notes are excluded on purpose: MUTING_NOTE uses the word precisely to
    // DISCLAIM it ("nothing here is described as effective"). Everywhere else —
    // field names, labels, grant values — it must not appear, because that is
    // where a reader would take it as a claim.
    const { notes, ...data } = vm;
    expect(JSON.stringify(data).toLowerCase()).not.toContain('effective');
    expect(notes.join(' ')).toContain('Nothing here is described as "effective"');
  });

  it('does not read an empty result as "nobody has access"', async () => {
    // Salesforce only stores a permission entry where access differs from the
    // default, so absence is not denial.
    const vm = await buildPermissionMatrix(fakeQueries([]), { object: 'Account' });
    expect(vm.notes.some((n) => n.includes('not a statement that nobody can see'))).toBe(true);
  });

  it('narrows to a parent filter for the per-user path', async () => {
    const vm = await buildPermissionMatrix(
      fakeQueries([[/FROM ObjectPermissions/, OBJ], [/FROM FieldPermissions/, FLD]]),
      { object: 'Account', parentFilter: new Set(['0PS2']) },
    );
    expect(vm.parents.map((p) => p.id)).toEqual(['0PS2']);
    // With the admin profile excluded, the union drops to read.
    expect(vm.fields.find((f) => f.field === 'Region__c')!.granted).toBe('read');
  });

  it('THROWS when a query fails, rather than reporting an empty matrix', async () => {
    // An empty matrix would read as "nobody has access to this object" —
    // materially wrong, not merely partial.
    await expect(
      buildPermissionMatrix(fakeQueries([[/FROM FieldPermissions/, new Error('INSUFFICIENT_ACCESS')]]), {
        object: 'Account',
      }),
    ).rejects.toThrow('INSUFFICIENT_ACCESS');
  });
});

describe('describeFinding — the ordering trap', () => {
  it('renders a permission finding as a permission line, NOT as an inactive user', () => {
    // The chain's `f.username` arm would otherwise turn a finding about ACCESS
    // into a finding about a dormant login. This is why the arm carries an
    // explicit discriminant and sits above it.
    const line = describeFinding({
      permission: 'granted',
      username: 'ana@example.com',
      object: 'Account',
      field: 'Secret__c',
      grant: 'edit',
    });
    expect(line).toBe('ana@example.com grants edit on Account.Secret__c');
    expect(line).not.toContain('last login');
    expect(line).not.toContain('<');
  });

  it('still renders an inactive-user finding the way it always did', () => {
    expect(describeFinding({ username: 'old@example.com', name: 'Old User', lastLogin: '2024-01-01' }))
      .toContain('last login');
  });

  it('falls back to the parent when there is no username', () => {
    expect(describeFinding({ permission: 'granted', parent: 'Sales Ops', object: 'Account', grant: 'read' }))
      .toBe('Sales Ops grants read on Account');
  });
});
