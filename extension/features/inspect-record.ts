import { CONTEXTS, extractRecordContext } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import {
  getSalesforceApi,
  sfApiErrorKind,
  SalesforceRestError,
  type SalesforceApiClient,
} from '../lib/salesforce-api.js';
import {
  getDescribeCache,
  type FieldDescribe,
  type SObjectDescribe,
  type GlobalDescribe,
} from '../lib/describe-cache.js';
import {
  classifyFieldEditability,
  formatForInput,
  buildDirtyDiff,
  mapSaveErrors,
  type FieldEditability,
} from '../lib/record-edit.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { setSfError } from '../ui/panels.js';
import { setTone, button, setLabel } from '../lib/ui-controls.js';
import { copyToClipboard } from '../ui/clipboard.js';

// Describe types come from lib/describe-cache.ts. This file used to declare its
// own narrow FieldDescribe (name/label/type/updateable/relationshipName/
// referenceTo) and its own two caches; the shared ones already carry
// picklistValues, scale, and the P4-1 permission block, and re-declaring them
// here is exactly the second describe layer the design forbids.

export function isRecordId(id: string): boolean {
  return typeof id === 'string'
    && /^[a-zA-Z0-9]{15,18}$/.test(id)
    && !id.startsWith('000')
    && /[0-9]/.test(id.slice(0, 5));
}

/**
 * What a save attempt turned out to be.
 *
 * A single PATCH is ONE DML transaction: Salesforce commits every field in the
 * body or rolls the whole thing back. There is no per-field partial apply to
 * report, so the UI claims exactly one of these and never anything in between.
 *
 * `unknown` is the one that matters. It exists because "rejected" is only a
 * truthful claim when the response actually ARRIVED — a bus timeout means the
 * worker never answered, so the write may well have committed. Reporting that
 * as a failure invites a retry that duplicates it.
 */
export type SaveOutcome =
  | { status: 'saved'; fieldCount: number }
  | { status: 'rejected'; bannerText: string }
  | { status: 'unknown'; detail: string }
  | { status: 'no-session'; detail: string };

/**
 * The outcome as text.
 *
 * Text rather than DOM, and pure rather than inline, so the three claims can be
 * asserted exactly — the same reason `formatBulkDeleteReport` in
 * features/soql-bulk-delete.ts is shaped this way. The wording is the contract:
 * "No changes were saved" and "Save outcome unknown" are what the design doc
 * commits to, and a test that pins them is what stops a later edit softening
 * the distinction back into one vague "save failed".
 */
export function formatSaveOutcome(outcome: SaveOutcome): string {
  switch (outcome.status) {
    case 'saved':
      return outcome.fieldCount === 1 ? 'Saved 1 field.' : `Saved ${outcome.fieldCount} fields.`;
    case 'rejected':
      return `No changes were saved. ${outcome.bannerText}`.trim();
    case 'unknown':
      return `Save outcome unknown — the record has been reloaded. ${outcome.detail}`.trim();
    case 'no-session':
      return `Not saved — no Salesforce session. ${outcome.detail}`.trim();
  }
}

/**
 * Classify a caught save error into an outcome.
 *
 * Branches on `sfApiErrorKind`'s discriminant, never on the shape of the
 * message — the same rule soql-bulk-delete follows. An unrecognised error is
 * treated as `unknown` rather than `rejected`: if we cannot tell that the org
 * answered, we must not claim nothing was saved.
 */
export function classifySaveError(err: unknown, bannerText: string): SaveOutcome {
  const detail = err instanceof Error ? err.message : String(err);
  switch (sfApiErrorKind(err)) {
    case 'http-error':
      return { status: 'rejected', bannerText };
    case 'no-session':
      return { status: 'no-session', detail };
    case 'timeout':
    default:
      return { status: 'unknown', detail };
  }
}

/** Short chip text per reason. The full sentence rides on `title`. */
const READ_ONLY_CHIP: Readonly<Record<string, string>> = {
  formula: 'formula',
  'auto-number': 'auto-number',
  system: 'system',
  'unsupported-type': 'not editable here',
  'no-permission': 'read-only for you',
};

/** A value carrying milliseconds needs a finer step, or the browser reports stepMismatch. */
function stepFor(value: string): string {
  return /\.\d{1,3}$/.test(value) ? '0.001' : '1';
}

/**
 * Build the control for one editable field.
 *
 * The type-to-control mapping is the design's rule — a field is editable iff
 * the DOM offers a native, lossless control and the wire format is unambiguous
 * — so every branch here has a counterpart in `EDITABLE_TYPES`. The initial
 * value always comes from `formatForInput`, never from `String(value)`: that is
 * what keeps a `date` off the `Date` constructor (and so off the day-shift bug
 * west of UTC) and what preserves the seconds a datetime carries.
 */
export function buildEditor(
  doc: Document,
  field: FieldDescribe,
  editability: FieldEditability & { editable: true },
  value: unknown,
): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const formatted = formatForInput(field, value);

  if (editability.type === 'picklist' || editability.type === 'multipicklist') {
    const select = doc.createElement('select');
    select.className = 'sfdt-field';
    if (editability.type === 'multipicklist') select.multiple = true;
    else {
      const blank = doc.createElement('option');
      blank.value = '';
      blank.textContent = '(none)';
      select.appendChild(blank);
    }
    const selected = new Set(Array.isArray(formatted) ? formatted : [String(formatted)]);
    // Decision 5: a dependent picklist renders its FULL value set. `validFor`
    // is a base64 bitmap and decoding it is its own correctness surface; the
    // org rejects an invalid combination, and that rejection lands on this
    // exact field because the error mapping makes it.
    for (const pv of field.picklistValues ?? []) {
      const opt = doc.createElement('option');
      opt.value = pv.value;
      opt.textContent = pv.label || pv.value;
      if (selected.has(pv.value)) opt.selected = true;
      select.appendChild(opt);
    }
    // An unrestricted picklist accepts values outside the list, so the current
    // value must survive even when the describe has never heard of it.
    for (const v of selected) {
      if (!v) continue;
      if (!(field.picklistValues ?? []).some((pv) => pv.value === v)) {
        const opt = doc.createElement('option');
        opt.value = v;
        opt.textContent = `${v} (not in picklist)`;
        opt.selected = true;
        select.appendChild(opt);
      }
    }
    // Setting `selected` on an option appended after the others does not
    // reliably move a single-select's value — say it outright.
    if (!select.multiple) {
      const first = [...selected][0];
      if (first !== undefined) select.value = String(first);
    }
    if (field.dependentPicklist === true) {
      select.title = `Depends on ${field.controllerName ?? 'another field'} — invalid combinations are rejected on save.`;
    }
    return select;
  }

  if (editability.type === 'textarea') {
    const ta = doc.createElement('textarea');
    ta.className = 'sfdt-field';
    ta.rows = 3;
    ta.value = String(formatted);
    return ta;
  }

  const input = doc.createElement('input');
  input.className = 'sfdt-field';
  const text = String(formatted);
  switch (editability.type) {
    case 'int': case 'double': case 'long': case 'currency': case 'percent':
      input.type = 'number';
      if (typeof field.scale === 'number' && field.scale > 0) {
        input.step = (1 / 10 ** field.scale).toFixed(field.scale);
      }
      break;
    case 'date':
      input.type = 'date';
      break;
    case 'datetime':
      input.type = 'datetime-local';
      input.step = stepFor(text);
      break;
    case 'time':
      input.type = 'time';
      input.step = stepFor(text);
      break;
    // No client-side format validation on these three — the server is
    // authoritative, and a browser that refuses a value the org would have
    // accepted is a worse failure than a round trip.
    case 'email': input.type = 'email'; break;
    case 'phone': input.type = 'tel'; break;
    case 'url': input.type = 'url'; break;
    case 'reference':
      input.type = 'text';
      input.placeholder = (field.referenceTo ?? []).join(', ') || 'Record Id';
      break;
    default:
      input.type = 'text';
  }
  input.value = text;
  return input;
}

/** Read a control back. Multi-selects yield an array; everything else its string. */
export function readEditor(el: HTMLElement): unknown {
  if (el instanceof HTMLSelectElement && el.multiple) {
    return Array.from(el.selectedOptions).map((o) => o.value);
  }
  if (el instanceof HTMLInputElement && el.type === 'checkbox') return el.checked;
  return (el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
}

export interface InspectRecordOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
}

/** The Inspect Record feature, plus an imperative opener for the context menu. */
export type InspectRecordFeature = Feature & {
  /** Open the inspector for a specific record Id (used by the right-click menu). */
  openFor: (recordId: string, sobjectName?: string) => Promise<void>;
};

export function createInspectRecordFeature(options: InspectRecordOptions = {}): InspectRecordFeature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();

  let view: ViewHandle | null = null;
  // The shared cache, not a private one: it already de-duplicates describes
  // across every feature in the page, so the inspector's second look at an
  // object it has seen is free rather than merely cheap.
  const describes = getDescribeCache(api);

  function close(): void {
    view?.close();
    view = null;
  }

  /**
   * Await a DescribeCache entry.
   *
   * The cache is built for reactive surfaces: it answers synchronously with
   * `{status:'loading'}` and notifies subscribers when the fetch lands. The
   * inspector's flow is `await`-shaped, so rather than restructure it — or,
   * worse, keep a private second cache alongside — this waits on the cache's
   * own notification. One cache, two consumption styles.
   */
  function awaitEntry<T>(read: () => { status: string; data?: T; error?: string }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const settle = (): boolean => {
        const entry = read();
        if (entry.status === 'ready' && entry.data !== undefined) {
          resolve(entry.data);
          return true;
        }
        if (entry.status === 'error') {
          // The cache has already annotated this with the org's errorCode and
          // guidance; re-wrapping it would only bury that.
          reject(new Error(entry.error ?? 'Describe failed'));
          return true;
        }
        return false;
      };
      if (settle()) return;
      const unsubscribe = describes.subscribe(() => {
        if (settle()) unsubscribe();
      });
    });
  }

  async function getSObjectDescribe(name: string): Promise<SObjectDescribe> {
    const data = await awaitEntry<SObjectDescribe>(() => describes.getSObject('rest', name));
    return data && Array.isArray(data.fields) ? data : ({ name, label: name, fields: [] } as SObjectDescribe);
  }

  async function resolveSObjectFromId(id: string): Promise<string | null> {
    const prefix = id.slice(0, 3);
    const globalDesc = await awaitEntry<GlobalDescribe>(() => describes.getGlobal('rest'));
    const match = globalDesc?.sobjects?.find((sobj) => sobj.keyPrefix === prefix);
    return match ? match.name : null;
  }

  async function open(initialRecordId?: string, initialSobjectName?: string): Promise<void> {
    close();

    const body = doc.createElement('div');
    body.style.cssText = 'display: flex; flex-direction: column; flex: 1; min-height: 0;';

    // Record identity, shown as the view's subtitle. presentView renders it in
    // the modal header and in the Workspace pane head, so the record being
    // inspected is stated once and reads the same on every surface. The two
    // spans concatenate to "Account · 001…" — one string, two type treatments.
    const recordInfo = doc.createElement('span');
    const recordObj = doc.createElement('span');
    recordObj.textContent = 'No record loaded';
    const recordIdSpan = doc.createElement('span');
    recordIdSpan.className = 'sfdt-mono';
    setTone(recordIdSpan, 'info');
    recordInfo.append(recordObj, recordIdSpan);

    // Fields / JSON toggle. Lives in the header rather than the body: it selects
    // between two renderings of the same record, which is identity, not content.
    // Hidden until a record is loaded — there is nothing to toggle before that.
    const viewToggleRow = doc.createElement('div');
    viewToggleRow.className = 'sfdt-segment';
    viewToggleRow.style.display = 'none';
    viewToggleRow.setAttribute('role', 'group');
    viewToggleRow.setAttribute('aria-label', 'Record view mode');
    const fieldsTabBtn = doc.createElement('button');
    fieldsTabBtn.type = 'button';
    fieldsTabBtn.textContent = 'Fields';
    const jsonTabBtn = doc.createElement('button');
    jsonTabBtn.type = 'button';
    jsonTabBtn.textContent = 'JSON';
    viewToggleRow.append(fieldsTabBtn, jsonTabBtn);

    const toolbar = doc.createElement('div');
    toolbar.className = 'sfdt-toolbar';

    // Filter + null toggle apply to a loaded record, so they appear with one.
    const filterWrap = doc.createElement('div');
    filterWrap.className = 'sfdt-toolbar-grow';
    filterWrap.style.display = 'none';
    const filterInput = doc.createElement('input');
    filterInput.className = 'sfdt-field';
    filterInput.type = 'search';
    filterInput.setAttribute('aria-label', 'Filter fields');
    filterInput.placeholder = 'Filter fields by label, API name, or value...';
    filterWrap.appendChild(filterInput);

    const checkboxLabel = doc.createElement('label');
    checkboxLabel.className = 'sfdt-check';
    checkboxLabel.style.display = 'none';
    const showNullsCheckbox = doc.createElement('input');
    showNullsCheckbox.type = 'checkbox';
    showNullsCheckbox.checked = true;
    checkboxLabel.appendChild(showNullsCheckbox);
    checkboxLabel.appendChild(doc.createTextNode('Show null values'));

    const idWrap = doc.createElement('div');
    idWrap.className = 'sfdt-toolbar-end';
    idWrap.classList.add('sfdt-row');
    const idInput = doc.createElement('input');
    idInput.className = 'sfdt-field sfdt-mono';
    idInput.setAttribute('aria-label', 'Salesforce record Id');
    idInput.placeholder = 'Paste Salesforce Record ID (e.g. 001800000000001AAA)';
    idInput.style.width = '19ch';
    const inspectBtn = button({ label: 'Inspect', iconName: 'search', variant: 'primary', doc });
    idWrap.append(idInput, inspectBtn);

    toolbar.append(filterWrap, checkboxLabel, idWrap);
    body.appendChild(toolbar);

    // The table owns the remaining height and scrolls inside it, so the sticky
    // `.sfdt-table th` header stays put and the toolbar never scrolls away.
    const tableContainer = doc.createElement('div');
    tableContainer.style.cssText = 'flex: 1; min-height: 0; overflow: auto; display: none;';
    body.appendChild(tableContainer);

    // Raw-JSON view: the REST record payload, pretty-printed with a copy button.
    const jsonContainer = doc.createElement('div');
    jsonContainer.style.cssText = 'display: none; flex-direction: column; gap: var(--sfdt-space-2); padding: var(--sfdt-space-4); flex: 1; min-height: 0; overflow: auto;';
    const jsonCopyRow = doc.createElement('div');
    jsonCopyRow.classList.add('sfdt-row');
    const jsonCopyBtn = button({ label: 'Copy JSON', iconName: 'clipboard', small: true, doc });
    jsonCopyRow.appendChild(jsonCopyBtn);
    const jsonPre = doc.createElement('pre');
    jsonPre.className = 'sfdt-mono';
    jsonPre.style.cssText = 'margin: 0; white-space: pre-wrap; word-break: break-word; color: var(--sfdt-color-text-strong);';
    jsonContainer.appendChild(jsonCopyRow);
    jsonContainer.appendChild(jsonPre);
    body.appendChild(jsonContainer);

    // Footer carries two strips: the save bar (only while dirty) above a
    // permanent count line, so "how much am I not seeing?" is always answerable
    // — the filter and the null toggle both hide rows silently otherwise.
    const footer = doc.createElement('div');
    // Form-level save banner: object-level validation rules, row locks, trigger
    // addError() on the record, and any field error whose field is not rendered
    // (which is why the banner names that field explicitly).
    const saveBanner = doc.createElement('div');
    saveBanner.style.display = 'none';
    const saveBar = doc.createElement('div');
    saveBar.className = 'sfdt-toolbar sfdt-toolbar-foot';
    saveBar.style.display = 'none';
    const dirtyNote = doc.createElement('span');
    dirtyNote.className = 'sfdt-caps';
    const saveActions = doc.createElement('div');
    saveActions.className = 'sfdt-toolbar-end';
    saveActions.classList.add('sfdt-row');
    const cancelChangesBtn = button({ label: 'Cancel', ariaLabel: 'Discard unsaved changes', small: true, doc });
    const saveChangesBtn = button({ label: 'Save Changes', iconName: 'save', variant: 'primary', small: true, doc });
    saveActions.append(cancelChangesBtn, saveChangesBtn);
    saveBar.append(dirtyNote, saveActions);

    const statusBar = doc.createElement('div');
    statusBar.className = 'sfdt-toolbar sfdt-toolbar-foot';
    statusBar.style.display = 'none';
    const countNote = doc.createElement('span');
    countNote.className = 'sfdt-caps';
    countNote.setAttribute('role', 'status');
    const hiddenNote = doc.createElement('span');
    hiddenNote.className = 'sfdt-caps';
    statusBar.append(countNote, hiddenNote);
    footer.append(saveBanner, saveBar, statusBar);

    // Assigned once the record state below exists. presentView only calls it on
    // a dismissal (Escape, backdrop), never on an explicit close().
    let confirmDiscard: () => boolean = () => true;

    view = presentView({
      title: 'Inspect Record',
      iconName: 'record',
      subtitle: recordInfo,
      headerActions: viewToggleRow,
      body,
      footer,
      doc,
      width: '900px',
      confirmClose: () => confirmDiscard(),
      onClose: () => {
        view = null;
      },
    });

    let activeRecordId = '';
    let activeSobjectName = '';
    let originalRecordData: Record<string, unknown> = {};
    let editedRecordData: Record<string, unknown> = {};
    let rawRecordData: Record<string, unknown> = {};
    let activeDescribe: SObjectDescribe | null = null;
    let currentView: 'fields' | 'json' = 'fields';
    // Field errors from the last rejected save, keyed lower-case because the org
    // echoes back its own casing, not the describe's.
    let fieldErrorMessages = new Map<string, string>();
    // Set during a render pass so a failed save can scroll to the first bad row.
    let firstErrorRow: HTMLElement | null = null;

    // `.sfdt-segment > button[aria-pressed="true"]` carries the appearance; this
    // only has to state the truth the CSS selects on.
    function styleToggleBtn(btn: HTMLButtonElement, active: boolean): void {
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }

    function renderJson(): void {
      jsonPre.textContent = JSON.stringify(rawRecordData, null, 2);
    }

    function applyView(): void {
      const isJson = currentView === 'json';
      styleToggleBtn(fieldsTabBtn, !isJson);
      styleToggleBtn(jsonTabBtn, isJson);
      filterWrap.style.display = isJson ? 'none' : 'block';
      checkboxLabel.style.display = isJson ? 'none' : 'inline-flex';
      statusBar.style.display = isJson ? 'none' : 'flex';
      tableContainer.style.display = isJson ? 'none' : 'block';
      jsonContainer.style.display = isJson ? 'flex' : 'none';
      if (isJson) renderJson();
    }

    function renderFields(): void {
      if (!activeDescribe) return;
      firstErrorRow = null;
      while (tableContainer.firstChild) tableContainer.removeChild(tableContainer.firstChild);

      const table = doc.createElement('table');
      table.className = 'sfdt-table';

      const thead = doc.createElement('thead');
      const headRow = doc.createElement('tr');
      const headers = ['Label', 'API Name', 'Type', 'Value'];
      for (const h of headers) {
        const th = doc.createElement('th');
        th.textContent = h;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = doc.createElement('tbody');
      const filterText = filterInput.value.toLowerCase().trim();
      const showNulls = showNullsCheckbox.checked;
      let shown = 0;
      let hiddenByNull = 0;

      for (const field of activeDescribe.fields) {
        const rawValue = editedRecordData[field.name];
        const isNull = rawValue === null || rawValue === undefined || rawValue === '';
        if (isNull && !showNulls) {
          hiddenByNull += 1;
          continue;
        }

        const valStr = String(rawValue ?? '');
        const matchesFilter = 
          field.name.toLowerCase().includes(filterText) ||
          field.label.toLowerCase().includes(filterText) ||
          field.type.toLowerCase().includes(filterText) ||
          valStr.toLowerCase().includes(filterText);
        
        if (filterText && !matchesFilter) continue;

        shown += 1;
        const tr = doc.createElement('tr');

        const tdLabel = doc.createElement('td');
        const labelSpan = doc.createElement('span');
        labelSpan.className = 'sfdt-cell-strong';
        labelSpan.textContent = field.label;
        tdLabel.appendChild(labelSpan);

        const tdApi = doc.createElement('td');
        tdApi.className = 'sfdt-cell-code';
        tdApi.textContent = field.name;

        // The type name is the information; the chip is just the frame for it.
        // (This replaced an emoji-per-type map — an emoji renders at the mercy
        // of the platform font and carried nothing the word next to it didn't.)
        const tdType = doc.createElement('td');
        const typePill = doc.createElement('span');
        typePill.className = 'sfdt-pill sfdt-square';
        typePill.textContent = field.type;
        tdType.appendChild(typePill);

        const tdValue = doc.createElement('td');
        tdValue.classList.add('sfdt-anchor');

        const isDirty = originalRecordData[field.name] !== rawValue;
        if (isDirty) {
          // Unsaved edit. Colour is a reinforcement here, not the signal — the
          // save bar below states the count in words.
          tr.classList.add('sfdt-row-flagged');
        }

        const editability = classifyFieldEditability(field, 'update');

        if (!editability.editable) {
          // AC-2: nothing is filtered out of the VIEW, only out of the payload.
          // The row still renders, and it carries the reason — a field that
          // simply refuses to accept typing, with no explanation, is the
          // silent-drop this criterion exists to prevent.
          const readSpan = doc.createElement('span');
          readSpan.textContent = isNull ? '(null)' : valStr;
          if (isNull) {
            readSpan.className = 'sfdt-null';
          } else if (isRecordId(valStr)) {
            setTone(readSpan, 'info');
            readSpan.classList.add('sfdt-link');
            readSpan.addEventListener('click', () => void navigateToRecord(valStr));
          }
          const reasonChip = doc.createElement('span');
          reasonChip.className = 'sfdt-pill sfdt-square';
          reasonChip.id = `sfdt-why-${field.name}`;
          reasonChip.textContent = READ_ONLY_CHIP[editability.reason] ?? 'read-only';
          reasonChip.title = editability.message;
          readSpan.setAttribute('aria-describedby', reasonChip.id);
          const wrap = doc.createElement('div');
          wrap.className = 'sfdt-row sfdt-row-between';
          wrap.append(readSpan, reasonChip);
          tdValue.appendChild(wrap);
        } else if (field.type === 'boolean') {
          const chk = doc.createElement('input');
          chk.type = 'checkbox';
          chk.checked = formatForInput(field, rawValue) === true;
          chk.setAttribute('aria-label', `${field.label} value`);
          chk.addEventListener('change', () => {
            editedRecordData[field.name] = chk.checked;
            updateSaveBar();
            renderFields();
          });
          tdValue.appendChild(chk);
        } else if (editability.editable) {
          const control = buildEditor(doc, field, editability, rawValue);
          control.setAttribute('aria-label', `${field.label} value`);
          const commit = () => {
            editedRecordData[field.name] = readEditor(control);
            updateSaveBar();
            renderFields();
          };
          // `change` rather than `input`: renderFields() rebuilds the whole
          // table, so committing per keystroke would tear the focused control
          // out from under the caret on every character.
          control.addEventListener('change', commit);
          if (control instanceof HTMLInputElement && control.type !== 'checkbox') {
            control.addEventListener('blur', commit);
            control.addEventListener('keydown', (e) => {
              if ((e as KeyboardEvent).key === 'Enter') commit();
              if ((e as KeyboardEvent).key === 'Escape') {
                // Abandon this cell, not the inspector. present-view listens on
                // the document, so without stopping this the whole view would
                // close and take every other unsaved edit with it.
                e.stopPropagation();
                control.value = String(formatForInput(field, originalRecordData[field.name]));
              }
            });
          }
          const wrap = doc.createElement('div');
          wrap.className = 'sfdt-row';
          wrap.appendChild(control);
          if (fieldErrorMessages.has(field.name.toLowerCase())) {
            tr.classList.add('sfdt-row-error');
            const err = doc.createElement('div');
            err.className = 'sfdt-field-error';
            err.style.cssText = 'white-space: pre-line; color: var(--sfdt-color-danger-text);';
            err.id = `sfdt-err-${field.name}`;
            err.setAttribute('role', 'alert');
            err.textContent = fieldErrorMessages.get(field.name.toLowerCase()) ?? '';
            control.setAttribute('aria-describedby', err.id);
            const cell = doc.createElement('div');
            cell.append(wrap, err);
            tdValue.appendChild(cell);
            if (!firstErrorRow) firstErrorRow = tr;
          } else {
            tdValue.appendChild(wrap);
          }
        }

        tr.appendChild(tdLabel);
        tr.appendChild(tdApi);
        tr.appendChild(tdType);
        tr.appendChild(tdValue);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      tableContainer.appendChild(table);
      tableContainer.style.display = 'block';

      const total = activeDescribe.fields.length;
      countNote.textContent = shown === total
        ? `Fields: ${total}`
        : `Fields: ${shown} of ${total}`;
      // Two ways a row can be missing, and they are fixed by different controls
      // — so they are counted separately rather than lumped into "hidden".
      const hiddenByFilter = total - shown - hiddenByNull;
      const parts: string[] = [];
      if (hiddenByNull) parts.push(`${hiddenByNull} null`);
      if (hiddenByFilter > 0) parts.push(`${hiddenByFilter} filtered`);
      hiddenNote.textContent = parts.length ? `Hidden: ${parts.join(' · ')}` : '';
      statusBar.style.display = currentView === 'json' ? 'none' : 'flex';
    }

    /**
     * The one dirty computation.
     *
     * The save bar and the PATCH body are now the same call, so they cannot
     * disagree — before P4-1 this file ran two independent `!==` walks for the
     * two questions, and the editors wrote strings while the baseline held
     * JSON-typed values, so an untouched number could read as dirty in one and
     * clean in the other.
     */
    function currentDiff() {
      return buildDirtyDiff(activeDescribe, originalRecordData, editedRecordData);
    }

    function updateSaveBar(): void {
      const { changedFieldNames } = currentDiff();
      const dirtyCount = changedFieldNames.length;
      saveBar.style.display = dirtyCount ? 'flex' : 'none';
      dirtyNote.textContent = dirtyCount === 1
        ? '1 unsaved change'
        : `${dirtyCount} unsaved changes`;
    }

    /** True while the record holds edits that have not reached the org. */
    function isDirty(): boolean {
      return currentDiff().changedFieldNames.length > 0;
    }

    /**
     * Show or clear the form-level save banner.
     *
     * Rendered through the shared `setSfError` when there is an error to carry,
     * so the org's own words and our guidance land as separate nodes — the org's
     * text can be multi-line (an Apex compile error is), and re-splitting
     * `err.message` by hand loses that.
     */
    function setSaveBanner(text: string | null, err?: unknown): void {
      if (!text) {
        saveBanner.style.display = 'none';
        while (saveBanner.firstChild) saveBanner.removeChild(saveBanner.firstChild);
        return;
      }
      saveBanner.style.display = 'block';
      while (saveBanner.firstChild) saveBanner.removeChild(saveBanner.firstChild);
      saveBanner.setAttribute('role', 'alert');
      // Our verdict first — "No changes were saved" is the sentence the user
      // needs before anything else — then the org's own words underneath it, in
      // their own nodes.
      const lead = doc.createElement('div');
      lead.className = 'sfdt-cell-strong';
      lead.textContent = text;
      saveBanner.appendChild(lead);
      if (err !== undefined) {
        const orgWords = doc.createElement('div');
        setSfError(orgWords, err, { doc });
        saveBanner.appendChild(orgWords);
      }
    }

    /**
     * Re-read the record from the org and rebuild both maps from the response.
     *
     * Used after a success AND after an unknown outcome — in both cases the only
     * trustworthy answer about what the record now holds is the server's.
     */
    async function reloadActiveRecord(): Promise<void> {
      if (!activeRecordId || !activeSobjectName || !activeDescribe) return;
      const apiVersion = api.apiVersion;
      const fresh = await api.apiGet<Record<string, unknown>>(
        `/services/data/${apiVersion}/sobjects/${activeSobjectName}/${activeRecordId}`,
      );
      rawRecordData = fresh ?? {};
      originalRecordData = {};
      editedRecordData = {};
      for (const field of activeDescribe.fields) {
        const val = rawRecordData[field.name];
        originalRecordData[field.name] = val;
        editedRecordData[field.name] = val;
      }
      renderFields();
      updateSaveBar();
      if (currentView === 'json') renderJson();
    }

    async function navigateToRecord(targetId: string): Promise<void> {
      try {
        const resolvedSobj = await resolveSObjectFromId(targetId);
        if (resolvedSobj) {
          activeRecordId = targetId;
          activeSobjectName = resolvedSobj;
          idInput.value = targetId;
          await loadRecord();
        } else {
          showToast('Could not resolve SObject for referenced ID', { doc, kind: 'error' });
        }
      } catch (err) {
        // Following a lookup fails most often because the user cannot read the
        // referenced record. "Navigation failed" hid exactly the sentence that
        // said so.
        showToast(`Navigation failed — ${err instanceof Error ? err.message : String(err)}`, {
          doc,
          kind: 'error',
        });
      }
    }

    async function loadRecord(): Promise<void> {
      const recordId = idInput.value.trim();
      if (!isRecordId(recordId)) {
        showToast('Please enter a valid 15 or 18 character Salesforce ID', { doc, kind: 'warning' });
        return;
      }
      inspectBtn.disabled = true;
      setLabel(inspectBtn, 'Loading…');
      try {
        let sobject = activeSobjectName;
        if (!sobject) {
          const resolved = await resolveSObjectFromId(recordId);
          if (!resolved) {
            showToast('Unable to auto-detect SObject type for ID key prefix.', { doc, kind: 'error' });
            return;
          }
          sobject = resolved;
        }
        activeSobjectName = sobject;
        activeRecordId = recordId;

        const describe = await getSObjectDescribe(sobject);
        activeDescribe = describe;

        const apiVersion = api.apiVersion;
        const rawRecord = await api.apiGet<Record<string, unknown>>(
          `/services/data/${apiVersion}/sobjects/${sobject}/${recordId}`
        );
        rawRecordData = rawRecord;

        originalRecordData = {};
        editedRecordData = {};
        for (const field of describe.fields) {
          const val = rawRecord[field.name];
          originalRecordData[field.name] = val;
          editedRecordData[field.name] = val;
        }

        fieldErrorMessages = new Map();
        setSaveBanner(null);
        recordObj.textContent = `${sobject} · `;
        recordIdSpan.textContent = recordId;

        renderFields();
        updateSaveBar();
        viewToggleRow.style.display = 'inline-flex';
        applyView();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), { doc, kind: 'error' });
      } finally {
        inspectBtn.disabled = false;
        setLabel(inspectBtn, 'Inspect');
      }
    }

    inspectBtn.addEventListener('click', () => {
      activeSobjectName = ''; // reset so it auto-detects from the new ID prefix
      void loadRecord();
    });

    idInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        activeSobjectName = '';
        void loadRecord();
      }
    });

    filterInput.addEventListener('input', renderFields);
    showNullsCheckbox.addEventListener('change', renderFields);

    fieldsTabBtn.addEventListener('click', () => {
      currentView = 'fields';
      applyView();
    });
    jsonTabBtn.addEventListener('click', () => {
      currentView = 'json';
      applyView();
    });
    jsonCopyBtn.addEventListener('click', async () => {
      await copyToClipboard(JSON.stringify(rawRecordData, null, 2), { doc, win: win, label: 'Record JSON copied to clipboard' });
    });

    // CONVENTIONS.md item 2: a surface holding unsaved input must not
    // click-outside-dismiss. Escape and the backdrop now ask first; the ✕ and
    // an explicit close() still go straight through, because pressing the close
    // button IS the decision.
    confirmDiscard = () => {
      if (!isDirty()) return true;
      const count = currentDiff().changedFieldNames.length;
      return win.confirm(
        `Discard ${count} unsaved change${count === 1 ? '' : 's'} to this record?`,
      );
    };

    cancelChangesBtn.addEventListener('click', () => {
      editedRecordData = { ...originalRecordData };
      fieldErrorMessages = new Map();
      setSaveBanner(null);
      updateSaveBar();
      renderFields();
    });

    saveChangesBtn.addEventListener('click', async () => {
      const { patchBody, changedFieldNames } = currentDiff();
      if (changedFieldNames.length === 0) return;

      // Clear last attempt's errors before this one, or a fixed field keeps its
      // red message.
      fieldErrorMessages = new Map();
      setSaveBanner(null);

      saveChangesBtn.disabled = true;
      setLabel(saveChangesBtn, 'Saving…');
      try {
        const apiVersion = api.apiVersion;
        // Note: patchBody has a null prototype (buildDirtyDiff builds it with
        // Object.create(null) so a field named __proto__ lands as an own key).
        // Don't call .hasOwnProperty on it or coerce it to a string.
        await api.apiRequest(
          'PATCH',
          `/services/data/${apiVersion}/sobjects/${activeSobjectName}/${activeRecordId}`,
          patchBody,
        );
        const outcome: SaveOutcome = { status: 'saved', fieldCount: changedFieldNames.length };
        showToast(formatSaveOutcome(outcome), { doc, kind: 'success' });
        // Re-GET rather than trusting our own echo. Formula fields, roll-up
        // summaries, audit fields and anything a trigger touched are only
        // knowable from the server's copy — the old
        // `originalRecordData = { ...editedRecordData }` promoted the values we
        // SENT to the baseline, so the record on screen quietly stopped being
        // the record in the org.
        await reloadActiveRecord();
      } catch (err) {
        const details = err instanceof SalesforceRestError ? err.details : [];
        const rendered = (activeDescribe?.fields ?? []).map((f) => f.name);
        const { fieldErrors, bannerErrors } = mapSaveErrors(details, rendered);
        fieldErrorMessages = new Map(
          fieldErrors.map((fe) => [fe.field.toLowerCase(), fe.message]),
        );
        const bannerText = bannerErrors.map((b) => b.text).join(' ');
        const outcome = classifySaveError(err, bannerText);

        if (outcome.status === 'unknown') {
          // The worker never answered: the write MAY have committed. Say so and
          // reload, so what the user sees next is the org's answer rather than
          // our guess.
          setSaveBanner(formatSaveOutcome(outcome));
          showToast(formatSaveOutcome(outcome), { doc, kind: 'warning' });
          await reloadActiveRecord();
        } else {
          setSaveBanner(formatSaveOutcome(outcome), err);
          showToast(formatSaveOutcome(outcome), { doc, kind: 'error' });
          // An error must never land on a row the current filter is hiding —
          // that is the silent failure this whole criterion exists to prevent.
          if (fieldErrors.length > 0) {
            filterInput.value = '';
            showNullsCheckbox.checked = true;
          }
          // Dirty edits are preserved verbatim: nothing was saved, so the user
          // fixes and retries rather than retyping.
          renderFields();
          updateSaveBar();
          firstErrorRow?.scrollIntoView({ block: 'center' });
        }
      } finally {
        saveChangesBtn.disabled = false;
        setLabel(saveChangesBtn, 'Save Changes');
      }
    });

    // Handle initial inputs
    if (initialRecordId) {
      idInput.value = initialRecordId;
      activeRecordId = initialRecordId;
      if (initialSobjectName) {
        activeSobjectName = initialSobjectName;
      }
      void loadRecord();
    }

    // No Esc handler here: presentAsModal owns it, and it checks which overlay
    // is on top first. A doc-level handler in this file closed the inspector
    // AND whatever opened it — the SOQL runner's own handler is registered
    // earlier, so one Escape from the inspector tore down the query underneath.
  }

  return {
    manifest: {
      id: 'inspect-record',
      name: 'Inspect Record',
      contexts: [
        CONTEXTS.SETUP_FLOWS,
        CONTEXTS.SETUP_OTHER,
        CONTEXTS.FLOW_BUILDER,
        CONTEXTS.FLOW_TRIGGER_EXPLORER,
        CONTEXTS.RECORD_PAGE,
      ],
    },

    async onActivate() {
      const url = win.location.href;
      const ctx = extractRecordContext(url);
      if (ctx) {
        await open(ctx.recordId, ctx.sobjectName);
      } else {
        await open();
      }
    },

    async openFor(recordId: string, sobjectName?: string) {
      await open(recordId, sobjectName);
    },
  };
}

export function _inspectRecordTestApi() {
  return {
    isRecordId,
  };
}
