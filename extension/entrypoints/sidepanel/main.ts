// Docked side panel ("Workspace-in-a-dock"). This runs on its own
// chrome-extension://sidepanel.html document with light DOM, and reuses the
// exact same boot/layout/tool-registration as the standalone Workspace tab
// (ui/workspace-host.ts) — so every tool renders here unmodified.
//
// Org binding at open is *bind-on-open*: the panel binds to the org of the tab
// it was opened from (the active tab's URL), falling back to the last-used org,
// then an org picker.
//
// PR-2 adds *org-follow*: once open, the panel re-targets when the user switches
// to a different Salesforce org's tab. The background worker (which owns the
// chrome.tabs.* events) broadcasts the active tab's URL; the pure
// `shouldRebindPanel` helper decides whether to re-bind, and we re-render the
// tool host *in place* (re-invoke bootHost — no page navigation, so no flash and
// the panel document stays alive; open tool tabs reset, which is acceptable for
// an org change). Switching to a NON-Salesforce tab is a no-op — the panel stays
// on its last org rather than blanking.

import { SFDT_TOKENS_CSS } from '../../lib/tokens.js';
import { watchTheme, OWN_PAGE_COLOR_SCHEME_CSS } from '../../lib/theme.js';
import { readLastOrg } from '../../features/org-switcher.js';
import { salesforceHostFromUrl } from '../../lib/sf-tab.js';
import { shouldRebindPanel, panelOrgForUrl } from '../../lib/sf-panel.js';
import {
  bootHost,
  renderOrgPicker,
  isAllowedSfHost,
  resolveOrgFromUrl,
  HOST_STYLES,
} from '../../ui/workspace-host.js';

const PANEL_TITLE = '⚡ SFDT Panel';

// Bind-on-open: the org of the tab the panel was opened from. Returns null on a
// non-Salesforce tab (the caller then falls back to last-used org / picker).
async function resolveOrgFromActiveTab(): Promise<string | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const host = salesforceHostFromUrl(tabs[0]?.url);
    return host && isAllowedSfHost(host) ? host : null;
  } catch {
    return null;
  }
}

function reloadWithOrg(host: string): void {
  const base = chrome.runtime?.getURL
    ? chrome.runtime.getURL('sidepanel.html')
    : window.location.pathname;
  window.location.href = `${base}?org=${encodeURIComponent(host)}`;
}

async function main(): Promise<void> {
  const styleTag = document.createElement('style');
  styleTag.textContent = `${SFDT_TOKENS_CSS}\n${OWN_PAGE_COLOR_SCHEME_CSS}\n${HOST_STYLES}`;
  document.head.appendChild(styleTag);
  watchTheme(document);

  const root = document.getElementById('sfdt-app-root');
  if (!root) return;

  const org =
    resolveOrgFromUrl() ?? (await resolveOrgFromActiveTab()) ?? (await readLastOrg());

  // The org the panel is currently bound to (null while the picker is showing).
  let boundOrg: string | null = null;

  function bindTo(host: string): void {
    boundOrg = host;
    bootHost(root!, host, { title: PANEL_TITLE, onSwitchOrg: reloadWithOrg });
  }

  if (org && isAllowedSfHost(org)) {
    bindTo(org);
  } else {
    renderOrgPicker(root, { title: PANEL_TITLE, onSelect: reloadWithOrg });
  }

  // Org-follow: the worker broadcasts the active tab's URL on every tab switch /
  // navigation. Re-bind in place when it names a *different* allowed org; when
  // the picker is showing (no bound org yet), bind to the first SF tab visited.
  chrome.runtime?.onMessage?.addListener((message: unknown) => {
    const msg = message as { action?: string; url?: string | null } | null;
    if (msg?.action !== 'sfdtPanelActiveTab') return;
    const next = boundOrg
      ? shouldRebindPanel(boundOrg, msg.url)
      : panelOrgForUrl(msg.url);
    if (next) bindTo(next);
    // No response needed — return undefined (don't hold the message channel open).
  });
}

void main();
