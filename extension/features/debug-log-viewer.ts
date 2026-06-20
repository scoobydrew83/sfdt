import { z } from 'zod';
import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { registerSettingsShape } from '../lib/settings.js';
import { showToast } from '../ui/toast.js';

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

  let overlay: HTMLDivElement | null = null;

  function close(): void {
    overlay?.remove();
    overlay = null;
  }

  async function fetchBody(id: string): Promise<string> {
    return api.apiGetText(`/services/data/${DEFAULT_API_VERSION}/tooling/sobjects/ApexLog/${id}/Body`);
  }

  async function open(): Promise<void> {
    close();

    overlay = doc.createElement('div');
    overlay.className = 'sfut-debug-log-overlay';
    overlay.style.cssText =
      'position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 100020; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif;';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    const modal = doc.createElement('div');
    modal.style.cssText =
      'background: #fff; border-radius: 4px; width: 960px; max-width: 96vw; max-height: 90vh; display: flex; flex-direction: column;';

    const header = doc.createElement('div');
    header.style.cssText =
      'padding: 12px 16px; border-bottom: 1px solid #d8dde6; display: flex; justify-content: space-between; align-items: center; font-weight: 600;';
    const headerLabel = doc.createElement('span');
    headerLabel.textContent = '🪵 Debug Logs';
    const headerRight = doc.createElement('div');
    headerRight.style.cssText = 'display: flex; gap: 8px; align-items: center;';
    const refreshBtn = doc.createElement('button');
    refreshBtn.textContent = '↻ Refresh';
    refreshBtn.style.cssText =
      'padding: 4px 10px; border: 1px solid #d8dde6; background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px;';
    const closeBtn = doc.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'background: none; border: 0; font-size: 22px; cursor: pointer;';
    closeBtn.addEventListener('click', close);
    headerRight.appendChild(refreshBtn);
    headerRight.appendChild(closeBtn);
    header.appendChild(headerLabel);
    header.appendChild(headerRight);
    modal.appendChild(header);

    const body = doc.createElement('div');
    body.style.cssText =
      'padding: 12px 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 10px;';

    const status = doc.createElement('div');
    status.style.cssText = 'font-size: 12px; color: #54698d;';
    body.appendChild(status);

    const table = doc.createElement('div');
    table.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';
    body.appendChild(table);

    const logPane = doc.createElement('pre');
    logPane.style.cssText =
      'margin: 0; padding: 10px; background: #1e1e1e; color: #d4d4d4; border-radius: 4px; overflow: auto; max-height: 360px; font-family: ui-monospace, monospace; font-size: 11px; display: none; white-space: pre-wrap;';
    body.appendChild(logPane);

    modal.appendChild(body);
    overlay.appendChild(modal);
    doc.body.appendChild(overlay);

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
        const result = await api.toolingQuery<ApexLogRow>(buildApexLogQuery(50));
        status.textContent = `${result.records.length} log${result.records.length === 1 ? '' : 's'}`;
        if (result.records.length === 0) {
          const empty = doc.createElement('div');
          empty.style.cssText = 'color: #80868d; font-size: 12px; padding: 8px;';
          empty.textContent = 'No debug logs. Enable a trace flag in Setup to capture some.';
          table.appendChild(empty);
          return;
        }
        for (const row of result.records) {
          const item = doc.createElement('div');
          item.style.cssText =
            'display: flex; gap: 10px; padding: 6px 8px; border-bottom: 1px solid #f3f3f3; cursor: pointer; font-size: 12px; align-items: center;';
          const time = doc.createElement('span');
          time.textContent = new Date(row.StartTime).toLocaleString();
          time.style.cssText = 'min-width: 170px; color: #54698d;';
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
          size.style.cssText = 'min-width: 70px; text-align: right; color: #80868d;';
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
          'border: 1px solid #c23934; background: #fef2f1; color: #c23934; padding: 8px 12px; border-radius: 4px; font-size: 13px;';
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
