import path from 'path';
import { escapeSoql } from '@sfdt/flow-core';
import { orgRest, restErrorMessage } from './org-rest.js';
import { apiVersion } from './record-runner.js';
import { query } from './org-query.js';
import { runPermissionDrift } from './permissions-runner.js';
import { recordIntent, recordOutcome, registerReverser } from './ledger.js';

/**
 * `sfdt permissions grant|revoke` — the writable half.
 *
 * `ObjectPermissions` and `FieldPermissions` are ordinary updatable sObjects, so
 * this is plain REST — no metadata deploy, no Tooling.
 *
 * **Profiles are refused.** Salesforce does not allow direct DML on a
 * profile-owned permission entry; those require the Metadata API. Refusing by
 * name up front beats letting the org return an opaque
 * `INSUFFICIENT_ACCESS_OR_READONLY` that reads like a permissions problem with
 * the user's own access. (Documented behaviour — not verified here against a
 * live org, and refusing is the safe direction to be wrong.)
 *
 * Every write records its before-state through the ledger first, and aborts if
 * that fails.
 */

/** Grants, strongest last — the order `read` ⊂ `edit` depends on. */
const LEVELS = ['none', 'read', 'edit'];

export function isValidLevel(level) {
  return LEVELS.includes(level);
}

function permissionFlags(level) {
  // Edit implies read: a parent that can write a field can necessarily see it,
  // and Salesforce rejects `PermissionsEdit` without `PermissionsRead`.
  return {
    PermissionsRead: level === 'read' || level === 'edit',
    PermissionsEdit: level === 'edit',
  };
}

/** Resolve a permission set by label, refusing profiles with the reason. */
export async function resolveParent(orgAlias, label) {
  // flow-core's escapeSoql, not a local one: it escapes the BACKSLASH before the
  // quote, so a value ending in `\` cannot escape its own closing delimiter and
  // break out of the literal. Four other call sites in this repo already use it.
  const escaped = escapeSoql(String(label));
  const rows = await query(
    orgAlias,
    `SELECT Id, Label, IsOwnedByProfile, Profile.Name FROM PermissionSet WHERE Label = '${escaped}' OR Name = '${escaped}'`,
  );
  if (rows.length === 0) throw new Error(`No permission set named "${label}" in ${orgAlias}.`);
  if (rows.length > 1) {
    throw new Error(`${rows.length} permission sets match "${label}" — use the exact API name.`);
  }
  const row = rows[0];
  if (row.IsOwnedByProfile === true) {
    const err = new Error(
      `"${label}" is a PROFILE (${row.Profile?.Name ?? label}). Salesforce does not permit direct ` +
        `updates to profile-owned permission entries — they must go through the Metadata API, so ` +
        `change this one in source and deploy it. Permission sets can be changed here.`,
    );
    err.exitCode = 1;
    throw err;
  }
  return { id: row.Id, label: row.Label ?? label };
}

/** The current FieldPermissions row for one parent+field, or null. */
async function currentFieldPermission(orgAlias, parentId, object, field) {
  const escaped = escapeSoql(`${object}.${field}`);
  const rows = await query(
    orgAlias,
    `SELECT Id, PermissionsRead, PermissionsEdit FROM FieldPermissions` +
      ` WHERE ParentId = '${parentId}' AND Field = '${escaped}' LIMIT 1`,
  );
  if (rows.length === 0) return null;
  return {
    id: rows[0].Id,
    level: rows[0].PermissionsEdit ? 'edit' : rows[0].PermissionsRead ? 'read' : 'none',
  };
}

/**
 * Apply one field-permission change.
 *
 * Three shapes, because Salesforce models "no access" as the absence of a row
 * rather than a row saying no:
 *   - no row, want access      → POST
 *   - row exists, want a change → PATCH
 *   - row exists, want none     → DELETE
 */
async function applyFieldPermission(config, orgAlias, parentId, object, field, level, current) {
  const base = `/services/data/${apiVersion(config)}/sobjects/FieldPermissions`;
  if (level === 'none') {
    if (!current) return { action: 'no-op' };
    await orgRest(orgAlias, `${base}/${current.id}`, { method: 'DELETE' });
    return { action: 'deleted' };
  }
  const flags = permissionFlags(level);
  if (current) {
    await orgRest(orgAlias, `${base}/${current.id}`, { method: 'PATCH', body: flags });
    return { action: 'updated' };
  }
  await orgRest(orgAlias, `${base}/`, {
    method: 'POST',
    body: { ParentId: parentId, SobjectType: object, Field: `${object}.${field}`, ...flags },
  });
  return { action: 'created' };
}

function splitField(qualified) {
  const dot = String(qualified).indexOf('.');
  if (dot <= 0) throw new Error(`Expected <Object>.<Field>, e.g. Account.Region__c — got "${qualified}".`);
  return { object: qualified.slice(0, dot), field: qualified.slice(dot + 1) };
}

/**
 * Grant or revoke field access for one permission set.
 *
 * @param {object} config
 * @param {string} orgAlias
 * @param {object} args
 * @param {string} args.parent - permission set label
 * @param {string[]} args.fields - qualified `Object.Field` names
 * @param {'none'|'read'|'edit'} args.level
 * @param {boolean} [args.dryRun]
 * @param {string} [args.logDir]
 */
export async function applyPermissionChange(config, orgAlias, { parent, fields, level, dryRun = false, logDir }) {
  if (!isValidLevel(level)) throw new Error(`--level must be one of ${LEVELS.join(', ')}.`);
  if (!fields?.length) throw new Error('Provide at least one --field <Object.Field>.');

  const resolved = await resolveParent(orgAlias, parent);
  const dir = logDir ?? config.logDir ?? path.join(config._projectRoot, 'logs');

  // Read every current grant BEFORE anything is written, so the recorded
  // before-state is a coherent snapshot rather than a mix of pre- and
  // post-change readings.
  const planned = [];
  for (const qualified of fields) {
    const { object, field } = splitField(qualified);
    const current = await currentFieldPermission(orgAlias, resolved.id, object, field);
    planned.push({ qualified, object, field, current, from: current?.level ?? 'none', to: level });
  }

  const changes = planned.filter((p) => p.from !== p.to);
  if (changes.length === 0) {
    return { outcome: 'no-op', parent: resolved.label, planned, applied: [] };
  }
  if (dryRun) {
    return { outcome: 'dry-run', parent: resolved.label, planned, applied: [] };
  }

  const entry = await recordIntent(dir, {
    org: orgAlias,
    kind: 'permissions.field',
    target: resolved.label,
    summary: `Set ${changes.length} field grant(s) to "${level}" on ${resolved.label}`,
    before: {
      parentId: resolved.id,
      parentLabel: resolved.label,
      fields: changes.map((c) => ({ field: c.qualified, level: c.from })),
    },
    after: {
      parentId: resolved.id,
      parentLabel: resolved.label,
      fields: changes.map((c) => ({ field: c.qualified, level: c.to })),
    },
  });

  const applied = [];
  try {
    for (const change of changes) {
      const result = await applyFieldPermission(
        config, orgAlias, resolved.id, change.object, change.field, change.to, change.current,
      );
      applied.push({ field: change.qualified, from: change.from, to: change.to, ...result });
    }
    await recordOutcome(dir, entry.id, { status: 'applied' });
    return { outcome: 'applied', parent: resolved.label, planned, applied, ledgerId: entry.id };
  } catch (err) {
    // Partial application is the honest outcome, and the ledger's before-state
    // still covers every field in the batch — so undo puts back the ones that
    // did change and no-ops the rest.
    await recordOutcome(dir, entry.id, {
      status: 'failed',
      error: `${restErrorMessage(err)} (${applied.length} of ${changes.length} applied before the failure)`,
    });
    const wrapped = new Error(
      `${restErrorMessage(err)} — ${applied.length} of ${changes.length} change(s) were applied ` +
        `before this failed. \`sfdt ledger undo ${entry.id}\` reverses those.`,
    );
    wrapped.ledgerId = entry.id;
    throw wrapped;
  }
}

/**
 * Apply exactly what `permissions drift` found missing in the org.
 *
 * This is the bulk fix, and its shape is the argument for it: the intended state
 * is **your repository**, which was code-reviewed before it was applied — rather
 * than a grid someone clicked through in a browser. Only `missing-in-org` rows
 * are applied; `extra-in-org` is deliberately NOT auto-revoked, because removing
 * access nobody asked to remove is a different and far more dangerous decision.
 */
export async function applyDriftFix(config, orgAlias, object, { dryRun = false, logDir } = {}) {
  const drift = await runPermissionDrift(config, orgAlias, object);
  const missing = drift.rows.filter((r) => r.verdict === 'missing-in-org' && r.field);

  if (missing.length === 0) {
    return { outcome: 'no-op', object, applied: [], skipped: drift.rows.length, notes: drift.notes };
  }

  // One call per parent, so each parent's changes are one ledger entry and one
  // undo.
  const byParent = new Map();
  for (const row of missing) {
    const list = byParent.get(row.parent) ?? [];
    list.push(row);
    byParent.set(row.parent, list);
  }

  const results = [];
  for (const [parent, rows] of byParent) {
    // The repo may declare `read` for one field and `edit` for another, so
    // grouping by level keeps each batch a single intended state.
    const byLevel = new Map();
    for (const row of rows) {
      const list = byLevel.get(row.repo) ?? [];
      list.push(`${object}.${row.field}`);
      byLevel.set(row.repo, list);
    }
    for (const [level, fields] of byLevel) {
      results.push(
        await applyPermissionChange(config, orgAlias, { parent, fields, level, dryRun, logDir }),
      );
    }
  }

  return {
    outcome: dryRun ? 'dry-run' : 'applied',
    object,
    results,
    notes: [
      ...drift.notes,
      'Only fields MISSING in the org were applied. Grants the org has but source does not ' +
        '(`extra-in-org`) were left alone — removing access nobody asked to remove is a different ' +
        'decision, and a riskier one.',
    ],
  };
}

// --------------------------------------------------------------------------
// Reversal
// --------------------------------------------------------------------------

async function reversePermissions(before, entry, ctx) {
  const org = ctx.org ?? entry.org;
  if (!org) throw new Error('Cannot undo a permission change without knowing which org it was made in.');
  const config = ctx.config;
  if (!config) throw new Error('Cannot undo a permission change without the project config.');

  const restored = [];
  for (const { field, level } of before.fields ?? []) {
    const { object, field: name } = splitField(field);
    const current = await currentFieldPermission(org, before.parentId, object, name);
    // Idempotent: a field already back at its recorded level is a no-op, so a
    // partially-applied change undoes cleanly.
    if ((current?.level ?? 'none') === level) {
      restored.push({ field, level, action: 'no-op' });
      continue;
    }
    const result = await applyFieldPermission(config, org, before.parentId, object, name, level, current);
    restored.push({ field, level, ...result });
  }
  return { restored };
}

registerReverser('permissions.field', reversePermissions);
