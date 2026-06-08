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

// --- SAVED QUERIES DEFINITIONS ---
const SAVED_QUERIES_STORAGE_KEY = 'soqlRunner.savedQueries';

export interface SavedQuery {
  name: string;
  q: string;
  api: ApiMode;
}

export async function readSavedQueries(): Promise<SavedQuery[]> {
  return new Promise((resolve) => {
    chrome.storage.local.get(SAVED_QUERIES_STORAGE_KEY, (result) => {
      const raw = result?.[SAVED_QUERIES_STORAGE_KEY] as { entries?: SavedQuery[] } | undefined;
      resolve(Array.isArray(raw?.entries) ? raw.entries : []);
    });
  });
}

export async function writeSavedQueries(entries: SavedQuery[]): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [SAVED_QUERIES_STORAGE_KEY]: { entries } }, () => resolve());
  });
}

export async function pushSavedQuery(entry: SavedQuery): Promise<void> {
  const existing = await readSavedQueries();
  const filtered = existing.filter((e) => e.name !== entry.name);
  await writeSavedQueries([entry, ...filtered]);
}

export async function deleteSavedQuery(name: string): Promise<void> {
  const existing = await readSavedQueries();
  const filtered = existing.filter((e) => e.name !== name);
  await writeSavedQueries(filtered);
}

// --- METADATA DESCRIBE INTERFACES & CACHE ---
export interface FieldDescribe {
  name: string;
  label: string;
  type: string;
  relationshipName: string | null;
  referenceTo: string[];
  picklistValues: { value: string; label: string }[];
  nillable: boolean;
  calculated: boolean;
}

export interface SObjectDescribe {
  name: string;
  label: string;
  fields: FieldDescribe[];
}

export interface GlobalDescribe {
  sobjects: { name: string; label: string; keyPrefix: string | null }[];
}

export class DescribeCache {
  private api: SalesforceApiClient;
  private globalCache = new Map<ApiMode, { status: 'loading' | 'ready' | 'error'; data?: GlobalDescribe }>();
  private sobjectCache = new Map<string, { status: 'loading' | 'ready' | 'error'; data?: SObjectDescribe }>();
  private onUpdate: () => void;

  constructor(api: SalesforceApiClient, onUpdate: () => void) {
    this.api = api;
    this.onUpdate = onUpdate;
  }

  clear(): void {
    this.globalCache.clear();
    this.sobjectCache.clear();
  }

  getGlobal(mode: ApiMode) {
    const cached = this.globalCache.get(mode);
    if (cached) return cached;

    this.globalCache.set(mode, { status: 'loading' });
    const apiVersion = (this.api as any).apiVersion ?? 'v62.0';
    const endpoint = mode === 'tooling'
      ? `/services/data/${apiVersion}/tooling/sobjects/`
      : `/services/data/${apiVersion}/sobjects/`;

    this.api.apiGet<GlobalDescribe>(endpoint)
      .then(data => {
        const enriched = data && Array.isArray(data.sobjects) ? data : { sobjects: [] };
        this.globalCache.set(mode, { status: 'ready', data: enriched });
        this.onUpdate();
      })
      .catch(err => {
        console.error('Failed to describe global', err);
        this.globalCache.set(mode, { status: 'error' });
        this.onUpdate();
      });

    return { status: 'loading' as const };
  }

  getSObject(mode: ApiMode, name: string) {
    const key = `${mode}:${name.toLowerCase()}`;
    const cached = this.sobjectCache.get(key);
    if (cached) return cached;

    this.sobjectCache.set(key, { status: 'loading' });
    const apiVersion = (this.api as any).apiVersion ?? 'v62.0';
    const endpoint = mode === 'tooling'
      ? `/services/data/${apiVersion}/tooling/sobjects/${name}/describe`
      : `/services/data/${apiVersion}/sobjects/${name}/describe`;

    this.api.apiGet<SObjectDescribe>(endpoint)
      .then(data => {
        const enriched = data && Array.isArray(data.fields) ? data : { name, label: name, fields: [] };
        this.sobjectCache.set(key, { status: 'ready', data: enriched });
        this.onUpdate();
      })
      .catch(err => {
        console.error(`Failed to describe sobject ${name}`, err);
        this.sobjectCache.set(key, { status: 'error' });
        this.onUpdate();
      });

    return { status: 'loading' as const };
  }
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
  const trimmed = soql.trim();
  const apiVersion = (api as any).apiVersion ?? 'v62.0';

  // SOSL search mode
  if (trimmed.toLowerCase().startsWith('find')) {
    const results = await api.apiGet<Record<string, unknown>[]>(`/services/data/${apiVersion}/search`, { q: soql });
    return {
      records: results,
      done: true,
    };
  }

  // GraphQL query mode
  if (trimmed.startsWith('{') || trimmed.toLowerCase().startsWith('query')) {
    const response = await api.apiRequest<{ data: any }>(
      'POST',
      `/services/data/${apiVersion}/graphql`,
      { query: soql }
    );
    const records: any[] = [];
    if (response?.data) {
      const findNodes = (obj: any) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (item && item.node) {
              records.push(item.node);
            } else {
              findNodes(item);
            }
          }
        } else {
          for (const key of Object.keys(obj)) {
            if (key === 'edges' && Array.isArray(obj[key])) {
              for (const edge of obj[key]) {
                if (edge && edge.node) records.push(edge.node);
              }
            } else {
              findNodes(obj[key]);
            }
          }
        }
      };
      findNodes(response.data);
    }
    return {
      records: records.length > 0 ? records : [response as any],
      done: true,
    };
  }

  // Default SOQL queries
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

  // Helper to check if a value is a Salesforce Record ID
  function isRecordId(recordId: string): boolean {
    return typeof recordId === 'string'
      && /^[a-zA-Z0-9]{15,18}$/.test(recordId)
      && !recordId.startsWith('000')
      && /[0-9]/.test(recordId.slice(0, 5));
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
      void runAutocomplete();
    };
    const togStyle =
      'padding: 4px 12px; border: 1px solid #d8dde6; cursor: pointer; font-size: 12px;';
    restBtn.style.cssText = togStyle + ' border-radius: 4px 0 0 4px;';
    toolingBtn.style.cssText = togStyle + ' border-radius: 0 4px 4px 0;';
    restBtn.textContent = 'REST';
    toolingBtn.textContent = 'Tooling';
    restBtn.addEventListener('click', () => setMode('rest'));
    toolingBtn.addEventListener('click', () => setMode('tooling'));
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

    // Saved queries menu
    const savedQueriesBtn = doc.createElement('button');
    savedQueriesBtn.textContent = '★ Bookmarks ▾';
    savedQueriesBtn.style.cssText =
      'padding: 4px 10px; border: 1px solid #d8dde6; background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px;';
    const savedWrap = doc.createElement('div');
    savedWrap.style.cssText = 'position: relative;';
    savedWrap.appendChild(savedQueriesBtn);
    const savedQueriesMenu = doc.createElement('div');
    savedQueriesMenu.style.cssText =
      'display: none; position: absolute; top: 100%; left: 0; background: #fff; border: 1px solid #d8dde6; border-radius: 4px; min-width: 360px; max-width: 600px; max-height: 280px; overflow-y: auto; z-index: 100021; box-shadow: 0 2px 8px rgba(0,0,0,0.15);';
    savedWrap.appendChild(savedQueriesMenu);
    savedQueriesBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (savedQueriesMenu.style.display === 'block') {
        savedQueriesMenu.style.display = 'none';
        return;
      }
      await renderSavedQueriesMenu();
      savedQueriesMenu.style.display = 'block';
    });
    doc.addEventListener('click', (e) => {
      if (savedQueriesMenu && !savedWrap.contains(e.target as Node)) {
        savedQueriesMenu.style.display = 'none';
      }
    });
    toolbar.appendChild(savedWrap);

    body.appendChild(toolbar);

    const textarea = doc.createElement('textarea');
    textarea.placeholder = 'SELECT Id, Name FROM Account LIMIT 10';
    textarea.style.cssText =
      'width: 100%; min-height: 120px; font-family: ui-monospace, monospace; font-size: 13px; padding: 8px; border: 1px solid #d8dde6; border-bottom: 1px solid #e1e6eb; border-radius: 4px 4px 0 0; resize: vertical; margin-bottom: 0; outline: none; box-sizing: border-box;';
    body.appendChild(textarea);

    // --- AUTOCOMPLETE UI SETUP ---
    let expandAutocomplete = false;
    const describeCache = new DescribeCache(api, () => {
      autocompleteState = '';
      void runAutocomplete();
    });

    const autocompleteBox = doc.createElement('div');
    autocompleteBox.className = 'sfut-soql-autocomplete-box';
    autocompleteBox.style.cssText =
      'border: 1px solid #d8dde6; border-top: none; border-radius: 0 0 4px 4px; background: #fafaf9; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; font-family: system-ui, sans-serif;';

    const autocompleteHeader = doc.createElement('div');
    autocompleteHeader.style.cssText = 'display: flex; justify-content: space-between; align-items: center; color: #54698d; font-size: 12px; font-weight: 600;';
    
    const autocompleteTitle = doc.createElement('span');
    autocompleteTitle.textContent = 'Enter query to see suggestions...';
    autocompleteHeader.appendChild(autocompleteTitle);

    const toggleWrapBtn = doc.createElement('button');
    toggleWrapBtn.textContent = 'Expand ▾';
    toggleWrapBtn.style.cssText = 'background: none; border: none; color: #0070d2; font-size: 11px; cursor: pointer; padding: 2px 6px; border-radius: 3px; font-family: inherit;';
    toggleWrapBtn.addEventListener('click', () => {
      expandAutocomplete = !expandAutocomplete;
      updateResultsWrap();
    });
    autocompleteHeader.appendChild(toggleWrapBtn);
    autocompleteBox.appendChild(autocompleteHeader);

    const autocompleteResults = doc.createElement('div');
    autocompleteResults.style.cssText = 'display: flex; flex-wrap: nowrap; overflow-x: auto; gap: 6px; padding-bottom: 4px; scrollbar-width: thin;';
    autocompleteBox.appendChild(autocompleteResults);

    body.appendChild(autocompleteBox);

    const runRow = doc.createElement('div');
    runRow.style.cssText = 'display: flex; gap: 8px; align-items: center; margin-top: 10px;';
    const runBtn = doc.createElement('button');
    runBtn.textContent = '▶ Run';
    runBtn.style.cssText =
      'padding: 6px 14px; background: #0070d2; color: #fff; border: 0; border-radius: 4px; cursor: pointer; font-size: 13px;';
    const bookmarkBtn = doc.createElement('button');
    bookmarkBtn.textContent = '★ Save';
    bookmarkBtn.style.cssText =
      'padding: 6px 12px; background: #fff; color: #0070d2; border: 1px solid #d8dde6; border-radius: 4px; cursor: pointer; font-size: 13px;';
    bookmarkBtn.addEventListener('click', async () => {
      const q = textarea.value.trim();
      if (!q) {
        showToast('Enter a query to bookmark first', { doc, kind: 'warning' });
        return;
      }
      const name = win.prompt('Enter a name for this bookmark:', 'My Saved Query');
      if (name) {
        await pushSavedQuery({ name, q, api: mode });
        showToast('Query bookmarked successfully', { doc, kind: 'success' });
      }
    });
    const status = doc.createElement('span');
    status.style.cssText = 'color: #54698d; font-size: 12px;';
    runRow.appendChild(runBtn);
    runRow.appendChild(bookmarkBtn);
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

    function showCellMenu(element: HTMLElement, id: string) {
      const existing = doc.querySelector('.sfut-soql-cell-menu');
      if (existing) existing.remove();

      const menu = doc.createElement('div');
      menu.className = 'sfut-soql-cell-menu';
      menu.style.cssText =
        'position: absolute; background: #fff; border: 1px solid #d8dde6; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); z-index: 100030; padding: 4px 0; font-family: system-ui, sans-serif; font-size: 12px;';

      const items = [
        {
          label: '📋 Copy ID',
          click: async () => {
            await win.navigator.clipboard.writeText(id);
            showToast('ID copied to clipboard', { doc, kind: 'success' });
          }
        },
        {
          label: '🔍 Query Record',
          click: () => {
            const fromMatch = /from\s+([a-z0-9_]+)/i.exec(textarea.value);
            const sobj = fromMatch ? fromMatch[1] : 'SObject';
            textarea.value = `SELECT Id FROM ${sobj} WHERE Id = '${id}'`;
            textarea.focus();
            void runAutocomplete();
          }
        },
        {
          label: '🌐 View in Salesforce',
          click: () => {
            const host = win.location.host;
            win.open(`https://${host}/${id}`, '_blank');
          }
        }
      ];

      for (const item of items) {
        const itemEl = doc.createElement('div');
        itemEl.textContent = item.label;
        itemEl.style.cssText = 'padding: 6px 12px; cursor: pointer; color: #16325c;';
        itemEl.addEventListener('mouseenter', () => itemEl.style.background = '#f4f6f9');
        itemEl.addEventListener('mouseleave', () => itemEl.style.background = '#fff');
        itemEl.addEventListener('click', () => {
          item.click();
          menu.remove();
        });
        menu.appendChild(itemEl);
      }

      doc.body.appendChild(menu);
      const rect = element.getBoundingClientRect();
      const scrollY = win.scrollY || doc.documentElement.scrollTop;
      const scrollX = win.scrollX || doc.documentElement.scrollLeft || 0;
      menu.style.top = `${rect.bottom + scrollY}px`;
      menu.style.left = `${rect.left + scrollX}px`;

      const outsideClick = (e: MouseEvent) => {
        if (!menu.contains(e.target as Node) && e.target !== element) {
          menu.remove();
          doc.removeEventListener('click', outsideClick);
        }
      };
      doc.addEventListener('click', outsideClick);
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
          if (isRecordId(raw)) {
            const link = doc.createElement('a');
            link.href = '#';
            link.textContent = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
            link.style.cssText = 'color: #0070d2; text-decoration: underline; cursor: pointer;';
            link.addEventListener('click', (e) => {
              e.preventDefault();
              showCellMenu(link, raw);
            });
            td.appendChild(link);
          } else {
            td.textContent = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
          }
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

    async function renderSavedQueriesMenu(): Promise<void> {
      while (savedQueriesMenu.firstChild) savedQueriesMenu.removeChild(savedQueriesMenu.firstChild);
      const entries = await readSavedQueries();
      if (entries.length === 0) {
        const empty = doc.createElement('div');
        empty.style.cssText = 'padding: 10px; color: #80868d; font-size: 12px;';
        empty.textContent = 'No bookmarked queries yet.';
        savedQueriesMenu.appendChild(empty);
        return;
      }
      for (const entry of entries) {
        const item = doc.createElement('div');
        item.style.cssText =
          'padding: 8px 10px; cursor: pointer; border-bottom: 1px solid #f3f3f3; font-family: ui-monospace, monospace; font-size: 11px; display: flex; justify-content: space-between; align-items: center;';
        
        const contentWrap = doc.createElement('div');
        contentWrap.style.cssText = 'display: flex; align-items: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
        
        const badge = doc.createElement('span');
        badge.textContent = entry.api === 'tooling' ? 'TOOL ' : 'REST ';
        badge.style.cssText =
          entry.api === 'tooling'
            ? 'color: #b46600; font-weight: 600; margin-right: 6px; flex-shrink: 0;'
            : 'color: #0070d2; font-weight: 600; margin-right: 6px; flex-shrink: 0;';
        
        const titleText = doc.createElement('strong');
        titleText.textContent = `${entry.name}: `;
        titleText.style.cssText = 'margin-right: 4px; flex-shrink: 0;';

        const qText = doc.createElement('span');
        qText.textContent = entry.q.length > 100 ? entry.q.slice(0, 100) + '…' : entry.q;
        
        contentWrap.appendChild(badge);
        contentWrap.appendChild(titleText);
        contentWrap.appendChild(qText);
        
        item.appendChild(contentWrap);

        const deleteBtn = doc.createElement('button');
        deleteBtn.textContent = '×';
        deleteBtn.style.cssText = 'background: none; border: none; color: #c23934; font-size: 16px; cursor: pointer; padding: 0 4px;';
        deleteBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (win.confirm(`Are you sure you want to delete bookmark "${entry.name}"?`)) {
            await deleteSavedQuery(entry.name);
            await renderSavedQueriesMenu();
            showToast('Bookmark deleted', { doc, kind: 'success' });
          }
        });
        item.appendChild(deleteBtn);

        item.addEventListener('click', () => {
          textarea.value = entry.q;
          setMode(entry.api);
          savedQueriesMenu.style.display = 'none';
          textarea.focus();
        });
        savedQueriesMenu.appendChild(item);
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

    // --- AUTOCOMPLETE STATE & ENGINE ---
    let autocompleteState = '';
    async function runAutocomplete(ctrlSpace = false) {
      let selStart = textarea.selectionStart;
      const selEnd = textarea.selectionEnd;
      const query = textarea.value;

      const newAutocompleteState = [mode, query, selStart, selEnd].join('$');
      if (newAutocompleteState === autocompleteState && !ctrlSpace) {
        return;
      }
      autocompleteState = newAutocompleteState;

      const searchTerm = selStart !== selEnd
        ? query.substring(selStart, selEnd)
        : query.substring(0, selStart).match(/[a-zA-Z0-9_]*$/)?.[0] ?? '';
      const replaceStart = selEnd - searchTerm.length;

      function sortRank(value: string, title: string) {
        let i = 0;
        if (value.toLowerCase() === searchTerm.toLowerCase()) return i;
        i++;
        if (title.toLowerCase() === searchTerm.toLowerCase()) return i;
        i++;
        if (value.toLowerCase().startsWith(searchTerm.toLowerCase())) return i;
        i++;
        if (title.toLowerCase().startsWith(searchTerm.toLowerCase())) return i;
        i++;
        if (value.toLowerCase().includes('__' + searchTerm.toLowerCase())) return i;
        i++;
        if (value.toLowerCase().includes('_' + searchTerm.toLowerCase())) return i;
        i++;
        if (title.toLowerCase().includes(' ' + searchTerm.toLowerCase())) return i;
        i++;
        return i;
      }
      
      function resultsSort(a: any, b: any) {
        return sortRank(a.value, a.title) - sortRank(b.value, b.title) || a.rank - b.rank || a.value.localeCompare(b.value);
      }

      const textBefore = query.substring(0, replaceStart);
      if (textBefore.match(/(^|\s)from\s*$/i)) {
        const globalDesc = describeCache.getGlobal(mode);
        if (globalDesc.status === 'loading') {
          renderAutocompleteUI({ sobjectName: '', title: 'Loading SObjects...', results: [] });
          return;
        }
        if (globalDesc.status === 'error') {
          renderAutocompleteUI({
            sobjectName: '',
            title: 'Loading SObjects failed. Click to retry.',
            results: [{ value: 'Retry', title: 'Retry', autocompleteType: 'retry', suffix: '' }]
          });
          return;
        }
        if (globalDesc.data) {
          const results = globalDesc.data.sobjects
            .filter(sobjectDescribe => 
              sobjectDescribe.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
              sobjectDescribe.label.toLowerCase().includes(searchTerm.toLowerCase())
            )
            .map(sobjectDescribe => ({
              value: sobjectDescribe.name,
              title: sobjectDescribe.label,
              suffix: ' ',
              rank: 1,
              autocompleteType: 'object',
              dataType: ''
            }))
            .sort(resultsSort);

          renderAutocompleteUI({
            sobjectName: '',
            title: 'Objects suggestions:',
            results
          });
          return;
        }
      }

      let sobjectName = '';
      let isAfterFrom = false;
      let fromKeywordMatch = /(^|\s)from\s+([a-z0-9_]*)/i.exec(query);
      const findKeywordMatch = /(^|\s)find\s+([a-z0-9_]*)/i.exec(query);
      const graphKeywordMatch = /(^|\s)uiapi\s+([a-z0-9_]*)/i.exec(query);
      if (fromKeywordMatch) {
        sobjectName = fromKeywordMatch[2] ?? '';
        isAfterFrom = replaceStart > fromKeywordMatch.index + 1;
      } else {
        fromKeywordMatch = /^from\s+([a-z0-9_]*)/i.exec(query.substring(selEnd));
        if (fromKeywordMatch) {
          sobjectName = fromKeywordMatch[1] ?? '';
          isAfterFrom = false;
        } else {
          const title = (findKeywordMatch || graphKeywordMatch) ? '' : '"from" keyword not found';
          renderAutocompleteUI({
            sobjectName: '',
            title,
            results: []
          });
          return;
        }
      }

      fromKeywordMatch = /\(\s*select.*\sfrom\s+([a-z0-9_]*)/i.exec(query);
      if (fromKeywordMatch && fromKeywordMatch.index < replaceStart) {
        const subQuery = query.substring(fromKeywordMatch.index, replaceStart);
        if (subQuery.split(')').length < subQuery.split('(').length) {
          sobjectName = fromKeywordMatch[1] ?? '';
          isAfterFrom = replaceStart > fromKeywordMatch.index + fromKeywordMatch[0].length;
        }
      }

      if (!sobjectName) {
        renderAutocompleteUI({ sobjectName: '', title: 'Enter SObject name after FROM', results: [] });
        return;
      }

      const sobjectDesc = describeCache.getSObject(mode, sobjectName);
      if (sobjectDesc.status === 'loading') {
        renderAutocompleteUI({
          sobjectName,
          title: `Loading ${sobjectName} metadata...`,
          results: []
        });
        return;
      }
      if (sobjectDesc.status === 'error') {
        renderAutocompleteUI({
          sobjectName,
          title: `Loading ${sobjectName} metadata failed. Click to retry.`,
          results: [{ value: 'Retry', title: 'Retry', autocompleteType: 'retry', suffix: '' }]
        });
        return;
      }

      let contextEnd = replaceStart;
      let isFieldValue = query.substring(0, replaceStart).match(/\s*[<>=!]+\s*('?[^'\s]*)$/);
      const isInWithValues = query.substring(0, replaceStart).match(/\s*in\s*\(\s*(?:(?:'[^']*'\s*,\s*)+|')('?[^'\s]*)$/i);
      let inValuesUtilized = '';
      if (isInWithValues) {
        if (isInWithValues[0] && isInWithValues[0].match(/\s*in\s*\(\s*(?:')$/i)) {
          selStart -= 1;
          isInWithValues[0] = isInWithValues[0].substring(0, isInWithValues[0].length - 1);
        }
        isFieldValue = isInWithValues;
        inValuesUtilized = isInWithValues[0].toLowerCase();
      }

      let fieldName: string | null = null;
      if (isFieldValue) {
        const fieldEnd = replaceStart - isFieldValue[0].length;
        fieldName = query.substring(0, fieldEnd).match(/[a-zA-Z0-9_]*$/)?.[0] ?? '';
        contextEnd = fieldEnd - fieldName.length;
        selStart -= isFieldValue[1]?.length ?? 0;
      }

      let contextSobjectDescribes = [sobjectDesc.data!];
      const contextPath = query.substring(0, contextEnd).match(/[a-zA-Z0-9_.]*$/)?.[0] ?? '';
      const sobjectStatuses = new Map<string, string>();

      if (contextPath) {
        const contextFields = contextPath.split('.');
        contextFields.pop();
        for (const referenceFieldName of contextFields) {
          const newContextSobjectDescribes: SObjectDescribe[] = [];
          for (const currDesc of contextSobjectDescribes) {
            const matchingFields = currDesc.fields.filter(
              f => f.relationshipName && f.relationshipName.toLowerCase() === referenceFieldName.toLowerCase()
            );
            for (const field of matchingFields) {
              for (const referencedSobjectName of field.referenceTo) {
                const res = describeCache.getSObject(mode, referencedSobjectName);
                if (res.data) {
                  newContextSobjectDescribes.push(res.data);
                } else {
                  sobjectStatuses.set(res.status, referencedSobjectName);
                }
              }
            }
          }
          contextSobjectDescribes = newContextSobjectDescribes;
        }
      }

      if (contextSobjectDescribes.length === 0) {
        if (sobjectStatuses.has('loading')) {
          renderAutocompleteUI({ sobjectName, title: `Loading ${sobjectStatuses.get('loading')} metadata...`, results: [] });
          return;
        }
        if (sobjectStatuses.has('error')) {
          renderAutocompleteUI({
            sobjectName,
            title: `Loading ${sobjectStatuses.get('error')} metadata failed. Click to retry.`,
            results: [{ value: 'Retry', title: 'Retry', autocompleteType: 'retry', suffix: '' }]
          });
          return;
        }
        renderAutocompleteUI({ sobjectName, title: `Unknown field: ${sobjectName}.${contextPath}`, results: [] });
        return;
      }

      if (isFieldValue && fieldName) {
        const contextValueFields: { sobjectDescribe: SObjectDescribe; field: FieldDescribe }[] = [];
        for (const currDesc of contextSobjectDescribes) {
          const field = currDesc.fields.find(f => f.name.toLowerCase() === fieldName!.toLowerCase());
          if (field) {
            contextValueFields.push({ sobjectDescribe: currDesc, field });
          }
        }

        if (contextValueFields.length === 0) {
          renderAutocompleteUI({
            sobjectName,
            title: `Unknown field: ${sobjectDesc.data!.name}.${contextPath}${fieldName}`,
            results: []
          });
          return;
        }

        const fieldNamesStr = contextValueFields.map(cv => `${cv.sobjectDescribe.name}.${cv.field.name}`).join(', ');

        if (ctrlSpace) {
          if (contextValueFields.length > 1) {
            renderAutocompleteUI({ sobjectName, title: `Multiple possible fields: ${fieldNamesStr}`, results: [] });
            return;
          }
          const cv = contextValueFields[0]!;
          const escapedSearch = searchTerm.replace(/([\\'])/g, '\\$1');
          let whereClause = `${cv.field.name} LIKE '%${escapedSearch}%'`;
          if (cv.sobjectDescribe.name.toLowerCase() === 'recordtype') {
            let sobject = contextPath.split('.')[0] ?? '';
            sobject = sobject.toLowerCase() === 'recordtype' ? sobjectName : sobject;
            whereClause += sobject ? ` AND SobjectType = '${sobject}'` : '';
          }
          const acQuery = `SELECT ${cv.field.name} FROM ${cv.sobjectDescribe.name} WHERE ${whereClause} GROUP BY ${cv.field.name} LIMIT 100`;

          renderAutocompleteUI({
            sobjectName,
            title: `Loading ${fieldNamesStr} values...`,
            results: []
          });

          const queryPromise = mode === 'tooling'
            ? api.toolingQuery<{ [key: string]: unknown }>(acQuery)
            : api.query<{ [key: string]: unknown }>(acQuery);

          queryPromise
            .then(data => {
              const results = data.records
                .map(record => record[cv.field.name])
                .filter((v): v is string => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
                .map(v => ({
                  value: `'${v}'`,
                  title: String(v),
                  suffix: ' ',
                  rank: 1,
                  autocompleteType: 'fieldValue',
                  dataType: ''
                }))
                .sort(resultsSort);

              renderAutocompleteUI({
                sobjectName,
                title: `${fieldNamesStr} values suggestions:`,
                results
              });
            })
            .catch(err => {
              console.error('Failed to query values', err);
              renderAutocompleteUI({
                sobjectName,
                title: `Error: ${err.message}`,
                results: []
              });
            });

          return;
        }

        const suggestions: any[] = [];
        for (const { field } of contextValueFields) {
          for (const pv of field.picklistValues) {
            if (!inValuesUtilized.includes(pv.value.toLowerCase())) {
              suggestions.push({
                value: `'${pv.value}'`,
                title: pv.label,
                suffix: ' ',
                rank: 1,
                autocompleteType: 'picklistValue',
                dataType: ''
              });
            }
          }
          if (field.type === 'boolean') {
            suggestions.push({ value: 'true', title: 'true', suffix: ' ', rank: 1, autocompleteType: 'boolean', dataType: '' });
            suggestions.push({ value: 'false', title: 'false', suffix: ' ', rank: 1, autocompleteType: 'boolean', dataType: '' });
          }
          if (field.type === 'date' || field.type === 'datetime') {
            const pad = (n: number, d: number) => ('000' + n).slice(-d);
            const d = new Date();
            if (field.type === 'date') {
              suggestions.push({
                value: `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`,
                title: 'Today',
                suffix: ' ',
                rank: 1,
                autocompleteType: 'date',
                dataType: ''
              });
            }
            if (field.type === 'datetime') {
              const tzSign = d.getTimezoneOffset() <= 0 ? '+' : '-';
              const tzHours = pad(Math.floor(Math.abs(d.getTimezoneOffset()) / 60), 2);
              const tzMins = pad(Math.abs(d.getTimezoneOffset()) % 60, 2);
              suggestions.push({
                value: `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}T${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}${tzSign}${tzHours}:${tzMins}`,
                title: 'Now',
                suffix: ' ',
                rank: 1,
                autocompleteType: 'datetime',
                dataType: ''
              });
            }
            const dateConstants = [
              { value: 'YESTERDAY', title: 'Yesterday' },
              { value: 'TODAY', title: 'Today' },
              { value: 'TOMORROW', title: 'Tomorrow' },
              { value: 'LAST_WEEK', title: 'Last week' },
              { value: 'THIS_WEEK', title: 'This week' },
              { value: 'NEXT_WEEK', title: 'Next week' },
              { value: 'LAST_MONTH', title: 'Last month' },
              { value: 'THIS_MONTH', title: 'This month' },
              { value: 'NEXT_MONTH', title: 'Next month' },
              { value: 'LAST_90_DAYS', title: 'Last 90 days' },
              { value: 'NEXT_90_DAYS', title: 'Next 90 days' },
              { value: 'LAST_N_DAYS:n', title: 'Last N days' },
              { value: 'NEXT_N_DAYS:n', title: 'Next N days' },
              { value: 'NEXT_N_WEEKS:n', title: 'Next N weeks' },
              { value: 'N_DAYS_AGO:n', title: 'N days ago' },
              { value: 'LAST_N_WEEKS:n', title: 'Last N weeks' },
              { value: 'N_WEEKS_AGO:n', title: 'N weeks ago' },
              { value: 'NEXT_N_MONTHS:n', title: 'Next N months' },
              { value: 'LAST_N_MONTHS:n', title: 'Last N months' },
              { value: 'N_MONTHS_AGO:n', title: 'N months ago' },
              { value: 'THIS_QUARTER', title: 'This quarter' },
              { value: 'LAST_QUARTER', title: 'Last quarter' },
              { value: 'NEXT_QUARTER', title: 'Next quarter' },
              { value: 'NEXT_N_QUARTERS:n', title: 'Next N quarters' },
              { value: 'LAST_N_QUARTERS:n', title: 'Last N quarters' },
              { value: 'N_QUARTERS_AGO:n', title: 'N quarters ago' },
              { value: 'THIS_YEAR', title: 'This year' },
              { value: 'LAST_YEAR', title: 'Last year' },
              { value: 'NEXT_YEAR', title: 'Next year' },
              { value: 'NEXT_N_YEARS:n', title: 'Next N years' },
              { value: 'LAST_N_YEARS:n', title: 'Last N years' },
              { value: 'N_YEARS_AGO:n', title: 'N years ago' }
            ];
            for (const dc of dateConstants) {
              suggestions.push({
                value: dc.value,
                title: dc.title,
                suffix: ' ',
                rank: 1,
                autocompleteType: 'variable',
                dataType: ''
              });
            }
          }
          if (field.nillable) {
            suggestions.push({ value: 'null', title: 'null', suffix: ' ', rank: 1, autocompleteType: 'null', dataType: '' });
          }
        }

        const filteredSuggestions = suggestions
          .filter(s => s.value.toLowerCase().includes(searchTerm.toLowerCase()) || s.title.toLowerCase().includes(searchTerm.toLowerCase()))
          .sort(resultsSort);

        renderAutocompleteUI({
          sobjectName,
          title: fieldNamesStr + (filteredSuggestions.length === 0 ? ' values (Press Ctrl+Space to load suggestions):' : ' values:'),
          results: filteredSuggestions
        });
        return;
      }

      if (ctrlSpace) {
        const allMatching = contextSobjectDescribes
          .flatMap(desc => desc.fields)
          .filter(field => field.name.toLowerCase().includes(searchTerm.toLowerCase()) || field.label.toLowerCase().includes(searchTerm.toLowerCase()))
          .map(field => contextPath + field.name);
        
        if (allMatching.length > 0) {
          textarea.focus();
          textarea.setRangeText(allMatching.join(', ') + (isAfterFrom ? ' ' : ''), replaceStart - contextPath.length, selEnd, 'end');
        }
        void runAutocomplete();
        return;
      }

      const fieldSuggestions: any[] = [];
      for (const desc of contextSobjectDescribes) {
        const fields = desc.fields.filter(
          field => field.name.toLowerCase().includes(searchTerm.toLowerCase()) || field.label.toLowerCase().includes(searchTerm.toLowerCase())
        );
        for (const field of fields) {
          fieldSuggestions.push({
            value: field.name,
            title: field.label,
            suffix: isAfterFrom ? ' ' : ', ',
            rank: 1,
            autocompleteType: 'fieldName',
            dataType: field.type
          });
          if (field.relationshipName) {
            fieldSuggestions.push({
              value: field.relationshipName + '.',
              title: field.label,
              suffix: '',
              rank: 1,
              autocompleteType: 'relationshipName',
              dataType: ''
            });
          }
        }
      }

      const soqlFunctions = [
        'FIELDS(ALL)', 'FIELDS(STANDARD)', 'FIELDS(CUSTOM)',
        'AVG', 'COUNT', 'COUNT_DISTINCT', 'MIN', 'MAX', 'SUM',
        'CALENDAR_MONTH', 'CALENDAR_QUARTER', 'CALENDAR_YEAR',
        'DAY_IN_MONTH', 'DAY_IN_WEEK', 'DAY_IN_YEAR', 'DAY_ONLY',
        'FISCAL_MONTH', 'FISCAL_QUARTER', 'FISCAL_YEAR', 'HOUR_IN_DAY',
        'WEEK_IN_MONTH', 'WEEK_IN_YEAR', 'toLabel', 'convertTimezone',
        'convertCurrency', 'FORMAT', 'GROUPING'
      ];
      for (const fn of soqlFunctions) {
        if (fn.toLowerCase().startsWith(searchTerm.toLowerCase())) {
          if (fn.includes(')')) {
            fieldSuggestions.push({ value: fn, title: fn, suffix: '', rank: 2, autocompleteType: 'variable', dataType: '' });
          } else {
            fieldSuggestions.push({ value: fn, title: fn + '()', suffix: '(', rank: 2, autocompleteType: 'variable', dataType: '' });
          }
        }
      }

      fieldSuggestions.sort(resultsSort);

      const objectNames = contextSobjectDescribes.map(desc => desc.name).join(', ');
      renderAutocompleteUI({
        sobjectName,
        title: `${objectNames} fields suggestions:`,
        results: fieldSuggestions
      });
    }

    function getIconForSuggestion(type: string, dataType: string): string {
      if (type === 'object') return '📦';
      if (type === 'relationshipName') return '🔗';
      if (type === 'variable') return '⚙️';
      if (type === 'picklistValue') return '📋';
      if (type === 'boolean') return '🌗';
      if (type === 'null') return '🕳️';
      if (type === 'fieldValue') return '🔸';
      
      if (type === 'fieldName') {
        switch (dataType?.toLowerCase()) {
          case 'id': return '🔑';
          case 'reference': return '🔍';
          case 'string':
          case 'textarea': return '📝';
          case 'int':
          case 'double':
          case 'long':
          case 'currency':
          case 'percent': return '🔢';
          case 'boolean': return '🌗';
          case 'date':
          case 'datetime': return '📅';
          case 'picklist':
          case 'multipicklist': return '📋';
          case 'phone': return '📞';
          case 'url': return '🌐';
          case 'email': return '✉️';
          default: return '🔹';
        }
      }
      return '🔹';
    }

    function renderAutocompleteUI(data: { sobjectName: string; title: string; results: any[] }) {
      autocompleteTitle.textContent = data.title || '\u00A0';
      
      while (autocompleteResults.firstChild) {
        autocompleteResults.removeChild(autocompleteResults.firstChild);
      }

      if (data.results.length === 0) {
        const none = doc.createElement('span');
        none.style.cssText = 'color: #80868d; font-size: 12px; font-style: italic;';
        none.textContent = 'No suggestions available';
        autocompleteResults.appendChild(none);
        return;
      }

      for (const item of data.results) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        const icon = getIconForSuggestion(item.autocompleteType, item.dataType);
        btn.textContent = `${icon} ${item.value}`;
        btn.title = item.title;
        btn.style.cssText =
          'display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border: 1px solid #d8dde6; border-radius: 14px; background: #fff; color: #0070d2; font-size: 12px; cursor: pointer; white-space: nowrap; transition: background 0.15s, border-color 0.15s, transform 0.1s; outline: none; margin: 2px 0; font-family: system-ui, sans-serif;';
        
        btn.addEventListener('mouseenter', () => {
          btn.style.background = '#f4f6f9';
          btn.style.borderColor = '#0070d2';
          btn.style.transform = 'translateY(-1px)';
        });
        btn.addEventListener('mouseleave', () => {
          btn.style.background = '#fff';
          btn.style.borderColor = '#d8dde6';
          btn.style.transform = 'none';
        });
        
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          onAutocompleteClick(item);
        });

        autocompleteResults.appendChild(btn);
      }
    }

    function onAutocompleteClick(item: any) {
      if (item.value === 'Retry') {
        describeCache.clear();
        void runAutocomplete();
        return;
      }

      const selStart = textarea.selectionStart;
      const selEnd = textarea.selectionEnd;
      const query = textarea.value;

      const searchTerm = selStart !== selEnd
        ? query.substring(selStart, selEnd)
        : query.substring(0, selStart).match(/[a-zA-Z0-9_]*$/)?.[0] ?? '';
      const replaceStart = selEnd - searchTerm.length;

      textarea.focus();
      let suffix = item.suffix ?? '';

      const indexFrom = query.toLowerCase().indexOf('from');
      const textAfterSelection = query.substring(selEnd).trim();
      if (suffix.trim() === ',' && (
        query.substring(selEnd, indexFrom).trim().length === 0 ||
        textAfterSelection.startsWith(',') ||
        textAfterSelection.toLowerCase().startsWith('from')
      )) {
        suffix = '';
      }

      textarea.setRangeText(item.value + suffix, replaceStart, selEnd, 'end');
      
      if (item.value.startsWith('FIELDS') && !textarea.value.toLowerCase().includes('limit')) {
        textarea.value += ' LIMIT 200';
      }

      void runAutocomplete();
    }

    function updateResultsWrap() {
      if (expandAutocomplete) {
        autocompleteResults.style.flexWrap = 'wrap';
        autocompleteResults.style.overflowX = 'visible';
        autocompleteResults.style.maxHeight = '180px';
        autocompleteResults.style.overflowY = 'auto';
        toggleWrapBtn.textContent = 'Collapse ▴';
      } else {
        autocompleteResults.style.flexWrap = 'nowrap';
        autocompleteResults.style.overflowX = 'auto';
        autocompleteResults.style.maxHeight = 'none';
        autocompleteResults.style.overflowY = 'visible';
        toggleWrapBtn.textContent = 'Expand ▾';
      }
    }

    runBtn.addEventListener('click', () => void execute());
    loadMoreBtn.addEventListener('click', () => void loadMore());
    
    // Wire up autocomplete events
    textarea.addEventListener('input', () => void runAutocomplete());
    textarea.addEventListener('keyup', (e) => {
      if (e.key !== 'Control' && e.key !== 'Meta' && e.key !== 'Shift' && e.key !== 'Alt') {
        void runAutocomplete();
      }
    });
    textarea.addEventListener('click', () => void runAutocomplete());
    textarea.addEventListener('focus', () => void runAutocomplete());

    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void execute();
      }
      if (e.ctrlKey && e.key === ' ') {
        e.preventDefault();
        void runAutocomplete(true);
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
    setMode(mode);
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
    readSavedQueries,
    writeSavedQueries,
    pushSavedQuery,
    deleteSavedQuery,
    DescribeCache,
    runQuery,
    HISTORY_CAP,
    PAGE_CAP,
  };
}
