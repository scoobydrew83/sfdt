// Debug Logs → "Analyze" view (P3-3). Renders a parsed Apex log for humans:
// per-method timings (sortable), governor-limit snapshots, and SOQL / DML /
// callout inventories whose "line N" controls deep-link into the raw log body
// shown alongside. The parser is this view's only data source — we take a
// ParsedLog (built by parseApexLog upstream) plus the raw text and never
// re-parse. Built with createElement + textContent only (zero innerHTML), tokens
// for every colour, and CONVENTIONS a11y (Esc closes, focus restore, native
// controls, labelled headers).

import {
  buildAnalyzerViewModel,
  sortMethodRows,
  formatNanosMs,
  methodKey,
  type AnalyzerViewModel,
  type MethodRow,
  type MethodSortKey,
} from '../lib/apex-log/viewmodel.js';
import type { ParsedLog, RawLineIndex } from '../lib/apex-log/types.js';
import { buildFlameChart, type FlameChartHandle } from './apex-log-flame-chart.js';
import { presentView, type ViewHandle } from './present-view.js';

export interface ApexLogAnalyzerOptions {
  /** The already-parsed log (parser is the single source of truth — no re-parse). */
  parsed: ParsedLog;
  /** The raw log body text, for the line-jump deep links. */
  rawText: string;
  /** Human label for the view header (e.g. the log operation). */
  title?: string;
  doc?: Document;
  onClose?: () => void;
}

const HEADING_CSS =
  'margin: 12px 0 6px; font-size: 13px; font-weight: 600; color: var(--sfdt-color-text);';
const TABLE_CSS =
  'border-collapse: collapse; width: 100%; font-size: 12px; color: var(--sfdt-color-text);';
const CELL_CSS =
  'padding: 4px 8px; border-bottom: 1px solid var(--sfdt-color-border); text-align: left;';
const NUM_CELL_CSS = CELL_CSS + ' text-align: right; font-variant-numeric: tabular-nums;';
const MUTED_CSS = 'font-size: 12px; color: var(--sfdt-color-text-weak);';

function cell(doc: Document, tag: 'td' | 'th', text: string, css: string): HTMLTableCellElement {
  const c = doc.createElement(tag);
  c.textContent = text;
  c.style.cssText = css;
  return c;
}

/** Present the analyzer overlay. Returns the ViewHandle (close() dismisses it). */
export function presentApexLogAnalyzer(opts: ApexLogAnalyzerOptions): ViewHandle {
  const doc = opts.doc ?? document;
  const vm = buildAnalyzerViewModel(opts.parsed);
  const previouslyFocused = doc.activeElement as HTMLElement | null;

  const body = doc.createElement('div');
  body.style.cssText =
    'padding: 12px 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 4px;';

  if (vm.truncated) body.appendChild(buildTruncationBanner(doc, vm));

  // Raw-log pane is built first so the inventory jump controls can target its
  // per-line elements.
  const { pane: rawPane, jumpTo } = buildRawLogPane(doc, opts.rawText);

  // Flame chart + method table are wired bidirectionally: selecting a frame
  // highlights its table row (chart→table, AC-1); activating a method name
  // highlights its frames (table→chart, keyboard-reachable).
  let flame: FlameChartHandle | null = null;
  const firstControl = buildMethodTable(doc, vm, {
    onMethodActivate: (ns, name) => flame?.highlightKey(ns, name),
  });
  body.appendChild(firstControl.section);

  flame = buildFlameChart({
    roots: opts.parsed.tree,
    doc,
    onSelectNode: (node) => {
      if (node) firstControl.highlightRow(node.namespace, node.name);
    },
  });
  const flameSection = doc.createElement('section');
  const flameHeading = doc.createElement('h3');
  flameHeading.textContent = 'Flame chart';
  flameHeading.style.cssText = HEADING_CSS;
  flameSection.append(flameHeading, flame.element);
  body.appendChild(flameSection);

  body.appendChild(buildLimitsSection(doc, vm));
  body.appendChild(buildInventorySection(doc, 'SOQL queries', vm.soql, jumpTo, (q) => q.query));
  body.appendChild(
    buildInventorySection(doc, 'DML operations', vm.dml, jumpTo, (d) =>
      `${d.op} ${d.sobject}${d.rows == null ? '' : ` (${d.rows} row${d.rows === 1 ? '' : 's'})`}`,
    ),
  );
  body.appendChild(
    buildInventorySection(doc, 'Callouts', vm.callouts, jumpTo, (c) =>
      `${c.method} ${c.endpoint}${c.status ? ` → ${c.status}` : ''}`,
    ),
  );

  const rawHeading = doc.createElement('h3');
  rawHeading.textContent = 'Raw log';
  rawHeading.style.cssText = HEADING_CSS;
  body.appendChild(rawHeading);
  body.appendChild(rawPane);

  const handle = presentView({
    title: `📊 Analyze — ${opts.title ?? 'Debug log'}`,
    body,
    doc,
    width: '960px',
    onClose: () => {
      cleanup();
      opts.onClose?.();
    },
  });

  // Esc closes + focus restore (CONVENTIONS 1 & 4) — presentView itself doesn't
  // wire Esc, so the overlay owns it. Capture phase so it fires from inside a
  // Salesforce-owned widget; removed on close so it can't leak across SPA navs.
  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handle.close();
    }
  };
  doc.addEventListener('keydown', onKeydown, true);
  let cleanedUp = false;
  function cleanup(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    doc.removeEventListener('keydown', onKeydown, true);
    flame?.destroy();
    previouslyFocused?.focus?.();
  }

  // Move focus into the overlay on open (item 8): the first sortable header.
  setTimeout(() => firstControl.firstHeaderButton.focus(), 0);

  return handle;
}

function buildTruncationBanner(doc: Document, vm: AnalyzerViewModel): HTMLElement {
  const banner = doc.createElement('div');
  banner.setAttribute('role', 'alert');
  banner.style.cssText =
    'padding: 8px 12px; border: 1px solid var(--sfdt-color-warning-border); background: var(--sfdt-color-warning-bg); color: var(--sfdt-color-warning-text); border-radius: 4px; font-size: 12px;';
  const reason = vm.truncationReason ?? 'unknown reason';
  banner.textContent = `⚠ This log was truncated (${reason}). Timings and inventories below may be incomplete.`;
  return banner;
}

interface MethodTableHandle {
  section: HTMLElement;
  firstHeaderButton: HTMLButtonElement;
  /** Highlight (and scroll to) the row for a method key — driven by the flame
   *  chart's frame selection, so chart→table selection stays in sync. */
  highlightRow(namespace: string | null, name: string): void;
}

interface MethodTableCallbacks {
  /** A method-name button was activated (click/Enter) — used to highlight the
   *  matching frames in the flame chart (table→chart, keyboard-reachable). */
  onMethodActivate?: (namespace: string | null, name: string) => void;
}

function buildMethodTable(
  doc: Document,
  vm: AnalyzerViewModel,
  cb: MethodTableCallbacks = {},
): MethodTableHandle {
  const section = doc.createElement('section');
  const heading = doc.createElement('h3');
  heading.textContent = 'Method timings';
  heading.style.cssText = HEADING_CSS;
  section.appendChild(heading);

  if (vm.methods.length === 0) {
    const empty = doc.createElement('div');
    empty.textContent = 'No method or code-unit frames in this log.';
    empty.style.cssText = MUTED_CSS;
    section.appendChild(empty);
    // A disabled placeholder button keeps the focus contract simple when empty.
    const placeholder = doc.createElement('button');
    placeholder.type = 'button';
    placeholder.style.cssText = 'position: absolute; width: 1px; height: 1px; overflow: hidden;';
    placeholder.setAttribute('aria-hidden', 'true');
    placeholder.tabIndex = -1;
    section.appendChild(placeholder);
    return { section, firstHeaderButton: placeholder, highlightRow: () => {} };
  }

  // key → current <tr>; rebuilt on each render (sort rebuilds the tbody).
  const rowByKey = new Map<string, HTMLTableRowElement>();
  let highlightedKey: string | null = null;

  const table = doc.createElement('table');
  table.style.cssText = TABLE_CSS;
  const thead = doc.createElement('thead');
  const headRow = doc.createElement('tr');

  headRow.appendChild(cell(doc, 'th', 'Method', CELL_CSS));
  headRow.appendChild(cell(doc, 'th', 'Namespace', CELL_CSS));

  let sortKey: MethodSortKey = 'total';
  const tbody = doc.createElement('tbody');

  const sortableCols: { key: MethodSortKey; label: string }[] = [
    { key: 'total', label: 'Total' },
    { key: 'self', label: 'Self' },
    { key: 'count', label: 'Count' },
  ];

  const headerButtons = new Map<MethodSortKey, { th: HTMLTableCellElement; btn: HTMLButtonElement }>();
  for (const col of sortableCols) {
    const th = doc.createElement('th');
    th.setAttribute('aria-sort', 'none');
    th.style.cssText = CELL_CSS + ' text-align: right;';
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.textContent = col.label;
    btn.setAttribute('aria-label', `Sort by ${col.label.toLowerCase()} descending`);
    btn.style.cssText =
      'background: none; border: 0; padding: 0; cursor: pointer; font: inherit; font-weight: 600; color: var(--sfdt-color-brand-text);';
    btn.addEventListener('click', () => {
      sortKey = col.key;
      renderRows();
    });
    th.appendChild(btn);
    headRow.appendChild(th);
    headerButtons.set(col.key, { th, btn });
  }

  thead.appendChild(headRow);
  table.appendChild(thead);
  table.appendChild(tbody);

  function renderRows(): void {
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
    rowByKey.clear();
    for (const [key, { th, btn }] of headerButtons) {
      const active = key === sortKey;
      th.setAttribute('aria-sort', active ? 'descending' : 'none');
      const label = sortableCols.find((c) => c.key === key)!.label;
      btn.textContent = active ? `${label} ▼` : label;
    }
    for (const row of sortMethodRows(vm.methods, sortKey)) appendRow(row);
    applyHighlight(); // re-apply across a sort re-render
  }

  function appendRow(row: MethodRow): void {
    const tr = doc.createElement('tr');
    rowByKey.set(methodKey(row.namespace, row.name), tr);

    // The method name is a button so table→chart selection is keyboard-reachable
    // (the table stays the fully accessible representation — CONVENTIONS a11y).
    const nameCell = doc.createElement('td');
    nameCell.style.cssText = CELL_CSS;
    const nameBtn = doc.createElement('button');
    nameBtn.type = 'button';
    nameBtn.textContent = row.name;
    nameBtn.setAttribute('aria-label', `Highlight ${row.name} in the flame chart`);
    nameBtn.style.cssText =
      'background: none; border: 0; padding: 0; cursor: pointer; font: inherit; text-align: left; color: var(--sfdt-color-brand-text);';
    nameBtn.addEventListener('click', () => cb.onMethodActivate?.(row.namespace, row.name));
    nameCell.appendChild(nameBtn);
    tr.appendChild(nameCell);

    tr.appendChild(cell(doc, 'td', row.namespace ?? '—', CELL_CSS));
    const total = cell(doc, 'td', formatNanosMs(row.totalNanos), NUM_CELL_CSS);
    total.title = `${row.totalNanos} ns`;
    tr.appendChild(total);
    const self = cell(doc, 'td', formatNanosMs(row.selfNanos), NUM_CELL_CSS);
    self.title = `${row.selfNanos} ns`;
    tr.appendChild(self);
    tr.appendChild(cell(doc, 'td', String(row.count), NUM_CELL_CSS));
    tbody.appendChild(tr);
  }

  function applyHighlight(): void {
    for (const [key, tr] of rowByKey) {
      const on = key === highlightedKey;
      tr.style.background = on ? 'var(--sfdt-color-warning-bg)' : '';
    }
  }

  function highlightRow(namespace: string | null, name: string): void {
    highlightedKey = methodKey(namespace, name);
    applyHighlight();
    rowByKey.get(highlightedKey)?.scrollIntoView?.({ block: 'nearest' });
  }

  renderRows();
  section.appendChild(table);
  return { section, firstHeaderButton: headerButtons.get('total')!.btn, highlightRow };
}

function buildLimitsSection(doc: Document, vm: AnalyzerViewModel): HTMLElement {
  const section = doc.createElement('section');
  const heading = doc.createElement('h3');
  heading.textContent = 'Governor limits';
  heading.style.cssText = HEADING_CSS;
  section.appendChild(heading);

  if (vm.limits.length === 0) {
    const empty = doc.createElement('div');
    empty.textContent = 'No governor-limit snapshot in this log.';
    empty.style.cssText = MUTED_CSS;
    section.appendChild(empty);
    return section;
  }

  for (const snap of vm.limits) {
    const nsLabel = doc.createElement('div');
    nsLabel.textContent = snap.namespace || '(default)';
    nsLabel.style.cssText = 'margin: 8px 0 2px; font-size: 12px; font-weight: 600; color: var(--sfdt-color-text-weak);';
    section.appendChild(nsLabel);

    const table = doc.createElement('table');
    table.style.cssText = TABLE_CSS;
    const tbody = doc.createElement('tbody');
    for (const [metric, pair] of Object.entries(snap.metrics)) {
      const tr = doc.createElement('tr');
      tr.appendChild(cell(doc, 'td', metric, CELL_CSS));
      tr.appendChild(cell(doc, 'td', `${pair.used} / ${pair.max}`, NUM_CELL_CSS));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    section.appendChild(table);
  }
  return section;
}

interface HasLine {
  line: RawLineIndex;
}

function buildInventorySection<T extends HasLine>(
  doc: Document,
  title: string,
  entries: T[],
  jumpTo: (line: RawLineIndex) => void,
  describe: (entry: T) => string,
): HTMLElement {
  const section = doc.createElement('section');
  const heading = doc.createElement('h3');
  heading.textContent = `${title} (${entries.length})`;
  heading.style.cssText = HEADING_CSS;
  section.appendChild(heading);

  if (entries.length === 0) {
    const empty = doc.createElement('div');
    empty.textContent = `No ${title.toLowerCase()}.`;
    empty.style.cssText = MUTED_CSS;
    section.appendChild(empty);
    return section;
  }

  const list = doc.createElement('ul');
  list.style.cssText = 'list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px;';
  for (const entry of entries) {
    const li = doc.createElement('li');
    li.style.cssText =
      'display: flex; gap: 8px; align-items: baseline; font-size: 12px; padding: 3px 0; border-bottom: 1px solid var(--sfdt-color-bg);';

    const jump = doc.createElement('button');
    jump.type = 'button';
    // Displayed 1-based for humans; jumpTo takes the parser's 0-based index.
    jump.textContent = `line ${entry.line + 1}`;
    jump.setAttribute('aria-label', `Jump to line ${entry.line + 1} in the raw log`);
    jump.style.cssText =
      'flex: none; background: none; border: 0; padding: 0; cursor: pointer; font: inherit; color: var(--sfdt-color-brand-text); text-decoration: underline;';
    jump.addEventListener('click', () => jumpTo(entry.line));

    const payload = doc.createElement('span');
    payload.textContent = describe(entry);
    payload.style.cssText = 'font-family: ui-monospace, monospace; color: var(--sfdt-color-text); word-break: break-word;';

    li.append(jump, payload);
    list.appendChild(li);
  }
  section.appendChild(list);
  return section;
}

interface RawLogPane {
  pane: HTMLElement;
  jumpTo: (line: RawLineIndex) => void;
}

// ponytail: one <div> per line — O(lines) nodes. Fine for a deliberately-opened
// dev tool at typical log sizes; virtualize only if multi-hundred-thousand-line
// logs prove slow.
function buildRawLogPane(doc: Document, rawText: string): RawLogPane {
  const pane = doc.createElement('div');
  pane.setAttribute('role', 'region');
  pane.setAttribute('aria-label', 'Raw log body');
  pane.tabIndex = 0;
  pane.style.cssText =
    'margin: 0; padding: 10px; background: var(--sfdt-color-code-bg); color: var(--sfdt-color-border-3); border-radius: 4px; overflow: auto; max-height: 320px; font-family: ui-monospace, monospace; font-size: 11px; white-space: pre; line-height: 1.5;';

  const lineEls: HTMLElement[] = [];
  const lines = rawText.split('\n');
  for (const text of lines) {
    const lineEl = doc.createElement('div');
    // Non-empty so blank lines keep height and remain a scroll target.
    lineEl.textContent = text === '' ? ' ' : text;
    lineEls.push(lineEl);
    pane.appendChild(lineEl);
  }

  let highlighted: HTMLElement | null = null;
  function jumpTo(line: RawLineIndex): void {
    const target = lineEls[line];
    if (!target) return;
    if (highlighted && highlighted !== target) {
      highlighted.style.background = '';
      highlighted.removeAttribute('data-sfdt-highlighted');
    }
    target.style.background = 'var(--sfdt-color-warning-bg)';
    target.setAttribute('data-sfdt-highlighted', 'true');
    highlighted = target;
    target.scrollIntoView?.({ block: 'center' });
  }

  return { pane, jumpTo };
}
