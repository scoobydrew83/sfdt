// P2-2 — the command palette registry feature + its opener.
//
// This module holds two things:
//  1. createCommandPaletteFeature() — a metadata-only registry feature (like
//     context-menu-inspect) so the palette gets an options toggle, a kill-switch
//     id, and a checked-in feature-manifests.json entry. It injects no UI itself.
//  2. createPaletteOpener() — the glue that assembles the palette's inputs from
//     the live registry / settings / describe cache and hands them to the overlay
//     (ui/command-palette.ts). Kept here (not in content.ts) so the content-script
//     diff stays a few lines: build the opener once, call open() from the two
//     entry points (the open-palette keyboard command + the ⚡ menu's
//     "View all features" entry).
//
// The SID never touches this code: the Objects category reads the shared describe
// cache, which fetches through the worker proxy.

import { CONTEXTS, extractRecordContext } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi } from '../lib/salesforce-api.js';
import {
  getDescribeCache,
  type DescribeCache,
  type GlobalDescribe,
} from '../lib/describe-cache.js';
import { AUTOMATION_HOME_TAB, BASE_TABS } from '../lib/setup-links.js';
import { setupHostname } from '../lib/hostname.js';
import { FEATURE_ICONS } from '../lib/feature-icons.js';
import { loadRecents, pushRecent } from '../lib/palette-recents.js';
import { enabledFeatureIds, type FeatureGate } from '../lib/palette-sources.js';
import { openCommandPalette, type PaletteObject } from '../ui/command-palette.js';

/** Settings / kill-switch id — the feature-registry key. */
export const COMMAND_PALETTE_ID = 'command-palette';

// Registry feature — metadata only. The overlay is opened imperatively from
// content.ts (keyboard command + ⚡ "View all features"), not by dispatch, so
// there is no init/onActivate. Listing every real page context keeps the palette
// available (enabled-for-context) on any Salesforce page.
export function createCommandPaletteFeature(): Feature {
  return {
    manifest: {
      id: COMMAND_PALETTE_ID,
      name: 'Command Palette',
      contexts: [
        CONTEXTS.SETUP_FLOWS,
        CONTEXTS.FLOW_DETAILS,
        CONTEXTS.FLOW_BUILDER,
        CONTEXTS.COMPARE_FLOWS,
        CONTEXTS.FLOW_TRIGGER_EXPLORER,
        CONTEXTS.SETUP_OTHER,
        CONTEXTS.RECORD_PAGE,
      ],
    },
  };
}

export interface PaletteOpenerDeps {
  /** Live enabled-for-context gate — the same predicate the ⚡ menu applies. */
  getGate: () => FeatureGate;
  /** Current Salesforce hostname (window.location.hostname). */
  getHostname: () => string;
  /** Dispatch a registry feature's activate action. */
  activateFeature: (featureId: string) => void | Promise<void>;
  /** Open the record inspector for an Id (inspect-record.openFor). */
  inspectRecord: (recordId: string) => void | Promise<void>;
  /**
   * Open the schema browser for an object, when that feature is registered
   * (a concurrent PR is adding it). GUARDED on presence — when absent, an object
   * selection falls back to the Object Manager page instead. Do not hard-import.
   */
  openSchemaBrowser?: (objectName: string) => void | Promise<void>;
  doc?: Document;
  win?: Window;
}

export interface PaletteOpener {
  /** True when the palette is enabled-for-context (registered ∩ !kill-switched ∩ user-enabled). */
  isEnabled: () => boolean;
  /** Open the palette. Async only because recents load from chrome.storage.local
   *  (a local read, not a Salesforce api call — AC-1 stays satisfied). */
  open: () => Promise<void>;
}

// Resolve the global (REST) describe once, waiting for the shared cache to fill.
// Returns [] on error so the Objects section is simply omitted, never a throw.
function describeGlobal(cache: DescribeCache): Promise<GlobalDescribe['sobjects']> {
  const read = () => cache.getGlobal('rest');
  const first = read();
  if (first.status === 'ready') return Promise.resolve(first.data?.sobjects ?? []);
  if (first.status === 'error') return Promise.resolve([]);
  return new Promise((resolve) => {
    const unsub = cache.subscribe(() => {
      const entry = read();
      if (entry.status === 'ready') {
        unsub();
        resolve(entry.data?.sobjects ?? []);
      } else if (entry.status === 'error') {
        unsub();
        resolve([]);
      }
    });
  });
}

export function createPaletteOpener(deps: PaletteOpenerDeps): PaletteOpener {
  const win = deps.win ?? window;

  const isEnabled = (): boolean =>
    enabledFeatureIds(deps.getGate()).includes(COMMAND_PALETTE_ID);

  const navigate = (url: string, newTab: boolean): void => {
    if (newTab) win.open(url, '_blank', 'noopener');
    else win.location.assign(url);
  };

  const openObject = (objectName: string): void => {
    if (deps.openSchemaBrowser) {
      void deps.openSchemaBrowser(objectName);
      return;
    }
    // Fallback: the object's Object Manager page.
    const host = setupHostname(deps.getHostname());
    navigate(
      `https://${host}/lightning/setup/ObjectManager/${encodeURIComponent(objectName)}/Details/view`,
      false,
    );
  };

  const loadObjects = async (): Promise<PaletteObject[]> => {
    const sobjects = await describeGlobal(getDescribeCache(getSalesforceApi()));
    return sobjects
      .filter((s) => Boolean(s.name))
      .map((s) => ({ name: s.name, label: s.label || s.name }));
  };

  const open = async (): Promise<void> => {
    // Recents are a local-storage read (not a Salesforce api call); loading them
    // before first paint keeps recent-first ordering without a re-render.
    const recents = await loadRecents();
    const recordIdHint = extractRecordContext(win.location.href)?.recordId;
    openCommandPalette({
      sourceInputs: {
        gate: deps.getGate(),
        featureIcons: FEATURE_ICONS,
        setupLinks: [...BASE_TABS, AUTOMATION_HOME_TAB],
        hostname: deps.getHostname(),
        recordIdHint,
        recents,
      },
      loadObjects,
      executors: {
        activateFeature: deps.activateFeature,
        navigate,
        inspectRecord: deps.inspectRecord,
        openObject,
      },
      onExecute: (id) => pushRecent(id),
      doc: deps.doc,
      win,
    });
  };

  return { isEnabled, open };
}
