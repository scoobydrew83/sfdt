import { execa } from 'execa';
import { safeParse } from './org-query.js';

/**
 * Generic Salesforce REST transport over `sf api request rest`.
 *
 * Extracted from apexguru-runner.js, which had the only copy: the same helper
 * is what a record read/write needs, and a second copy would have been a second
 * place to forget the NO_COLOR workaround below.
 *
 * Why `sf api request rest` rather than fetch: it inherits the org session the
 * user already has, so nothing here handles a credential, opens a socket, or
 * adds a dependency — the same reason soql-runner.js reaches for it.
 */

/**
 * Call a Salesforce REST endpoint through the sf CLI.
 *
 * @param {string} orgAlias    Target org alias.
 * @param {string} urlPath     Path beginning `/services/data/...`.
 * @param {object} [opts]
 * @param {string} [opts.method='GET']
 * @param {unknown} [opts.body] JSON-serialised when present.
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<any>} Parsed JSON, or null for an empty body (a 204 from a
 *   PATCH or DELETE returns nothing — that is success, not failure).
 */
export async function orgRest(orgAlias, urlPath, { method = 'GET', body, timeoutMs } = {}) {
  const args = ['api', 'request', 'rest', urlPath, '--target-org', orgAlias];
  if (method !== 'GET') args.push('--method', method);
  if (body !== undefined) args.push('--body', JSON.stringify(body));
  // sf colorizes this command's output even without a TTY, which breaks
  // JSON.parse. Same workaround as detectOrgRelease in org-release.js.
  const opts = { env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } };
  if (timeoutMs) opts.timeout = timeoutMs;
  const resp = await execa('sf', args, opts);
  return safeParse(resp.stdout);
}

/**
 * The friendliest message out of a failed `sf api request rest` call.
 *
 * Salesforce REST errors arrive as `[{ message, errorCode }]`, sf CLI errors as
 * `{ message }` — check stdout then stderr, then fall back to execa's own
 * message (e.g. ENOENT when the sf CLI itself is missing).
 */
export function restErrorMessage(err) {
  for (const raw of [err?.stdout, err?.stderr]) {
    const parsed = safeParse(raw);
    const message = Array.isArray(parsed) ? parsed[0]?.message : parsed?.message;
    if (message) return message;
  }
  return err?.shortMessage || err?.message || 'unknown error';
}

/**
 * The structured error records Salesforce returns on a rejected write.
 *
 * `[{ message, errorCode, fields }]` — `fields` is the only thing that says
 * WHICH field the org refused, and it is what flow-core's `mapSaveErrors` needs
 * to put an error on the exact field rather than in a general-purpose blob.
 * Returns [] when the body is not that shape.
 */
export function restErrorDetails(err) {
  for (const raw of [err?.stdout, err?.stderr]) {
    const parsed = safeParse(raw);
    if (!Array.isArray(parsed)) continue;
    const details = parsed
      .filter((d) => d && typeof d === 'object' && typeof d.message === 'string')
      .map((d) => ({
        message: d.message,
        errorCode: typeof d.errorCode === 'string' ? d.errorCode : '',
        fields: Array.isArray(d.fields) ? d.fields.filter((f) => typeof f === 'string' && f) : [],
      }));
    if (details.length) return details;
  }
  return [];
}
