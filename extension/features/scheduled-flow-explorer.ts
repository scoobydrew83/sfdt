import {
  calculateNextRun,
  formatDateLong,
  formatRelative,
  formatTime,
  parseActivationDate,
  parseSchedule,
  type ParsedSchedule,
} from '@sfdt/flow-core';
import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import { escapeSoql } from '../lib/escape.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { registerSettingsShape } from '../lib/settings.js';
import { z } from 'zod';

const SCHEDULED_FLOW_EXPLORER_SETTINGS_SCHEMA = z.object({
  defaultView: z.enum(['list', 'calendar']).default('list'),
});

registerSettingsShape('scheduled-flow-explorer', SCHEDULED_FLOW_EXPLORER_SETTINGS_SCHEMA);

const METADATA_FETCH_CONCURRENCY = 5;

interface FlowDefinition {
  Id: string;
  DeveloperName: string;
  ActiveVersionId: string | null;
  LatestVersionId: string | null;
}

interface FlowVersionRecord {
  Id: string;
  MasterLabel?: string;
  Description?: string;
  Status?: string;
  VersionNumber?: number;
  LastModifiedDate?: string;
  Metadata?: Record<string, unknown>;
}

export interface ScheduledFlowEntry {
  flowDefinitionId: string;
  activeVersionId: string;
  developerName: string;
  label: string;
  parsedSchedule: ParsedSchedule;
  activationDate: Date | null;
  versionNumber: number | undefined;
  status: string | undefined;
  description: string | null;
}

export interface DiscoveryResult {
  flows: ScheduledFlowEntry[];
  errors: Array<{ flowDefinitionId: string; activeVersionId: string | null; message: string }>;
}

export async function discoverScheduledFlows(
  api: SalesforceApiClient,
): Promise<DiscoveryResult> {
  const defResult = await api.toolingQuery<FlowDefinition>(
    'SELECT Id, DeveloperName, ActiveVersionId, LatestVersionId FROM FlowDefinition ' +
      'WHERE ActiveVersionId != null ORDER BY DeveloperName ASC',
  );
  const definitions = defResult.records;
  if (definitions.length === 0) return { flows: [], errors: [] };

  const flows: ScheduledFlowEntry[] = [];
  const errors: DiscoveryResult['errors'] = [];

  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= definitions.length) return;
      const def = definitions[idx]!;
      if (!def.ActiveVersionId) continue;
      try {
        const result = await api.toolingQuery<FlowVersionRecord>(
          'SELECT Id, MasterLabel, Description, Status, VersionNumber, LastModifiedDate, Metadata ' +
            `FROM Flow WHERE Id = '${escapeSoql(def.ActiveVersionId)}'`,
        );
        const record = result.records[0];
        if (!record) continue;
        const parsed = parseSchedule(record as never);
        if (!parsed) continue; // not Scheduled-Triggered
        flows.push({
          flowDefinitionId: def.Id,
          activeVersionId: def.ActiveVersionId,
          developerName: def.DeveloperName,
          label: record.MasterLabel ?? def.DeveloperName,
          description: record.Description ?? null,
          parsedSchedule: parsed,
          activationDate: parseActivationDate(record.LastModifiedDate ?? null),
          versionNumber: record.VersionNumber,
          status: record.Status,
        });
      } catch (err) {
        errors.push({
          flowDefinitionId: def.Id,
          activeVersionId: def.ActiveVersionId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(METADATA_FETCH_CONCURRENCY, definitions.length) }, () => worker()),
  );
  return { flows, errors };
}

function buildModal(doc: Document, result: DiscoveryResult, now: Date): HTMLDivElement {
  const overlay = doc.createElement('div');
  overlay.className = 'sfut-scheduled-flow-overlay';
  overlay.style.cssText =
    'position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 100020; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif;';

  const modal = doc.createElement('div');
  modal.style.cssText =
    'background: #fff; border-radius: 4px; width: 720px; max-width: 90vw; max-height: 90vh; display: flex; flex-direction: column;';

  const header = doc.createElement('div');
  header.style.cssText =
    'padding: 12px 16px; border-bottom: 1px solid #d8dde6; display: flex; justify-content: space-between; align-items: center; font-weight: 600;';
  const headerLabel = doc.createElement('span');
  headerLabel.textContent = `Scheduled Flow Explorer — ${result.flows.length} flow${result.flows.length === 1 ? '' : 's'}`;
  const close = doc.createElement('button');
  close.textContent = '×';
  close.style.cssText = 'background: none; border: 0; font-size: 22px; cursor: pointer;';
  close.addEventListener('click', () => overlay.remove());
  header.appendChild(headerLabel);
  header.appendChild(close);
  modal.appendChild(header);

  const body = doc.createElement('div');
  body.style.cssText = 'padding: 16px; overflow-y: auto; flex: 1;';

  if (result.flows.length === 0) {
    const empty = doc.createElement('div');
    empty.textContent = 'No active Schedule-Triggered Flows in this org.';
    empty.style.color = '#80868d';
    body.appendChild(empty);
  } else {
    const list = doc.createElement('div');
    for (const entry of result.flows) {
      const next = calculateNextRun(entry.parsedSchedule, entry.activationDate, now);
      const row = doc.createElement('div');
      row.style.cssText =
        'padding: 10px; border: 1px solid #d8dde6; border-radius: 4px; margin-bottom: 8px;';
      const title = doc.createElement('div');
      title.style.fontWeight = '600';
      title.textContent = entry.label;
      const meta = doc.createElement('div');
      meta.style.cssText = 'color: #80868d; font-size: 12px; margin-top: 4px;';
      meta.textContent = `${entry.parsedSchedule.frequency} · ${entry.parsedSchedule.targetObject ?? 'no target object'}`;
      const nextRun = doc.createElement('div');
      nextRun.style.cssText = 'margin-top: 4px; font-size: 13px;';
      nextRun.textContent = next
        ? `Next run: ${formatDateLong(next)} at ${formatTime(next.getHours(), next.getMinutes())} (${formatRelative(next, now)})`
        : 'Next run: expired';
      row.appendChild(title);
      row.appendChild(meta);
      row.appendChild(nextRun);
      list.appendChild(row);
    }
    body.appendChild(list);
  }

  if (result.errors.length > 0) {
    const errBox = doc.createElement('div');
    errBox.style.cssText =
      'margin-top: 12px; padding: 10px; background: #fef2f1; border: 1px solid #c23934; border-radius: 4px; font-size: 12px;';
    errBox.textContent = `${result.errors.length} flow${result.errors.length === 1 ? '' : 's'} could not be loaded.`;
    body.appendChild(errBox);
  }

  modal.appendChild(body);
  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  return overlay;
}

export interface ScheduledFlowExplorerOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
  // For tests: lets the modal show "now" relative to a deterministic date.
  now?: () => Date;
}

export function createScheduledFlowExplorerFeature(
  options: ScheduledFlowExplorerOptions = {},
): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();
  const now = options.now ?? (() => new Date());

  return {
    manifest: {
      id: 'scheduled-flow-explorer',
      name: 'Scheduled Flow Explorer',
      contexts: [CONTEXTS.SETUP_FLOWS, CONTEXTS.SETUP_OTHER],
      settingsSchema: SCHEDULED_FLOW_EXPLORER_SETTINGS_SCHEMA,
    },

    async onActivate() {
      const ctx = detectContext({ location: { href: win.location.href } }, doc);
      if (ctx === CONTEXTS.NONE) return;

      const loadingOverlay = doc.createElement('div');
      loadingOverlay.style.cssText =
        'position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 100020; display: flex; align-items: center; justify-content: center; color: #fff; font-family: system-ui, sans-serif;';
      loadingOverlay.textContent = 'Discovering scheduled flows…';
      doc.body.appendChild(loadingOverlay);
      try {
        const result = await discoverScheduledFlows(api);
        loadingOverlay.remove();
        doc.body.appendChild(buildModal(doc, result, now()));
      } catch (err) {
        loadingOverlay.textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`;
        setTimeout(() => loadingOverlay.remove(), 3000);
      }
    },
  };
}

export function _scheduledFlowExplorerTestApi() {
  return { discoverScheduledFlows, buildModal };
}
