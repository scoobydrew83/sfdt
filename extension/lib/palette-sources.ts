// Pure provider layer for the command palette (P2-2). Turns injected inputs
// (feature gate, feature icons, setup deep-links, custom shortcuts, an optional
// record-Id hint, and a recents list) into an ordered list of categorized
// candidates. No DOM and no chrome.* access — every dependency is passed in, so
// this is trivially unit-testable and the overlay UI (PR-2) is the only thing
// that talks to the browser.

import { isRecordId } from '../features/inspect-record.js';
import type { TabDefinition } from './setup-links.js';

export type PaletteCategory = 'recent' | 'feature' | 'setup' | 'shortcut' | 'record' | 'object';

/**
 * What selecting a candidate should do. Pure data — the overlay (PR-2) turns
 * this into a registry dispatch, a navigation, or an inspector open. No behaviour
 * lives here.
 */
export type PaletteAction =
  | { kind: 'feature'; featureId: string }
  | { kind: 'url'; url: string; newTab: boolean }
  | { kind: 'inspect-record'; recordId: string };

export interface PaletteCandidate {
  /** Stable id, unique across the pool. Also the MRU key (see palette-recents). */
  id: string;
  category: PaletteCategory;
  label: string;
  /** Secondary matchable key (feature id / setup tab id) — fed to fuzzyScoreFields. */
  apiName?: string;
  icon?: string;
  action: PaletteAction;
}

export interface PaletteSection {
  category: PaletteCategory;
  label: string;
  candidates: PaletteCandidate[];
}

/** Inputs to the enabled-for-context filter shared with content.ts's side menu. */
export interface FeatureGate {
  /** getAvailableFeatures() — features whose contexts match the current page. */
  available: readonly string[];
  /** registry.has(id) */
  isRegistered: (id: string) => boolean;
  /** Remote kill-switch set. */
  disabledRemote: ReadonlySet<string>;
  /** (id) => isFeatureEnabled(settings, id) */
  isEnabled: (id: string) => boolean;
}

/**
 * The enabled-for-context feature filter, factored out of content.ts's
 * menuItemsProvider so the side menu and the palette apply the exact same
 * predicate (AC-3): available ∩ registered ∩ !kill-switched ∩ user-enabled.
 */
export function enabledFeatureIds(gate: FeatureGate): string[] {
  return gate.available.filter(
    (id) => gate.isRegistered(id) && !gate.disabledRemote.has(id) && gate.isEnabled(id),
  );
}

/** A user-defined custom shortcut (label → URL). Injected; no storage here. */
export interface CustomShortcut {
  id: string;
  label: string;
  url: string;
  openInNewTab?: boolean;
}

export interface PaletteSourceInputs {
  gate: FeatureGate;
  /** FEATURE_ICONS — icon + label per feature id. */
  featureIcons: Record<string, { icon: string; label: string }>;
  /** Setup deep-link map (from lib/setup-links.ts), already assembled by the caller. */
  setupLinks: readonly TabDefinition[];
  /** Salesforce hostname used to materialise setup-link URLs. */
  hostname: string;
  customShortcuts?: readonly CustomShortcut[];
  /**
   * A candidate record Id extracted from the current page/URL by the caller.
   * Only produces a "record" candidate when it passes isRecordId (so a Setup or
   * list URL fragment never mints a bogus inspect entry).
   */
  recordIdHint?: string;
  /** Most-recently-used candidate ids, most-recent first (from palette-recents). */
  recents?: readonly string[];
}

const CATEGORY_LABELS: Record<PaletteCategory, string> = {
  recent: 'Recent',
  feature: 'Features',
  setup: 'Setup',
  shortcut: 'Shortcuts',
  record: 'This record',
  object: 'Objects',
};

// Order of the non-recent sections.
const SECTION_ORDER: PaletteCategory[] = ['record', 'feature', 'setup', 'shortcut', 'object'];

/**
 * Assemble the categorized palette candidates. Returns sections in display
 * order, with a "Recent" section first (recent-first ordering) resolved from the
 * `recents` id list against the full candidate pool. The "Objects" section is
 * deliberately empty.
 * // TODO(P2-2 PR-2): wire the Objects category to getDescribeCache once P2-1's
 * // lib/describe-cache lands. Do NOT import describe-cache here — it ships in a
 * // separate PR; leaving it lazy keeps this module dependency-free.
 */
export function buildPaletteSources(inputs: PaletteSourceInputs): PaletteSection[] {
  const pool: PaletteCandidate[] = [];
  const enabledIds = enabledFeatureIds(inputs.gate);

  // Record (top when present): a single inspect candidate for a real record Id.
  // Gated on inspect-record being enabled-for-context (not kill-switched /
  // user-disabled) — selecting it opens that feature, so it must respect the same
  // gate as the Features section rather than bypass the kill-switch (AC-3).
  if (
    inputs.recordIdHint &&
    isRecordId(inputs.recordIdHint) &&
    enabledIds.includes('inspect-record')
  ) {
    pool.push({
      id: `record:${inputs.recordIdHint}`,
      category: 'record',
      label: `Inspect record ${inputs.recordIdHint}`,
      apiName: inputs.recordIdHint,
      icon: '🔍',
      action: { kind: 'inspect-record', recordId: inputs.recordIdHint },
    });
  }

  // Features: only the enabled-for-context set (AC-3), rendered via the icon map.
  for (const featureId of enabledIds) {
    const meta = inputs.featureIcons[featureId];
    if (!meta) continue;
    pool.push({
      id: `feature:${featureId}`,
      category: 'feature',
      label: meta.label,
      apiName: featureId,
      icon: meta.icon,
      action: { kind: 'feature', featureId },
    });
  }

  // Setup deep-links, materialised to concrete URLs for the current org.
  for (const tab of inputs.setupLinks) {
    pool.push({
      id: `setup:${tab.id}`,
      category: 'setup',
      label: tab.label,
      apiName: tab.id,
      icon: '📑',
      action: { kind: 'url', url: tab.buildUrl(inputs.hostname), newTab: tab.openInNewTab },
    });
  }

  // Custom shortcuts.
  for (const sc of inputs.customShortcuts ?? []) {
    pool.push({
      id: `shortcut:${sc.id}`,
      category: 'shortcut',
      label: sc.label,
      icon: '⭐',
      action: { kind: 'url', url: sc.url, newTab: sc.openInNewTab ?? false },
    });
  }

  // Objects: intentionally empty stub (see TODO above).

  const byId = new Map(pool.map((c) => [c.id, c]));
  const sections: PaletteSection[] = [];

  // Recent-first: resolve the recents id list against the pool, preserving the
  // recents order and skipping ids no longer present in this context.
  const recentCandidates: PaletteCandidate[] = [];
  const seen = new Set<string>();
  for (const id of inputs.recents ?? []) {
    const c = byId.get(id);
    if (c && !seen.has(id)) {
      recentCandidates.push(c);
      seen.add(id);
    }
  }
  if (recentCandidates.length > 0) {
    sections.push({ category: 'recent', label: CATEGORY_LABELS.recent, candidates: recentCandidates });
  }

  // The remaining category sections, in fixed display order. Candidates already
  // surfaced in "Recent" are not repeated in their home section.
  for (const category of SECTION_ORDER) {
    const candidates = pool.filter((c) => c.category === category && !seen.has(c.id));
    if (candidates.length > 0) {
      sections.push({ category, label: CATEGORY_LABELS[category], candidates });
    }
  }

  return sections;
}
