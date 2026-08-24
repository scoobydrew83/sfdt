import { execa } from 'execa';
import { safeParse } from './org-query.js';

/**
 * The ONE place anything is read out of `sf org display --json`.
 *
 * That command's result carries an `accessToken`. Everywhere else in this CLI,
 * auth is ambient — we shell to `sf` and it joins the session itself, so no
 * token ever enters this process. Two callers genuinely need more than that:
 *
 *   - `getOrgInstanceUrl` needs the host to build Setup deep links. It parses
 *     the result, takes the URL, and lets the rest go out of scope untouched.
 *     No token is returned, so no caller can leak one it never received.
 *   - `getOrgSession` needs the access token, because a CometD long-poll is a
 *     direct HTTP connection this process holds open — `sf` cannot proxy it.
 *
 * Consolidating both here means the security review is one file, not a grep.
 *
 * RULES for anything the second function returns:
 *   - In memory only. Never written to disk, never logged, never placed in the
 *     JSON envelope, a snapshot, or a notification payload.
 *   - `accessToken` / `sessionId` / `sid` are in `SENSITIVE_KEYS`
 *     (`audit-logger.js`), so anything that does reach a log is redacted — that
 *     is the backstop, not the plan.
 *   - Never accept a token as a CLI flag or an env var here. It comes from the
 *     `sf` keychain or it does not come at all, which is what keeps "stored
 *     tokens: 0" true.
 */

/**
 * Run `sf org display --json` and return its parsed `result`.
 *
 * Private on purpose: everything this returns is sensitive, so callers get one
 * of the narrow accessors below instead of the whole object.
 *
 * @param {string} orgAlias
 * @returns {Promise<object>}
 */
async function displayOrg(orgAlias) {
  if (!orgAlias) {
    throw new Error('No org specified — pass --org <alias> or set defaultOrg in .sfdt/config.json');
  }
  let out;
  try {
    out = await execa('sf', ['org', 'display', '--target-org', orgAlias, '--json']);
  } catch (err) {
    // sf writes its structured error envelope to stdout (sometimes stderr).
    // Surface that message rather than execa's opaque one — the common case is
    // "no authorization found for <alias>", which is directly actionable.
    const fromOut = safeParse(err.stdout);
    const parsed = fromOut?.message ? fromOut : safeParse(err.stderr);
    if (parsed?.message) throw new Error(parsed.message);
    throw err;
  }
  const result = safeParse(out.stdout)?.result;
  if (!result) throw new Error(`Could not read org details for "${orgAlias}".`);
  return result;
}

/**
 * The org's instance URL, e.g. `https://acme.my.salesforce.com`.
 *
 * Deliberately returns a string and not the surrounding object: the access
 * token in that object is dropped here rather than handed to a caller that only
 * wanted a hostname for a link.
 *
 * @param {string} orgAlias
 * @returns {Promise<string|null>} Trailing slash stripped, or null when absent.
 */
export async function getOrgInstanceUrl(orgAlias) {
  const result = await displayOrg(orgAlias);
  const url = result.instanceUrl ?? null;
  return url ? String(url).replace(/\/+$/, '') : null;
}

/**
 * The org's access token, instance URL and API version — for the one caller
 * that genuinely needs a token in this process.
 *
 * Everything else in this CLI shells to `sf` and lets it join the session
 * itself, which is why "stored tokens: 0" is true. A CometD long-poll cannot
 * work that way: it is a single HTTP connection held open for minutes, and `sf`
 * has no subcommand that proxies one. So `sfdt events tail` holds a bearer
 * token in memory for the life of the command.
 *
 * What that does and does not change:
 *
 *   - It is read from the `sf` keychain at the moment of use. Nothing is
 *     written, cached to disk, or persisted between runs, so no new secret is
 *     STORED anywhere.
 *   - It is never logged, never placed in the JSON envelope, never put in a
 *     snapshot or a notification payload, and never accepted from a flag or an
 *     env var — it comes from the keychain or it does not come at all.
 *   - `accessToken` / `sessionid` / `sid` are in `SENSITIVE_KEYS`
 *     (`audit-logger.js`) so anything that does reach a log is redacted. That
 *     is the backstop, not the plan.
 *
 * @param {string} orgAlias
 * @returns {Promise<{accessToken: string, instanceUrl: string, apiVersion: string}>}
 */
export async function getOrgSession(orgAlias) {
  const result = await displayOrg(orgAlias);
  const accessToken = result.accessToken ?? null;
  const instanceUrl = result.instanceUrl ?? null;
  if (!accessToken || !instanceUrl) {
    // Say what is missing without echoing any part of what WAS returned.
    throw new Error(
      `No usable session for "${orgAlias}" — \`sf org display\` returned no ${
        accessToken ? 'instance URL' : 'access token'
      }. Re-authenticate with \`sf org login web --alias ${orgAlias}\`.`,
    );
  }
  return {
    accessToken,
    instanceUrl: String(instanceUrl).replace(/\/+$/, ''),
    // `sf` reports this as e.g. "62.0"; the CometD endpoint wants the same
    // number, and the Bayeux client strips a leading `v` if one is present.
    apiVersion: String(result.apiVersion ?? '').trim() || '62.0',
  };
}
