// Standalone Workspace tab. Unlike the content script, this runs on a
// chrome-extension://app.html page with no Salesforce host of its own. It gives
// every feature a *synthetic* window whose location reports the chosen org's
// Salesforce URL — that single trick satisfies both the API's host derivation
// and each feature's detectContext() gate, so the existing tools run unchanged.
// Because this lives in its own browser tab, closing a tool's modal never costs
// the user their place on the Salesforce page they were working on.

import { createFeatureRegistry, type Feature } from '../../lib/feature-registry.js';
import { lightningHostname } from '../../lib/hostname.js';
import {
  configureSalesforceApi,
  SalesforceApiClient,
} from '../../lib/salesforce-api.js';
import { releaseFromVersionList } from '@sfdt/flow-core';
import { FEATURE_ICONS, WORKSPACE_TOOLS } from '../../lib/feature-icons.js';
import { showToast } from '../../ui/toast.js';
import { createWorkspaceTabs } from '../../ui/workspace-tabs.js';
import { SFDT_TOKENS_CSS } from '../../lib/tokens.js';

import { createSoqlRunnerFeature } from '../../features/soql-runner.js';
import { createSavedSoqlFeature } from '../../features/saved-soql.js';
import { createApexAnonymousFeature } from '../../features/apex-anonymous.js';
import { createDebugLogViewerFeature } from '../../features/debug-log-viewer.js';
import { createRestExploreFeature } from '../../features/rest-explore.js';
import { createSoapExploreFeature } from '../../features/soap-explore.js';
import { createInspectRecordFeature } from '../../features/inspect-record.js';
import { createOrgLimitsFeature } from '../../features/org-limits.js';
import { createEventMonitorFeature } from '../../features/event-monitor.js';
import { createDataImportFeature } from '../../features/data-import.js';
import { createFieldCreatorFeature } from '../../features/field-creator.js';
import { createMetadataRetrieveFeature } from '../../features/metadata-retrieve.js';
import { createExportForPromptFeature } from '../../features/export-for-prompt.js';
import { createCodeCoverageFeature } from '../../features/code-coverage.js';
import { createOrgHealthLiveFeature } from '../../features/org-health-live.js';
import { createOrgHealthFeature } from '../../features/org-health.js';
import { createDependencyExplorerFeature } from '../../features/dependency-explorer.js';
import { createApexTestRunnerFeature } from '../../features/apex-test-runner.js';
import {
  createDriftFeature,
  createScanFeature,
  createCompareFeature,
} from '../../features/bridge-tools.js';
import { createFlowQualityFeature } from '../../features/flow-quality.js';
import {
  createOrgSwitcherFeature,
  listOrgs,
  readLastOrg,
  persistLastOrg,
} from '../../features/org-switcher.js';

const SF_HOST_SUFFIXES = [
  '.salesforce.com',
  '.salesforce-setup.com',
  '.lightning.force.com',
  '.force.com',
  '.my.salesforce.com',
];

function isAllowedSfHost(host: string): boolean {
  const h = host.toLowerCase();
  return SF_HOST_SUFFIXES.some((s) => h.endsWith(s));
}

const STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: var(--sfdt-color-brand-deep); background: var(--sfdt-color-bg); }
  #sfdt-topbar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: var(--sfdt-color-brand-deep); color: var(--sfdt-color-surface); }
  #sfdt-topbar .title { font-weight: 600; font-size: 15px; }
  #sfdt-topbar .org { margin-left: auto; font-size: 12px; opacity: 0.85; font-family: ui-monospace, monospace; }
  #sfdt-topbar .release-badge { display: none; align-items: center; font-size: 11px; padding: 2px 8px; border-radius: 10px; background: rgba(255,255,255,0.14); color: var(--sfdt-color-surface); white-space: nowrap; }
  #sfdt-topbar .release-badge.preview { background: var(--sfdt-color-warning); color: var(--sfdt-color-brand-deep); font-weight: 600; }
  #sfdt-topbar button { padding: 5px 12px; border: 1px solid rgba(255,255,255,0.4); background: transparent; color: var(--sfdt-color-surface); border-radius: 4px; cursor: pointer; font-size: 12px; }
  #sfdt-topbar button:hover { background: rgba(255,255,255,0.12); }
  #sfdt-layout { display: flex; height: calc(100vh - 45px); }
  #sfdt-sidebar { width: 260px; background: var(--sfdt-color-surface); border-right: 1px solid var(--sfdt-color-border); overflow-y: auto; padding: 8px; }
  #sfdt-sidebar .tool { display: flex; gap: 10px; align-items: center; padding: 10px 12px; border-radius: 4px; cursor: pointer; font-size: 13px; }
  #sfdt-sidebar .tool:hover { background: var(--sfdt-color-surface-shade-2); }
  #sfdt-sidebar .tool .icon { font-size: 16px; }
  #sfdt-main { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
  #sfdt-tabbar { display: flex; gap: 4px; padding: 6px 8px 0; background: var(--sfdt-color-bg); border-bottom: 1px solid var(--sfdt-color-border); overflow-x: auto; }
  #sfdt-tabbar:empty { display: none; }
  #sfdt-tabbar .tab { display: flex; align-items: center; gap: 6px; padding: 6px 10px; background: var(--sfdt-color-surface-shade-4); border: 1px solid var(--sfdt-color-border); border-bottom: none; border-radius: 4px 4px 0 0; cursor: pointer; font-size: 12px; white-space: nowrap; color: var(--sfdt-color-text-weak); }
  #sfdt-tabbar .tab.active { background: var(--sfdt-color-surface); color: var(--sfdt-color-brand-deep); font-weight: 600; }
  #sfdt-tabbar .tab .x { border: 0; background: none; cursor: pointer; font-size: 14px; line-height: 1; color: var(--sfdt-color-text-icon); padding: 0 2px; }
  #sfdt-tabbar .tab .x:hover { color: var(--sfdt-color-error); }
  #sfdt-panes { flex: 1; overflow: auto; }
  #sfdt-panes .pane { height: 100%; flex-direction: column; }
  #sfdt-panes .welcome { max-width: 560px; margin: 40px auto; text-align: center; color: var(--sfdt-color-text-weak); padding: 0 24px; }
  #sfdt-panes .welcome h2 { color: var(--sfdt-color-brand-deep); }
  #sfdt-panes code { background: var(--sfdt-color-surface-shade-4); padding: 1px 5px; border-radius: 3px; font-size: 12px; }
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// Synthetic window: location is overridden to the org's Salesforce URL; every
// other member (open, prompt, confirm, navigator, scroll*, timers…) delegates
// to the real window, bound correctly so methods keep working.
function makeSyntheticWin(href: string): Window {
  const u = new URL(href);
  const fakeLocation = {
    href,
    hostname: u.hostname,
    origin: u.origin,
    host: u.host,
    pathname: u.pathname,
    search: u.search,
    hash: '',
  } as unknown as Location;
  return new Proxy(window, {
    get(target, prop, receiver) {
      if (prop === 'location') return fakeLocation;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as unknown as Window;
}

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

function renderOrgPicker(root: HTMLElement): void {
  while (root.firstChild) root.removeChild(root.firstChild);
  const wrap = el('div');
  wrap.style.cssText = 'max-width: 480px; margin: 80px auto; background: var(--sfdt-color-surface); border: 1px solid var(--sfdt-color-border); border-radius: 6px; padding: 24px;';
  const h = el('h2');
  h.textContent = '⚡ SFDT Workspace';
  h.style.cssText = 'margin: 0 0 4px;';
  const p = el('p');
  p.textContent = 'Choose a Salesforce org to work in:';
  p.style.cssText = 'color: var(--sfdt-color-text-weak); font-size: 13px; margin: 0 0 16px;';
  const list = el('div');
  list.style.cssText = 'display: flex; flex-direction: column; gap: 6px;';
  const loading = el('div');
  loading.textContent = 'Finding logged-in orgs…';
  loading.style.cssText = 'color: var(--sfdt-color-text-icon); font-size: 12px;';
  list.appendChild(loading);
  wrap.appendChild(h);
  wrap.appendChild(p);
  wrap.appendChild(list);
  root.appendChild(wrap);

  void (async () => {
    const orgs = await listOrgs();
    while (list.firstChild) list.removeChild(list.firstChild);
    if (orgs.length === 0) {
      const empty = el('div');
      empty.style.cssText = 'color: var(--sfdt-color-error); font-size: 13px;';
      empty.textContent =
        'No logged-in Salesforce orgs found. Log in to an org in another browser tab, then reload this page.';
      list.appendChild(empty);
      return;
    }
    for (const org of orgs) {
      const btn = el('button');
      btn.style.cssText =
        'text-align: left; padding: 12px; border: 1px solid var(--sfdt-color-surface-shade-3); background: var(--sfdt-color-surface); border-radius: 4px; cursor: pointer;';
      const name = el('div');
      name.textContent = org.displayName;
      name.style.cssText = 'font-weight: 600; font-size: 13px;';
      const host = el('div');
      host.textContent = org.host;
      host.style.cssText = 'font-size: 11px; color: var(--sfdt-color-text-icon); font-family: ui-monospace, monospace;';
      btn.appendChild(name);
      btn.appendChild(host);
      btn.addEventListener('click', () => {
        void persistLastOrg(org.host);
        reloadWithOrg(org.host);
      });
      list.appendChild(btn);
    }
  })();
}

/**
 * Best-effort: read the org's REST version list (`/services/data`) and show its
 * release + preview status in the top-bar badge. Silent on any failure — the
 * badge simply stays hidden. Uses the same flow-core helper as the CLI so the
 * "(preview instance)" wording matches `sfdt monitor org-info`.
 */
async function populateReleaseBadge(
  badge: HTMLElement,
  api: SalesforceApiClient,
): Promise<void> {
  try {
    const versions = await api.apiGet<Array<{ version: string; label: string }>>('/services/data');
    const info = releaseFromVersionList(versions);
    if (!info) return;
    badge.textContent = info.preview ? `${info.release} (preview instance)` : info.release;
    badge.title = `Salesforce API v${info.apiVersion}${info.preview ? ' — preview instance (ahead of GA)' : ''}`;
    badge.classList.toggle('preview', info.preview);
    badge.style.display = 'inline-flex';
  } catch {
    // Informational only — leave the badge hidden.
  }
}

function bootWorkspace(root: HTMLElement, orgHost: string): void {
  const orgOrigin = `https://${lightningHostname(orgHost)}`;
  const syntheticWin = makeSyntheticWin(`${orgOrigin}/lightning/setup/SetupOneHome/home`);

  // Bind the singleton first, so even features that call getSalesforceApi()
  // directly (bypassing options.api) get an org-bound client.
  configureSalesforceApi({ targetOrigin: orgOrigin });
  const api = new SalesforceApiClient({ win: syntheticWin, targetOrigin: orgOrigin });
  void persistLastOrg(orgHost);

  const registry = createFeatureRegistry();
  const common = { doc: document, win: syntheticWin, api };

  // Created eagerly so the Flow Scanner can cross-link its dependency rows into
  // the full org-wide Dependency Explorer (openFor pre-fills + runs the search).
  const depExplorer = createDependencyExplorerFeature(common);

  // Saved SOQL hands a chosen query to the runner, then asks us to open it.
  const factories: Record<string, () => Feature> = {
    'soql-runner': () => createSoqlRunnerFeature(common),
    'saved-soql': () =>
      createSavedSoqlFeature({
        doc: document,
        win: syntheticWin,
        onLoadQuery: () => void registry.dispatch('soql-runner', 'activate'),
      }),
    'apex-anonymous': () => createApexAnonymousFeature(common),
    'debug-log-viewer': () => createDebugLogViewerFeature(common),
    'rest-explore': () => createRestExploreFeature(common),
    'soap-explore': () => createSoapExploreFeature(common),
    'inspect-record': () => createInspectRecordFeature(common),
    'org-limits': () => createOrgLimitsFeature(common),
    'event-monitor': () => createEventMonitorFeature(common),
    'data-import': () => createDataImportFeature(common),
    'field-creator': () => createFieldCreatorFeature(common),
    'metadata-retrieve': () => createMetadataRetrieveFeature(common),
    'export-for-prompt': () =>
      createExportForPromptFeature({ doc: document, win: syntheticWin }),
    'apex-coverage': () => createCodeCoverageFeature(common),
    'apex-test-runner': () => createApexTestRunnerFeature(common),
    'org-health-live': () => createOrgHealthLiveFeature(common),
    'org-health': () => createOrgHealthFeature(common),
    'dependency-explorer': () => depExplorer,
    'flow-quality': () =>
      createFlowQualityFeature({
        ...common,
        onExploreDependency: (dep) => void depExplorer.openFor(dep.type, dep.name),
      }),
    'drift-check': () => createDriftFeature(common),
    'metadata-scan': () => createScanFeature(common),
    'org-compare': () => createCompareFeature(common),
  };
  for (const id of WORKSPACE_TOOLS) {
    const make = factories[id];
    if (make) registry.register(make());
  }

  const orgSwitcher = createOrgSwitcherFeature({
    doc: document,
    win: syntheticWin,
    onSwitch: reloadWithOrg,
  });

  // --- Layout ---
  while (root.firstChild) root.removeChild(root.firstChild);

  const topbar = el('div', { id: 'sfdt-topbar' });
  const title = el('span', { class: 'title' });
  title.textContent = '⚡ SFDT Workspace';
  const orgLabel = el('span', { class: 'org' });
  orgLabel.textContent = orgHost;
  // Release badge: shows the org's Salesforce release (e.g. "Summer '26") and
  // flags preview instances, matching the CLI's `monitor org-info` wording.
  // Populated best-effort after boot; stays hidden if release can't be read.
  const releaseBadge = el('span', { class: 'release-badge' });
  const switchBtn = el('button');
  switchBtn.textContent = '🏢 Switch org';
  switchBtn.addEventListener('click', () => void orgSwitcher.onActivate?.());
  topbar.appendChild(title);
  topbar.appendChild(orgLabel);
  topbar.appendChild(releaseBadge);
  topbar.appendChild(switchBtn);
  void populateReleaseBadge(releaseBadge, api);
  root.appendChild(topbar);

  const layout = el('div', { id: 'sfdt-layout' });
  const sidebar = el('div', { id: 'sfdt-sidebar' });
  const main = el('div', { id: 'sfdt-main' });
  const tabbar = el('div', { id: 'sfdt-tabbar' });
  const panes = el('div', { id: 'sfdt-panes' });
  main.appendChild(tabbar);
  main.appendChild(panes);

  const welcome = el('div', { class: 'welcome' });
  const wh = el('h2');
  wh.textContent = 'Pick a tool to get started';
  const wp = el('p');
  wp.textContent =
    'Tools open as tabs here in the main area — switch between them freely, and your work stays put. Nothing closes on a stray click.';
  welcome.appendChild(wh);
  welcome.appendChild(wp);
  panes.appendChild(welcome);

  // Tabbed tool host: tools open as persistent tabs in the main area (state kept
  // across switches, no click-dismiss). Features render into panes via presentView.
  const workspace = createWorkspaceTabs({
    tabbar,
    panes,
    welcome,
    dispatch: (id) => void registry.dispatch(id, 'activate'),
    labelFor: (id) => FEATURE_ICONS[id]?.label ?? id,
  });

  for (const id of WORKSPACE_TOOLS) {
    if (!registry.has(id)) continue;
    const meta = FEATURE_ICONS[id];
    if (!meta) continue;
    const tool = el('div', { class: 'tool' });
    const icon = el('span', { class: 'icon' });
    icon.textContent = meta.icon;
    const label = el('span');
    label.textContent = meta.label;
    tool.appendChild(icon);
    tool.appendChild(label);
    tool.addEventListener('click', () => workspace.openTool(id));
    sidebar.appendChild(tool);
  }

  layout.appendChild(sidebar);
  layout.appendChild(main);
  root.appendChild(layout);

  showToast(`Workspace connected to ${orgHost}`, { kind: 'success' });
}

async function main(): Promise<void> {
  const styleTag = document.createElement('style');
  styleTag.textContent = `${SFDT_TOKENS_CSS}\n${STYLES}`;
  document.head.appendChild(styleTag);

  const root = document.getElementById('sfdt-app-root');
  if (!root) return;

  const org = resolveOrgFromUrl() ?? (await readLastOrg());
  if (org && isAllowedSfHost(org)) {
    bootWorkspace(root, org);
  } else {
    renderOrgPicker(root);
  }
}

void main();
