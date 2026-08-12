import { z } from 'zod';
import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { SF_API_VERSION } from '../lib/api-version.js';
import { loadSettings, registerSettingsShape } from '../lib/settings.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { parseApexLog } from '../lib/apex-log/index.js';
import { presentApexLogAnalyzer } from '../ui/apex-log-analyzer.js';
import { button, field, glyph, toolbar } from '../lib/ui-controls.js';
import { createLimitTiles, pickLimitSnapshot } from '../ui/apex-limit-tiles.js';
import { renderApexLogBody } from '../ui/apex-log-console.js';
import { confirmDialog } from '../ui/confirm-dialog.js';
import { clearSfError, renderSfError, setSfError } from '../ui/panels.js';

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

// Import-from-disk cap. The parser handles 5 MB in ~30 ms, so 30 MB is generous
// headroom while still rejecting absurd files before they hang the tab.
export const MAX_IMPORT_BYTES = 30 * 1024 * 1024;

// Analyze a LOCAL log file's text via the SAME analyzer path as an org log —
// but with ZERO Salesforce calls (it's a user-picked file, no `api` involved).
// Returns the ViewHandle, or null when the input is rejected (empty / not a log)
// so the caller doesn't open an empty analyzer over garbage. The parser never
// throws, so "clearly not a log" = no header AND no recognised events.
export function importApexLogText(
  text: string,
  fileName: string,
  doc: Document,
): ViewHandle | null {
  if (!text.trim()) {
    showToast(`"${fileName}" is empty — nothing to analyze.`, { doc, kind: 'warning' });
    return null;
  }
  const parsed = parseApexLog(text);
  if (parsed.apiVersion === null && parsed.events.length === 0) {
    showToast(`"${fileName}" doesn't look like an Apex debug log.`, { doc, kind: 'warning' });
    return null;
  }
  return presentApexLogAnalyzer({ parsed, rawText: text, title: fileName, doc });
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
    body.className = 'sfdt-view-body';

    // Toolbar lives at the top of the BODY, not in presentView's header, so it
    // shows in both presentations — the workspace tab supplies its own chrome
    // and would swallow anything put in the header there.
    const bar = toolbar(doc);

    const filterField = field({
      placeholder: 'Filter logs…',
      ariaLabel: 'Filter debug logs',
      doc,
    });
    filterField.classList.add('sfdt-toolbar-grow');

    // Auto-refresh toggle — native checkbox in a <label> so it's labelled and
    // keyboard-operable for free. OFF by default; toggling on starts the poll.
    const autoLabel = doc.createElement('label');
    autoLabel.className = 'sfdt-check';
    const autoToggle = doc.createElement('input');
    autoToggle.type = 'checkbox';
    const autoText = doc.createElement('span');
    autoText.textContent = 'Auto-refresh (15s)';
    autoLabel.append(autoToggle, autoText);

    const deleteBtn = button({
      label: 'Delete all logs',
      iconName: 'trash',
      variant: 'danger',
      ariaLabel: 'Delete all debug logs',
      small: true,
      doc,
    });
    const refreshBtn = button({
      iconName: 'refresh',
      title: 'Refresh',
      ariaLabel: 'Refresh',
      small: true,
      doc,
    });

    bar.appendChild(filterField);
    bar.appendChild(autoLabel);
    // Entry into the Trace Flags manager (only when wired by the entrypoint).
    // The two tools are siblings — a trace flag is what makes ApexLogs exist at
    // all — so this is a cross-link, not a duplicate of that view.
    if (onManageTraceFlags) {
      bar.appendChild(
        button({
          label: 'Trace flags',
          iconName: 'flag',
          ariaLabel: 'Manage trace flags',
          small: true,
          onClick: () => onManageTraceFlags(),
          doc,
        }),
      );
    }
    bar.appendChild(deleteBtn);
    bar.appendChild(refreshBtn);
    body.appendChild(bar);

    const main = doc.createElement('div');
    main.className = 'sfdt-view-main';
    body.appendChild(main);

    // Import-from-disk zone. Analyzes a LOCAL .log/.txt via the same analyzer as
    // an org log, with NO Salesforce call — so it works with no session at all.
    // The file input is natively labelled (wrapped in <label>) and keyboard-
    // operable (Enter/Space opens the picker); the zone is also a drop target.
    const importZone = doc.createElement('div');
    importZone.className = 'sfdt-drop';
    const importLabel = doc.createElement('label');
    importLabel.className = 'sfdt-check';
    importLabel.appendChild(glyph('upload', 16, doc));
    const importText = doc.createElement('span');
    importText.textContent = 'Import log';
    const importInput = doc.createElement('input');
    importInput.type = 'file';
    importInput.accept = '.log,.txt';
    importInput.setAttribute('aria-label', 'Import a debug log file from disk');
    importLabel.append(importText, importInput);
    const importHint = doc.createElement('span');
    importHint.textContent = 'or drop a .log/.txt file here — analyzed locally, no org needed';
    importZone.append(importLabel, importHint);
    main.appendChild(importZone);

    const tableWrap = doc.createElement('div');
    tableWrap.className = 'sfdt-scrollbox';
    tableWrap.style.maxHeight = '320px';
    const table = doc.createElement('table');
    table.className = 'sfdt-table';
    const thead = doc.createElement('thead');
    const headRow = doc.createElement('tr');
    for (const label of ['Time', 'User', 'Operation', 'Status', 'Size', 'Actions']) {
      const th = doc.createElement('th');
      th.scope = 'col';
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    const tbody = doc.createElement('tbody');
    table.append(thead, tbody);
    tableWrap.appendChild(table);
    main.appendChild(tableWrap);

    // Governor limits of whichever log is selected — the same component the
    // Execute Anonymous runner uses, fed by the body fetch that populates the
    // pane below rather than a second call.
    // Org-side failure (session, permissions, a bad query). A div rather than a
    // <pre> on purpose: the log pane below is the only <pre> in this view, and
    // tests — like a user's eye — reach for it by that.
    const errPanel = renderSfError(null, { doc });
    errPanel.style.display = 'none';
    main.appendChild(errPanel);

    const limits = createLimitTiles(doc);
    main.appendChild(limits.el);

    const logPane = doc.createElement('pre');
    logPane.className = 'sfdt-console';
    logPane.style.display = 'none';
    main.appendChild(logPane);

    const statusBar = toolbar(doc, true);
    const status = doc.createElement('span');
    status.className = 'sfdt-muted';
    statusBar.appendChild(status);
    body.appendChild(statusBar);

    // Reads a user-picked/dropped file and opens the analyzer. Rejects oversized
    // files up front (before reading) with a visible toast — never an org call.
    async function handleImportFile(file: File | null | undefined): Promise<void> {
      if (!file) return;
      if (file.size > MAX_IMPORT_BYTES) {
        showToast(
          `"${file.name}" is ${formatBytes(file.size)} — too large to import (max ${formatBytes(MAX_IMPORT_BYTES)}).`,
          { doc, kind: 'error' },
        );
        return;
      }
      let text: string;
      try {
        text = await file.text();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), { doc, kind: 'error' });
        return;
      }
      importApexLogText(text, file.name, doc);
    }

    importInput.addEventListener('change', () => {
      void handleImportFile(importInput.files?.[0]);
      // Reset so re-picking the same file fires 'change' again.
      importInput.value = '';
    });
    importZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      importZone.classList.add('sfdt-drop-over');
    });
    importZone.addEventListener('dragleave', () => importZone.classList.remove('sfdt-drop-over'));
    importZone.addEventListener('drop', (e) => {
      e.preventDefault();
      importZone.classList.remove('sfdt-drop-over');
      void handleImportFile(e.dataTransfer?.files?.[0]);
    });

    view = presentView({
      title: 'Debug Logs',
      iconName: 'debug-log-viewer',
      body,
      doc,
      width: '960px',
      onClose: () => { view = null; },
    });

    // The rows currently loaded, held for the client-side filter. Re-querying on
    // each keystroke would put a Tooling round-trip behind every character; the
    // page is at most 200 rows, so filtering in memory is instant and free.
    let loaded: ApexLogRow[] = [];
    let selectedRow: HTMLTableRowElement | null = null;

    async function showLog(row: ApexLogRow, tr: HTMLTableRowElement): Promise<void> {
      selectedRow?.removeAttribute('aria-current');
      selectedRow = tr;
      tr.setAttribute('aria-current', 'true');
      logPane.style.display = 'block';
      logPane.className = 'sfdt-console';
      // The pane is reused, so a previous failure's role="alert" would still be
      // on it — announcing the next log body as an error.
      clearSfError(logPane);
      logPane.textContent = 'Loading log…';
      limits.render(null);
      try {
        const raw = await fetchBody(row.Id);
        renderApexLogBody(logPane, raw, doc);
        // The body is already here, and parsing it is what the analyzer would do
        // on click anyway — so the governor limits come for free rather than
        // costing a second fetch behind a second button.
        limits.render(pickLimitSnapshot(parseApexLog(raw).limits));
      } catch (err) {
        setSfError(logPane, err, { doc });
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

    function matchesFilter(row: ApexLogRow, needle: string): boolean {
      if (!needle) return true;
      // Match what is on screen, including the rendered timestamp — someone
      // filtering "9:55" means the column they can see, not the ISO string.
      return [
        new Date(row.StartTime).toLocaleString(),
        row.LogUser?.Name ?? '',
        row.Operation,
        row.Status,
      ]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    }

    function emptyRow(text: string): HTMLTableRowElement {
      const tr = doc.createElement('tr');
      const td = doc.createElement('td');
      td.colSpan = 6;
      td.className = 'sfdt-muted';
      td.textContent = text;
      tr.appendChild(td);
      return tr;
    }

    function renderRows(): void {
      const typed = filterField.value.trim();
      const rows = loaded.filter((r) => matchesFilter(r, typed.toLowerCase()));
      while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
      // The <tr> it pointed at is gone; holding the reference would leave the
      // next removeAttribute() writing to a detached node.
      selectedRow = null;

      const noun = `log${loaded.length === 1 ? '' : 's'}`;
      status.textContent =
        rows.length === loaded.length
          ? `${loaded.length} ${noun}`
          : `${rows.length} of ${loaded.length} ${noun}`;

      if (rows.length === 0) {
        tbody.appendChild(
          emptyRow(
            loaded.length
              ? `No logs match "${typed}".`
              : 'No debug logs. Enable a trace flag in Setup to capture some.',
          ),
        );
        return;
      }

      for (const row of rows) {
        const tr = doc.createElement('tr');
        tr.classList.add('sfdt-clickable');
        const time = doc.createElement('td');
        time.className = 'sfdt-cell-code';
        time.textContent = new Date(row.StartTime).toLocaleString();

        const user = doc.createElement('td');
        user.textContent = row.LogUser?.Name ?? '—';

        const op = doc.createElement('td');
        op.className = 'sfdt-cell-code';
        op.textContent = row.Operation;

        const statusCell = doc.createElement('td');
        const pill = doc.createElement('span');
        // Anything that is not 'Success' is a failure code the user needs to
        // read verbatim (a LimitException, 'Skipped'), so the raw value stays.
        pill.className =
          row.Status === 'Success' ? 'sfdt-pill sfdt-success' : 'sfdt-pill sfdt-error';
        pill.textContent = row.Status;
        statusCell.appendChild(pill);

        const size = doc.createElement('td');
        size.className = 'sfdt-cell-code';
        size.textContent = formatBytes(row.LogLength);

        const actions = doc.createElement('td');
        actions.appendChild(
          button({
            label: 'Analyze',
            iconName: 'chart',
            small: true,
            ariaLabel: `Analyze log: ${row.Operation}`,
            // stopPropagation so Analyze doesn't also trigger the row's click.
            onClick: (e) => {
              e.stopPropagation();
              void analyze(row);
            },
            doc,
          }),
        );

        tr.append(time, user, op, statusCell, size, actions);
        tr.addEventListener('click', () => void showLog(row, tr));
        tbody.appendChild(tr);
      }
    }

    async function load(): Promise<void> {
      status.textContent = 'Loading logs…';
      try {
        const result = await api.toolingQuery<ApexLogRow>(buildApexLogQuery(config.pageSize));
        loaded = result.records;
        clearSfError(errPanel);
        errPanel.style.display = 'none';
        renderRows();
      } catch (err) {
        loaded = [];
        while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
        selectedRow = null;
        status.textContent = '';
        setSfError(errPanel, err, { doc });
        errPanel.style.display = 'block';
      }
    }

    filterField.addEventListener('input', renderRows);

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

    const logNoun = (n: number): string => `log${n === 1 ? '' : 's'}`;

    /**
     * Count every ApexLog in the org, with a busy affordance on the trigger.
     *
     * Split out of `deleteAll()`, and the split IS the fix rather than tidying.
     * This phase is a genuinely slow paginated fetch that needs the button
     * disabled; the confirm dialog that follows restores focus to whatever
     * opened it, and `.focus()` on a disabled element is a specified no-op. One
     * `disabled` held across both phases therefore cancels the focus restore —
     * #326's B1, which was fixed in the SOQL runner and left live here, with
     * the whole suite green. Moving a single line was not available: it would
     * have taken the busy affordance off the fetch. Separating the two gives
     * each phase its own, and `test/confirm-dialog-trigger-contract.test.ts`
     * now fails if they are ever put back in one body.
     *
     * Returns null when the count failed; the user has already been told.
     */
    async function countAllLogIds(): Promise<string[] | null> {
      // Disabling the FOCUSED element hands focus to <body> in a real browser,
      // so the busy affordance would otherwise do exactly the damage the split
      // prevents: the dialog captures `doc.activeElement` when it opens, and by
      // then the trigger would no longer be it. Remembered against the same
      // expression the dialog reads, and put back with the button.
      const hadFocus = doc.activeElement === deleteBtn;
      deleteBtn.disabled = true;
      try {
        status.textContent = 'Counting logs…';
        return await fetchAllLogIds();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), { doc, kind: 'error' });
        return null;
      } finally {
        // Re-enabled BEFORE anything can open a dialog. See above.
        deleteBtn.disabled = false;
        // …and only when the disable is what lost the focus. If the user moved
        // it somewhere real while the org was being counted, leave it there —
        // a busy affordance that yanks focus back is its own bug.
        if (hadFocus && (doc.activeElement === null || doc.activeElement === doc.body)) {
          deleteBtn.focus();
        }
      }
    }

    /** The destructive phase. The trigger goes disabled HERE, past the confirm. */
    async function deleteLogs(ids: readonly string[]): Promise<void> {
      deleteBtn.disabled = true;
      status.textContent = `Deleting ${ids.length} ${logNoun(ids.length)}…`;
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
        showToast(`Deleted ${ids.length} ${logNoun(ids.length)}.`, { doc, kind: 'success' });
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), { doc, kind: 'error' });
      } finally {
        deleteBtn.disabled = false;
        await load();
      }
    }

    // One run at a time. This is the re-entrancy guard the trigger's `disabled`
    // used to be, and it is a flag for the reason ui/confirm-dialog.ts's caller
    // contract gives: a disabled trigger cannot be focused, so it cannot be the
    // thing that keeps a modal from being opened twice.
    let deleteInFlight = false;

    // Bulk delete — clears ALL of the org's ApexLog rows (the standard "clear my
    // debug logs" dev action), not just the loaded page.
    async function deleteAll(): Promise<void> {
      if (deleteInFlight) return;
      deleteInFlight = true;
      try {
        const ids = await countAllLogIds();
        if (ids === null) {
          await load();
          return;
        }
        if (ids.length === 0) {
          showToast('No debug logs to delete.', { doc, kind: 'info' });
          await load();
          return;
        }
        const ok = await confirmDialog({
          doc,
          title: 'Delete debug logs',
          message: `Delete ${ids.length} ${logNoun(ids.length)}?`,
          confirmLabel: 'Delete',
        });
        if (!ok) return;
        await deleteLogs(ids);
      } finally {
        deleteInFlight = false;
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
    filterField.focus();
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
  return {
    buildApexLogQuery,
    formatBytes,
    buildLogDeleteEndpoint,
    AUTO_REFRESH_INTERVAL_MS,
    importApexLogText,
    MAX_IMPORT_BYTES,
  };
}
