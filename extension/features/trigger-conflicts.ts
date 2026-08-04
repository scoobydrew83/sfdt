// Activation routes through the sfdt bridge's `rollback` handler:
// activate-vN → toVersion: N, deactivate → toVersion: 0. Both flip
// FlowDefinition.Metadata.activeVersionNumber non-destructively.

import { detectTriggerConflicts, type FlowConflictGroup } from '@sfdt/flow-core';
import type { SfdtResponse } from '@sfdt/flow-core/bridge-contract';
import type { Feature } from '../lib/feature-registry.js';
import { CONTEXTS } from '../lib/context-detector.js';
import { escapeSoql } from '../lib/escape.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { loadSettings } from '../lib/settings.js';
import { createBridgeClient, LONG_RUNNING_TIMEOUT_MS } from '../lib/sfdt-bridge.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { setTone, button, setLabel } from '../lib/ui-controls.js';
import { busyOverlay } from '../ui/panels.js';

interface FlowDefinitionRecord {
  Id: string;
  DeveloperName: string;
  ActiveVersionId: string | null;
  LatestVersion?: { VersionNumber: number | null } | null;
}

interface FlowVersionRecord {
  Id: string;
  MasterLabel?: string;
  Metadata?: Record<string, unknown>;
}

export interface ConflictFlowExtra {
  // FlowDefinition.LatestVersion.VersionNumber — what an Activate button
  // should set Metadata.activeVersionNumber to. Null when the org has no
  // version for the flow at all (rare; usually the flow wouldn't have
  // surfaced as a conflict candidate in that case).
  latestVersionNumber: number | null;
  // Snapshot of whether the flow is currently active. The modal flips
  // this in-place after a successful bridge round-trip so the user sees
  // the new state without re-running the scan.
  active: boolean;
}

export interface FetchedConflictCandidates {
  candidates: Array<{ flowId: string; label: string; metadata: Record<string, unknown> }>;
  extras: Record<string, ConflictFlowExtra>;
}

async function fetchActiveFlows(api: SalesforceApiClient): Promise<FetchedConflictCandidates> {
  const defs = await api.toolingQuery<FlowDefinitionRecord>(
    'SELECT Id, DeveloperName, ActiveVersionId, LatestVersion.VersionNumber ' +
      'FROM FlowDefinition WHERE ActiveVersionId != null ORDER BY DeveloperName ASC',
  );
  const candidates: FetchedConflictCandidates['candidates'] = [];
  const extras: FetchedConflictCandidates['extras'] = {};

  // Modest concurrency — discovery is mostly waiting on Tooling API round-trips.
  const queue = [...defs.records];
  const concurrency = 5;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const def = queue.shift();
        if (!def?.ActiveVersionId) continue;
        try {
          const result = await api.toolingQuery<FlowVersionRecord>(
            `SELECT Id, MasterLabel, Metadata FROM Flow WHERE Id = '${escapeSoql(def.ActiveVersionId)}'`,
          );
          const record = result.records[0];
          if (record?.Metadata) {
            candidates.push({
              flowId: def.DeveloperName,
              label: record.MasterLabel ?? def.DeveloperName,
              metadata: record.Metadata,
            });
            extras[def.DeveloperName] = {
              latestVersionNumber: def.LatestVersion?.VersionNumber ?? null,
              active: true, // We only queried active flows.
            };
          }
        } catch {
          // Per-flow read errors surface as missing rows in the modal.
        }
      }
    }),
  );
  return { candidates, extras };
}

export interface ConflictModalActions {
  // Returns a structured response — { ok: true } on success, { ok: false,
  // error } on failure. The modal uses ok to decide whether to flip the
  // row state to "active=false" / "active=true" in-place.
  onActivate?(flowApiName: string, toVersion: number): Promise<{ ok: boolean; error?: string }>;
  onDeactivate?(flowApiName: string): Promise<{ ok: boolean; error?: string }>;
}

export interface ConflictModalOptions extends ConflictModalActions {
  extras?: Record<string, ConflictFlowExtra>;
}

export function buildConflictsModal(
  doc: Document,
  groups: readonly FlowConflictGroup[],
  options: ConflictModalOptions = {},
): ViewHandle {
  const extras = options.extras ?? {};
  const onActivate = options.onActivate;
  const onDeactivate = options.onDeactivate;

  const totalFlows = groups.reduce((n, g) => n + g.flows.length, 0);
  const title =
    groups.length === 0
      ? 'Trigger Conflicts'
      : `Trigger Conflicts — ${groups.length} group${groups.length === 1 ? '' : 's'} (${totalFlows} flows)`;

  const body = doc.createElement('div');
  body.className = 'sfdt-view-main';
  if (groups.length === 0) {
    const empty = doc.createElement('div');
    setTone(empty, 'muted');
    empty.textContent =
      'No record-triggered flows in this org share the same object + timing + event.';
    body.appendChild(empty);
  } else {
    const intro = doc.createElement('div');
    intro.classList.add('sfdt-muted');
    intro.textContent =
      'These groups of record-triggered flows fire on the same object + timing + event. The order in which they run is not guaranteed, so behaviour can vary save-to-save. Use Deactivate to silence a conflicting flow without deleting it; Activate restores the latest version.';
    body.appendChild(intro);

    for (const group of groups) {
      const groupBox = doc.createElement('div');
      groupBox.classList.add('sfdt-panel', 'sfdt-below');
      const title = doc.createElement('div');
      title.classList.add('sfdt-subhead');
      title.textContent = `${group.objectApiName} · ${group.triggerTiming} · ${group.triggerEvent}`;
      groupBox.appendChild(title);

      for (const flow of group.flows) {
        groupBox.appendChild(
          buildFlowRow(doc, flow, extras[flow.flowId], { onActivate, onDeactivate }),
        );
      }
      body.appendChild(groupBox);
    }
  }

  const footer = doc.createElement('div');
  footer.style.cssText =
    'padding: 12px 16px; border-top: 1px solid var(--sfdt-color-border); display: flex; justify-content: flex-end; gap: 8px;';
  const closeFooter = button({ label: 'Close', doc });
  footer.appendChild(closeFooter);

  const view = presentView({ title, body, footer, doc, width: '720px' });
  closeFooter.addEventListener('click', () => view.close());
  return view;
}

function buildFlowRow(
  doc: Document,
  flow: FlowConflictGroup['flows'][number],
  extra: ConflictFlowExtra | undefined,
  actions: ConflictModalActions,
): HTMLDivElement {
  const row = doc.createElement('div');
  row.style.cssText =
    'display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 0; border-top: 1px solid var(--sfdt-color-bg);';

  const left = doc.createElement('div');
  left.style.cssText = 'min-width: 0; flex: 1;';
  const labelLine = doc.createElement('div');
  labelLine.style.cssText = 'font-size: 13px;';
  const labelSpan = doc.createElement('span');
  labelSpan.textContent = flow.label;
  labelSpan.classList.add('sfdt-strong');
  const stateBadge = doc.createElement('span');
  stateBadge.style.cssText =
    'margin-left: 8px; padding: 1px 6px; border-radius: 8px; font-size: 11px;';
  setBadgeState(stateBadge, extra?.active ?? true);
  labelLine.appendChild(labelSpan);
  labelLine.appendChild(stateBadge);
  const criteria = doc.createElement('div');
  criteria.classList.add('sfdt-faint');
  criteria.textContent = flow.entryCriteriaSummary ?? 'no entry criteria';
  left.appendChild(labelLine);
  left.appendChild(criteria);
  row.appendChild(left);

  const right = doc.createElement('div');
  right.classList.add('sfdt-row', 'sfdt-tight');
  const statusSpan = doc.createElement('span');
  statusSpan.style.cssText = 'font-size: 11px; color: var(--sfdt-color-text-icon); min-width: 18px;';
  right.appendChild(statusSpan);

  const activateBtn = button({ label: 'Activate', iconName: 'check', small: true, doc });
  const deactivateBtn = button({ label: 'Deactivate', iconName: 'close', small: true, doc });

  const latest = extra?.latestVersionNumber ?? null;
  // setLabel, not textContent: the latter wipes the button's glyph along with
  // its text (lib/ui-controls.ts).
  if (latest) setLabel(activateBtn, `Activate v${latest}`);
  setTone(deactivateBtn, 'bad');

  const refresh = () => {
    const active = extra?.active ?? true;
    setBadgeState(stateBadge, active);
    activateBtn.disabled = active || !actions.onActivate || latest === null;
    deactivateBtn.disabled = !active || !actions.onDeactivate;
    activateBtn.style.opacity = activateBtn.disabled ? '0.5' : '1';
    deactivateBtn.style.opacity = deactivateBtn.disabled ? '0.5' : '1';
    // '.sfdt-btn[disabled]' already sets the cursor — declaring it per-state
    // here just meant two places could disagree.
  };
  refresh();

  const setPending = (label: string) => {
    statusSpan.textContent = label;
    setTone(statusSpan, 'muted');
    activateBtn.disabled = true;
    deactivateBtn.disabled = true;
  };
  const setError = (msg: string) => {
    statusSpan.textContent = 'Inactive';
    setTone(statusSpan, 'bad');
    statusSpan.title = msg;
    refresh();
  };
  const setOk = () => {
    statusSpan.textContent = 'Active';
    setTone(statusSpan, 'ok');
    statusSpan.title = '';
    refresh();
  };

  if (actions.onActivate && latest !== null) {
    activateBtn.addEventListener('click', async () => {
      if (!actions.onActivate) return;
      setPending('…');
      const result = await actions.onActivate(flow.flowId, latest);
      if (result.ok) {
        if (extra) extra.active = true;
        setOk();
      } else {
        setError(result.error ?? 'failed');
      }
    });
  }
  if (actions.onDeactivate) {
    deactivateBtn.addEventListener('click', async () => {
      if (!actions.onDeactivate) return;
      setPending('…');
      const result = await actions.onDeactivate(flow.flowId);
      if (result.ok) {
        if (extra) extra.active = false;
        setOk();
      } else {
        setError(result.error ?? 'failed');
      }
    });
  }

  right.appendChild(activateBtn);
  right.appendChild(deactivateBtn);
  row.appendChild(right);
  return row;
}

function setBadgeState(badge: HTMLSpanElement, active: boolean): void {
  if (active) {
    badge.textContent = 'Active';
    badge.classList.add('sfdt-fill-ok');
    setTone(badge, 'ok');
  } else {
    badge.textContent = 'Inactive';
    setTone(badge, 'muted');
  }
}

async function dispatchRollback(
  flowApiName: string,
  toVersion: number,
): Promise<SfdtResponse> {
  const settings = await loadSettings();
  const bridge = createBridgeClient({
    token: settings.bridge.token,
    preferredTransport: settings.bridge.preferredTransport,
    localhostPort: settings.bridge.localhostPort,
    connectNativeImpl: chrome.runtime?.connectNative?.bind(chrome.runtime),
  });
  // Rollback runs real `sf` CLI work server-side — give it far longer than
  // the default request timeout.
  return bridge.call({ kind: 'rollback', flowApiName, toVersion }, { timeoutMs: LONG_RUNNING_TIMEOUT_MS });
}

function describeBridgeError(response: SfdtResponse): string {
  if (response.ok) return 'OK';
  const code = response.code ?? 'BRIDGE_OFFLINE';
  switch (code) {
    case 'BRIDGE_UNAUTHORIZED':
      return 'Bridge bearer token is missing or invalid — open extension settings to pair with sfdt.';
    case 'BRIDGE_FORBIDDEN':
      return 'sfdt bridge rejected this origin.';
    case 'NOT_IMPLEMENTED':
      return 'Bridge does not support this action yet.';
    case 'BRIDGE_OFFLINE':
      return 'sfdt is not running. Start `sfdt ui` or install the native messaging host.';
    case 'NOT_FOUND':
      return response.error;
    default:
      return response.error;
  }
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
    manifest: {
      id: 'trigger-conflicts',
      name: 'Trigger Conflicts',
      contexts: [CONTEXTS.SETUP_FLOWS, CONTEXTS.FLOW_TRIGGER_EXPLORER, CONTEXTS.SETUP_OTHER],
    },

    async onActivate() {
      const loading = busyOverlay('Scanning flows for trigger conflicts…', doc);
      try {
        const { candidates, extras } = await fetchActiveFlows(api);
        const groups = detectTriggerConflicts(candidates);
        loading.close();
        buildConflictsModal(doc, groups, {
          extras,
          onActivate: async (flowApiName, toVersion) => {
            const response = await dispatchRollback(flowApiName, toVersion);
            if (response.ok) {
              showToast(`Activated v${toVersion} of "${flowApiName}"`, { kind: 'success', doc });
              return { ok: true };
            }
            const msg = describeBridgeError(response);
            showToast(`Activate failed: ${msg}`, { kind: 'error', doc });
            return { ok: false, error: msg };
          },
          onDeactivate: async (flowApiName) => {
            const response = await dispatchRollback(flowApiName, 0);
            if (response.ok) {
              showToast(`Deactivated "${flowApiName}"`, { kind: 'success', doc });
              return { ok: true };
            }
            const msg = describeBridgeError(response);
            showToast(`Deactivate failed: ${msg}`, { kind: 'error', doc });
            return { ok: false, error: msg };
          },
        });
      } catch (err) {
        loading.close();
        showToast(`Trigger conflicts failed: ${err instanceof Error ? err.message : String(err)}`, {
          kind: 'error',
          doc,
        });
      }
    },
  };
}

export function _triggerConflictsTestApi() {
  return { fetchActiveFlows, buildConflictsModal, describeBridgeError };
}
