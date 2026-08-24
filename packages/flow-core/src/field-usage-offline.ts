// Offline field usage — the same question as field-usage.ts, asked of a repo
// instead of an org.
//
// This is the half a hosted competitor structurally cannot offer: it needs your
// source tree, not your org, so it runs in CI on a pull request, before the
// field is ever deployed anywhere.
//
// ---------------------------------------------------------------------------
// The distinction that makes this useful: structural vs logical
// ---------------------------------------------------------------------------
// A naive "grep the field name across force-app" reports every field as
// referenced, and is therefore worthless. Two metadata types reference fields
// almost universally:
//
//   - **Profiles and permission sets** carry a `fieldPermissions` entry for
//     every field they grant. A field is named there because it EXISTS, not
//     because anything uses it.
//   - **Page layouts** list most fields on the object for the same reason.
//
// Those are STRUCTURAL references: they describe access and presentation, and
// they follow a field around whether or not any behaviour depends on it. A field
// referenced only structurally is precisely what "unused" means in practice, so
// `unreferenced` is keyed on LOGICAL references only — Apex, flows, validation
// rules, formulas on other fields, reports, email templates, LWC and Aura.
//
// Structural hits are still counted and reported, because a field with a layout
// entry needs that entry removed too, and pretending we never saw it would make
// the removal instructions wrong.
//
// ---------------------------------------------------------------------------
// Everything here is `inferred`, by construction
// ---------------------------------------------------------------------------
// A text match in a file is not a reference. It may be a comment, a string
// literal, or a longer field name that contains this one. There is no org to
// confirm against, so nothing offline is ever `confirmed` — the same rule the
// dependency `--gaps` report already applies.

import type { FieldUsageRow, FieldUsageVM } from './field-usage.js';

export type ReferenceKind = 'logical' | 'structural';

export interface OfflineSourceType {
  /** Metadata type label, e.g. `ApexClass`. */
  type: string;
  kind: ReferenceKind;
}

/**
 * Which metadata type a repo-relative path belongs to, and whether a hit in it
 * is evidence of USE or merely of existence.
 *
 * Returns null for paths that must not be scanned at all — most importantly the
 * object's own field definitions, where every field names itself.
 */
export function classifyOfflineSource(relPath: string): OfflineSourceType | null {
  const p = relPath.replace(/\\/g, '/');

  // Another field's FORMULA is a real logical reference, so field definitions
  // are scanned — but a field's OWN file names it in `<fullName>`, so the
  // scanner must skip the self-match. `isSelfDefinition` below is that check;
  // without it every field would be referenced by itself and nothing would ever
  // be a candidate.
  if (/\/fields\/[^/]+\.field-meta\.xml$/.test(p)) return { type: 'CustomField', kind: 'logical' };
  // The object file lists every field in its own right — existence, not use.
  if (/\.object-meta\.xml$/.test(p)) return null;

  if (/\.cls$/.test(p)) return { type: 'ApexClass', kind: 'logical' };
  if (/\.trigger$/.test(p)) return { type: 'ApexTrigger', kind: 'logical' };
  if (/\.flow-meta\.xml$/.test(p)) return { type: 'Flow', kind: 'logical' };
  if (/\/validationRules\/[^/]+\.validationRule-meta\.xml$/.test(p)) {
    return { type: 'ValidationRule', kind: 'logical' };
  }
  if (/\.report-meta\.xml$/.test(p)) return { type: 'Report', kind: 'logical' };
  if (/\.email-meta\.xml$/.test(p)) return { type: 'EmailTemplate', kind: 'logical' };
  if (/\/lwc\/[^/]+\/.*\.(js|html)$/.test(p)) return { type: 'LightningComponentBundle', kind: 'logical' };
  if (/\/aura\/[^/]+\/.*\.(js|cmp|app|evt)$/.test(p)) return { type: 'AuraDefinitionBundle', kind: 'logical' };
  if (/\.workflow-meta\.xml$/.test(p)) return { type: 'Workflow', kind: 'logical' };
  if (/\/quickActions\/[^/]+\.quickAction-meta\.xml$/.test(p)) {
    return { type: 'QuickAction', kind: 'logical' };
  }

  // Structural — a hit here says the field exists and is exposed, not that
  // anything depends on its value.
  if (/\.layout-meta\.xml$/.test(p)) return { type: 'Layout', kind: 'structural' };
  if (/\.profile-meta\.xml$/.test(p)) return { type: 'Profile', kind: 'structural' };
  if (/\.permissionset-meta\.xml$/.test(p)) return { type: 'PermissionSet', kind: 'structural' };
  if (/\/listViews\//.test(p) || /\.listView-meta\.xml$/.test(p)) {
    return { type: 'ListView', kind: 'structural' };
  }
  if (/\.recordType-meta\.xml$/.test(p)) return { type: 'RecordType', kind: 'structural' };
  if (/\.fieldSet-meta\.xml$/.test(p)) return { type: 'FieldSet', kind: 'structural' };

  return null;
}

/**
 * Does this path define the field itself?
 *
 * `objects/Account/fields/Region__c.field-meta.xml` names `Region__c` in its
 * own `<fullName>`. Counting that would make every field reference itself, so
 * the scanner drops the self-match while still reading the file for OTHER
 * fields' formulas.
 */
export function isSelfDefinition(relPath: string, field: string): boolean {
  const base = relPath.replace(/\\/g, '/').split('/').pop() ?? '';
  return base.toLowerCase() === `${field.toLowerCase()}.field-meta.xml`;
}

/**
 * Match a field API name as a whole token.
 *
 * A bare substring search is wrong in a specific, silent way: `Region__c` occurs
 * inside `Sub_Region__c`, so every long field would keep its shorter namesakes
 * alive and they would never appear as cleanup candidates. Word boundaries alone
 * do not fix it — `_` is a word character in JS regex, so `\bRegion__c\b` still
 * matches inside `Sub_Region__c`. Hence an explicit "not preceded by an
 * identifier character" guard.
 */
export function fieldReferenceRegex(field: string): RegExp {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`);
}

/** One file that mentioned one field. */
export interface OfflineHit {
  field: string;
  /** Repo-relative path, used as the reference's name. */
  path: string;
  type: string;
  kind: ReferenceKind;
}

function emptyOfflineRow(f: { name: string; label?: string | null; type?: string | null }): FieldUsageRow {
  return {
    name: f.name,
    label: (f.label ?? '').trim() || f.name,
    type: f.type ?? 'unknown',
    custom: /__c$/i.test(f.name),
    required: false,
    unique: false,
    scannable: true,
    references: [],
    referenceCount: 0,
    unreferenced: null,
    safeToRemove: null,
    keepReason: null,
    populated: null,
    totalRecords: null,
  };
}

/**
 * Fold file hits into a viewmodel with the same shape the org sweep produces, so
 * both modes render and serialise identically.
 *
 * `safeToRemove` is left `null` on every row and is never computed here. Offline
 * there is no data to count, and a field with no reference in the repo may still
 * hold millions of values in every org it is deployed to. Saying "safe to
 * remove" from a repo alone would be the exact claim this feature refuses.
 */
export function buildOfflineUsageVM({
  object,
  fields,
  hits,
  notes = [],
}: {
  object: string;
  fields: ReadonlyArray<{ name: string; label?: string | null; type?: string | null }>;
  hits: readonly OfflineHit[];
  notes?: readonly string[];
}): FieldUsageVM {
  const rows = fields.map(emptyOfflineRow);
  const byName = new Map(rows.map((r) => [r.name.toLowerCase(), r]));

  /** field → type → paths, for both kinds. */
  const logical = new Map<string, Map<string, string[]>>();
  const structural = new Map<string, Map<string, string[]>>();

  for (const hit of hits) {
    const bucket = hit.kind === 'logical' ? logical : structural;
    const byType = bucket.get(hit.field.toLowerCase()) ?? new Map<string, string[]>();
    const paths = byType.get(hit.type) ?? [];
    paths.push(hit.path);
    byType.set(hit.type, paths);
    bucket.set(hit.field.toLowerCase(), byType);
  }

  let structuralOnly = 0;
  for (const row of rows) {
    const key = row.name.toLowerCase();
    const log = logical.get(key);
    const str = structural.get(key);

    const groups = [...(log ?? new Map<string, string[]>())].map(([type, names]) => ({
      type,
      names: [...names].sort(),
    }));
    // Structural groups are labelled so they can never be mistaken for use.
    for (const [type, names] of str ?? new Map<string, string[]>()) {
      groups.push({ type: `${type} (structural)`, names: [...names].sort() });
    }
    groups.sort((a, b) => a.type.localeCompare(b.type));

    row.references = groups;
    row.referenceCount = groups.reduce((n, g) => n + g.names.length, 0);
    // Keyed on LOGICAL hits only — see the header.
    row.unreferenced = !log || log.size === 0;
    if (row.unreferenced && str && str.size > 0) structuralOnly++;
  }

  const allNotes = [...notes];
  if (structuralOnly > 0) {
    allNotes.push(
      `${structuralOnly} field(s) appear ONLY in layouts, profiles, permission sets, list views or ` +
        `field sets. Those references describe access and presentation, not behaviour — a field ` +
        `named there is named because it exists, not because anything uses it — so they are ` +
        `reported as unreferenced. Removing such a field still means removing those entries too.`,
    );
  }
  allNotes.push(
    'Offline results are ALWAYS inferred. A text match in a file is not a reference: it may be a ' +
      'comment, a string literal, or dynamic code that builds the name at runtime — and dynamic ' +
      'SOQL or a field name assembled from parts is invisible to this scan entirely.',
  );
  allNotes.push(
    'This scanned the repository, not an org. It says nothing about how much DATA a field holds, ' +
      'so no field is reported as safe to remove. Run `sfdt field usage <Object> --population` ' +
      'against an org for that.',
  );

  rows.sort((a, b) => {
    const rank = (r: FieldUsageRow) => (r.unreferenced === true ? 0 : r.unreferenced === null ? 1 : 2);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });

  return {
    object,
    rows,
    counts: {
      total: rows.length,
      scanned: rows.filter((r) => r.unreferenced !== null).length,
      unreferenced: rows.filter((r) => r.unreferenced === true).length,
      unknown: rows.filter((r) => r.unreferenced === null).length,
      safeToRemove: 0,
    },
    notes: allNotes,
  };
}
