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
//
// Each histogram bucket carries the component NAMES at that version (the
// queries select a name field, so this costs no extra round-trip). Below-floor
// buckets render as disclosure buttons that expand to the name list — the
// "which classes are actually behind?" answer the CLI already gives via
// `sfdt versions` outliers.

const PANEL_CLASS = 'sfdt-api-version-audit-panel';
// Fills/bars use the base token; TEXT uses the foreground variant — a fill
// token as .style.color renders low-contrast in dark (see extension CLAUDE.md).
const BEHIND_FILL = 'var(--sfdt-color-warning)';
const BEHIND_TEXT = 'var(--sfdt-color-warning-text)';

interface ApiVersionRow {
  ApiVersion?: number | null;
  // Name shape varies by type: Name (Apex), DeveloperName (LWC/Aura),
  // Definition.DeveloperName (Flow).
  Name?: string | null;
  DeveloperName?: string | null;
  Definition?: { DeveloperName?: string | null } | null;
}

/** One API version and the components sitting on it. `names.length` is the count. */
export interface VersionBucket {
  version: number;
  names: string[];
}

/** Buckets oldest version first. */
export type VersionHistogram = ReadonlyArray<VersionBucket>;

export interface TypeDistribution {
  label: string;
  versions: VersionHistogram;
}

export interface AuditData {
  release: OrgReleaseInfo | null;
  types: TypeDistribution[];
}

const TYPE_QUERIES: ReadonlyArray<{ label: string; soql: string }> = [
  { label: 'Apex Classes', soql: 'SELECT Name, ApiVersion FROM ApexClass WHERE NamespacePrefix = null' },
  { label: 'Apex Triggers', soql: 'SELECT Name, ApiVersion FROM ApexTrigger WHERE NamespacePrefix = null' },
  { label: 'Flows', soql: "SELECT Definition.DeveloperName, ApiVersion FROM Flow WHERE Status = 'Active'" },
  {
    label: 'Lightning Web Components',
    soql: 'SELECT DeveloperName, ApiVersion FROM LightningComponentBundle WHERE NamespacePrefix = null',
  },
  {
    label: 'Aura Components',
    soql: 'SELECT DeveloperName, ApiVersion FROM AuraDefinitionBundle WHERE NamespacePrefix = null',
  },
];

/** The component name across the three Tooling row shapes. */
function rowName(row: ApiVersionRow): string {
  const raw = row?.Name ?? row?.DeveloperName ?? row?.Definition?.DeveloperName;
  return typeof raw === 'string' && raw.trim() ? raw : '(unknown)';
}

/**
 * Aggregate raw rows into version buckets, oldest first, names sorted within
 * each bucket. Rows without a usable ApiVersion are skipped.
 */
export function aggregateVersions(rows: ReadonlyArray<ApiVersionRow>): VersionHistogram {
  const buckets = new Map<number, string[]>();
  for (const row of rows) {
    const v = row?.ApiVersion;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const names = buckets.get(v);
    if (names) names.push(rowName(row));
    else buckets.set(v, [rowName(row)]);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([version, names]) => ({ version, names: names.sort((a, b) => a.localeCompare(b)) }));
}

/** Components with an ApiVersion below flow-core's minApiVersionFloor. */
export function countBehind(types: ReadonlyArray<TypeDistribution>): number {
  let behind = 0;
  for (const t of types) {
    for (const bucket of t.versions) {
      if (bucket.version < ORG_HEALTH_THRESHOLDS.minApiVersionFloor) behind += bucket.names.length;
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
  let listId = 0; // unique aria-controls targets within this panel
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

    const max = Math.max(...t.versions.map((b) => b.names.length));
    for (const bucket of t.versions) {
      const below = bucket.version < floor;
      // Below-floor buckets are expandable (native <button>, aria-expanded,
      // labelled) so the user can see WHICH components are behind. On-floor
      // buckets stay inert — nothing to action there.
      const row = doc.createElement(below ? 'button' : 'div');
      row.className = `${PANEL_CLASS}-row`;
      row.style.cssText = [
        'display: flex',
        'align-items: center',
        'gap: 8px',
        'padding: 1px 4px',
        'width: 100%',
        'box-sizing: border-box',
        'text-align: left',
        'font: inherit',
        below
          ? `color: ${BEHIND_TEXT}; font-weight: 700; background: var(--sfdt-color-warning-bg-5); border: 0; border-radius: 2px; cursor: pointer`
          : 'background: none; border: 0',
      ].join('; ');

      const caret = doc.createElement('span');
      caret.setAttribute('aria-hidden', 'true');
      caret.style.cssText = 'width: 10px; flex: 0 0 auto;';
      caret.textContent = below ? '▸' : '';

      const label = doc.createElement('span');
      label.style.cssText = 'width: 36px; flex: 0 0 auto;';
      label.textContent = `v${bucket.version}`;
      const bar = doc.createElement('span');
      bar.style.cssText = [
        'display: inline-block',
        'height: 8px',
        'border-radius: 2px',
        `width: ${Math.max(4, Math.round((bucket.names.length / max) * 80))}px`,
        `background: ${below ? BEHIND_FILL : 'var(--sfdt-color-info)'}`,
      ].join('; ');
      const countEl = doc.createElement('span');
      countEl.textContent = String(bucket.names.length);
      row.append(caret, label, bar, countEl);

      if (!below) {
        panel.appendChild(row);
        continue;
      }

      row.dataset['belowFloor'] = 'true';
      (row as HTMLButtonElement).type = 'button';
      listId += 1;
      const namesId = `${PANEL_CLASS}-names-${listId}`;
      const n = bucket.names.length;
      row.setAttribute('aria-expanded', 'false');
      row.setAttribute('aria-controls', namesId);
      row.setAttribute(
        'aria-label',
        `${t.label}: ${n} component${n === 1 ? '' : 's'} on API v${bucket.version}, below the v${floor} floor. Show names.`,
      );

      const names = doc.createElement('ul');
      names.id = namesId;
      names.className = `${PANEL_CLASS}-names`;
      names.hidden = true;
      names.style.cssText = [
        'margin: 2px 0 6px 54px',
        'padding: 0',
        'list-style: none',
        'font-weight: 400',
        'font-size: 12px',
        'color: var(--sfdt-color-text-weak)',
      ].join('; ');
      for (const name of bucket.names) {
        const li = doc.createElement('li');
        li.style.cssText = 'padding: 1px 0;';
        li.textContent = name;
        names.appendChild(li);
      }

      row.addEventListener('click', () => {
        const open = row.getAttribute('aria-expanded') === 'true';
        row.setAttribute('aria-expanded', String(!open));
        names.hidden = open;
        caret.textContent = open ? '▸' : '▾';
      });

      panel.append(row, names);
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
