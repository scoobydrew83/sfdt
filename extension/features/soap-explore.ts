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

interface SoapHistoryRecord {
  entries: SoapHistoryEntry[];
}

export async function readSoapHistory(): Promise<SoapHistoryEntry[]> {
  return new Promise((resolve) => {
    chrome.storage.local.get(HISTORY_STORAGE_KEY, (result) => {
      const raw = result?.[HISTORY_STORAGE_KEY] as SoapHistoryRecord | undefined;
      resolve(Array.isArray(raw?.entries) ? raw.entries : []);
    });
  });
}

export async function writeSoapHistory(entries: SoapHistoryEntry[]): Promise<void> {
  const record: SoapHistoryRecord = { entries: entries.slice(0, HISTORY_CAP) };
  return new Promise((resolve) => {
    chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: record }, () => resolve());
  });
}

export async function pushSoapHistory(entry: SoapHistoryEntry): Promise<void> {
  const existing = await readSoapHistory();
  const deduped = existing.filter(
    (e) => !(e.wsdl === entry.wsdl && e.operation === entry.operation && e.payload === entry.payload),
  );
  await writeSoapHistory([entry, ...deduped]);
}

export async function clearSoapHistory(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove(HISTORY_STORAGE_KEY, () => resolve());
  });
}

const TEMPLATES: Record<string, Record<string, string>> = {
  Partner: {
    getUserInfo: '{}',
    query: '{\n  "queryString": "SELECT Id, Name FROM Account LIMIT 5"\n}',
    create: '{\n  "sObjects": [\n    {\n      "$xsi:type": "Account",\n      "Name": "New Test Account"\n    }\n  ]\n}',
  },
  Metadata: {
    describeMetadata: '{\n  "apiVersion": "62.0"\n}',
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
    body.style.cssText = 'padding: 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 12px;';

    // Working spinner lives at the top of the body (presentView's header is title + × only).
    const spinner = doc.createElement('div');
    spinner.style.cssText = 'border: 2px solid #f3f3f3; border-top: 2px solid #0070d2; border-radius: 50%; width: 14px; height: 14px; animation: spin 1s linear infinite; display: none;';

    const configRow = doc.createElement('div');
    configRow.style.cssText = 'display: flex; gap: 8px; align-items: center;';
    configRow.appendChild(spinner);

    const wsdlSelect = doc.createElement('select');
    wsdlSelect.style.cssText = 'padding: 6px 8px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 13px; outline: none;';
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
    opInput.style.cssText = 'flex: 1; padding: 6px 8px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 13px; outline: none;';

    const opSelect = doc.createElement('select');
    opSelect.style.cssText = 'padding: 6px 8px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 13px; outline: none;';
    configRow.appendChild(wsdlSelect);
    configRow.appendChild(opSelect);
    configRow.appendChild(opInput);

    const sendBtn = doc.createElement('button');
    sendBtn.textContent = 'Send';
    sendBtn.style.cssText = 'padding: 6px 14px; background: #0070d2; color: #fff; border: 0; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 600;';
    configRow.appendChild(sendBtn);
    body.appendChild(configRow);

    const payloadTextarea = doc.createElement('textarea');
    payloadTextarea.placeholder = 'JSON arguments';
    payloadTextarea.value = '{}';
    payloadTextarea.style.cssText = 'width: 100%; min-height: 120px; font-family: monospace; font-size: 12px; padding: 8px; border: 1px solid #d8dde6; border-radius: 4px; resize: vertical; outline: none;';
    body.appendChild(payloadTextarea);

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
    statusPanel.style.cssText = 'color: #54698d; font-size: 12px;';
    body.appendChild(statusPanel);

    const errorPanel = doc.createElement('div');
    errorPanel.style.cssText = 'display: none; border: 1px solid #c23934; background: #fef2f1; color: #c23934; padding: 8px 12px; border-radius: 4px; font-size: 13px; white-space: pre-wrap;';
    body.appendChild(errorPanel);

    const responsePane = doc.createElement('pre');
    responsePane.style.cssText = 'margin: 0; padding: 10px; background: #fafaf9; border: 1px solid #d8dde6; border-radius: 4px; overflow: auto; max-height: 280px; font-family: monospace; font-size: 12px; display: none; white-space: pre-wrap;';
    body.appendChild(responsePane);

    let lastResponse: any = null;

    const footer = doc.createElement('div');
    footer.style.cssText = 'display: flex; gap: 8px; align-items: center;';
    const copyBtn = doc.createElement('button');
    copyBtn.textContent = 'Copy response';
    copyBtn.style.cssText = 'padding: 6px 12px; border: 1px solid #d8dde6; background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px; display: none;';
    footer.appendChild(copyBtn);

    let historyMenu: HTMLDivElement | null = null;
    if (historyEnabled) {
      const historyBtn = doc.createElement('button');
      historyBtn.textContent = '▸ History ▾';
      historyBtn.style.cssText = 'padding: 6px 10px; border: 1px solid #d8dde6; background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px;';
      const histWrap = doc.createElement('div');
      histWrap.style.cssText = 'position: relative; margin-left: auto;';
      histWrap.appendChild(historyBtn);
      historyMenu = doc.createElement('div');
      historyMenu.style.cssText = 'display: none; position: absolute; top: 100%; right: 0; background: #fff; border: 1px solid #d8dde6; border-radius: 4px; min-width: 420px; max-height: 280px; overflow-y: auto; z-index: 100021; box-shadow: 0 2px 8px rgba(0,0,0,0.15);';
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
      docClickHandler = (e) => {
        if (historyMenu && !histWrap.contains(e.target as Node)) {
          historyMenu.style.display = 'none';
        }
      };
      doc.addEventListener('click', docClickHandler);
      const clearBtn = doc.createElement('button');
      clearBtn.textContent = 'Clear history';
      clearBtn.style.cssText = 'padding: 6px 10px; border: 1px solid #d8dde6; background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px;';
      clearBtn.addEventListener('click', async () => {
        await clearSoapHistory();
        showToast('History cleared', { doc, kind: 'success' });
      });
      footer.appendChild(histWrap);
      footer.appendChild(clearBtn);
    }
    body.appendChild(footer);

    view = presentView({
      title: '💬 SOAP API Explorer',
      body,
      doc,
      width: '860px',
      onClose: () => {
        teardown();
        view = null;
      },
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
      historyMenu.replaceChildren();
      const entries = await readSoapHistory();
      if (entries.length === 0) {
        const empty = doc.createElement('div');
        empty.style.cssText = 'padding: 10px; color: #80868d; font-size: 12px;';
        empty.textContent = 'No requests yet.';
        historyMenu.appendChild(empty);
        return;
      }
      entries.forEach(entry => {
        const item = doc.createElement('div');
        item.style.cssText = 'padding: 8px 10px; cursor: pointer; border-bottom: 1px solid #f3f3f3; font-family: monospace; font-size: 11px;';
        const badge = doc.createElement('span');
        badge.textContent = entry.wsdl;
        badge.style.cssText = 'display: inline-block; min-width: 60px; padding: 1px 4px; border-radius: 3px; background: #16325c; color: #fff; font-weight: 600; margin-right: 6px; text-align: center;';
        const text = doc.createElement('span');
        text.textContent = entry.operation;
        item.appendChild(badge);
        item.appendChild(text);
        item.addEventListener('click', () => {
          wsdlSelect.value = entry.wsdl;
          syncOperations();
          opSelect.value = 'custom';
          opInput.value = entry.operation;
          opInput.style.display = 'block';
          payloadTextarea.value = entry.payload;
          if (historyMenu) historyMenu.style.display = 'none';
        });
        historyMenu.appendChild(item);
      });
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
        showError(err.message || String(err));
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
        await win.navigator.clipboard.writeText(JSON.stringify(lastResponse, null, 2));
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
