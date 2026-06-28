import type { SfdtResponse } from '@sfdt/flow-core/bridge-contract';
import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { loadSettings } from '../lib/settings.js';
import { createBridgeClient, getBridgeData, LONG_RUNNING_TIMEOUT_MS } from '../lib/sfdt-bridge.js';
import { showToast } from '../ui/toast.js';
import { presentView } from '../ui/present-view.js';

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
  // Deploys and rollbacks run real `sf` CLI work server-side — give them far
  // longer than the default request timeout.
  return bridge.call({ kind, ...payload } as never, { timeoutMs: LONG_RUNNING_TIMEOUT_MS });
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
      return 'That bridge action is not available on this version of sfdt — update the CLI and retry.';
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

// The Flow Builder URL's `?flowId=` is a Salesforce Id, but the deploy
// command (`sf project deploy start --metadata Flow:<name>`) needs the
// developer name — Tooling API round-trip is required to bridge them.
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
        // Both deploy and rollback need the Flow's developer name, not the URL Id.
        showToast('Resolving Flow metadata…', { doc });
        let flowApiName: string;
        try {
          flowApiName = await resolveFlowApiName(api, flowId);
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err), { kind: 'error', doc });
          return;
        }

        if (action === 'rollback') {
          // Rollback = deactivate the active version (Tooling PATCH, toVersion=0).
          showToast(`Rolling back ${flowApiName}…`, { doc });
          const response = await dispatchBridge('rollback', { flowApiName, flowId, toVersion: 0 });
          if (response.ok) {
            const data = getBridgeData<{ status?: string; summary?: string }>(response);
            showToast(data.summary ?? `Flow "${flowApiName}" deactivated`, { kind: 'success', doc });
          } else {
            showToast(describeBridgeError(response), { kind: 'error', doc });
          }
          return;
        }

        showToast(`Deploying ${flowApiName}…`, { doc });
        const response = await dispatchBridge('deploy', { flowApiName, flowId });
        if (response.ok) {
          const data = getBridgeData<{ status: string; summary: string }>(response);
          showToast(data.summary ?? `Deploy ${data.status ?? 'completed'}`, {
            kind: data.status === 'Succeeded' ? 'success' : 'warning',
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
  const body = doc.createElement('div');
  body.style.cssText = 'padding: 16px;';

  const intro = doc.createElement('p');
  intro.style.cssText = 'margin: 0 0 12px; font-size: 13px; color: #54698d;';
  intro.textContent = 'sfdt re-validates against the target org before pushing.';
  body.appendChild(intro);

  const buttons = doc.createElement('div');
  buttons.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';
  const deployBtn = doc.createElement('button');
  deployBtn.textContent = 'Deploy';
  deployBtn.style.cssText =
    'padding: 6px 12px; background: #0070d2; color: #fff; border: 0; border-radius: 4px; cursor: pointer;';
  deployBtn.addEventListener('click', async () => {
    view.close();
    await onChoice('deploy');
  });
  const rollbackBtn = doc.createElement('button');
  rollbackBtn.textContent = 'Rollback';
  rollbackBtn.style.cssText =
    'padding: 6px 12px; background: #c23934; color: #fff; border: 0; border-radius: 4px; cursor: pointer;';
  rollbackBtn.addEventListener('click', async () => {
    view.close();
    await onChoice('rollback');
  });
  const cancelBtn = doc.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'padding: 6px 12px;';
  cancelBtn.addEventListener('click', () => view.close());

  buttons.appendChild(cancelBtn);
  buttons.appendChild(rollbackBtn);
  buttons.appendChild(deployBtn);
  body.appendChild(buttons);

  const view = presentView({ title: 'Deploy / Rollback this Flow', body, doc, width: '380px' });
}

export function _flowDeployTestApi() {
  return { describeBridgeError };
}
