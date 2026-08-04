import { CONTEXTS, extractRecordContext } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import {
  getSalesforceApi,
  type SalesforceApiClient,
} from '../lib/salesforce-api.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { setTone, button, setLabel } from '../lib/ui-controls.js';
import { copyToClipboard } from '../ui/clipboard.js';

interface GlobalDescribe {
  sobjects: { name: string; label: string; keyPrefix: string | null }[];
}

interface FieldDescribe {
  name: string;
  label: string;
  type: string;
  updateable: boolean;
  relationshipName: string | null;
  referenceTo: string[];
}

interface SObjectDescribe {
  name: string;
  label: string;
  fields: FieldDescribe[];
}

export function isRecordId(id: string): boolean {
  return typeof id === 'string'
    && /^[a-zA-Z0-9]{15,18}$/.test(id)
    && !id.startsWith('000')
    && /[0-9]/.test(id.slice(0, 5));
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
  let globalDescribeCached: GlobalDescribe | null = null;
  const sobjectDescribesCached = new Map<string, SObjectDescribe>();

  function close(): void {
    view?.close();
    view = null;
  }

  async function getGlobalDescribe(): Promise<GlobalDescribe> {
    if (globalDescribeCached) return globalDescribeCached;
    const apiVersion = api.apiVersion;
    const data = await api.apiGet<GlobalDescribe>(`/services/data/${apiVersion}/sobjects/`);
    globalDescribeCached = data && Array.isArray(data.sobjects) ? data : { sobjects: [] };
    return globalDescribeCached;
  }

  async function getSObjectDescribe(name: string): Promise<SObjectDescribe> {
    const key = name.toLowerCase();
    const cached = sobjectDescribesCached.get(key);
    if (cached) return cached;
    const apiVersion = api.apiVersion;
    const data = await api.apiGet<SObjectDescribe>(`/services/data/${apiVersion}/sobjects/${name}/describe`);
    const enriched = data && Array.isArray(data.fields) ? data : { name, label: name, fields: [] };
    sobjectDescribesCached.set(key, enriched);
    return enriched;
  }

  async function resolveSObjectFromId(id: string): Promise<string | null> {
    const prefix = id.slice(0, 3);
    const globalDesc = await getGlobalDescribe();
    const match = globalDesc.sobjects.find((s) => s.keyPrefix === prefix);
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
    footer.append(saveBar, statusBar);

    view = presentView({
      title: 'Inspect Record',
      iconName: 'record',
      subtitle: recordInfo,
      headerActions: viewToggleRow,
      body,
      footer,
      doc,
      width: '900px',
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

        if (field.type === 'boolean') {
          const chk = doc.createElement('input');
          chk.type = 'checkbox';
          chk.checked = !!rawValue;
          chk.disabled = !field.updateable;
          chk.addEventListener('change', () => {
            editedRecordData[field.name] = chk.checked;
            updateSaveBarVisibility();
            renderFields();
          });
          tdValue.appendChild(chk);
        } else if (field.updateable) {
          const editWrapper = doc.createElement('div');
          editWrapper.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: var(--sfdt-space-2); width: 100%;';
          const valSpan = doc.createElement('span');
          valSpan.textContent = isNull ? '(null)' : valStr;
          valSpan.style.cssText = isNull
            ? 'color: var(--sfdt-color-text-muted); font-style: italic; cursor: pointer; flex: 1;'
            : 'cursor: pointer; flex: 1;';
          if (isRecordId(valStr)) {
            setTone(valSpan, 'info');
            valSpan.classList.add('sfdt-link');
          }

          editWrapper.appendChild(valSpan);

          const editInput = doc.createElement('input');
          editInput.className = 'sfdt-field';
          editInput.type = 'text';
          editInput.setAttribute('aria-label', `${field.label} value`);
          editInput.value = isNull ? '' : valStr;
          editInput.style.cssText = 'display: none; flex: 1; padding: 2px 6px; border-color: var(--sfdt-color-brand);';
          editWrapper.appendChild(editInput);

          const startEdit = () => {
            valSpan.style.display = 'none';
            editInput.style.display = 'inline-block';
            editInput.focus();
          };

          const finishEdit = () => {
            valSpan.style.display = 'inline-block';
            editInput.style.display = 'none';
            const nextVal = editInput.value.trim() === '' ? null : editInput.value;
            if (nextVal !== valStr) {
              editedRecordData[field.name] = nextVal;
              updateSaveBarVisibility();
              renderFields();
            }
          };

          valSpan.addEventListener('click', (e) => {
            if (isRecordId(valStr) && e.ctrlKey) {
              e.preventDefault();
              void navigateToRecord(valStr);
            } else {
              startEdit();
            }
          });

          editInput.addEventListener('blur', finishEdit);
          editInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') finishEdit();
            if (e.key === 'Escape') {
              // Escape here means "abandon this cell edit", not "close the
              // inspector" — presentAsModal now listens for Escape on the
              // document, so without this the whole view would vanish and take
              // every other unsaved edit with it.
              e.stopPropagation();
              editInput.value = isNull ? '' : valStr;
              valSpan.style.display = 'inline-block';
              editInput.style.display = 'none';
            }
          });

          tdValue.appendChild(editWrapper);
        } else {
          // Read-only cell
          const readSpan = doc.createElement('span');
          readSpan.textContent = isNull ? '(null)' : valStr;
          if (isNull) {
            readSpan.style.cssText = 'color: var(--sfdt-color-text-muted); font-style: italic;';
          } else if (isRecordId(valStr)) {
            readSpan.style.cssText = 'color: var(--sfdt-color-brand-text); text-decoration: underline; cursor: pointer;';
            readSpan.addEventListener('click', () => void navigateToRecord(valStr));
          }
          tdValue.appendChild(readSpan);
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

    function updateSaveBarVisibility(): void {
      let dirtyCount = 0;
      for (const k of Object.keys(originalRecordData)) {
        if (originalRecordData[k] !== editedRecordData[k]) dirtyCount += 1;
      }
      saveBar.style.display = dirtyCount ? 'flex' : 'none';
      dirtyNote.textContent = dirtyCount === 1
        ? '1 unsaved change'
        : `${dirtyCount} unsaved changes`;
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

        recordObj.textContent = `${sobject} · `;
        recordIdSpan.textContent = recordId;

        renderFields();
        updateSaveBarVisibility();
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

    cancelChangesBtn.addEventListener('click', () => {
      editedRecordData = { ...originalRecordData };
      updateSaveBarVisibility();
      renderFields();
    });

    saveChangesBtn.addEventListener('click', async () => {
      const patchBody: Record<string, unknown> = {};
      for (const k of Object.keys(originalRecordData)) {
        if (originalRecordData[k] !== editedRecordData[k]) {
          patchBody[k] = editedRecordData[k];
        }
      }
      if (Object.keys(patchBody).length === 0) return;

      saveChangesBtn.disabled = true;
      setLabel(saveChangesBtn, 'Saving…');
      try {
        const apiVersion = api.apiVersion;
        await api.apiRequest(
          'PATCH',
          `/services/data/${apiVersion}/sobjects/${activeSobjectName}/${activeRecordId}`,
          patchBody
        );
        showToast('Record saved successfully', { doc, kind: 'success' });
        // Update original to match the newly saved state
        originalRecordData = { ...editedRecordData };
        updateSaveBarVisibility();
        renderFields();
      } catch (err) {
        showToast(`Save failed: ${err instanceof Error ? err.message : String(err)}`, { doc, kind: 'error' });
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
