import { z } from 'zod';
import { CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import {
  getSalesforceApi,
  type SalesforceApiClient,
} from '../lib/salesforce-api.js';
import { loadSettings, registerSettingsShape } from '../lib/settings.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { SF_API_VERSION } from '../lib/api-version.js';
import { button, toolbar } from '../lib/ui-controls.js';
import { openMenu } from '../ui/menu.js';
import { clearSfError, renderSfError, setSfError } from '../ui/panels.js';
import { createHistory } from '../lib/history.js';
import { copyToClipboard } from '../ui/clipboard.js';

// SOAP request bodies carry the bare numeric version (e.g. "62.0"), not "v62.0".
const SOAP_API_VERSION = SF_API_VERSION.replace(/^v/, '');

const SOAP_EXPLORE_SETTINGS_SCHEMA = z.object({
  historyEnabled: z.boolean().default(true),
});

registerSettingsShape('soap-explore', SOAP_EXPLORE_SETTINGS_SCHEMA);

const HISTORY_STORAGE_KEY = 'soapExplore.history';
const HISTORY_CAP = 20;

interface SoapHistoryEntry {
  wsdl: 'Partner' | 'Metadata' | 'Tooling' | 'Enterprise' | 'Apex';
  operation: string;
  payload: string;
  ts: number;
}

// One shared capped ring (lib/history.ts) instead of a private read/write/push/
// clear quartet. It also routes through lib/storage.ts, so recording a request
// in a tab whose extension was updated underneath it fails quietly rather than
// throwing onto the page.
const history = createHistory<SoapHistoryEntry>(HISTORY_STORAGE_KEY, {
  cap: HISTORY_CAP,
  sameAs: (a, b) => a.wsdl === b.wsdl && a.operation === b.operation && a.payload === b.payload,
});

export const readSoapHistory = (): Promise<SoapHistoryEntry[]> => history.read();
export const writeSoapHistory = (entries: SoapHistoryEntry[]): Promise<void> => history.write(entries);
export const pushSoapHistory = (entry: SoapHistoryEntry): Promise<void> => history.push(entry);
export const clearSoapHistory = (): Promise<void> => history.clear();

const TEMPLATES: Record<string, Record<string, string>> = {
  Partner: {
    getUserInfo: '{}',
    query: '{\n  "queryString": "SELECT Id, Name FROM Account LIMIT 5"\n}',
    create: '{\n  "sObjects": [\n    {\n      "$xsi:type": "Account",\n      "Name": "New Test Account"\n    }\n  ]\n}',
  },
  Metadata: {
    describeMetadata: `{\n  "apiVersion": "${SOAP_API_VERSION}"\n}`,
    listMetadata: '{\n  "queries": {\n    "type": "ApexClass"\n  }\n}',
  },
  Tooling: {
    query: '{\n  "queryString": "SELECT Id, Name FROM ApexClass LIMIT 5"\n}',
  },
  Enterprise: {
    getUserInfo: '{}',
  },
  Apex: {
    executeAnonymous: '{\n  "apexCode": "System.debug(\'Hello World\');"\n}',
  },
};

export function createSoapExploreFeature(options: {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
} = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();

  let view: ViewHandle | null = null;
  let isWorking = false;
  let docClickHandler: ((e: MouseEvent) => void) | null = null;

  function teardown(): void {
    if (docClickHandler) {
      doc.removeEventListener('click', docClickHandler);
      docClickHandler = null;
    }
    isWorking = false;
  }

  function close(): void {
    teardown();
    view?.close();
    view = null;
  }

  async function open(): Promise<void> {
    close();

    const settings = await loadSettings();
    const config = (settings.featureSettings?.['soap-explore'] ?? {
      historyEnabled: true,
    }) as z.infer<typeof SOAP_EXPLORE_SETTINGS_SCHEMA>;
    const historyEnabled = config.historyEnabled;

    const body = doc.createElement('div');
    body.className = 'sfdt-view-body';
    // '.sfdt-spinner' from the sheet — this had its own copy of the ring AND its
    // own @keyframes, like metadata-retrieve did.
    const spinner = doc.createElement('div');
    spinner.className = 'sfdt-spinner';
    spinner.setAttribute('role', 'status');
    spinner.setAttribute('aria-label', 'Working');
    spinner.style.display = 'none';

    // The config row IS this view's toolbar.
    const configRow = toolbar(doc);
    configRow.appendChild(spinner);

    const wsdlSelect = doc.createElement('select');
    wsdlSelect.className = 'sfdt-field sfdt-auto';
    (['Partner', 'Metadata', 'Tooling', 'Enterprise', 'Apex'] as const).forEach(w => {
      const opt = doc.createElement('option');
      opt.value = w;
      opt.textContent = w;
      wsdlSelect.appendChild(opt);
    });

    const opInput = doc.createElement('input');
    opInput.type = 'text';
    opInput.placeholder = 'Operation (e.g. getUserInfo)';
    opInput.value = 'getUserInfo';
    opInput.className = 'sfdt-field sfdt-toolbar-grow';

    const opSelect = doc.createElement('select');
    opSelect.className = 'sfdt-field sfdt-auto';
    opSelect.setAttribute('aria-label', 'Operation');
    configRow.appendChild(wsdlSelect);
    configRow.appendChild(opSelect);
    configRow.appendChild(opInput);

    const sendBtn = button({ label: 'Send', iconName: 'play', variant: 'primary', doc });
    configRow.appendChild(sendBtn);
    body.appendChild(configRow);
    const main = doc.createElement('div');
    main.className = 'sfdt-view-main';
    body.appendChild(main);

    const payloadTextarea = doc.createElement('textarea');
    payloadTextarea.placeholder = 'JSON arguments';
    payloadTextarea.value = '{}';
    payloadTextarea.className = 'sfdt-field sfdt-mono';
    payloadTextarea.classList.add('sfdt-taller');
    main.appendChild(payloadTextarea);

    function syncOperations(): void {
      const wsdl = wsdlSelect.value;
      opSelect.replaceChildren();
      const ops = Object.keys(TEMPLATES[wsdl] || {});
      ops.forEach(op => {
        const opt = doc.createElement('option');
        opt.value = op;
        opt.textContent = op;
        opSelect.appendChild(opt);
      });
      // Add "Custom" option
      const customOpt = doc.createElement('option');
      customOpt.value = 'custom';
      customOpt.textContent = 'Custom Operation...';
      opSelect.appendChild(customOpt);

      if (ops.length > 0) {
        opSelect.value = ops[0]!;
        opInput.value = ops[0]!;
        opInput.style.display = 'none';
        payloadTextarea.value = TEMPLATES[wsdl]?.[ops[0]!] || '{}';
      } else {
        opSelect.value = 'custom';
        opInput.value = '';
        opInput.style.display = 'block';
        payloadTextarea.value = '{}';
      }
    }

    wsdlSelect.addEventListener('change', syncOperations);
    opSelect.addEventListener('change', () => {
      const wsdl = wsdlSelect.value;
      const op = opSelect.value;
      if (op === 'custom') {
        opInput.value = '';
        opInput.style.display = 'block';
        opInput.focus();
      } else {
        opInput.value = op;
        opInput.style.display = 'none';
        payloadTextarea.value = TEMPLATES[wsdl]?.[op] || '{}';
      }
    });

    syncOperations();

    const statusPanel = doc.createElement('div');
    statusPanel.className = 'sfdt-muted';
    main.appendChild(statusPanel);

    const errorPanel = renderSfError(null, { doc });
    errorPanel.style.display = 'none';
    main.appendChild(errorPanel);

    const responsePane = doc.createElement('pre');
    responsePane.style.cssText = 'margin: 0; padding: 10px; background: var(--sfdt-color-surface-alt); border: 1px solid var(--sfdt-color-border); border-radius: 4px; overflow: auto; max-height: 280px; font-family: monospace; font-size: 12px; display: none; white-space: pre-wrap;';
    main.appendChild(responsePane);

    let lastResponse: any = null;

    const footer = doc.createElement('div');
    footer.className = 'sfdt-toolbar sfdt-toolbar-foot';
    const copyBtn = button({ label: 'Copy response', iconName: 'clipboard', small: true, doc });
    copyBtn.style.display = 'none';
    footer.appendChild(copyBtn);

    if (historyEnabled) {
      // ui/menu.ts owns the dropdown now. The hand-rolled version added a
      // document click listener per open and only removed it via a teardown that
      // had to remember to — attachDismiss() removes both listeners on every
      // exit path, which is the bug it was written for.
      const historyBtn = button({ label: 'History', iconName: 'history', small: true, doc });
      historyBtn.setAttribute('aria-haspopup', 'menu');
      historyBtn.addEventListener('click', () => {
        void (async () => {
          const entries = await readSoapHistory();
          openMenu({
            anchor: historyBtn,
            label: 'SOAP request history',
            doc,
            win,
            items: entries.length
              ? entries.map((entry) => ({
                  label: `${entry.wsdl}  ${entry.operation}`,
                  iconName: 'api',
                  onSelect: () => {
                    wsdlSelect.value = entry.wsdl;
                    syncOperations();
                    opSelect.value = 'custom';
                    opInput.value = entry.operation;
                    opInput.style.display = 'block';
                    payloadTextarea.value = entry.payload;
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
            await clearSoapHistory();
            showToast('History cleared', { doc, kind: 'success' });
          })();
        },
      });
      footer.appendChild(historyBtn);
      footer.appendChild(clearBtn);
    }
    main.appendChild(footer);

    view = presentView({
      title: 'SOAP API Explorer',
      iconName: 'soap-explore',
      body,
      doc,
      width: '860px',
      onClose: () => {
        teardown();
        view = null;
      },
    });

    // `unknown`, not `string` — see the note on the SOQL runner's showError.
    function showError(message: unknown): void {
      setSfError(errorPanel, message, { doc });
      errorPanel.style.display = 'block';
      responsePane.style.display = 'none';
      copyBtn.style.display = 'none';
    }

    function clearError(): void {
      clearSfError(errorPanel);
      errorPanel.style.display = 'none';
    }

    async function executeRequest(): Promise<void> {
      if (isWorking) return;
      const wsdl = wsdlSelect.value as any;
      const operation = opInput.value.trim();
      if (!operation) {
        showError('Operation name is required');
        return;
      }
      clearError();

      let parsedPayload: any = null;
      try {
        parsedPayload = JSON.parse(payloadTextarea.value);
      } catch (err: any) {
        showError(`Payload is not valid JSON: ${err.message}`);
        return;
      }

      isWorking = true;
      spinner.style.display = 'block';
      sendBtn.disabled = true;
      statusPanel.textContent = `Sending SOAP ${wsdl}.${operation} request...`;
      const t0 = Date.now();

      try {
        // `mutating` is deliberately left undeclared here: the operation is
        // whatever the user typed, so this call site genuinely cannot know
        // whether it writes. It therefore takes apiSoap's safe default
        // (mutating), and a timeout over-warns rather than under-warns.
        const res = await api.apiSoap(wsdl, operation, parsedPayload);
        const elapsed = Date.now() - t0;
        statusPanel.textContent = `⏱ ${elapsed} ms · OK`;
        lastResponse = res;
        responsePane.textContent = JSON.stringify(res, null, 2);
        responsePane.style.display = 'block';
        copyBtn.style.display = 'inline-block';

        if (historyEnabled) {
          await pushSoapHistory({
            wsdl,
            operation,
            payload: payloadTextarea.value,
            ts: Date.now(),
          });
        }
      } catch (err: any) {
        showError(err);
        statusPanel.textContent = '';
      } finally {
        isWorking = false;
        spinner.style.display = 'none';
        sendBtn.disabled = false;
      }
    }

    sendBtn.addEventListener('click', () => {
      void executeRequest();
    });

    copyBtn.addEventListener('click', async () => {
      try {
        await copyToClipboard(JSON.stringify(lastResponse, null, 2), { doc, win, label: 'response' });
        showToast('Response copied', { doc, kind: 'success' });
      } catch {
        showToast('Could not copy response', { doc, kind: 'error' });
      }
    });
  }

  return {
    manifest: {
      id: 'soap-explore',
      name: 'SOAP API Explorer',
      contexts: [
        CONTEXTS.SETUP_FLOWS,
        CONTEXTS.SETUP_OTHER,
        CONTEXTS.FLOW_BUILDER,
        CONTEXTS.FLOW_TRIGGER_EXPLORER,
        CONTEXTS.RECORD_PAGE,
      ],
      settingsSchema: SOAP_EXPLORE_SETTINGS_SCHEMA,
    },
    async onActivate() {
      await open();
    },
  };
}
