import { releaseFromVersionList, ORG_HEALTH_THRESHOLDS, type OrgReleaseInfo } from '@sfdt/flow-core';
import { isFeatureEnabled, loadSettings, onSettingsChange } from '../lib/settings.js';
import type { Feature } from '../lib/feature-registry.js';
import { CONTEXTS } from '../lib/context-detector.js';
import { waitForTabBar } from '../lib/setup-tab-bar.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';

// An interactive pill in the Setup tab strip auditing the org's API-version
// spread: org max API version + release (via /services/data, same flow-core
// reduction as the release badge) plus per-type ApiVersion histograms from the
// Tooling API. "Behind" = components below flow-core's minApiVersionFloor, so
// the banding matches the CLI's org-health checks. Clicking the pill toggles a
// small histogram panel.

const AUDIT_CLASS = 'sfdt-api-version-audit';
const PANEL_CLASS = 'sfdt-api-version-audit-panel';
const BEHIND_COLOUR = 'var(--sfdt-color-warning)'; // amber — matches org-health's amber band
const OK_COLOUR = 'var(--sfdt-color-text-muted)'; // neutral grey

interface ApiVersionRow {
  ApiVersion?: number | null;
}

/** version → count, oldest first. */
export type VersionHistogram = ReadonlyArray<readonly [number, number]>;

export interface TypeDistribution {
  label: string;
  versions: VersionHistogram;
}

export interface AuditData {
  release: OrgReleaseInfo | null;
  types: TypeDistribution[];
}

const TYPE_QUERIES: ReadonlyArray<{ label: string; soql: string }> = [
  { label: 'Apex Classes', soql: 'SELECT ApiVersion FROM ApexClass WHERE NamespacePrefix = null' },
  { label: 'Apex Triggers', soql: 'SELECT ApiVersion FROM ApexTrigger WHERE NamespacePrefix = null' },
  { label: 'Flows', soql: "SELECT ApiVersion FROM Flow WHERE Status = 'Active'" },
];

/** Aggregate raw ApiVersion rows into a version→count histogram, oldest first. */
export function aggregateVersions(rows: ReadonlyArray<ApiVersionRow>): VersionHistogram {
  const counts = new Map<number, number>();
  for (const row of rows) {
    const v = row?.ApiVersion;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0] - b[0]);
}

/** Components with an ApiVersion below flow-core's minApiVersionFloor. */
export function countBehind(types: ReadonlyArray<TypeDistribution>): number {
  let behind = 0;
  for (const t of types) {
    for (const [version, count] of t.versions) {
      if (version < ORG_HEALTH_THRESHOLDS.minApiVersionFloor) behind += count;
    }
  }
  return behind;
}

/** Compose the short pill text + hover title from the fetched data. */
export function describeAuditPill(data: AuditData): { text: string; title: string } {
  const behind = countBehind(data.types);
  const parts = [data.release ? `API v${data.release.apiVersion}` : 'API versions'];
  if (behind > 0) parts.push(`${behind} behind`);

  const titleBits: string[] = [];
  if (data.release) {
    titleBits.push(
      `Org max API v${data.release.apiVersion} — ${data.release.release}${data.release.preview ? ' (preview)' : ''}`,
    );
  }
  titleBits.push(
    behind > 0
      ? `${behind} component${behind === 1 ? '' : 's'} below v${ORG_HEALTH_THRESHOLDS.minApiVersionFloor}`
      : `No components below v${ORG_HEALTH_THRESHOLDS.minApiVersionFloor}`,
  );
  return { text: parts.join(' · '), title: titleBits.join(' · ') };
}

/** Fetch release + per-type distributions; null only when nothing could be read. */
async function fetchAuditData(api: SalesforceApiClient): Promise<AuditData | null> {
  let release: OrgReleaseInfo | null = null;
  try {
    release = releaseFromVersionList(await api.apiGet('/services/data'));
  } catch {
    // Informational — a failed version list just drops the footer.
  }

  const types: TypeDistribution[] = [];
  for (const t of TYPE_QUERIES) {
    try {
      const res = await api.toolingQuery<ApiVersionRow>(t.soql);
      types.push({ label: t.label, versions: aggregateVersions(res.records) });
    } catch {
      // Each query stands alone — e.g. a failing Flow query still renders Apex.
    }
  }

  if (!release && types.length === 0) return null;
  return { release, types };
}

function buildPanel(doc: Document, data: AuditData): HTMLDivElement {
  const panel = doc.createElement('div');
  panel.className = PANEL_CLASS;
  panel.style.cssText = [
    'position: absolute',
    'top: 100%',
    'right: 0',
    'z-index: 99999',
    'background: var(--sfdt-color-surface)',
    'border: 1px solid var(--sfdt-color-border)',
    'border-radius: 4px',
    'box-shadow: 0 2px 8px rgba(0,0,0,0.15)',
    'padding: 10px 12px',
    'min-width: 240px',
    'max-height: 380px',
    'overflow-y: auto',
    'font-size: 12px',
    'color: var(--sfdt-color-text-strong)',
    'text-align: left',
    'white-space: nowrap',
  ].join('; ');

  const floor = ORG_HEALTH_THRESHOLDS.minApiVersionFloor;
  for (const t of data.types) {
    const heading = doc.createElement('div');
    heading.style.cssText = 'font-weight: 700; margin: 6px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.02em; color: var(--sfdt-color-text-weak);';
    heading.textContent = t.label;
    panel.appendChild(heading);

    if (t.versions.length === 0) {
      const empty = doc.createElement('div');
      empty.style.cssText = 'color: var(--sfdt-color-text-weak); font-style: italic;';
      empty.textContent = 'none';
      panel.appendChild(empty);
      continue;
    }

    const max = Math.max(...t.versions.map(([, count]) => count));
    for (const [version, count] of t.versions) {
      const below = version < floor;
      const row = doc.createElement('div');
      row.className = `${PANEL_CLASS}-row`;
      row.style.cssText = [
        'display: flex',
        'align-items: center',
        'gap: 8px',
        'padding: 1px 4px',
        below ? `color: ${BEHIND_COLOUR}; font-weight: 700; background: var(--sfdt-color-warning-bg-5)` : '',
      ].join('; ');
      if (below) row.dataset['belowFloor'] = 'true';

      const label = doc.createElement('span');
      label.style.cssText = 'width: 36px; flex: 0 0 auto;';
      label.textContent = `v${version}`;
      const bar = doc.createElement('span');
      bar.style.cssText = [
        'display: inline-block',
        'height: 8px',
        'border-radius: 2px',
        `width: ${Math.max(4, Math.round((count / max) * 80))}px`,
        `background: ${below ? BEHIND_COLOUR : 'var(--sfdt-color-info)'}`,
      ].join('; ');
      const countEl = doc.createElement('span');
      countEl.textContent = String(count);
      row.append(label, bar, countEl);
      panel.appendChild(row);
    }
  }

  if (data.release) {
    const footer = doc.createElement('div');
    footer.className = `${PANEL_CLASS}-footer`;
    footer.style.cssText = 'margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--sfdt-color-border); color: var(--sfdt-color-text-weak);';
    footer.textContent = `Org max: v${data.release.apiVersion} — ${data.release.release}${data.release.preview ? ' (preview)' : ''}`;
    panel.appendChild(footer);
  }

  return panel;
}

function removeAudit(doc: Document): void {
  for (const el of doc.querySelectorAll(`.${AUDIT_CLASS}`)) el.remove();
}

export interface ApiVersionAuditOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
  waitTimeoutMs?: number;
}

export function createApiVersionAuditFeature(options: ApiVersionAuditOptions = {}): Feature {
  const doc = options.doc ?? document;
  const api = options.api ?? getSalesforceApi();
  const timeoutMs = options.waitTimeoutMs ?? 10_000;
  let injecting = false;
  let unsubscribe: (() => void) | null = null;
  // Version spread doesn't change within a session — fetch once, reuse across
  // SPA navigations (each nav rebuilds the tab bar, so we re-inject the pill).
  let cached: AuditData | null = null;
  let escListener: ((e: KeyboardEvent) => void) | null = null;
  let outsideListener: ((e: MouseEvent) => void) | null = null;

  function closePanel(): void {
    for (const el of doc.querySelectorAll(`.${PANEL_CLASS}`)) el.remove();
    if (escListener) {
      doc.removeEventListener('keydown', escListener);
      escListener = null;
    }
    if (outsideListener) {
      doc.removeEventListener('click', outsideListener);
      outsideListener = null;
    }
  }

  function togglePanel(host: HTMLElement, data: AuditData): void {
    if (host.querySelector(`.${PANEL_CLASS}`)) {
      closePanel();
      return;
    }
    closePanel();
    host.appendChild(buildPanel(doc, data));
    escListener = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel();
    };
    doc.addEventListener('keydown', escListener);
    // Close on click outside the pill/panel — matches the dropdown pattern in
    // rest-explore/soql-runner; without it the absolute panel floats over
    // subsequent content after an SPA nav (which rebuilds the tab bar).
    outsideListener = (e: MouseEvent) => {
      if (!host.contains(e.target as Node)) closePanel();
    };
    doc.addEventListener('click', outsideListener);
  }

  function buildPill(data: AuditData): HTMLLIElement {
    const { text, title } = describeAuditPill(data);
    const li = doc.createElement('li');
    li.setAttribute('role', 'presentation');
    li.className = `oneConsoleTabItem tabItem slds-context-bar__item ${AUDIT_CLASS}`;
    li.style.cssText = 'display: flex; align-items: center; padding: 0 8px; position: relative;';

    const pill = doc.createElement('span');
    const behind = countBehind(data.types) > 0;
    pill.style.cssText = [
      'font-size: 10px',
      'font-weight: 700',
      'text-transform: uppercase',
      'letter-spacing: 0.02em',
      'color: var(--sfdt-color-on-accent)',
      `background: ${behind ? BEHIND_COLOUR : OK_COLOUR}`,
      'border-radius: 3px',
      'padding: 2px 8px',
      'white-space: nowrap',
      'cursor: pointer',
    ].join('; ');
    pill.textContent = text;
    pill.title = title;
    // stopPropagation so this opening click doesn't immediately reach the
    // outside-click listener togglePanel registers on the document.
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel(li, data);
    });

    li.appendChild(pill);
    return li;
  }

  async function injectIfEnabled(): Promise<void> {
    const settings = await loadSettings();
    if (!isFeatureEnabled(settings, 'api-version-audit')) {
      closePanel();
      removeAudit(doc);
      return;
    }
    if (injecting) return;
    if (doc.querySelector(`.${AUDIT_CLASS}`)) return;

    injecting = true;
    try {
      const tabBar = await waitForTabBar(doc, timeoutMs);
      if (!tabBar) return;
      if (doc.querySelector(`.${AUDIT_CLASS}`)) return; // another pass mounted it while we waited

      cached ??= await fetchAuditData(api);
      if (!cached) return;
      tabBar.appendChild(buildPill(cached));
    } catch (err) {
      console.warn('[SFDT api-version-audit] failed to render', err);
    } finally {
      injecting = false;
    }
  }

  return {
    manifest: {
      id: 'api-version-audit',
      name: 'API Version Audit',
      contexts: [CONTEXTS.SETUP_FLOWS, CONTEXTS.FLOW_TRIGGER_EXPLORER, CONTEXTS.SETUP_OTHER],
    },

    async init() {
      await injectIfEnabled();
      unsubscribe = onSettingsChange(async () => {
        closePanel();
        removeAudit(doc);
        await injectIfEnabled();
      });
    },

    // Side-button activation: make sure the pill exists, then toggle its panel.
    async onActivate() {
      await injectIfEnabled();
      const host = doc.querySelector<HTMLElement>(`.${AUDIT_CLASS}`);
      if (host && cached) togglePanel(host, cached);
    },

    async refresh() {
      closePanel();
      removeAudit(doc);
      await injectIfEnabled();
    },

    async teardown() {
      unsubscribe?.();
      unsubscribe = null;
      closePanel();
      removeAudit(doc);
    },
  };
}

export function _apiVersionAuditTestApi() {
  return { AUDIT_CLASS, PANEL_CLASS };
}
