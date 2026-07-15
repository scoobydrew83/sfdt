import { z } from 'zod';
import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import { escapeSoql } from '../lib/escape.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { SF_API_VERSION } from '../lib/api-version.js';
import { loadSettings, registerSettingsShape } from '../lib/settings.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';

const APEX_ANONYMOUS_SETTINGS_SCHEMA = z.object({
  historyEnabled: z.boolean().default(true),
  captureLogs: z.boolean().default(true),
});

registerSettingsShape('apex-anonymous', APEX_ANONYMOUS_SETTINGS_SCHEMA);

const HISTORY_STORAGE_KEY = 'apexAnonymous.history';
const SNIPPETS_STORAGE_KEY = 'apexAnonymous.snippets';
const HISTORY_CAP = 20;

// DeveloperName for the DebugLevel this feature owns. Reused across runs so we
// don't litter the org with a fresh DebugLevel every execution.
const DEBUG_LEVEL_DEVELOPER_NAME = 'SFDT_Finest';
// DEVELOPER_LOG trace flags may span at most 24h from their start date.
const TRACE_FLAG_DURATION_MS = 24 * 60 * 60 * 1000;
// Back-date the start a touch so client/server clock skew can't push it "into
// the future" and get the create rejected.
const TRACE_FLAG_START_BUFFER_MS = 60 * 1000;
// ApexLog indexing lags execution by a beat; poll a few times before giving up.
const LOG_POLL_ATTEMPTS = 6;
const LOG_POLL_DELAY_MS = 700;

interface HistoryEntry {
  code: string;
  ts: number;
}

export interface ApexSnippet {
  name: string;
  code: string;
}

// Shape returned by the Tooling REST executeAnonymous endpoint.
export interface ExecuteAnonymousResult {
  compiled: boolean;
  compileProblem: string | null;
  success: boolean;
  line: number;
  column: number;
  exceptionMessage: string | null;
  exceptionStackTrace: string | null;
}

// Minimal projections of the Tooling rows the log-capture flow queries.
interface DebugLevelRow {
  Id: string;
}
interface TraceFlagRow {
  Id: string;
  ExpirationDate: string;
  DebugLevelId: string;
}
interface ApexLogIdRow {
  Id: string;
}

// SOQL builders are pure so the queries are unit-testable without a live org,
// mirroring buildApexLogQuery() in the Debug Logs viewer.
export function buildDebugLevelLookup(): string {
  return `SELECT Id FROM DebugLevel WHERE DeveloperName = '${DEBUG_LEVEL_DEVELOPER_NAME}' LIMIT 1`;
}

export function buildTraceFlagLookup(userId: string): string {
  return (
    'SELECT Id, ExpirationDate, DebugLevelId FROM TraceFlag ' +
    `WHERE TracedEntityId = '${escapeSoql(userId)}' AND LogType = 'DEVELOPER_LOG' ` +
    'ORDER BY ExpirationDate DESC LIMIT 1'
  );
}

export function buildLatestApexLogLookup(userId: string): string {
  return (
    `SELECT Id FROM ApexLog WHERE LogUserId = '${escapeSoql(userId)}' ` +
    'ORDER BY StartTime DESC, Id DESC LIMIT 1'
  );
}

// FINEST Apex/Fine System so System.debug output (and most else) is captured;
// the other categories stay at INFO to keep logs from ballooning.
export function debugLevelCreatePayload(): Record<string, string> {
  return {
    DeveloperName: DEBUG_LEVEL_DEVELOPER_NAME,
    MasterLabel: DEBUG_LEVEL_DEVELOPER_NAME,
    ApexCode: 'FINEST',
    ApexProfiling: 'INFO',
    Callout: 'INFO',
    Database: 'INFO',
    System: 'FINE',
    Validation: 'INFO',
    Visualforce: 'INFO',
    Workflow: 'INFO',
  };
}

// nowMs is injected so the computed dates are deterministic in tests. The window
// is held to exactly TRACE_FLAG_DURATION_MS to respect the 24h DEVELOPER_LOG cap.
export function traceFlagWindow(nowMs: number): { StartDate: string; ExpirationDate: string } {
  const start = nowMs - TRACE_FLAG_START_BUFFER_MS;
  return {
    StartDate: new Date(start).toISOString(),
    ExpirationDate: new Date(start + TRACE_FLAG_DURATION_MS).toISOString(),
  };
}

export function traceFlagCreatePayload(
  userId: string,
  debugLevelId: string,
  nowMs: number,
): Record<string, string> {
  return {
    TracedEntityId: userId,
    DebugLevelId: debugLevelId,
    LogType: 'DEVELOPER_LOG',
    ...traceFlagWindow(nowMs),
  };
}

export function traceFlagIsActive(
  row: { ExpirationDate?: string } | undefined | null,
  nowMs: number,
): boolean {
  if (!row?.ExpirationDate) return false;
  const exp = Date.parse(row.ExpirationDate);
  return Number.isFinite(exp) && exp > nowMs;
}

// The just-run log is the newest one whose Id differs from the pre-run baseline.
export function pickNewLogId(latestId: string | null, baselineId: string | null): string | null {
  if (!latestId) return null;
  return latestId === baselineId ? null : latestId;
}

export async function readApexHistory(): Promise<HistoryEntry[]> {
  return new Promise((resolve) => {
    chrome.storage.local.get(HISTORY_STORAGE_KEY, (result) => {
      const raw = result?.[HISTORY_STORAGE_KEY] as { entries?: HistoryEntry[] } | undefined;
      resolve(Array.isArray(raw?.entries) ? raw.entries : []);
    });
  });
}

export async function pushApexHistory(entry: HistoryEntry): Promise<void> {
  const existing = await readApexHistory();
  const deduped = existing.filter((e) => e.code !== entry.code);
  const entries = [entry, ...deduped].slice(0, HISTORY_CAP);
  return new Promise((resolve) => {
    chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: { entries } }, () => resolve());
  });
}

export async function readApexSnippets(): Promise<ApexSnippet[]> {
  return new Promise((resolve) => {
    chrome.storage.local.get(SNIPPETS_STORAGE_KEY, (result) => {
      const raw = result?.[SNIPPETS_STORAGE_KEY] as { entries?: ApexSnippet[] } | undefined;
      resolve(Array.isArray(raw?.entries) ? raw.entries : []);
    });
  });
}

export async function pushApexSnippet(entry: ApexSnippet): Promise<void> {
  const existing = await readApexSnippets();
  const filtered = existing.filter((e) => e.name !== entry.name);
  return new Promise((resolve) => {
    chrome.storage.local.set({ [SNIPPETS_STORAGE_KEY]: { entries: [entry, ...filtered] } }, () =>
      resolve(),
    );
  });
}

// Summarises the executeAnonymous response into a single human-readable line.
export function summariseResult(result: ExecuteAnonymousResult): {
  ok: boolean;
  message: string;
} {
  if (!result.compiled) {
    return {
      ok: false,
      message: `Compile error (line ${result.line}, col ${result.column}): ${
        result.compileProblem ?? 'unknown'
      }`,
    };
  }
  if (!result.success) {
    return {
      ok: false,
      message: result.exceptionMessage
        ? `Runtime exception: ${result.exceptionMessage}`
        : 'Execution failed',
    };
  }
  return { ok: true, message: 'Compiled and executed successfully.' };
}

export interface ApexAnonymousOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
}

export function createApexAnonymousFeature(options: ApexAnonymousOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();

  let view: ViewHandle | null = null;

  function close(): void {
    view?.close();
    view = null;
  }

  async function run(code: string): Promise<ExecuteAnonymousResult> {
    return api.apiGet<ExecuteAnonymousResult>(
      `/services/data/${SF_API_VERSION}/tooling/executeAnonymous/`,
      { anonymousBody: code },
    );
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => win.setTimeout(resolve, ms));
  }

  // The REST executeAnonymous endpoint never returns the debug log, so log
  // capture rides on an ApexLog record — which only exists if a trace flag is
  // active for the running user. Identify that user (userinfo, falling back to
  // Chatter) so we can target a trace flag at them.
  async function getCurrentUserId(): Promise<string | null> {
    try {
      const info = await api.apiGet<{ user_id?: string }>('/services/oauth2/userinfo');
      if (info?.user_id) return info.user_id;
    } catch {
      // userinfo can be unavailable; fall through to the Chatter identity.
    }
    try {
      const me = await api.apiGet<{ id?: string }>(
        `/services/data/${SF_API_VERSION}/chatter/users/me`,
      );
      if (me?.id) return me.id;
    } catch {
      // Both lookups failed — caller degrades to "no log captured".
    }
    return null;
  }

  // Reuse our own DebugLevel if it already exists; create it once otherwise.
  async function ensureDebugLevelId(): Promise<string> {
    const existing = await api.toolingQuery<DebugLevelRow>(buildDebugLevelLookup());
    if (existing.records[0]?.Id) return existing.records[0].Id;
    const created = await api.apiRequest<{ id?: string }>(
      'POST',
      `/services/data/${SF_API_VERSION}/tooling/sobjects/DebugLevel`,
      debugLevelCreatePayload(),
    );
    if (!created?.id) throw new Error('Could not create a DebugLevel for log capture.');
    return created.id;
  }

  // Guarantee an active DEVELOPER_LOG trace flag for the user. An already-active
  // flag is left untouched (respect the user's existing tracing); an expired one
  // is extended in place; otherwise a new one is created. Salesforce rejects a
  // second overlapping DEVELOPER_LOG flag for the same entity, hence the lookup.
  async function ensureTraceFlag(userId: string): Promise<void> {
    const now = Date.now();
    const existing = await api.toolingQuery<TraceFlagRow>(buildTraceFlagLookup(userId));
    const current = existing.records[0];
    if (traceFlagIsActive(current, now)) return;
    const debugLevelId = await ensureDebugLevelId();
    if (current?.Id) {
      await api.apiRequest(
        'PATCH',
        `/services/data/${SF_API_VERSION}/tooling/sobjects/TraceFlag/${current.Id}`,
        { DebugLevelId: debugLevelId, ...traceFlagWindow(now) },
      );
      return;
    }
    await api.apiRequest(
      'POST',
      `/services/data/${SF_API_VERSION}/tooling/sobjects/TraceFlag`,
      traceFlagCreatePayload(userId, debugLevelId, now),
    );
  }

  async function latestLogId(userId: string): Promise<string | null> {
    try {
      const res = await api.toolingQuery<ApexLogIdRow>(buildLatestApexLogLookup(userId));
      return res.records[0]?.Id ?? null;
    } catch {
      return null;
    }
  }

  async function pollForNewLog(userId: string, baselineId: string | null): Promise<string | null> {
    for (let attempt = 0; attempt < LOG_POLL_ATTEMPTS; attempt++) {
      const found = pickNewLogId(await latestLogId(userId), baselineId);
      if (found) return found;
      if (attempt < LOG_POLL_ATTEMPTS - 1) await delay(LOG_POLL_DELAY_MS);
    }
    return null;
  }

  // Same text endpoint the Debug Logs viewer uses for the raw log body.
  async function fetchLogBody(id: string): Promise<string> {
    return api.apiGetText(
      `/services/data/${SF_API_VERSION}/tooling/sobjects/ApexLog/${id}/Body`,
    );
  }

  async function open(): Promise<void> {
    close();

    const settings = await loadSettings();
    // Parse through the schema rather than a hand-written fallback so newly added
    // keys (like captureLogs) get their defaults even when an older settings
    // block — saved before the key existed — is already in storage. The composed
    // settings schema makes each feature shape .optional() and does NOT fill
    // per-feature defaults, so the feature is responsible for doing it here.
    const config = APEX_ANONYMOUS_SETTINGS_SCHEMA.parse(
      settings.featureSettings?.['apex-anonymous'] ?? {},
    );

    const body = doc.createElement('div');
    body.style.cssText =
      'padding: 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 10px;';

    const editor = doc.createElement('textarea');
    editor.placeholder = 'System.debug(\'Hello\');';
    editor.value = "System.debug('Hello from SFDT');";
    editor.style.cssText =
      'width: 100%; min-height: 180px; font-family: ui-monospace, monospace; font-size: 12px; padding: 8px; border: 1px solid var(--sfdt-color-border); border-radius: 4px; resize: vertical;';
    body.appendChild(editor);

    const toolbar = doc.createElement('div');
    toolbar.style.cssText = 'display: flex; gap: 8px; align-items: center;';
    const runBtn = doc.createElement('button');
    runBtn.textContent = 'Execute';
    runBtn.style.cssText =
      'padding: 6px 14px; background: var(--sfdt-color-brand); color: var(--sfdt-color-surface); border: 0; border-radius: 4px; cursor: pointer; font-size: 13px;';
    const saveBtn = doc.createElement('button');
    saveBtn.textContent = 'Save snippet';
    saveBtn.style.cssText =
      'padding: 6px 12px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); border-radius: 4px; cursor: pointer; font-size: 12px;';
    const openLogBtn = doc.createElement('button');
    openLogBtn.textContent = '🪵 Open log';
    openLogBtn.style.cssText =
      'padding: 6px 12px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); border-radius: 4px; cursor: pointer; font-size: 12px; display: none;';
    const hint = doc.createElement('span');
    hint.textContent = 'Ctrl/Cmd+Enter to run';
    hint.style.cssText = 'color: var(--sfdt-color-text-icon); font-size: 11px; margin-left: auto;';
    toolbar.appendChild(runBtn);
    toolbar.appendChild(saveBtn);
    toolbar.appendChild(openLogBtn);
    toolbar.appendChild(hint);
    body.appendChild(toolbar);

    const status = doc.createElement('div');
    status.style.cssText = 'font-size: 12px; color: var(--sfdt-color-text-weak);';
    body.appendChild(status);

    const resultPane = doc.createElement('pre');
    resultPane.style.cssText =
      'margin: 0; padding: 10px; background: var(--sfdt-color-surface-alt); border: 1px solid var(--sfdt-color-border); border-radius: 4px; overflow: auto; max-height: 280px; font-family: ui-monospace, monospace; font-size: 12px; display: none; white-space: pre-wrap;';
    body.appendChild(resultPane);

    const logPane = doc.createElement('pre');
    logPane.style.cssText =
      'margin: 0; padding: 10px; background: var(--sfdt-color-code-bg); color: var(--sfdt-color-border-3); border-radius: 4px; overflow: auto; max-height: 320px; font-family: ui-monospace, monospace; font-size: 11px; display: none; white-space: pre-wrap;';
    body.appendChild(logPane);

    // The log captured by the most recent run, if any. Drives the Open log button.
    let capturedLogId: string | null = null;

    view = presentView({
      title: '⚡ Execute Anonymous Apex',
      body,
      doc,
      width: '860px',
      onClose: () => {
        view = null;
      },
    });

    async function execute(): Promise<void> {
      const code = editor.value;
      if (!code.trim()) {
        showToast('Enter some Apex to execute.', { doc, kind: 'warning' });
        return;
      }
      runBtn.disabled = true;
      openLogBtn.style.display = 'none';
      logPane.style.display = 'none';
      capturedLogId = null;
      resultPane.style.display = 'none';
      resultPane.style.color = '';
      status.style.color = 'var(--sfdt-color-text-weak)';
      status.textContent = 'Executing…';

      // Trace-flag setup is best-effort: failing to arm log capture must never
      // stop the Apex from running. captureNote carries any setup warning so it
      // can be appended to the status line after the run.
      let userId: string | null = null;
      let baselineLogId: string | null = null;
      let captureNote = '';
      if (config.captureLogs) {
        status.textContent = 'Preparing debug log…';
        try {
          userId = await getCurrentUserId();
          if (userId) {
            await ensureTraceFlag(userId);
            baselineLogId = await latestLogId(userId);
          } else {
            captureNote = 'log not captured (could not identify user)';
          }
        } catch (err) {
          userId = null;
          captureNote = `log capture unavailable: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }

      try {
        status.textContent = 'Executing…';
        const result = await run(code);
        const summary = summariseResult(result);
        const head = summary.ok ? '✓ Success' : '✗ Failed';
        status.textContent = head;
        status.style.color = summary.ok ? 'var(--sfdt-color-success)' : 'var(--sfdt-color-error)';
        const lines = [summary.message];
        if (result.exceptionStackTrace) lines.push('', result.exceptionStackTrace);
        resultPane.textContent = lines.join('\n');
        resultPane.style.display = 'block';
        if (config.historyEnabled) await pushApexHistory({ code, ts: Date.now() });

        if (config.captureLogs && userId) {
          status.textContent = `${head} · capturing log…`;
          capturedLogId = await pollForNewLog(userId, baselineLogId);
          if (capturedLogId) {
            openLogBtn.style.display = '';
            status.textContent = `${head} · log ready`;
          } else {
            status.textContent = `${head} · no log captured`;
          }
        } else if (captureNote) {
          status.textContent = `${head} · ${captureNote}`;
        }
      } catch (err) {
        status.textContent = '';
        resultPane.textContent = err instanceof Error ? err.message : String(err);
        resultPane.style.display = 'block';
        resultPane.style.color = 'var(--sfdt-color-error)';
      } finally {
        runBtn.disabled = false;
      }
    }

    runBtn.addEventListener('click', () => void execute());
    editor.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void execute();
      }
    });
    saveBtn.addEventListener('click', async () => {
      const name = win.prompt('Snippet name?');
      if (!name) return;
      await pushApexSnippet({ name, code: editor.value });
      showToast(`Saved snippet "${name}"`, { doc, kind: 'success' });
    });
    openLogBtn.addEventListener('click', async () => {
      if (!capturedLogId) return;
      logPane.style.display = 'block';
      logPane.textContent = 'Loading log…';
      try {
        logPane.textContent = await fetchLogBody(capturedLogId);
      } catch (err) {
        logPane.textContent = err instanceof Error ? err.message : String(err);
      }
    });

    editor.focus();
  }

  return {
    manifest: {
      id: 'apex-anonymous',
      name: 'Execute Anonymous Apex',
      contexts: [CONTEXTS.WORKSPACE, CONTEXTS.SETUP_OTHER, CONTEXTS.SETUP_FLOWS],
      settingsSchema: APEX_ANONYMOUS_SETTINGS_SCHEMA,
    },

    async onActivate() {
      const ctx = detectContext({ location: { href: win.location.href } }, doc);
      if (ctx === CONTEXTS.NONE) {
        showToast('Open a Salesforce page or the Workspace to run Apex.', {
          doc,
          kind: 'warning',
        });
        return;
      }
      await open();
    },
  };
}

export function _apexAnonymousTestApi() {
  return {
    summariseResult,
    readApexHistory,
    pushApexHistory,
    readApexSnippets,
    pushApexSnippet,
    HISTORY_CAP,
    DEBUG_LEVEL_DEVELOPER_NAME,
    buildDebugLevelLookup,
    buildTraceFlagLookup,
    buildLatestApexLogLookup,
    debugLevelCreatePayload,
    traceFlagWindow,
    traceFlagCreatePayload,
    traceFlagIsActive,
    pickNewLogId,
  };
}
