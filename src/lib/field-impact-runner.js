import { analyzeFieldImpact } from '@sfdt/flow-core';
import { query, search } from './org-query.js';
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

/** `Account.Region__c` → `{ object, field }`. */
export function parseFieldRef(ref) {
  const raw = String(ref ?? '').trim();
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) {
    throw new Error(`Expected <Object>.<Field>, e.g. Account.Region__c — got "${ref}".`);
  }
  return { object: raw.slice(0, dot), field: raw.slice(dot + 1) };
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
