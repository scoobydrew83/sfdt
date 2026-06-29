/**
 * Shared severity helpers for the normalised check shape used across audit,
 * monitor, and any future health-style runner:
 *
 *   { id, title, status: 'ok'|'warn'|'fail'|'error', summary, findings: [...] }
 *
 * Centralised here so the notifier (per-channel severity routing) and any
 * snapshot exit-code logic agree on a single ordering. `fail` ranks above
 * `error`: an `error` means a check could not run (often a transient/permission
 * issue), whereas `fail` is a confirmed bad state — escalate the confirmed
 * problem highest.
 */

export const STATUS_RANK = { ok: 0, warn: 1, error: 2, fail: 3 };

const VALID = new Set(Object.keys(STATUS_RANK));

/**
 * Numeric rank for a status string. Unknown/missing statuses rank as `ok` (0)
 * so a malformed check never silently escalates a notification.
 */
export function rankStatus(status) {
  return STATUS_RANK[status] ?? 0;
}

/**
 * Highest-severity status across a list of checks (or raw status strings).
 * Returns 'ok' for an empty/missing list.
 *
 * @param {Array<{status?: string}|string>} checks
 * @returns {'ok'|'warn'|'fail'|'error'}
 */
export function maxStatus(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return 'ok';
  let worst = 'ok';
  for (const c of checks) {
    const status = typeof c === 'string' ? c : c?.status;
    if (status && VALID.has(status) && rankStatus(status) > rankStatus(worst)) {
      worst = status;
    }
  }
  return worst;
}

/**
 * True when `status` is at or above the `threshold` severity. Used by the
 * notifier to decide whether a channel should receive a given snapshot.
 */
export function meetsThreshold(status, threshold) {
  return rankStatus(status) >= rankStatus(threshold);
}
