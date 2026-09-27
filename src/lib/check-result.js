import { safeParse } from './org-query.js';

/**
 * Shared result builders for the org-health check runners (audit-runner.js,
 * monitor-runner.js). Every check returns the same normalised shape so all
 * surfaces — CLI, GUI, bridge/Chrome, MCP — render uniformly:
 *
 *   { id, title, status: 'ok'|'warn'|'fail'|'error', summary, findings: [...] }
 *
 * These helpers used to be copied verbatim into both runners; they live here so
 * the two cannot drift.
 */

export function result(id, title, status, summary, findings) {
  return { id, title, status, summary, findings };
}

/** Collapse a message to one line, capped so a stack dump can't flood a summary. */
export function oneLine(s) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 300);
}

// sf emits a JSON error envelope (e.g. auth failure, invalid org alias) usually
// on stdout, but some commands route it to stderr — check both, and prefer its
// structured `message` over the opaque execa error string.
function structuredMessage(err) {
  return safeParse(err?.stdout)?.message ?? safeParse(err?.stderr)?.message;
}

/** Hard failure: the check could not run. */
export function errored(id, title, err) {
  return {
    id,
    title,
    status: 'error',
    summary: `Check failed: ${oneLine(structuredMessage(err) || err?.message)}`,
    findings: [],
  };
}

/**
 * Soft failure for checks that query a Beta / license-gated / permission-gated
 * object (e.g. MetadataComponentDependency, ConnectedApplication): a query
 * failure there usually means "this org can't run the check", not "the org is
 * broken". Surface a `warn` so `audit all` / `monitor all` don't exit non-zero
 * (red CI) over a missing API, while never reading as a clean `ok`.
 */
export function degraded(id, title, err, what) {
  return {
    id,
    title,
    status: 'warn',
    summary: `${what} unavailable in this org: ${oneLine(structuredMessage(err) || err?.message)}`,
    findings: [],
  };
}

/** Status rollup shared by every runner's snapshot `summary`. */
export function summarize(results) {
  const count = (status) => results.filter((r) => r.status === status).length;
  return {
    total: results.length,
    ok: count('ok'),
    warn: count('warn'),
    fail: count('fail'),
    error: count('error'),
  };
}
