// Standalone Workspace tab. Unlike the content script, this runs on a
// chrome-extension://app.html page with no Salesforce host of its own. It gives
// every feature a *synthetic* window whose location reports the chosen org's
// Salesforce URL — that single trick satisfies both the API's host derivation
// and each feature's detectContext() gate, so the existing tools run unchanged.
// Because this lives in its own browser tab, closing a tool's modal never costs
// the user their place on the Salesforce page they were working on.
//
// The boot/layout/tool-registration logic is shared with the docked side panel
// (entrypoints/sidepanel) via ui/workspace-host.ts; this entrypoint only wires
// the chrome-specific bits: org resolution from the URL and the reload-on-switch
// navigation.

import { SFDT_TOKENS_CSS } from '../../lib/tokens.js';
import { watchTheme, OWN_PAGE_COLOR_SCHEME_CSS } from '../../lib/theme.js';
import { readLastOrg } from '../../features/org-switcher.js';
import {
  bootHost,
  renderOrgPicker,
  isAllowedSfHost,
  HOST_STYLES,
} from '../../ui/workspace-host.js';

function resolveOrgFromUrl(): string | null {
  const param = new URLSearchParams(window.location.search).get('org');
  if (param && isAllowedSfHost(param)) return param;
  return null;
}

function reloadWithOrg(host: string): void {
  const base = chrome.runtime?.getURL
    ? chrome.runtime.getURL('app.html')
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

  const org = resolveOrgFromUrl() ?? (await readLastOrg());
  if (org && isAllowedSfHost(org)) {
    bootHost(root, org, { title: '⚡ SFDT Workspace', onSwitchOrg: reloadWithOrg });
  } else {
    renderOrgPicker(root, { title: '⚡ SFDT Workspace', onSelect: reloadWithOrg });
  }
}

void main();
