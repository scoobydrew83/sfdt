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
 * Run a SOQL query against an org and return its records.
 *
 * @param {string} orgAlias - Target org alias.
 * @param {string} soql - SOQL query string.
 * @param {object} [options]
 * @param {boolean} [options.tooling] - Use the Tooling API (`--use-tooling-api`).
 * @param {boolean} [options.all] - Include deleted/archived rows (`--all-rows`).
 * @returns {Promise<Array<object>>} Query records (empty array when none).
 */
export async function query(orgAlias, soql, { tooling = false, all = false } = {}) {
  if (!orgAlias) {
    throw new Error('No org specified — pass --org <alias> or set defaultOrg in .sfdt/config.json');
  }
  const args = [
    'data',
    'query',
    '--query',
    soql,
    '--target-org',
    orgAlias,
    '--json',
  ];
  if (tooling) args.push('--use-tooling-api');
  if (all) args.push('--all-rows');

  let result;
  try {
    result = await execa('sf', args);
  } catch (err) {
    // execa attaches stdout/stderr; sf emits a JSON error envelope on stdout
    // for query failures (e.g. malformed SOQL, missing sObject). Prefer the
    // structured message when present, else re-throw the raw error.
    const parsed = safeParse(err.stdout);
    if (parsed?.message) {
      const e = new Error(parsed.message);
      e.stderr = err.stderr;
      throw e;
    }
    throw err;
  }

  const parsed = safeParse(result.stdout);
  return parsed?.result?.records ?? [];
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
  const records = await query(orgAlias, soql, options);
  // `SELECT COUNT() FROM …` returns no records but a totalSize; for safety we
  // return records.length, and callers that need totalSize use rawQuery.
  return records.length;
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
  if (!orgAlias) {
    throw new Error('No org specified — pass --org <alias> or set defaultOrg in .sfdt/config.json');
  }
  const args = ['data', 'query', '--query', soql, '--target-org', orgAlias, '--json'];
  if (options.tooling) args.push('--use-tooling-api');
  if (options.all) args.push('--all-rows');
  let result;
  try {
    result = await execa('sf', args);
  } catch (err) {
    // Mirror query(): sf emits a JSON error envelope on stdout for query
    // failures (malformed SOQL, missing sObject). Surface the structured
    // message instead of the opaque execa error.
    const parsed = safeParse(err.stdout);
    if (parsed?.message) {
      const e = new Error(parsed.message);
      e.stderr = err.stderr;
      throw e;
    }
    throw err;
  }
  const parsed = safeParse(result.stdout);
  return {
    records: parsed?.result?.records ?? [],
    totalSize: parsed?.result?.totalSize ?? 0,
    done: parsed?.result?.done ?? true,
  };
}

function safeParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
