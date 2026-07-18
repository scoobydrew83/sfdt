import { z } from 'zod';
import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { SF_API_VERSION } from '../lib/api-version.js';
import { loadSettings, registerSettingsShape } from '../lib/settings.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { getContentRoot } from '../ui/content-root.js';
import { parseApexLog } from '../lib/apex-log/index.js';
import { presentApexLogAnalyzer } from '../ui/apex-log-analyzer.js';

const DEBUG_LOG_SETTINGS_SCHEMA = z.object({
  pageSize: z.number().int().min(1).max(200).default(50),
});

registerSettingsShape('debug-log-viewer', DEBUG_LOG_SETTINGS_SCHEMA);

// Auto-refresh poll interval. 15s sits in the middle of the sanctioned 10–30s
// band: frequent enough to surface new logs while a trace flag is active,
// infrequent enough not to hammer the Tooling API. The timer is owned at
// feature scope and cleared on close()/teardown() so it never orphans.
export const AUTO_REFRESH_INTERVAL_MS = 15_000;

// Tooling API single-record delete endpoint for an ApexLog row.
export function buildLogDeleteEndpoint(id: string): string {
  return `/services/data/${SF_API_VERSION}/tooling/sobjects/ApexLog/${id}`;
}

export interface ApexLogRow {
  Id: string;
  Operation: string;
  Application: string;
  Status: string;
  LogLength: number;
  DurationMilliseconds: number;
  StartTime: string;
  LogUser?: { Name?: string };
}

// Pure query builder so the SOQL is unit-testable without a live org.
export function buildApexLogQuery(limit: number): string {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  return (
    'SELECT Id, LogUser.Name, Operation, Application, Status, LogLength, ' +
    'DurationMilliseconds, StartTime FROM ApexLog ORDER BY StartTime DESC ' +
    `LIMIT ${safeLimit}`
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Small accessible count-confirm dialog for the destructive bulk delete.
// role="dialog" + aria-modal, labelled by its title; Esc (capture phase, removed
// on close) and backdrop click cancel; Tab is trapped between the two buttons;
// focus is moved to Cancel on open and restored to the opener on close
// (CONVENTIONS.md items 1–6, 8–10). Mounts into the shared shadow content root.
function confirmDialog(
  doc: Document,
  opts: { title: string; message: string; confirmLabel: string },
): Promise<boolean> {
  return new Promise((resolve) => {
    const previouslyFocused = doc.activeElement as HTMLElement | null;

    const overlay = doc.createElement('div');
    overlay.className = 'sfdt-confirm-overlay';
    overlay.style.cssText =
      'position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 100025; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif;';

    const card = doc.createElement('div');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    const titleId = `sfdt-confirm-title-${Math.random().toString(36).slice(2)}`;
    card.setAttribute('aria-labelledby', titleId);
    card.style.cssText =
      'background: var(--sfdt-color-surface); color: var(--sfdt-color-text); border-radius: 4px; padding: 16px; min-width: 320px; max-width: 460px;';

    const title = doc.createElement('h2');
    title.id = titleId;
    title.textContent = opts.title;
    title.style.cssText = 'margin: 0 0 8px; font-size: 16px;';

    const msg = doc.createElement('p');
    msg.textContent = opts.message;
    msg.style.cssText = 'margin: 0 0 12px; font-size: 13px; color: var(--sfdt-color-text-weak);';

    const footer = doc.createElement('div');
    footer.style.cssText = 'display: flex; justify-content: flex-end; gap: 8px;';
    const cancelBtn = doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText =
      'padding: 6px 12px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); color: var(--sfdt-color-text); border-radius: 4px; cursor: pointer; font-size: 13px;';
    const confirmBtn = doc.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.textContent = opts.confirmLabel;
    confirmBtn.style.cssText =
      'padding: 6px 12px; border: 0; background: var(--sfdt-color-error); color: var(--sfdt-color-on-accent); border-radius: 4px; cursor: pointer; font-size: 13px;';
    footer.append(cancelBtn, confirmBtn);

    card.append(title, msg, footer);
    overlay.appendChild(card);

    const onKeydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup(false);
      }
    };
    // Capture phase so Esc fires even when focus sits in a Salesforce widget,
    // and removed on close so it can't leak across SPA navigations (item 1).
    doc.addEventListener('keydown', onKeydown, true);

    // Two-button focus trap: Tab/Shift-Tab only ever move between these two
    // controls, so focus can never reach the page behind the dialog (item 3).
    card.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      (e.target === confirmBtn ? cancelBtn : confirmBtn).focus();
    });

    function cleanup(result: boolean): void {
      doc.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      previouslyFocused?.focus?.();
      resolve(result);
    }

    cancelBtn.addEventListener('click', () => cleanup(false));
    confirmBtn.addEventListener('click', () => cleanup(true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
    });

    (getContentRoot() ?? doc.body).appendChild(overlay);
    setTimeout(() => cancelBtn.focus(), 0);
  });
}

export interface DebugLogViewerOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
  // Cross-link into the Trace Flags manager (P3-1). When provided, the Debug
  // Logs header shows a "⚑ Trace flags" entry that opens it — the two tools are
  // siblings (a trace flag is what makes ApexLogs appear in the first place).
  onManageTraceFlags?: () => void;
}

export function createDebugLogViewerFeature(options: DebugLogViewerOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();
  const onManageTraceFlags = options.onManageTraceFlags;

  let view: ViewHandle | null = null;
  let autoTimer: ReturnType<typeof setInterval> | null = null;

  function stopAutoRefresh(): void {
    if (autoTimer !== null) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }

  function close(): void {
    stopAutoRefresh();
    view?.close();
    view = null;
  }

  async function fetchBody(id: string): Promise<string> {
    return api.apiGetText(`/services/data/${SF_API_VERSION}/tooling/sobjects/ApexLog/${id}/Body`);
  }

  async function open(): Promise<void> {
    close();

    const settings = await loadSettings();
    const config = (settings.featureSettings?.['debug-log-viewer'] ?? {
      pageSize: 50,
    }) as z.infer<typeof DEBUG_LOG_SETTINGS_SCHEMA>;

    const body = doc.createElement('div');
    body.style.cssText =
      'padding: 12px 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 10px;';

    // Toolbar (status + refresh) lives at the top of the body so it shows in both
    // the modal and the workspace tab — presentView's header is title + × only.
    const toolbar = doc.createElement('div');
    toolbar.style.cssText = 'display: flex; align-items: center; gap: 10px;';
    const status = doc.createElement('div');
    status.style.cssText = 'font-size: 12px; color: var(--sfdt-color-text-weak);';

    // Auto-refresh toggle — native checkbox in a <label> so it's labelled and
    // keyboard-operable for free. OFF by default; toggling on starts the poll.
    const autoLabel = doc.createElement('label');
    autoLabel.style.cssText =
      'margin-left: auto; display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--sfdt-color-text-weak); cursor: pointer;';
    const autoToggle = doc.createElement('input');
    autoToggle.type = 'checkbox';
    const autoText = doc.createElement('span');
    autoText.textContent = 'Auto-refresh (15s)';
    autoLabel.append(autoToggle, autoText);

    const deleteBtn = doc.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.textContent = '🗑 Delete all logs';
    deleteBtn.setAttribute('aria-label', 'Delete all debug logs');
    deleteBtn.style.cssText =
      'padding: 4px 10px; border: 1px solid var(--sfdt-color-error); background: var(--sfdt-color-surface); color: var(--sfdt-color-error-text); border-radius: 4px; cursor: pointer; font-size: 12px;';

    const refreshBtn = doc.createElement('button');
    refreshBtn.textContent = '↻ Refresh';
    refreshBtn.style.cssText =
      'padding: 4px 10px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); border-radius: 4px; cursor: pointer; font-size: 12px;';
    toolbar.appendChild(status);
    toolbar.appendChild(autoLabel);
    // Header entry into the Trace Flags manager (only when wired by the entrypoint).
    if (onManageTraceFlags) {
      const traceBtn = doc.createElement('button');
      traceBtn.type = 'button';
      traceBtn.textContent = '⚑ Trace flags';
      traceBtn.setAttribute('aria-label', 'Manage trace flags');
      traceBtn.style.cssText =
        'padding: 4px 10px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); color: var(--sfdt-color-text); border-radius: 4px; cursor: pointer; font-size: 12px;';
      traceBtn.addEventListener('click', () => onManageTraceFlags());
      toolbar.appendChild(traceBtn);
    }
    toolbar.appendChild(deleteBtn);
    toolbar.appendChild(refreshBtn);
    body.appendChild(toolbar);

    const table = doc.createElement('div');
    table.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';
    body.appendChild(table);

    const logPane = doc.createElement('pre');
    logPane.style.cssText =
      'margin: 0; padding: 10px; background: var(--sfdt-color-code-bg); color: var(--sfdt-color-border-3); border-radius: 4px; overflow: auto; max-height: 360px; font-family: ui-monospace, monospace; font-size: 11px; display: none; white-space: pre-wrap;';
    body.appendChild(logPane);

    view = presentView({
      title: '🪵 Debug Logs',
      body,
      doc,
      width: '960px',
      onClose: () => { view = null; },
    });

    async function showLog(row: ApexLogRow): Promise<void> {
      logPane.style.display = 'block';
      logPane.textContent = 'Loading log…';
      try {
        logPane.textContent = await fetchBody(row.Id);
      } catch (err) {
        logPane.textContent = err instanceof Error ? err.message : String(err);
      }
    }

    // "Analyze" — fetch the body (same path as showLog, no second fetch route),
    // parse it, and open the profiler view (timings + limits + inventories).
    async function analyze(row: ApexLogRow): Promise<void> {
      try {
        const raw = await fetchBody(row.Id);
        const parsed = parseApexLog(raw);
        presentApexLogAnalyzer({ parsed, rawText: raw, title: row.Operation, doc });
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), { doc, kind: 'error' });
      }
    }

    async function load(): Promise<void> {
      status.textContent = 'Loading logs…';
      while (table.firstChild) table.removeChild(table.firstChild);
      try {
        const result = await api.toolingQuery<ApexLogRow>(buildApexLogQuery(config.pageSize));
        status.textContent = `${result.records.length} log${result.records.length === 1 ? '' : 's'}`;
        if (result.records.length === 0) {
          const empty = doc.createElement('div');
          empty.style.cssText = 'color: var(--sfdt-color-text-icon); font-size: 12px; padding: 8px;';
          empty.textContent = 'No debug logs. Enable a trace flag in Setup to capture some.';
          table.appendChild(empty);
          return;
        }
        for (const row of result.records) {
          const item = doc.createElement('div');
          item.style.cssText =
            'display: flex; gap: 10px; padding: 6px 8px; border-bottom: 1px solid var(--sfdt-color-bg); cursor: pointer; font-size: 12px; align-items: center;';
          const time = doc.createElement('span');
          time.textContent = new Date(row.StartTime).toLocaleString();
          time.style.cssText = 'min-width: 170px; color: var(--sfdt-color-text-weak);';
          const user = doc.createElement('span');
          user.textContent = row.LogUser?.Name ?? '—';
          user.style.cssText = 'min-width: 140px;';
          const op = doc.createElement('span');
          op.textContent = row.Operation;
          op.style.cssText = 'flex: 1;';
          const status2 = doc.createElement('span');
          status2.textContent = row.Status;
          status2.style.cssText = 'min-width: 90px;';
          const size = doc.createElement('span');
          size.textContent = formatBytes(row.LogLength);
          size.style.cssText = 'min-width: 70px; text-align: right; color: var(--sfdt-color-text-icon);';
          const analyzeBtn = doc.createElement('button');
          analyzeBtn.type = 'button';
          analyzeBtn.textContent = '📊 Analyze';
          analyzeBtn.setAttribute('aria-label', `Analyze log: ${row.Operation}`);
          analyzeBtn.style.cssText =
            'flex: none; padding: 2px 8px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); color: var(--sfdt-color-text); border-radius: 4px; cursor: pointer; font-size: 11px;';
          // stopPropagation so Analyze doesn't also trigger the row's show-body click.
          analyzeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            void analyze(row);
          });
          item.appendChild(time);
          item.appendChild(user);
          item.appendChild(op);
          item.appendChild(status2);
          item.appendChild(size);
          item.appendChild(analyzeBtn);
          item.addEventListener('click', () => void showLog(row));
          table.appendChild(item);
        }
      } catch (err) {
        status.textContent = '';
        const errPanel = doc.createElement('div');
        errPanel.style.cssText =
          'border: 1px solid var(--sfdt-color-error); background: var(--sfdt-color-error-bg); color: var(--sfdt-color-error-text); padding: 8px 12px; border-radius: 4px; font-size: 13px;';
        errPanel.textContent = err instanceof Error ? err.message : String(err);
        table.appendChild(errPanel);
      }
    }

    // Fetch EVERY ApexLog Id in the org, following query pagination — the org's
    // log count routinely exceeds the 2000-row first page, so a single query
    // would under-count and leave logs behind.
    async function fetchAllLogIds(): Promise<string[]> {
      const ids: string[] = [];
      let page = await api.query<{ Id: string }>('SELECT Id FROM ApexLog');
      ids.push(...page.records.map((r) => r.Id));
      while (!page.done && page.nextRecordsUrl) {
        page = await api.queryMore<{ Id: string }>(page.nextRecordsUrl);
        ids.push(...page.records.map((r) => r.Id));
      }
      return ids;
    }

    // Bulk delete — clears ALL of the org's ApexLog rows (the standard "clear my
    // debug logs" dev action), not just the loaded page.
    async function deleteAll(): Promise<void> {
      deleteBtn.disabled = true;
      let ids: string[];
      try {
        status.textContent = 'Counting logs…';
        ids = await fetchAllLogIds();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), { doc, kind: 'error' });
        deleteBtn.disabled = false;
        await load();
        return;
      }
      if (ids.length === 0) {
        showToast('No debug logs to delete.', { doc, kind: 'info' });
        deleteBtn.disabled = false;
        await load();
        return;
      }
      const noun = `log${ids.length === 1 ? '' : 's'}`;
      const ok = await confirmDialog(doc, {
        title: 'Delete debug logs',
        message: `Delete ${ids.length} ${noun}?`,
        confirmLabel: 'Delete',
      });
      if (!ok) {
        deleteBtn.disabled = false;
        return;
      }
      status.textContent = `Deleting ${ids.length} ${noun}…`;
      try {
        // Chunked concurrency so a large org doesn't fire thousands of requests
        // at once (or serialise into a multi-minute hang). ponytail: fixed
        // chunk of 10; make it adaptive only if rate limits bite.
        const CHUNK = 10;
        for (let i = 0; i < ids.length; i += CHUNK) {
          await Promise.all(
            ids.slice(i, i + CHUNK).map((id) => api.apiRequest('DELETE', buildLogDeleteEndpoint(id))),
          );
        }
        showToast(`Deleted ${ids.length} ${noun}.`, { doc, kind: 'success' });
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), { doc, kind: 'error' });
      } finally {
        deleteBtn.disabled = false;
        await load();
      }
    }

    autoToggle.addEventListener('change', () => {
      stopAutoRefresh();
      if (autoToggle.checked) {
        autoTimer = setInterval(() => void load(), AUTO_REFRESH_INTERVAL_MS);
      }
    });
    deleteBtn.addEventListener('click', () => void deleteAll());
    refreshBtn.addEventListener('click', () => void load());
    await load();
  }

  return {
    manifest: {
      id: 'debug-log-viewer',
      name: 'Debug Logs',
      contexts: [CONTEXTS.WORKSPACE, CONTEXTS.SETUP_OTHER, CONTEXTS.SETUP_FLOWS],
      settingsSchema: DEBUG_LOG_SETTINGS_SCHEMA,
    },

    async onActivate() {
      const ctx = detectContext({ location: { href: win.location.href } }, doc);
      if (ctx === CONTEXTS.NONE) {
        showToast('Open a Salesforce page or the Workspace to view debug logs.', {
          doc,
          kind: 'warning',
        });
        return;
      }
      await open();
    },

    // Unwinds injected DOM and — critically — clears the auto-refresh interval
    // so no orphan timer survives a kill-switch/route change (CONVENTIONS + AC1).
    teardown() {
      close();
    },
  };
}

export function _debugLogViewerTestApi() {
  return { buildApexLogQuery, formatBytes, buildLogDeleteEndpoint, AUTO_REFRESH_INTERVAL_MS };
}
