import { z } from 'zod';
import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import {
  getSalesforceApi,
  type QueryEnvelope,
  type SalesforceApiClient,
} from '../lib/salesforce-api.js';
import {
  getDescribeCache,
  DescribeCache,
  type ApiMode,
  type FieldDescribe,
  type SObjectDescribe,
} from '../lib/describe-cache.js';
import { loadSettings, registerSettingsShape } from '../lib/settings.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';

const SOQL_RUNNER_SETTINGS_SCHEMA = z.object({
  defaultApi: z.enum(['rest', 'tooling']).default('rest'),
  historyEnabled: z.boolean().default(true),
});

registerSettingsShape('soql-runner', SOQL_RUNNER_SETTINGS_SCHEMA);

const HISTORY_STORAGE_KEY = 'soqlRunner.history';
const HISTORY_CAP = 20;
const PAGE_CAP = 10;

/**
 * Which query language the editor is in. SOQL is `SELECT … FROM …` against one
 * object; SOSL is `FIND {term} …`, a text search that returns rows from many
 * objects at once (hence the per-object result grouping).
 */
export type QueryLang = 'soql' | 'sosl';

/**
 * Is this query text SOSL? A query whose first keyword is FIND is SOSL —
 * the same rule the CLI uses (`validateLocal()` in `src/lib/soql-runner.js`
 * sets `kind: 'sosl'` on `/^find\b/i`) and the same rule the GUI console uses
 * to route a query to the SOSL endpoint (`isSosl` in
 * `gui/src/pages/SoqlConsole.jsx`). Semantics stay identical across the three
 * surfaces; only the transport differs (the extension goes through the
 * worker-proxied REST Search resource, never the CLI).
 */
export function isSoslQuery(text: string | null | undefined): boolean {
  return /^\s*find\b/i.test(text ?? '');
}

/** The language a query text is written in — the auto-detect half of the toggle. */
export function detectQueryLang(text: string | null | undefined): QueryLang {
  return isSoslQuery(text) ? 'sosl' : 'soql';
}

/** One returned sObject's slice of a SOSL result set. */
export interface SoslGroup {
  sobject: string;
  records: Array<Record<string, unknown>>;
}

/** Bucket for search rows whose `attributes.type` is missing or unusable. */
const UNKNOWN_SOBJECT = 'Unknown';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The rows of a REST Search reply. The documented shape is
 * `{ searchRecords: [...] }`; a bare array is accepted too so a caller holding
 * an already-unwrapped list can reuse the grouping. Anything else — an error
 * body, `null`, a reply with no `searchRecords` — yields zero rows rather than
 * a throw, so a malformed response renders as "no matches" and never as a
 * fabricated row.
 */
export function searchRecordsFrom(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw.filter(isPlainRecord);
  if (isPlainRecord(raw) && Array.isArray(raw.searchRecords)) {
    return raw.searchRecords.filter(isPlainRecord);
  }
  return [];
}

/**
 * Map a REST Search reply to one group per returned sObject, in the order the
 * objects first appear in the response (Salesforce returns the RETURNING
 * clause's objects in order). Each row keeps its fields but drops the
 * Salesforce `attributes` envelope, so a group's records are exactly the shape
 * the shared CSV/TSV/JSON serialisers already take for SOQL rows.
 *
 * An empty (or unusable) response yields NO groups — never a group with an
 * empty record list, so the UI can't present a fabricated object heading.
 */
export function groupSearchRecords(raw: unknown): SoslGroup[] {
  const groups: SoslGroup[] = [];
  const byName = new Map<string, SoslGroup>();
  for (const record of searchRecordsFrom(raw)) {
    const attributes = record.attributes;
    const type =
      isPlainRecord(attributes) && typeof attributes.type === 'string' && attributes.type.length > 0
        ? attributes.type
        : UNKNOWN_SOBJECT;
    let group = byName.get(type);
    if (!group) {
      group = { sobject: type, records: [] };
      byName.set(type, group);
      groups.push(group);
    }
    const { attributes: _attributes, ...fields } = record;
    group.records.push(fields);
  }
  return groups;
}

/** Total rows across every group — the number the status line reports. */
export function soslRowCount(groups: ReadonlyArray<SoslGroup>): number {
  return groups.reduce((sum, g) => sum + g.records.length, 0);
}

interface HistoryEntry {
  q: string;
  api: ApiMode;
  /** Query language. Absent on entries written before P4-3 — see {@link entryLang}. */
  lang?: QueryLang;
  ts: number;
}

/**
 * The language a stored history/saved/pending entry was recorded in. Entries
 * written before the SOSL toggle shipped carry no `lang`, so fall back to
 * detecting it from the query text — an old `FIND {…}` bookmark still restores
 * into SOSL mode.
 */
export function entryLang(entry: { q: string; lang?: QueryLang } | null | undefined): QueryLang {
  return entry?.lang ?? detectQueryLang(entry?.q);
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
  const deduped = existing.filter(
    (e) => !(e.q === entry.q && e.api === entry.api && entryLang(e) === entryLang(entry)),
  );
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
  /** Query language. Absent on bookmarks saved before P4-3 — see {@link entryLang}. */
  lang?: QueryLang;
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

// --- PENDING QUERY HAND-OFF ---
// The Saved SOQL workspace panel stashes a chosen query here, then opens the
// runner; open() consumes and clears it to pre-fill the editor. This keeps the
// two features decoupled (saved-soql depends on soql-runner, not vice-versa).
const PENDING_QUERY_STORAGE_KEY = 'soqlRunner.pendingQuery';

export interface PendingQuery {
  q: string;
  api: ApiMode;
  /** Query language, so a staged SOSL query opens the runner in SOSL mode. */
  lang?: QueryLang;
}

export async function writePendingQuery(entry: PendingQuery): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [PENDING_QUERY_STORAGE_KEY]: entry }, () => resolve());
  });
}

export async function takePendingQuery(): Promise<PendingQuery | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(PENDING_QUERY_STORAGE_KEY, (result) => {
      const raw = result?.[PENDING_QUERY_STORAGE_KEY] as PendingQuery | undefined;
      if (raw && typeof raw.q === 'string') {
        chrome.storage.local.remove(PENDING_QUERY_STORAGE_KEY, () => resolve(raw));
      } else {
        resolve(null);
      }
    });
  });
}

// Shape shared by every autocomplete chip (objects, fields, values, retry).
// `rank`/`dataType` are optional because sentinel entries (e.g. Retry) omit them.
interface AutocompleteSuggestion {
  value: string;
  title: string;
  suffix: string;
  autocompleteType: string;
  rank?: number;
  dataType?: string;
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

function csvEscape(s: string): string {
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Serialize one page of records to CSV data rows (no header) for a fixed column
// set. Used by both recordsToCsv and the streaming export-all path.
function csvRows(cols: string[], records: ReadonlyArray<Record<string, unknown>>): string {
  return records.map((r) => cols.map((c) => csvEscape(formatCell(r[c]))).join(',')).join('\n');
}

export function recordsToCsv(records: ReadonlyArray<Record<string, unknown>>): string {
  const cols = columnsFromRecords(records);
  if (cols.length === 0) return '';
  const header = cols.map(csvEscape).join(',');
  const rows = csvRows(cols, records);
  return rows ? `${header}\n${rows}` : header;
}

export interface ExportAllProgress {
  pages: number;
  rows: number;
}

export interface ExportAllResult {
  parts: string[];
  rows: number;
  pages: number;
  canceled: boolean;
}

// Streams a query to completion via queryMore(), building CSV incrementally.
// Memory approach: columns are fixed from the first page, then each page's rows
// are converted to a CSV text chunk and pushed onto a `parts[]` array — the raw
// record objects for that page are never retained past conversion, and we never
// build one giant concatenated string (the caller hands `parts` straight to
// `new Blob(parts, …)`, which concatenates lazily). Peak memory is therefore one
// page of records plus the accumulated CSV text, not every record object at once.
export async function exportAllToCsv(
  api: SalesforceApiClient,
  first: QueryEnvelope<Record<string, unknown>>,
  opts: { signal?: AbortSignal; onProgress?: (p: ExportAllProgress) => void } = {},
): Promise<ExportAllResult> {
  const { signal, onProgress } = opts;
  const cols = columnsFromRecords(first.records);
  const parts: string[] = [];
  let rows = 0;
  let pages = 0;

  const pushPage = (records: ReadonlyArray<Record<string, unknown>>): void => {
    if (records.length === 0) return;
    parts.push(`${csvRows(cols, records)}\n`);
    rows += records.length;
  };

  if (cols.length > 0) parts.push(`${cols.map(csvEscape).join(',')}\n`);
  pushPage(first.records);
  pages = 1;
  onProgress?.({ pages, rows });
  // Check even for a single-page (already-done) export so a Cancel between the
  // first page and the return still aborts instead of downloading.
  if (signal?.aborted) return { parts, rows, pages, canceled: true };

  let envelope = first;
  while (!envelope.done && envelope.nextRecordsUrl) {
    if (signal?.aborted) return { parts, rows, pages, canceled: true };
    envelope = await api.queryMore<Record<string, unknown>>(envelope.nextRecordsUrl);
    // Re-check after the await: if cancelled mid-fetch, don't process/emit this
    // page (avoids a trailing onProgress that would stomp a superseding run).
    if (signal?.aborted) return { parts, rows, pages, canceled: true };
    pushPage(envelope.records);
    pages += 1;
    onProgress?.({ pages, rows });
  }
  return { parts, rows, pages, canceled: false };
}

// Pretty-printed JSON of the current result set. The Salesforce `attributes`
// envelope is dropped so the output matches the columns shown in the table
// (and what CSV/TSV export). Nested relationship records keep their real
// structure — this is not a stringified-cell flattening like CSV/TSV.
export function recordsToJson(records: ReadonlyArray<Record<string, unknown>>): string {
  const stripped = records.map(({ attributes: _attributes, ...rest }) => rest);
  return JSON.stringify(stripped, null, 2);
}

// Tab-separated values for pasting into a spreadsheet. Mirrors recordsToCsv's
// RFC-4180-style quoting but on the TAB delimiter, so a value containing a tab
// or newline is quoted and can't break the column/row grid on paste.
// ponytail: near-copy of recordsToCsv; fold into one delimiter-parametrised
// helper only if a third delimiter ever shows up.
export function recordsToTsv(records: ReadonlyArray<Record<string, unknown>>): string {
  const cols = columnsFromRecords(records);
  if (cols.length === 0) return '';
  const escape = (s: string): string => {
    if (s.includes('"') || s.includes('\t') || s.includes('\n') || s.includes('\r')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const header = cols.map(escape).join('\t');
  const rows = records.map((r) => cols.map((c) => escape(formatCell(r[c]))).join('\t'));
  return [header, ...rows].join('\n');
}

export function generateLangGraphNode(soql: string, records: ReadonlyArray<Record<string, unknown>>): string {
  const cols = columnsFromRecords(records);
  const typeMap: Record<string, string> = {};
  // Escape backslashes first, then double-quotes, so the query can't break out
  // of the Python triple-quoted string literal it is embedded in below.
  const safeSoql = soql.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  if (records.length > 0) {
    const firstRow = records[0] as Record<string, unknown>;
    for (const col of cols) {
       const val = firstRow[col];
       if (typeof val === 'number') typeMap[col] = 'float';
       else if (typeof val === 'boolean') typeMap[col] = 'bool';
       else typeMap[col] = 'str';
    }
  }

  const fieldsDef = cols.map(c => `    ${c}: ${typeMap[c] || 'str'}`).join('\n');

  return `from typing import Any, Dict
from langchain_core.runnables import RunnableConfig
from pydantic import BaseModel

class SoqlResult(BaseModel):
${fieldsDef || '    pass'}

def execute_soql_node(state: Dict[str, Any], config: RunnableConfig) -> Dict[str, Any]:
    """
    Executes a SOQL query against Salesforce.
    """
    query = """
${safeSoql}
    """

    # Example implementation using simple_salesforce or similar
    # sf = get_salesforce_client(config)
    # results = sf.query(query)

    # return {"soql_results": results['records']}
    pass
`;
}

function downloadBlob(doc: Document, filename: string, blob: Blob): void {
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

function triggerDownload(doc: Document, filename: string, text: string, mime: string): void {
  downloadBlob(doc, filename, new Blob([text], { type: mime }));
}

/**
 * Execute a SOSL search through the worker-proxied REST Search resource and
 * map the reply to one group per returned sObject.
 *
 * Transport note: the CLI runs SOSL via `sf data search` (`runSearch` in
 * `src/lib/soql-runner.js`) and returns the flat `searchRecords` list; the
 * extension calls the same underlying REST resource through `sfApiFetch` and
 * groups the rows here. Same result rows, same detection rule — only the
 * presentation differs, because the extension has a table to draw and the CLI
 * has an envelope to print.
 *
 * There is no Tooling variant of the Search resource, so SOSL is REST-only.
 */
async function runSearch(api: SalesforceApiClient, sosl: string): Promise<SoslGroup[]> {
  const raw = await api.apiGet<unknown>(`/services/data/${api.apiVersion}/search`, { q: sosl });
  return groupSearchRecords(raw);
}

async function runQuery(
  api: SalesforceApiClient,
  soql: string,
  mode: ApiMode,
): Promise<QueryEnvelope<Record<string, unknown>>> {
  const trimmed = soql.trim();
  const apiVersion = api.apiVersion;

  // SOSL search mode. The runner's SOSL mode calls runSearch() directly to keep
  // the per-object grouping; this branch is the flat view of the same rows, for
  // callers that only want an envelope (and for a FIND query typed while the
  // toggle somehow still says SOQL). Both go through groupSearchRecords, so
  // there is exactly one SOSL response mapping.
  if (isSoslQuery(trimmed)) {
    const groups = await runSearch(api, soql);
    return {
      records: groups.flatMap((g) => g.records),
      done: true,
    };
  }

  // GraphQL query mode
  if (trimmed.startsWith('{') || trimmed.toLowerCase().startsWith('query')) {
    const response = await api.apiRequest<{ data: unknown; errors?: Array<{ message?: string }> }>(
      'POST',
      `/services/data/${apiVersion}/graphql`,
      { query: soql }
    );
    // The GraphQL endpoint returns HTTP 200 even on failure; surface any errors.
    if (Array.isArray(response?.errors) && response.errors.length > 0) {
      const messages = response.errors
        .map((e) => e?.message)
        .filter((m): m is string => typeof m === 'string' && m.length > 0);
      throw new Error(messages.length > 0 ? messages.join('\n') : 'GraphQL query failed.');
    }
    const isRecord = (v: unknown): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null && !Array.isArray(v);
    const records: Record<string, unknown>[] = [];
    if (response?.data) {
      const findNodes = (obj: unknown): void => {
        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (isRecord(item) && isRecord(item.node)) {
              records.push(item.node);
            } else {
              findNodes(item);
            }
          }
        } else if (isRecord(obj)) {
          for (const key of Object.keys(obj)) {
            const value = obj[key];
            if (key === 'edges' && Array.isArray(value)) {
              for (const edge of value) {
                if (isRecord(edge) && isRecord(edge.node)) records.push(edge.node);
              }
            } else {
              findNodes(value);
            }
          }
        }
      };
      findNodes(response.data);
    }
    return {
      records: records.length > 0 ? records : [(response ?? {}) as Record<string, unknown>],
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

// --- QUERY PLAN / EXPLAIN ---
// Salesforce's query-plan endpoint is the same query resource with an
// `?explain=<soql>` param instead of `?q=`; the Tooling variant lives under
// /tooling/query. It returns one plan per candidate access path (the first is
// the one the optimizer picks). Non-explainable queries (SOSL, aggregate-only,
// malformed) return an HTTP error, which the caller surfaces inline.
export interface QueryPlanNote {
  description?: string;
  tableEnumOrId?: string;
  fields?: string[];
}

export interface QueryPlan {
  cardinality?: number;
  sobjectCardinality?: number;
  leadingOperationType?: string;
  relativeCost?: number;
  sobjectType?: string;
  notes?: QueryPlanNote[];
}

async function explainQuery(
  api: SalesforceApiClient,
  soql: string,
  mode: ApiMode,
): Promise<QueryPlan[]> {
  const apiVersion = api.apiVersion;
  const endpoint = mode === 'tooling'
    ? `/services/data/${apiVersion}/tooling/query`
    : `/services/data/${apiVersion}/query`;
  const resp = await api.apiGet<{ plans?: QueryPlan[] }>(endpoint, { explain: soql });
  return Array.isArray(resp?.plans) ? resp.plans : [];
}

const EXPLAIN_TITLE =
  'Show the query plan (cost, cardinality, leading operation) without running the query';

export interface SoqlRunnerOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
}

/** The SOQL Runner feature, plus an imperative hook so other tools (Schema
 * Browser) can drop a field into the live draft — or stash it for the next open. */
export type SoqlRunnerFeature = Feature & {
  insertFieldIntoDraft: (fieldApiName: string) => void;
};

// Append a field into a draft SOQL query predictably: slot it into the SELECT
// list (before FROM when present, else at the end). Comma-separates unless the
// insertion point already follows SELECT or a trailing comma.
export function insertFieldIntoQuery(query: string, field: string): string {
  if (!query.trim()) return field;
  const sep = (before: string): string =>
    /(,|\bselect)\s*$/i.test(before) ? ' ' : ', ';
  const from = /\bfrom\b/i.exec(query);
  if (from) {
    const before = query.slice(0, from.index).replace(/\s+$/, '');
    return `${before}${sep(before)}${field} ${query.slice(from.index)}`;
  }
  const trimmed = query.replace(/\s+$/, '');
  return `${trimmed}${sep(trimmed)}${field} `;
}

export function createSoqlRunnerFeature(options: SoqlRunnerOptions = {}): SoqlRunnerFeature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();

  let view: ViewHandle | null = null;
  // The live query textarea while the runner is open (null once closed), plus a
  // field fragment stashed by insertFieldIntoDraft() when the runner is closed —
  // applied to the draft on the next open(). Mirrors the pending-query hand-off.
  let activeTextarea: HTMLTextAreaElement | null = null;
  let pendingFieldFragment: string | null = null;

  // Drop a field API name into the draft: append to the open textarea, or stash
  // it for the next open() when the runner isn't up.
  function insertFieldIntoDraft(fieldApiName: string): void {
    if (activeTextarea) {
      activeTextarea.value = insertFieldIntoQuery(activeTextarea.value, fieldApiName);
      // Re-run autocomplete + keep the field list in sync via the existing input path.
      activeTextarea.dispatchEvent(new Event('input'));
      activeTextarea.focus();
      return;
    }
    pendingFieldFragment = insertFieldIntoQuery(pendingFieldFragment ?? '', fieldApiName);
  }

  function close(): void {
    view?.close();
    view = null;
    activeTextarea = null;
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
    let lang: QueryLang = 'soql';
    const historyEnabled = config.historyEnabled;

    const body = doc.createElement('div');
    body.style.cssText = 'padding: 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 10px;';

    const toolbar = doc.createElement('div');
    toolbar.style.cssText = 'display: flex; gap: 8px; align-items: center;';

    // --- SOQL / SOSL language toggle ---
    // A real radiogroup (roles + aria-checked + roving tabindex + arrow keys),
    // because two <button>s styled as a segmented control are otherwise
    // indistinguishable from unrelated buttons to a screen reader
    // (CONVENTIONS.md items 9 and 11).
    const langGroup = doc.createElement('div');
    langGroup.setAttribute('role', 'radiogroup');
    langGroup.setAttribute('aria-label', 'Query language');
    langGroup.style.cssText = 'display: inline-flex;';
    const soqlLangBtn = doc.createElement('button');
    const soslLangBtn = doc.createElement('button');
    const langButtons: Array<[QueryLang, HTMLButtonElement]> = [
      ['soql', soqlLangBtn],
      ['sosl', soslLangBtn],
    ];
    const LANG_TITLES: Record<QueryLang, string> = {
      soql: 'SOQL — SELECT … FROM one object',
      sosl: 'SOSL — FIND {term} … text search across many objects',
    };
    for (const [value, btn] of langButtons) {
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      btn.textContent = value.toUpperCase();
      btn.title = LANG_TITLES[value];
      btn.style.cssText =
        'padding: 4px 12px; border: 1px solid var(--sfdt-color-border); cursor: pointer; font-size: 12px;' +
        (value === 'soql' ? ' border-radius: 4px 0 0 4px;' : ' border-radius: 0 4px 4px 0;');
      btn.addEventListener('click', () => setLang(value));
      // Arrow keys move the selection inside the group, as a radiogroup must.
      btn.addEventListener('keydown', (e) => {
        if (['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
          e.preventDefault();
          setLang(value === 'soql' ? 'sosl' : 'soql', { focus: true });
        }
      });
      langGroup.appendChild(btn);
    }
    toolbar.appendChild(langGroup);

    const restBtn = doc.createElement('button');
    const toolingBtn = doc.createElement('button');
    const setMode = (next: ApiMode): void => {
      mode = next;
      const isRest = next === 'rest';
      restBtn.style.background = isRest ? 'var(--sfdt-color-brand)' : 'var(--sfdt-color-surface)';
      restBtn.style.color = isRest ? 'var(--sfdt-color-on-accent)' : 'var(--sfdt-color-text-strong)';
      toolingBtn.style.background = isRest ? 'var(--sfdt-color-surface)' : 'var(--sfdt-color-brand)';
      toolingBtn.style.color = isRest ? 'var(--sfdt-color-text-strong)' : 'var(--sfdt-color-on-accent)';
      void runAutocomplete();
    };
    const togStyle =
      'padding: 4px 12px; border: 1px solid var(--sfdt-color-border); cursor: pointer; font-size: 12px;';
    restBtn.style.cssText = togStyle + ' border-radius: 4px 0 0 4px;';
    toolingBtn.style.cssText = togStyle + ' border-radius: 0 4px 4px 0;';
    restBtn.textContent = 'REST';
    toolingBtn.textContent = 'Tooling';
    restBtn.addEventListener('click', () => setMode('rest'));
    toolingBtn.addEventListener('click', () => setMode('tooling'));
    toolbar.appendChild(restBtn);
    toolbar.appendChild(toolingBtn);

    // Switch query language. Drives the editor affordances that differ between
    // the two languages: SOSL has no Tooling variant of the Search resource, no
    // query plan (same as the GUI console, which disables Plan for a FIND
    // query), and no SOQL field/object autocomplete.
    function setLang(next: QueryLang, opts: { focus?: boolean } = {}): void {
      lang = next;
      const sosl = next === 'sosl';
      for (const [value, btn] of langButtons) {
        const on = value === next;
        btn.setAttribute('aria-checked', String(on));
        btn.tabIndex = on ? 0 : -1;
        btn.style.background = on ? 'var(--sfdt-color-brand)' : 'var(--sfdt-color-surface)';
        btn.style.color = on ? 'var(--sfdt-color-on-accent)' : 'var(--sfdt-color-text-strong)';
        if (opts.focus && on) btn.focus();
      }
      textarea.placeholder = sosl
        ? 'FIND {Acme} IN ALL FIELDS RETURNING Account(Id, Name), Contact(Id, Name)'
        : 'SELECT Id, Name FROM Account LIMIT 10';
      // The Tooling API has no search resource — SOSL always runs on REST.
      toolingBtn.disabled = sosl;
      toolingBtn.title = sosl ? 'SOSL runs on the REST Search resource — the Tooling API has no search endpoint' : '';
      if (sosl && mode !== 'rest') setMode('rest');
      explainBtn.disabled = sosl;
      explainBtn.title = sosl ? 'Query plans are SOQL-only' : EXPLAIN_TITLE;
      autocompleteBox.style.display = sosl ? 'none' : 'flex';
      void runAutocomplete();
    }

    // Keep the toggle honest when the user types or pastes: a query whose first
    // keyword is FIND is SOSL, a SELECT is SOQL — the same auto-routing the GUI
    // console does. The toggle stays the source of truth for anything the text
    // does not settle (a half-typed query keeps the current mode).
    function syncLangFromText(): void {
      const text = textarea.value;
      if (lang !== 'sosl' && isSoslQuery(text)) setLang('sosl');
      else if (lang !== 'soql' && /^\s*select\b/i.test(text)) setLang('soql');
    }

    let historyMenu: HTMLDivElement | null = null;
    if (historyEnabled) {
      const historyBtn = doc.createElement('button');
      historyBtn.textContent = '▸ History ▾';
      historyBtn.style.cssText =
        'padding: 4px 10px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); border-radius: 4px; cursor: pointer; font-size: 12px;';
      const histWrap = doc.createElement('div');
      histWrap.style.cssText = 'position: relative;';
      histWrap.appendChild(historyBtn);
      historyMenu = doc.createElement('div');
      historyMenu.style.cssText =
        'display: none; position: absolute; top: 100%; left: 0; background: var(--sfdt-color-surface); border: 1px solid var(--sfdt-color-border); border-radius: 4px; min-width: 360px; max-width: 600px; max-height: 280px; overflow-y: auto; z-index: 100021; box-shadow: 0 2px 8px rgba(0,0,0,0.15);';
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
      'padding: 4px 10px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); border-radius: 4px; cursor: pointer; font-size: 12px;';
    const savedWrap = doc.createElement('div');
    savedWrap.style.cssText = 'position: relative;';
    savedWrap.appendChild(savedQueriesBtn);
    const savedQueriesMenu = doc.createElement('div');
    savedQueriesMenu.style.cssText =
      'display: none; position: absolute; top: 100%; left: 0; background: var(--sfdt-color-surface); border: 1px solid var(--sfdt-color-border); border-radius: 4px; min-width: 360px; max-width: 600px; max-height: 280px; overflow-y: auto; z-index: 100021; box-shadow: 0 2px 8px rgba(0,0,0,0.15);';
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
      'width: 100%; min-height: 120px; font-family: ui-monospace, monospace; font-size: 13px; padding: 8px; border: 1px solid var(--sfdt-color-border); border-bottom: 1px solid var(--sfdt-color-surface-shade-6); border-radius: 4px 4px 0 0; resize: vertical; margin-bottom: 0; outline: none; box-sizing: border-box;';
    body.appendChild(textarea);

    // --- AUTOCOMPLETE UI SETUP ---
    let expandAutocomplete = false;
    const describeCache = getDescribeCache(api);
    const unsubscribeDescribe = describeCache.subscribe(() => {
      autocompleteState = '';
      void runAutocomplete();
    });

    const autocompleteBox = doc.createElement('div');
    autocompleteBox.className = 'sfdt-soql-autocomplete-box';
    autocompleteBox.style.cssText =
      'border: 1px solid var(--sfdt-color-border); border-top: none; border-radius: 0 0 4px 4px; background: var(--sfdt-color-surface-alt); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; font-family: system-ui, sans-serif;';

    const autocompleteHeader = doc.createElement('div');
    autocompleteHeader.style.cssText = 'display: flex; justify-content: space-between; align-items: center; color: var(--sfdt-color-text-weak); font-size: 12px; font-weight: 600;';
    
    const autocompleteTitle = doc.createElement('span');
    autocompleteTitle.textContent = 'Enter query to see suggestions...';
    autocompleteHeader.appendChild(autocompleteTitle);

    const toggleWrapBtn = doc.createElement('button');
    toggleWrapBtn.textContent = 'Expand ▾';
    toggleWrapBtn.style.cssText = 'background: none; border: none; color: var(--sfdt-color-brand-text); font-size: 11px; cursor: pointer; padding: 2px 6px; border-radius: 3px; font-family: inherit;';
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
      'padding: 6px 14px; background: var(--sfdt-color-brand); color: var(--sfdt-color-on-accent); border: 0; border-radius: 4px; cursor: pointer; font-size: 13px;';
    const explainBtn = doc.createElement('button');
    explainBtn.textContent = '🔎 Explain';
    explainBtn.title = EXPLAIN_TITLE;
    explainBtn.style.cssText =
      'padding: 6px 12px; background: var(--sfdt-color-surface); color: var(--sfdt-color-brand-text); border: 1px solid var(--sfdt-color-border); border-radius: 4px; cursor: pointer; font-size: 13px;';
    const bookmarkBtn = doc.createElement('button');
    bookmarkBtn.textContent = '★ Save';
    bookmarkBtn.style.cssText =
      'padding: 6px 12px; background: var(--sfdt-color-surface); color: var(--sfdt-color-brand-text); border: 1px solid var(--sfdt-color-border); border-radius: 4px; cursor: pointer; font-size: 13px;';
    bookmarkBtn.addEventListener('click', async () => {
      const q = textarea.value.trim();
      if (!q) {
        showToast('Enter a query to bookmark first', { doc, kind: 'warning' });
        return;
      }
      const name = win.prompt('Enter a name for this bookmark:', 'My Saved Query');
      if (name) {
        await pushSavedQuery({ name, q, api: mode, lang });
        showToast('Query bookmarked successfully', { doc, kind: 'success' });
      }
    });
    const status = doc.createElement('span');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.style.cssText = 'color: var(--sfdt-color-text-weak); font-size: 12px;';
    runRow.appendChild(runBtn);
    runRow.appendChild(explainBtn);
    runRow.appendChild(bookmarkBtn);
    runRow.appendChild(status);
    body.appendChild(runRow);

    const errorPanel = doc.createElement('div');
    errorPanel.setAttribute('role', 'alert');
    errorPanel.style.cssText =
      'display: none; border: 1px solid var(--sfdt-color-error); background: var(--sfdt-color-error-bg); color: var(--sfdt-color-error-text); padding: 8px 12px; border-radius: 4px; font-size: 13px; white-space: pre-wrap;';
    body.appendChild(errorPanel);

    // Query-plan (EXPLAIN) output panel — separate from the results table so a
    // plan and a result set don't clobber each other.
    const explainPanel = doc.createElement('div');
    explainPanel.style.cssText =
      'display: none; border: 1px solid var(--sfdt-color-border); border-radius: 4px; overflow: auto; max-height: 360px;';
    body.appendChild(explainPanel);

    const resultsWrap = doc.createElement('div');
    resultsWrap.style.cssText =
      'border: 1px solid var(--sfdt-color-border); border-radius: 4px; overflow: auto; max-height: 360px; display: none;';
    body.appendChild(resultsWrap);

    // Result-set state. Declared before the toolbar factory below because its
    // buttons read whichever set they were built for.
    // `records` is the flat SOQL result set; `groups` is the SOSL one (one
    // entry per returned sObject). Exactly one of them is populated at a time —
    // whichever the last run produced.
    let records: Array<Record<string, unknown>> = [];
    let groups: SoslGroup[] = [];
    let lastEnvelope: QueryEnvelope<Record<string, unknown>> | null = null;
    let pagesLoaded = 0;
    // Tracks an in-flight "Export all" so a new run/loadMore/error can supersede
    // it: the running export compares against this and stays silent once null'd.
    let exportController: AbortController | null = null;

    const ACTION_BTN_CSS =
      'padding: 6px 12px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); color: var(--sfdt-color-text-strong); border-radius: 4px; cursor: pointer; font-size: 12px;';

    /**
     * The shared result toolbar: Copy CSV / Export CSV / Copy JSON / Copy for
     * Excel over a record set. ONE definition, used twice — once for the flat
     * SOQL result set in the footer, and once per SOSL object group, so
     * copy/export apply per group without a second toolbar or a second
     * serialiser (the P1-3 `recordsToCsv`/`recordsToJson`/`recordsToTsv` are
     * the only serialisers in either path).
     *
     * `scope` names the record set for accessible labels and toasts ("Copy
     * Account rows as CSV") — the visible button text stays identical in both
     * places so the toolbar reads the same wherever it appears.
     */
    function createResultActions(opts: {
      getRecords: () => Array<Record<string, unknown>>;
      filePrefix: string;
      scope?: string;
    }): { copyCsv: HTMLButtonElement; exportCsv: HTMLButtonElement; copyJson: HTMLButtonElement; copyExcel: HTMLButtonElement; all: HTMLButtonElement[] } {
      const { getRecords, filePrefix, scope } = opts;
      const of = scope ? `${scope} ` : '';
      const mk = (label: string, ariaLabel: string, onClick: () => void | Promise<void>): HTMLButtonElement => {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.setAttribute('aria-label', ariaLabel);
        btn.style.cssText = ACTION_BTN_CSS;
        btn.addEventListener('click', () => void onClick());
        return btn;
      };
      const copyText = async (text: string, what: string): Promise<void> => {
        const n = getRecords().length;
        try {
          await win.navigator.clipboard.writeText(text);
          showToast(`Copied ${n} ${of}row${n === 1 ? '' : 's'} ${what}`, { doc, kind: 'success' });
        } catch {
          showToast('Could not copy to clipboard', { doc, kind: 'error' });
        }
      };
      const copyCsv = mk('Copy CSV', `Copy ${of}rows as CSV`, () =>
        copyText(recordsToCsv(getRecords()), 'as CSV'));
      const exportCsv = mk('Export CSV', `Download ${of}rows as a CSV file`, () => {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        triggerDownload(doc, `${filePrefix}-${stamp}.csv`, recordsToCsv(getRecords()), 'text/csv');
      });
      const copyJson = mk('Copy JSON', `Copy ${of}rows as JSON`, () =>
        copyText(recordsToJson(getRecords()), 'as JSON'));
      const copyExcel = mk('Copy for Excel', `Copy ${of}rows for Excel`, () =>
        copyText(recordsToTsv(getRecords()), 'for Excel'));
      return { copyCsv, exportCsv, copyJson, copyExcel, all: [copyCsv, exportCsv, copyJson, copyExcel] };
    }

    const mainActions = createResultActions({ getRecords: () => records, filePrefix: 'soql' });
    const { copyCsv: copyCsvBtn, exportCsv: exportCsvBtn, copyJson: copyJsonBtn, copyExcel: copyExcelBtn } =
      mainActions;
    for (const btn of mainActions.all) btn.style.display = 'none';

    const footer = doc.createElement('div');
    footer.style.cssText = 'display: flex; gap: 8px; align-items: center;';
    const loadMoreBtn = doc.createElement('button');
    loadMoreBtn.textContent = 'Load more';
    loadMoreBtn.style.cssText =
      'padding: 6px 12px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); border-radius: 4px; cursor: pointer; font-size: 12px; display: none;';
    const exportAllBtn = doc.createElement('button');
    exportAllBtn.textContent = 'Export all as CSV';
    exportAllBtn.title = 'Follow pagination to the end and download every row';
    exportAllBtn.style.cssText =
      'padding: 6px 12px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); border-radius: 4px; cursor: pointer; font-size: 12px; display: none;';
    const cancelExportBtn = doc.createElement('button');
    cancelExportBtn.textContent = 'Cancel';
    cancelExportBtn.setAttribute('aria-label', 'Cancel export');
    cancelExportBtn.style.cssText =
      'padding: 6px 12px; border: 1px solid var(--sfdt-color-error); background: var(--sfdt-color-surface); color: var(--sfdt-color-error-text); border-radius: 4px; cursor: pointer; font-size: 12px; display: none;';
    const langGraphBtn = doc.createElement('button');
    langGraphBtn.textContent = 'LangGraph Node';
    langGraphBtn.style.cssText =
      'padding: 6px 12px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); border-radius: 4px; cursor: pointer; font-size: 12px; display: none;';
    footer.appendChild(loadMoreBtn);
    footer.appendChild(copyCsvBtn);
    footer.appendChild(exportCsvBtn);
    footer.appendChild(exportAllBtn);
    footer.appendChild(cancelExportBtn);
    footer.appendChild(copyJsonBtn);
    footer.appendChild(copyExcelBtn);
    footer.appendChild(langGraphBtn);

    if (historyEnabled) {
      const clearHistBtn = doc.createElement('button');
      clearHistBtn.textContent = 'Clear history';
      clearHistBtn.style.cssText =
        'padding: 6px 12px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); border-radius: 4px; cursor: pointer; font-size: 12px; margin-left: auto;';
      clearHistBtn.addEventListener('click', async () => {
        await clearSoqlHistory();
        showToast('Query history cleared', { doc, kind: 'success' });
      });
      footer.appendChild(clearHistBtn);
    }
    body.appendChild(footer);

    view = presentView({
      title: '🗂 SOQL Query Runner',
      body,
      doc,
      width: '860px',
      onClose: () => { view = null; activeTextarea = null; unsubscribeDescribe(); },
    });

    // Cancel any in-flight export and reset its UI. Idempotent; the running
    // handler's owns()-guard skips its own cleanup once superseded here.
    function abortExport(): void {
      if (!exportController) return;
      exportController.abort();
      exportController = null;
      exportAllBtn.disabled = false;
      cancelExportBtn.style.display = 'none';
    }

    // Run and Explain share `records`/`lastEnvelope`/`status` and toggle the same
    // panels, so only one may be in flight at a time. Guard both entry points —
    // including the Ctrl+Enter path, which bypasses the disabled button — and
    // disable both buttons for visual feedback.
    let busy = false;
    function setBusy(next: boolean): void {
      busy = next;
      runBtn.disabled = next;
      // Explain stays disabled in SOSL mode regardless of the busy flag —
      // there is no query plan for a FIND query.
      explainBtn.disabled = next || lang === 'sosl';
    }

    // Hide every footer action that belongs to a result set (the shared
    // toolbar's four, plus the pagination/export-all/LangGraph extras).
    function hideResultActions(): void {
      for (const btn of [
        loadMoreBtn,
        copyCsvBtn,
        exportCsvBtn,
        exportAllBtn,
        cancelExportBtn,
        copyJsonBtn,
        copyExcelBtn,
        langGraphBtn,
      ]) {
        btn.style.display = 'none';
      }
    }

    function showError(message: string): void {
      abortExport();
      errorPanel.textContent = message;
      errorPanel.style.display = 'block';
      resultsWrap.style.display = 'none';
      explainPanel.style.display = 'none';
      hideResultActions();
    }

    function clearError(): void {
      errorPanel.textContent = '';
      errorPanel.style.display = 'none';
    }

    function showCellMenu(element: HTMLElement, id: string) {
      const existing = doc.querySelector('.sfdt-soql-cell-menu');
      if (existing) existing.remove();

      const menu = doc.createElement('div');
      menu.className = 'sfdt-soql-cell-menu';
      menu.style.cssText =
        'position: absolute; background: var(--sfdt-color-surface); border: 1px solid var(--sfdt-color-border); border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); z-index: 100030; padding: 4px 0; font-family: system-ui, sans-serif; font-size: 12px;';

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
        itemEl.style.cssText = 'padding: 6px 12px; cursor: pointer; color: var(--sfdt-color-text-strong);';
        itemEl.addEventListener('mouseenter', () => itemEl.style.background = 'var(--sfdt-color-surface-shade)');
        itemEl.addEventListener('mouseleave', () => itemEl.style.background = 'var(--sfdt-color-surface)');
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

    function emptyNote(text: string): HTMLDivElement {
      const empty = doc.createElement('div');
      empty.style.cssText = 'padding: 12px; color: var(--sfdt-color-text-icon); font-size: 13px;';
      empty.textContent = text;
      return empty;
    }

    // Build the result table for a record set. Shared by the flat SOQL view and
    // each SOSL object group so the two never drift (record-Id cells, the
    // 200-char cell clamp, and the sticky header behave identically).
    function buildRecordsTable(rows: ReadonlyArray<Record<string, unknown>>): HTMLTableElement {
      const cols = columnsFromRecords(rows);
      const table = doc.createElement('table');
      table.style.cssText = 'border-collapse: collapse; width: 100%; font-size: 12px;';
      const thead = doc.createElement('thead');
      const headRow = doc.createElement('tr');
      for (const c of cols) {
        const th = doc.createElement('th');
        th.textContent = c;
        th.style.cssText =
          'text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface-alt); position: sticky; top: 0;';
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = doc.createElement('tbody');
      for (const r of rows) {
        const tr = doc.createElement('tr');
        for (const c of cols) {
          const td = doc.createElement('td');
          const raw = formatCell(r[c]);
          if (isRecordId(raw)) {
            const link = doc.createElement('a');
            link.href = '#';
            link.textContent = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
            link.style.cssText = 'color: var(--sfdt-color-brand-text); text-decoration: underline; cursor: pointer;';
            link.addEventListener('click', (e) => {
              e.preventDefault();
              showCellMenu(link, raw);
            });
            td.appendChild(link);
          } else {
            td.textContent = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
          }
          td.title = raw;
          td.style.cssText = 'padding: 6px 10px; border-bottom: 1px solid var(--sfdt-color-bg); vertical-align: top;';
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      return table;
    }

    // Flat SOQL result set.
    function renderResults(): void {
      explainPanel.style.display = 'none';
      while (resultsWrap.firstChild) resultsWrap.removeChild(resultsWrap.firstChild);
      if (records.length === 0) {
        hideResultActions();
        resultsWrap.appendChild(emptyNote('No rows.'));
        resultsWrap.style.display = 'block';
        return;
      }
      resultsWrap.appendChild(buildRecordsTable(records));
      resultsWrap.style.display = 'block';
      copyCsvBtn.style.display = 'inline-block';
      exportCsvBtn.style.display = 'inline-block';
      exportAllBtn.style.display = 'inline-block';
      copyJsonBtn.style.display = 'inline-block';
      copyExcelBtn.style.display = 'inline-block';
      langGraphBtn.style.display = 'inline-block';
      const canPaginate =
        !!lastEnvelope && lastEnvelope.done === false && !!lastEnvelope.nextRecordsUrl;
      loadMoreBtn.style.display = canPaginate && pagesLoaded < PAGE_CAP ? 'inline-block' : 'none';
    }

    // SOSL result set: one section per returned sObject, each with its own copy
    // of the shared result toolbar scoped to that group's rows. The footer
    // actions stay hidden — they act on the flat SOQL set, and SOSL has no
    // queryMore to paginate or export-all.
    function renderGroupedResults(): void {
      explainPanel.style.display = 'none';
      hideResultActions();
      while (resultsWrap.firstChild) resultsWrap.removeChild(resultsWrap.firstChild);
      if (groups.length === 0) {
        resultsWrap.appendChild(emptyNote('No matches.'));
        resultsWrap.style.display = 'block';
        return;
      }
      for (const group of groups) {
        const section = doc.createElement('section');
        section.setAttribute('aria-label', `${group.sobject} results`);
        section.style.cssText = 'border-bottom: 1px solid var(--sfdt-color-border);';

        const head = doc.createElement('div');
        head.style.cssText =
          'display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px 10px; background: var(--sfdt-color-surface-alt); border-bottom: 1px solid var(--sfdt-color-border);';
        const heading = doc.createElement('h3');
        const n = group.records.length;
        heading.textContent = `${group.sobject} · ${n} row${n === 1 ? '' : 's'}`;
        heading.style.cssText =
          'margin: 0; font-size: 12px; font-weight: 600; color: var(--sfdt-color-text-strong);';
        head.appendChild(heading);
        const spacer = doc.createElement('span');
        spacer.style.cssText = 'flex: 1;';
        head.appendChild(spacer);
        const groupActions = createResultActions({
          getRecords: () => group.records,
          filePrefix: `sosl-${group.sobject}`,
          scope: group.sobject,
        });
        for (const btn of groupActions.all) head.appendChild(btn);
        section.appendChild(head);
        section.appendChild(buildRecordsTable(group.records));
        resultsWrap.appendChild(section);
      }
      resultsWrap.style.display = 'block';
    }

    async function renderHistoryMenu(): Promise<void> {
      if (!historyMenu) return;
      while (historyMenu.firstChild) historyMenu.removeChild(historyMenu.firstChild);
      const entries = await readSoqlHistory();
      if (entries.length === 0) {
        const empty = doc.createElement('div');
        empty.style.cssText = 'padding: 10px; color: var(--sfdt-color-text-icon); font-size: 12px;';
        empty.textContent = 'No queries yet.';
        historyMenu.appendChild(empty);
        return;
      }
      for (const entry of entries) {
        const item = doc.createElement('div');
        item.style.cssText =
          'padding: 8px 10px; cursor: pointer; border-bottom: 1px solid var(--sfdt-color-bg); font-family: ui-monospace, monospace; font-size: 11px;';
        const entryMode = entryLang(entry);
        const langBadge = doc.createElement('span');
        langBadge.textContent = entryMode === 'sosl' ? 'SOSL ' : 'SOQL ';
        langBadge.style.cssText =
          'color: var(--sfdt-color-text-weak); font-weight: 600; margin-right: 6px;';
        const badge = doc.createElement('span');
        badge.textContent = entry.api === 'tooling' ? 'TOOL ' : 'REST ';
        badge.style.cssText =
          entry.api === 'tooling'
            ? 'color: var(--sfdt-color-warning-text); font-weight: 600; margin-right: 6px;'
            : 'color: var(--sfdt-color-brand-text); font-weight: 600; margin-right: 6px;';
        const text = doc.createElement('span');
        const trimmed = entry.q.length > 200 ? entry.q.slice(0, 200) + '…' : entry.q;
        text.textContent = trimmed;
        item.appendChild(langBadge);
        item.appendChild(badge);
        item.appendChild(text);
        item.addEventListener('click', () => {
          textarea.value = entry.q;
          setMode(entry.api);
          // After setMode: SOSL forces REST, so the language wins the tie.
          setLang(entryMode);
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
        empty.style.cssText = 'padding: 10px; color: var(--sfdt-color-text-icon); font-size: 12px;';
        empty.textContent = 'No bookmarked queries yet.';
        savedQueriesMenu.appendChild(empty);
        return;
      }
      for (const entry of entries) {
        const item = doc.createElement('div');
        item.style.cssText =
          'padding: 8px 10px; cursor: pointer; border-bottom: 1px solid var(--sfdt-color-bg); font-family: ui-monospace, monospace; font-size: 11px; display: flex; justify-content: space-between; align-items: center;';
        
        const contentWrap = doc.createElement('div');
        contentWrap.style.cssText = 'display: flex; align-items: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
        
        const entryMode = entryLang(entry);
        const langBadge = doc.createElement('span');
        langBadge.textContent = entryMode === 'sosl' ? 'SOSL ' : 'SOQL ';
        langBadge.style.cssText =
          'color: var(--sfdt-color-text-weak); font-weight: 600; margin-right: 6px; flex-shrink: 0;';

        const badge = doc.createElement('span');
        badge.textContent = entry.api === 'tooling' ? 'TOOL ' : 'REST ';
        badge.style.cssText =
          entry.api === 'tooling'
            ? 'color: var(--sfdt-color-warning-text); font-weight: 600; margin-right: 6px; flex-shrink: 0;'
            : 'color: var(--sfdt-color-brand-text); font-weight: 600; margin-right: 6px; flex-shrink: 0;';

        const titleText = doc.createElement('strong');
        titleText.textContent = `${entry.name}: `;
        titleText.style.cssText = 'margin-right: 4px; flex-shrink: 0;';

        const qText = doc.createElement('span');
        qText.textContent = entry.q.length > 100 ? entry.q.slice(0, 100) + '…' : entry.q;
        
        contentWrap.appendChild(langBadge);
        contentWrap.appendChild(badge);
        contentWrap.appendChild(titleText);
        contentWrap.appendChild(qText);
        
        item.appendChild(contentWrap);

        const deleteBtn = doc.createElement('button');
        deleteBtn.textContent = '×';
        deleteBtn.style.cssText = 'background: none; border: none; color: var(--sfdt-color-error-text); font-size: 16px; cursor: pointer; padding: 0 4px;';
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
          setLang(entryMode);
          savedQueriesMenu.style.display = 'none';
          textarea.focus();
        });
        savedQueriesMenu.appendChild(item);
      }
    }

    async function execute(): Promise<void> {
      if (busy) return;
      const soql = textarea.value.trim();
      if (!soql) {
        showError('Enter a SOQL query to run.');
        return;
      }
      abortExport(); // a fresh run supersedes any in-flight export
      clearError();
      setBusy(true);
      status.textContent = 'Running…';
      const t0 = Date.now();
      try {
        if (lang === 'sosl') {
          const found = await runSearch(api, soql);
          const elapsed = Date.now() - t0;
          groups = found;
          records = [];
          lastEnvelope = null;
          pagesLoaded = 0;
          const rows = soslRowCount(found);
          status.textContent = `⏱ ${elapsed} ms · ${rows} row${rows === 1 ? '' : 's'} across ${
            found.length
          } object${found.length === 1 ? '' : 's'}`;
          renderGroupedResults();
        } else {
          const envelope = await runQuery(api, soql, mode);
          const elapsed = Date.now() - t0;
          const total = envelope.totalSize ?? envelope.size ?? envelope.records.length;
          groups = [];
          records = [...envelope.records];
          lastEnvelope = envelope;
          pagesLoaded = 1;
          status.textContent = `⏱ ${elapsed} ms · ${records.length}${
            envelope.done ? '' : ` of ${total}+`
          } row${records.length === 1 ? '' : 's'}`;
          renderResults();
        }
        if (historyEnabled) {
          await pushSoqlHistory({ q: soql, api: mode, lang, ts: Date.now() });
        }
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
        status.textContent = '';
      } finally {
        setBusy(false);
      }
    }

    function renderPlan(plans: QueryPlan[]): void {
      while (explainPanel.firstChild) explainPanel.removeChild(explainPanel.firstChild);
      // Hide the results-table + its footer actions: they're bound to the stale
      // result set and would flip the view back to the (now-hidden) table.
      resultsWrap.style.display = 'none';
      loadMoreBtn.style.display = 'none';
      copyCsvBtn.style.display = 'none';
      exportCsvBtn.style.display = 'none';
      exportAllBtn.style.display = 'none';
      cancelExportBtn.style.display = 'none';
      copyJsonBtn.style.display = 'none';
      copyExcelBtn.style.display = 'none';
      langGraphBtn.style.display = 'none';
      if (plans.length === 0) {
        const empty = doc.createElement('div');
        empty.style.cssText = 'padding: 12px; color: var(--sfdt-color-text-icon); font-size: 13px;';
        empty.textContent = 'No query plan returned.';
        explainPanel.appendChild(empty);
        explainPanel.style.display = 'block';
        return;
      }

      const fmtNotes = (notes: QueryPlanNote[] | undefined): string => {
        if (!Array.isArray(notes) || notes.length === 0) return '—';
        return notes
          .map((n) => n.description)
          .filter((d): d is string => typeof d === 'string' && d.length > 0)
          .join('\n') || '—';
      };
      const fmt = (v: unknown): string =>
        v === null || v === undefined ? '—' : String(v);

      plans.forEach((plan, i) => {
        const heading = doc.createElement('div');
        heading.style.cssText =
          'padding: 8px 10px; font-weight: 600; font-size: 12px; color: var(--sfdt-color-text-strong); background: var(--sfdt-color-surface-alt); border-bottom: 1px solid var(--sfdt-color-border);';
        heading.textContent = plan.sobjectType
          ? `Plan ${i + 1} · ${plan.sobjectType}${i === 0 ? ' (chosen)' : ''}`
          : `Plan ${i + 1}${i === 0 ? ' (chosen)' : ''}`;
        explainPanel.appendChild(heading);

        const table = doc.createElement('table');
        table.style.cssText = 'border-collapse: collapse; width: 100%; font-size: 12px;';
        const rows: Array<[string, string]> = [
          ['Cardinality', fmt(plan.cardinality)],
          ['SObject cardinality', fmt(plan.sobjectCardinality)],
          ['Leading operation', fmt(plan.leadingOperationType)],
          ['Relative cost', fmt(plan.relativeCost)],
          ['Notes', fmtNotes(plan.notes)],
        ];
        const tbody = doc.createElement('tbody');
        for (const [label, value] of rows) {
          const tr = doc.createElement('tr');
          const th = doc.createElement('th');
          th.scope = 'row';
          th.textContent = label;
          th.style.cssText =
            'text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--sfdt-color-bg); color: var(--sfdt-color-text-weak); font-weight: 600; white-space: nowrap; vertical-align: top; width: 160px;';
          const td = doc.createElement('td');
          td.textContent = value;
          td.style.cssText =
            'padding: 6px 10px; border-bottom: 1px solid var(--sfdt-color-bg); color: var(--sfdt-color-text-strong); white-space: pre-wrap; vertical-align: top;';
          tr.appendChild(th);
          tr.appendChild(td);
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        explainPanel.appendChild(table);
      });
      explainPanel.style.display = 'block';
    }

    async function explain(): Promise<void> {
      if (busy) return;
      const soql = textarea.value.trim();
      if (!soql) {
        showError('Enter a SOQL query to explain.');
        return;
      }
      abortExport(); // Explain supersedes any in-flight export (shares status/panels)
      clearError();
      setBusy(true);
      status.textContent = 'Explaining…';
      const t0 = Date.now();
      try {
        const plans = await explainQuery(api, soql, mode);
        renderPlan(plans);
        status.textContent = `⏱ ${Date.now() - t0} ms · query plan`;
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
        status.textContent = '';
      } finally {
        setBusy(false);
      }
    }

    async function loadMore(): Promise<void> {
      if (!lastEnvelope?.nextRecordsUrl || lastEnvelope.done) return;
      abortExport(); // loading a page supersedes any in-flight export
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
      // The suggestion engine parses SELECT/FROM/WHERE — SOSL has none of that
      // grammar, so the box is hidden (setLang) and the engine stays idle
      // rather than emitting SOQL suggestions for a FIND query.
      if (lang === 'sosl') {
        autocompleteState = '';
        return;
      }
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
      
      function resultsSort(a: AutocompleteSuggestion, b: AutocompleteSuggestion) {
        return sortRank(a.value, a.title) - sortRank(b.value, b.title) || (a.rank ?? 0) - (b.rank ?? 0) || a.value.localeCompare(b.value);
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

        const suggestions: AutocompleteSuggestion[] = [];
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

      const fieldSuggestions: AutocompleteSuggestion[] = [];
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

    function getIconForSuggestion(type: string, dataType: string | undefined): string {
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

    function renderAutocompleteUI(data: { sobjectName: string; title: string; results: AutocompleteSuggestion[] }) {
      autocompleteTitle.textContent = data.title || '\u00A0';
      
      while (autocompleteResults.firstChild) {
        autocompleteResults.removeChild(autocompleteResults.firstChild);
      }

      if (data.results.length === 0) {
        const none = doc.createElement('span');
        none.style.cssText = 'color: var(--sfdt-color-text-icon); font-size: 12px; font-style: italic;';
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
          'display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border: 1px solid var(--sfdt-color-border); border-radius: 14px; background: var(--sfdt-color-surface); color: var(--sfdt-color-brand-text); font-size: 12px; cursor: pointer; white-space: nowrap; transition: background 0.15s, border-color 0.15s, transform 0.1s; outline: none; margin: 2px 0; font-family: system-ui, sans-serif;';
        
        btn.addEventListener('mouseenter', () => {
          btn.style.background = 'var(--sfdt-color-surface-shade)';
          btn.style.borderColor = 'var(--sfdt-color-brand)';
          btn.style.transform = 'translateY(-1px)';
        });
        btn.addEventListener('mouseleave', () => {
          btn.style.background = 'var(--sfdt-color-surface)';
          btn.style.borderColor = 'var(--sfdt-color-border)';
          btn.style.transform = 'none';
        });
        
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          onAutocompleteClick(item);
        });

        autocompleteResults.appendChild(btn);
      }
    }

    function onAutocompleteClick(item: AutocompleteSuggestion) {
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
    explainBtn.addEventListener('click', () => void explain());
    loadMoreBtn.addEventListener('click', () => void loadMore());
    
    // Wire up autocomplete events (and keep the language toggle in step with
    // whatever the user has typed).
    textarea.addEventListener('input', () => {
      syncLangFromText();
      void runAutocomplete();
    });
    textarea.addEventListener('keyup', (e) => {
      if (e.key !== 'Control' && e.key !== 'Meta' && e.key !== 'Shift' && e.key !== 'Alt') {
        syncLangFromText();
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

    // Copy CSV / Export CSV / Copy JSON / Copy for Excel are wired by
    // createResultActions() above — the same code path the per-object SOSL
    // toolbars use.

    cancelExportBtn.addEventListener('click', () => exportController?.abort());
    exportAllBtn.addEventListener('click', async () => {
      const soql = textarea.value.trim();
      if (!soql) return;
      abortExport(); // never run two exports at once
      const controller = new AbortController();
      exportController = controller;
      // Whether this handler is still the active export — false once a new
      // run/loadMore/error (or a subsequent export) has superseded it. Guards
      // every status/UI write so a stale export can't stomp a newer run.
      const owns = (): boolean => exportController === controller;
      exportAllBtn.disabled = true;
      cancelExportBtn.style.display = 'inline-block';
      const prevStatus = status.textContent;
      status.textContent = 'Exporting all… fetching page 1';
      try {
        const first = await runQuery(api, soql, mode);
        // The worker-proxied page-1 fetch can't be aborted mid-flight; guarantee
        // the data-correctness half — a Cancel during page 1 yields NO download.
        if (!owns()) return; // superseded by a new run/loadMore/explain — stay silent
        if (controller.signal.aborted) {
          showToast('Export canceled', { doc, kind: 'warning' });
          status.textContent = prevStatus;
          return;
        }
        const result = await exportAllToCsv(api, first, {
          signal: controller.signal,
          onProgress: ({ pages, rows }) => {
            if (owns()) {
              status.textContent = `Exporting all… ${rows} row${rows === 1 ? '' : 's'} across ${pages} page${pages === 1 ? '' : 's'}`;
            }
          },
        });
        if (!owns()) return; // superseded — stay silent, superseder owns the UI
        if (result.canceled) {
          showToast('Export canceled', { doc, kind: 'warning' });
          status.textContent = prevStatus;
          return;
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        downloadBlob(doc, `soql-all-${stamp}.csv`, new Blob(result.parts, { type: 'text/csv' }));
        status.textContent = `Exported ${result.rows} row${result.rows === 1 ? '' : 's'} across ${result.pages} page${result.pages === 1 ? '' : 's'}`;
        showToast(`Exported ${result.rows} rows as CSV`, { doc, kind: 'success' });
      } catch (err) {
        if (owns()) {
          showToast(err instanceof Error ? err.message : String(err), { doc, kind: 'error' });
          status.textContent = prevStatus;
        }
      } finally {
        if (owns()) {
          exportAllBtn.disabled = false;
          cancelExportBtn.style.display = 'none';
          exportController = null;
        }
      }
    });
    langGraphBtn.addEventListener('click', async () => {
      const currentSoql = textarea.value.trim();
      const code = generateLangGraphNode(currentSoql, records);
      try {
        await win.navigator.clipboard.writeText(code);
        showToast('LangGraph node copied to clipboard', { doc, kind: 'success' });
      } catch {
        showToast('Could not copy to clipboard', { doc, kind: 'error' });
      }
    });

    doc.addEventListener('keydown', function escHandler(e) {
      if (e.key === 'Escape' && view) {
        close();
        doc.removeEventListener('keydown', escHandler);
      }
    });

    // A Saved SOQL panel selection pre-fills the editor (and the API mode +
    // query language, so a staged SOSL bookmark opens in SOSL mode).
    const pending = await takePendingQuery();
    if (pending) {
      textarea.value = pending.q;
      mode = pending.api;
      lang = entryLang(pending);
    }

    // Expose the live textarea so insertFieldIntoDraft() targets it, and drain
    // any field fragment stashed while the runner was closed.
    activeTextarea = textarea;
    if (pendingFieldFragment) {
      textarea.value = insertFieldIntoQuery(textarea.value, pendingFieldFragment);
      pendingFieldFragment = null;
    }

    textarea.focus();
    setMode(mode);
    setLang(lang);
  }

  return {
    insertFieldIntoDraft,
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
    exportAllToCsv,
    recordsToJson,
    recordsToTsv,
    generateLangGraphNode,
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
    runSearch,
    explainQuery,
    insertFieldIntoQuery,
    isSoslQuery,
    detectQueryLang,
    entryLang,
    searchRecordsFrom,
    groupSearchRecords,
    soslRowCount,
    HISTORY_CAP,
    PAGE_CAP,
  };
}
