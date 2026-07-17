import { z } from 'zod';
import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import { escapeSoql } from '../lib/escape.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { SF_API_VERSION } from '../lib/api-version.js';
import { loadSettings, registerSettingsShape } from '../lib/settings.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';

// --- Constants -------------------------------------------------------------

// The DebugLevel categories every TraceFlag/DebugLevel carries. Kept to the
// eight always-present ones so a create never fails on an org that lacks the
// newer optional categories (Nba/Wave). ponytail: fixed 8; widen only if a
// user actually needs Nba/Wave tracing.
export const DEBUG_CATEGORIES = [
  'ApexCode',
  'ApexProfiling',
  'Callout',
  'Database',
  'System',
  'Validation',
  'Visualforce',
  'Workflow',
] as const;
export type DebugCategory = (typeof DEBUG_CATEGORIES)[number];

// Valid log levels, coarsest → finest. Drives the per-category <select> options.
export const DEBUG_LEVELS = [
  'NONE',
  'ERROR',
  'WARN',
  'INFO',
  'DEBUG',
  'FINE',
  'FINER',
  'FINEST',
] as const;

export type CategoryMap = Record<DebugCategory, string>;

export type Preset = 'basic' | 'full' | 'custom';

// A light "Basic" level — enough Apex/System debug for everyday work without the
// log-bloat of FINEST everywhere.
export const PRESET_BASIC: CategoryMap = {
  ApexCode: 'DEBUG',
  ApexProfiling: 'NONE',
  Callout: 'INFO',
  Database: 'INFO',
  System: 'DEBUG',
  Validation: 'INFO',
  Visualforce: 'INFO',
  Workflow: 'INFO',
};

// "Full" — every category at FINEST.
export const PRESET_FULL: CategoryMap = DEBUG_CATEGORIES.reduce((acc, c) => {
  acc[c] = 'FINEST';
  return acc;
}, {} as CategoryMap);

// DeveloperNames of the feature-managed DebugLevels, one per preset. Reused
// across sessions so we don't litter the org with a fresh DebugLevel each time.
export const MANAGED_LEVEL_NAMES: Record<Preset, string> = {
  basic: 'SFDT_TF_Basic',
  full: 'SFDT_TF_Full',
  custom: 'SFDT_TF_Custom',
};

// DEVELOPER_LOG trace flags may span at most 24h from their start date.
export const TRACE_FLAG_DURATION_MS = 24 * 60 * 60 * 1000;
// Back-date the start so client/server clock skew can't push it "into the
// future" and get the create/renew rejected.
const TRACE_FLAG_START_BUFFER_MS = 60 * 1000;

const CUSTOM_PRESET_STORAGE_KEY = 'traceFlags.customPreset';

const TRACE_FLAGS_SETTINGS_SCHEMA = z.object({
  defaultPreset: z.enum(['basic', 'full', 'custom']).default('basic'),
});
registerSettingsShape('trace-flags', TRACE_FLAGS_SETTINGS_SCHEMA);

// --- Row shapes ------------------------------------------------------------

export interface TraceFlagRow {
  Id: string;
  TracedEntityId: string;
  DebugLevelId: string;
  LogType: string;
  StartDate: string;
  ExpirationDate: string;
}
interface UserRow {
  Id: string;
  Name: string;
  Username?: string;
}
interface DebugLevelRow {
  Id: string;
  DeveloperName?: string;
  MasterLabel?: string;
}

// --- Pure helpers (unit-tested without a live org) -------------------------

export function presetCategories(preset: Preset, custom?: CategoryMap): CategoryMap {
  if (preset === 'full') return { ...PRESET_FULL };
  if (preset === 'custom') return { ...PRESET_BASIC, ...(custom ?? {}) };
  return { ...PRESET_BASIC };
}

// TraceFlags carry many LogTypes; the manager lists them all (expired ones are
// styled distinct client-side, so no now-filter is needed here).
export function buildActiveTraceFlagsQuery(): string {
  return (
    'SELECT Id, TracedEntityId, DebugLevelId, LogType, StartDate, ExpirationDate ' +
    'FROM TraceFlag ORDER BY ExpirationDate DESC LIMIT 200'
  );
}

// The one active DEVELOPER_LOG flag for an entity (Salesforce rejects a second
// overlapping one), used to decide create-vs-patch when starting a session.
export function buildEntityTraceFlagLookup(entityId: string): string {
  return (
    'SELECT Id, TracedEntityId, DebugLevelId, LogType, StartDate, ExpirationDate FROM TraceFlag ' +
    `WHERE TracedEntityId = '${escapeSoql(entityId)}' AND LogType = 'DEVELOPER_LOG' ` +
    'ORDER BY ExpirationDate DESC LIMIT 1'
  );
}

// User lookup for the start-session picker (name OR username, case-insensitive).
export function buildUserSearchQuery(term: string): string {
  const t = escapeSoql(term);
  return (
    'SELECT Id, Name, Username FROM User ' +
    `WHERE IsActive = true AND (Name LIKE '%${t}%' OR Username LIKE '%${t}%') ` +
    'ORDER BY Name LIMIT 20'
  );
}

// Resolve a batch of TracedEntityIds → user names for the list.
export function buildUsersByIdQuery(ids: readonly string[]): string {
  const inList = ids.map((id) => `'${escapeSoql(id)}'`).join(', ');
  return `SELECT Id, Name, Username FROM User WHERE Id IN (${inList})`;
}

// Resolve a batch of DebugLevelIds → level names for the list.
export function buildDebugLevelsByIdQuery(ids: readonly string[]): string {
  const inList = ids.map((id) => `'${escapeSoql(id)}'`).join(', ');
  return `SELECT Id, DeveloperName, MasterLabel FROM DebugLevel WHERE Id IN (${inList})`;
}

export function buildManagedDebugLevelLookup(developerName: string): string {
  return `SELECT Id FROM DebugLevel WHERE DeveloperName = '${escapeSoql(developerName)}' LIMIT 1`;
}

export function traceFlagCollectionEndpoint(): string {
  return `/services/data/${SF_API_VERSION}/tooling/sobjects/TraceFlag`;
}
export function traceFlagEndpoint(id: string): string {
  return `${traceFlagCollectionEndpoint()}/${id}`;
}
export function debugLevelCollectionEndpoint(): string {
  return `/services/data/${SF_API_VERSION}/tooling/sobjects/DebugLevel`;
}
export function debugLevelEndpoint(id: string): string {
  return `${debugLevelCollectionEndpoint()}/${id}`;
}

// A 24h-capped window from a back-dated start. nowMs is injected so the dates
// are deterministic in tests.
export function traceFlagWindow(nowMs: number): { StartDate: string; ExpirationDate: string } {
  const start = nowMs - TRACE_FLAG_START_BUFFER_MS;
  return {
    StartDate: new Date(start).toISOString(),
    ExpirationDate: new Date(start + TRACE_FLAG_DURATION_MS).toISOString(),
  };
}

export function traceFlagCreatePayload(
  entityId: string,
  debugLevelId: string,
  nowMs: number,
): Record<string, string> {
  return {
    TracedEntityId: entityId,
    DebugLevelId: debugLevelId,
    LogType: 'DEVELOPER_LOG',
    ...traceFlagWindow(nowMs),
  };
}

// Renew = push the expiry forward. Both dates move so we never violate the 24h
// cap (StartDate + 24h) that a stale StartDate would otherwise breach.
export function renewTraceFlagPayload(nowMs: number): Record<string, string> {
  return traceFlagWindow(nowMs);
}

export function debugLevelPayload(
  developerName: string,
  categories: CategoryMap,
): Record<string, string> {
  return { DeveloperName: developerName, MasterLabel: developerName, ...categories };
}

// Given an ExpirationDate + the current time, compute the remaining window.
export function traceFlagCountdown(
  expirationDate: string | undefined | null,
  nowMs: number,
): { expired: boolean; remainingMs: number; label: string } {
  const t = expirationDate ? Date.parse(expirationDate) : NaN;
  if (!Number.isFinite(t)) return { expired: true, remainingMs: 0, label: '—' };
  const remaining = t - nowMs;
  if (remaining <= 0) return { expired: true, remainingMs: 0, label: 'Expired' };
  return { expired: false, remainingMs: remaining, label: formatDuration(remaining) };
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function uniq(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

// --- Custom-preset persistence (round-trips exactly) -----------------------

export async function readCustomPreset(): Promise<CategoryMap> {
  return new Promise((resolve) => {
    chrome.storage.local.get(CUSTOM_PRESET_STORAGE_KEY, (result) => {
      const raw = result?.[CUSTOM_PRESET_STORAGE_KEY] as Partial<CategoryMap> | undefined;
      // Merge onto Basic so a partial/older stored map still yields every category.
      resolve({ ...PRESET_BASIC, ...(raw ?? {}) });
    });
  });
}

export async function writeCustomPreset(categories: CategoryMap): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [CUSTOM_PRESET_STORAGE_KEY]: categories }, () => resolve());
  });
}

// --- Feature ---------------------------------------------------------------

export interface TraceFlagsOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
}

export function createTraceFlagsFeature(options: TraceFlagsOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();

  let view: ViewHandle | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;

  function stopTick(): void {
    if (tick !== null) {
      clearInterval(tick);
      tick = null;
    }
  }

  function close(): void {
    stopTick();
    view?.close();
    view = null;
  }

  async function getCurrentUserId(): Promise<string | null> {
    try {
      const info = await api.apiGet<{ user_id?: string }>('/services/oauth2/userinfo');
      if (info?.user_id) return info.user_id;
    } catch {
      // fall through to Chatter identity
    }
    try {
      const me = await api.apiGet<{ id?: string }>(
        `/services/data/${SF_API_VERSION}/chatter/users/me`,
      );
      if (me?.id) return me.id;
    } catch {
      // both failed
    }
    return null;
  }

  // Reuse the managed DebugLevel for this preset if it exists; create it
  // otherwise. Custom is re-applied (PATCH) so an edited custom preset takes
  // effect even when the managed level already exists.
  async function ensureDebugLevel(preset: Preset): Promise<string> {
    const developerName = MANAGED_LEVEL_NAMES[preset];
    const categories =
      preset === 'custom' ? await readCustomPreset() : presetCategories(preset);
    const existing = await api.toolingQuery<DebugLevelRow>(
      buildManagedDebugLevelLookup(developerName),
    );
    const found = existing.records[0]?.Id;
    if (found) {
      if (preset === 'custom') {
        await api.apiRequest('PATCH', debugLevelEndpoint(found), categories);
      }
      return found;
    }
    const created = await api.apiRequest<{ id?: string }>(
      'POST',
      debugLevelCollectionEndpoint(),
      debugLevelPayload(developerName, categories),
    );
    if (!created?.id) throw new Error('Could not create a DebugLevel for tracing.');
    return created.id;
  }

  // Start (or re-point) a DEVELOPER_LOG session for an entity. An existing
  // active flag is patched in place; otherwise a new flag is created.
  async function startSession(entityId: string, preset: Preset): Promise<void> {
    const debugLevelId = await ensureDebugLevel(preset);
    const now = Date.now();
    const existing = await api.toolingQuery<TraceFlagRow>(buildEntityTraceFlagLookup(entityId));
    const current = existing.records[0];
    if (current?.Id) {
      await api.apiRequest('PATCH', traceFlagEndpoint(current.Id), {
        DebugLevelId: debugLevelId,
        ...traceFlagWindow(now),
      });
      return;
    }
    await api.apiRequest(
      'POST',
      traceFlagCollectionEndpoint(),
      traceFlagCreatePayload(entityId, debugLevelId, now),
    );
  }

  async function renewFlag(id: string): Promise<void> {
    await api.apiRequest('PATCH', traceFlagEndpoint(id), renewTraceFlagPayload(Date.now()));
  }

  async function stopFlag(id: string): Promise<void> {
    await api.apiRequest('DELETE', traceFlagEndpoint(id));
  }

  async function open(): Promise<void> {
    close();

    const settings = await loadSettings();
    const config = TRACE_FLAGS_SETTINGS_SCHEMA.parse(
      settings.featureSettings?.['trace-flags'] ?? {},
    );

    const body = doc.createElement('div');
    body.style.cssText =
      'padding: 14px 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 14px;';

    // ---- Start-session panel ----
    const startPanel = doc.createElement('div');
    startPanel.style.cssText =
      'display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--sfdt-color-border); border-radius: 6px; background: var(--sfdt-color-surface-alt);';
    const startTitle = doc.createElement('div');
    startTitle.textContent = 'Start debug session';
    startTitle.style.cssText = 'font-size: 13px; font-weight: 600;';
    startPanel.appendChild(startTitle);

    const startRow = doc.createElement('div');
    startRow.style.cssText = 'display: flex; gap: 8px; align-items: center; flex-wrap: wrap;';

    const userSearch = doc.createElement('input');
    userSearch.type = 'search';
    userSearch.placeholder = 'Find a user by name or username…';
    userSearch.setAttribute('aria-label', 'Find a user by name or username');
    userSearch.style.cssText =
      'flex: 1; min-width: 200px; padding: 6px 8px; border: 1px solid var(--sfdt-color-border); border-radius: 4px; font-size: 13px; background: var(--sfdt-color-surface); color: var(--sfdt-color-text);';

    const meBtn = doc.createElement('button');
    meBtn.type = 'button';
    meBtn.textContent = 'Me';
    meBtn.setAttribute('aria-label', 'Trace my own user');
    meBtn.style.cssText =
      'padding: 6px 12px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); color: var(--sfdt-color-text); border-radius: 4px; cursor: pointer; font-size: 12px;';

    // Preset picker.
    const presetLabel = doc.createElement('label');
    presetLabel.style.cssText =
      'display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--sfdt-color-text-weak);';
    const presetLabelText = doc.createElement('span');
    presetLabelText.textContent = 'Level';
    const presetSelect = doc.createElement('select');
    presetSelect.style.cssText =
      'font-size: 12px; padding: 5px 6px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); color: var(--sfdt-color-text); border-radius: 4px;';
    for (const [value, text] of [
      ['basic', 'Basic'],
      ['full', 'Full (FINEST)'],
      ['custom', 'Custom…'],
    ] as const) {
      const opt = doc.createElement('option');
      opt.value = value;
      opt.textContent = text;
      presetSelect.appendChild(opt);
    }
    presetSelect.value = config.defaultPreset;
    presetLabel.append(presetLabelText, presetSelect);

    startRow.append(userSearch, meBtn, presetLabel);
    startPanel.appendChild(startRow);

    // Search results (buttons that start a session for the chosen user).
    const results = doc.createElement('div');
    results.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';
    startPanel.appendChild(results);

    // ---- Custom-preset editor (per-category selects) ----
    const customEditor = doc.createElement('div');
    customEditor.style.cssText =
      'display: none; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 6px; margin-top: 4px;';
    const customSelects = new Map<DebugCategory, HTMLSelectElement>();
    for (const cat of DEBUG_CATEGORIES) {
      const wrap = doc.createElement('label');
      wrap.style.cssText =
        'display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 11px; color: var(--sfdt-color-text-weak);';
      const name = doc.createElement('span');
      name.textContent = cat;
      const sel = doc.createElement('select');
      sel.setAttribute('aria-label', `${cat} log level`);
      sel.style.cssText =
        'font-size: 11px; padding: 3px 4px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); color: var(--sfdt-color-text); border-radius: 4px;';
      for (const lvl of DEBUG_LEVELS) {
        const o = doc.createElement('option');
        o.value = lvl;
        o.textContent = lvl;
        sel.appendChild(o);
      }
      // Persist the whole custom map on any change so it round-trips exactly.
      sel.addEventListener('change', () => void writeCustomPreset(readCustomEditor()));
      wrap.append(name, sel);
      customEditor.appendChild(wrap);
      customSelects.set(cat, sel);
    }
    startPanel.appendChild(customEditor);

    function readCustomEditor(): CategoryMap {
      const out = {} as CategoryMap;
      for (const cat of DEBUG_CATEGORIES) {
        out[cat] = customSelects.get(cat)?.value ?? PRESET_BASIC[cat];
      }
      return out;
    }

    function applyCustomEditor(map: CategoryMap): void {
      for (const cat of DEBUG_CATEGORIES) {
        const sel = customSelects.get(cat);
        if (sel) sel.value = map[cat] ?? PRESET_BASIC[cat];
      }
    }

    async function syncCustomEditorVisibility(): Promise<void> {
      if (presetSelect.value === 'custom') {
        applyCustomEditor(await readCustomPreset());
        customEditor.style.display = 'grid';
      } else {
        customEditor.style.display = 'none';
      }
    }
    presetSelect.addEventListener('change', () => void syncCustomEditorVisibility());
    void syncCustomEditorVisibility();

    body.appendChild(startPanel);

    // ---- Toolbar + flag list ----
    const toolbar = doc.createElement('div');
    toolbar.style.cssText = 'display: flex; align-items: center; gap: 10px;';
    const status = doc.createElement('div');
    status.style.cssText = 'font-size: 12px; color: var(--sfdt-color-text-weak);';
    const refreshBtn = doc.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.textContent = '↻ Refresh';
    refreshBtn.style.cssText =
      'margin-left: auto; padding: 4px 10px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); color: var(--sfdt-color-text); border-radius: 4px; cursor: pointer; font-size: 12px;';
    toolbar.append(status, refreshBtn);
    body.appendChild(toolbar);

    const table = doc.createElement('div');
    table.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';
    body.appendChild(table);

    view = presentView({
      title: '⚑ Trace Flags',
      body,
      doc,
      width: '900px',
      onClose: () => {
        stopTick();
        view = null;
      },
    });

    // Countdown spans rebuilt on each load; a single interval refreshes them.
    let countdowns: Array<{ span: HTMLElement; exp: string }> = [];
    function refreshCountdowns(): void {
      const now = Date.now();
      for (const { span, exp } of countdowns) {
        const c = traceFlagCountdown(exp, now);
        span.textContent = c.label;
        span.style.color = c.expired
          ? 'var(--sfdt-color-error-text)'
          : 'var(--sfdt-color-success-text)';
      }
    }

    async function runAction(fn: () => Promise<void>, okMsg: string): Promise<void> {
      try {
        await fn();
        showToast(okMsg, { doc, kind: 'success' });
        await load();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), { doc, kind: 'error' });
      }
    }

    async function load(): Promise<void> {
      stopTick();
      countdowns = [];
      status.textContent = 'Loading trace flags…';
      while (table.firstChild) table.removeChild(table.firstChild);
      try {
        const res = await api.toolingQuery<TraceFlagRow>(buildActiveTraceFlagsQuery());
        const flags = res.records;
        status.textContent = `${flags.length} trace flag${flags.length === 1 ? '' : 's'}`;
        if (flags.length === 0) {
          const empty = doc.createElement('div');
          empty.style.cssText =
            'color: var(--sfdt-color-text-icon); font-size: 12px; padding: 8px;';
          empty.textContent = 'No trace flags. Start a debug session above to create one.';
          table.appendChild(empty);
          return;
        }
        // Resolve entity + level names (best-effort; ids shown if lookups fail).
        const userNames = new Map<string, string>();
        const levelNames = new Map<string, string>();
        const entityIds = uniq(flags.map((f) => f.TracedEntityId));
        const levelIds = uniq(flags.map((f) => f.DebugLevelId));
        try {
          if (entityIds.length) {
            const users = await api.query<UserRow>(buildUsersByIdQuery(entityIds));
            for (const u of users.records) userNames.set(u.Id, u.Name);
          }
        } catch {
          // ids will be shown instead of names
        }
        try {
          if (levelIds.length) {
            const levels = await api.toolingQuery<DebugLevelRow>(
              buildDebugLevelsByIdQuery(levelIds),
            );
            for (const l of levels.records) {
              levelNames.set(l.Id, l.MasterLabel || l.DeveloperName || l.Id);
            }
          }
        } catch {
          // ids will be shown instead of names
        }

        const now = Date.now();
        for (const flag of flags) {
          const c = traceFlagCountdown(flag.ExpirationDate, now);
          const row = doc.createElement('div');
          row.style.cssText =
            'display: flex; gap: 10px; align-items: center; padding: 7px 8px; border-bottom: 1px solid var(--sfdt-color-bg); font-size: 12px;';
          if (c.expired) row.style.opacity = '0.6';

          const user = doc.createElement('span');
          user.textContent = userNames.get(flag.TracedEntityId) ?? flag.TracedEntityId;
          user.style.cssText = 'min-width: 160px; font-weight: 500;';

          const level = doc.createElement('span');
          level.textContent = levelNames.get(flag.DebugLevelId) ?? flag.DebugLevelId;
          level.style.cssText = 'min-width: 130px; color: var(--sfdt-color-text-weak);';

          const type = doc.createElement('span');
          type.textContent = flag.LogType;
          type.style.cssText = 'min-width: 120px; color: var(--sfdt-color-text-icon);';

          const countdown = doc.createElement('span');
          countdown.setAttribute('aria-label', 'Time remaining');
          countdown.textContent = c.label;
          countdown.style.cssText = `min-width: 90px; font-variant-numeric: tabular-nums; color: ${
            c.expired ? 'var(--sfdt-color-error-text)' : 'var(--sfdt-color-success-text)'
          };`;
          countdowns.push({ span: countdown, exp: flag.ExpirationDate });

          const spacer = doc.createElement('span');
          spacer.style.cssText = 'flex: 1;';

          const renewBtn = doc.createElement('button');
          renewBtn.type = 'button';
          renewBtn.textContent = 'Renew';
          renewBtn.setAttribute('aria-label', `Renew trace flag for ${user.textContent}`);
          renewBtn.style.cssText =
            'padding: 3px 10px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); color: var(--sfdt-color-text); border-radius: 4px; cursor: pointer; font-size: 12px;';
          renewBtn.addEventListener(
            'click',
            () => void runAction(() => renewFlag(flag.Id), 'Trace flag renewed.'),
          );

          const stopBtn = doc.createElement('button');
          stopBtn.type = 'button';
          stopBtn.textContent = 'Stop';
          stopBtn.setAttribute('aria-label', `Stop trace flag for ${user.textContent}`);
          stopBtn.style.cssText =
            'padding: 3px 10px; border: 1px solid var(--sfdt-color-error); background: var(--sfdt-color-surface); color: var(--sfdt-color-error-text); border-radius: 4px; cursor: pointer; font-size: 12px;';
          stopBtn.addEventListener(
            'click',
            () => void runAction(() => stopFlag(flag.Id), 'Trace flag stopped.'),
          );

          row.append(user, level, type, countdown, spacer, renewBtn, stopBtn);
          table.appendChild(row);
        }
        // Live countdown while the list is open (cleared on load()/close()).
        tick = setInterval(refreshCountdowns, 1000);
      } catch (err) {
        status.textContent = '';
        const errPanel = doc.createElement('div');
        errPanel.style.cssText =
          'border: 1px solid var(--sfdt-color-error); background: var(--sfdt-color-error-bg); color: var(--sfdt-color-error-text); padding: 8px 12px; border-radius: 4px; font-size: 13px;';
        errPanel.textContent = err instanceof Error ? err.message : String(err);
        table.appendChild(errPanel);
      }
    }

    function currentPreset(): Preset {
      return presetSelect.value as Preset;
    }

    // Render user-search results as start buttons.
    async function runUserSearch(term: string): Promise<void> {
      while (results.firstChild) results.removeChild(results.firstChild);
      if (term.trim().length < 2) return;
      try {
        const res = await api.query<UserRow>(buildUserSearchQuery(term.trim()));
        if (res.records.length === 0) {
          const none = doc.createElement('div');
          none.style.cssText = 'font-size: 12px; color: var(--sfdt-color-text-icon); padding: 4px;';
          none.textContent = 'No matching active users.';
          results.appendChild(none);
          return;
        }
        for (const u of res.records) {
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.textContent = `▶ ${u.Name}${u.Username ? ` · ${u.Username}` : ''}`;
          btn.setAttribute('aria-label', `Start a debug session for ${u.Name}`);
          btn.style.cssText =
            'text-align: left; padding: 5px 8px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); color: var(--sfdt-color-text); border-radius: 4px; cursor: pointer; font-size: 12px;';
          btn.addEventListener('click', () =>
            void runAction(async () => {
              await startSession(u.Id, currentPreset());
              userSearch.value = '';
              while (results.firstChild) results.removeChild(results.firstChild);
            }, `Started ${currentPreset()} tracing for ${u.Name}.`),
          );
          results.appendChild(btn);
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), { doc, kind: 'error' });
      }
    }

    // Debounce the search so we don't fire a query per keystroke.
    let searchTimer: ReturnType<typeof setTimeout> | null = null;
    userSearch.addEventListener('input', () => {
      if (searchTimer) clearTimeout(searchTimer);
      const term = userSearch.value;
      searchTimer = setTimeout(() => void runUserSearch(term), 300);
    });

    meBtn.addEventListener('click', () =>
      void runAction(async () => {
        const id = await getCurrentUserId();
        if (!id) throw new Error('Could not identify the current user.');
        await startSession(id, currentPreset());
      }, `Started ${currentPreset()} tracing for you.`),
    );

    refreshBtn.addEventListener('click', () => void load());

    await load();
    userSearch.focus();
  }

  return {
    manifest: {
      id: 'trace-flags',
      name: 'Trace Flags',
      contexts: [CONTEXTS.WORKSPACE, CONTEXTS.SETUP_OTHER, CONTEXTS.SETUP_FLOWS],
      settingsSchema: TRACE_FLAGS_SETTINGS_SCHEMA,
    },

    async onActivate() {
      const ctx = detectContext({ location: { href: win.location.href } }, doc);
      if (ctx === CONTEXTS.NONE) {
        showToast('Open a Salesforce page or the Workspace to manage trace flags.', {
          doc,
          kind: 'warning',
        });
        return;
      }
      await open();
    },

    // Clear the countdown interval so no orphan timer survives a kill-switch /
    // route change (CONVENTIONS + debug-log-viewer precedent).
    teardown() {
      close();
    },
  };
}

export function _traceFlagsTestApi() {
  return {
    presetCategories,
    buildActiveTraceFlagsQuery,
    buildEntityTraceFlagLookup,
    buildUserSearchQuery,
    buildUsersByIdQuery,
    buildDebugLevelsByIdQuery,
    buildManagedDebugLevelLookup,
    traceFlagWindow,
    traceFlagCreatePayload,
    renewTraceFlagPayload,
    debugLevelPayload,
    traceFlagCountdown,
    readCustomPreset,
    writeCustomPreset,
    traceFlagEndpoint,
    debugLevelEndpoint,
    MANAGED_LEVEL_NAMES,
    PRESET_FULL,
    PRESET_BASIC,
  };
}
