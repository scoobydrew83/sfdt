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
import { button, toolbar } from '../lib/ui-controls.js';
import { openMenu } from '../ui/menu.js';
import { clearSfError, renderSfError, setSfError } from '../ui/panels.js';
import { createHistory } from '../lib/history.js';
import { copyToClipboard } from '../ui/clipboard.js';

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

// One shared capped ring (lib/history.ts) instead of a private read/write/push/
// clear quartet. It also routes through lib/storage.ts, so recording a request
// in a tab whose extension was updated underneath it fails quietly rather than
// throwing onto the page.
const history = createHistory<HistoryEntry>(HISTORY_STORAGE_KEY, {
  cap: HISTORY_CAP,
  sameAs: (a, b) => a.method === b.method && a.path === b.path && (a.body ?? '') === (b.body ?? ''),
});

export const readRestHistory = (): Promise<HistoryEntry[]> => history.read();
export const writeRestHistory = (entries: HistoryEntry[]): Promise<void> => history.write(entries);
export const pushRestHistory = (entry: HistoryEntry): Promise<void> => history.push(entry);
export const clearRestHistory = (): Promise<void> => history.clear();

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
    body.className = 'sfdt-view-body';

    const form = toolbar(doc);
    const methodSelect = doc.createElement('select');
    methodSelect.className = 'sfdt-field sfdt-auto';
    methodSelect.setAttribute('aria-label', 'HTTP method');
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
    pathInput.className = 'sfdt-field sfdt-mono sfdt-toolbar-grow';
    const sendBtn = button({ label: 'Send', iconName: 'play', variant: 'primary', doc });

    form.appendChild(methodSelect);
    form.appendChild(pathInput);
    form.appendChild(sendBtn);
    body.appendChild(form);

    const main = doc.createElement('div');
    main.className = 'sfdt-view-main';
    body.appendChild(main);

    const bodyTextarea = doc.createElement('textarea');
    bodyTextarea.placeholder = 'JSON body (POST / PATCH / PUT)';
    bodyTextarea.className = 'sfdt-field sfdt-mono';
    bodyTextarea.classList.add('sfdt-tall');
    bodyTextarea.style.display = 'none';

    function syncBodyVisibility(): void {
      bodyTextarea.style.display = METHODS_WITH_BODY.has(methodSelect.value as HttpMethod) ? 'block' : 'none';
    }
    methodSelect.addEventListener('change', syncBodyVisibility);
    syncBodyVisibility();
    main.appendChild(bodyTextarea);

    const status = doc.createElement('div');
    status.className = 'sfdt-muted';
    main.appendChild(status);

    const errorPanel = renderSfError(null, { doc });
    errorPanel.style.display = 'none';
    main.appendChild(errorPanel);

    const responsePane = doc.createElement('pre');
    responsePane.className = 'sfdt-console';
    responsePane.style.display = 'none';
    main.appendChild(responsePane);

    let lastResponse: unknown = null;

    const footer = doc.createElement('div');
    footer.className = 'sfdt-toolbar sfdt-toolbar-foot';
    const copyBtn = button({ label: 'Copy response', iconName: 'clipboard', small: true, doc });
    copyBtn.style.display = 'none';
    footer.appendChild(copyBtn);

    if (historyEnabled) {
      // The dropdown is ui/menu.ts now. The hand-rolled one it replaces added a
      // document click listener on every open and never removed it — the exact
      // leak attachDismiss() was written to stop — and it had no Esc, no roles
      // and no focus return.
      const historyBtn = button({
        label: 'History',
        iconName: 'history',
        small: true,
        doc,
      });
      historyBtn.setAttribute('aria-haspopup', 'menu');
      historyBtn.addEventListener('click', () => {
        void (async () => {
          const entries = await readRestHistory();
          openMenu({
            anchor: historyBtn,
            label: 'REST request history',
            doc,
            win,
            items: entries.length
              ? entries.map((entry) => ({
                  label: `${entry.method}  ${entry.path}`,
                  iconName: 'api',
                  onSelect: () => {
                    methodSelect.value = entry.method;
                    pathInput.value = entry.path;
                    if (entry.body !== undefined) bodyTextarea.value = entry.body;
                    syncBodyVisibility();
                  },
                }))
              : [{ label: 'No requests yet.', iconName: 'history', onSelect: () => {} }],
          });
        })();
      });
      const clearBtn = button({
        label: 'Clear history',
        iconName: 'trash',
        variant: 'danger',
        small: true,
        doc,
        onClick: () => {
          void (async () => {
            await clearRestHistory();
            showToast('History cleared', { doc, kind: 'success' });
          })();
        },
      });
      footer.appendChild(historyBtn);
      footer.appendChild(clearBtn);
    }
    body.appendChild(footer);

    view = presentView({
      title: 'REST API Explorer',
      iconName: 'rest-explore',
      body,
      doc,
      width: '860px',
      onClose: () => { view = null; },
    });

    // `unknown`, not `string` — see the note on the SOQL runner's showError.
    // `guidance` is OUR line, rendered as its own node below whatever the error
    // itself said, so a caller never has to compose the two into one string.
    function showError(message: unknown, guidance?: string): void {
      setSfError(errorPanel, message, { doc, guidance });
      errorPanel.style.display = 'block';
      responsePane.style.display = 'none';
      copyBtn.style.display = 'none';
    }

    function clearError(): void {
      clearSfError(errorPanel);
      errorPanel.style.display = 'none';
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
            showError(err, 'The request body must be valid JSON.');
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
          showError(err);
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
      await copyToClipboard(prettyJson(lastResponse), { doc, win, label: 'response' });
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
