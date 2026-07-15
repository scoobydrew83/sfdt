import { CONTEXTS, extractRecordContext } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import {
  getSalesforceApi,
  type SalesforceApiClient,
} from '../lib/salesforce-api.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';

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

export function getIconForType(type: string): string {
  switch (type.toLowerCase()) {
    case 'id': return '🔑';
    case 'reference': return '🔍';
    case 'boolean': return '🌗';
    case 'picklist':
    case 'multipicklist': return '📋';
    case 'string':
    case 'textarea': return '📝';
    case 'int':
    case 'double':
    case 'long':
    case 'currency':
    case 'percent': return '🔢';
    case 'date':
    case 'datetime': return '📅';
    case 'phone': return '📞';
    case 'url': return '🌐';
    case 'email': return '✉️';
    default: return '🔹';
  }
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

export function createInspectRecordFeature(options: InspectRecordOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();

  let view: ViewHandle | null = null;
  let escHandler: ((e: KeyboardEvent) => void) | null = null;
  let globalDescribeCached: GlobalDescribe | null = null;
  const sobjectDescribesCached = new Map<string, SObjectDescribe>();

  function teardown(): void {
    if (escHandler) {
      doc.removeEventListener('keydown', escHandler);
      escHandler = null;
    }
  }

  function close(): void {
    teardown();
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
    body.style.cssText = 'padding: 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 12px;';

    // Record identity line lives at the top of the body (presentView's header is title + × only).
    const recordInfo = doc.createElement('span');
    recordInfo.style.cssText = 'font-weight: 600; font-size: 15px; display: flex; gap: 8px; align-items: center;';
    body.appendChild(recordInfo);

    const searchRow = doc.createElement('div');
    searchRow.style.cssText = 'display: flex; gap: 8px; align-items: center;';
    const idInput = doc.createElement('input');
    idInput.placeholder = 'Paste Salesforce Record ID (e.g. 001800000000001AAA)';
    idInput.style.cssText = 'flex: 1; padding: 6px 10px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 13px; outline: none;';
    const inspectBtn = doc.createElement('button');
    inspectBtn.textContent = 'Inspect';
    inspectBtn.style.cssText = 'padding: 6px 14px; background: #0070d2; color: #fff; border: 0; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 600;';
    searchRow.appendChild(idInput);
    searchRow.appendChild(inspectBtn);
    body.appendChild(searchRow);

    const filterRow = doc.createElement('div');
    filterRow.style.cssText = 'display: none; justify-content: space-between; align-items: center; gap: 12px; margin-top: 4px;';
    const filterInput = doc.createElement('input');
    filterInput.placeholder = 'Filter fields by label, API name, or value...';
    filterInput.style.cssText = 'flex: 1; max-width: 400px; padding: 5px 8px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 12px; outline: none;';
    const checkboxLabel = doc.createElement('label');
    checkboxLabel.style.cssText = 'display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #54698d; cursor: pointer;';
    const showNullsCheckbox = doc.createElement('input');
    showNullsCheckbox.type = 'checkbox';
    showNullsCheckbox.checked = true;
    checkboxLabel.appendChild(showNullsCheckbox);
    checkboxLabel.appendChild(doc.createTextNode('Show null values'));
    filterRow.appendChild(filterInput);
    filterRow.appendChild(checkboxLabel);
    body.appendChild(filterRow);

    const tableContainer = doc.createElement('div');
    tableContainer.style.cssText = 'border: 1px solid #d8dde6; border-radius: 4px; overflow: auto; max-height: 50vh; display: none;';
    body.appendChild(tableContainer);

    const saveBar = doc.createElement('div');
    saveBar.style.cssText = 'display: none; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid #d8dde6; background: #fafaf9;';
    const cancelChangesBtn = doc.createElement('button');
    cancelChangesBtn.textContent = 'Cancel';
    cancelChangesBtn.style.cssText = 'padding: 6px 12px; background: #fff; color: #54698d; border: 1px solid #d8dde6; border-radius: 4px; cursor: pointer; font-size: 13px;';
    const saveChangesBtn = doc.createElement('button');
    saveChangesBtn.textContent = 'Save Changes';
    saveChangesBtn.style.cssText = 'padding: 6px 14px; background: #04844b; color: #fff; border: 0; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 600;';
    saveBar.appendChild(cancelChangesBtn);
    saveBar.appendChild(saveChangesBtn);

    view = presentView({
      title: '🔍 Inspect Record (Show All Data)',
      body,
      footer: saveBar,
      doc,
      width: '900px',
      onClose: () => {
        teardown();
        view = null;
      },
    });

    let activeRecordId = '';
    let activeSobjectName = '';
    let originalRecordData: Record<string, unknown> = {};
    let editedRecordData: Record<string, unknown> = {};
    let activeDescribe: SObjectDescribe | null = null;

    function renderFields(): void {
      if (!activeDescribe) return;
      while (tableContainer.firstChild) tableContainer.removeChild(tableContainer.firstChild);

      const table = doc.createElement('table');
      table.style.cssText = 'width: 100%; border-collapse: collapse; font-size: 12px; text-align: left;';
      
      const thead = doc.createElement('thead');
      const headRow = doc.createElement('tr');
      const headers = ['Label', 'API Name', 'Type', 'Value'];
      for (const h of headers) {
        const th = doc.createElement('th');
        th.textContent = h;
        th.style.cssText = 'padding: 8px 12px; background: #fafaf9; border-bottom: 1px solid #d8dde6; font-weight: 600; position: sticky; top: 0; z-index: 1;';
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = doc.createElement('tbody');
      const filterText = filterInput.value.toLowerCase().trim();
      const showNulls = showNullsCheckbox.checked;

      for (const field of activeDescribe.fields) {
        const rawValue = editedRecordData[field.name];
        const isNull = rawValue === null || rawValue === undefined || rawValue === '';
        if (isNull && !showNulls) continue;

        const valStr = String(rawValue ?? '');
        const matchesFilter = 
          field.name.toLowerCase().includes(filterText) ||
          field.label.toLowerCase().includes(filterText) ||
          field.type.toLowerCase().includes(filterText) ||
          valStr.toLowerCase().includes(filterText);
        
        if (filterText && !matchesFilter) continue;

        const tr = doc.createElement('tr');
        tr.style.cssText = 'border-bottom: 1px solid #f3f3f3;';

        const tdLabel = doc.createElement('td');
        tdLabel.textContent = field.label;
        tdLabel.style.cssText = 'padding: 8px 12px; color: #16325c;';

        const tdApi = doc.createElement('td');
        tdApi.textContent = field.name;
        tdApi.style.cssText = 'padding: 8px 12px; font-family: ui-monospace, monospace; color: #54698d;';

        const tdType = doc.createElement('td');
        const icon = getIconForType(field.type);
        tdType.textContent = `${icon} ${field.type}`;
        tdType.style.cssText = 'padding: 8px 12px; color: #54698d;';

        const tdValue = doc.createElement('td');
        tdValue.style.cssText = 'padding: 8px 12px; position: relative;';

        const isDirty = originalRecordData[field.name] !== rawValue;
        if (isDirty) {
          tr.style.background = '#fff8e1';
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
          editWrapper.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%;';
          const valSpan = doc.createElement('span');
          valSpan.textContent = isNull ? '(null)' : valStr;
          valSpan.style.cssText = isNull ? 'color: #c23934; font-style: italic; cursor: pointer; flex: 1;' : 'cursor: pointer; flex: 1;';
          if (isRecordId(valStr)) {
            valSpan.style.color = '#0070d2';
            valSpan.style.textDecoration = 'underline';
          }
          
          editWrapper.appendChild(valSpan);

          const editInput = doc.createElement('input');
          editInput.type = 'text';
          editInput.value = isNull ? '' : valStr;
          editInput.style.cssText = 'display: none; flex: 1; padding: 2px 6px; border: 1px solid #0070d2; border-radius: 4px; font-size: 12px; outline: none;';
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
            readSpan.style.cssText = 'color: #80868d; font-style: italic;';
          } else if (isRecordId(valStr)) {
            readSpan.style.cssText = 'color: #0070d2; text-decoration: underline; cursor: pointer;';
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
    }

    function updateSaveBarVisibility(): void {
      let dirty = false;
      for (const k of Object.keys(originalRecordData)) {
        if (originalRecordData[k] !== editedRecordData[k]) {
          dirty = true;
          break;
        }
      }
      saveBar.style.display = dirty ? 'flex' : 'none';
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
      } catch {
        showToast('Navigation failed', { doc, kind: 'error' });
      }
    }

    async function loadRecord(): Promise<void> {
      const recordId = idInput.value.trim();
      if (!isRecordId(recordId)) {
        showToast('Please enter a valid 15 or 18 character Salesforce ID', { doc, kind: 'warning' });
        return;
      }
      inspectBtn.disabled = true;
      inspectBtn.textContent = 'Loading…';
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

        originalRecordData = {};
        editedRecordData = {};
        for (const field of describe.fields) {
          const val = rawRecord[field.name];
          originalRecordData[field.name] = val;
          editedRecordData[field.name] = val;
        }

        recordInfo.textContent = '🔍 Inspect Record: ';
        const idSpan = doc.createElement('span');
        idSpan.style.cssText = 'color:#0070d2; font-family:ui-monospace, monospace; margin-left: 6px;';
        idSpan.textContent = `${sobject} · ${recordId}`;
        recordInfo.appendChild(idSpan);
        
        filterRow.style.display = 'flex';
        renderFields();
        updateSaveBarVisibility();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), { doc, kind: 'error' });
      } finally {
        inspectBtn.disabled = false;
        inspectBtn.textContent = 'Inspect';
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
      saveChangesBtn.textContent = 'Saving…';
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
        saveChangesBtn.textContent = 'Save Changes';
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

    escHandler = (e) => {
      if (e.key === 'Escape' && view) {
        close();
      }
    };
    doc.addEventListener('keydown', escHandler);
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
  };
}

export function _inspectRecordTestApi() {
  return {
    getIconForType,
    isRecordId,
  };
}
