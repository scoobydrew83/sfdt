// Shared host boot for the standalone Workspace tab (entrypoints/app) and the
// docked side panel (entrypoints/sidepanel). Both run on their own
// chrome-extension:// page with no Salesforce host of their own; each gives
// every feature a *synthetic* window whose location reports the chosen org's
// Salesforce URL — that single trick satisfies both the API's host derivation
// and each feature's detectContext() gate, so the existing tools run unchanged.
//
// This module is chrome-free (the reload/org-switch behaviour is injected by the
// entrypoint) so it is unit-testable in happy-dom. The two entrypoints differ
// only in how they derive the org and where they navigate on switch.

import { createFeatureRegistry, type Feature } from '../lib/feature-registry.js';
import { lightningHostname, orgDisplayName } from '../lib/hostname.js';
import {
  configureSalesforceApi,
  SalesforceApiClient,
} from '../lib/salesforce-api.js';
import { releaseFromVersionList } from '@sfdt/flow-core';
import { FEATURE_ICONS, WORKSPACE_TOOLS, WORKSPACE_PRIMARY } from '../lib/feature-icons.js';
import { icon, featureIcon } from '../lib/icons.js';
import type { ActivityEntry } from '../lib/activity-log.js';
import { showToast } from './toast.js';
import { createWorkspaceTabs } from './workspace-tabs.js';

import { shapeLimits, bandFor, BAND_CLASS, humaniseName } from '../features/org-limits.js';
import { createSoqlRunnerFeature } from '../features/soql-runner.js';
import { createSavedSoqlFeature } from '../features/saved-soql.js';
import { createApexAnonymousFeature } from '../features/apex-anonymous.js';
import { createDebugLogViewerFeature } from '../features/debug-log-viewer.js';
import { createTraceFlagsFeature } from '../features/trace-flags.js';
import { createRestExploreFeature } from '../features/rest-explore.js';
import { createSoapExploreFeature } from '../features/soap-explore.js';
import { createInspectRecordFeature } from '../features/inspect-record.js';
import { createSchemaBrowserFeature } from '../features/schema-browser.js';
import { createFieldImpactFeature } from '../features/field-impact.js';
import { createOrgLimitsFeature } from '../features/org-limits.js';
import { createEventMonitorFeature } from '../features/event-monitor.js';
import { createDataImportFeature } from '../features/data-import.js';
import { createFieldCreatorFeature } from '../features/field-creator.js';
import { createMetadataRetrieveFeature } from '../features/metadata-retrieve.js';
import { createDeployStatusFeature } from '../features/deploy-status.js';
import { createExportForPromptFeature } from '../features/export-for-prompt.js';
import { createCodeCoverageFeature } from '../features/code-coverage.js';
import { createOrgHealthFeature } from '../features/org-health.js';
import { createDependencyExplorerFeature } from '../features/dependency-explorer.js';
import { createApexTestRunnerFeature } from '../features/apex-test-runner.js';
import {
  createDriftFeature,
  createScanFeature,
  createCompareFeature,
} from '../features/bridge-tools.js';
import { createFlowQualityFeature } from '../features/flow-quality.js';
import {
  createOrgSwitcherFeature,
  listOrgs,
  persistLastOrg,
} from '../features/org-switcher.js';

// The SF-host suffix list + `isAllowedSfHost` moved to the chrome-free, feature-free
// `lib/sf-panel.js` so the background worker can import the panel predicates
// without pulling every feature module into the worker bundle. Re-exported here
// so existing importers (the panel entrypoint, tests) keep working unchanged.
import { SF_HOST_SUFFIXES, isAllowedSfHost } from '../lib/sf-panel.js';
export { SF_HOST_SUFFIXES, isAllowedSfHost };

/** An org host set explicitly on our own page URL (`?org=`), validated. Shared by
 *  the Workspace tab and the side panel so the two can't drift. */
export function resolveOrgFromUrl(): string | null {
  const param = new URLSearchParams(window.location.search).get('org');
  if (param && isAllowedSfHost(param)) return param;
  return null;
}

/** The org's Lightning origin, e.g. `https://acme.lightning.force.com`. */
export function orgOriginFor(orgHost: string): string {
  return `https://${lightningHostname(orgHost)}`;
}

// Layout styles shared by both host surfaces. The tab layout flexes, so the same
// sheet renders acceptably in a narrow docked panel.
//
// SCOPE: this sheet owns *layout only* — the host chrome, sidebar geometry, tab
// strip, and the Overview grid. Anything reusable (card, button, pill, meter,
// table, nav item) comes from lib/ui-styles.ts, which both entrypoints inject
// alongside this. Adding a card/button rule here instead is what created four
// divergent stylesheets in the first place.
export const HOST_STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; font: var(--sfdt-type-body-md); color: var(--sfdt-color-text); background: var(--sfdt-color-bg); overflow-x: hidden; }
  /* A native <button> ignores inherited colour (UA buttontext), so tool buttons that set a themed background but no colour go dark-on-dark in dark mode. Make them inherit; more-specific rules (#sfdt-topbar button) and inline colours still win. */
  button { color: inherit; }
  /* Header — a fixed 64px app bar. Left cluster identifies the ORG you are
     looking at; right cluster is search + actions. Product identity lives in
     the sidebar, not here. */
  #sfdt-topbar { display: flex; flex-wrap: wrap; min-width: 0; align-items: center; gap: var(--sfdt-space-2) var(--sfdt-space-4); padding: 0 var(--sfdt-space-6); height: var(--sfdt-topbar-h); flex: 0 0 auto; background: var(--sfdt-color-surface); border-bottom: 1px solid var(--sfdt-color-border); }
  #sfdt-topbar .lead { display: flex; align-items: center; gap: var(--sfdt-space-3); min-width: 0; }
  #sfdt-topbar .trail { margin-left: auto; display: flex; align-items: center; gap: var(--sfdt-space-3); min-width: 0; }
  #sfdt-topbar .org { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: var(--sfdt-type-headline-md); color: var(--sfdt-color-text-strong); }
  #sfdt-topbar .release-badge { display: none; align-items: center; font: var(--sfdt-type-label-caps); letter-spacing: var(--sfdt-tracking-caps); text-transform: uppercase; padding: 3px var(--sfdt-space-2); border-radius: var(--sfdt-radius); background: var(--sfdt-color-bg); border: 1px solid var(--sfdt-color-border); color: var(--sfdt-color-text-weak); white-space: nowrap; }
  /* Amber is reserved for a preview instance — it is information, not decoration. */
  #sfdt-topbar .release-badge.preview { background: var(--sfdt-color-warning-bg); border-color: var(--sfdt-color-warning-border); color: var(--sfdt-color-warning-text); }
  /* Pill-shaped search, icon inset. */
  #sfdt-topbar .search { display: flex; align-items: center; gap: var(--sfdt-space-2); min-width: 0; width: 256px; padding: 6px var(--sfdt-space-4); background: var(--sfdt-color-bg); border: 1px solid var(--sfdt-color-border); border-radius: var(--sfdt-radius-pill); color: var(--sfdt-color-text-icon); }
  #sfdt-topbar .search:focus-within { border-color: var(--sfdt-color-brand); box-shadow: 0 0 0 1px var(--sfdt-color-brand); }
  #sfdt-topbar .search input { flex: 1; min-width: 0; border: 0; background: none; outline: none; font: var(--sfdt-type-body-sm); color: var(--sfdt-color-text); }
  /* Switch org is a text action, not a bordered button — it competes with the
     search field for attention otherwise. */
  #sfdt-topbar .switch-org { border: 0; background: none; padding: var(--sfdt-space-1) 0; color: var(--sfdt-color-brand-text); font: var(--sfdt-type-label-caps); letter-spacing: var(--sfdt-tracking-caps); text-transform: uppercase; cursor: pointer; white-space: nowrap; }
  #sfdt-topbar .switch-org:hover { text-decoration: underline; }
  /* Chrome-only overrides. The button LOOK comes from '.sfdt-btn.sfdt-ghost' in
     lib/ui-styles.ts — this used to redeclare the whole thing, which is how the
     app bar drifted away from every other icon button in the product. */
  #sfdt-topbar button:hover { color: var(--sfdt-color-brand-text); background: var(--sfdt-color-bg); }
  #sfdt-topbar button:focus-visible { outline: 2px solid var(--sfdt-color-info); outline-offset: 2px; }
  #sfdt-layout { display: flex; height: 100vh; }
  /* Sidebar is 'surface', not 'surface-alt'. In light, surface-alt (#fafaf9) sits
     2% away from the page (#f3f3f3) — the two planes blended into one grey mush.
     Making the rail a card-white plane against the grey canvas is the same
     figure/ground split the cards already use. Dark is unaffected in kind:
     #202024 rail still reads above the #141416 canvas. */
  #sfdt-sidebar { width: var(--sfdt-sidebar-w); flex: 0 0 auto; display: flex; flex-direction: column; background: var(--sfdt-color-surface); border-right: 1px solid var(--sfdt-color-border); }
  #sfdt-sidebar .brandblock { padding: var(--sfdt-space-5) var(--sfdt-space-5) var(--sfdt-space-4); flex: 0 0 auto; }
  #sfdt-sidebar .brandblock .name { display: flex; align-items: center; gap: var(--sfdt-space-2); font: var(--sfdt-type-headline-lg); color: var(--sfdt-color-brand-text); }
  #sfdt-sidebar .brandblock .sub { font: var(--sfdt-type-body-sm); color: var(--sfdt-color-text-muted); margin-top: 2px; }
  #sfdt-sidebar .nav { flex: 1; min-height: 0; overflow-y: auto; padding: 0 var(--sfdt-space-2) var(--sfdt-space-4) 0; }
  #sfdt-sidebar .group { padding: var(--sfdt-space-4) var(--sfdt-space-3) var(--sfdt-space-1); }
  /* Collapsed by default; the "All tools" button flips it. Hidden rather than unmounted so the disclosure keeps its scroll position. */
  #sfdt-sidebar .all-tools[hidden] { display: none; }
  /* Shown only while the header search has a term — see applyToolFilter. */
  #sfdt-sidebar .no-matches { padding: var(--sfdt-space-3) var(--sfdt-space-4); color: var(--sfdt-color-text-weak); font: var(--sfdt-type-body-sm); }
  #sfdt-main { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
  #sfdt-tabbar { display: flex; gap: var(--sfdt-space-1); padding: 6px var(--sfdt-space-2) 0; background: var(--sfdt-color-bg); border-bottom: 1px solid var(--sfdt-color-border); overflow-x: auto; }
  #sfdt-tabbar:empty { display: none; }
  /* A tab is genuinely NOT a '.sfdt-btn' — it is a folder edge, seamed into the
     pane below it, so it keeps its own shape. Only the parts a button would
     have given it for free are declared. */
  #sfdt-tabbar .tab { display: flex; align-items: center; gap: 6px; padding: 6px var(--sfdt-space-3); background: var(--sfdt-color-surface-shade-4); border: 1px solid var(--sfdt-color-border); border-bottom: none; border-radius: var(--sfdt-radius) var(--sfdt-radius) 0 0; font: var(--sfdt-type-body-sm); white-space: nowrap; color: var(--sfdt-color-text-weak); }
  #sfdt-tabbar .tab { cursor: pointer; }
  #sfdt-tabbar .tab.active { background: var(--sfdt-color-surface); color: var(--sfdt-color-text-strong); font-weight: 600; }
  #sfdt-tabbar .tab .x { border: 0; background: none; cursor: pointer; font-size: 14px; line-height: 1; color: var(--sfdt-color-text-icon); padding: 0 2px; }
  #sfdt-tabbar .tab .x:hover { color: var(--sfdt-color-error-text); }
  #sfdt-panes { flex: 1; overflow: auto; }
  #sfdt-panes .pane { height: 100%; flex-direction: column; }
  #sfdt-panes code { background: var(--sfdt-color-surface-shade-4); padding: 1px var(--sfdt-space-1); border-radius: var(--sfdt-radius-sm); font: var(--sfdt-type-code-sm); }

  /* --- Overview home (the .welcome element; workspace-tabs hides it when a tool tab is active) --- */
  #sfdt-panes .welcome { padding: var(--sfdt-space-6); }
  #sfdt-panes .welcome .greeting { display: flex; align-items: flex-end; gap: var(--sfdt-space-4); flex-wrap: wrap; margin-bottom: var(--sfdt-space-6); }
  #sfdt-panes .welcome .greeting h2 { font: var(--sfdt-type-display); margin: 0; color: var(--sfdt-color-text-strong); letter-spacing: -0.01em; overflow-wrap: anywhere; }
  #sfdt-panes .welcome .greeting p { margin: var(--sfdt-space-1) 0 0; color: var(--sfdt-color-text-weak); }
  /* Geometry comes from '.sfdt-bento' in lib/ui-styles.ts; only the page rhythm is local. */
  #sfdt-panes .welcome .bento { margin-bottom: var(--sfdt-space-4); }
  #sfdt-panes .welcome .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--sfdt-space-3); padding: 0 var(--sfdt-space-5) var(--sfdt-space-5); }
  #sfdt-panes .welcome .quick { display: flex; flex-direction: column; gap: var(--sfdt-space-2); padding: 0 var(--sfdt-space-5) var(--sfdt-space-5); }
  /* Quick actions wear '.sfdt-btn'; this only widens them into full-width rows
     with a left-aligned label, which the base class deliberately doesn't do. */
  #sfdt-panes .welcome .quick .action { width: 100%; justify-content: flex-start; text-align: left; padding: var(--sfdt-space-3); }
  #sfdt-panes .welcome .quick .action:hover { border-color: var(--sfdt-color-brand); }
  #sfdt-panes .welcome .quick .action:focus-visible { outline: 2px solid var(--sfdt-color-info); outline-offset: 2px; }
  #sfdt-panes .welcome .quick .action .icon { width: 36px; height: 36px; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; background: var(--sfdt-color-surface-shade-4); border-radius: var(--sfdt-radius-md); color: var(--sfdt-color-text-weak); }
  #sfdt-panes .welcome .quick .action .label { font: var(--sfdt-type-body-md); font-weight: 600; color: var(--sfdt-color-text-strong); }
  #sfdt-panes .welcome .quick .action .chev { margin-left: auto; color: var(--sfdt-color-text-icon); display: flex; }
  #sfdt-panes .welcome .empty { padding: 0 var(--sfdt-space-5) var(--sfdt-space-5); color: var(--sfdt-color-text-weak); font: var(--sfdt-type-body-sm); }
  /* Two lines then ellipsis. Salesforce limit names are long enough to bury the
     number they label; the full text stays available as a title. */
  .clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  /* A genuinely narrow TAB (dragged small) still just stacks. */
  @media (max-width: 900px) {
    #sfdt-panes .welcome .bento { grid-template-columns: minmax(0, 1fr); }
  }

  /* --- Panel surface -------------------------------------------------------
     The docked side panel is ~400px. Shrinking the labelled sidebar was the
     wrong answer: at 160px every label truncated to "SOQL Query…", which costs
     the same vertical space as a full label and tells you less than an icon
     would. So the panel gets an icon-only RAIL and the labels become tooltips.
     Everything here is a structural change, not a size tweak — which is why it
     keys off the surface attribute rather than a width. */
  [data-sfdt-surface='panel'] #sfdt-sidebar { width: var(--sfdt-sidebar-collapsed); }
  [data-sfdt-surface='panel'] #sfdt-sidebar .brandblock { padding: var(--sfdt-space-3) 0; display: flex; justify-content: center; }
  [data-sfdt-surface='panel'] #sfdt-sidebar .brandblock .name span,
  [data-sfdt-surface='panel'] #sfdt-sidebar .brandblock .sub { display: none; }
  [data-sfdt-surface='panel'] #sfdt-sidebar .nav { padding: 0 0 var(--sfdt-space-3); }
  /* Group headings are meaningless above unlabelled icons; a hairline divider
     carries the same grouping in 1px instead of 16. */
  [data-sfdt-surface='panel'] #sfdt-sidebar .group { height: 1px; padding: 0; margin: var(--sfdt-space-2) var(--sfdt-space-3); overflow: hidden; text-indent: -999px; background: var(--sfdt-color-border); }
  [data-sfdt-surface='panel'] #sfdt-sidebar .sfdt-nav-item { justify-content: center; padding: 10px 0; border-left-width: 3px; border-radius: 0; }
  [data-sfdt-surface='panel'] #sfdt-sidebar .sfdt-nav-label,
  [data-sfdt-surface='panel'] #sfdt-sidebar .sfdt-nav-trail { display: none; }
  [data-sfdt-surface='panel'] #sfdt-sidebar .no-matches { display: none; }

  /* Header: the org name alone, wrapping onto at most two lines. The search box
     and its 320px minimum do not fit beside anything at this width. */
  [data-sfdt-surface='panel'] #sfdt-topbar { height: auto; padding: var(--sfdt-space-2) var(--sfdt-space-3); gap: var(--sfdt-space-1) var(--sfdt-space-2); }
  /* Narrow surfaces stack the release UNDER the org name as a caps line rather
     than a pill beside it — a bordered chip next to a long org name is the first
     thing to wrap, and Stitch's own panel/popup use the stacked form. */
  [data-sfdt-surface='panel'] #sfdt-topbar .lead { flex: 1 1 100%; min-width: 0; flex-direction: column; align-items: flex-start; gap: 0; }
  [data-sfdt-surface='panel'] #sfdt-topbar .release-badge { padding: 0; border: 0; background: none; color: var(--sfdt-color-brand-text); }
  [data-sfdt-surface='panel'] #sfdt-topbar .release-badge.preview { background: none; color: var(--sfdt-color-warning-text); }
  [data-sfdt-surface='panel'] #sfdt-topbar .trail { margin-left: 0; gap: var(--sfdt-space-2); }
  [data-sfdt-surface='panel'] #sfdt-topbar .switch-org { font: var(--sfdt-type-body-sm); font-weight: 600; text-transform: none; letter-spacing: 0; }
  /* The org name claims its own row so the controls stay together beneath it.
     Left to wrap naturally the name pushed Switch-org onto row 1 and refresh
     onto row 2, which read as two unrelated toolbars. */
  [data-sfdt-surface='panel'] #sfdt-topbar .org { font: var(--sfdt-type-body-md); font-weight: 600; }
  [data-sfdt-surface='panel'] #sfdt-topbar .search { display: none; }

  /* Overview: 2-up tiles, and the display type steps down two sizes — 30px in a
     ~330px column produced a three-word heading over three lines. */
  [data-sfdt-surface='panel'] #sfdt-panes .welcome { padding: var(--sfdt-space-4); }
  [data-sfdt-surface='panel'] #sfdt-panes .welcome .greeting { margin-bottom: var(--sfdt-space-4); }
  [data-sfdt-surface='panel'] #sfdt-panes .welcome .greeting h2 { font: var(--sfdt-type-headline-md); }
  [data-sfdt-surface='panel'] #sfdt-panes .welcome .bento { grid-template-columns: minmax(0, 1fr); gap: var(--sfdt-space-3); }
  [data-sfdt-surface='panel'] #sfdt-panes .welcome .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sfdt-space-2); padding: 0 var(--sfdt-space-4) var(--sfdt-space-4); }
  [data-sfdt-surface='panel'] #sfdt-panes .welcome .tiles .sfdt-tile { padding: var(--sfdt-space-3); }
  [data-sfdt-surface='panel'] #sfdt-panes .welcome .sfdt-tile-value { font: var(--sfdt-type-headline-lg); }
  [data-sfdt-surface='panel'] #sfdt-panes .welcome .quick { padding: 0 var(--sfdt-space-4) var(--sfdt-space-4); }
  [data-sfdt-surface='panel'] .sfdt-card-head { padding: var(--sfdt-space-4) var(--sfdt-space-4) var(--sfdt-space-3); }
  /* The activity table cannot show four columns here; drop to time + action. */
  [data-sfdt-surface='panel'] #sfdt-panes .welcome .sfdt-table th:nth-child(3),
  [data-sfdt-surface='panel'] #sfdt-panes .welcome .sfdt-table td:nth-child(3) { display: none; }
  [data-sfdt-surface='panel'] #sfdt-panes .welcome .sfdt-table th,
  [data-sfdt-surface='panel'] #sfdt-panes .welcome .sfdt-table td { padding-left: var(--sfdt-space-4); padding-right: var(--sfdt-space-4); }
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  // Strings go through createTextNode, never innerHTML (extension rule #1).
  for (const child of children) {
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** An icon wrapped in the span the component sheet expects. Decorative. */
function glyph(name: string, size = 20, cls = 'sfdt-glyph'): HTMLElement {
  return el('span', { class: cls, 'aria-hidden': 'true' }, icon(name, size));
}

/** The same, resolved from a feature registry id. */
function featureGlyph(id: string, size = 20, cls = 'sfdt-glyph'): HTMLElement {
  return el('span', { class: cls, 'aria-hidden': 'true' }, featureIcon(id, size));
}

/** A filled progress meter. `pct` is 0..1. */
/** A filled progress meter. `pct` is 0..1; `tone` is 'sfdt-ok' | 'sfdt-warn' | 'sfdt-bad'. */
function meter(pct: number, tone: string): HTMLElement {
  const bar = el('div', { class: 'sfdt-meter' });
  const fill = el('i', { class: tone });
  fill.style.width = `${Math.round(Math.min(1, Math.max(0, pct)) * 100)}%`;
  bar.appendChild(fill);
  return bar;
}

/** `HH:MM:SS` in local time — the activity table's Time column. */
function clockTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Synthetic window: location is overridden to the org's Salesforce URL; every
// other member (open, prompt, confirm, navigator, scroll*, timers…) delegates
// to the real window, bound correctly so methods keep working.
export function makeSyntheticWin(href: string): Window {
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
    get(target, prop) {
      if (prop === 'location') return fakeLocation;
      // Read with the REAL window as receiver, never the proxy.
      //
      // `scrollY`, `innerWidth`, `visualViewport` and friends are WebIDL
      // *accessors* on Window.prototype. Forwarding the proxy as receiver runs
      // those getters with `this` = proxy, which fails Chrome's brand check with
      // "TypeError: Illegal invocation" — so any feature reading one through the
      // synthetic window threw, and the click that triggered it died silently.
      //
      // happy-dom exposes the same properties as plain data values, so this was
      // invisible to every unit test; test/workspace-host.test.ts now simulates
      // the accessor to keep it that way.
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as unknown as Window;
}

export interface OrgPickerOptions {
  /** Heading shown above the org list. */
  title: string;
  /** Called with the chosen org host (last-org is persisted first). */
  onSelect: (host: string) => void;
}

export function renderOrgPicker(root: HTMLElement, opts: OrgPickerOptions): void {
  while (root.firstChild) root.removeChild(root.firstChild);
  const wrap = el('div');
  wrap.style.cssText = 'max-width: 480px; margin: 80px auto; background: var(--sfdt-color-surface); border: 1px solid var(--sfdt-color-border); border-radius: 6px; padding: 24px;';
  // Same treatment as the app bar: a real glyph beside the words, not a
  // pictograph inside them.
  const h = el('h2');
  h.classList.add('sfdt-row', 'sfdt-snug');
  h.appendChild(icon('bolt', 20));
  const hText = el('span');
  hText.textContent = opts.title;
  h.appendChild(hText);
  const p = el('p');
  p.textContent = 'Choose a Salesforce org to work in:';
  p.classList.add('sfdt-muted');
  const list = el('div');
  list.classList.add('sfdt-stack', 'sfdt-snug');
  const loading = el('div');
  loading.textContent = 'Finding logged-in orgs…';
  loading.className = 'sfdt-faint';
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
      empty.classList.add('sfdt-muted');
      empty.textContent =
        'No logged-in Salesforce orgs found. Log in to an org in another browser tab, then reload this page.';
      list.appendChild(empty);
      return;
    }
    for (const org of orgs) {
      // '.sfdt-nav-item' is exactly this shape — a full-width, left-aligned,
      // hoverable row button — and it is already what the Schema Browser's
      // object list uses.
      const btn = el('button', { class: 'sfdt-nav-item' });
      const name = el('div');
      name.textContent = org.displayName;
      const host = el('div', { class: 'sfdt-mono sfdt-muted' });
      host.textContent = org.host;
      btn.appendChild(name);
      btn.appendChild(host);
      btn.addEventListener('click', () => {
        void persistLastOrg(org.host);
        opts.onSelect(org.host);
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
/** Shape of what `releaseFromVersionList` gives us, narrowed to what we render. */
export interface ReleaseBadgeInfo {
  release: string;
  apiVersion: number;
  preview: boolean;
}

/**
 * Badge text: release AND API version, e.g. `Summer '26 · v65.0`.
 *
 * The API version was previously only in the `title`, which meant the single
 * number that decides what every tool here calls was invisible until you
 * hovered. A Salesforce developer checking "which API am I on?" should not have
 * to hunt for it.
 *
 * `preview` is appended as TEXT, not signalled by the amber tint alone —
 * status must never be conveyed by colour by itself (CONVENTIONS.md a11y).
 * Split from the DOM so the formatting is testable without a network call.
 */
export function formatReleaseBadge(info: ReleaseBadgeInfo): string {
  // parseFloat('65.0') is 65; Salesforce always writes one decimal place.
  const parts = [info.release, `v${info.apiVersion.toFixed(1)}`];
  if (info.preview) parts.push('preview');
  return parts.join(' · ');
}

async function populateReleaseBadge(
  badge: HTMLElement,
  api: SalesforceApiClient,
): Promise<void> {
  try {
    const versions = await api.apiGet<Array<{ version: string; label: string }>>('/services/data');
    const info = releaseFromVersionList(versions);
    if (!info) return;
    badge.textContent = formatReleaseBadge(info);
    badge.title = info.preview
      ? `Salesforce API v${info.apiVersion.toFixed(1)} — preview instance (ahead of GA)`
      : `Salesforce API v${info.apiVersion.toFixed(1)}`;
    badge.classList.toggle('preview', info.preview);
    badge.style.display = 'inline-flex';
  } catch {
    // Informational only — leave the badge hidden.
  }
}

export interface HostOptions {
  /** Top-bar / welcome heading, e.g. "⚡ SFDT Workspace" or "⚡ SFDT Panel". */
  title: string;
  /** Navigate the host to a different org (reload with `?org=`). Injected by the
   * entrypoint so this module stays chrome-free. */
  onSwitchOrg: (host: string) => void;
  /**
   * Whether a tool is switched on for this user (`settings.features`). Injected
   * for the same chrome-free reason as `onSwitchOrg`.
   *
   * Until this existed the Workspace ignored the kill switches entirely: turning
   * a tool off in Settings removed it from the ⚡ menu on Salesforce pages
   * (entrypoints/content.ts gates on `isFeatureEnabled`) while the Workspace
   * sidebar and the docked panel kept showing it. Defaults to "everything on"
   * so tests and any caller that doesn't care keep the old behaviour.
   */
  isEnabled?: (id: string) => boolean;
  /** Most-recently-used tool ids, newest first (lib/palette-recents). */
  loadRecents?: () => Promise<readonly string[]>;
  /** Called when a tool is opened, so the MRU learns from Workspace use too. */
  onToolOpened?: (id: string) => void;
  /** Recent activity entries, newest first (lib/activity-log). */
  loadActivity?: () => Promise<readonly ActivityEntry[]>;
  /** Wipe the activity log — backs the panel's Clear action. */
  clearActivity?: () => Promise<void>;
  /**
   * Which surface this is. 'panel' is the docked side panel (~400px).
   *
   * This is NOT a width breakpoint. The panel needs a structurally different
   * shell — an icon-only rail instead of a labelled sidebar — because at 400px
   * a labelled sidebar either eats half the width or truncates every label to
   * "SOQL Query…", which is worse than no label. Media queries alone produced
   * exactly that. The variant is set at boot (the entrypoint knows which surface
   * it is) and drives a `data-sfdt-surface` attribute the stylesheet keys off,
   * so the branching stays in CSS rather than in two DOM builders.
   */
  variant?: 'tab' | 'panel';
}

/** How many MRU entries the sidebar's Recent group shows. */
const RECENT_LIMIT = 4;

/** How many activity rows the Overview table shows. */
const ACTIVITY_ROWS = 6;

/**
 * Fill the sidebar's Recent group from the MRU. Best-effort and async: the store
 * is in chrome.storage, which this module can't reach, so the group starts
 * hidden and appears only if there is something to show. Ids that are no longer
 * available (feature switched off, tool removed) are skipped rather than
 * rendered as dead rows.
 */
async function populateRecent(
  groupEl: HTMLElement,
  listEl: HTMLElement,
  opts: HostOptions,
  build: (id: string) => HTMLElement | null,
  alreadyShown: readonly string[] = [],
): Promise<void> {
  if (!opts.loadRecents) return;
  try {
    const recents = await opts.loadRecents();
    let shown = 0;
    for (const id of recents) {
      if (shown >= RECENT_LIMIT) break;
      // Skip anything already visible in the Tools group. Recent is for
      // surfacing what you'd otherwise have to hunt for; listing SOQL Query
      // Runner twice, six rows apart, is pure noise — and in the panel's rail it
      // renders as the same icon twice with no way to tell them apart.
      if (alreadyShown.includes(id)) continue;
      const btn = build(id);
      if (!btn) continue;
      listEl.appendChild(btn);
      shown++;
    }
    if (shown > 0) {
      groupEl.hidden = false;
      listEl.hidden = false;
    }
  } catch {
    // A missing MRU is not worth a broken sidebar.
  }
}

interface OverviewOptions {
  orgHost: string;
  api: SalesforceApiClient;
  enabledTools: readonly string[];
  openTool: (id: string) => void;
  loadActivity?: () => Promise<readonly ActivityEntry[]>;
  clearActivity?: () => Promise<void>;
}

/** A `.sfdt-card` with an icon + heading, and optional header actions. */
function card(iconName: string, heading: string, actions?: HTMLElement): HTMLElement {
  const wrap = el('div', { class: 'sfdt-card' });
  const head = el('div', { class: 'sfdt-card-head' });
  head.appendChild(glyph(iconName, 20, 'sfdt-card-lead'));
  head.appendChild(el('h2', {}, heading));
  if (actions) head.appendChild(actions);
  wrap.appendChild(head);
  return wrap;
}

/**
 * Org health tiles, filled from the same `/limits` payload and the same
 * shapeLimits/bandFor/BAND_CLASS helpers the full Org Limits tool uses — so the
 * summary and the detail view can never disagree about what "amber" means.
 *
 * Best-effort, exactly like the release badge: a failed read leaves a short
 * explanatory line instead of an empty card or a thrown boot.
 */
async function populateHealthTiles(tiles: HTMLElement, api: SalesforceApiClient): Promise<void> {
  try {
    const rows = shapeLimits(await api.limits());
    while (tiles.firstChild) tiles.removeChild(tiles.firstChild);
    if (rows.length === 0) {
      tiles.appendChild(el('div', { class: 'empty' }, 'No limits returned for this org.'));
      return;
    }
    const atRisk = rows.filter((r) => bandFor(r.pct) !== 'green').length;

    // rows is sorted by pct desc (shapeLimits), so the head of the list is
    // exactly "what is closest to hurting" — which is what a summary should show.
    for (const row of rows.slice(0, 3)) {
      const tile = el('div', { class: 'sfdt-tile' });
      // Full name on hover; the visible label is clamped by CSS. Salesforce
      // limit names run long — DailyDurableGenericStreamingApiEvents humanises
      // to six words, which took four lines of a panel tile and pushed the
      // number itself off-screen.
      const label = el('span', { class: 'sfdt-caps clamp', title: humaniseName(row.name) });
      label.textContent = humaniseName(row.name);
      tile.appendChild(label);
      const value = el('div', { class: 'sfdt-tile-value' }, row.used.toLocaleString());
      value.appendChild(el('small', {}, ` / ${row.max.toLocaleString()}`));
      tile.appendChild(value);
      tile.appendChild(meter(row.pct, BAND_CLASS[bandFor(row.pct)]));
      tiles.appendChild(tile);
    }

    const summary = el('div', { class: 'sfdt-tile' });
    summary.appendChild(el('span', { class: 'sfdt-caps' }, 'Limits at risk'));
    summary.appendChild(
      el('div', { class: 'sfdt-tile-value' }, String(atRisk)),
    );
    summary.appendChild(el('span', { class: 'sfdt-caps' }, `of ${rows.length} tracked`));
    tiles.appendChild(summary);
  } catch {
    while (tiles.firstChild) tiles.removeChild(tiles.firstChild);
    tiles.appendChild(
      el('div', { class: 'empty' }, 'Org limits unavailable — open the Org Limits tool for details.'),
    );
  }
}

/** Fill the activity table, or explain why it's empty. */
async function populateActivity(
  tbody: HTMLElement,
  empty: HTMLElement,
  load: () => Promise<readonly ActivityEntry[]>,
): Promise<void> {
  let entries: readonly ActivityEntry[] = [];
  try {
    entries = await load();
  } catch {
    entries = [];
  }
  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
  if (entries.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const entry of entries.slice(0, ACTIVITY_ROWS)) {
    const tr = el('tr');
    tr.appendChild(el('td', { class: 'sfdt-cell-code' }, clockTime(entry.ts)));

    const action = el('span', { class: 'sfdt-cell-strong' });
    action.appendChild(featureGlyph(entry.featureId, 18));
    action.appendChild(document.createTextNode(entry.action));
    tr.appendChild(el('td', {}, action));

    tr.appendChild(el('td', { class: 'sfdt-cell-code' }, entry.resource ?? '—'));

    const pillClass = entry.status === 'success' ? 'sfdt-success' : 'sfdt-error';
    const label = entry.status === 'success' ? 'Success' : 'Failed';
    tr.appendChild(el('td', {}, el('span', { class: `sfdt-pill ${pillClass}` }, label)));
    tbody.appendChild(tr);
  }
}

/**
 * Build the Overview home: greeting, org-health tiles, quick actions, and the
 * recent-activity table. Synchronous structure with async fills, so the panel
 * paints immediately and never blocks boot.
 */
function renderOverview(host: HTMLElement, opts: OverviewOptions): void {
  while (host.firstChild) host.removeChild(host.firstChild);

  const greeting = el('div', { class: 'greeting' });
  const heading = el('div');
  // Lead with the org's short name rather than a generic sentence plus a raw
  // 50-character host underneath — the name is the useful part, and the pair
  // took five lines in the panel to say less than one.
  const h = el('h2', { title: opts.orgHost });
  h.textContent = orgDisplayName(opts.orgHost);
  heading.appendChild(h);
  heading.appendChild(el('p', {}, 'Connected'));
  greeting.appendChild(heading);
  host.appendChild(greeting);

  const bento = el('div', { class: 'sfdt-bento bento' });

  // --- Org health ---
  const health = card('gauge', 'Org health');
  const tiles = el('div', { class: 'tiles' });
  tiles.appendChild(el('div', { class: 'empty' }, 'Reading org limits…'));
  health.appendChild(tiles);
  bento.appendChild(health);
  void populateHealthTiles(tiles, opts.api);

  // --- Quick actions ---
  // Drawn from the primary set intersected with what's actually enabled, so a
  // switched-off tool can't appear here either.
  const quickIds = WORKSPACE_PRIMARY.filter((id) => opts.enabledTools.includes(id)).slice(0, 4);
  if (quickIds.length > 0) {
    const quick = card('bolt', 'Quick actions');
    const list = el('div', { class: 'quick' });
    for (const id of quickIds) {
      const action = el('button', { class: 'sfdt-btn action', type: 'button', 'data-tool-id': id });
      action.appendChild(featureGlyph(id, 20, 'icon'));
      action.appendChild(
        el('span', {}, el('span', { class: 'label' }, FEATURE_ICONS[id]?.label ?? id)),
      );
      action.appendChild(glyph('chevron', 18, 'chev'));
      action.addEventListener('click', () => opts.openTool(id));
      list.appendChild(action);
    }
    quick.appendChild(list);
    bento.appendChild(quick);
  }
  host.appendChild(bento);

  // --- Recent activity ---
  // Only rendered when the entrypoint wired a loader: in a test (or any caller
  // that didn't) the panel is absent rather than permanently "Loading…".
  if (!opts.loadActivity) return;

  const actions = el('div', { class: 'sfdt-card-actions' });
  const clearBtn = el('button', { class: 'sfdt-btn', type: 'button' }, 'Clear');
  actions.appendChild(clearBtn);
  const activity = card('history', 'Recent activity', actions);

  const table = el('table', { class: 'sfdt-table' });
  const thead = el('thead');
  const hrow = el('tr');
  for (const h of ['Time', 'Action', 'Resource', 'Status']) hrow.appendChild(el('th', {}, h));
  thead.appendChild(hrow);
  table.appendChild(thead);
  const tbody = el('tbody');
  table.appendChild(tbody);
  activity.appendChild(table);

  const empty = el('div', { class: 'empty' },
    'Nothing yet. Runs from the SOQL runner, anonymous Apex, deploys and the bridge tools show up here.');
  empty.hidden = true;
  activity.appendChild(empty);

  if (!opts.clearActivity) {
    clearBtn.disabled = true;
  } else {
    clearBtn.addEventListener('click', () => {
      void opts.clearActivity?.().then(() => {
        void populateActivity(tbody, empty, opts.loadActivity!);
      });
    });
  }

  host.appendChild(activity);
  void populateActivity(tbody, empty, opts.loadActivity);
}

export function bootHost(root: HTMLElement, orgHost: string, opts: HostOptions): void {
  const orgOrigin = orgOriginFor(orgHost);
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

  // Created eagerly so the SOQL Runner's record-Id row menu can hand an Id to
  // it ("View all fields"). Inspect Record is also a Workspace tool in its own
  // right, so this is the same instance the sidebar opens.
  // Built, but deliberately NOT in `factories` below: the Workspace sidebar no
  // longer lists Inspect Record, because nobody opens an empty inspector and
  // goes looking for a record. The instance still exists because the SOQL
  // runner's result-row Id menu opens it directly — that is the path that
  // matters here, and it does not go through the registry.
  const inspectRecord = createInspectRecordFeature(common);

  // Created eagerly so the Schema Browser can drop a field into the SOQL Runner
  // draft and export a chosen field subset for a prompt (P2-1 PR-3).
  const soqlRunner = createSoqlRunnerFeature({
    ...common,
    inspectRecord: (recordId) => inspectRecord.openFor(recordId),
  });
  const exportForPrompt = createExportForPromptFeature({ doc: document, win: syntheticWin });

  // Created eagerly so the Schema Browser's per-field "What writes this?" action
  // can drive it (P4-4). Field Impact is also a Workspace tool in its own right.
  const fieldImpact = createFieldImpactFeature(common);

  // Saved SOQL hands a chosen query to the runner, then asks us to open it.
  const factories: Record<string, () => Feature> = {
    'soql-runner': () => soqlRunner,
    'saved-soql': () =>
      createSavedSoqlFeature({
        doc: document,
        win: syntheticWin,
        onLoadQuery: () => void registry.dispatch('soql-runner', 'activate'),
      }),
    'apex-anonymous': () => createApexAnonymousFeature(common),
    'debug-log-viewer': () =>
      createDebugLogViewerFeature({
        ...common,
        onManageTraceFlags: () => void registry.dispatch('trace-flags', 'activate'),
      }),
    'trace-flags': () => createTraceFlagsFeature(common),
    'rest-explore': () => createRestExploreFeature(common),
    'soap-explore': () => createSoapExploreFeature(common),
    'schema-browser': () =>
      createSchemaBrowserFeature({
        ...common,
        insertFieldIntoDraft: (field) => soqlRunner.insertFieldIntoDraft(field),
        exportForPrompt: (name, fields) => exportForPrompt.exportObject(name, fields),
        analyzeFieldImpact: (name, field) => void fieldImpact.openFor(name, field),
      }),
    'field-impact': () => fieldImpact,
    'org-limits': () => createOrgLimitsFeature(common),
    'event-monitor': () => createEventMonitorFeature(common),
    'data-import': () => createDataImportFeature(common),
    'field-creator': () => createFieldCreatorFeature(common),
    'metadata-retrieve': () => createMetadataRetrieveFeature(common),
    'deploy-status': () => createDeployStatusFeature(common),
    'export-for-prompt': () => exportForPrompt,
    'apex-coverage': () => createCodeCoverageFeature(common),
    'apex-test-runner': () => createApexTestRunnerFeature(common),
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
  // The kill-switch gate. Everything downstream — registration, the sidebar,
  // Recent, quick actions — reads `enabledTools`, so a tool the user switched
  // off in Settings is not merely hidden, it is never constructed.
  const isEnabled = opts.isEnabled ?? (() => true);
  const enabledTools = WORKSPACE_TOOLS.filter((id) => isEnabled(id));

  for (const id of enabledTools) {
    const make = factories[id];
    if (make) registry.register(make());
  }

  const orgSwitcher = createOrgSwitcherFeature({
    doc: document,
    win: syntheticWin,
    onSwitch: opts.onSwitchOrg,
  });

  // --- Layout ---
  while (root.firstChild) root.removeChild(root.firstChild);
  // Drives every structural difference between the tab and the docked panel.
  root.setAttribute('data-sfdt-surface', opts.variant ?? 'tab');

  // --- Header ---
  // Lives inside the main column, not as a full-width bar above everything:
  // product identity belongs to the sidebar, and this row is about the ORG
  // you're looking at.
  const topbar = el('div', { id: 'sfdt-topbar' });
  // Short name, full host on hover. The raw host is ~50 characters and the
  // suffix every org shares carries no information — rendering it in full took
  // four lines of the panel header before anything else could be shown.
  const orgLabel = el('span', { class: 'org', title: orgHost });
  orgLabel.textContent = orgDisplayName(orgHost);
  // Release badge: shows the org's Salesforce release (e.g. "Summer '26") and
  // flags preview instances, matching the CLI's `monitor org-info` wording.
  // Populated best-effort after boot; stays hidden if release can't be read.
  const releaseBadge = el('span', { class: 'release-badge' });

  // Tool filter. Deliberately NOT the command palette: that needs the describe
  // cache and the enabled-for-context gate wired into this surface, which is its
  // own change. Filtering a 25-tool sidebar is the problem the sidebar actually
  // has, so the placeholder promises exactly that and nothing more.
  const searchWrap = el('div', { class: 'search' });
  const searchInput = el('input', {
    type: 'search',
    placeholder: 'Search tools…',
    'aria-label': 'Search tools',
  });
  searchWrap.appendChild(icon('search', 16));
  searchWrap.appendChild(searchInput);

  const switchBtn = el('button', { type: 'button', class: 'switch-org' }, 'Switch org');
  switchBtn.addEventListener('click', () => void orgSwitcher.onActivate?.());

  const refreshBtn = el('button', {
    type: 'button',
    // '.sfdt-btn.sfdt-ghost.sfdt-icon' is the shared icon-button; the bar used
    // to get its look from a bare `#sfdt-topbar button` rule, which is why it
    // drifted from every other icon button in the product.
    class: 'sfdt-btn sfdt-ghost sfdt-icon',
    'aria-label': 'Refresh Overview',
    title: 'Refresh Overview',
  });
  refreshBtn.appendChild(icon('refresh', 20));

  // Two clusters: what org you're on, then what you can do about it. Grouping
  // them is what lets the right side stay together when the bar gets tight,
  // instead of each control wrapping independently.
  const lead = el('div', { class: 'lead' });
  lead.appendChild(orgLabel);
  lead.appendChild(releaseBadge);

  const trail = el('div', { class: 'trail' });
  trail.appendChild(searchWrap);
  trail.appendChild(switchBtn);
  trail.appendChild(refreshBtn);

  topbar.appendChild(lead);
  topbar.appendChild(trail);
  void populateReleaseBadge(releaseBadge, api);

  const layout = el('div', { id: 'sfdt-layout' });
  const sidebar = el('div', { id: 'sfdt-sidebar' });
  const main = el('div', { id: 'sfdt-main' });
  const tabbar = el('div', { id: 'sfdt-tabbar' });
  const panes = el('div', { id: 'sfdt-panes' });
  main.appendChild(topbar);
  main.appendChild(tabbar);
  main.appendChild(panes);

  // Brand block — the identity the header used to carry.
  const brand = el('div', { class: 'brandblock' });
  const brandName = el('div', { class: 'name' });
  brandName.appendChild(icon('bolt', 22));
  // The glyph above IS the mark — callers pass plain text. This used to strip a
  // leading ⚡ that every caller sent and this line immediately threw away.
  brandName.appendChild(el('span', { class: 'title' }, opts.title));
  brand.appendChild(brandName);
  brand.appendChild(el('div', { class: 'sub' }, 'Salesforce developer tools'));
  sidebar.appendChild(brand);

  // Scrollable nav region, so the brand block stays pinned while tools scroll.
  const nav = el('div', { class: 'nav' });
  sidebar.appendChild(nav);

  // The Overview home. This IS the `welcome` element workspace-tabs shows when
  // no tool tab is active and hides when one is — so the dashboard costs no
  // extra routing: open a tool and it's replaced, close the last tab and it's
  // back.
  const welcome = el('div', { class: 'welcome' });
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

  // Single entry point for opening a tool, so the MRU learns from every route
  // into a tool (sidebar, Recent, quick action) rather than only the command
  // palette — which is why Recent was empty before this.
  function openTool(id: string): void {
    workspace.openTool(id);
    opts.onToolOpened?.(id);
  }

  /** A sidebar row for a tool. Returns null for an unknown/unregistered id. */
  function toolButton(id: string): HTMLElement | null {
    if (!registry.has(id)) return null;
    const meta = FEATURE_ICONS[id];
    if (!meta) return null;
    // `title` + `aria-label` are what keep the panel's icon-only rail usable:
    // the visible label is hidden there, so the name has to survive somewhere
    // for both pointer hover and assistive tech.
    const tool = el('button', {
      class: 'sfdt-nav-item tool',
      type: 'button',
      'data-tool-id': id,
      title: meta.label,
      'aria-label': meta.label,
    });
    tool.appendChild(featureGlyph(id));
    tool.appendChild(el('span', { class: 'sfdt-nav-label' }, meta.label));
    tool.addEventListener('click', () => openTool(id));
    return tool;
  }

  function group(label: string): HTMLElement {
    return el('div', { class: 'group sfdt-caps' }, label);
  }

  // Iterate WORKSPACE_PRIMARY, not enabledTools: its order is a curation
  // decision (query → run → inspect → ship), and filtering enabledTools would
  // silently re-impose WORKSPACE_TOOLS' order instead.
  const primary = WORKSPACE_PRIMARY.filter((id) => enabledTools.includes(id));
  const secondary = enabledTools.filter((id) => !WORKSPACE_PRIMARY.includes(id));

  // Recent group — rendered async because the MRU lives in chrome.storage, which
  // this module can't touch. Inserted above Tools so "the thing I was just
  // doing" is the first thing on screen.
  const recentGroup = group('Recent');
  const recentList = el('div');
  recentGroup.hidden = true;
  recentList.hidden = true;
  nav.appendChild(recentGroup);
  nav.appendChild(recentList);

  const toolsGroup = group('Tools');
  nav.appendChild(toolsGroup);
  for (const id of primary) {
    const btn = toolButton(id);
    if (btn) nav.appendChild(btn);
  }

  // "All tools" disclosure. Twenty-five rows in a flat list isn't navigation, so
  // the long tail is collapsed behind a real aria-expanded button rather than
  // simply dropped.
  let moreGroup: HTMLElement | null = null;
  let allTools: HTMLElement | null = null;
  let allToolsToggle: HTMLElement | null = null;
  if (secondary.length > 0) {
    moreGroup = group('More');
    nav.appendChild(moreGroup);
    allTools = el('div', { class: 'all-tools' });
    allTools.hidden = true;
    for (const id of secondary) {
      const btn = toolButton(id);
      if (btn) allTools.appendChild(btn);
    }
    const toggle = el('button', {
      class: 'sfdt-nav-item',
      type: 'button',
      id: 'sfdt-all-tools',
      title: `All tools (${secondary.length})`,
      'aria-label': `All tools (${secondary.length})`,
      'aria-expanded': 'false',
      'aria-controls': 'sfdt-all-tools-list',
    });
    allTools.id = 'sfdt-all-tools-list';
    toggle.appendChild(glyph('grid', 20));
    toggle.appendChild(el('span', { class: 'sfdt-nav-label' }, 'All tools'));
    toggle.appendChild(el('span', { class: 'sfdt-nav-trail sfdt-caps' }, String(secondary.length)));
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      if (allTools) allTools.hidden = open;
    });
    allToolsToggle = toggle;
    nav.appendChild(toggle);
    nav.appendChild(allTools);
  }

  const noMatches = el('div', { class: 'no-matches' }, 'No tools match that search.');
  noMatches.hidden = true;
  nav.appendChild(noMatches);

  /**
   * Filter the sidebar to tools whose label matches `term`.
   *
   * While filtering, the group headings and the All-tools disclosure are hidden
   * and the long tail is force-shown: a search that silently omitted 18 of 25
   * tools because they sit behind a collapsed toggle would be worse than no
   * search. Clearing the box restores the collapsed state exactly.
   */
  function applyToolFilter(term: string): void {
    const q = term.trim().toLowerCase();
    const filtering = q.length > 0;

    for (const g of [recentGroup, toolsGroup, moreGroup]) {
      if (!g) continue;
      // Recent has its own hidden state; don't resurrect it when the filter clears.
      if (g === recentGroup) {
        g.hidden = filtering || recentList.hidden;
        continue;
      }
      g.hidden = filtering;
    }
    recentList.hidden = filtering || recentList.childElementCount === 0;
    if (allToolsToggle) allToolsToggle.hidden = filtering;
    if (allTools) {
      allTools.hidden = filtering
        ? false
        : allToolsToggle?.getAttribute('aria-expanded') !== 'true';
    }

    let matches = 0;
    for (const btn of nav.querySelectorAll<HTMLElement>('[data-tool-id]')) {
      const label = btn.textContent?.toLowerCase() ?? '';
      const hit = !filtering || label.includes(q);
      btn.hidden = !hit;
      if (hit && filtering) matches++;
    }
    noMatches.hidden = !filtering || matches > 0;
  }

  searchInput.addEventListener('input', () => applyToolFilter(searchInput.value));

  void populateRecent(recentGroup, recentList, opts, (id) => toolButton(id), primary);

  const overviewOptions: OverviewOptions = {
    orgHost,
    api,
    enabledTools,
    openTool,
    loadActivity: opts.loadActivity,
    clearActivity: opts.clearActivity,
  };
  renderOverview(welcome, overviewOptions);
  // Re-reads org limits and the activity log. Rebuilding the panel is cheaper
  // than threading refresh handles out of every async fill.
  refreshBtn.addEventListener('click', () => renderOverview(welcome, overviewOptions));

  layout.appendChild(sidebar);
  layout.appendChild(main);
  root.appendChild(layout);

  showToast(`Workspace connected to ${orgHost}`, { kind: 'success' });
}
