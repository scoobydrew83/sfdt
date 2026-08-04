import { z } from 'zod';
import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import { escapeSoql } from '../lib/escape.js';
// The 24h window, the back-dating buffer and the active test are Salesforce's
// rules, owned by lib/trace-flag.ts. Re-exported so this module's public test
// API is unchanged by the move.
import {
  traceFlagWindow,
  traceFlagCreatePayload,
  traceFlagIsActive,
} from '../lib/trace-flag.js';

export { traceFlagWindow, traceFlagCreatePayload, traceFlagIsActive };
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { SF_API_VERSION } from '../lib/api-version.js';
import { loadSettings, registerSettingsShape } from '../lib/settings.js';
import { showToast } from '../ui/toast.js';
import { recordActivity } from '../lib/activity-log.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { parseApexLog } from '../lib/apex-log/index.js';
import type { ParsedLog } from '../lib/apex-log/types.js';
import { presentApexLogAnalyzer } from '../ui/apex-log-analyzer.js';
import { button, setLabel, toolbar } from '../lib/ui-controls.js';
import { createCodeEditor } from '../lib/code-editor.js';
import { createLimitTiles, pickLimitSnapshot } from '../ui/apex-limit-tiles.js';
import { renderApexLogBody } from '../ui/apex-log-console.js';
import { createHistory } from '../lib/history.js';

const APEX_ANONYMOUS_SETTINGS_SCHEMA = z.object({
  historyEnabled: z.boolean().default(true),
  captureLogs: z.boolean().default(true),
});

registerSettingsShape('apex-anonymous', APEX_ANONYMOUS_SETTINGS_SCHEMA);

const HISTORY_STORAGE_KEY = 'apexAnonymous.history';
const SNIPPETS_STORAGE_KEY = 'apexAnonymous.snippets';
// Per-user persisted pick for the trace-flag's DebugLevel (empty = managed default).
const DEBUG_LEVEL_STORAGE_KEY = 'apexAnonymous.debugLevelId';
const HISTORY_CAP = 20;

// DeveloperName for the DebugLevel this feature owns. Reused across runs so we
// don't litter the org with a fresh DebugLevel every execution.
const DEBUG_LEVEL_DEVELOPER_NAME = 'SFDT_Finest';
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
  DeveloperName?: string;
  MasterLabel?: string;
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

// All of the org's DebugLevels, to populate the log-level picker.
export function buildDebugLevelListQuery(): string {
  return 'SELECT Id, DeveloperName, MasterLabel FROM DebugLevel ORDER BY DeveloperName LIMIT 200';
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

// The just-run log is the newest one whose Id differs from the pre-run baseline.
export function pickNewLogId(latestId: string | null, baselineId: string | null): string | null {
  if (!latestId) return null;
  return latestId === baselineId ? null : latestId;
}

// Both stores are the same shared ring. History is capped and de-duplicated by
// code; snippets are keyed by NAME and uncapped — saving over a name replaces
// it, and a cap here would quietly delete saved work.
const apexHistory = createHistory<HistoryEntry>(HISTORY_STORAGE_KEY, {
  cap: HISTORY_CAP,
  sameAs: (a, b) => a.code === b.code,
});
const apexSnippets = createHistory<ApexSnippet>(SNIPPETS_STORAGE_KEY, {
  cap: Number.POSITIVE_INFINITY,
  sameAs: (a, b) => a.name === b.name,
});

export const readApexHistory = (): Promise<HistoryEntry[]> => apexHistory.read();
export const pushApexHistory = (entry: HistoryEntry): Promise<void> => apexHistory.push(entry);
export const readApexSnippets = (): Promise<ApexSnippet[]> => apexSnippets.read();
export const pushApexSnippet = (entry: ApexSnippet): Promise<void> => apexSnippets.push(entry);

// The picked DebugLevel Id persists per browser profile (i.e. per user); empty
// string means "use the feature-managed SFDT_Finest default".
export async function readSelectedDebugLevelId(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEBUG_LEVEL_STORAGE_KEY, (result) => {
      const raw = result?.[DEBUG_LEVEL_STORAGE_KEY];
      resolve(typeof raw === 'string' ? raw : '');
    });
  });
}

export async function writeSelectedDebugLevelId(id: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [DEBUG_LEVEL_STORAGE_KEY]: id }, () => resolve());
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
  async function ensureTraceFlag(userId: string, selectedDebugLevelId: string | null = null): Promise<void> {
    const now = Date.now();
    const existing = await api.toolingQuery<TraceFlagRow>(buildTraceFlagLookup(userId));
    const current = existing.records[0];
    const active = traceFlagIsActive(current, now);
    // No explicit pick: keep respecting an already-active flag as-is.
    if (active && !selectedDebugLevelId) return;
    const debugLevelId = selectedDebugLevelId ?? (await ensureDebugLevelId());
    // Explicit pick that already matches the active flag: nothing to change.
    if (active && current?.DebugLevelId === debugLevelId) return;
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
    body.className = 'sfdt-view-body';

    const bar = toolbar(doc);
    const runBtn = button({
      label: 'Execute',
      iconName: 'play',
      variant: 'primary',
      title: 'Run this Apex (Ctrl/Cmd+Enter)',
      doc,
    });
    // Runs the Apex, then opens the produced log in the profiler view. Forces log
    // capture on for the run regardless of the captureLogs setting.
    const analyzeBtn = button({
      label: 'Run & analyze',
      iconName: 'chart',
      title: 'Run, then open the produced debug log in the profiler',
      doc,
    });
    const saveBtn = button({ label: 'Save snippet', iconName: 'save', doc });
    const openLogBtn = button({ label: 'Open log', iconName: 'logs', doc });
    openLogBtn.style.display = 'none';
    // Log-level picker: choose which org DebugLevel the trace flag uses so users
    // set log verbosity without a trip to Setup. A native <label>+<select> gives
    // implicit labelling and the full keyboard path for free. Only meaningful
    // when log capture is on (the trace flag is what carries the DebugLevel).
    const debugSelect = doc.createElement('select');
    // Accessible name comes from the wrapping <label>'s visible "Log level" text
    // (no aria-label — it would override the visible label and fail WCAG 2.5.3).
    debugSelect.className = 'sfdt-field sfdt-auto';
    const debugDefaultOpt = doc.createElement('option');
    debugDefaultOpt.value = '';
    debugDefaultOpt.textContent = 'SFDT Finest (auto)';
    debugSelect.appendChild(debugDefaultOpt);
    const debugLabel = doc.createElement('label');
    debugLabel.className = 'sfdt-check';
    const debugLabelText = doc.createElement('span');
    debugLabelText.textContent = 'Log level';
    debugLabel.appendChild(debugLabelText);
    debugLabel.appendChild(debugSelect);
    debugSelect.addEventListener('change', () => void writeSelectedDebugLevelId(debugSelect.value));

    // Best-effort: fill the picker with the org's DebugLevels and restore the
    // persisted pick. A failure leaves just the managed-default option.
    async function populateDebugLevels(): Promise<void> {
      try {
        const stored = await readSelectedDebugLevelId();
        const res = await api.toolingQuery<DebugLevelRow>(buildDebugLevelListQuery());
        for (const row of res.records) {
          if (!row.Id) continue;
          // Skip our managed level — it's already the "SFDT Finest (auto)" default.
          if (row.DeveloperName === DEBUG_LEVEL_DEVELOPER_NAME) continue;
          const opt = doc.createElement('option');
          opt.value = row.Id;
          opt.textContent = row.MasterLabel || row.DeveloperName || row.Id;
          debugSelect.appendChild(opt);
        }
        if (stored && Array.from(debugSelect.options).some((o) => o.value === stored)) {
          debugSelect.value = stored;
        }
      } catch {
        // Leave the default option; picking is a convenience, not required.
      }
    }

    const hint = doc.createElement('span');
    hint.textContent = 'Ctrl/Cmd+Enter to run';
    hint.className = 'sfdt-muted sfdt-toolbar-end';
    bar.appendChild(runBtn);
    bar.appendChild(analyzeBtn);
    bar.appendChild(saveBtn);
    bar.appendChild(openLogBtn);
    // Kick off population and hold the promise so execute() can await the
    // persisted-pick restore before reading debugSelect.value — otherwise a fast
    // Ctrl/Cmd+Enter would run with the still-default '' and lose the saved pick.
    let debugReady: Promise<void> | null = null;
    if (config.captureLogs) {
      bar.appendChild(debugLabel);
      debugReady = populateDebugLevels();
    }
    bar.appendChild(hint);
    body.appendChild(bar);

    const main = doc.createElement('div');
    main.className = 'sfdt-view-main';
    body.appendChild(main);

    const editor = createCodeEditor({
      ariaLabel: 'Anonymous Apex',
      placeholder: "System.debug('Hello');",
      value: "System.debug('Hello from SFDT');",
      doc,
    });
    // Grow into whatever the panes below leave, never shrink under the 180px
    // floor the component sheet sets.
    editor.root.classList.add('sfdt-fill');
    main.appendChild(editor.root);

    // Governor limits from the run's own log. The parser has always extracted
    // these; until now they were only reachable by clicking through to the
    // analyzer, which is one click too many for the number a developer is most
    // often running the snippet to check.
    const limits = createLimitTiles(doc);
    main.appendChild(limits.el);

    const resultPane = doc.createElement('pre');
    resultPane.className = 'sfdt-console';
    resultPane.style.display = 'none';
    main.appendChild(resultPane);

    const logPane = doc.createElement('pre');
    logPane.className = 'sfdt-console';
    logPane.style.display = 'none';
    main.appendChild(logPane);

    const statusBar = toolbar(doc, true);
    const statusPill = doc.createElement('span');
    const statusText = doc.createElement('span');
    statusText.className = 'sfdt-muted';
    statusBar.appendChild(statusPill);
    statusBar.appendChild(statusText);
    body.appendChild(statusBar);

    // One writer for the whole strip. With the pill and the detail written
    // separately it is only a matter of time before a green SUCCESS pill is left
    // standing beside the next run's error text, because every early-return path
    // has to remember to clear both.
    function setStatus(
      kind: '' | 'success' | 'warning' | 'error',
      label: string,
      detail = '',
    ): void {
      statusPill.className = kind ? `sfdt-pill sfdt-${kind}` : 'sfdt-pill';
      statusPill.textContent = label;
      statusText.textContent = detail;
    }
    setStatus('', 'Ready');

    // The log captured by the most recent run, if any. Drives the Open log
    // button, the limits panel and the analyzer — all three read the same fetch
    // rather than each pulling the body down again.
    let capturedLogId: string | null = null;
    let capturedLogBody: string | null = null;
    let capturedParsed: ParsedLog | null = null;

    view = presentView({
      title: 'Execute Anonymous Apex',
      iconName: 'apex-anonymous',
      body,
      doc,
      width: '860px',
      onClose: () => {
        view = null;
      },
    });

    // analyze=true is the "Run & analyze" action: force log capture on for this
    // run and, once the log is located, open it in the analyzer. If no log is
    // produced, the normal result view is already shown — we just add a notice.
    async function execute(analyze = false): Promise<void> {
      const code = editor.getValue();
      if (!code.trim()) {
        showToast('Enter some Apex to execute.', { doc, kind: 'warning' });
        return;
      }
      const wantCapture = config.captureLogs || analyze;
      runBtn.disabled = true;
      analyzeBtn.disabled = true;
      setLabel(runBtn, 'Running…');
      openLogBtn.style.display = 'none';
      logPane.style.display = 'none';
      capturedLogId = null;
      capturedLogBody = null;
      capturedParsed = null;
      limits.render(null);
      resultPane.style.display = 'none';
      resultPane.className = 'sfdt-console';
      setStatus('', 'Running');

      // Trace-flag setup is best-effort: failing to arm log capture must never
      // stop the Apex from running. captureNote carries any setup warning so it
      // can be appended to the status line after the run.
      let userId: string | null = null;
      let baselineLogId: string | null = null;
      let captureNote = '';
      if (wantCapture) {
        setStatus('', 'Running', 'Preparing debug log…');
        try {
          // Ensure the persisted pick has been restored into the select before
          // we read it (covers both the button and Ctrl/Cmd+Enter paths).
          if (debugReady) await debugReady;
          userId = await getCurrentUserId();
          if (userId) {
            // debugSelect is only populated (and the persisted pick restored into
            // it) when the capture *setting* is on. "Run & analyze" forces capture
            // even when that setting is off, so read the persisted pick directly
            // when the select is empty — otherwise we'd silently downgrade the
            // user's chosen DebugLevel to the managed SFDT_Finest default.
            const debugLevelId = debugSelect.value || (await readSelectedDebugLevelId()) || null;
            await ensureTraceFlag(userId, debugLevelId);
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
        setStatus('', 'Running', 'Executing…');
        const result = await run(code);
        const summary = summariseResult(result);
        // `summary.ok` already folds in compile errors and runtime exceptions —
        // both come back as a 200, so a try/catch alone would log them as
        // successes.
        void recordActivity({
          featureId: 'apex-anonymous',
          action: 'Execute Anonymous',
          resource: code,
          status: summary.ok ? 'success' : 'failed',
        });
        const kind = summary.ok ? 'success' : 'error';
        const head = summary.ok ? 'Success' : 'Failed';
        setStatus(kind, head);
        const lines = [summary.message];
        if (result.exceptionStackTrace) lines.push('', result.exceptionStackTrace);
        resultPane.textContent = lines.join('\n');
        resultPane.style.display = 'block';
        if (config.historyEnabled) await pushApexHistory({ code, ts: Date.now() });

        if (wantCapture && userId) {
          setStatus(kind, head, 'capturing log…');
          capturedLogId = await pollForNewLog(userId, baselineLogId);
          if (capturedLogId) {
            openLogBtn.style.display = '';
            setStatus(kind, head, 'log ready');
            // One fetch, three consumers: the limits panel, the Open log pane
            // and the analyzer. A log body is immutable once written, so
            // re-fetching it per consumer was pure latency.
            let logNote = 'log ready';
            try {
              capturedLogBody = await fetchLogBody(capturedLogId);
              capturedParsed = parseApexLog(capturedLogBody);
              limits.render(pickLimitSnapshot(capturedParsed.limits));
            } catch {
              // The run itself already succeeded and is already reported. A
              // failure to read the log downgrades the extras, never the result.
              logNote = 'log captured (body unavailable)';
            }
            setStatus(kind, head, logNote);
            if (analyze) {
              // Focus-restore: presentApexLogAnalyzer captures the current
              // activeElement to restore focus to on close. analyzeBtn was
              // disabled at the top of the run (which blurred it to <body>), so
              // re-enable + refocus it before opening — otherwise focus would
              // land on <body> when the analyzer closes.
              analyzeBtn.disabled = false;
              analyzeBtn.focus();
              if (capturedParsed && capturedLogBody !== null) {
                presentApexLogAnalyzer({
                  parsed: capturedParsed,
                  rawText: capturedLogBody,
                  title: 'Execute Anonymous',
                  doc,
                });
              } else {
                showToast('Could not read the debug log — showing the result instead.', {
                  doc,
                  kind: 'warning',
                });
              }
            }
          } else {
            setStatus(kind, head, 'no log captured');
            // AC: analyze fell back — the result view above is still shown; notify why.
            if (analyze) {
              showToast('No debug log was produced — showing the result instead.', {
                doc,
                kind: 'warning',
              });
            }
          }
        } else if (captureNote) {
          setStatus(kind, head, captureNote);
          if (analyze) {
            showToast(`Could not analyze — ${captureNote}. Showing the result instead.`, {
              doc,
              kind: 'warning',
            });
          }
        }
      } catch (err) {
        setStatus('error', 'Failed');
        resultPane.textContent = err instanceof Error ? err.message : String(err);
        resultPane.style.display = 'block';
        resultPane.className = 'sfdt-console sfdt-error';
      } finally {
        runBtn.disabled = false;
        analyzeBtn.disabled = false;
        setLabel(runBtn, 'Execute');
      }
    }

    runBtn.addEventListener('click', () => void execute());
    analyzeBtn.addEventListener('click', () => void execute(true));
    editor.input.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void execute();
      }
    });
    saveBtn.addEventListener('click', async () => {
      const name = win.prompt('Snippet name?');
      if (!name) return;
      await pushApexSnippet({ name, code: editor.getValue() });
      showToast(`Saved snippet "${name}"`, { doc, kind: 'success' });
    });
    openLogBtn.addEventListener('click', async () => {
      if (!capturedLogId) return;
      logPane.style.display = 'block';
      if (capturedLogBody !== null) {
        renderApexLogBody(logPane, capturedLogBody, doc);
        return;
      }
      logPane.textContent = 'Loading log…';
      try {
        capturedLogBody = await fetchLogBody(capturedLogId);
        renderApexLogBody(logPane, capturedLogBody, doc);
      } catch (err) {
        logPane.textContent = err instanceof Error ? err.message : String(err);
      }
    });

    editor.input.focus();
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
    buildDebugLevelListQuery,
    readSelectedDebugLevelId,
    writeSelectedDebugLevelId,
    buildTraceFlagLookup,
    buildLatestApexLogLookup,
    debugLevelCreatePayload,
    traceFlagWindow,
    traceFlagCreatePayload,
    traceFlagIsActive,
    pickNewLogId,
  };
}
