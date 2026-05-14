// One-click Deploy / Rollback from the Flow Builder canvas — Phase 6c.
//
// Three actions, all dispatched through the sfdt bridge:
//   - Deploy   — push the currently-open Flow to the configured org
//   - Rollback — revert the active version to a chosen prior version
//   - Status   — show last deploy/rollback result for this Flow
//
// The bridge handlers for `deploy` and `rollback` are still stubbed
// server-side (they will land in Phase 7's distribution work alongside the
// scripted native host installer). For Phase 6 this feature is shipped end-
// to-end on the client: the button mounts, the bridge call goes through,
// and the response — currently NOT_IMPLEMENTED — surfaces as a clear
// "available once sfdt-host is installed" toast rather than a crash.

import type { SfdtResponse } from '@sfdt/flow-core/bridge-contract';
import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
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
      return 'Deploy/rollback ships with Phase 7. The extension is wired up; sfdt-side handler still has to land.';
    case 'BRIDGE_OFFLINE':
      return 'sfdt is not running. Start `sfdt ui` or install the native messaging host.';
    default:
      return response.error;
  }
}

export interface FlowDeployFeatureOptions {
  doc?: Document;
  win?: Window;
}

export function createFlowDeployFeature(options: FlowDeployFeatureOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;

  return {
    id: 'flow-deploy',

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

      // Phase 6 ships the modal that lets the user pick deploy vs rollback.
      // The actions hand off to the bridge — the server side (`deploy` and
      // `rollback` kinds) lands in Phase 7.
      showDeployModal(doc, async (action) => {
        showToast(`${action === 'deploy' ? 'Deploying' : 'Rolling back'}…`, { doc });
        const response = await dispatchBridge(action, { flowId });
        if (response.ok) {
          showToast(`${action === 'deploy' ? 'Deploy' : 'Rollback'} complete.`, {
            kind: 'success',
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
