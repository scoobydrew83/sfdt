import { z } from 'zod';
import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { loadSettings, registerSettingsShape } from '../lib/settings.js';
import { showToast } from '../ui/toast.js';

const APEX_ANONYMOUS_SETTINGS_SCHEMA = z.object({
  historyEnabled: z.boolean().default(true),
});

registerSettingsShape('apex-anonymous', APEX_ANONYMOUS_SETTINGS_SCHEMA);

const HISTORY_STORAGE_KEY = 'apexAnonymous.history';
const SNIPPETS_STORAGE_KEY = 'apexAnonymous.snippets';
const HISTORY_CAP = 20;
const DEFAULT_API_VERSION = 'v62.0';

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

  let overlay: HTMLDivElement | null = null;

  function close(): void {
    overlay?.remove();
    overlay = null;
  }

  async function run(code: string): Promise<ExecuteAnonymousResult> {
    return api.apiGet<ExecuteAnonymousResult>(
      `/services/data/${DEFAULT_API_VERSION}/tooling/executeAnonymous/`,
      { anonymousBody: code },
    );
  }

  async function open(): Promise<void> {
    close();

    const settings = await loadSettings();
    const config = (settings.featureSettings?.['apex-anonymous'] ?? {
      historyEnabled: true,
    }) as z.infer<typeof APEX_ANONYMOUS_SETTINGS_SCHEMA>;

    overlay = doc.createElement('div');
    overlay.className = 'sfut-apex-anonymous-overlay';
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
    headerLabel.textContent = '⚡ Execute Anonymous Apex';
    const closeBtn = doc.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'background: none; border: 0; font-size: 22px; cursor: pointer;';
    closeBtn.addEventListener('click', close);
    header.appendChild(headerLabel);
    header.appendChild(closeBtn);
    modal.appendChild(header);

    const body = doc.createElement('div');
    body.style.cssText =
      'padding: 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 10px;';

    const editor = doc.createElement('textarea');
    editor.placeholder = 'System.debug(\'Hello\');';
    editor.value = "System.debug('Hello from SFDT');";
    editor.style.cssText =
      'width: 100%; min-height: 180px; font-family: ui-monospace, monospace; font-size: 12px; padding: 8px; border: 1px solid #d8dde6; border-radius: 4px; resize: vertical;';
    body.appendChild(editor);

    const toolbar = doc.createElement('div');
    toolbar.style.cssText = 'display: flex; gap: 8px; align-items: center;';
    const runBtn = doc.createElement('button');
    runBtn.textContent = 'Execute';
    runBtn.style.cssText =
      'padding: 6px 14px; background: #0070d2; color: #fff; border: 0; border-radius: 4px; cursor: pointer; font-size: 13px;';
    const saveBtn = doc.createElement('button');
    saveBtn.textContent = 'Save snippet';
    saveBtn.style.cssText =
      'padding: 6px 12px; border: 1px solid #d8dde6; background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px;';
    const hint = doc.createElement('span');
    hint.textContent = 'Ctrl/Cmd+Enter to run';
    hint.style.cssText = 'color: #80868d; font-size: 11px; margin-left: auto;';
    toolbar.appendChild(runBtn);
    toolbar.appendChild(saveBtn);
    toolbar.appendChild(hint);
    body.appendChild(toolbar);

    const status = doc.createElement('div');
    status.style.cssText = 'font-size: 12px; color: #54698d;';
    body.appendChild(status);

    const resultPane = doc.createElement('pre');
    resultPane.style.cssText =
      'margin: 0; padding: 10px; background: #fafaf9; border: 1px solid #d8dde6; border-radius: 4px; overflow: auto; max-height: 280px; font-family: ui-monospace, monospace; font-size: 12px; display: none; white-space: pre-wrap;';
    body.appendChild(resultPane);

    modal.appendChild(body);
    overlay.appendChild(modal);
    doc.body.appendChild(overlay);

    async function execute(): Promise<void> {
      const code = editor.value;
      if (!code.trim()) {
        showToast('Enter some Apex to execute.', { doc, kind: 'warning' });
        return;
      }
      runBtn.disabled = true;
      status.textContent = 'Executing…';
      resultPane.style.display = 'none';
      try {
        const result = await run(code);
        const summary = summariseResult(result);
        status.textContent = summary.ok ? '✓ Success' : '✗ Failed';
        status.style.color = summary.ok ? '#04844b' : '#c23934';
        const lines = [summary.message];
        if (result.exceptionStackTrace) lines.push('', result.exceptionStackTrace);
        resultPane.textContent = lines.join('\n');
        resultPane.style.display = 'block';
        if (config.historyEnabled) await pushApexHistory({ code, ts: Date.now() });
      } catch (err) {
        status.textContent = '';
        resultPane.textContent = err instanceof Error ? err.message : String(err);
        resultPane.style.display = 'block';
        resultPane.style.color = '#c23934';
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
  };
}
