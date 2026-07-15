import { z } from 'zod';
import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import {
  getSalesforceApi,
  type HttpMethod,
  type SalesforceApiClient,
} from '../lib/salesforce-api.js';
import { SF_API_VERSION } from '../lib/api-version.js';
import { loadSettings, registerSettingsShape } from '../lib/settings.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';

const REST_EXPLORE_SETTINGS_SCHEMA = z.object({
  defaultMethod: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']).default('GET'),
  historyEnabled: z.boolean().default(true),
});

registerSettingsShape('rest-explore', REST_EXPLORE_SETTINGS_SCHEMA);

const HISTORY_STORAGE_KEY = 'restExplore.history';
const HISTORY_CAP = 20;

const METHODS_WITH_BODY: ReadonlySet<HttpMethod> = new Set(['POST', 'PATCH', 'PUT']);

interface HistoryEntry {
  method: HttpMethod;
  path: string;
  body?: string;
  ts: number;
}

interface HistoryRecord {
  entries: HistoryEntry[];
}

export async function readRestHistory(): Promise<HistoryEntry[]> {
  return new Promise((resolve) => {
    chrome.storage.local.get(HISTORY_STORAGE_KEY, (result) => {
      const raw = result?.[HISTORY_STORAGE_KEY] as HistoryRecord | undefined;
      resolve(Array.isArray(raw?.entries) ? raw.entries : []);
    });
  });
}

export async function writeRestHistory(entries: HistoryEntry[]): Promise<void> {
  const record: HistoryRecord = { entries: entries.slice(0, HISTORY_CAP) };
  return new Promise((resolve) => {
    chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: record }, () => resolve());
  });
}

export async function pushRestHistory(entry: HistoryEntry): Promise<void> {
  const existing = await readRestHistory();
  const deduped = existing.filter(
    (e) => !(e.method === entry.method && e.path === entry.path && (e.body ?? '') === (entry.body ?? '')),
  );
  await writeRestHistory([entry, ...deduped]);
}

export async function clearRestHistory(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove(HISTORY_STORAGE_KEY, () => resolve());
  });
}

export function prettyJson(value: unknown): string {
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export interface RestExploreOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
  /** Test seam: when set, skips the DELETE/PATCH/PUT confirmation toast. */
  skipDestructiveConfirm?: boolean;
}

export function createRestExploreFeature(options: RestExploreOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();
  const skipDestructiveConfirm = options.skipDestructiveConfirm ?? false;

  let view: ViewHandle | null = null;

  function close(): void {
    view?.close();
    view = null;
  }

  async function open(): Promise<void> {
    close();

    const settings = await loadSettings();
    const config = (settings.featureSettings?.['rest-explore'] ?? {
      defaultMethod: 'GET',
      historyEnabled: true,
    }) as z.infer<typeof REST_EXPLORE_SETTINGS_SCHEMA>;
    const historyEnabled = config.historyEnabled;

    const body = doc.createElement('div');
    body.style.cssText = 'padding: 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 10px;';

    const form = doc.createElement('div');
    form.style.cssText = 'display: flex; gap: 8px; align-items: center;';
    const methodSelect = doc.createElement('select');
    methodSelect.style.cssText =
      'padding: 6px 8px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 13px;';
    for (const m of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const) {
      const opt = doc.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === config.defaultMethod) opt.selected = true;
      methodSelect.appendChild(opt);
    }
    const pathInput = doc.createElement('input');
    pathInput.type = 'text';
    pathInput.value = `/services/data/${SF_API_VERSION}/`;
    pathInput.placeholder = `/services/data/${SF_API_VERSION}/sobjects/Account/describe`;
    pathInput.style.cssText =
      'flex: 1; padding: 6px 8px; border: 1px solid #d8dde6; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 12px;';
    const sendBtn = doc.createElement('button');
    sendBtn.textContent = 'Send';
    sendBtn.style.cssText =
      'padding: 6px 14px; background: #0070d2; color: #fff; border: 0; border-radius: 4px; cursor: pointer; font-size: 13px;';
    form.appendChild(methodSelect);
    form.appendChild(pathInput);
    form.appendChild(sendBtn);
    body.appendChild(form);

    const bodyTextarea = doc.createElement('textarea');
    bodyTextarea.placeholder = 'JSON body (POST / PATCH / PUT)';
    bodyTextarea.style.cssText =
      'width: 100%; min-height: 100px; font-family: ui-monospace, monospace; font-size: 12px; padding: 8px; border: 1px solid #d8dde6; border-radius: 4px; resize: vertical; display: none;';

    function syncBodyVisibility(): void {
      bodyTextarea.style.display = METHODS_WITH_BODY.has(methodSelect.value as HttpMethod) ? 'block' : 'none';
    }
    methodSelect.addEventListener('change', syncBodyVisibility);
    syncBodyVisibility();
    body.appendChild(bodyTextarea);

    const status = doc.createElement('div');
    status.style.cssText = 'color: #54698d; font-size: 12px;';
    body.appendChild(status);

    const errorPanel = doc.createElement('div');
    errorPanel.style.cssText =
      'display: none; border: 1px solid #c23934; background: #fef2f1; color: #c23934; padding: 8px 12px; border-radius: 4px; font-size: 13px; white-space: pre-wrap;';
    body.appendChild(errorPanel);

    const responsePane = doc.createElement('pre');
    responsePane.style.cssText =
      'margin: 0; padding: 10px; background: #fafaf9; border: 1px solid #d8dde6; border-radius: 4px; overflow: auto; max-height: 360px; font-family: ui-monospace, monospace; font-size: 12px; display: none; white-space: pre-wrap;';
    body.appendChild(responsePane);

    let lastResponse: unknown = null;

    const footer = doc.createElement('div');
    footer.style.cssText = 'display: flex; gap: 8px; align-items: center;';
    const copyBtn = doc.createElement('button');
    copyBtn.textContent = 'Copy response';
    copyBtn.style.cssText =
      'padding: 6px 12px; border: 1px solid #d8dde6; background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px; display: none;';
    footer.appendChild(copyBtn);

    let historyMenu: HTMLDivElement | null = null;
    if (historyEnabled) {
      const historyBtn = doc.createElement('button');
      historyBtn.textContent = '▸ History ▾';
      historyBtn.style.cssText =
        'padding: 6px 10px; border: 1px solid #d8dde6; background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px;';
      const histWrap = doc.createElement('div');
      histWrap.style.cssText = 'position: relative; margin-left: auto;';
      histWrap.appendChild(historyBtn);
      historyMenu = doc.createElement('div');
      historyMenu.style.cssText =
        'display: none; position: absolute; top: 100%; right: 0; background: #fff; border: 1px solid #d8dde6; border-radius: 4px; min-width: 420px; max-height: 280px; overflow-y: auto; z-index: 100021; box-shadow: 0 2px 8px rgba(0,0,0,0.15);';
      histWrap.appendChild(historyMenu);
      historyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!historyMenu) return;
        if (historyMenu.style.display === 'block') {
          historyMenu.style.display = 'none';
          return;
        }
        await renderHistoryMenu();
        historyMenu.style.display = 'block';
      });
      doc.addEventListener('click', (e) => {
        if (historyMenu && !histWrap.contains(e.target as Node)) {
          historyMenu.style.display = 'none';
        }
      });
      const clearBtn = doc.createElement('button');
      clearBtn.textContent = 'Clear history';
      clearBtn.style.cssText =
        'padding: 6px 10px; border: 1px solid #d8dde6; background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px;';
      clearBtn.addEventListener('click', async () => {
        await clearRestHistory();
        showToast('History cleared', { doc, kind: 'success' });
      });
      footer.appendChild(histWrap);
      footer.appendChild(clearBtn);
    }
    body.appendChild(footer);

    view = presentView({
      title: '🛠 REST API Explorer',
      body,
      doc,
      width: '860px',
      onClose: () => { view = null; },
    });

    function showError(message: string): void {
      errorPanel.textContent = message;
      errorPanel.style.display = 'block';
      responsePane.style.display = 'none';
      copyBtn.style.display = 'none';
    }

    function clearError(): void {
      errorPanel.textContent = '';
      errorPanel.style.display = 'none';
    }

    async function renderHistoryMenu(): Promise<void> {
      if (!historyMenu) return;
      while (historyMenu.firstChild) historyMenu.removeChild(historyMenu.firstChild);
      const entries = await readRestHistory();
      if (entries.length === 0) {
        const empty = doc.createElement('div');
        empty.style.cssText = 'padding: 10px; color: #80868d; font-size: 12px;';
        empty.textContent = 'No requests yet.';
        historyMenu.appendChild(empty);
        return;
      }
      for (const entry of entries) {
        const item = doc.createElement('div');
        item.style.cssText =
          'padding: 8px 10px; cursor: pointer; border-bottom: 1px solid #f3f3f3; font-family: ui-monospace, monospace; font-size: 11px;';
        const badge = doc.createElement('span');
        badge.textContent = entry.method;
        badge.style.cssText =
          'display: inline-block; min-width: 50px; padding: 1px 4px; border-radius: 3px; background: #16325c; color: #fff; font-weight: 600; margin-right: 6px; text-align: center;';
        const text = doc.createElement('span');
        text.textContent = entry.path;
        item.appendChild(badge);
        item.appendChild(text);
        item.addEventListener('click', () => {
          methodSelect.value = entry.method;
          pathInput.value = entry.path;
          if (entry.body !== undefined) bodyTextarea.value = entry.body;
          syncBodyVisibility();
          if (historyMenu) historyMenu.style.display = 'none';
        });
        historyMenu.appendChild(item);
      }
    }

    async function send(): Promise<void> {
      const method = methodSelect.value as HttpMethod;
      const path = pathInput.value.trim();
      if (!path.startsWith('/')) {
        showError('Endpoint must start with /');
        return;
      }
      if (method === 'DELETE' && !skipDestructiveConfirm) {
        showToast(`Click Send again to confirm DELETE ${path}`, { doc, kind: 'warning' });
        sendBtn.dataset.confirmedDelete = 'pending';
        const reset = setTimeout(() => {
          delete sendBtn.dataset.confirmedDelete;
        }, 4000);
        sendBtn.addEventListener(
          'click',
          () => {
            clearTimeout(reset);
            void executeAfterConfirm();
          },
          { once: true },
        );
        return;
      }
      await executeAfterConfirm();

      async function executeAfterConfirm(): Promise<void> {
        clearError();
        let parsedBody: unknown = undefined;
        if (METHODS_WITH_BODY.has(method) && bodyTextarea.value.trim()) {
          try {
            parsedBody = JSON.parse(bodyTextarea.value);
          } catch (err) {
            showError(`Body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
            return;
          }
        }
        sendBtn.disabled = true;
        status.textContent = `Sending ${method} ${path}…`;
        const t0 = Date.now();
        try {
          const result = await api.rawRequest(method, path, parsedBody);
          const elapsed = Date.now() - t0;
          lastResponse = result;
          status.textContent = `⏱ ${elapsed} ms · OK`;
          responsePane.textContent = prettyJson(result) || '(no body)';
          responsePane.style.display = 'block';
          copyBtn.style.display = 'inline-block';
          if (historyEnabled) {
            const entry: HistoryEntry = {
              method,
              path,
              ts: Date.now(),
              ...(METHODS_WITH_BODY.has(method) && bodyTextarea.value
                ? { body: bodyTextarea.value }
                : {}),
            };
            await pushRestHistory(entry);
          }
        } catch (err) {
          showError(err instanceof Error ? err.message : String(err));
          status.textContent = '';
        } finally {
          sendBtn.disabled = false;
        }
      }
    }

    sendBtn.addEventListener('click', () => {
      if (sendBtn.dataset.confirmedDelete !== 'pending') void send();
    });
    pathInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void send();
      }
    });
    bodyTextarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void send();
      }
    });
    copyBtn.addEventListener('click', async () => {
      try {
        await win.navigator.clipboard.writeText(prettyJson(lastResponse));
        showToast('Response copied', { doc, kind: 'success' });
      } catch {
        showToast('Could not copy to clipboard', { doc, kind: 'error' });
      }
    });

    pathInput.focus();
    pathInput.setSelectionRange(pathInput.value.length, pathInput.value.length);
  }

  return {
    manifest: {
      id: 'rest-explore',
      name: 'REST API Explorer',
      contexts: [
        CONTEXTS.SETUP_FLOWS,
        CONTEXTS.SETUP_OTHER,
        CONTEXTS.FLOW_BUILDER,
        CONTEXTS.FLOW_TRIGGER_EXPLORER,
      ],
      settingsSchema: REST_EXPLORE_SETTINGS_SCHEMA,
    },

    async onActivate() {
      const ctx = detectContext({ location: { href: win.location.href } }, doc);
      if (ctx === CONTEXTS.NONE) {
        showToast('Open a Salesforce page to use the REST Explorer.', { doc, kind: 'warning' });
        return;
      }
      await open();
    },
  };
}

export function _restExploreTestApi() {
  return {
    prettyJson,
    readRestHistory,
    writeRestHistory,
    pushRestHistory,
    clearRestHistory,
    HISTORY_CAP,
  };
}
