// A bounded, local-only log of what you actually ran — the data behind the
// Workspace Overview's "Recent activity" panel.
//
// Same bucket and rationale as lib/palette-recents.ts (chrome.storage.local,
// origin-isolated, never synced, never transmitted). The difference is what it
// holds: palette-recents stores command IDs only, which is useless for an
// activity view — no timestamp, no outcome, no idea *what* was queried.
//
// PRIVACY — this is the one local store that can hold Salesforce data.
// A SOQL `WHERE` clause can contain customer PII (`WHERE Email = '…'`), so:
//   - `resource` is truncated hard (RESOURCE_MAX) — enough to recognise a run,
//     not enough to be a data export;
//   - the log is bounded to MAX_ENTRIES and clearable from the Overview;
//   - `settings.activityLog.enabled` turns it off entirely, and recordActivity()
//     writes nothing when it's off;
//   - it is documented in PRIVACY.md alongside the other local keys.
// Never put a query RESULT in here — only the statement/target that was run.
//
// Like telemetry, recording must never break the thing being recorded: every
// entry point swallows its own errors (golden principle #5).

import { loadSettings } from './settings.js';
import { storageGet, storageSet, storageRemove } from './storage.js';

const ACTIVITY_KEY = 'sfdt.activity';

/** Ring-buffer bound. ~100 rows is more than the Overview ever shows. */
export const MAX_ENTRIES = 100;

/** Hard cap on the stored `resource` string. See the privacy note above. */
export const RESOURCE_MAX = 120;

/**
 * Outcome of a run. Deliberately only terminal states: every writer records
 * once, on completion, with the result it got. An in-flight 'running' state
 * would need entry identity and a second write to resolve it — no caller needs
 * that yet.
 */
export type ActivityStatus = 'success' | 'failed';

export interface ActivityEntry {
  /** Epoch ms. Set by recordActivity(); callers don't pass it. */
  ts: number;
  /** Feature registry id — the key into FEATURE_ICONS / ICON_FOR_FEATURE. */
  featureId: string;
  /** Human label for the operation, e.g. 'SOQL Query', 'Deploy'. */
  action: string;
  /** What it acted on — statement, class name, package target. Truncated. */
  resource?: string;
  status: ActivityStatus;
}

/** What a caller supplies; the timestamp is stamped on write. */
export type ActivityInput = Omit<ActivityEntry, 'ts'>;

/**
 * Truncate to `max` characters with a single-character ellipsis, collapsing
 * whitespace first so a pretty-printed multi-line SOQL statement reads as one
 * line in the table (and so newlines can't pad past the cap).
 *
 * Exported for the test — the cap is a privacy control, not cosmetics.
 */
export function truncateResource(value: string, max = RESOURCE_MAX): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Pure newest-first insert with a bound. Exported so the ring-buffer rule is
 * testable without touching storage (same split as mergeRecent).
 */
export function mergeEntry(
  list: readonly ActivityEntry[],
  entry: ActivityEntry,
  max = MAX_ENTRIES,
): ActivityEntry[] {
  return [entry, ...list].slice(0, max);
}

/** Reject anything that didn't come out of this module (corrupt/older shape). */
function isEntry(value: unknown): value is ActivityEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Partial<ActivityEntry>;
  return (
    typeof e.ts === 'number' &&
    typeof e.featureId === 'string' &&
    typeof e.action === 'string' &&
    (e.status === 'success' || e.status === 'failed') &&
    (e.resource === undefined || typeof e.resource === 'string')
  );
}

export async function loadActivity(): Promise<ActivityEntry[]> {
  const raw = await storageGet(ACTIVITY_KEY);
  return Array.isArray(raw) ? raw.filter(isEntry) : [];
}

/**
 * Append a run to the log. No-ops when the user has switched the log off, and
 * never throws — a failed write must not take down the tool that succeeded.
 */
export async function recordActivity(input: ActivityInput, now = Date.now()): Promise<void> {
  try {
    const settings = await loadSettings();
    if (settings.activityLog?.enabled === false) return;

    const entry: ActivityEntry = {
      ts: now,
      featureId: input.featureId,
      action: input.action,
      status: input.status,
      ...(input.resource === undefined
        ? {}
        : { resource: truncateResource(input.resource) }),
    };
    await storageSet(ACTIVITY_KEY, mergeEntry(await loadActivity(), entry));
  } catch {
    // Recording is never load-bearing.
  }
}

/** Wipe the log. Surfaced as the "Clear" action on the Overview panel. */
export async function clearActivity(): Promise<void> {
  await storageRemove(ACTIVITY_KEY);
}
