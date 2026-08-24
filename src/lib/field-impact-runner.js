import { analyzeFieldImpact, analyzeFieldUsage, applyPopulation } from '@sfdt/flow-core';
import { query, search, count } from './org-query.js';
import { describeSObject } from './soql-runner.js';
import { getOrgInstanceUrl } from './org-session.js';

/**
 * `sfdt field impact` — "what writes this field?", CLI side.
 *
 * There is deliberately no analysis in this file. The scan — which queries run,
 * what each failure means, and every scope note the answer carries — lives in
 * `@sfdt/flow-core`'s `analyzeFieldImpact`, shared verbatim with the Chrome
 * extension's Field Impact panel. What is here is transport: `sf data query
 * --use-tooling-api` where the browser uses its worker-proxied Tooling client.
 *
 * That split is the point. The notes ARE the product of this feature — they are
 * what separates "no flow writes this field" from "we could not check". Two
 * implementations would inevitably hedge differently about the same org, and a
 * user would have no way to tell which answer to trust.
 */

/**
 * A Salesforce API name, and nothing else.
 *
 * Object and field names go into SOQL as IDENTIFIERS — `FROM ${object}`,
 * `WHERE ${field} != null` — where quoting does not apply and `escapeSoql` has
 * nothing to escape. The only defence is refusing anything that is not shaped
 * like an API name in the first place.
 */
const API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

function assertApiName(value, what) {
  if (!API_NAME_RE.test(String(value ?? ''))) {
    throw new Error(`"${value}" is not a valid ${what} API name.`);
  }
  return value;
}

/** `Account.Region__c` → `{ object, field }`. */
export function parseFieldRef(ref) {
  const raw = String(ref ?? '').trim();
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) {
    throw new Error(`Expected <Object>.<Field>, e.g. Account.Region__c — got "${ref}".`);
  }
  return {
    object: assertApiName(raw.slice(0, dot), 'object'),
    field: assertApiName(raw.slice(dot + 1), 'field'),
  };
}

/**
 * Build the `FieldImpactQueries` implementation the shared scan expects.
 *
 * Both methods let a rejection THROW, which the flow-core contract requires:
 * catching here and returning `[]` would tell the scan "your org has none of
 * these", turning a permissions or licence failure into a clean bill of health.
 * The scan catches them itself and converts each into a note that says which
 * query was refused.
 *
 * @param {string} orgAlias
 * @returns {import('@sfdt/flow-core').FieldImpactQueries}
 */
export function toolingQueriesFor(orgAlias) {
  return {
    toolingQuery: async (soql) => ({ records: await query(orgAlias, soql, { tooling: true }) }),
    toolingSearch: (sosl) => search(orgAlias, sosl, { tooling: true }),
  };
}

/**
 * Run the impact scan for one field.
 *
 * @param {string} orgAlias
 * @param {string} ref - `Object.Field`
 * @param {object} [options]
 * @param {boolean} [options.links] - Resolve the org's instance URL so rows carry
 *   Setup / Flow Builder deep links. Costs one extra `sf` call, so it is opt-in;
 *   without it rows come back with `url: null`, which is honest for a terminal.
 * @returns {Promise<import('@sfdt/flow-core').FieldImpactVM>}
 */
export async function runFieldImpact(orgAlias, ref, { links = false } = {}) {
  const { object, field } = parseFieldRef(ref);
  let origin = '';
  if (links) {
    // A missing instance URL costs deep links, not the scan. Degrading to no
    // links beats failing an analysis the user can still read.
    try {
      origin = (await getOrgInstanceUrl(orgAlias)) ?? '';
    } catch {
      origin = '';
    }
  }
  return analyzeFieldImpact(toolingQueriesFor(orgAlias), { object, field, origin });
}

// --------------------------------------------------------------------------
// `sfdt field usage <Object>` — the object-wide sweep
// --------------------------------------------------------------------------

/**
 * Count non-null values for one field.
 *
 * `COUNT()` returns an empty `records` array with the real number in
 * `totalSize`, which is exactly what `count()` in org-query.js already handles —
 * counting `records.length` here would report 0 for every field.
 *
 * @returns {Promise<number|null>} null when the count could not be taken, which
 *   is NOT the same as zero and must never be folded into one.
 */
async function countPopulated(orgAlias, object, field) {
  try {
    assertApiName(object, 'object');
    assertApiName(field, 'field');
    return await count(orgAlias, `SELECT COUNT() FROM ${object} WHERE ${field} != null`);
  } catch {
    return null;
  }
}

/** Run `tasks` with at most `limit` in flight, preserving input order in the result. */
async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/** Concurrent `COUNT()` queries. Bounded so a wide object cannot flood the org. */
export const POPULATION_CONCURRENCY = 5;

/**
 * Sweep every field on an object for references, and optionally for data.
 *
 * The adjudication — what counts as unreferenced, and what `safeToRemove`
 * requires — is `@sfdt/flow-core`'s. This function supplies the describe, the
 * transport, and the counts.
 *
 * @param {object} config - loaded sfdt config (for `describeSObject`)
 * @param {string} orgAlias
 * @param {string} object - sObject API name
 * @param {object} [options]
 * @param {boolean} [options.population] - Measure non-null counts per field.
 *   Opt-in: it is one query per field.
 * @returns {Promise<import('@sfdt/flow-core').FieldUsageVM>}
 */
export async function runFieldUsage(config, orgAlias, object, { population = false } = {}) {
  assertApiName(object, 'object');
  const described = await describeSObject(config, object, { org: orgAlias });
  const fields = described.fields.map((f) => ({
    name: f.name,
    label: f.label,
    type: f.type,
    custom: f.custom,
    // A describe reports "required" as `nillable: false`.
    required: f.nillable === false,
    unique: f.unique,
  }));

  const vm = await analyzeFieldUsage(toolingQueriesFor(orgAlias), { object, fields });

  if (!population) {
    // Without counts `safeToRemove` stays null on every row, which is the
    // honest answer — so say why, rather than leaving a column of nulls to be
    // read as "no".
    vm.notes.push(
      'Field data was NOT counted (pass --population). Without it no field can be called safe to ' +
        'remove: an unreferenced field may still hold values.',
    );
    return vm;
  }

  // Only fields that could actually be scanned AND came back clean are worth
  // counting — counting the rest would be N queries spent to learn nothing,
  // since a referenced field is not a removal candidate whatever its data says.
  const candidates = vm.rows.filter((r) => r.custom && r.unreferenced === true);
  const populations = await mapWithConcurrency(
    candidates,
    POPULATION_CONCURRENCY,
    async (row) => ({ field: row.name, populated: await countPopulated(orgAlias, object, row.name) }),
  );

  let totalRecords = null;
  try {
    totalRecords = await count(orgAlias, `SELECT COUNT() FROM ${object}`);
  } catch {
    totalRecords = null;
  }

  applyPopulation(vm, populations, { totalRecords });

  const failed = populations.filter((p) => p.populated === null).length;
  if (failed > 0) {
    vm.notes.push(
      `${failed} population count(s) failed. Those fields are NOT reported as safe to remove — a ` +
        'count that did not run is not a count of zero.',
    );
  }
  if (totalRecords === 0) {
    // Every count is trivially zero, so "empty" says nothing about the field.
    vm.notes.push(
      `${object} has no records at all, so every field counts zero. That is a fact about the ` +
        'object, not evidence about any field.',
    );
  }
  return vm;
}
