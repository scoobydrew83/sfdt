// Docked side panel ("Workspace-in-a-dock"). This runs on its own
// chrome-extension://sidepanel.html document with light DOM, and reuses the
// exact same boot/layout/tool-registration as the standalone Workspace tab
// (ui/workspace-host.ts) — so every tool renders here unmodified.
//
// Org binding model for this PR is *bind-on-open*: the panel binds to the org
// of the tab it was opened from (the active tab's URL), falling back to the
// last-used org, then an org picker. There are deliberately NO
// chrome.tabs.onActivated/onUpdated listeners — org-follow-across-tabs and
// auto-enable-on-Lightning are PR-2 (they need hands-on browser validation).

import { SFDT_TOKENS_CSS } from '../../lib/tokens.js';
import { watchTheme, OWN_PAGE_COLOR_SCHEME_CSS } from '../../lib/theme.js';
import { readLastOrg } from '../../features/org-switcher.js';
import { salesforceHostFromUrl } from '../../lib/sf-tab.js';
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
  if (org && isAllowedSfHost(org)) {
    bootHost(root, org, { title: PANEL_TITLE, onSwitchOrg: reloadWithOrg });
  } else {
    renderOrgPicker(root, { title: PANEL_TITLE, onSelect: reloadWithOrg });
  }
}

void main();
