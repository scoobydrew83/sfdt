// TraceFlag lifecycle — the Salesforce rules, in one place.
//
// Two features arm trace flags for different reasons: features/trace-flags.ts
// manages them as a tool, and features/apex-anonymous.ts arms one so that
// Execute Anonymous can capture its own debug log. Both had grown their own
// copy of `traceFlagWindow` and `traceFlagCreatePayload` — byte-identical, down
// to the back-dating buffer — plus their own `TRACE_FLAG_DURATION_MS`.
//
// That is not a styling duplication, it is a PLATFORM CONSTRAINT duplicated.
// The 24h cap is Salesforce's, not ours; if it ever changes, or if we get the
// window wrong, two files have to be found and only one will be. The rules
// live here now and nothing else may restate them.
//
// Everything is pure and takes `nowMs`, so the dates are deterministic in tests
// rather than depending on when the suite runs.

/**
 * A DEVELOPER_LOG trace flag may span at most 24h from its StartDate.
 * Salesforce rejects a longer window outright.
 */
export const TRACE_FLAG_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * Back-date the start by a minute.
 *
 * Client and server clocks disagree by seconds in practice. Without the buffer
 * a StartDate computed from a slightly-fast browser clock lands "in the future"
 * for the org, and Salesforce rejects the create — an intermittent failure that
 * looks like a permissions problem.
 */
export const TRACE_FLAG_START_BUFFER_MS = 60 * 1000;

export interface TraceFlagWindow {
  StartDate: string;
  ExpirationDate: string;
}

/** A 24h-capped window from a back-dated start. */
export function traceFlagWindow(nowMs: number): TraceFlagWindow {
  const start = nowMs - TRACE_FLAG_START_BUFFER_MS;
  return {
    StartDate: new Date(start).toISOString(),
    ExpirationDate: new Date(start + TRACE_FLAG_DURATION_MS).toISOString(),
  };
}

/**
 * Body for creating a DEVELOPER_LOG flag against an entity.
 *
 * `entityId` is a User for both current callers, but Salesforce also traces
 * classes and triggers — hence the neutral name.
 */
export function traceFlagCreatePayload(
  entityId: string,
  debugLevelId: string,
  nowMs: number,
): Record<string, string> {
  return {
    TracedEntityId: entityId,
    DebugLevelId: debugLevelId,
    LogType: 'DEVELOPER_LOG',
    ...traceFlagWindow(nowMs),
  };
}

/**
 * Renew = push the whole window forward.
 *
 * BOTH dates move, deliberately. Extending only ExpirationDate against a stale
 * StartDate is the obvious implementation and it breaches the 24h cap the
 * moment the flag is more than a moment old.
 */
export function renewTraceFlagPayload(nowMs: number): TraceFlagWindow {
  return traceFlagWindow(nowMs);
}

/**
 * Is this flag still live?
 *
 * Tolerates a missing or unparseable ExpirationDate by reporting NOT active —
 * the caller's next move is to create one, and a spurious "active" would leave
 * the user with no logs and no explanation.
 */
export function traceFlagIsActive(
  row: { ExpirationDate?: string } | undefined | null,
  nowMs: number,
): boolean {
  if (!row?.ExpirationDate) return false;
  const exp = Date.parse(row.ExpirationDate);
  return Number.isFinite(exp) && exp > nowMs;
}
