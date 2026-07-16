// P1-8 — right-click "Inspect this record".
//
// chrome.contextMenus is only available in the service worker, so the menu is
// created and its click handled in entrypoints/background.ts. This module holds
// the worker-agnostic pieces: the menu constants, the Salesforce URL patterns
// that scope the menu to our hosts, the pure click→record-Id planner, and the
// registry feature manifest (metadata only — no injected content-script UI, so
// no init/onActivate). The manifest gives the feature an options toggle, a
// kill-switch id, and a checked-in feature-manifests.json entry like any other
// feature; the SID never leaves the worker — the click handler only forwards a
// record Id for inspect-record to fetch through the worker proxy.

import { CONTEXTS, extractRecordContext } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';

/** Settings / kill-switch id — the feature-registry key. */
export const CONTEXT_MENU_INSPECT_ID = 'context-menu-inspect';

/** chrome.contextMenus item id. */
export const INSPECT_MENU_ITEM_ID = 'sfdt-inspect-record';

export const INSPECT_MENU_TITLE = 'SFDT: Inspect this record';

// The menu shows only on these Salesforce hosts — the same set the content
// script (entrypoints/content.ts) injects on — so a click always has a content
// script listening to open the inspect-record modal. Used for both
// documentUrlPatterns (page context) and targetUrlPatterns (link context).
export const INSPECT_MENU_URL_PATTERNS = [
  'https://*.salesforce.com/*',
  'https://*.salesforce-setup.com/*',
  'https://*.my.salesforce.com/*',
  'https://*.lightning.force.com/*',
] as const;

export interface InspectClickInfo {
  /** The right-clicked link's href, when the click was on a link. */
  linkUrl?: string;
  /** The page URL the click happened on. */
  pageUrl?: string;
}

export interface InspectTarget {
  recordId: string;
  sobjectName?: string;
}

// Pure and testable: prefer the right-clicked link's target, then fall back to
// the page URL. Returns null when neither carries a 15/18-char Salesforce
// record Id — AC2: only act when an Id is actually present.
export function planInspectFromClick(info: InspectClickInfo): InspectTarget | null {
  for (const url of [info.linkUrl, info.pageUrl]) {
    if (typeof url !== 'string' || url.length === 0) continue;
    const ctx = extractRecordContext(url);
    if (ctx) return { recordId: ctx.recordId, sobjectName: ctx.sobjectName };
  }
  return null;
}

/** The message the worker forwards to the content script on a menu click. */
export interface InspectRecordMessage {
  action: 'inspectRecord';
  recordId: string;
  sobjectName?: string;
}

// Pure menu→inspect-record wiring: turn a click into the message the content
// script's inspectRecord handler expects, or null when there is no record Id to
// act on (menu does nothing — AC2).
export function buildInspectMenuMessage(info: InspectClickInfo): InspectRecordMessage | null {
  const target = planInspectFromClick(info);
  if (!target) return null;
  return { action: 'inspectRecord', recordId: target.recordId, sobjectName: target.sobjectName };
}

// Registry feature — metadata only. The actual menu lives in the service
// worker; declaring the `contextMenus` permission here lets the registry skip
// the feature if the manifest ever loses the permission.
export function createContextMenuInspectFeature(): Feature {
  return {
    manifest: {
      id: CONTEXT_MENU_INSPECT_ID,
      name: 'Right-click "Inspect this record"',
      contexts: [CONTEXTS.RECORD_PAGE],
      permissions: ['contextMenus'],
    },
  };
}

export function _contextMenuInspectTestApi() {
  return { planInspectFromClick, buildInspectMenuMessage };
}
