// Clone of the "Show API Name" Web Store extension, rebuilt on sfdt's
// feature/registry/api infrastructure. Annotates Lightning record detail
// pages with each field's API name (layout-describe driven, so duplicate
// labels resolve in layout order), appends the object API name + 18-char id
// to the record header, and offers copy helpers (18-char Id, Apex insert,
// record SOQL) from a small panel.
// ponytail: Lightning record pages only — Classic (.labelCol/.pageType)
// selectors deferred until someone asks.

import { CONTEXTS, extractRecordContext } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { loadSettings, onSettingsChange, patchSettings, registerSettingsShape } from '../lib/settings.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { z } from 'zod';

// The display toggle lives in featureSettings — deliberately NOT
// settings.features['show-api-names'], which would hide the side-button menu
// item (and with it the copy helpers) whenever the annotations are off.
const SHOW_API_NAMES_SETTINGS_SCHEMA = z.object({
  showApiNames: z.boolean().default(false),
});

registerSettingsShape('show-api-names', SHOW_API_NAMES_SETTINGS_SCHEMA);

const MARKER_CLASS = 'sfdt-api-name';
const FIELD_LABEL_SELECTOR = '.test-id__field-label-container.slds-form-element__label';
const HEADER_SELECTOR = '.entityNameTitle';
const DEFAULT_RECORD_TYPE_ID = '012000000000000AAA';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Standard Salesforce 15→18 char id: one checksum char per 5-char block, a
 * bit per uppercase letter, mapped through the base-32 alphabet. */
export function getLongId(id: string): string {
  if (!id || id.length < 15) return '';
  const short = id.substring(0, 15);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
  let suffix = '';
  for (let block = 0; block < 3; block++) {
    let bits = 0;
    for (let position = 0; position < 5; position++) {
      const ch = short.charAt(block * 5 + position);
      if (ch >= 'A' && ch <= 'Z') bits += 1 << position;
    }
    suffix += alphabet.charAt(bits);
  }
  return short + suffix;
}

export function normalizeFieldLabel(label: string | null | undefined): string {
  return String(label ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[:*]/g, '')
    .trim()
    .toLowerCase();
}

/** label → { occurrenceIndex (1-based, layout order) → field API name } */
export type LayoutLabelMap = Map<string, Record<number, string>>;

export interface LabelMaps {
  layoutLabelMap: LayoutLabelMap;
  objectLabelMap: Map<string, string>;
}

interface LayoutItem {
  placeholder?: boolean;
  label?: string;
  layoutComponents?: { value?: string }[];
}

interface LayoutShape {
  detailLayoutSections?: { layoutRows?: { layoutItems?: LayoutItem[] }[] }[];
}

/** The layouts endpoint returns either { layouts: [layout] } or the layout
 * object bare, depending on how it was addressed — handle both. */
export function buildLayoutLabelMap(layoutData: unknown): LayoutLabelMap {
  const map: LayoutLabelMap = new Map();
  const root = layoutData as { layouts?: LayoutShape[] } & LayoutShape;
  const layout = root?.layouts?.[0] ?? root;
  const occurrences = new Map<string, number>();
  for (const section of layout?.detailLayoutSections ?? []) {
    for (const row of section.layoutRows ?? []) {
      for (const item of row.layoutItems ?? []) {
        if (item.placeholder) continue;
        const apiName = item.layoutComponents?.[0]?.value;
        const label = item.label;
        if (!apiName || !label) continue;
        const n = (occurrences.get(label) ?? 0) + 1;
        occurrences.set(label, n);
        const entry = map.get(label) ?? {};
        entry[n] = apiName;
        map.set(label, entry);
      }
    }
  }
  return map;
}

export interface DescribeField {
  name: string;
  label: string;
  type: string;
  createable?: boolean;
}

export interface SObjectDescribe {
  fields: DescribeField[];
}

/** Fallback for labels the layout doesn't carry (system fields etc.). */
export function buildObjectLabelMap(
  describe: SObjectDescribe,
  layoutMap: LayoutLabelMap,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const field of describe.fields ?? []) {
    if (!layoutMap.has(field.label)) map.set(field.label, field.name);
  }
  return map;
}

function lookupNormalized<T>(map: Map<string, T>, label: string): T | undefined {
  const direct = map.get(label);
  if (direct !== undefined) return direct;
  const normalized = normalizeFieldLabel(label);
  for (const [key, value] of map) {
    if (normalizeFieldLabel(key) === normalized) return value;
  }
  return undefined;
}

const QUOTED_APEX_TYPES = new Set([
  'date', 'datetime', 'time', 'id', 'reference', 'string', 'textarea', 'phone',
  'url', 'email', 'picklist', 'multipicklist', 'encryptedstring', 'combobox',
]);
const NUMERIC_APEX_TYPES = new Set(['int', 'double', 'currency', 'percent', 'long']);

function escapeApexString(value: unknown): string {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

export function formatApexLiteral(type: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (type === 'boolean') return value ? 'true' : 'false';
  if (NUMERIC_APEX_TYPES.has(type)) {
    return Number.isFinite(Number(value)) ? String(value) : null;
  }
  if (QUOTED_APEX_TYPES.has(type)) return `'${escapeApexString(value)}'`;
  // Unknown type — infer from the JS value.
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return `'${escapeApexString(value)}'`;
  return null;
}

export function buildInsertStatement(
  sobjectName: string,
  record: Record<string, unknown>,
  describe: SObjectDescribe,
): string | null {
  const fieldMeta = new Map((describe.fields ?? []).map((f) => [f.name, f]));
  const lines: string[] = [];
  for (const fieldName of Object.keys(record).sort()) {
    if (fieldName === 'attributes') continue;
    const value = record[fieldName];
    if (value === null || value === undefined || typeof value === 'object') continue;
    const meta = fieldMeta.get(fieldName);
    if (!meta || !meta.createable) continue;
    const literal = formatApexLiteral(meta.type, value);
    if (literal === null) continue;
    lines.push(`  ${fieldName} = ${literal}`);
  }
  if (lines.length === 0) return null;
  return `insert new ${sobjectName}(\n${lines.join(',\n')}\n);`;
}

export function buildSoqlStatement(
  sobjectName: string,
  record: Record<string, unknown>,
  describe: SObjectDescribe,
  longId: string,
): string | null {
  const described = new Set((describe.fields ?? []).map((f) => f.name));
  const fields = Object.keys(record)
    .filter((name) => name !== 'attributes' && described.has(name))
    .sort((a, b) => a.localeCompare(b));
  if (!fields.includes('Id') && described.has('Id')) fields.unshift('Id');
  if (fields.length === 0) return null;
  return `SELECT ${fields.join(', ')} FROM ${sobjectName} WHERE Id = '${longId}' LIMIT 1`;
}

// ---------------------------------------------------------------------------
// DOM annotation (idempotent — this is what makes the MutationObserver safe:
// a pass triggered by our own appends finds every label already marked and
// changes nothing, so the observe→annotate cycle settles)
// ---------------------------------------------------------------------------

function makeApiSpan(doc: Document, text: string): HTMLSpanElement {
  const span = doc.createElement('span');
  span.className = MARKER_CLASS;
  span.textContent = `(${text})`;
  span.style.cssText = 'font-weight: normal; color: #a9a9a9; margin-left: 0.5rem;';
  return span;
}

export function annotateFieldLabels(doc: Document, maps: LabelMaps): number {
  const labels = doc.querySelectorAll<HTMLElement>(FIELD_LABEL_SELECTOR);
  const occurrences = new Map<string, number>();
  let count = 0;
  for (const el of labels) {
    if (el.querySelector(`.${MARKER_CLASS}`)) continue;
    const label = el.textContent ?? '';
    if (!label.trim()) continue;

    let apiName: string | undefined;
    const layoutEntry = lookupNormalized(maps.layoutLabelMap, label);
    if (layoutEntry) {
      const n = (occurrences.get(label) ?? 0) + 1;
      occurrences.set(label, n);
      // Occurrence beyond the layout's count (or ordering mismatch) → any
      // remaining layout value, mirroring the reference plugin's fallback.
      apiName = layoutEntry[n] ?? Object.values(layoutEntry).find(Boolean);
    }
    apiName ??= lookupNormalized(maps.objectLabelMap, label);
    if (!apiName) continue;

    el.appendChild(makeApiSpan(doc, apiName));
    count += 1;
  }
  return count;
}

export function annotateHeader(doc: Document, sobjectName: string, longId: string): void {
  const headers = doc.querySelectorAll<HTMLElement>(HEADER_SELECTOR);
  const header = headers[headers.length - 1];
  if (!header || header.querySelector(`.${MARKER_CLASS}`)) return;
  const span = makeApiSpan(doc, sobjectName);
  if (longId) span.textContent = `(${sobjectName}) (${longId})`;
  header.appendChild(span);
}

export function clearAnnotations(doc: Document): void {
  doc.querySelectorAll(`.${MARKER_CLASS}`).forEach((el) => el.remove());
}

// ---------------------------------------------------------------------------
// Feature
// ---------------------------------------------------------------------------

export interface ShowApiNamesOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
}

interface RecordPageContext {
  sobjectName: string;
  recordId: string;
}

export function createShowApiNamesFeature(options: ShowApiNamesOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();

  let active = false;
  let observer: MutationObserver | null = null;
  let unsubscribeSettings: (() => void) | null = null;
  let view: ViewHandle | null = null;
  let currentMaps: LabelMaps | null = null;
  let currentCtx: RecordPageContext | null = null;

  const recordCache = new Map<string, Record<string, unknown>>();
  const describeCache = new Map<string, SObjectDescribe>();
  const labelMapsCache = new Map<string, LabelMaps>();

  function getContext(): RecordPageContext | null {
    // ponytail: /lightning/r/<obj>/<id>/… only — no keyPrefix resolution for
    // sobject-less or Classic URLs; scope is Lightning record detail pages.
    const url = win.location.href;
    if (!new URL(url).pathname.startsWith('/lightning/r/')) return null;
    const ctx = extractRecordContext(url);
    if (!ctx?.sobjectName) return null;
    return { sobjectName: ctx.sobjectName, recordId: ctx.recordId };
  }

  async function fetchRecord(ctx: RecordPageContext): Promise<Record<string, unknown>> {
    const cached = recordCache.get(ctx.recordId);
    if (cached) return cached;
    const record = await api.apiGet<Record<string, unknown>>(
      `/services/data/${api.apiVersion}/sobjects/${ctx.sobjectName}/${ctx.recordId}`,
    );
    recordCache.set(ctx.recordId, record);
    return record;
  }

  async function fetchDescribe(sobjectName: string): Promise<SObjectDescribe> {
    const cached = describeCache.get(sobjectName);
    if (cached) return cached;
    const describe = await api.apiGet<SObjectDescribe>(
      `/services/data/${api.apiVersion}/sobjects/${sobjectName}/describe`,
    );
    describeCache.set(sobjectName, describe);
    return describe;
  }

  async function fetchLabelMaps(ctx: RecordPageContext): Promise<LabelMaps> {
    const record = await fetchRecord(ctx);
    const recordTypeId = typeof record.RecordTypeId === 'string'
      ? record.RecordTypeId
      : DEFAULT_RECORD_TYPE_ID;
    const cacheKey = `${ctx.sobjectName}|${recordTypeId}`;
    const cached = labelMapsCache.get(cacheKey);
    if (cached) return cached;

    const [layoutData, describe] = await Promise.all([
      api.apiGet<unknown>(
        `/services/data/${api.apiVersion}/sobjects/${ctx.sobjectName}/describe/layouts/${recordTypeId}`,
      ),
      fetchDescribe(ctx.sobjectName),
    ]);
    const layoutLabelMap = buildLayoutLabelMap(layoutData);
    const maps: LabelMaps = {
      layoutLabelMap,
      objectLabelMap: buildObjectLabelMap(describe, layoutLabelMap),
    };
    labelMapsCache.set(cacheKey, maps);
    return maps;
  }

  function applyAnnotations(): void {
    if (!currentMaps || !currentCtx) return;
    annotateFieldLabels(doc, currentMaps);
    annotateHeader(doc, currentCtx.sobjectName, getLongId(currentCtx.recordId));
  }

  function startObserver(): void {
    if (observer) return;
    let scheduled = false;
    observer = new MutationObserver(() => {
      if (!active || scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        if (active) applyAnnotations();
      });
    });
    if (doc.body) observer.observe(doc.body, { childList: true, subtree: true });
  }

  async function activate(): Promise<void> {
    const ctx = getContext();
    if (!ctx) return;
    try {
      const maps = await fetchLabelMaps(ctx);
      // Record changed while we were fetching (SPA nav) → drop stale spans
      // before annotating with the new record's maps.
      if (currentCtx && currentCtx.recordId !== ctx.recordId) clearAnnotations(doc);
      currentMaps = maps;
      currentCtx = ctx;
      active = true;
      applyAnnotations();
      startObserver();
    } catch (err) {
      console.warn('[SFDT show-api-names] activate failed:', err);
    }
  }

  function deactivate(): void {
    active = false;
    observer?.disconnect();
    observer = null;
    currentMaps = null;
    currentCtx = null;
    clearAnnotations(doc);
  }

  async function isDisplayOn(): Promise<boolean> {
    const settings = await loadSettings();
    const config = (settings.featureSettings?.['show-api-names'] ?? {}) as { showApiNames?: boolean };
    return config.showApiNames === true;
  }

  async function setDisplay(on: boolean): Promise<void> {
    await patchSettings({
      featureSettings: { 'show-api-names': { showApiNames: on } },
    } as never);
    if (on && !active) await activate();
    else if (!on && active) deactivate();
  }

  async function copyToClipboard(text: string, successMessage: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      showToast(successMessage, { doc, kind: 'success' });
    } catch {
      showToast('Copy failed — please allow clipboard access.', { doc, kind: 'error' });
    }
  }

  function closePanel(): void {
    view?.close();
    view = null;
  }

  async function openPanel(): Promise<void> {
    closePanel();
    const ctx = getContext();

    const body = doc.createElement('div');
    body.style.cssText = 'padding: 16px; display: flex; flex-direction: column; gap: 14px; font-size: 13px;';

    const toggleLabel = doc.createElement('label');
    toggleLabel.style.cssText = 'display: inline-flex; align-items: center; gap: 8px; cursor: pointer;';
    const toggle = doc.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = await isDisplayOn();
    toggleLabel.appendChild(toggle);
    toggleLabel.appendChild(doc.createTextNode('Show field API names inline on record pages'));
    toggle.addEventListener('change', () => void setDisplay(toggle.checked));
    body.appendChild(toggleLabel);

    const hint = doc.createElement('div');
    hint.style.cssText = 'color: #54698d; font-size: 12px;';
    hint.textContent = ctx
      ? `Current record: ${ctx.sobjectName} · ${ctx.recordId}`
      : 'Open a Lightning record page to use the copy helpers.';
    body.appendChild(hint);

    const buttonRow = doc.createElement('div');
    buttonRow.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap;';
    const makeButton = (label: string, onClick: () => Promise<void>): HTMLButtonElement => {
      const btn = doc.createElement('button');
      btn.textContent = label;
      btn.disabled = !ctx;
      btn.style.cssText =
        'padding: 6px 12px; background: #0070d2; color: #fff; border: 0; border-radius: 4px; cursor: pointer; font-size: 13px;' +
        (ctx ? '' : ' opacity: 0.5; cursor: not-allowed;');
      btn.addEventListener('click', () => void onClick());
      buttonRow.appendChild(btn);
      return btn;
    };

    makeButton('Copy 18-char Id', async () => {
      if (!ctx) return;
      await copyToClipboard(getLongId(ctx.recordId) || ctx.recordId, 'Record Id copied.');
    });
    makeButton('Copy Apex insert', async () => {
      if (!ctx) return;
      try {
        const [record, describe] = await Promise.all([fetchRecord(ctx), fetchDescribe(ctx.sobjectName)]);
        const statement = buildInsertStatement(ctx.sobjectName, record, describe);
        if (!statement) {
          showToast('No createable field values found on this record.', { doc, kind: 'warning' });
          return;
        }
        await copyToClipboard(statement, 'Apex insert statement copied.');
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), { doc, kind: 'error' });
      }
    });
    makeButton('Copy SOQL', async () => {
      if (!ctx) return;
      try {
        const [record, describe] = await Promise.all([fetchRecord(ctx), fetchDescribe(ctx.sobjectName)]);
        const statement = buildSoqlStatement(
          ctx.sobjectName,
          record,
          describe,
          getLongId(ctx.recordId) || ctx.recordId,
        );
        if (!statement) {
          showToast('No queryable fields found on this record.', { doc, kind: 'warning' });
          return;
        }
        await copyToClipboard(statement, 'SOQL query copied.');
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), { doc, kind: 'error' });
      }
    });
    body.appendChild(buttonRow);

    view = presentView({
      title: '🏷️ Show API Names',
      body,
      doc,
      width: '480px',
      onClose: () => {
        view = null;
      },
    });
  }

  return {
    manifest: {
      id: 'show-api-names',
      name: 'Show API Names',
      contexts: [CONTEXTS.RECORD_PAGE],
      settingsSchema: SHOW_API_NAMES_SETTINGS_SCHEMA,
    },

    async init() {
      if (!getContext()) return;
      if (await isDisplayOn()) await activate();
      if (!unsubscribeSettings) {
        // React to toggles from the options page / another tab.
        unsubscribeSettings = onSettingsChange((next) => {
          const config = (next.featureSettings?.['show-api-names'] ?? {}) as { showApiNames?: boolean };
          const on = config.showApiNames === true;
          if (on && !active) void activate();
          else if (!on && active) deactivate();
        });
      }
    },

    async onActivate() {
      await openPanel();
    },

    async refresh() {
      if (!active) return;
      deactivate();
      await activate();
    },

    async teardown() {
      deactivate();
      closePanel();
      if (unsubscribeSettings) {
        unsubscribeSettings();
        unsubscribeSettings = null;
      }
    },
  };
}

export function _showApiNamesTestApi() {
  return {
    getLongId,
    normalizeFieldLabel,
    buildLayoutLabelMap,
    buildObjectLabelMap,
    formatApexLiteral,
    buildInsertStatement,
    buildSoqlStatement,
    annotateFieldLabels,
    annotateHeader,
    clearAnnotations,
  };
}
