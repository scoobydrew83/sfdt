// Pure, chrome-free decision logic for the docked side panel's org-follow and
// auto-enable behaviours (P2-3 PR-2). Kept out of ui/workspace-host.ts — which
// pulls in every feature module — so the *background service worker* can import
// just these predicates without dragging the whole tool host into the worker
// bundle. Both the panel (entrypoints/sidepanel) and the worker
// (entrypoints/background) share these, so the two can't drift.

import { salesforceHostFromUrl } from './sf-tab.js';
import { lightningHostname } from './hostname.js';

// The Salesforce host suffixes the panel can bind to. Mirrors the content
// script's match patterns; `salesforceHostFromUrl` already gates a URL to this
// same family, so this is the panel-binding gate on an already-extracted host.
export const SF_HOST_SUFFIXES = [
  '.salesforce.com',
  '.salesforce-setup.com',
  '.lightning.force.com',
  '.force.com',
  '.my.salesforce.com',
] as const;

export function isAllowedSfHost(host: string): boolean {
  const h = host.toLowerCase();
  return SF_HOST_SUFFIXES.some((s) => h.endsWith(s));
}

/** The bindable Salesforce org host for a tab URL, or null when the tab is not a
 *  Salesforce page (non-https, unparseable, or a non-Salesforce host). */
export function panelOrgForUrl(url: string | null | undefined): string | null {
  const host = salesforceHostFromUrl(url);
  return host && isAllowedSfHost(host) ? host : null;
}

/** Auto-enable predicate: should the docked panel be *offered* on this tab?
 *  True only on a bindable Salesforce tab — the panel is Salesforce-specific. */
export function panelEnabledForUrl(url: string | null | undefined): boolean {
  return panelOrgForUrl(url) !== null;
}

/**
 * Org-follow decision (the make-or-break of PR-2). Given the org the OPEN panel
 * is currently bound to and the URL the user just switched to, return the new
 * org host to re-bind to, or null to leave the panel where it is.
 *
 *   • non-Salesforce tab            → null  (keep the panel on its last org — do NOT blank it)
 *   • same org (any of its hosts)   → null  (no needless rebind)
 *   • a *different* allowed SF org  → that org's host
 *
 * Org identity is compared via `lightningHostname`, which collapses the
 * my.salesforce.com / lightning.force.com / setup views of ONE org — so moving
 * between two hostnames of the same org doesn't trigger a rebind.
 */
export function shouldRebindPanel(
  currentOrg: string,
  newTabUrl: string | null | undefined,
): string | null {
  const host = panelOrgForUrl(newTabUrl);
  if (!host) return null;
  if (lightningHostname(host) === lightningHostname(currentOrg)) return null;
  return host;
}
