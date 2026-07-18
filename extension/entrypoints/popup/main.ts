// Browser-action popup entrypoint. Thin glue: it wires the real chrome.* APIs
// into the testable state/render logic in lib/popup.ts, then closes the popup
// after a navigation action. All session/bridge status comes from the service
// worker (via chrome.runtime messages) — the popup never reads the sid cookie
// itself, so the credential stays in the worker.

import { SFDT_TOKENS_CSS } from '../../lib/tokens.js';
import { loadPopupState, renderPopup, type PopupState } from '../../lib/popup.js';
import { salesforceHostFromUrl } from '../../lib/sf-tab.js';
import { loadSettings } from '../../lib/settings.js';

const STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    width: 300px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: var(--sfdt-color-surface);
    color: var(--sfdt-color-brand-deep);
  }
  #sfdt-popup-root { padding: 14px 16px; }
  .sfdt-popup-title { font-size: 15px; margin: 0 0 10px; display: flex; align-items: center; gap: 6px; }
  .sfdt-popup-body { font-size: 13px; margin-bottom: 12px; }
  .sfdt-popup-org {
    font-family: ui-monospace, monospace;
    font-size: 12px;
    word-break: break-all;
    margin-bottom: 8px;
    color: var(--sfdt-color-text);
  }
  .sfdt-popup-org strong { font-family: -apple-system, system-ui, sans-serif; }
  .sfdt-popup-status { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
  .sfdt-popup-status-text { color: var(--sfdt-color-text-weak); }
  .sfdt-popup-dot {
    width: 9px; height: 9px; border-radius: 50%;
    flex: 0 0 auto;
    box-shadow: 0 0 0 1px rgba(0,0,0,0.08) inset;
  }
  .sfdt-popup-empty { color: var(--sfdt-color-text-weak); font-size: 13px; line-height: 1.45; margin: 0; }
  .sfdt-popup-actions { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
  .sfdt-popup-btn {
    width: 100%;
    padding: 8px 12px;
    border-radius: 4px;
    border: 1px solid var(--sfdt-color-border);
    background: var(--sfdt-color-surface);
    color: var(--sfdt-color-brand-text);
    cursor: pointer;
    font-size: 13px;
    font-family: inherit;
    text-align: center;
  }
  .sfdt-popup-btn:hover { background: var(--sfdt-color-bg); }
  .sfdt-popup-btn.primary {
    background: var(--sfdt-color-brand);
    color: var(--sfdt-color-on-accent);
    border-color: var(--sfdt-color-brand);
  }
  .sfdt-popup-btn.primary:hover { background: var(--sfdt-color-brand-active); }
  .sfdt-popup-btn:focus-visible {
    outline: 2px solid var(--sfdt-color-info);
    outline-offset: 2px;
  }
  .sfdt-popup-version {
    font-size: 11px;
    color: var(--sfdt-color-text-icon);
    text-align: right;
    font-family: ui-monospace, monospace;
  }
`;

// Promise wrapper around chrome.runtime.sendMessage. Resolves to the response
// (or null on a dropped channel), never throws into the popup.
function sendMessage<T>(message: unknown): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (resp: T) => {
        void chrome.runtime.lastError; // swallow "no receiver" etc.
        resolve(resp ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function getActiveTab(): Promise<{ url?: string; id?: number }> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return { url: tabs[0]?.url, id: tabs[0]?.id };
  } catch {
    return {};
  }
}

async function listLoggedInHosts(): Promise<string[]> {
  const resp = await sendMessage<{ ok: boolean; orgs?: Array<{ host: string }> }>({
    action: 'listSalesforceOrgs',
  });
  if (!resp?.ok || !Array.isArray(resp.orgs)) return [];
  return resp.orgs.map((o) => o.host);
}

async function pingBridge(): Promise<boolean> {
  const resp = await sendMessage<{ ok: boolean }>({ action: 'bridgePing' });
  return !!resp?.ok;
}

function bindHandlers(activeTabUrl: string | undefined, activeTabId: number | undefined) {
  const org = salesforceHostFromUrl(activeTabUrl) ?? '';
  return {
    onOpenWorkspace: () => {
      void sendMessage({ action: 'openApp', org }).then(() => window.close());
    },
    onOpenPanel: () => {
      // chrome.sidePanel.open() requires a live user gesture, so it must run
      // synchronously in this click handler (no awaits before it) with a tab id
      // captured earlier. Chrome-only — on Firefox the sidebar opens from the
      // native sidebar button, so there's simply nothing to do here.
      const panel = chrome.sidePanel;
      if (panel?.open && typeof activeTabId === 'number') {
        panel.open({ tabId: activeTabId }).then(
          () => window.close(),
          () => window.close(),
        );
      } else {
        window.close();
      }
    },
    onOpenPalette: () => {
      // Opening the ⚡ menu lives on the tab's content script; the background
      // command router handles the same message, so reuse it via a command.
      // Simpler here: message the active tab directly through the worker.
      void sendMessage({ action: 'openPaletteOnActiveTab' }).then(() => window.close());
    },
    onOpenOptions: () => {
      void sendMessage({ action: 'openSettings' }).then(() => window.close());
    },
  };
}

async function main(): Promise<void> {
  const styleTag = document.createElement('style');
  styleTag.textContent = `${SFDT_TOKENS_CSS}\n${STYLES}`;
  document.head.appendChild(styleTag);

  const root = document.getElementById('sfdt-popup-root');
  if (!root) return;

  const version = chrome.runtime.getManifest().version;
  const { url: activeTabUrl, id: activeTabId } = await getActiveTab();
  // Read the default-surface preference up front so the very first frame already
  // orders the action buttons correctly (a fast chrome.storage.local read).
  const defaultSurface = (await loadSettings()).defaultSurface;

  // Paint a first frame immediately (before the async status lookups resolve)
  // so the popup never flashes empty.
  const initial: PopupState = {
    isSalesforceTab: !!salesforceHostFromUrl(activeTabUrl),
    hasSidePanel: !!chrome.sidePanel,
    orgHost: salesforceHostFromUrl(activeTabUrl),
    session: null,
    bridge: null,
    defaultSurface,
    version,
  };
  const handlers = bindHandlers(activeTabUrl, activeTabId);
  renderPopup(root, initial, handlers);

  const state = await loadPopupState({
    activeTabUrl,
    hasSidePanel: !!chrome.sidePanel,
    defaultSurface,
    version,
    listLoggedInHosts,
    pingBridge,
  });
  renderPopup(root, state, handlers);
}

void main();
