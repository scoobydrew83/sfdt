import { z } from 'zod';
import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import {
  getSalesforceApi,
  type QueryEnvelope,
  type SalesforceApiClient,
} from '../lib/salesforce-api.js';
import { loadSettings, registerSettingsShape } from '../lib/settings.js';
import { showToast } from '../ui/toast.js';

const SOQL_RUNNER_SETTINGS_SCHEMA = z.object({
  defaultApi: z.enum(['rest', 'tooling']).default('rest'),
  historyEnabled: z.boolean().default(true),
});

registerSettingsShape('soql-runner', SOQL_RUNNER_SETTINGS_SCHEMA);

const HISTORY_STORAGE_KEY = 'soqlRunner.history';
const HISTORY_CAP = 20;
const PAGE_CAP = 10;

type ApiMode = 'rest' | 'tooling';

interface HistoryEntry {
  q: string;
  api: ApiMode;
  ts: number;
}

interface HistoryRecord {
  entries: HistoryEntry[];
}

export async function readSoqlHistory(): Promise<HistoryEntry[]> {
  return new Promise((resolve) => {
    chrome.storage.local.get(HISTORY_STORAGE_KEY, (result) => {
      const raw = result?.[HISTORY_STORAGE_KEY] as HistoryRecord | undefined;
      resolve(Array.isArray(raw?.entries) ? raw.entries : []);
    });
  });
}

export async function writeSoqlHistory(entries: HistoryEntry[]): Promise<void> {
  const record: HistoryRecord = { entries: entries.slice(0, HISTORY_CAP) };
  return new Promise((resolve) => {
    chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: record }, () => resolve());
  });
}

export async function pushSoqlHistory(entry: HistoryEntry): Promise<void> {
  const existing = await readSoqlHistory();
  const deduped = existing.filter((e) => !(e.q === entry.q && e.api === entry.api));
  await writeSoqlHistory([entry, ...deduped]);
}

export async function clearSoqlHistory(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove(HISTORY_STORAGE_KEY, () => resolve());
  });
}

export function columnsFromRecords(records: ReadonlyArray<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const r of records) {
    for (const k of Object.keys(r)) {
      if (k === 'attributes' || seen.has(k)) continue;
      seen.add(k);
      cols.push(k);
    }
  }
  return cols;
}

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function recordsToCsv(records: ReadonlyArray<Record<string, unknown>>): string {
  const cols = columnsFromRecords(records);
  if (cols.length === 0) return '';
  const escape = (s: string): string => {
    if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const header = cols.map(escape).join(',');
  const rows = records.map((r) => cols.map((c) => escape(formatCell(r[c]))).join(','));
  return [header, ...rows].join('\n');
}

function triggerDownload(doc: Document, filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  doc.body.appendChild(a);
  a.click();
  doc.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function runQuery(
  api: SalesforceApiClient,
  soql: string,
  mode: ApiMode,
): Promise<QueryEnvelope<Record<string, unknown>>> {
  if (mode === 'tooling') {
    const result = await api.toolingQuery<Record<string, unknown>>(soql);
    return result;
  }
  return api.query<Record<string, unknown>>(soql);
}

export interface SoqlRunnerOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
}

export function createSoqlRunnerFeature(options: SoqlRunnerOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();

  let overlay: HTMLDivElement | null = null;

  function close(): void {
    overlay?.remove();
    overlay = null;
  }

  async function open(): Promise<void> {
    close();

    const settings = await loadSettings();
    const config = (settings.featureSettings?.['soql-runner'] ?? {
      defaultApi: 'rest',
      historyEnabled: true,
    }) as z.infer<typeof SOQL_RUNNER_SETTINGS_SCHEMA>;
    let mode: ApiMode = config.defaultApi;
    const historyEnabled = config.historyEnabled;

    overlay = doc.createElement('div');
    overlay.className = 'sfut-soql-runner-overlay';
    overlay.style.cssText =
      'position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 100020; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif;';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    const modal = doc.createElement('div');
    modal.style.cssText =
      'background: #fff; border-radius: 4px; width: 860px; max-width: 95vw; max-height: 90vh; display: flex; flex-direction: column;';

    const header = doc.createElement('div');
    header.style.cssText =
      'padding: 12px 16px; border-bottom: 1px solid #d8dde6; display: flex; justify-content: space-between; align-items: center; font-weight: 600;';
    const headerLabel = doc.createElement('span');
    headerLabel.textContent = '🗂 SOQL Query Runner';
    const closeBtn = doc.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'background: none; border: 0; font-size: 22px; cursor: pointer;';
    closeBtn.addEventListener('click', close);
    header.appendChild(headerLabel);
    header.appendChild(closeBtn);
    modal.appendChild(header);

    const body = doc.createElement('div');
    body.style.cssText = 'padding: 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 10px;';

    const toolbar = doc.createElement('div');
    toolbar.style.cssText = 'display: flex; gap: 8px; align-items: center;';
    const restBtn = doc.createElement('button');
    const toolingBtn = doc.createElement('button');
    const setMode = (next: ApiMode): void => {
      mode = next;
      const isRest = next === 'rest';
      restBtn.style.background = isRest ? '#0070d2' : '#fff';
      restBtn.style.color = isRest ? '#fff' : '#16325c';
      toolingBtn.style.background = isRest ? '#fff' : '#0070d2';
      toolingBtn.style.color = isRest ? '#16325c' : '#fff';
    };
    const togStyle =
      'padding: 4px 12px; border: 1px solid #d8dde6; cursor: pointer; font-size: 12px;';
    restBtn.style.cssText = togStyle + ' border-radius: 4px 0 0 4px;';
    toolingBtn.style.cssText = togStyle + ' border-radius: 0 4px 4px 0;';
    restBtn.textContent = 'REST';
    toolingBtn.textContent = 'Tooling';
    restBtn.addEventListener('click', () => setMode('rest'));
    toolingBtn.addEventListener('click', () => setMode('tooling'));
    setMode(mode);
    toolbar.appendChild(restBtn);
    toolbar.appendChild(toolingBtn);

    let historyMenu: HTMLDivElement | null = null;
    if (historyEnabled) {
      const historyBtn = doc.createElement('button');
      historyBtn.textContent = '▸ History ▾';
      historyBtn.style.cssText =
        'padding: 4px 10px; border: 1px solid #d8dde6; background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px;';
      const histWrap = doc.createElement('div');
      histWrap.style.cssText = 'position: relative;';
      histWrap.appendChild(historyBtn);
      historyMenu = doc.createElement('div');
      historyMenu.style.cssText =
        'display: none; position: absolute; top: 100%; left: 0; background: #fff; border: 1px solid #d8dde6; border-radius: 4px; min-width: 360px; max-width: 600px; max-height: 280px; overflow-y: auto; z-index: 100021; box-shadow: 0 2px 8px rgba(0,0,0,0.15);';
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
      toolbar.appendChild(histWrap);
    }
    body.appendChild(toolbar);

    const textarea = doc.createElement('textarea');
    textarea.placeholder = 'SELECT Id, Name FROM Account LIMIT 10';
    textarea.style.cssText =
      'width: 100%; min-height: 120px; font-family: ui-monospace, monospace; font-size: 13px; padding: 8px; border: 1px solid #d8dde6; border-radius: 4px; resize: vertical;';
    body.appendChild(textarea);

    const runRow = doc.createElement('div');
    runRow.style.cssText = 'display: flex; gap: 8px; align-items: center;';
    const runBtn = doc.createElement('button');
    runBtn.textContent = '▶ Run';
    runBtn.style.cssText =
      'padding: 6px 14px; background: #0070d2; color: #fff; border: 0; border-radius: 4px; cursor: pointer; font-size: 13px;';
    const status = doc.createElement('span');
    status.style.cssText = 'color: #54698d; font-size: 12px;';
    runRow.appendChild(runBtn);
    runRow.appendChild(status);
    body.appendChild(runRow);

    const errorPanel = doc.createElement('div');
    errorPanel.style.cssText =
      'display: none; border: 1px solid #c23934; background: #fef2f1; color: #c23934; padding: 8px 12px; border-radius: 4px; font-size: 13px; white-space: pre-wrap;';
    body.appendChild(errorPanel);

    const resultsWrap = doc.createElement('div');
    resultsWrap.style.cssText =
      'border: 1px solid #d8dde6; border-radius: 4px; overflow: auto; max-height: 360px; display: none;';
    body.appendChild(resultsWrap);

    const footer = doc.createElement('div');
    footer.style.cssText = 'display: flex; gap: 8px; align-items: center;';
    const loadMoreBtn = doc.createElement('button');
    loadMoreBtn.textContent = 'Load more';
    loadMoreBtn.style.cssText =
      'padding: 6px 12px; border: 1px solid #d8dde6; background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px; display: none;';
    const copyCsvBtn = doc.createElement('button');
    copyCsvBtn.textContent = 'Copy CSV';
    copyCsvBtn.style.cssText =
      'padding: 6px 12px; border: 1px solid #d8dde6; background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px; display: none;';
    const exportCsvBtn = doc.createElement('button');
    exportCsvBtn.textContent = 'Export CSV';
    exportCsvBtn.style.cssText =
      'padding: 6px 12px; border: 1px solid #d8dde6; background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px; display: none;';
    footer.appendChild(loadMoreBtn);
    footer.appendChild(copyCsvBtn);
    footer.appendChild(exportCsvBtn);

    if (historyEnabled) {
      const clearHistBtn = doc.createElement('button');
      clearHistBtn.textContent = 'Clear history';
      clearHistBtn.style.cssText =
        'padding: 6px 12px; border: 1px solid #d8dde6; background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px; margin-left: auto;';
      clearHistBtn.addEventListener('click', async () => {
        await clearSoqlHistory();
        showToast('Query history cleared', { doc, kind: 'success' });
      });
      footer.appendChild(clearHistBtn);
    }
    body.appendChild(footer);

    modal.appendChild(body);
    overlay.appendChild(modal);
    doc.body.appendChild(overlay);

    let records: Array<Record<string, unknown>> = [];
    let lastEnvelope: QueryEnvelope<Record<string, unknown>> | null = null;
    let pagesLoaded = 0;

    function showError(message: string): void {
      errorPanel.textContent = message;
      errorPanel.style.display = 'block';
      resultsWrap.style.display = 'none';
      loadMoreBtn.style.display = 'none';
      copyCsvBtn.style.display = 'none';
      exportCsvBtn.style.display = 'none';
    }

    function clearError(): void {
      errorPanel.textContent = '';
      errorPanel.style.display = 'none';
    }

    function renderResults(): void {
      while (resultsWrap.firstChild) resultsWrap.removeChild(resultsWrap.firstChild);
      if (records.length === 0) {
        const empty = doc.createElement('div');
        empty.style.cssText = 'padding: 12px; color: #80868d; font-size: 13px;';
        empty.textContent = 'No rows.';
        resultsWrap.appendChild(empty);
        resultsWrap.style.display = 'block';
        return;
      }
      const cols = columnsFromRecords(records);
      const table = doc.createElement('table');
      table.style.cssText = 'border-collapse: collapse; width: 100%; font-size: 12px;';
      const thead = doc.createElement('thead');
      const headRow = doc.createElement('tr');
      for (const c of cols) {
        const th = doc.createElement('th');
        th.textContent = c;
        th.style.cssText =
          'text-align: left; padding: 6px 10px; border-bottom: 1px solid #d8dde6; background: #fafaf9; position: sticky; top: 0;';
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = doc.createElement('tbody');
      for (const r of records) {
        const tr = doc.createElement('tr');
        for (const c of cols) {
          const td = doc.createElement('td');
          const raw = formatCell(r[c]);
          td.textContent = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
          td.title = raw;
          td.style.cssText = 'padding: 6px 10px; border-bottom: 1px solid #f3f3f3; vertical-align: top;';
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      resultsWrap.appendChild(table);
      resultsWrap.style.display = 'block';
      copyCsvBtn.style.display = 'inline-block';
      exportCsvBtn.style.display = 'inline-block';
      const canPaginate =
        !!lastEnvelope && lastEnvelope.done === false && !!lastEnvelope.nextRecordsUrl;
      loadMoreBtn.style.display = canPaginate && pagesLoaded < PAGE_CAP ? 'inline-block' : 'none';
    }

    async function renderHistoryMenu(): Promise<void> {
      if (!historyMenu) return;
      while (historyMenu.firstChild) historyMenu.removeChild(historyMenu.firstChild);
      const entries = await readSoqlHistory();
      if (entries.length === 0) {
        const empty = doc.createElement('div');
        empty.style.cssText = 'padding: 10px; color: #80868d; font-size: 12px;';
        empty.textContent = 'No queries yet.';
        historyMenu.appendChild(empty);
        return;
      }
      for (const entry of entries) {
        const item = doc.createElement('div');
        item.style.cssText =
          'padding: 8px 10px; cursor: pointer; border-bottom: 1px solid #f3f3f3; font-family: ui-monospace, monospace; font-size: 11px;';
        const badge = doc.createElement('span');
        badge.textContent = entry.api === 'tooling' ? 'TOOL ' : 'REST ';
        badge.style.cssText =
          entry.api === 'tooling'
            ? 'color: #b46600; font-weight: 600; margin-right: 6px;'
            : 'color: #0070d2; font-weight: 600; margin-right: 6px;';
        const text = doc.createElement('span');
        const trimmed = entry.q.length > 200 ? entry.q.slice(0, 200) + '…' : entry.q;
        text.textContent = trimmed;
        item.appendChild(badge);
        item.appendChild(text);
        item.addEventListener('click', () => {
          textarea.value = entry.q;
          setMode(entry.api);
          if (historyMenu) historyMenu.style.display = 'none';
          textarea.focus();
        });
        historyMenu.appendChild(item);
      }
    }

    async function execute(): Promise<void> {
      const soql = textarea.value.trim();
      if (!soql) {
        showError('Enter a SOQL query to run.');
        return;
      }
      clearError();
      runBtn.disabled = true;
      status.textContent = 'Running…';
      const t0 = Date.now();
      try {
        const envelope = await runQuery(api, soql, mode);
        const elapsed = Date.now() - t0;
        const total = envelope.totalSize ?? envelope.size ?? envelope.records.length;
        records = [...envelope.records];
        lastEnvelope = envelope;
        pagesLoaded = 1;
        status.textContent = `⏱ ${elapsed} ms · ${records.length}${
          envelope.done ? '' : ` of ${total}+`
        } row${records.length === 1 ? '' : 's'}`;
        renderResults();
        if (historyEnabled) {
          await pushSoqlHistory({ q: soql, api: mode, ts: Date.now() });
        }
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
        status.textContent = '';
      } finally {
        runBtn.disabled = false;
      }
    }

    async function loadMore(): Promise<void> {
      if (!lastEnvelope?.nextRecordsUrl || lastEnvelope.done) return;
      if (pagesLoaded >= PAGE_CAP) {
        showToast(`Stopped at ${PAGE_CAP} pages — narrow your query for more.`, {
          doc,
          kind: 'warning',
        });
        loadMoreBtn.style.display = 'none';
        return;
      }
      loadMoreBtn.disabled = true;
      const t0 = Date.now();
      try {
        const next = await api.queryMore<Record<string, unknown>>(lastEnvelope.nextRecordsUrl);
        records = records.concat(next.records);
        lastEnvelope = next;
        pagesLoaded += 1;
        const elapsed = Date.now() - t0;
        const total = next.totalSize ?? next.size ?? records.length;
        status.textContent = `⏱ +${elapsed} ms · ${records.length}${
          next.done ? '' : ` of ${total}+`
        } rows`;
        renderResults();
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
      } finally {
        loadMoreBtn.disabled = false;
      }
    }

    runBtn.addEventListener('click', () => void execute());
    loadMoreBtn.addEventListener('click', () => void loadMore());
    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void execute();
      }
    });
    copyCsvBtn.addEventListener('click', async () => {
      const csv = recordsToCsv(records);
      try {
        await win.navigator.clipboard.writeText(csv);
        showToast(`Copied ${records.length} rows as CSV`, { doc, kind: 'success' });
      } catch {
        showToast('Could not copy to clipboard', { doc, kind: 'error' });
      }
    });
    exportCsvBtn.addEventListener('click', () => {
      const csv = recordsToCsv(records);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      triggerDownload(doc, `soql-${stamp}.csv`, csv, 'text/csv');
    });

    doc.addEventListener('keydown', function escHandler(e) {
      if (e.key === 'Escape' && overlay) {
        close();
        doc.removeEventListener('keydown', escHandler);
      }
    });

    textarea.focus();
  }

  return {
    manifest: {
      id: 'soql-runner',
      name: 'SOQL Query Runner',
      contexts: [
        CONTEXTS.SETUP_FLOWS,
        CONTEXTS.SETUP_OTHER,
        CONTEXTS.FLOW_BUILDER,
        CONTEXTS.FLOW_TRIGGER_EXPLORER,
      ],
      settingsSchema: SOQL_RUNNER_SETTINGS_SCHEMA,
    },

    async onActivate() {
      const ctx = detectContext({ location: { href: win.location.href } }, doc);
      if (ctx === CONTEXTS.NONE) {
        showToast('Open a Salesforce page to run SOQL.', { doc, kind: 'warning' });
        return;
      }
      await open();
    },
  };
}

export function _soqlRunnerTestApi() {
  return {
    columnsFromRecords,
    formatCell,
    recordsToCsv,
    readSoqlHistory,
    writeSoqlHistory,
    pushSoqlHistory,
    clearSoqlHistory,
    HISTORY_CAP,
    PAGE_CAP,
  };
}
