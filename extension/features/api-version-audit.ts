import { releaseFromVersionList, ORG_HEALTH_THRESHOLDS, type OrgReleaseInfo } from '@sfdt/flow-core';
import type { Feature } from '../lib/feature-registry.js';
import { CONTEXTS } from '../lib/context-detector.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';

// An org API-version audit, launched on demand from the ⚡ menu / command
// palette (no always-on Setup-strip pill). Reports the org max API version +
// release (via /services/data, same flow-core reduction as the release badge)
// plus per-type ApiVersion histograms from the Tooling API. "Behind" =
// components below flow-core's minApiVersionFloor, so the banding matches the
// CLI's org-health checks. Opens as a Workspace tab or a page modal.

const PANEL_CLASS = 'sfdt-api-version-audit-panel';
const BEHIND_COLOUR = 'var(--sfdt-color-warning)'; // amber — matches org-health's amber band

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
  // Modal/tab-pane content: the presenter (present-view) supplies the card
  // chrome, so this is a plain flex:1 scroll body rather than a floating pill
  // dropdown.
  panel.style.cssText = [
    'flex: 1',
    'overflow-y: auto',
    'padding: 12px 16px',
    'font-size: 13px',
    'color: var(--sfdt-color-text-strong)',
    'text-align: left',
  ].join('; ');

  const summary = doc.createElement('div');
  summary.style.cssText = 'font-weight: 700; font-size: 14px; margin-bottom: 10px;';
  summary.textContent = describeAuditPill(data).text;
  panel.appendChild(summary);

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

export interface ApiVersionAuditOptions {
  doc?: Document;
  api?: SalesforceApiClient;
}

export function createApiVersionAuditFeature(options: ApiVersionAuditOptions = {}): Feature {
  const doc = options.doc ?? document;
  const api = options.api ?? getSalesforceApi();
  // Version spread doesn't change within a session — fetch once, reuse.
  let cached: AuditData | null = null;
  let handle: ViewHandle | null = null;

  return {
    manifest: {
      id: 'api-version-audit',
      name: 'API Version Audit',
      contexts: [CONTEXTS.SETUP_FLOWS, CONTEXTS.FLOW_TRIGGER_EXPLORER, CONTEXTS.SETUP_OTHER],
    },

    // Launched on demand from the ⚡ menu / command palette. Opens the audit as
    // a view — a Workspace tab, or a centered modal on a Salesforce page. There
    // is no always-on Setup-strip pill.
    async onActivate() {
      cached ??= await fetchAuditData(api);
      if (!cached) return;
      handle?.close();
      handle = presentView({
        title: 'API Version Audit',
        body: buildPanel(doc, cached),
        doc,
        onClose: () => {
          handle = null;
        },
      });
    },

    async teardown() {
      handle?.close();
      handle = null;
    },
  };
}

export function _apiVersionAuditTestApi() {
  return { PANEL_CLASS };
}
