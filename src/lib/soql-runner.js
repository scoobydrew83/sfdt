import path from 'path';
import fs from 'fs-extra';
import { execa } from 'execa';
import { rawQuery, safeParse } from './org-query.js';

/**
 * SOQL/SOSL toolkit runner — schema search/describe, relationship discovery,
 * query validation, query plans, and bounded query execution with exports.
 *
 * Native clean-room implementation of the query/schema lifecycle (inspired by
 * the capability set of sf-pi's SF SOQL extension; no code shared). Everything
 * shells to the Salesforce CLI (`sf sobject …`, `sf data query|search --json`,
 * `sf api request rest`) — no new auth plumbing and no new dependencies —
 * mirroring org-query.js / org-release.js conventions.
 *
 * Bounded execution: `runQuery`/`runSearch` never issue an unbounded query.
 * The effective row cap comes from `--limit` / `config.soql.defaultLimit`
 * (default 200) and is clamped to `config.soql.maxLimit` (default 2000); a
 * LIMIT already present in the query is kept only when it is at or under the
 * cap. Exports write RAW records to disk (JSON or CSV) per the envelope
 * boundary rule — the sf-native `{status, result, warnings}` envelope exists
 * on stdout only.
 *
 * Pure helpers (limit parsing/injection, local validation, CSV flattening) are
 * exported so they can be unit-tested without a live org.
 */

/** Fallback bounds when config.soql is absent (canonical defaults live in src/templates/sfdt.config.json). */
export const SOQL_DEFAULTS = {
  defaultLimit: 200,
  maxLimit: 2000,
};

/** REST API version used for query plans when the project doesn't declare one. */
export const DEFAULT_PLAN_API_VERSION = '64.0';

/** Resolve the org alias or throw the standard guidance error. */
export function resolveOrg(config, options = {}) {
  const org = options.org ?? config?.defaultOrg;
  if (!org) throw new Error('No org specified — pass --org <alias> or set defaultOrg in .sfdt/config.json');
  return org;
}

/**
 * Compute the effective row bound for query execution.
 *
 * @param {object} config - Loaded sfdt config (reads `config.soql`).
 * @param {number|string} [requested] - The user's --limit value, if any.
 * @returns {{ limit: number, max: number, clamped: boolean }}
 */
export function resolveBounds(config, requested) {
  const defaults = config?.soql ?? {};
  const max = toPositiveInt(defaults.maxLimit) ?? SOQL_DEFAULTS.maxLimit;
  let limit = toPositiveInt(requested ?? defaults.defaultLimit) ?? SOQL_DEFAULTS.defaultLimit;
  if (requested != null && toPositiveInt(requested) == null) {
    throw new Error(`--limit must be a positive integer (got: ${requested})`);
  }
  const clamped = limit > max;
  if (clamped) limit = max;
  return { limit, max, clamped };
}

function toPositiveInt(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Trailing-clause matcher: `LIMIT n [OFFSET m]` at the end of a query. */
const TRAILING_LIMIT_RE = /\blimit\s+(\d+)(\s+offset\s+\d+)?\s*$/i;
/** Trailing `OFFSET m` with no LIMIT before it. */
const TRAILING_OFFSET_RE = /\boffset\s+\d+\s*$/i;

/**
 * Extract the trailing LIMIT of a SOQL/SOSL query, or null when unbounded.
 * Only the outer (trailing) LIMIT counts — a LIMIT inside a subquery does not
 * bound the parent query.
 */
export function parseLimit(query) {
  const m = String(query ?? '').match(TRAILING_LIMIT_RE);
  return m ? Number(m[1]) : null;
}

/**
 * Return a copy of the query bounded to at most `limit` rows.
 *
 * - No trailing LIMIT → append one (before a trailing OFFSET when present).
 * - Trailing LIMIT ≤ cap → left untouched.
 * - Trailing LIMIT > cap → rewritten down to the cap.
 *
 * @returns {{ query: string, effectiveLimit: number, action: 'appended'|'kept'|'clamped' }}
 */
export function applyLimit(query, limit) {
  const text = String(query ?? '').trim();
  const existing = parseLimit(text);
  if (existing == null) {
    const offsetMatch = text.match(TRAILING_OFFSET_RE);
    if (offsetMatch) {
      // SOQL syntax order is `LIMIT n OFFSET m` — inject before the OFFSET.
      const head = text.slice(0, offsetMatch.index).trimEnd();
      return { query: `${head} LIMIT ${limit} ${offsetMatch[0].trim()}`, effectiveLimit: limit, action: 'appended' };
    }
    return { query: `${text} LIMIT ${limit}`, effectiveLimit: limit, action: 'appended' };
  }
  if (existing <= limit) return { query: text, effectiveLimit: existing, action: 'kept' };
  return {
    query: text.replace(TRAILING_LIMIT_RE, (full) => full.replace(/\blimit\s+\d+/i, `LIMIT ${limit}`)),
    effectiveLimit: limit,
    action: 'clamped',
  };
}

/**
 * Static (offline) SOQL/SOSL sanity checks — the cheap first pass of
 * validation. Structural only; real grammar/schema validation happens on the
 * org round-trip in `validateQuery`.
 *
 * @returns {{ valid: boolean, kind: 'soql'|'sosl'|'unknown', errors: string[], warnings: string[] }}
 */
export function validateLocal(query) {
  const errors = [];
  const warnings = [];
  const text = String(query ?? '').trim();
  let kind = 'unknown';

  if (!text) {
    return { valid: false, kind, errors: ['Query is empty.'], warnings };
  }
  if (/^select\b/i.test(text)) kind = 'soql';
  else if (/^find\b/i.test(text)) kind = 'sosl';
  else errors.push('Query must start with SELECT (SOQL) or FIND (SOSL).');

  if (kind === 'soql') {
    if (!/\bfrom\s+[a-z0-9_]+/i.test(text)) errors.push('SOQL requires a FROM <sObject> clause.');
    if (/^select\s+\*/i.test(text)) errors.push('SOQL has no `SELECT *` — list the fields explicitly.');
  }
  if (kind === 'sosl' && !/^find\s*\{.+\}/is.test(text)) {
    errors.push('SOSL requires a braced search term: FIND {term} …');
  }
  if (text.includes(';')) errors.push('Semicolons are not valid in SOQL/SOSL.');

  const parens = balance(text, '(', ')');
  if (parens !== 0) errors.push(`Unbalanced parentheses (${parens > 0 ? 'missing )' : 'missing ('}).`);
  const quotes = (text.match(/'/g) ?? []).length;
  if (quotes % 2 !== 0) errors.push('Unbalanced single quotes.');

  if (kind === 'soql' && parseLimit(text) == null) {
    warnings.push('No trailing LIMIT — execution via `sfdt soql query` will apply the configured bound.');
  }

  return { valid: errors.length === 0, kind, errors, warnings };
}

function balance(text, open, close) {
  let depth = 0;
  // Ignore parens inside single-quoted string literals.
  let inString = false;
  for (const ch of text) {
    if (ch === "'") inString = !inString;
    else if (!inString && ch === open) depth += 1;
    else if (!inString && ch === close) depth -= 1;
  }
  return depth;
}

/**
 * Rewrite a SOQL query so it can be validated against the org without
 * materialising rows: strip any trailing LIMIT/OFFSET and append `LIMIT 0`.
 * Salesforce parses and binds the full query (unknown fields/objects and
 * syntax errors still fail) but returns zero rows.
 */
export function rewriteForValidation(soql) {
  let text = String(soql ?? '').trim();
  text = text.replace(TRAILING_LIMIT_RE, '').replace(TRAILING_OFFSET_RE, '').trimEnd();
  return `${text} LIMIT 0`;
}

/**
 * Validate a SOQL query. Always runs the local static checks; when an org is
 * resolvable the query is additionally round-tripped as a `LIMIT 0` execution
 * so Salesforce itself confirms grammar, objects, and fields. Degrades
 * gracefully to a local-only result (with a warning, never a fabricated pass)
 * when no org is available or reachable.
 *
 * @returns {Promise<{ query: string, valid: boolean, mode: 'local'|'org', kind: string, errors: string[], warnings: string[] }>}
 */
export async function validateQuery(config, soql, { org, tooling = false, localOnly = false } = {}) {
  const local = validateLocal(soql);
  const result = { query: soql, valid: local.valid, mode: 'local', kind: local.kind, errors: local.errors, warnings: local.warnings };
  if (!local.valid || local.kind !== 'soql' || localOnly) {
    if (local.kind === 'sosl') result.warnings = [...result.warnings, 'Org round-trip validation covers SOQL only.'];
    return result;
  }

  const orgAlias = org ?? config?.defaultOrg;
  if (!orgAlias) {
    result.warnings = [...result.warnings, 'No org resolvable — org round-trip skipped (local checks only).'];
    return result;
  }

  try {
    await rawQuery(orgAlias, rewriteForValidation(soql), { tooling });
    return { ...result, mode: 'org', valid: true };
  } catch (err) {
    const message = oneLine(err.message);
    // An unreachable/unauthenticated org is a degraded validation, not an
    // invalid query — never fabricate a verdict the org didn't give.
    if (isOrgUnavailable(message)) {
      result.warnings = [...result.warnings, `Org "${orgAlias}" not reachable (${message}) — local checks only.`];
      return result;
    }
    return { ...result, mode: 'org', valid: false, errors: [message] };
  }
}

/** Heuristic: error text that indicates the org (not the query) is the problem. */
function isOrgUnavailable(message) {
  return /no authorization information|named org|not authorized|enoent|econn|etimedout|getaddrinfo|socket hang up|expired access\/refresh token/i.test(
    message,
  );
}

/**
 * List sObjects in the org, optionally filtered by a case-insensitive
 * substring. Schema search — the entry point of the query lifecycle.
 *
 * @param {object} config
 * @param {string} [term] - Substring to match against API names (empty = all).
 * @param {object} [options]
 * @param {string} [options.org]
 * @param {string} [options.category] - all | custom | standard (default all).
 * @param {number|string} [options.limit] - Max matches returned (default 100).
 * @returns {Promise<{ org: string, term: string|null, category: string, totalScanned: number, totalMatched: number, truncated: boolean, matches: string[] }>}
 */
export async function searchSObjects(config, term, { org, category = 'all', limit } = {}) {
  const orgAlias = resolveOrg(config, { org });
  if (!['all', 'custom', 'standard'].includes(category)) {
    throw new Error(`--category must be one of: all, custom, standard (got: ${category})`);
  }
  const cap = toPositiveInt(limit) ?? 100;
  if (limit != null && toPositiveInt(limit) == null) {
    throw new Error(`--limit must be a positive integer (got: ${limit})`);
  }
  const parsed = await runSf(['sobject', 'list', '--sobject', category, '--target-org', orgAlias, '--json']);
  const names = (parsed?.result ?? []).filter((n) => typeof n === 'string');
  const needle = String(term ?? '').toLowerCase();
  const matched = needle ? names.filter((n) => n.toLowerCase().includes(needle)) : names;
  return {
    org: orgAlias,
    term: term ?? null,
    category,
    totalScanned: names.length,
    totalMatched: matched.length,
    truncated: matched.length > cap,
    matches: matched.slice(0, cap),
  };
}

/**
 * Describe an sObject: field inventory + child relationships, summarised from
 * `sf sobject describe --json` to the slice that matters for query authoring.
 *
 * @param {object} [options]
 * @param {string} [options.org]
 * @param {boolean} [options.tooling] - Describe a Tooling API object.
 * @param {string} [options.filter] - Case-insensitive substring filter on field API name/label.
 */
export async function describeSObject(config, name, { org, tooling = false, filter } = {}) {
  const orgAlias = resolveOrg(config, { org });
  if (!name) throw new Error('Provide an sObject API name, e.g. `sfdt soql describe Account`.');
  const args = ['sobject', 'describe', '--sobject', name, '--target-org', orgAlias, '--json'];
  if (tooling) args.push('--use-tooling-api');
  const parsed = await runSf(args);
  const d = parsed?.result;
  if (!d?.name) throw new Error(`Describe for "${name}" returned no result.`);

  const needle = String(filter ?? '').toLowerCase();
  const fields = (d.fields ?? [])
    .filter(
      (f) =>
        !needle ||
        f.name?.toLowerCase().includes(needle) ||
        f.label?.toLowerCase().includes(needle),
    )
    .map((f) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      length: f.length ?? null,
      nillable: !!f.nillable,
      custom: !!f.custom,
      picklistValues: (f.picklistValues ?? []).filter((p) => p.active).map((p) => p.value),
      referenceTo: f.referenceTo ?? [],
      relationshipName: f.relationshipName ?? null,
    }));

  return {
    org: orgAlias,
    name: d.name,
    label: d.label,
    custom: !!d.custom,
    queryable: !!d.queryable,
    keyPrefix: d.keyPrefix ?? null,
    fieldCount: (d.fields ?? []).length,
    filter: filter ?? null,
    fields,
    childRelationships: (d.childRelationships ?? [])
      .filter((r) => r.relationshipName)
      .map((r) => ({
        childSObject: r.childSObject,
        relationshipName: r.relationshipName,
        field: r.field,
      })),
  };
}

/**
 * Relationship discovery for an sObject: parent lookups (reference fields —
 * what you traverse "up" with dot notation) and child relationships (what you
 * traverse "down" with a subquery). Derived from the same describe call.
 *
 * @param {object} [options]
 * @param {string} [options.org]
 * @param {string} [options.direction] - parent | child | both (default both).
 */
export async function discoverRelationships(config, name, { org, direction = 'both' } = {}) {
  if (!['parent', 'child', 'both'].includes(direction)) {
    throw new Error(`--direction must be one of: parent, child, both (got: ${direction})`);
  }
  const described = await describeSObject(config, name, { org });
  const parents = described.fields
    .filter((f) => f.type === 'reference' && f.referenceTo.length > 0)
    .map((f) => ({
      field: f.name,
      relationshipName: f.relationshipName,
      referenceTo: f.referenceTo,
      nillable: f.nillable,
    }));
  const result = { org: described.org, sobject: described.name, direction };
  if (direction !== 'child') result.parents = parents;
  if (direction !== 'parent') result.children = described.childRelationships;
  return result;
}

/**
 * Fetch the org's query plans for a SOQL query via the REST explain endpoint
 * (`/query/?explain=…` through `sf api request rest`, same transport as
 * org-release.js). Read-only; the query is never executed.
 *
 * @param {object} [options]
 * @param {string} [options.org]
 * @param {string} [options.apiVersion] - REST version (default: the project's
 *   sourceApiVersion, else {@link DEFAULT_PLAN_API_VERSION}).
 */
export async function explainQuery(config, soql, { org, apiVersion } = {}) {
  const orgAlias = resolveOrg(config, { org });
  const version = normalizeApiVersion(apiVersion ?? config?.sourceApiVersion) ?? DEFAULT_PLAN_API_VERSION;
  const url = `/services/data/v${version}/query/?explain=${encodeURIComponent(soql)}`;
  // sf colorizes `api request rest` output even without a TTY — force color off
  // so the JSON parses (same caveat as org-release.js).
  const parsed = await runSf(['api', 'request', 'rest', url, '--target-org', orgAlias], {
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    rawStdout: true,
  });
  if (Array.isArray(parsed) && parsed[0]?.errorCode) {
    throw new Error(oneLine(`${parsed[0].errorCode}: ${parsed[0].message}`));
  }
  const plans = (parsed?.plans ?? []).map((p) => ({
    leadingOperationType: p.leadingOperationType,
    relativeCost: p.relativeCost,
    cardinality: p.cardinality,
    sobjectCardinality: p.sobjectCardinality,
    sobjectType: p.sobjectType,
    fields: p.fields ?? [],
    notes: (p.notes ?? []).map((n) => ({ description: n.description, fields: n.fields ?? [], tableEnumOrId: n.tableEnumOrId })),
  }));
  return { org: orgAlias, apiVersion: version, query: soql, plans };
}

function normalizeApiVersion(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return s.includes('.') ? s : `${s}.0`;
}

/**
 * Execute a SOQL query with the row bound enforced (see module doc), returning
 * records plus bound/truncation metadata. Optionally exports the RAW records
 * to a JSON or CSV file.
 *
 * @param {object} [options]
 * @param {string} [options.org]
 * @param {boolean} [options.tooling]
 * @param {boolean} [options.allRows] - Include deleted/archived rows.
 * @param {number|string} [options.limit]
 * @param {string} [options.out] - Export file path.
 * @param {string} [options.format] - json | csv (default: from --out extension, else json).
 */
export async function runQuery(config, soql, { org, tooling = false, allRows = false, limit, out, format } = {}) {
  const orgAlias = resolveOrg(config, { org });
  const local = validateLocal(soql);
  if (local.kind !== 'soql') throw new Error('`soql query` executes SOQL — for SOSL use `sfdt soql sosl`.');
  if (!local.valid) throw new Error(`Invalid SOQL: ${local.errors.join(' ')}`);

  const bounds = resolveBounds(config, limit);
  const bounded = applyLimit(soql, bounds.limit);
  const { records, totalSize, done } = await rawQuery(orgAlias, bounded.query, { tooling, all: allRows });
  const cleaned = records.map(stripAttributes);

  const result = {
    org: orgAlias,
    query: bounded.query,
    requestedQuery: String(soql).trim(),
    bound: { limit: bounded.effectiveLimit, max: bounds.max, action: bounded.action },
    totalSize,
    returned: cleaned.length,
    truncated: !done || totalSize > cleaned.length,
    records: cleaned,
  };
  if (out) result.export = await writeExport(cleaned, { out, format });
  return result;
}

/**
 * Execute a SOSL search with the row bound enforced (SOSL trailing LIMIT),
 * via `sf data search --json`. Optionally exports the raw records.
 */
export async function runSearch(config, sosl, { org, limit, out, format } = {}) {
  const orgAlias = resolveOrg(config, { org });
  const local = validateLocal(sosl);
  if (local.kind !== 'sosl') throw new Error('`soql sosl` executes SOSL (FIND {…}) — for SOQL use `sfdt soql query`.');
  if (!local.valid) throw new Error(`Invalid SOSL: ${local.errors.join(' ')}`);

  const bounds = resolveBounds(config, limit);
  const bounded = applyLimit(sosl, bounds.limit);
  const parsed = await runSf(['data', 'search', '--query', bounded.query, '--target-org', orgAlias, '--json']);
  const records = (parsed?.result?.searchRecords ?? []).map(stripAttributes);

  const result = {
    org: orgAlias,
    query: bounded.query,
    requestedQuery: String(sosl).trim(),
    bound: { limit: bounded.effectiveLimit, max: bounds.max, action: bounded.action },
    returned: records.length,
    records,
  };
  if (out) result.export = await writeExport(records, { out, format });
  return result;
}

/** Drop the sf REST `attributes` wrapper from a record (recursively for subquery results). */
export function stripAttributes(record) {
  if (record == null || typeof record !== 'object') return record;
  if (Array.isArray(record)) return record.map(stripAttributes);
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'attributes') continue;
    if (value != null && typeof value === 'object' && Array.isArray(value.records)) {
      // Nested subquery result: keep the records array, drop paging metadata.
      out[key] = value.records.map(stripAttributes);
    } else if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = stripAttributes(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Render records as RFC-4180 CSV. Nested parent objects flatten to dot paths
 * (`Owner.Name`); array values (subquery results) serialise as JSON strings.
 * Header = union of keys across all records, in first-seen order.
 */
export function toCsv(records) {
  const rows = (records ?? []).map((r) => flattenRecord(r));
  const columns = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  const escape = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map(escape).join(',')];
  for (const row of rows) lines.push(columns.map((c) => escape(row[c])).join(','));
  return `${lines.join('\n')}\n`;
}

function flattenRecord(record, prefix = '') {
  const out = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    const col = prefix ? `${prefix}.${key}` : key;
    if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flattenRecord(value, col));
    } else {
      out[col] = value;
    }
  }
  return out;
}

/**
 * Write records to disk as raw JSON or CSV (never the stdout envelope —
 * on-disk artifacts stay raw, golden principle #6).
 *
 * @returns {Promise<{ file: string, format: 'json'|'csv', rows: number }>}
 */
export async function writeExport(records, { out, format } = {}) {
  const resolvedFormat = (format ?? (out?.toLowerCase().endsWith('.csv') ? 'csv' : 'json')).toLowerCase();
  if (!['json', 'csv'].includes(resolvedFormat)) {
    throw new Error(`--format must be json or csv (got: ${format})`);
  }
  const file = path.resolve(out);
  await fs.ensureDir(path.dirname(file));
  if (resolvedFormat === 'csv') await fs.writeFile(file, toCsv(records), 'utf-8');
  else await fs.writeFile(file, `${JSON.stringify(records, null, 2)}\n`, 'utf-8');
  return { file, format: resolvedFormat, rows: (records ?? []).length };
}

/**
 * Shared execa wrapper for the non-query `sf` calls in this module: runs the
 * command, parses stdout JSON, and rethrows failures with sf's structured
 * message instead of the opaque execa error (same posture as org-query.js).
 */
async function runSf(args, { env, rawStdout = false } = {}) {
  let result;
  try {
    result = env ? await execa('sf', args, { env }) : await execa('sf', args);
  } catch (err) {
    const parsed = safeParse(err.stdout)?.message ? safeParse(err.stdout) : safeParse(err.stderr);
    if (parsed?.message) {
      const e = new Error(oneLine(parsed.message));
      e.stderr = err.stderr;
      throw e;
    }
    throw err;
  }
  const parsed = safeParse(result.stdout);
  if (parsed == null && rawStdout) {
    throw new Error('Unexpected non-JSON response from sf — is the Salesforce CLI up to date?');
  }
  return parsed;
}

function oneLine(s) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
}
