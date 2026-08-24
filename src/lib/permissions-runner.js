import path from 'path';
import fs from 'fs-extra';
import { glob } from 'glob';
import {
  buildPermissionMatrix,
  userAssignmentsQuery,
  groupComponentsQuery,
  grantFromFlags,
  maxGrant,
  unionObjectGrants,
  MUTING_NOTE,
} from '@sfdt/flow-core';
import { query } from './org-query.js';

/**
 * `sfdt permissions` — object and field access, CLI side.
 *
 * The model, the fold and the vocabulary are `@sfdt/flow-core`'s. This file
 * supplies the transport, the per-user assignment walk, and the repo-side
 * (offline) parse.
 *
 * The one thing to keep in mind editing this file: nothing here may say
 * "effective". Muting permission sets subtract access and are Metadata-API only,
 * so a computed union is an upper bound. See the header of
 * `packages/flow-core/src/permissions.ts`.
 */

/** `PermissionQueries` over `sf data query`. Refusals throw, by contract. */
export function queriesFor(orgAlias) {
  return {
    query: async (soql) => ({ records: await query(orgAlias, soql) }),
  };
}

/**
 * Resolve which permission parents apply to one user.
 *
 * Two hops, because a permission set GROUP is assigned to the user while the
 * grants live on its member sets. Skipping the second hop would silently drop
 * every grant a group carries — and groups are where large orgs put most of
 * their access, so the answer would look plausible and be badly incomplete.
 *
 * @returns {Promise<{parentIds: Set<string>, notes: string[], groups: string[]}>}
 */
export async function resolveUserParents(orgAlias, username) {
  const assignments = await query(orgAlias, userAssignmentsQuery(username));
  if (assignments.length === 0) {
    throw new Error(
      `No permission set assignments found for "${username}". Check the username — every active ` +
        `user has at least their profile's implicit permission set.`,
    );
  }

  const parentIds = new Set();
  const groupIds = new Set();
  const groups = [];

  for (const row of assignments) {
    if (row.PermissionSetId) parentIds.add(row.PermissionSetId);
    if (row.PermissionSetGroupId) {
      groupIds.add(row.PermissionSetGroupId);
      groups.push(row.PermissionSetGroup?.DeveloperName ?? row.PermissionSetGroupId);
    }
  }

  const notes = [];
  if (groupIds.size > 0) {
    try {
      const components = await query(orgAlias, groupComponentsQuery([...groupIds]));
      for (const row of components) {
        if (row.PermissionSetId) parentIds.add(row.PermissionSetId);
      }
      // Groups are exactly where muting is used, so the general caveat is at its
      // sharpest here and is repeated pointing at the specific groups.
      notes.push(
        `${username} is assigned ${groupIds.size} permission set group(s) (${groups.join(', ')}); ` +
          `their member sets are included. A group may also contain a MUTING permission set, which ` +
          `subtracts access and cannot be queried — so this user's real access may be less than shown.`,
      );
    } catch (err) {
      // Not "the group grants nothing". Say the hop failed.
      notes.push(
        `The member sets of ${groupIds.size} permission set group(s) could not be read ` +
          `(${err.message}), so whatever they grant is MISSING from this result.`,
      );
    }
  }

  return { parentIds, notes, groups };
}

/**
 * Granted permissions on one object, optionally narrowed to one user.
 *
 * @param {string} orgAlias
 * @param {string} object
 * @param {object} [options]
 * @param {string} [options.user] - username to resolve for
 * @returns {Promise<import('@sfdt/flow-core').PermissionMatrixVM>}
 */
export async function runPermissionMatrix(orgAlias, object, { user } = {}) {
  if (!user) {
    return buildPermissionMatrix(queriesFor(orgAlias), { object });
  }
  const { parentIds, notes } = await resolveUserParents(orgAlias, user);
  const vm = await buildPermissionMatrix(queriesFor(orgAlias), {
    object,
    parentFilter: parentIds,
    extraNotes: [
      `Scoped to ${user}: their profile and assigned permission sets only.`,
      ...notes,
    ],
  });
  vm.user = user;
  return vm;
}

// --------------------------------------------------------------------------
// Offline: the same question, asked of the repo
// --------------------------------------------------------------------------

function packageBases(config) {
  const root = config._projectRoot ?? process.cwd();
  const dirs = config.packageDirectories?.length
    ? config.packageDirectories.map((d) => d.path)
    : [config.defaultSourcePath ?? 'force-app/main/default'];
  return dirs.map((d) => path.join(root, d));
}

/**
 * Pull `<fieldPermissions>` and `<objectPermissions>` blocks out of a profile or
 * permission set XML.
 *
 * A deliberate regex parse rather than a full XML parse: these blocks have a
 * fixed, flat shape, and the alternative is adding an XML dependency to read
 * four tags. The bound is stated where it matters — a file using an unusual
 * layout yields nothing rather than a wrong answer, because the regex simply
 * does not match.
 */
export function parsePermissionXml(xml, object) {
  const fields = {};
  let objectGrant = null;

  const fieldBlocks = xml.match(/<fieldPermissions>[\s\S]*?<\/fieldPermissions>/g) ?? [];
  for (const block of fieldBlocks) {
    const field = /<field>([^<]+)<\/field>/.exec(block)?.[1];
    if (!field || !field.startsWith(`${object}.`)) continue;
    const readable = /<readable>true<\/readable>/.test(block);
    const editable = /<editable>true<\/editable>/.test(block);
    fields[field.slice(object.length + 1)] = grantFromFlags(readable, editable);
  }

  const objectBlocks = xml.match(/<objectPermissions>[\s\S]*?<\/objectPermissions>/g) ?? [];
  for (const block of objectBlocks) {
    const name = /<object>([^<]+)<\/object>/.exec(block)?.[1];
    if (name !== object) continue;
    const flag = (tag) => new RegExp(`<${tag}>true</${tag}>`).test(block);
    objectGrant = {
      create: flag('allowCreate'),
      read: flag('allowRead'),
      edit: flag('allowEdit'),
      delete: flag('allowDelete'),
      viewAll: flag('viewAllRecords'),
      modifyAll: flag('modifyAllRecords'),
    };
  }

  return { fields, objectGrant };
}

/**
 * Build the matrix from repo source, with no org.
 *
 * Runs on a pull request, which is the half a hosted product cannot offer. The
 * bound is different from the org path and is stated: source declares what is
 * *committed*, and an org may have grants nobody ever put in the repo.
 */
export async function runOfflinePermissionMatrix(config, object) {
  const parents = [];
  const objectGrants = {};
  const fieldMap = new Map();

  for (const base of packageBases(config)) {
    for (const [dir, pattern, isProfile] of [
      ['profiles', '*.profile-meta.xml', true],
      ['permissionsets', '*.permissionset-meta.xml', false],
    ]) {
      const files = await glob(pattern, { cwd: path.join(base, dir), absolute: true }).catch(() => []);
      for (const file of files) {
        const xml = await fs.readFile(file, 'utf8').catch(() => '');
        if (!xml) continue;
        const { fields, objectGrant } = parsePermissionXml(xml, object);
        // A file that mentions the object nowhere is not a column: including it
        // would fill the matrix with empty rows that read as "denied".
        if (Object.keys(fields).length === 0 && !objectGrant) continue;

        const label = path.basename(file).replace(/\.(profile|permissionset)-meta\.xml$/i, '');
        const id = `${isProfile ? 'profile' : 'permset'}:${label}`;
        parents.push({ id, label, isProfile });
        if (objectGrant) objectGrants[id] = objectGrant;
        for (const [field, grant] of Object.entries(fields)) {
          const byParent = fieldMap.get(field) ?? {};
          byParent[id] = grant;
          fieldMap.set(field, byParent);
        }
      }
    }
  }

  parents.sort((a, b) => Number(b.isProfile) - Number(a.isProfile) || a.label.localeCompare(b.label));

  const fields = [...fieldMap.entries()]
    .map(([field, byParent]) => ({
      field,
      byParent,
      granted: Object.values(byParent).reduce((acc, g) => maxGrant(acc, g), 'none'),
    }))
    .sort((a, b) => a.field.localeCompare(b.field));

  const notes = [
    `Read from ${parents.length} profile/permission-set file(s) in this repository. Source ` +
      `declares what is COMMITTED — an org may carry grants that were never put in the repo, and ` +
      `this says nothing about those.`,
    MUTING_NOTE,
  ];
  if (parents.length === 0) {
    notes.push(
      `No profile or permission set in this repository mentions ${object}. That is a fact about ` +
        `the repository, not a finding that nobody has access.`,
    );
  }

  return {
    object,
    mode: 'offline',
    parents,
    objectGrants,
    objectGranted: unionObjectGrants(Object.values(objectGrants)),
    fields,
    counts: {
      parents: parents.length,
      fields: fields.length,
      readable: fields.filter((f) => f.granted !== 'none').length,
      editable: fields.filter((f) => f.granted === 'edit').length,
      noAccess: fields.filter((f) => f.granted === 'none').length,
    },
    notes,
  };
}

// --------------------------------------------------------------------------
// Drift: org vs repo
// --------------------------------------------------------------------------

/**
 * Compare what the ORG grants against what the REPO declares, per parent+field.
 *
 * Permissions as a deploy gate is the thing a hosted product structurally cannot
 * do, and it is the reason this feature is worth building rather than matching.
 *
 * Parents are matched by LABEL, because the org knows them by id and the repo
 * knows them by filename and those can never be equated. That is a real
 * limitation, so a parent present on only one side is reported as
 * `only-in-org` / `only-in-repo` rather than silently dropped.
 */
export function comparePermissionSets(orgVm, repoVm) {
  const rows = [];
  const orgByLabel = new Map(orgVm.parents.map((p) => [p.label, p]));
  const repoByLabel = new Map(repoVm.parents.map((p) => [p.label, p]));

  const grantOf = (vm, parentId, field) =>
    vm.fields.find((f) => f.field === field)?.byParent?.[parentId] ?? 'none';

  const allFields = new Set([
    ...orgVm.fields.map((f) => f.field),
    ...repoVm.fields.map((f) => f.field),
  ]);
  const allLabels = new Set([...orgByLabel.keys(), ...repoByLabel.keys()]);

  for (const label of [...allLabels].sort()) {
    const orgParent = orgByLabel.get(label);
    const repoParent = repoByLabel.get(label);
    if (!orgParent || !repoParent) {
      rows.push({
        parent: label,
        field: null,
        org: orgParent ? 'present' : 'absent',
        repo: repoParent ? 'present' : 'absent',
        verdict: orgParent ? 'only-in-org' : 'only-in-repo',
      });
      continue;
    }
    for (const field of [...allFields].sort()) {
      const inOrg = grantOf(orgVm, orgParent.id, field);
      const inRepo = grantOf(repoVm, repoParent.id, field);
      if (inOrg === inRepo) continue;
      rows.push({
        parent: label,
        field,
        org: inOrg,
        repo: inRepo,
        // Named by direction: an org granting MORE than source is the one that
        // matters for a security review.
        verdict: inOrg === 'none' ? 'missing-in-org' : inRepo === 'none' ? 'extra-in-org' : 'changed',
      });
    }
  }

  return {
    object: orgVm.object,
    rows,
    counts: {
      total: rows.length,
      extraInOrg: rows.filter((r) => r.verdict === 'extra-in-org').length,
      missingInOrg: rows.filter((r) => r.verdict === 'missing-in-org').length,
      changed: rows.filter((r) => r.verdict === 'changed').length,
      unmatchedParents: rows.filter((r) => r.field === null).length,
    },
    notes: [
      'Profiles and permission sets are matched by LABEL: the org identifies them by id and the ' +
        'repository by filename, and those cannot be equated. A parent present on only one side ' +
        'is reported as such rather than dropped.',
      MUTING_NOTE,
    ],
  };
}

/** Fetch both sides and diff them. */
export async function runPermissionDrift(config, orgAlias, object) {
  const [orgVm, repoVm] = await Promise.all([
    runPermissionMatrix(orgAlias, object),
    runOfflinePermissionMatrix(config, object),
  ]);
  return comparePermissionSets(orgVm, repoVm);
}
