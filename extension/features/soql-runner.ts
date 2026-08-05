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
import { isFeatureEnabled, loadSettings, registerSettingsShape } from '../lib/settings.js';
import { recordActivity } from '../lib/activity-log.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { openMenu, type MenuAction } from '../ui/menu.js';
import { clearSfError, renderSfError, setSfError } from '../ui/panels.js';
import { button, setLabel, toolbar } from '../lib/ui-controls.js';
import { createHistory } from '../lib/history.js';
import { copyToClipboard } from '../ui/clipboard.js';
import { createCodeEditor, SOQL_KEYWORDS } from '../lib/code-editor.js';
import { isRecordId } from '../lib/salesforce-id.js';
import { triggerDownload, triggerDownloadBlob } from '../lib/download.js';
import { confirmDialog } from '../ui/confirm-dialog.js';
import {
  SOQL_BULK_DELETE_ID,
  REJECTION_MESSAGES,
  backupCsvCoversPlan,
  backupFilename,
  buildDeleteEndpoint,
  confirmPhrase,
  describePlan,
  formatBulkDeleteReport,
  planBulkDelete,
  rowRecordId,
  runBulkDelete,
  type BulkDeleteOutcome,
  type BulkDeletePlan,
} from './soql-bulk-delete.js';

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

// Shared capped ring (lib/history.ts) — and via lib/storage.ts, so recording a
// query in a tab whose extension was updated underneath it fails quietly.
const soqlHistory = createHistory<HistoryEntry>(HISTORY_STORAGE_KEY, {
  cap: HISTORY_CAP,
  sameAs: (a, b) => a.q === b.q && a.api === b.api && entryLang(a) === entryLang(b),
});

export const readSoqlHistory = (): Promise<HistoryEntry[]> => soqlHistory.read();
export const writeSoqlHistory = (entries: HistoryEntry[]): Promise<void> => soqlHistory.write(entries);
export const pushSoqlHistory = (entry: HistoryEntry): Promise<void> => soqlHistory.push(entry);
export const clearSoqlHistory = (): Promise<void> => soqlHistory.clear();

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

/**
 * The pre-delete backup CSV (C-P4-2, AC-1). Returns the filename it handed to
 * the browser, which the confirm dialog then shows the user.
 *
 * The rows go through the SAME `recordsToCsv` the Export CSV button uses (comma
 * and quote handling included — P1-3), and the file goes out through the SAME
 * `lib/download.ts` every other export uses. A backup written by a second,
 * bespoke serialiser would be a backup that quotes differently from the export
 * the user already trusts, which is the worst possible moment to find that out.
 *
 * WHAT THIS CAN AND CANNOT PROVE. It throws — and so fails `runBulkDelete`'s
 * backup gate, deleting nothing — on the three things it can actually observe:
 *
 *   1. the serialised CSV does not contain every Id in the plan (an empty or
 *      wrong payload; a "download" that succeeded and backed up nothing);
 *   2. the browser refused to mint a blob URL for it;
 *   3. the download helper did not complete the handoff at all.
 *
 * It CANNOT prove the file reached the user's disk. Nothing in the extension
 * can: that needs the `downloads` permission, which is deliberately not in the
 * manifest. So the dialog names the file and asks the user — the only party who
 * can actually check — rather than asserting a guarantee that is not ours to
 * make. Read the dialog copy alongside this function; the two have to agree.
 */
export function downloadDeleteBackup(
  doc: Document,
  plan: BulkDeletePlan,
  now = new Date(),
): string {
  const csv = recordsToCsv(plan.rows);
  // Verify the PAYLOAD, not just that the call returned. Checking the call is
  // how a backup of nothing passes for a backup.
  if (!backupCsvCoversPlan(csv, plan)) {
    throw new Error(
      `The backup CSV did not contain all ${plan.ids.length} row${
        plan.ids.length === 1 ? '' : 's'
      } about to be deleted.`,
    );
  }
  const filename = backupFilename(plan, now);
  const url = triggerDownload(doc, filename, csv, 'text/csv');
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('The browser did not accept the backup CSV for download.');
  }
  return filename;
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
  /**
   * Open the Inspect Record tool for a record Id — backs the row menu's "View
   * all fields". Injected rather than imported so this feature keeps no hard
   * dependency on another feature (same pattern as the Schema Browser's
   * `analyzeFieldImpact`); when absent the row is simply not offered.
   */
  inspectRecord?: (recordId: string) => void | Promise<void>;
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
    // C-P4-2. Its own registry feature, so this is the ordinary feature gate —
    // and it ships `enabledByDefault: false`, so with no stored preference this
    // is FALSE and no delete control is ever built. Read once per open(), the
    // same lifetime as `historyEnabled`: toggling it in Settings takes effect
    // the next time the runner is opened.
    const bulkDeleteEnabled = isFeatureEnabled(settings, SOQL_BULK_DELETE_ID);

    const body = doc.createElement('div');
    body.className = 'sfdt-view-body';
    // Language/transport toggles and the history + saved menus stay pinned:
    // they describe what the editor below IS, and losing them to the scroll on
    // a large result set is exactly when you want to change one.
    const bar = toolbar(doc);
    bar.classList.add('sfdt-wrap');
    // --- SOQL / SOSL language toggle ---
    // A real radiogroup (roles + aria-checked + roving tabindex + arrow keys),
    // because two <button>s styled as a segmented control are otherwise
    // indistinguishable from unrelated buttons to a screen reader
    // (CONVENTIONS.md items 9 and 11).
    const langGroup = doc.createElement('div');
    langGroup.setAttribute('role', 'radiogroup');
    langGroup.setAttribute('aria-label', 'Query language');
    langGroup.className = 'sfdt-segment';
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
      btn.addEventListener('click', () => setLang(value, { explicit: true }));
      // Arrow keys move the selection inside the group, as a radiogroup must.
      // The target is computed from the CURRENT selection, not from the button
      // the key landed on, so it stays correct if focus is ever moved
      // programmatically to the unselected radio.
      btn.addEventListener('keydown', (e) => {
        if (['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
          e.preventDefault();
          setLang(lang === 'soql' ? 'sosl' : 'soql', { focus: true, explicit: true });
        }
      });
      langGroup.appendChild(btn);
    }
    bar.appendChild(langGroup);

    const restBtn = doc.createElement('button');
    const toolingBtn = doc.createElement('button');
    const TRANSPORT_SOSL_TITLE =
      'Not available in SOSL mode — the Search resource is REST-only. Your SOQL choice is restored when you switch back.';

    // The transport actually used for a run. `mode` is the user's SOQL
    // transport CHOICE and is never overwritten by the language toggle; SOSL
    // simply has no Tooling variant of the Search resource, so it runs REST
    // regardless. Keeping the two apart is what lets a Tooling user paste a
    // FIND query and get their Tooling selection back afterwards.
    function effectiveMode(): ApiMode {
      return lang === 'sosl' ? 'rest' : mode;
    }

    // Paint the transport toggle from the effective transport, and mark the
    // whole control unavailable (genuinely disabled, not hidden) in SOSL mode.
    function paintModeToggle(): void {
      const isRest = effectiveMode() === 'rest';
      // Appearance follows aria-pressed via '.sfdt-segment' — the state is
      // declared once, in the DOM, rather than painted a second time inline.
      restBtn.setAttribute('aria-pressed', String(isRest));
      toolingBtn.setAttribute('aria-pressed', String(!isRest));
      const sosl = lang === 'sosl';
      restBtn.disabled = sosl;
      toolingBtn.disabled = sosl;
      restBtn.title = sosl ? TRANSPORT_SOSL_TITLE : '';
      toolingBtn.title = sosl ? TRANSPORT_SOSL_TITLE : '';
    }

    const setMode = (next: ApiMode): void => {
      // The transport control is unavailable in SOSL mode; ignore programmatic
      // or stray activations there rather than silently recording a choice the
      // user can't see taking effect.
      if (lang === 'sosl') return;
      mode = next;
      paintModeToggle();
      void runAutocomplete();
    };
    restBtn.type = 'button';
    toolingBtn.type = 'button';
    restBtn.textContent = 'REST';
    toolingBtn.textContent = 'Tooling';
    restBtn.addEventListener('click', () => setMode('rest'));
    toolingBtn.addEventListener('click', () => setMode('tooling'));
    const modeGroup = doc.createElement('div');
    modeGroup.className = 'sfdt-segment';
    modeGroup.setAttribute('role', 'group');
    modeGroup.setAttribute('aria-label', 'API transport');
    modeGroup.append(restBtn, toolingBtn);
    bar.appendChild(modeGroup);

    // Explicit-choice latch. `langExplicit` records that the user *chose* the
    // current language (clicked the toggle, or restored a stored entry);
    // `langChoiceBaseline` is what the editor text detected as at that moment.
    // Together they encode "this choice holds until the query itself changes
    // language" — see syncLangFromText().
    let langExplicit = false;
    let langChoiceBaseline: QueryLang | null = null;

    // Switch query language. Drives the editor affordances that differ between
    // the two languages: SOSL has no Tooling variant of the Search resource, no
    // query plan (same as the GUI console, which disables Plan for a FIND
    // query), and no SOQL field/object autocomplete.
    function setLang(next: QueryLang, opts: { focus?: boolean; explicit?: boolean } = {}): void {
      lang = next;
      langExplicit = opts.explicit === true;
      langChoiceBaseline = langExplicit ? detectedLang(textarea.value) : null;
      const sosl = next === 'sosl';
      for (const [value, btn] of langButtons) {
        const on = value === next;
        btn.setAttribute('aria-checked', String(on));
        btn.tabIndex = on ? 0 : -1;
        if (opts.focus && on) btn.focus();
      }
      textarea.placeholder = sosl
        ? 'FIND {Acme} IN ALL FIELDS RETURNING Account(Id, Name), Contact(Id, Name)'
        : 'SELECT Id, Name FROM Account LIMIT 10';
      // The accessible name follows the language too. A placeholder is not a
      // name — it disappears the moment anything is typed.
      textarea.setAttribute('aria-label', sosl ? 'SOSL search' : 'SOQL query');
      // The transport control is unavailable in SOSL (no Tooling Search
      // resource) but the user's SOQL choice is preserved, not reset.
      paintModeToggle();
      explainBtn.disabled = sosl;
      explainBtn.title = sosl ? 'Query plans are SOQL-only' : EXPLAIN_TITLE;
      autocompleteBox.style.display = sosl ? 'none' : 'flex';
      void runAutocomplete();
    }

    // What the editor text says the language is, or null when it doesn't say —
    // an empty or half-typed query settles nothing and must not move the toggle.
    function detectedLang(text: string): QueryLang | null {
      if (isSoslQuery(text)) return 'sosl';
      if (/^\s*select\b/i.test(text)) return 'soql';
      return null;
    }

    // Keep the toggle honest when the user types or pastes: a query whose first
    // keyword is FIND is SOSL, a SELECT is SOQL — the same auto-routing the GUI
    // console does.
    //
    // Precedence: an explicit click is a stronger signal than inference, so a
    // chosen mode is NOT reverted by text the user did not just change. The
    // latch only lifts when the query's own language moves away from what it
    // was when the choice was made — e.g. choose SOSL over a leftover SELECT
    // and it sticks through further edits of that SELECT, but pasting a real
    // FIND (or later going back to a SELECT after the choice) hands control
    // back to detection.
    function syncLangFromText(): void {
      const detected = detectedLang(textarea.value);
      if (detected === null) return; // text settles nothing — keep the current mode
      if (langExplicit && detected === langChoiceBaseline) return; // user's choice wins
      if (detected !== lang) setLang(detected);
      else {
        // Detection now agrees with the current mode on its own merits; the
        // latch has done its job and is released.
        langExplicit = false;
        langChoiceBaseline = null;
      }
    }

    let historyMenu: HTMLDivElement | null = null;
    if (historyEnabled) {
      const historyBtn = button({ label: 'History', iconName: 'history', small: true, doc });
      historyBtn.setAttribute('aria-haspopup', 'true');
      historyBtn.setAttribute('aria-expanded', 'false');
      const histWrap = doc.createElement('div');
      histWrap.style.cssText = 'position: relative;';
      histWrap.appendChild(historyBtn);
      historyMenu = doc.createElement('div');
      historyMenu.style.cssText =
        'display: none; position: absolute; top: 100%; left: 0; background: var(--sfdt-color-surface); border: 1px solid var(--sfdt-color-border); border-radius: 4px; min-width: 360px; max-width: 600px; max-height: 280px; overflow-y: auto; z-index: 100021; box-shadow: var(--sfdt-shadow-2);';
      histWrap.appendChild(historyMenu);
      historyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!historyMenu) return;
        if (historyMenu.style.display === 'block') {
          historyMenu.style.display = 'none';
          historyBtn.setAttribute('aria-expanded', 'false');
          return;
        }
        await renderHistoryMenu();
        historyMenu.style.display = 'block';
        historyBtn.setAttribute('aria-expanded', 'true');
      });
      doc.addEventListener('click', (e) => {
        if (historyMenu && !histWrap.contains(e.target as Node)) {
          historyMenu.style.display = 'none';
          historyBtn.setAttribute('aria-expanded', 'false');
        }
      });
      bar.appendChild(histWrap);
    }

    // Saved queries menu
    const savedQueriesBtn = button({ label: 'Bookmarks', iconName: 'star', small: true, doc });
    savedQueriesBtn.setAttribute('aria-haspopup', 'true');
    savedQueriesBtn.setAttribute('aria-expanded', 'false');
    const savedWrap = doc.createElement('div');
    savedWrap.style.cssText = 'position: relative;';
    savedWrap.appendChild(savedQueriesBtn);
    const savedQueriesMenu = doc.createElement('div');
    savedQueriesMenu.style.cssText =
      'display: none; position: absolute; top: 100%; left: 0; background: var(--sfdt-color-surface); border: 1px solid var(--sfdt-color-border); border-radius: 4px; min-width: 360px; max-width: 600px; max-height: 280px; overflow-y: auto; z-index: 100021; box-shadow: var(--sfdt-shadow-2);';
    savedWrap.appendChild(savedQueriesMenu);
    savedQueriesBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (savedQueriesMenu.style.display === 'block') {
        savedQueriesMenu.style.display = 'none';
        savedQueriesBtn.setAttribute('aria-expanded', 'false');
        return;
      }
      await renderSavedQueriesMenu();
      savedQueriesMenu.style.display = 'block';
      savedQueriesBtn.setAttribute('aria-expanded', 'true');
    });
    doc.addEventListener('click', (e) => {
      if (savedQueriesMenu && !savedWrap.contains(e.target as Node)) {
        savedQueriesMenu.style.display = 'none';
        savedQueriesBtn.setAttribute('aria-expanded', 'false');
      }
    });
    bar.appendChild(savedWrap);

    body.appendChild(bar);

    const main = doc.createElement('div');
    main.className = 'sfdt-view-main';
    body.appendChild(main);

    // The line-numbered, highlighted editor rather than a bare <textarea>.
    // `editor.input` IS a real textarea — the caret, selection, undo stack, IME
    // and native find are the browser's, and every call site below (including
    // `setRangeText` for autocomplete) works on it unchanged. What it adds:
    // line numbers for the "Malformed query at line 3" the org reports back, and
    // an accessible name the textarea never had.
    const editor = createCodeEditor({
      ariaLabel: 'SOQL query',
      placeholder: 'SELECT Id, Name FROM Account LIMIT 10',
      keywords: SOQL_KEYWORDS,
      doc,
    });
    const textarea = editor.input;
    main.appendChild(editor.root);

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

    const toggleWrapBtn = button({ label: 'Expand', iconName: 'chevron', small: true, variant: 'ghost', doc });
    toggleWrapBtn.setAttribute('aria-expanded', 'false');
    toggleWrapBtn.addEventListener('click', () => {
      expandAutocomplete = !expandAutocomplete;
      updateResultsWrap();
    });
    autocompleteHeader.appendChild(toggleWrapBtn);
    autocompleteBox.appendChild(autocompleteHeader);

    const autocompleteResults = doc.createElement('div');
    autocompleteResults.className = 'sfdt-chiprow';
    autocompleteBox.appendChild(autocompleteResults);

    main.appendChild(autocompleteBox);

    const runRow = doc.createElement('div');
    runRow.classList.add('sfdt-row', 'sfdt-snug');
    const runBtn = button({ label: 'Run', iconName: 'play', variant: 'primary', doc });
    const explainBtn = button({ label: 'Explain', iconName: 'chart', title: EXPLAIN_TITLE, doc });
    const bookmarkBtn = button({ label: 'Save', iconName: 'star', doc });
    bookmarkBtn.addEventListener('click', async () => {
      const q = textarea.value.trim();
      if (!q) {
        showToast('Enter a query to bookmark first', { doc, kind: 'warning' });
        return;
      }
      const name = win.prompt('Enter a name for this bookmark:', 'My Saved Query');
      if (name) {
        await pushSavedQuery({ name, q, api: effectiveMode(), lang });
        showToast('Query bookmarked successfully', { doc, kind: 'success' });
      }
    });
    const status = doc.createElement('span');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.className = 'sfdt-muted';
    runRow.appendChild(runBtn);
    runRow.appendChild(explainBtn);
    runRow.appendChild(bookmarkBtn);
    runRow.appendChild(status);
    main.appendChild(runRow);

    const errorPanel = renderSfError(null, { doc });
    errorPanel.style.display = 'none';
    main.appendChild(errorPanel);

    // Bulk-delete outcome (C-P4-2). Its own container rather than reusing
    // `errorPanel`: a partial delete is not a query error, and showError()
    // hides the results table — which is the last thing you want to lose while
    // reading which of its rows failed to delete. Empty and hidden until a
    // delete has actually run; the block inside is built by ui/panels.ts.
    const deleteReport = doc.createElement('div');
    deleteReport.style.display = 'none';
    main.appendChild(deleteReport);

    // Query-plan (EXPLAIN) output panel — separate from the results table so a
    // plan and a result set don't clobber each other.
    const explainPanel = doc.createElement('div');
    explainPanel.classList.add('sfdt-frame');
    explainPanel.style.display = 'none';
    main.appendChild(explainPanel);

    const resultsWrap = doc.createElement('div');
    resultsWrap.classList.add('sfdt-frame');
    resultsWrap.style.display = 'none';
    main.appendChild(resultsWrap);

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

    // ---- Bulk delete (C-P4-2) --------------------------------------------
    //
    // One delete at a time, and always stoppable. `deleteInFlight` covers the
    // whole operation including the dialog (so a second group's Delete button
    // cannot start a parallel run over the same status line); `deleteController`
    // is the live run's abort handle, checked by runBulkDelete between waves and
    // tripped by the Cancel button, by closing the view, and by a fresh query.
    let deleteInFlight = false;
    let deleteController: AbortController | null = null;

    const cancelDeleteBtn = button({
      label: 'Cancel',
      ariaLabel: 'Stop deleting',
      iconName: 'close',
      variant: 'danger',
      small: true,
      doc,
      onClick: () => deleteController?.abort(),
    });
    cancelDeleteBtn.style.display = 'none';

    /**
     * Stop an in-flight delete between waves.
     *
     * A confirmed delete used to have no brake at all: the signal existed and
     * was tested, but nothing ever passed one. Rows already sent are gone —
     * this stops the NEXT wave, which on a few thousand rows is most of them.
     */
    function abortBulkDelete(): void {
      deleteController?.abort();
    }
    //
    // Every gate lives in features/soql-bulk-delete.ts; this half is only the
    // wiring — a backup that reuses recordsToCsv + lib/download.ts, a confirm
    // that is ui/confirm-dialog.ts's typed gate, one DELETE per row through the
    // worker proxy, and a report built by ui/panels.ts. There is deliberately
    // no `api.apiRequest('DELETE', …)` anywhere else in this file: the only
    // caller is the `deleteRecord` dep below, and `runBulkDelete` is the only
    // thing that calls that.

    function clearDeleteReport(): void {
      while (deleteReport.firstChild) deleteReport.removeChild(deleteReport.firstChild);
      deleteReport.style.display = 'none';
    }

    function showDeleteReport(text: string): void {
      clearDeleteReport();
      // C-FIX-4's shared renderer, not a hand-rolled console block: it carries
      // role="alert" so the report is announced, and it puts every line of a
      // multi-line message in its own node — which is exactly the shape of a
      // per-row failure report (a summary line, then one line per failed Id).
      deleteReport.appendChild(renderSfError(text, { doc }));
      deleteReport.style.display = 'block';
    }

    /**
     * Show/label a delete button from the CURRENT rows, and answer whether it
     * should be offered at all.
     *
     * The label is the AC-1 preview: `Delete 12 rows` on the button itself, so
     * the count is on screen before anything is clicked, and again inside the
     * typed phrase. Hidden entirely when the rows do not qualify (no Id column
     * is the common case) rather than shown-and-disabled — a greyed Delete on a
     * result set that can never be deleted is just noise.
     */
    function paintDeleteButton(
      btn: HTMLButtonElement | null,
      rows: ReadonlyArray<Record<string, unknown>>,
      sobject?: string,
    ): void {
      if (!btn) return;
      const planned = planBulkDelete(rows, { sobject });
      if (!planned.ok) {
        btn.style.display = 'none';
        return;
      }
      const n = planned.plan.ids.length;
      setLabel(btn, `Delete ${n} row${n === 1 ? '' : 's'}`);
      btn.setAttribute('aria-label', `Delete ${describePlan(planned.plan)}`);
      btn.title =
        `Downloads a backup CSV of the ${n} row${n === 1 ? '' : 's'}, then asks you to type ` +
        `"${confirmPhrase(planned.plan)}" before deleting.`;
      btn.style.display = 'inline-block';
    }

    function reportDeleteOutcome(outcome: BulkDeleteOutcome, prevStatus: string | null): void {
      if (outcome.status === 'ineligible') {
        showToast(REJECTION_MESSAGES[outcome.reason], { doc, kind: 'warning' });
        status.textContent = prevStatus;
        return;
      }
      if (outcome.status === 'backup-failed') {
        // The one failure worth a panel even though nothing happened: the user
        // asked for a destructive thing and has to know it did NOT run.
        showDeleteReport(`${outcome.message}\nNo records were deleted.`);
        showToast('Backup failed — nothing was deleted.', { doc, kind: 'error' });
        status.textContent = prevStatus;
        return;
      }
      if (outcome.status === 'not-confirmed') {
        // Cancelled at the dialog. Silent by design — the user just said no.
        status.textContent = prevStatus;
        return;
      }
      const report = formatBulkDeleteReport(outcome);
      status.textContent =
        `Deleted ${outcome.deleted} of ${outcome.total} · re-run the query to refresh the table`;
      if (outcome.failures.length > 0) {
        showDeleteReport(report);
        showToast(`${outcome.failures.length} row(s) failed to delete`, { doc, kind: 'error' });
      } else {
        showToast(`Deleted ${outcome.deleted} ${outcome.sobject} record(s)`, {
          doc,
          kind: 'success',
        });
      }
      void recordActivity({
        featureId: SOQL_BULK_DELETE_ID,
        action: 'Bulk delete',
        resource: `${outcome.sobject} × ${outcome.total}`,
        status: outcome.failures.length > 0 ? 'failed' : 'success',
      });
    }

    async function startBulkDelete(
      btn: HTMLButtonElement,
      getRecords: () => ReadonlyArray<Record<string, unknown>>,
      /** Drop the confirmed-deleted rows from the backing set and re-render. */
      pruneDeleted: (ids: ReadonlySet<string>) => void,
      sobject?: string,
    ): Promise<void> {
      // Re-entrancy guard, and the reason the trigger is NOT disabled here.
      // It also serialises the SOSL groups: each object group has its own
      // Delete button over the same `status` line and the same report panel, so
      // two running at once would interleave progress and leave whichever
      // finished last owning a report about the other one's rows.
      if (deleteInFlight) return;
      const rows = getRecords();
      // Preview first so an ineligible set never opens a dialog at all. The
      // authoritative check is still inside runBulkDelete — this one only
      // decides whether it is worth starting.
      const preview = planBulkDelete(rows, { sobject });
      if (!preview.ok) {
        showToast(REJECTION_MESSAGES[preview.reason], { doc, kind: 'warning' });
        return;
      }
      deleteInFlight = true;
      clearDeleteReport();
      clearError();
      const prevStatus = status.textContent;
      // Snapshot the transport at click time: a delete has to go to the same
      // API the rows came from, and the toggle stays live while the dialog is up.
      const transport = effectiveMode();
      const controller = new AbortController();
      deleteController = controller;
      // The filename the backup actually went out under, captured from the
      // backup gate so the confirm dialog can name it. Empty until gate 2 has
      // run, which is exactly the ordering the dialog copy depends on.
      let backupName = '';
      try {
        const outcome = await runBulkDelete(rows, {
          sobject,
          signal: controller.signal,
          // GATE: the backup. Only `true` proceeds. downloadDeleteBackup throws
          // — which runBulkDelete turns into 'backup-failed', deleting nothing —
          // when the CSV does not contain every Id in the plan, when the browser
          // will not mint a blob URL for it, or when the handoff did not happen.
          // It cannot prove the file reached disk; see its doc comment and the
          // dialog copy below, which are deliberately worded to match.
          backup: (plan) => {
            backupName = downloadDeleteBackup(doc, plan);
            return true;
          },
          // GATE: the typed confirm. ui/confirm-dialog.ts owns the focus trap,
          // Esc-cancels-never-confirms, focus restore, and the typed gate that
          // keeps the Confirm button disabled until the phrase matches exactly.
          //
          // The copy states only what the extension can actually observe, and
          // names the file so the user — the only party who CAN check whether it
          // reached disk — is able to. It also says what the backup contains,
          // because a CSV of the columns you happened to SELECT restores those
          // columns and no others.
          confirm: (plan, phrase) =>
            confirmDialog({
              doc,
              title: `Delete ${describePlan(plan)}?`,
              message:
                `This permanently deletes ${describePlan(plan)} from your org and cannot be ` +
                `undone.\n\nA backup CSV was generated and handed to your browser as ` +
                `"${backupName}". SFDT cannot confirm it reached your disk — check your ` +
                `downloads before continuing. It holds only the columns this query selected, ` +
                `so restoring from it restores those columns and no others.\n\n` +
                `Type ${phrase} to confirm.`,
              details: previewIds(plan),
              confirmLabel: `Delete ${describePlan(plan)}`,
              requireTyped: phrase,
            }),
          // Both gates are behind us; the destructive phase starts now.
          //
          // This is where the trigger goes disabled, NOT at click time. A
          // disabled element cannot receive focus, so disabling it before the
          // dialog opens makes the dialog's focus-restore land on <body> and
          // strands the keyboard user (ui/confirm-dialog.ts documents the
          // contract; test/confirm-dialog.test.ts pins it). Re-entrancy in the
          // meantime is covered by `deleteInFlight` above, and in any case the
          // modal's own scrim and focus trap make the trigger unreachable.
          onConfirmed: () => {
            btn.disabled = true;
            cancelDeleteBtn.style.display = 'inline-block';
          },
          deleteRecord: (id, plan) =>
            api.apiRequest(
              'DELETE',
              buildDeleteEndpoint(api.apiVersion, plan.sobject, id, transport),
            ),
          onProgress: ({ deleted, failed, total }) => {
            status.textContent = `Deleting… ${deleted + failed} of ${total}${
              failed > 0 ? ` · ${failed} failed` : ''
            }`;
          },
        });
        reportDeleteOutcome(outcome, prevStatus);
        if (outcome.status === 'done' && outcome.deletedIds.length > 0) {
          // Drop exactly the rows the org confirmed gone and re-render. Leaving
          // them on screen is not cosmetic: the Delete button would recount
          // them and re-issue DELETEs against Ids that no longer exist. Rows
          // that FAILED — including the timed-out ones, whose outcome is
          // unknown — deliberately stay, because they are what you re-check.
          pruneDeleted(new Set(outcome.deletedIds));
          // The trigger may have been re-rendered away (all rows gone, or the
          // SOSL group's toolbar rebuilt). Focus was correctly restored to it
          // when the dialog closed, so if it is no longer reachable, hand the
          // keyboard user the view's primary control rather than <body>.
          if (!btn.isConnected || btn.style.display === 'none') runBtn.focus();
        }
      } finally {
        btn.disabled = false;
        cancelDeleteBtn.style.display = 'none';
        if (deleteController === controller) deleteController = null;
        deleteInFlight = false;
      }
    }

    /** First few Ids for the dialog's detail list — enough to recognise, not a dump. */
    function previewIds(plan: BulkDeletePlan): string[] {
      const CAP = 5;
      const shown = plan.ids.slice(0, CAP).map(String);
      const rest = plan.ids.length - shown.length;
      return rest > 0 ? [...shown, `…and ${rest} more`] : shown;
    }

    /**
     * The shared result toolbar: Copy CSV / Export CSV / Copy JSON / Copy for
     * Excel over a record set — plus, when C-P4-2 is switched on and the rows
     * qualify, Delete rows. ONE definition, used twice — once for the flat
     * SOQL result set in the footer, and once per SOSL object group, so
     * copy/export apply per group without a second toolbar or a second
     * serialiser (the P1-3 `recordsToCsv`/`recordsToJson`/`recordsToTsv` are
     * the only serialisers in either path).
     *
     * `scope` names the record set for accessible labels and toasts ("Copy
     * Account rows as CSV") — the visible button text stays identical in both
     * places so the toolbar reads the same wherever it appears. `sobject` names
     * the object for row sets that don't carry `attributes` (the SOSL groups
     * strip it), and is what the delete plan uses instead of guessing.
     */
    function createResultActions(opts: {
      getRecords: () => Array<Record<string, unknown>>;
      filePrefix: string;
      scope?: string;
      sobject?: string;
      /**
       * Remove the rows a completed delete confirmed gone, then re-render.
       * Only needed by a toolbar that offers Delete; omitted elsewhere.
       */
      pruneDeleted?: (ids: ReadonlySet<string>) => void;
    }): {
      copyCsv: HTMLButtonElement;
      exportCsv: HTMLButtonElement;
      copyJson: HTMLButtonElement;
      copyExcel: HTMLButtonElement;
      /** null whenever the feature is switched off — the control is never built. */
      deleteRows: HTMLButtonElement | null;
      all: HTMLButtonElement[];
    } {
      const { getRecords, filePrefix, scope } = opts;
      const of = scope ? `${scope} ` : '';
      const mk = (
        label: string,
        ariaLabel: string,
        iconName: string,
        onClick: () => void | Promise<void>,
      ): HTMLButtonElement =>
        button({ label, ariaLabel, iconName, small: true, doc, onClick: () => void onClick() });
      const copyText = async (text: string, what: string): Promise<void> => {
        const n = getRecords().length;
        await copyToClipboard(text, { doc, win: win, label: `${n} ${of}row${n === 1 ? '' : 's'} ${what}` });
      };
      const copyCsv = mk('Copy CSV', `Copy ${of}rows as CSV`, 'clipboard', () =>
        copyText(recordsToCsv(getRecords()), 'as CSV'));
      const exportCsv = mk('Export CSV', `Download ${of}rows as a CSV file`, 'export', () => {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        triggerDownload(doc, `${filePrefix}-${stamp}.csv`, recordsToCsv(getRecords()), 'text/csv');
      });
      const copyJson = mk('Copy JSON', `Copy ${of}rows as JSON`, 'code', () =>
        copyText(recordsToJson(getRecords()), 'as JSON'));
      const copyExcel = mk('Copy for Excel', `Copy ${of}rows for Excel`, 'table', () =>
        copyText(recordsToTsv(getRecords()), 'for Excel'));

      // Built ONLY when the feature is enabled. Not built-then-hidden: a hidden
      // button is one `style.display` away from being clickable, and this one
      // deletes data. Off ⇒ the control does not exist in the DOM.
      let deleteRows: HTMLButtonElement | null = null;
      if (bulkDeleteEnabled) {
        const btn: HTMLButtonElement = button({
          label: 'Delete rows',
          ariaLabel: `Delete ${of}rows`,
          iconName: 'trash',
          variant: 'danger',
          small: true,
          doc,
          onClick: () =>
            void startBulkDelete(
              btn,
              getRecords,
              opts.pruneDeleted ?? (() => {}),
              opts.sobject,
            ),
        });
        deleteRows = btn;
      }

      const all = [copyCsv, exportCsv, copyJson, copyExcel];
      if (deleteRows) all.push(deleteRows);
      return { copyCsv, exportCsv, copyJson, copyExcel, deleteRows, all };
    }

    const mainActions = createResultActions({
      getRecords: () => records,
      filePrefix: 'soql',
      pruneDeleted: (ids) => {
        records = records.filter((row) => {
          const id = rowRecordId(row);
          return id === null || !ids.has(id);
        });
        renderResults();
      },
    });
    const {
      copyCsv: copyCsvBtn,
      exportCsv: exportCsvBtn,
      copyJson: copyJsonBtn,
      copyExcel: copyExcelBtn,
      deleteRows: deleteRowsBtn,
    } = mainActions;
    for (const btn of mainActions.all) btn.style.display = 'none';

    const footer = toolbar(doc, true);
    const loadMoreBtn = button({ label: 'Load more', iconName: 'chevron', small: true, doc });
    loadMoreBtn.style.display = 'none';
    const exportAllBtn = button({
      label: 'Export all as CSV',
      iconName: 'export',
      title: 'Follow pagination to the end and download every row',
      small: true,
      doc,
    });
    exportAllBtn.style.display = 'none';
    const cancelExportBtn = button({
      label: 'Cancel',
      ariaLabel: 'Cancel export',
      iconName: 'close',
      variant: 'danger',
      small: true,
      doc,
    });
    cancelExportBtn.style.display = 'none';
    const langGraphBtn = button({ label: 'LangGraph Node', iconName: 'graph', small: true, doc });
    langGraphBtn.style.display = 'none';
    footer.appendChild(loadMoreBtn);
    footer.appendChild(copyCsvBtn);
    footer.appendChild(exportCsvBtn);
    footer.appendChild(exportAllBtn);
    footer.appendChild(cancelExportBtn);
    footer.appendChild(copyJsonBtn);
    footer.appendChild(copyExcelBtn);
    footer.appendChild(langGraphBtn);
    // Last of the row-scoped actions, after every read-only one — the
    // destructive control should never be the button next to your thumb.
    if (deleteRowsBtn) {
      footer.appendChild(deleteRowsBtn);
      footer.appendChild(cancelDeleteBtn);
    }

    if (historyEnabled) {
      const clearHistBtn = button({
        label: 'Clear history',
        iconName: 'trash',
        variant: 'danger',
        small: true,
        doc,
        onClick: () => {
          void (async () => {
            await clearSoqlHistory();
            showToast('Query history cleared', { doc, kind: 'success' });
          })();
        },
      });
      clearHistBtn.classList.add('sfdt-toolbar-end');
      footer.appendChild(clearHistBtn);
    }
    body.appendChild(footer);

    view = presentView({
      title: 'SOQL Query Runner',
      iconName: 'database',
      body,
      doc,
      width: '860px',
      onClose: () => {
        view = null;
        activeTextarea = null;
        unsubscribeDescribe();
        // Closing the runner is the other way to stop a delete: the progress
        // line and the failure report both live in a view that no longer
        // exists, so continuing would destroy rows with nowhere to report it.
        abortBulkDelete();
      },
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
        ...(deleteRowsBtn ? [deleteRowsBtn] : []),
      ]) {
        btn.style.display = 'none';
      }
    }

    // `unknown`, not `string`: a failure from the API client carries the
    // org's text and our appended guidance separately on `.userFacing`, and
    // `err.message` at the call site flattens the two back together.
    function showError(message: unknown): void {
      abortExport();
      setSfError(errorPanel, message, { doc });
      errorPanel.style.display = 'block';
      resultsWrap.style.display = 'none';
      explainPanel.style.display = 'none';
      hideResultActions();
    }

    function clearError(): void {
      clearSfError(errorPanel);
      errorPanel.style.display = 'none';
    }

    // Record-Id row menu. Rebuilt on ui/menu.ts: the previous version rendered
    // <div> rows (no keyboard path), used emoji labels, and registered a
    // document click listener on every open that was only removed on
    // outside-click — so choosing an item leaked it, once per Id ever clicked.
    function showCellMenu(element: HTMLElement, id: string) {
      const items: MenuAction[] = [
        {
          label: 'Copy Id',
          iconName: 'clipboard',
          onSelect: async () => {
            await copyToClipboard(id, { doc, win, label: 'Id' });
            showToast('Id copied to clipboard', { doc, kind: 'success' });
          },
        },
        {
          label: 'Query this record',
          iconName: 'database',
          onSelect: () => {
            const fromMatch = /from\s+([a-z0-9_]+)/i.exec(textarea.value);
            const sobj = fromMatch ? fromMatch[1] : 'SObject';
            editor.setValue(`SELECT Id FROM ${sobj} WHERE Id = '${id}'`);
            textarea.focus();
            void runAutocomplete();
          },
        },
      ];

      // Only offered when the host wired the Inspect Record tool in — the
      // Workspace does; a bare feature instance (tests, an unwired surface)
      // simply doesn't show a row that would do nothing.
      if (options.inspectRecord) {
        items.push({
          label: 'View all fields',
          iconName: 'record',
          onSelect: () => void options.inspectRecord?.(id),
        });
      }

      items.push({
        label: 'Open in Salesforce',
        iconName: 'external',
        separatorBefore: true,
        onSelect: () => {
          win.open(`https://${win.location.host}/${id}`, '_blank', 'noopener');
        },
      });

      openMenu({ anchor: element, items, label: `Actions for ${id}`, doc, win });
    }

    function emptyNote(text: string): HTMLDivElement {
      const empty = doc.createElement('div');
      empty.classList.add('sfdt-prose', 'sfdt-muted');
      empty.textContent = text;
      return empty;
    }

    // Build the result table for a record set. Shared by the flat SOQL view and
    // each SOSL object group so the two never drift (record-Id cells, the
    // 200-char cell clamp, and the sticky header behave identically).
    function buildRecordsTable(rows: ReadonlyArray<Record<string, unknown>>): HTMLTableElement {
      const cols = columnsFromRecords(rows);
      const table = doc.createElement('table');
      // .sfdt-table supplies the header band, row rules and hover; only the
      // sticky header (specific to this scrolling result pane) is added here.
      table.className = 'sfdt-table';
      const thead = doc.createElement('thead');
      const headRow = doc.createElement('tr');
      for (const c of cols) {
        const th = doc.createElement('th');
        th.textContent = c;
        // Sticky is the one thing the shared table does not own — it only
        // makes sense inside a scrolling results pane.
        th.style.cssText = 'position: sticky; top: 0; z-index: 1;';
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
            // A <button>, not an <a href="#">: it opens a menu rather than
            // navigating, and the fake href made it a keyboard trap that looked
            // like a link and went nowhere.
            const link = doc.createElement('button');
            link.type = 'button';
            link.textContent = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
            link.setAttribute('aria-haspopup', 'menu');
            link.setAttribute('aria-label', `Actions for ${raw}`);
            link.style.cssText =
              'border: 0; background: none; padding: 0; font: var(--sfdt-type-code-sm); color: var(--sfdt-color-brand-text); text-decoration: underline; cursor: pointer;';
            link.addEventListener('click', () => showCellMenu(link, raw));
            td.appendChild(link);
          } else {
            td.textContent = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
          }
          td.title = raw;
          td.classList.add('sfdt-align-top');
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
      // Only offered when these rows actually carry Ids (AC-1). Re-evaluated on
      // every render, so a Load-more that adds rows re-counts the preview and a
      // query without Id takes the button away again.
      paintDeleteButton(deleteRowsBtn, records);
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
        section.classList.add('sfdt-divider');
        const head = doc.createElement('div');
        head.style.cssText =
          'display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px 10px; background: var(--sfdt-color-surface-alt); border-bottom: 1px solid var(--sfdt-color-border);';
        const heading = doc.createElement('h3');
        const n = group.records.length;
        heading.textContent = `${group.sobject} · ${n} row${n === 1 ? '' : 's'}`;
        heading.classList.add('sfdt-subhead');
        head.appendChild(heading);
        const spacer = doc.createElement('span');
        spacer.style.cssText = 'flex: 1;';
        head.appendChild(spacer);
        const groupActions = createResultActions({
          // The sObject name is org-supplied and reaches a download filename
          // here — real API names are already [A-Za-z0-9_], so this only ever
          // bites on a malformed describe, but the filename is not the place to
          // find that out.
          filePrefix: `sosl-${group.sobject.replace(/[^A-Za-z0-9_]+/g, '_')}`,
          getRecords: () => group.records,
          scope: group.sobject,
          // SOSL rows have their `attributes` envelope stripped by
          // groupSearchRecords, so the group's own heading is the only place
          // the object name survives. Without this the delete plan would refuse
          // the rows as 'unknown-object' rather than guess.
          sobject: group.sobject,
          pruneDeleted: (ids) => {
            group.records = group.records.filter((row) => {
              const id = rowRecordId(row);
              return id === null || !ids.has(id);
            });
            // Drop a group with nothing left rather than render an object
            // heading over an empty table.
            groups = groups.filter((g) => g.records.length > 0);
            renderGroupedResults();
          },
        });
        for (const btn of groupActions.all) head.appendChild(btn);
        paintDeleteButton(groupActions.deleteRows, group.records, group.sobject);
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
        empty.classList.add('sfdt-prose', 'sfdt-muted');
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
          editor.setValue(entry.q);
          // Language first (it decides whether the transport control is even
          // available), then the recorded transport for a SOQL entry. A SOSL
          // entry leaves the user's SOQL transport choice untouched — it ran on
          // REST because SOSL always does, not because they chose REST.
          setLang(entryMode, { explicit: true });
          if (entryMode === 'soql') setMode(entry.api);
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
        empty.classList.add('sfdt-prose', 'sfdt-muted');
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

        // Was a bare '×' with no accessible name — button() will not build one.
        const deleteBtn = button({
          iconName: 'trash',
          ariaLabel: `Delete bookmark ${entry.name}`,
          variant: 'danger',
          small: true,
          doc,
        });
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
          editor.setValue(entry.q);
          setLang(entryMode, { explicit: true });
          if (entryMode === 'soql') setMode(entry.api);
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
      // …and so does it supersede an in-flight delete: the new result set will
      // replace the rows the delete is working through, and a progress line for
      // rows that are no longer on screen is worse than no progress line.
      abortBulkDelete();
      clearError();
      // The previous delete's report describes rows that are about to be
      // replaced; leaving it up next to a fresh result set reads as if the new
      // rows failed.
      clearDeleteReport();
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
          const envelope = await runQuery(api, soql, effectiveMode());
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
          await pushSoqlHistory({ q: soql, api: effectiveMode(), lang, ts: Date.now() });
        }
        void recordActivity({
          featureId: 'soql-runner',
          action: lang === 'sosl' ? 'SOSL Search' : 'SOQL Query',
          resource: soql,
          status: 'success',
        });
      } catch (err) {
        void recordActivity({
          featureId: 'soql-runner',
          action: lang === 'sosl' ? 'SOSL Search' : 'SOQL Query',
          resource: soql,
          status: 'failed',
        });
        showError(err);
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
      // Same reason as the rest: a Delete bound to a result set that is no
      // longer on screen is the worst possible stale button.
      if (deleteRowsBtn) deleteRowsBtn.style.display = 'none';
      if (plans.length === 0) {
        const empty = doc.createElement('div');
        empty.classList.add('sfdt-prose', 'sfdt-muted');
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
        table.classList.add('sfdt-table');
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
        const plans = await explainQuery(api, soql, effectiveMode());
        renderPlan(plans);
        status.textContent = `⏱ ${Date.now() - t0} ms · query plan`;
      } catch (err) {
        showError(err);
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
        showError(err);
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
            title: globalDesc.error
              ? `Loading SObjects failed: ${globalDesc.error}`
              : 'Loading SObjects failed. Click to retry.',
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
          title: sobjectDesc.error
            ? `Loading ${sobjectName} metadata failed: ${sobjectDesc.error}`
            : `Loading ${sobjectName} metadata failed. Click to retry.`,
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
      // Why the last relationship-target describe failed, so the autocomplete
      // can say more than "failed" when a lookup's target object is unreadable
      // (the usual cause: the user has no access to the referenced object).
      let describeError = '';

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
                  if (res.status === 'error' && res.error) describeError = res.error;
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
            title: describeError
              ? `Loading ${sobjectStatuses.get('error')} metadata failed: ${describeError}`
              : `Loading ${sobjectStatuses.get('error')} metadata failed. Click to retry.`,
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
          // setRangeText mutates the value without firing 'input', so the
          // highlight and gutter have to be told.
          editor.refresh();
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

    // Suggestion chips carry no type LABEL — the glyph is the only thing that
    // separates an object from a field from a picklist value in a dense row —
    // so unlike the Inspect Record type column this map earns its keep. It
    // returns an icon NAME (lib/icons.ts), not an emoji: an emoji renders at the
    // platform font's mercy and was the loudest "this is old" tell in the UI.
    function getIconForSuggestion(type: string, dataType: string | undefined): string {
      if (type === 'object') return 'metadata';
      if (type === 'relationshipName') return 'link';
      if (type === 'variable') return 'settings';
      if (type === 'picklistValue') return 'logs';
      if (type === 'boolean') return 'check';
      if (type === 'null') return 'close';
      if (type === 'fieldValue') return 'tag';

      if (type === 'fieldName') {
        switch (dataType?.toLowerCase()) {
          case 'id': return 'record';
          case 'reference': return 'link';
          case 'string':
          case 'textarea': return 'tag';
          case 'int':
          case 'double':
          case 'long':
          case 'currency':
          case 'percent': return 'chart';
          case 'boolean': return 'check';
          case 'date':
          case 'datetime': return 'clock';
          case 'picklist':
          case 'multipicklist': return 'logs';
          case 'phone': return 'user';
          case 'url': return 'external';
          case 'email': return 'export';
          default: return 'code';
        }
      }
      return 'code';
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
        // Hover/leave used to be two JS listeners repainting three inline
        // properties per chip; '.sfdt-btn:hover' does it for free, and a chip
        // row can be hundreds of elements.
        const btn = button({
          label: item.value,
          iconName: getIconForSuggestion(item.autocompleteType, item.dataType),
          title: item.title,
          small: true,
          doc,
        });
        btn.classList.add('sfdt-round');
        btn.classList.add('sfdt-nowrap');
        
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
      // Both branches above mutate the value without an 'input' event.
      editor.refresh();

      void runAutocomplete();
    }

    function updateResultsWrap() {
      // One class toggle rather than four style writes per branch — the two
      // layouts now sit next to each other in the sheet instead of being
      // reconstructable only by reading both halves of this if.
      autocompleteResults.classList.toggle('sfdt-chiprow-wrap', expandAutocomplete);
      if (expandAutocomplete) {
        setLabel(toggleWrapBtn, 'Collapse');
        toggleWrapBtn.setAttribute('aria-expanded', 'true');
      } else {
        setLabel(toggleWrapBtn, 'Expand');
        toggleWrapBtn.setAttribute('aria-expanded', 'false');
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
        const first = await runQuery(api, soql, effectiveMode());
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
        triggerDownloadBlob(
          doc,
          `soql-all-${stamp}.csv`,
          new Blob(result.parts, { type: 'text/csv' }),
          'text/csv',
        );
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
      await copyToClipboard(code, { doc, win: win, label: 'LangGraph node copied to clipboard' });
    });

    // Esc is the modal shell's (presentAsModal), which only closes the overlay
    // on top. This used to be a doc-level handler here, registered before the
    // inspector's — so Escape from an Inspect Record opened over the runner
    // closed the RUNNER, discarding the query, and left the inspector standing.
    // In the Workspace this deliberately does nothing: a tab is closed by its ×,
    // never by a stray keystroke.

    // A Saved SOQL panel selection pre-fills the editor (and the API mode +
    // query language, so a staged SOSL bookmark opens in SOSL mode).
    const pending = await takePendingQuery();
    if (pending) {
      editor.setValue(pending.q);
      mode = pending.api;
      lang = entryLang(pending);
    }

    // Expose the live textarea so insertFieldIntoDraft() targets it, and drain
    // any field fragment stashed while the runner was closed.
    activeTextarea = textarea;
    if (pendingFieldFragment) {
      editor.setValue(insertFieldIntoQuery(textarea.value, pendingFieldFragment));
      pendingFieldFragment = null;
    }

    textarea.focus();
    // setLang paints the transport toggle too (and marks it unavailable when
    // the staged entry is SOSL), so this one call establishes both controls.
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
    downloadDeleteBackup,
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
