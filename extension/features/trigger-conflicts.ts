// Trigger Conflict Detector — extension UI for the detection engine that
// already lives in @sfdt/flow-core (Phase 5). Fetches every active Flow's
// metadata via Tooling API, runs detectTriggerConflicts, and renders the
// groups in a modal.
//
// The plan calls this "Phase 6b" and pairs it with a bulk activator that
// dispatches deploy / activate / deactivate through the sfdt bridge. The
// activator path requires the bridge `deploy` handler (still NOT_IMPLEMENTED
// at the time of writing); for Phase 6 we surface the conflicts visually and
// keep the action buttons present-but-disabled until the bridge wires
// deploy. The same pattern matches what Phase 6c does for one-click deploy.

import { detectTriggerConflicts, type FlowConflictGroup } from '@sfdt/flow-core';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { showToast } from '../ui/toast.js';

interface FlowDefinitionRecord {
  Id: string;
  DeveloperName: string;
  ActiveVersionId: string | null;
}

interface FlowVersionRecord {
  Id: string;
  MasterLabel?: string;
  Metadata?: Record<string, unknown>;
}

async function fetchActiveFlows(api: SalesforceApiClient): Promise<
  Array<{ flowId: string; label: string; metadata: Record<string, unknown> }>
> {
  const defs = await api.toolingQuery<FlowDefinitionRecord>(
    'SELECT Id, DeveloperName, ActiveVersionId FROM FlowDefinition ' +
      'WHERE ActiveVersionId != null ORDER BY DeveloperName ASC',
  );
  const out: Array<{ flowId: string; label: string; metadata: Record<string, unknown> }> = [];
  // Modest concurrency — Tooling API supports it and discovery is mostly
  // sequential time waiting for round-trips.
  const queue = [...defs.records];
  const concurrency = 5;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const def = queue.shift();
        if (!def?.ActiveVersionId) continue;
        try {
          const result = await api.toolingQuery<FlowVersionRecord>(
            `SELECT Id, MasterLabel, Metadata FROM Flow WHERE Id = '${def.ActiveVersionId.replace(/'/g, "\\'")}'`,
          );
          const record = result.records[0];
          if (record?.Metadata) {
            out.push({
              flowId: def.DeveloperName,
              label: record.MasterLabel ?? def.DeveloperName,
              metadata: record.Metadata,
            });
          }
        } catch {
          // Skip flows we can't read — surfacing every individual error is
          // noisy; the user will see them as missing rows in the modal.
        }
      }
    }),
  );
  return out;
}

export function buildConflictsModal(
  doc: Document,
  groups: readonly FlowConflictGroup[],
): HTMLDivElement {
  const overlay = doc.createElement('div');
  overlay.className = 'sfut-trigger-conflicts-overlay';
  overlay.style.cssText =
    'position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 100020; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif;';

  const modal = doc.createElement('div');
  modal.style.cssText =
    'background: #fff; border-radius: 4px; width: 720px; max-width: 90vw; max-height: 90vh; display: flex; flex-direction: column;';

  const header = doc.createElement('div');
  header.style.cssText =
    'padding: 12px 16px; border-bottom: 1px solid #d8dde6; display: flex; justify-content: space-between; align-items: center; font-weight: 600;';
  const headerLabel = doc.createElement('span');
  const totalFlows = groups.reduce((n, g) => n + g.flows.length, 0);
  headerLabel.textContent =
    groups.length === 0
      ? 'Trigger Conflicts'
      : `Trigger Conflicts — ${groups.length} group${groups.length === 1 ? '' : 's'} (${totalFlows} flows)`;
  const closeBtn = doc.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.style.cssText = 'background: none; border: 0; font-size: 22px; cursor: pointer;';
  closeBtn.addEventListener('click', () => overlay.remove());
  header.appendChild(headerLabel);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const body = doc.createElement('div');
  body.style.cssText = 'padding: 16px; overflow-y: auto; flex: 1;';

  if (groups.length === 0) {
    const empty = doc.createElement('div');
    empty.style.color = '#80868d';
    empty.textContent =
      'No record-triggered flows in this org share the same object + timing + event. 🎉';
    body.appendChild(empty);
  } else {
    const intro = doc.createElement('div');
    intro.style.cssText = 'color: #54698d; font-size: 13px; margin-bottom: 12px;';
    intro.textContent =
      'These groups of record-triggered flows fire on the same object + timing + event. The order in which they run is not guaranteed, so behaviour can vary save-to-save.';
    body.appendChild(intro);

    for (const group of groups) {
      const groupBox = doc.createElement('div');
      groupBox.style.cssText =
        'border: 1px solid #d8dde6; border-radius: 4px; padding: 10px; margin-bottom: 8px;';
      const title = doc.createElement('div');
      title.style.cssText = 'font-weight: 600; margin-bottom: 4px;';
      title.textContent = `${group.objectApiName} · ${group.triggerTiming} · ${group.triggerEvent}`;
      groupBox.appendChild(title);

      const list = doc.createElement('ul');
      list.style.cssText = 'margin: 4px 0 0; padding-left: 18px; font-size: 13px;';
      for (const flow of group.flows) {
        const li = doc.createElement('li');
        li.style.marginBottom = '2px';
        const labelSpan = doc.createElement('span');
        labelSpan.textContent = flow.label;
        const criteriaSpan = doc.createElement('span');
        criteriaSpan.style.cssText = 'color: #80868d; margin-left: 8px;';
        criteriaSpan.textContent = flow.entryCriteriaSummary ?? 'no entry criteria';
        li.appendChild(labelSpan);
        li.appendChild(criteriaSpan);
        list.appendChild(li);
      }
      groupBox.appendChild(list);
      body.appendChild(groupBox);
    }
  }

  modal.appendChild(body);

  const footer = doc.createElement('div');
  footer.style.cssText =
    'padding: 12px 16px; border-top: 1px solid #d8dde6; display: flex; justify-content: flex-end; gap: 8px;';
  const closeFooter = doc.createElement('button');
  closeFooter.textContent = 'Close';
  closeFooter.style.cssText =
    'padding: 6px 12px; border: 1px solid #d8dde6; background: #fff; border-radius: 4px; cursor: pointer;';
  closeFooter.addEventListener('click', () => overlay.remove());
  footer.appendChild(closeFooter);
  modal.appendChild(footer);

  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  return overlay;
}

export interface TriggerConflictsFeatureOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
}

export function createTriggerConflictsFeature(
  options: TriggerConflictsFeatureOptions = {},
): Feature {
  const doc = options.doc ?? document;
  const _win = options.win ?? window;
  void _win;
  const api = options.api ?? getSalesforceApi();

  return {
    id: 'trigger-conflicts',

    async onActivate() {
      const loading = doc.createElement('div');
      loading.style.cssText =
        'position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 100020; display: flex; align-items: center; justify-content: center; color: #fff; font-family: system-ui, sans-serif;';
      loading.textContent = 'Scanning flows for trigger conflicts…';
      doc.body.appendChild(loading);
      try {
        const candidates = await fetchActiveFlows(api);
        const groups = detectTriggerConflicts(candidates);
        loading.remove();
        doc.body.appendChild(buildConflictsModal(doc, groups));
      } catch (err) {
        loading.remove();
        showToast(`Trigger conflicts failed: ${err instanceof Error ? err.message : String(err)}`, {
          kind: 'error',
          doc,
        });
      }
    },
  };
}

export function _triggerConflictsTestApi() {
  return { fetchActiveFlows, buildConflictsModal };
}
