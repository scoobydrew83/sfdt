// Object and field permissions — what is GRANTED, by whom.
//
// ---------------------------------------------------------------------------
// The word this module will not use
// ---------------------------------------------------------------------------
// Not "effective". Never "effective".
//
// A user's real access is the union of what their profile and permission sets
// grant, MINUS whatever a muting permission set inside a permission set group
// takes away. Muting permission sets are **Metadata API only** — there is no
// queryable sObject for them — so a computed union can be MORE PERMISSIVE THAN
// REALITY, and no amount of care with the queries changes that.
//
// A tool that calls that number "effective access" is not slightly imprecise; it
// is wrong in the direction that matters, and wrong in a way the reader cannot
// detect. So this module reports what is **granted**, every result carries the
// bound in words, and the caller is never handed a number that claims more than
// it knows. A competitor claiming "effective" has the identical blind spot plus
// a false label.
//
// ---------------------------------------------------------------------------
// Why every query here is scoped to ONE object
// ---------------------------------------------------------------------------
// `SELECT … FROM FieldPermissions` with no WHERE is 100k–1M rows in a real org,
// funnelled through `sf` stdout into `JSON.parse`. The existing audit checks
// (`checkLintAccess`, `checkLintAccessFields`) do exactly that and are the only
// unbounded queries in the audit runner. Scoping by `SobjectType` makes the
// matrix bounded by construction rather than by a cap that has to be explained.
//
// Those audit checks are also where this module's shape comes from — by
// contrast. They select `PermissionsRead` only, drop `ParentId` entirely, and
// fold everything through an existential OR, so they can answer "does ANYONE
// have read?" and nothing else. A matrix needs the parent axis they discard.

import { escapeSoql } from './dependencies.js';

/** What a parent grants on a field. */
export type FieldGrant = 'none' | 'read' | 'edit';

/** What a parent grants on an object. */
export interface ObjectGrant {
  create: boolean;
  read: boolean;
  edit: boolean;
  delete: boolean;
  viewAll: boolean;
  modifyAll: boolean;
}

export const NO_OBJECT_GRANT: ObjectGrant = {
  create: false,
  read: false,
  edit: false,
  delete: false,
  viewAll: false,
  modifyAll: false,
};

/** A profile or a permission set — the thing a grant hangs off. */
export interface PermissionParent {
  id: string;
  /** `PermissionSet.Label`, or the profile's name. */
  label: string;
  /** True when this PermissionSet is a profile's implicit one. */
  isProfile: boolean;
}

export interface FieldGrantRow {
  field: string;
  /** parent id → grant. Absent means the parent grants nothing on that field. */
  byParent: Record<string, FieldGrant>;
  /** The union across every parent scanned. GRANTED, not effective. */
  granted: FieldGrant;
}

export interface PermissionMatrixVM {
  object: string;
  /** The columns, in a stable order: profiles first, then permission sets. */
  parents: PermissionParent[];
  objectGrants: Record<string, ObjectGrant>;
  /** The union across parents, object level. */
  objectGranted: ObjectGrant;
  fields: FieldGrantRow[];
  counts: { parents: number; fields: number; readable: number; editable: number; noAccess: number };
  notes: string[];
}

// --------------------------------------------------------------------------
// Query builders — all scoped to one object
// --------------------------------------------------------------------------

/**
 * Object-level permissions for one sObject.
 *
 * `ParentId` and `Parent.IsOwnedByProfile` are the two columns the existing
 * audit checks do not select, and they are exactly what turns a yes/no answer
 * into a matrix: the parent is the axis.
 */
export function objectPermissionsQuery(object: string): string {
  return (
    'SELECT ParentId, Parent.Label, Parent.IsOwnedByProfile, Parent.Profile.Name,' +
    ' PermissionsCreate, PermissionsRead, PermissionsEdit, PermissionsDelete,' +
    ' PermissionsViewAllRecords, PermissionsModifyAllRecords' +
    ` FROM ObjectPermissions WHERE SobjectType = '${escapeSoql(object)}'`
  );
}

/**
 * Field-level permissions for one sObject.
 *
 * `Field` is `Object.FieldName`, and `SobjectType` is a real filterable column —
 * so this is bounded by the object, not by a row cap.
 */
export function fieldPermissionsQuery(object: string): string {
  return (
    'SELECT ParentId, Parent.Label, Parent.IsOwnedByProfile, Parent.Profile.Name,' +
    ' Field, PermissionsRead, PermissionsEdit' +
    ` FROM FieldPermissions WHERE SobjectType = '${escapeSoql(object)}'`
  );
}

/** Permission sets (and groups) assigned to one user, plus their profile. */
export function userAssignmentsQuery(username: string): string {
  return (
    'SELECT PermissionSetId, PermissionSet.Label, PermissionSet.IsOwnedByProfile,' +
    ' PermissionSetGroupId, PermissionSetGroup.DeveloperName' +
    ` FROM PermissionSetAssignment WHERE Assignee.Username = '${escapeSoql(username)}'`
  );
}

/**
 * The permission sets that make up a set of permission set groups.
 *
 * Groups are the reason per-user resolution needs a second hop: a user is
 * assigned the GROUP, and the grants live on its member sets.
 */
export function groupComponentsQuery(groupIds: readonly string[]): string {
  const list = groupIds.map((id) => `'${escapeSoql(id)}'`).join(',');
  return (
    'SELECT PermissionSetGroupId, PermissionSetId, PermissionSet.Label' +
    ` FROM PermissionSetGroupComponent WHERE PermissionSetGroupId IN (${list})`
  );
}

// --------------------------------------------------------------------------
// The fold
// --------------------------------------------------------------------------

/** `Account.Region__c` → `Region__c`. FieldPermissions qualifies its Field column. */
export function unqualifyField(field: string): string {
  const dot = field.indexOf('.');
  return dot > 0 ? field.slice(dot + 1) : field;
}

const truthy = (v: unknown): boolean => v === true || v === 'true';

/** Edit implies read — a parent that can write a field can necessarily see it. */
export function grantFromFlags(read: unknown, edit: unknown): FieldGrant {
  if (truthy(edit)) return 'edit';
  if (truthy(read)) return 'read';
  return 'none';
}

/** The stronger of two grants. */
export function maxGrant(a: FieldGrant, b: FieldGrant): FieldGrant {
  const rank = { none: 0, read: 1, edit: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}

export function unionObjectGrants(grants: readonly ObjectGrant[]): ObjectGrant {
  return grants.reduce<ObjectGrant>(
    (acc, g) => ({
      create: acc.create || g.create,
      read: acc.read || g.read,
      edit: acc.edit || g.edit,
      delete: acc.delete || g.delete,
      viewAll: acc.viewAll || g.viewAll,
      modifyAll: acc.modifyAll || g.modifyAll,
    }),
    { ...NO_OBJECT_GRANT },
  );
}

/**
 * Read a parent out of a permission row.
 *
 * A profile's permissions hang off an implicit PermissionSet whose
 * `IsOwnedByProfile` is true; its human name is on `Parent.Profile.Name`, while
 * `Parent.Label` for such a set is an internal string. Using the wrong one gives
 * a matrix whose columns nobody recognises.
 */
export function parentFromRow(row: Record<string, unknown>): PermissionParent | null {
  const id = typeof row.ParentId === 'string' ? row.ParentId : null;
  if (!id) return null;
  const parent = (row.Parent ?? {}) as Record<string, unknown>;
  const isProfile = truthy(parent.IsOwnedByProfile);
  const profile = (parent.Profile ?? {}) as Record<string, unknown>;
  const label = isProfile
    ? (typeof profile.Name === 'string' && profile.Name ? profile.Name : String(parent.Label ?? id))
    : (typeof parent.Label === 'string' && parent.Label ? parent.Label : id);
  return { id, label, isProfile };
}

/** The note every result carries. Stated as a limit on the ANSWER, not a footnote. */
export const MUTING_NOTE =
  'These are GRANTED permissions — the union of what the listed profiles and permission sets ' +
  'give. Muting permission sets, which subtract access inside a permission set group, are ' +
  'Metadata-API only and cannot be queried, so a user\'s real access may be LESS than shown. ' +
  'Nothing here is described as "effective" for that reason.';

export interface PermissionQueries {
  /** Standard (non-Tooling) SOQL. Rejections MUST throw, never resolve empty. */
  query<T>(soql: string): Promise<{ records: T[] }>;
}

/**
 * Build the granted-permission matrix for one object.
 *
 * Throws if either core query fails: with only two sources, a failure leaves
 * nothing meaningful, and an empty matrix would read as "nobody has access to
 * this object" — a materially wrong answer rather than a partial one.
 */
export async function buildPermissionMatrix(
  q: PermissionQueries,
  {
    object,
    parentFilter,
    extraNotes = [],
  }: {
    object: string;
    /** When set, only these parent ids become columns (the per-user path). */
    parentFilter?: ReadonlySet<string>;
    extraNotes?: readonly string[];
  },
): Promise<PermissionMatrixVM> {
  const [objRes, fldRes] = await Promise.all([
    q.query<Record<string, unknown>>(objectPermissionsQuery(object)),
    q.query<Record<string, unknown>>(fieldPermissionsQuery(object)),
  ]);

  const parents = new Map<string, PermissionParent>();
  const objectGrants: Record<string, ObjectGrant> = {};

  for (const row of objRes.records) {
    const parent = parentFromRow(row);
    if (!parent) continue;
    if (parentFilter && !parentFilter.has(parent.id)) continue;
    parents.set(parent.id, parent);
    objectGrants[parent.id] = {
      create: truthy(row.PermissionsCreate),
      read: truthy(row.PermissionsRead),
      edit: truthy(row.PermissionsEdit),
      delete: truthy(row.PermissionsDelete),
      viewAll: truthy(row.PermissionsViewAllRecords),
      modifyAll: truthy(row.PermissionsModifyAllRecords),
    };
  }

  const fieldMap = new Map<string, Record<string, FieldGrant>>();
  for (const row of fldRes.records) {
    const parent = parentFromRow(row);
    if (!parent) continue;
    if (parentFilter && !parentFilter.has(parent.id)) continue;
    parents.set(parent.id, parent);
    const field = unqualifyField(String(row.Field ?? ''));
    if (!field) continue;
    const byParent = fieldMap.get(field) ?? {};
    byParent[parent.id] = grantFromFlags(row.PermissionsRead, row.PermissionsEdit);
    fieldMap.set(field, byParent);
  }

  // Profiles first, then permission sets; alphabetical within each. A stable
  // column order is what makes two runs comparable by eye.
  const parentList = [...parents.values()].sort(
    (a, b) => Number(b.isProfile) - Number(a.isProfile) || a.label.localeCompare(b.label),
  );

  const fields: FieldGrantRow[] = [...fieldMap.entries()]
    .map(([field, byParent]) => ({
      field,
      byParent,
      granted: Object.values(byParent).reduce<FieldGrant>((acc, g) => maxGrant(acc, g), 'none'),
    }))
    .sort((a, b) => a.field.localeCompare(b.field));

  const notes = [...extraNotes, MUTING_NOTE];
  if (parentList.length === 0) {
    notes.push(
      `No profile or permission set carries a permission entry for ${object}. That is what the ` +
        `org returned — it is not a statement that nobody can see the object, since a permission ` +
        `entry is only stored where access differs from the default.`,
    );
  }

  return {
    object,
    parents: parentList,
    objectGrants,
    objectGranted: unionObjectGrants(Object.values(objectGrants)),
    fields,
    counts: {
      parents: parentList.length,
      fields: fields.length,
      readable: fields.filter((f) => f.granted !== 'none').length,
      editable: fields.filter((f) => f.granted === 'edit').length,
      noAccess: fields.filter((f) => f.granted === 'none').length,
    },
    notes,
  };
}
