import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import type { OrgEntry } from '../lib/org-list.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';

const LAST_ORG_STORAGE_KEY = 'sfdt.workspace.lastOrg';

export async function readLastOrg(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(LAST_ORG_STORAGE_KEY, (result) => {
      const raw = result?.[LAST_ORG_STORAGE_KEY];
      resolve(typeof raw === 'string' && raw ? raw : null);
    });
  });
}

export async function persistLastOrg(host: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [LAST_ORG_STORAGE_KEY]: host }, () => resolve());
  });
}

// Ask the background service worker which orgs the user is logged in to.
export async function listOrgs(): Promise<OrgEntry[]> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'listSalesforceOrgs' }, (resp) => {
        if (chrome.runtime.lastError || !resp?.ok) {
          resolve([]);
          return;
        }
        resolve(Array.isArray(resp.orgs) ? (resp.orgs as OrgEntry[]) : []);
      });
    } catch {
      resolve([]);
    }
  });
}

export interface OrgSwitcherOptions {
  doc?: Document;
  win?: Window;
  /**
   * Performs the actual switch. The Workspace shell supplies a reloader that
   * navigates app.html to the chosen org. Defaults to a full page reload of the
   * current tab with `?org=<host>` so all per-org state (sessions, caches) is
   * rebuilt cleanly.
   */
  onSwitch?: (host: string) => void;
}

function defaultSwitch(host: string): void {
  // Reload the standalone tab targeting the new org. A full reload is the
  // simplest correct reset — it discards every feature's cached session.
  const base =
    typeof chrome !== 'undefined' && chrome.runtime?.getURL
      ? chrome.runtime.getURL('app.html')
      : globalThis.location.pathname;
  globalThis.location.href = `${base}?org=${encodeURIComponent(host)}`;
}

export function createOrgSwitcherFeature(options: OrgSwitcherOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const doSwitch = options.onSwitch ?? defaultSwitch;

  let view: ViewHandle | null = null;

  function close(): void {
    view?.close();
    view = null;
  }

  async function apply(host: string): Promise<void> {
    await persistLastOrg(host);
    close();
    doSwitch(host);
  }

  async function open(): Promise<void> {
    close();

    const list = doc.createElement('div');
    list.style.cssText =
      'padding: 8px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 4px;';
    const loading = doc.createElement('div');
    loading.style.cssText = 'padding: 12px; color: #54698d; font-size: 12px;';
    loading.textContent = 'Finding logged-in orgs…';
    list.appendChild(loading);

    view = presentView({
      title: '🏢 Switch Org',
      body: list,
      doc,
      width: '480px',
      onClose: () => {
        view = null;
      },
    });

    const orgs = await listOrgs();
    while (list.firstChild) list.removeChild(list.firstChild);
    if (orgs.length === 0) {
      const empty = doc.createElement('div');
      empty.style.cssText = 'padding: 12px; color: #80868d; font-size: 12px;';
      empty.textContent =
        'No logged-in Salesforce orgs found. Log in to an org in another tab, then retry.';
      list.appendChild(empty);
      return;
    }
    for (const org of orgs) {
      const item = doc.createElement('button');
      item.style.cssText =
        'text-align: left; padding: 10px 12px; border: 1px solid #eef1f4; background: #fff; border-radius: 4px; cursor: pointer; display: flex; flex-direction: column; gap: 2px;';
      const name = doc.createElement('span');
      name.textContent = org.displayName;
      name.style.cssText = 'font-weight: 600; font-size: 13px; color: #16325c;';
      const host = doc.createElement('span');
      host.textContent = org.host;
      host.style.cssText = 'font-size: 11px; color: #80868d; font-family: ui-monospace, monospace;';
      item.appendChild(name);
      item.appendChild(host);
      item.addEventListener('click', () => void apply(org.host));
      list.appendChild(item);
    }
  }

  return {
    manifest: {
      id: 'org-switcher',
      name: 'Switch Org',
      contexts: [CONTEXTS.WORKSPACE],
    },

    async onActivate() {
      // Workspace-only; the synthetic win reports a real Salesforce context.
      const ctx = detectContext({ location: { href: win.location.href } }, doc);
      if (ctx === CONTEXTS.NONE) {
        showToast('Open the Workspace to switch orgs.', { doc, kind: 'warning' });
        return;
      }
      await open();
    },
  };
}
