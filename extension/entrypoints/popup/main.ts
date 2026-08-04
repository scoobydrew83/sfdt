// Browser-action popup entrypoint. Thin glue: it wires the real chrome.* APIs
// into the testable state/render logic in lib/popup.ts, then closes the popup
// after a navigation action. All session/bridge status comes from the service
// worker (via chrome.runtime messages) — the popup never reads the sid cookie
// itself, so the credential stays in the worker.

import { SFDT_TOKENS_CSS } from '../../lib/tokens.js';
import { SFDT_COMPONENT_CSS } from '../../lib/ui-styles.js';
import { watchTheme, OWN_PAGE_COLOR_SCHEME_CSS } from '../../lib/theme.js';
import { loadPopupState, renderPopup, type PopupState } from '../../lib/popup.js';
import { salesforceHostFromUrl } from '../../lib/sf-tab.js';
import { loadSettings } from '../../lib/settings.js';

// Popup-specific LAYOUT only. The card/button/nav-item/dot primitives come from
// lib/ui-styles.ts (SFDT_COMPONENT_CSS), which this entrypoint injects — the
// stack of bespoke `.sfdt-popup-btn` rules that used to live here is exactly the
// duplication that sheet exists to end.
const STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    width: 320px;
    font: var(--sfdt-type-body-md);
    background: var(--sfdt-color-surface);
    /* text-strong, not brand-deep: brand-deep is a navy FILL token, so using it
       as the popup's inherited foreground put navy-on-near-black in dark mode
       (the title inherits it). Light values are identical, so light is unchanged. */
    color: var(--sfdt-color-text-strong);
  }
  #sfdt-popup-root { display: flex; flex-direction: column; }

  /* The header row is .sfdt-panel-head from lib/ui-styles.ts — shared with the
     ⚡ side menu. Nothing popup-specific to add. */

  /* Status strip: the popup's only answer to "why isn't the tool working". */
  .sfdt-popup-body {
    padding: var(--sfdt-space-3) var(--sfdt-space-4);
    background: var(--sfdt-color-surface-shade-2);
    border-bottom: 1px solid var(--sfdt-color-border);
  }
  .sfdt-popup-org {
    font: var(--sfdt-type-code-sm);
    word-break: break-all;
    margin-bottom: var(--sfdt-space-2);
    color: var(--sfdt-color-text);
  }
  .sfdt-popup-org strong { font: var(--sfdt-type-body-sm); font-weight: 600; }
  .sfdt-popup-status { display: flex; align-items: center; gap: var(--sfdt-space-2); padding: 3px 0; }
  .sfdt-popup-status-text { color: var(--sfdt-color-text-weak); font: var(--sfdt-type-body-sm); }
  /* Sized here rather than reusing .sfdt-dot: the popup's dots sit on a tinted
     strip and carry an inset ring so a pale status still reads against it. */
  .sfdt-popup-dot {
    width: 9px; height: 9px; border-radius: var(--sfdt-radius-pill);
    flex: 0 0 auto;
    box-shadow: 0 0 0 1px rgba(0,0,0,0.08) inset;
  }
  /* The fill comes from the shared '.sfdt-ok' / '.sfdt-idle' threshold classes
     the dot also carries, but those are scoped to '.sfdt-dot' in the component
     sheet — so the popup's own variant restates the mapping here rather than
     going back to an inline background. */
  .sfdt-popup-dot.sfdt-ok { background: var(--sfdt-color-success); }
  .sfdt-popup-dot.sfdt-warn { background: var(--sfdt-color-warning); }
  .sfdt-popup-dot.sfdt-bad { background: var(--sfdt-color-error); }
  .sfdt-popup-dot.sfdt-idle { background: var(--sfdt-color-text-icon); }
  .sfdt-popup-empty { color: var(--sfdt-color-text-weak); font: var(--sfdt-type-body-sm); line-height: 1.45; margin: 0; }

  .sfdt-popup-actions { padding: var(--sfdt-space-2) 0; }
  /* .sfdt-nav-item supplies the row geometry, hover and focus ring; these only
     adjust the horizontal padding to the popup's narrower gutter. */
  .sfdt-popup-btn { padding-left: var(--sfdt-space-4); padding-right: var(--sfdt-space-4); }
  .sfdt-popup-btn.primary { color: var(--sfdt-color-brand-text); font-weight: 600; }
  .sfdt-popup-btn.primary .sfdt-glyph { color: var(--sfdt-color-brand-text); }

  .sfdt-popup-foot {
    display: flex; align-items: center;
    border-top: 1px solid var(--sfdt-color-border);
    background: var(--sfdt-color-surface-alt);
  }
  .sfdt-popup-foot .sfdt-popup-settings { width: auto; flex: 1; }
  .sfdt-popup-version {
    padding-right: var(--sfdt-space-4);
    font: var(--sfdt-type-code-sm);
    color: var(--sfdt-color-text-icon);
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
  // Order matters: tokens define the custom properties the component sheet
  // consumes, and STYLES layers this surface's layout on top of both.
  styleTag.textContent = `${SFDT_TOKENS_CSS}\n${OWN_PAGE_COLOR_SCHEME_CSS}\n${SFDT_COMPONENT_CSS}\n${STYLES}`;
  document.head.appendChild(styleTag);
  // Without this the popup only ever honoured the OS preference: the token
  // sheet's `prefers-color-scheme` block is a pre-JS fallback, and nothing was
  // resolving `settings.theme` into the `data-sfdt-theme` attribute. So a user
  // who had explicitly chosen Dark while their OS was Light got a light popup —
  // the one surface that ignored their setting. Every other own-page surface
  // (Workspace, side panel, options) already did this.
  watchTheme(document);

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
