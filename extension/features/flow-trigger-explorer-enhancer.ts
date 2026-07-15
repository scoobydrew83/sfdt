// Flow Trigger Explorer Enhancer — Salesforce's native Flow Trigger Explorer
// (`/interaction_explorer/flowExplorer`) only shows one object at a time and
// omits the active version number and a quick way into Flow Builder. This tool
// opens a cross-object panel of every ACTIVE record-triggered flow, grouped by
// object and trigger timing (Before Save / After Save / Before Delete), each row
// carrying its trigger event, process type, description and a one-click
// "Open in Builder" link.
//
// Data comes from a SINGLE `FlowDefinitionView` SOQL query — the same source
// that powers the native page — rather than scraping the page's LWC DOM (which
// is fragile) or fanning out one Metadata fetch per flow (which is slow on orgs
// with hundreds of triggered flows). One live query, keyed off the current org's
// session (getSalesforceApi()), exactly like SOQL Runner and Apex Coverage.

import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';

// FlowDefinitionView is a standard, read-only object queryable via the Data API.
// Only record-triggered flows carry these TriggerType values.
const RECORD_TRIGGER_TYPES = ['RecordBeforeSave', 'RecordAfterSave', 'RecordBeforeDelete'] as const;

export interface FlowDefinitionViewRow {
  ApiName: string;
  Label?: string;
  TriggerType?: string;
  RecordTriggerType?: string;
  TriggerObjectOrEventLabel?: string;
  IsActive?: boolean;
  ActiveVersionId?: string | null;
  ProcessType?: string;
  Description?: string | null;
}

export type TriggerTiming = 'BeforeSave' | 'AfterSave' | 'BeforeDelete' | 'Other';

// Native Trigger Explorer order: everything that runs before the save, then
// after-save automation, then before-delete. Keeps the panel scannable.
const TIMING_RANK: Record<TriggerTiming, number> = {
  BeforeSave: 0,
  AfterSave: 1,
  BeforeDelete: 2,
  Other: 3,
};

const TIMING_LABEL: Record<TriggerTiming, string> = {
  BeforeSave: 'Before Save',
  AfterSave: 'After Save',
  BeforeDelete: 'Before Delete',
  Other: 'Other',
};

const TIMING_COLOUR: Record<TriggerTiming, string> = {
  BeforeSave: 'var(--sfdt-color-brand)',
  AfterSave: 'var(--sfdt-color-success)',
  BeforeDelete: 'var(--sfdt-color-error)',
  Other: 'var(--sfdt-color-text-muted)',
};

export function triggerTiming(triggerType: string | undefined): TriggerTiming {
  const t = (triggerType ?? '').toLowerCase();
  if (t.includes('before') && t.includes('delete')) return 'BeforeDelete';
  if (t.includes('before')) return 'BeforeSave';
  if (t.includes('after')) return 'AfterSave';
  return 'Other';
}

function eventLabel(recordTriggerType: string | undefined): string {
  switch ((recordTriggerType ?? '').toLowerCase()) {
    case 'create':
      return 'on Create';
    case 'update':
      return 'on Update';
    case 'createandupdate':
    case 'createorupdate':
      return 'on Create or Update';
    case 'delete':
      return 'on Delete';
    default:
      return recordTriggerType ? `on ${recordTriggerType}` : '';
  }
}

export interface TriggeredFlow {
  apiName: string;
  label: string;
  timing: TriggerTiming;
  timingLabel: string;
  event: string;
  processType: string;
  description: string;
  activeVersionId: string | null;
}

export interface ObjectGroup {
  object: string;
  flows: TriggeredFlow[];
}

/** Group active record-triggered flows by object, sorted by timing then label. */
export function shapeTriggeredFlows(rows: readonly FlowDefinitionViewRow[]): ObjectGroup[] {
  const byObject = new Map<string, TriggeredFlow[]>();
  for (const r of rows) {
    const timing = triggerTiming(r.TriggerType);
    const object = (r.TriggerObjectOrEventLabel ?? '').trim() || 'Unknown object';
    const flow: TriggeredFlow = {
      apiName: r.ApiName,
      label: (r.Label ?? '').trim() || r.ApiName,
      timing,
      timingLabel: TIMING_LABEL[timing],
      event: eventLabel(r.RecordTriggerType),
      processType: r.ProcessType ?? '',
      description: (r.Description ?? '').trim(),
      activeVersionId: r.ActiveVersionId ?? null,
    };
    const list = byObject.get(object);
    if (list) list.push(flow);
    else byObject.set(object, [flow]);
  }

  const groups: ObjectGroup[] = [...byObject.entries()].map(([object, flows]) => ({
    object,
    flows: flows.sort(
      (a, b) => TIMING_RANK[a.timing] - TIMING_RANK[b.timing] || a.label.localeCompare(b.label),
    ),
  }));
  return groups.sort((a, b) => a.object.localeCompare(b.object));
}

/** Flow Builder deep link for a specific active version (301… id). */
export function flowBuilderUrl(origin: string, activeVersionId: string): string {
  return `${origin}/builder_platform_interaction/flowBuilder.app?flowId=${encodeURIComponent(activeVersionId)}`;
}

export async function discoverTriggeredFlows(
  api: SalesforceApiClient,
): Promise<ObjectGroup[]> {
  const inClause = RECORD_TRIGGER_TYPES.map((t) => `'${t}'`).join(', ');
  const soql =
    'SELECT ApiName, Label, TriggerType, RecordTriggerType, TriggerObjectOrEventLabel, ' +
    'IsActive, ActiveVersionId, ProcessType, Description ' +
    'FROM FlowDefinitionView ' +
    `WHERE IsActive = true AND TriggerType IN (${inClause}) ` +
    'ORDER BY TriggerObjectOrEventLabel NULLS LAST, Label';
  const result = await api.query<FlowDefinitionViewRow>(soql);
  return shapeTriggeredFlows(result.records);
}

function renderGroups(doc: Document, results: HTMLElement, groups: ObjectGroup[], origin: string): void {
  for (const group of groups) {
    const section = doc.createElement('div');
    section.style.cssText = 'margin-bottom: 16px;';

    const header = doc.createElement('div');
    header.style.cssText =
      'font-weight: 700; font-size: 13px; padding: 6px 0; border-bottom: 2px solid var(--sfdt-color-border); margin-bottom: 8px;';
    header.textContent = `${group.object} · ${group.flows.length} flow${group.flows.length === 1 ? '' : 's'}`;
    section.appendChild(header);

    for (const flow of group.flows) {
      const row = doc.createElement('div');
      row.style.cssText =
        'border: 1px solid var(--sfdt-color-border); border-radius: 4px; padding: 8px 10px; margin-bottom: 6px; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;';

      const badge = doc.createElement('span');
      badge.style.cssText = `flex: 0 0 auto; font-size: 10px; font-weight: 700; color: var(--sfdt-color-on-accent); background: ${TIMING_COLOUR[flow.timing]}; border-radius: 3px; padding: 2px 6px;`;
      badge.textContent = flow.timingLabel;

      const name = doc.createElement('span');
      name.style.cssText = 'font-weight: 600; font-size: 12px;';
      name.textContent = flow.label;

      const meta = doc.createElement('span');
      meta.style.cssText = 'color: var(--sfdt-color-text-weak); font-size: 11px;';
      meta.textContent = [flow.event, flow.processType].filter(Boolean).join(' · ');

      row.append(badge, name, meta);

      if (flow.activeVersionId) {
        const link = doc.createElement('a');
        link.href = flowBuilderUrl(origin, flow.activeVersionId);
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'Open in Builder ↗';
        link.style.cssText = 'margin-left: auto; font-size: 11px; color: var(--sfdt-color-brand-text); text-decoration: none;';
        row.appendChild(link);
      }

      if (flow.description) {
        const desc = doc.createElement('div');
        desc.style.cssText = 'flex: 1 0 100%; color: var(--sfdt-color-text); font-size: 11px; margin-top: 2px;';
        desc.textContent = flow.description;
        row.appendChild(desc);
      }

      section.appendChild(row);
    }
    results.appendChild(section);
  }
}

export interface FlowTriggerExplorerEnhancerOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
}

export function createFlowTriggerExplorerEnhancerFeature(
  options: FlowTriggerExplorerEnhancerOptions = {},
): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();

  let view: ViewHandle | null = null;

  function close(): void {
    view?.close();
    view = null;
  }

  async function fetchAndRender(results: HTMLElement, status: HTMLSpanElement): Promise<void> {
    status.textContent = 'Loading…';
    while (results.firstChild) results.removeChild(results.firstChild);
    try {
      const groups = await discoverTriggeredFlows(api);
      const total = groups.reduce((n, g) => n + g.flows.length, 0);
      status.textContent = `${total} flow${total === 1 ? '' : 's'} · ${groups.length} object${groups.length === 1 ? '' : 's'}`;
      if (total === 0) {
        const empty = doc.createElement('div');
        empty.style.cssText = 'padding: 12px; color: var(--sfdt-color-text-icon);';
        empty.textContent = 'No active record-triggered flows in this org.';
        results.appendChild(empty);
        return;
      }
      renderGroups(doc, results, groups, win.location.origin);
    } catch (err) {
      const panel = doc.createElement('div');
      panel.style.cssText =
        'border: 1px solid var(--sfdt-color-error); background: var(--sfdt-color-error-bg); color: var(--sfdt-color-error-text); padding: 8px 12px; border-radius: 4px; font-size: 13px;';
      panel.textContent = err instanceof Error ? err.message : String(err);
      results.appendChild(panel);
      status.textContent = 'Failed';
    }
  }

  async function open(): Promise<void> {
    close();

    const body = doc.createElement('div');
    body.style.cssText = 'padding: 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column;';

    const toolbar = doc.createElement('div');
    toolbar.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 12px;';
    const status = doc.createElement('span');
    status.style.cssText = 'color: var(--sfdt-color-text-weak); font-size: 12px;';
    const refreshBtn = doc.createElement('button');
    refreshBtn.textContent = 'Refresh';
    refreshBtn.style.cssText =
      'margin-left: auto; padding: 4px 10px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); border-radius: 4px; cursor: pointer; font-size: 12px;';
    toolbar.append(status, refreshBtn);
    body.appendChild(toolbar);

    const results = doc.createElement('div');
    body.appendChild(results);

    view = presentView({
      title: '🧭 Flow Trigger Explorer',
      body,
      doc,
      width: '820px',
      onClose: () => { view = null; },
    });

    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      await fetchAndRender(results, status);
      refreshBtn.disabled = false;
    });
    await fetchAndRender(results, status);
  }

  return {
    manifest: {
      id: 'flow-trigger-explorer-enhancer',
      name: 'Flow Trigger Explorer Enhancer',
      contexts: [CONTEXTS.FLOW_TRIGGER_EXPLORER],
    },

    async onActivate() {
      const ctx = detectContext({ location: { href: win.location.href } }, doc);
      if (ctx === CONTEXTS.NONE) return;
      await open();
    },
  };
}

export function _flowTriggerExplorerEnhancerTestApi() {
  return { shapeTriggeredFlows, triggerTiming, flowBuilderUrl, discoverTriggeredFlows };
}
