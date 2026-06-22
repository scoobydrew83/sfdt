/**
 * Org-health finding rendering — shared across surfaces.
 *
 * `sfdt audit` / `sfdt monitor` emit findings as loosely-typed bags whose shape
 * depends on which check produced them (deprecated API versions, inactive
 * users, audit-trail entries, failed Apex jobs, license usage, governor limits,
 * the security health-check score, backup batch errors). This single function
 * turns any of those into a one-line description.
 *
 * It lives in flow-core (zero-dependency, browser-safe) so the CLI report, the
 * GUI dashboard, and the Chrome extension all render findings identically and
 * can never drift apart — historically each surface kept its own copy and they
 * diverged (e.g. licenses emit `total` while limits emit `max`).
 */

/** Coerce an unknown bag value to a string, or undefined when null/absent. */
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : v == null ? undefined : String(v);
}

export function describeFinding(f: Record<string, unknown>): string {
  // Deprecated API versions: { type, name, apiVersion }
  if (f.name != null && f.apiVersion != null) {
    return `${f.type ? `${str(f.type)} ` : ''}${str(f.name)} (API ${str(f.apiVersion)})`;
  }
  // Inactive / MFA users: { username, name?, lastLogin? }
  if (f.username != null) {
    return `${str(f.name) ?? str(f.username)} <${str(f.username)}>${f.lastLogin ? ` — last login ${str(f.lastLogin)}` : ''}`;
  }
  // Setup audit trail: { date, action, section, user }
  if (f.action != null) return `${str(f.date)}: ${str(f.action)} (${str(f.section)}) by ${str(f.user)}`;
  // Failed async Apex jobs: { date, job, type, errors, status? (ExtendedStatus) }
  if (f.job != null) {
    const detail = f.status ? ` — ${str(f.status)}` : '';
    return `${str(f.date)}: ${str(f.job)} (${str(f.type)}) — ${str(f.errors)} error(s)${detail}`;
  }
  // License usage emits `total`; governor limits emit `max` (with a `ratio`).
  // Accept either denominator and append the percentage when a ratio is present.
  const denom = f.max ?? f.total;
  if (f.name != null && denom != null) {
    const pct = f.ratio != null ? ` (${Math.round(Number(f.ratio) * 100)}%)` : '';
    return `${str(f.name)}: ${str(f.used)}/${str(denom)}${pct}`;
  }
  // Security health-check score: { score, floor }
  if (f.score != null) return `score ${str(f.score)}% (floor ${str(f.floor)}%)`;
  // Backup batch error: { batch, error }
  if (f.error != null) return String(f.error);
  if (f.name != null) return String(f.name);
  return JSON.stringify(f);
}
