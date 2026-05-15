// One-click Deploy / Rollback from the Flow Builder canvas — Phase 6c +
// Phase 7's bridge wiring.
//
// Deploy is now wired end-to-end: the extension fetches the Flow's
// metadata via Tooling API to resolve the developer name, then dispatches
// `kind: deploy` through the sfdt bridge. The bridge handler runs `sf
// project deploy start --metadata Flow:<name>` against the configured
// target org and returns a structured result. Rollback still routes to
// NOT_IMPLEMENTED on the server side and is surfaced as a clear toast.

import type { SfdtResponse } from '@sfdt/flow-core/bridge-contract';
import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { loadSettings } from '../lib/settings.js';
import { createBridgeClient } from '../lib/sfdt-bridge.js';
import { showToast } from '../ui/toast.js';

async function dispatchBridge(
  kind: 'deploy' | 'rollback',
  payload: Record<string, unknown>,
): Promise<SfdtResponse> {
  const settings = await loadSettings();
  const bridge = createBridgeClient({
    token: settings.bridge.token,
    preferredTransport: settings.bridge.preferredTransport,
    localhostPort: settings.bridge.localhostPort,
    connectNativeImpl: chrome.runtime?.connectNative?.bind(chrome.runtime),
  });
  return bridge.call({ kind, ...payload } as never);
}

function describeBridgeError(response: SfdtResponse): string {
  if (response.ok) return 'OK';
  const code = response.code ?? 'BRIDGE_OFFLINE';
  switch (code) {
    case 'BRIDGE_UNAUTHORIZED':
      return 'Bridge bearer token is missing or invalid — open extension settings to pair with sfdt.';
    case 'BRIDGE_FORBIDDEN':
      return 'sfdt bridge rejected this origin. Make sure the extension is paired with the right machine.';
    case 'NOT_IMPLEMENTED':
      return 'That bridge action is not implemented yet (rollback still pending).';
    case 'BRIDGE_OFFLINE':
      return 'sfdt is not running. Start `sfdt ui` or install the native messaging host.';
    default:
      return response.error;
  }
}

export interface FlowDeployFeatureOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
}

/**
 * Resolve the Flow's developer name from Tooling API. Required because the
 * Flow Builder URL's `?flowId=` is a Salesforce Id (or a managed-package
 * path), but `sf project deploy start --metadata Flow:<name>` needs the
 * developer name. v2.0.2 never integrated with deploy so this round-trip
 * is new to the port.
 */
async function resolveFlowApiName(api: SalesforceApiClient, flowId: string): Promise<string> {
  const record = (await api.getFlowMetadata(flowId)) as {
    Definition?: { DeveloperName?: string };
    FullName?: string;
    Metadata?: { label?: string };
  };
  const candidates = [
    record.Definition?.DeveloperName,
    record.FullName,
    record.Metadata?.label,
  ];
  const valid = candidates.find(
    (v): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(v),
  );
  if (!valid) {
    throw new Error(`Could not resolve a deployable developer name from flowId=${flowId}`);
  }
  return valid;
}

export function createFlowDeployFeature(options: FlowDeployFeatureOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();

  return {
    manifest: {
      id: 'flow-deploy',
      name: 'Deploy or Rollback…',
      contexts: [CONTEXTS.FLOW_BUILDER],
    },

    async onActivate() {
      if (detectContext({ location: { href: win.location.href } }, doc) !== CONTEXTS.FLOW_BUILDER) {
        showToast('Open the Flow Builder canvas to deploy or rollback.', { kind: 'warning', doc });
        return;
      }
      const flowId = new URL(win.location.href).searchParams.get('flowId');
      if (!flowId) {
        showToast('Could not determine the current Flow ID from the URL.', { kind: 'error', doc });
        return;
      }

      showDeployModal(doc, async (action) => {
        if (action === 'rollback') {
          // Server-side handler still NOT_IMPLEMENTED; surface that early
          // instead of paying the metadata-fetch round-trip.
          const response = await dispatchBridge('rollback', { flowId, toVersion: 1 });
          showToast(describeBridgeError(response), { kind: 'error', doc });
          return;
        }

        showToast('Resolving Flow metadata…', { doc });
        let flowApiName: string;
        try {
          flowApiName = await resolveFlowApiName(api, flowId);
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err), { kind: 'error', doc });
          return;
        }

        showToast(`Deploying ${flowApiName}…`, { doc });
        const response = await dispatchBridge('deploy', { flowApiName, flowId });
        if (response.ok) {
          const data = response.data as { status?: string; summary?: string };
          showToast(data?.summary ?? `Deploy ${data?.status ?? 'completed'}`, {
            kind: data?.status === 'Succeeded' ? 'success' : 'warning',
            doc,
          });
        } else {
          showToast(describeBridgeError(response), { kind: 'error', doc });
        }
      });
    },
  };
}

function showDeployModal(
  doc: Document,
  onChoice: (action: 'deploy' | 'rollback') => void | Promise<void>,
): void {
  const overlay = doc.createElement('div');
  overlay.style.cssText =
    'position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 100020; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif;';
  const modal = doc.createElement('div');
  modal.style.cssText = 'background: #fff; border-radius: 4px; width: 380px; padding: 16px;';

  const title = doc.createElement('div');
  title.style.cssText = 'font-weight: 600; font-size: 15px; margin-bottom: 8px;';
  title.textContent = 'Deploy / Rollback this Flow';
  modal.appendChild(title);

  const intro = doc.createElement('p');
  intro.style.cssText = 'margin: 0 0 12px; font-size: 13px; color: #54698d;';
  intro.textContent = 'sfdt re-validates against the target org before pushing.';
  modal.appendChild(intro);

  const buttons = doc.createElement('div');
  buttons.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';
  const deployBtn = doc.createElement('button');
  deployBtn.textContent = 'Deploy';
  deployBtn.style.cssText =
    'padding: 6px 12px; background: #0070d2; color: #fff; border: 0; border-radius: 4px; cursor: pointer;';
  deployBtn.addEventListener('click', async () => {
    overlay.remove();
    await onChoice('deploy');
  });
  const rollbackBtn = doc.createElement('button');
  rollbackBtn.textContent = 'Rollback';
  rollbackBtn.style.cssText =
    'padding: 6px 12px; background: #c23934; color: #fff; border: 0; border-radius: 4px; cursor: pointer;';
  rollbackBtn.addEventListener('click', async () => {
    overlay.remove();
    await onChoice('rollback');
  });
  const cancelBtn = doc.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'padding: 6px 12px;';
  cancelBtn.addEventListener('click', () => overlay.remove());

  buttons.appendChild(cancelBtn);
  buttons.appendChild(rollbackBtn);
  buttons.appendChild(deployBtn);
  modal.appendChild(buttons);

  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  doc.body.appendChild(overlay);
}

export function _flowDeployTestApi() {
  return { describeBridgeError };
}
