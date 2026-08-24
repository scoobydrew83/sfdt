// Record deletion — a CAPABILITY feature, not a UI one.
//
// This file injects nothing. It exists so deleting a record has its own feature
// id, and it has its own id for one reason: AC-4 requires delete to be
// kill-switchable independently of the inspector it lives in.
//
// The remote kill switch is a list of FEATURE IDS and nothing else
// (entrypoints/content.ts feeds it from `bridge.getServerInfo().disabledFeatures`).
// A boolean tucked inside `featureSettings['inspect-record']` would be
// local-only and could never be killed remotely — so a sub-flag fails the
// criterion outright, however tidy it looks. The shape here follows
// features/context-menu-inspect.ts, which proves the pattern: a metadata-only
// manifest plus a pure gate, with the behaviour living in whichever surface
// asks the gate.
//
// `enabledByDefault: false` IS the entire opt-in mechanism. It needs no
// settings-layer machinery, because the runtime already honours the manifest
// flag (lib/feature-defaults.ts, via isFeatureEnabled) — so declaring it false
// is genuinely off until the user ticks the row on the options page. Deleting a
// Salesforce record is irreversible and nothing else in the inspector is, which
// is why this one ships off while everything around it ships on.

import type { Feature } from '../lib/feature-registry.js';
import { CONTEXTS } from '../lib/context-detector.js';
import { isFeatureEnabled, type Settings } from '../lib/settings.js';

export const RECORD_DELETE_ID = 'record-delete';

/**
 * Pure gate: delete is available only when the user has opted in AND the remote
 * kill switch has not disabled it.
 *
 * Pure (no storage reads) so the truth table is testable without a browser, and
 * so the two conditions cannot drift apart in a caller that remembers one.
 */
export function isRecordDeleteEnabled(
  settings: Settings,
  disabledRemote: readonly string[] | ReadonlySet<string>,
): boolean {
  // Callers hold this as an array in some places and a Set in others
  // (content.ts keeps a Set); accept both rather than make every call site
  // convert, which is the kind of chore a caller eventually skips.
  const killed = Array.isArray(disabledRemote)
    ? disabledRemote.includes(RECORD_DELETE_ID)
    : (disabledRemote as ReadonlySet<string>).has(RECORD_DELETE_ID);
  return isFeatureEnabled(settings, RECORD_DELETE_ID) && !killed;
}

/**
 * Registry feature — metadata only.
 *
 * No `onActivate`: there is nothing to activate. It contributes no icon either,
 * which keeps it out of the ⚡ menu and the command palette for free, since both
 * filter their candidates through FEATURE_ICONS. The only thing that reads this
 * feature is the inspector, through the gate above.
 */
export function createRecordDeleteFeature(): Feature {
  return {
    manifest: {
      id: RECORD_DELETE_ID,
      name: 'Delete records (opt-in)',
      contexts: [
        CONTEXTS.SETUP_FLOWS,
        CONTEXTS.SETUP_OTHER,
        CONTEXTS.FLOW_BUILDER,
        CONTEXTS.FLOW_TRIGGER_EXPLORER,
        CONTEXTS.RECORD_PAGE,
      ],
      enabledByDefault: false,
    },
  };
}
