import { execa } from 'execa';

/**
 * Thin SOQL helper over the Salesforce CLI (`sf data query --json`).
 *
 * Centralises the execa plumbing, JSON parsing, and Tooling-API toggle used by
 * the monitor and audit runners so individual checks stay declarative. Each
 * caller supplies a SOQL string and receives the plain `records` array back.
 *
 * Mirrors the conventions in org-inventory.js: shells `sf`, parses stdout JSON,
 * and surfaces the org alias safely in error messages.
 */

/**
 * Shared execa core for query()/rawQuery(): builds the `sf data query` argv,
 * runs it, and returns the parsed `result` object. On failure, sf emits a JSON
 * error envelope on stdout (malformed SOQL, missing sObject) — surface that
 * structured message instead of the opaque execa error.
 *
 * @param {string} orgAlias
 * @param {string} soql
 * @param {object} [options]
 * @param {boolean} [options.tooling]
 * @param {boolean} [options.all]
 * @returns {Promise<object|null>} The parsed sf `result` object (or null).
 */
async function _execQuery(orgAlias, soql, { tooling = false, all = false } = {}) {
  if (!orgAlias) {
    throw new Error('No org specified — pass --org <alias> or set defaultOrg in .sfdt/config.json');
  }
  const args = ['data', 'query', '--query', soql, '--target-org', orgAlias, '--json'];
  if (tooling) args.push('--use-tooling-api');
  if (all) args.push('--all-rows');

  let result;
  try {
    result = await execa('sf', args);
  } catch (err) {
    // sf usually writes its JSON error envelope to stdout, but some commands
    // route it to stderr — check both for the structured message.
    const parsed = safeParse(err.stdout) ?? safeParse(err.stderr);
    if (parsed?.message) {
      const e = new Error(parsed.message);
      e.stderr = err.stderr;
      throw e;
    }
    throw err;
  }
  return safeParse(result.stdout)?.result ?? null;
}

/**
 * Run a SOQL query against an org and return its records.
 *
 * @param {string} orgAlias - Target org alias.
 * @param {string} soql - SOQL query string.
 * @param {object} [options]
 * @param {boolean} [options.tooling] - Use the Tooling API (`--use-tooling-api`).
 * @param {boolean} [options.all] - Include deleted/archived rows (`--all-rows`).
 * @returns {Promise<Array<object>>} Query records (empty array when none).
 */
export async function query(orgAlias, soql, options = {}) {
  const result = await _execQuery(orgAlias, soql, options);
  return result?.records ?? [];
}

/**
 * Run a query and return only the total record count without materialising
 * every row. Uses `COUNT()` semantics when the SOQL is a count query, otherwise
 * falls back to the length of the returned records.
 *
 * @param {string} orgAlias
 * @param {string} soql
 * @param {object} [options]
 * @returns {Promise<number>}
 */
export async function count(orgAlias, soql, options = {}) {
  // Use rawQuery and return totalSize: a `SELECT COUNT() FROM …` query returns
  // an empty `records` array with the real count in `totalSize`, so counting
  // records.length would always yield 0. totalSize is also correct for normal
  // (non-aggregate) queries.
  const { totalSize } = await rawQuery(orgAlias, soql, options);
  return totalSize;
}

/**
 * Run a query and return the full parsed `result` object (records + totalSize +
 * done), for callers that need pagination metadata or COUNT() totals.
 *
 * @param {string} orgAlias
 * @param {string} soql
 * @param {object} [options]
 * @returns {Promise<{records: Array<object>, totalSize: number, done: boolean}>}
 */
export async function rawQuery(orgAlias, soql, options = {}) {
  const result = await _execQuery(orgAlias, soql, options);
  return {
    records: result?.records ?? [],
    totalSize: result?.totalSize ?? 0,
    done: result?.done ?? true,
  };
}

export function safeParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
