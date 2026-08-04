import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import type { OrgEntry } from '../lib/org-list.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { storageGet, storageSet } from '../lib/storage.js';

const LAST_ORG_STORAGE_KEY = 'sfdt.workspace.lastOrg';

export async function readLastOrg(): Promise<string | null> {
  const raw = await storageGet<string>(LAST_ORG_STORAGE_KEY);
  return typeof raw === 'string' && raw ? raw : null;
}

export async function persistLastOrg(host: string): Promise<void> {
  await storageSet(LAST_ORG_STORAGE_KEY, host);
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
    list.classList.add('sfdt-view-main');
    const loading = doc.createElement('div');
    loading.classList.add('sfdt-prose', 'sfdt-muted');
    loading.textContent = 'Finding logged-in orgs…';
    list.appendChild(loading);

    view = presentView({
      title: 'Switch Org',
      iconName: 'building',
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
      empty.classList.add('sfdt-prose', 'sfdt-muted');
      empty.textContent =
        'No logged-in Salesforce orgs found. Log in to an org in another tab, then retry.';
      list.appendChild(empty);
      return;
    }
    for (const org of orgs) {
      // A list row, not chrome: '.sfdt-nav-item' is the shared full-width,
      // left-aligned, hoverable row — the same one the popup and sidebar use.
      const item = doc.createElement('button');
      item.type = 'button';
      item.className = 'sfdt-nav-item';
      item.style.cssText = 'flex-direction: column; align-items: flex-start; gap: 2px;';
      const name = doc.createElement('span');
      name.textContent = org.displayName;
      name.classList.add('sfdt-subhead');
      const host = doc.createElement('span');
      host.textContent = org.host;
      host.style.cssText = 'font-size: 11px; color: var(--sfdt-color-text-icon); font-family: ui-monospace, monospace;';
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
