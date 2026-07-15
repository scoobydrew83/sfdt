import { z } from 'zod';
import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { loadSettings, registerSettingsShape } from '../lib/settings.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';

const DEBUG_LOG_SETTINGS_SCHEMA = z.object({
  pageSize: z.number().int().min(1).max(200).default(50),
});

registerSettingsShape('debug-log-viewer', DEBUG_LOG_SETTINGS_SCHEMA);

const DEFAULT_API_VERSION = 'v62.0';

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

export interface DebugLogViewerOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
}

export function createDebugLogViewerFeature(options: DebugLogViewerOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();

  let view: ViewHandle | null = null;

  function close(): void {
    view?.close();
    view = null;
  }

  async function fetchBody(id: string): Promise<string> {
    return api.apiGetText(`/services/data/${DEFAULT_API_VERSION}/tooling/sobjects/ApexLog/${id}/Body`);
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
    const refreshBtn = doc.createElement('button');
    refreshBtn.textContent = '↻ Refresh';
    refreshBtn.style.cssText =
      'margin-left: auto; padding: 4px 10px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); border-radius: 4px; cursor: pointer; font-size: 12px;';
    toolbar.appendChild(status);
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
          item.appendChild(time);
          item.appendChild(user);
          item.appendChild(op);
          item.appendChild(status2);
          item.appendChild(size);
          item.addEventListener('click', () => void showLog(row));
          table.appendChild(item);
        }
      } catch (err) {
        status.textContent = '';
        const errPanel = doc.createElement('div');
        errPanel.style.cssText =
          'border: 1px solid var(--sfdt-color-error); background: var(--sfdt-color-error-bg); color: var(--sfdt-color-error); padding: 8px 12px; border-radius: 4px; font-size: 13px;';
        errPanel.textContent = err instanceof Error ? err.message : String(err);
        table.appendChild(errPanel);
      }
    }

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
  };
}

export function _debugLogViewerTestApi() {
  return { buildApexLogQuery, formatBytes };
}
