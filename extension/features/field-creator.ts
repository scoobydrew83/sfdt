import { CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import {
  getSalesforceApi,
  type SalesforceApiClient,
} from '../lib/salesforce-api.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { button, setLabel, setTone } from '../lib/ui-controls.js';

interface GlobalDescribe {
  sobjects: { name: string; label: string; keyPrefix: string | null; queryable: boolean; createable: boolean; updateable: boolean }[];
}

interface PermissionSetRecord {
  Id: string;
  Name: string;
  Profile?: {
    Name: string;
  };
}

export interface CustomFieldDefinition {
  label: string;
  name: string;
  type: string;
  description?: string;
  helptext?: string;
  required?: boolean;
  uniqueSetting?: boolean;
  external?: boolean;
  length?: number;
  precision?: number;
  decimal?: number;
  checkboxDefault?: 'checked' | 'unchecked';
  geodisplay?: 'decimal' | 'degrees';
  picklistvalues?: string;
  sortalpha?: boolean;
  firstvaluedefault?: boolean;
  vislines?: number;
  
  // FLS profile access: maps profile name / permset name to access type
  profiles?: { name: string; access: 'read' | 'edit' }[];

  // Deployment
  deploymentStatus?: 'pending' | 'success' | 'error';
  deploymentError?: string;
}

export function formatApiName(label: string): string {
  let apiName = label.trim().replace(/[^a-zA-Z0-9\s]/g, '_');
  // Remove spaces and convert to PascalCase
  apiName = apiName.replace(/[\s_]+(\w)/g, (_, letter) => letter.toUpperCase());
  // Remove leading/trailing underscores and multiple underscores
  apiName = apiName.replace(/^_+|_+$/g, '').replace(/_+/g, '_');
  // Capitalize first letter if not already
  if (apiName.length > 0) {
    apiName = apiName[0]!.toUpperCase() + apiName.slice(1);
  }
  return apiName;
}

export function mapFieldType(uiType: string): string {
  const typeMap: Record<string, string> = {
    'Checkbox': 'Checkbox',
    'Currency': 'Currency',
    'Date': 'Date',
    'DateTime': 'DateTime',
    'Email': 'Email',
    'Location': 'Location',
    'Number': 'Number',
    'Percent': 'Percent',
    'Phone': 'Phone',
    'Picklist': 'Picklist',
    'MultiselectPicklist': 'MultiselectPicklist',
    'Text': 'Text',
    'TextArea': 'TextArea',
    'LongTextArea': 'LongTextArea',
    'Html': 'Html',
    'Url': 'Url'
  };
  return typeMap[uiType] || uiType;
}

export function createFieldCreatorFeature(options: {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
} = {}): Feature {
  const doc = options.doc ?? document;
  const _win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();

  let view: ViewHandle | null = null;
  let globalDescribeCached: GlobalDescribe | null = null;

  // State
  let sObjectList: string[] = [];
  let selectedSObject = '';
  let fields: CustomFieldDefinition[] = [{ label: '', name: '', type: 'Text' }];
  let permissionSets: Record<string, string | null> = {}; // Name -> ProfileName (if profile-based)
  let permissionSetMap: Record<string, string> = {}; // Name -> Id
  
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

  async function fetchPermissionSets() {
    try {
      const data = await api.query<PermissionSetRecord>('SELECT Id, Name, Profile.Name FROM PermissionSet');
      permissionSets = {};
      permissionSetMap = {};
      data.records.forEach(record => {
        permissionSets[record.Name] = record.Profile ? record.Profile.Name : null;
        permissionSetMap[record.Name] = record.Id;
      });
    } catch (err) {
      console.error('Error fetching permission sets:', err);
    }
  }

  async function open(): Promise<void> {
    close();
    await fetchPermissionSets();

    // Body presented into a Workspace tab (or a modal on a Salesforce page).
    const body = doc.createElement('div');
    body.classList.add('sfdt-view-main');
    // Top Controls
    const topRow = doc.createElement('div');
    topRow.style.cssText = 'display: flex; gap: 16px; align-items: center; border-bottom: 1px solid var(--sfdt-color-border-2); padding-bottom: 16px;';
    body.appendChild(topRow);

    const sobjDiv = doc.createElement('div');
    sobjDiv.classList.add('sfdt-stack', 'sfdt-tight');
    const sobjLabel = doc.createElement('label');
    sobjLabel.textContent = 'Select Target SObject';
    sobjLabel.className = 'sfdt-label';
    const sobjSelect = doc.createElement('select');
    sobjSelect.className = 'sfdt-field sfdt-auto';
    sobjDiv.appendChild(sobjLabel);
    sobjDiv.appendChild(sobjSelect);
    topRow.appendChild(sobjDiv);

    const buttonGroup = doc.createElement('div');
    buttonGroup.classList.add('sfdt-row', 'sfdt-snug');
    topRow.appendChild(buttonGroup);

    const addFieldBtn = button({ label: 'Add Field', iconName: 'plus', doc });
    const permAllBtn = button({ label: 'Permissions for All', iconName: 'setup-tabs', doc });
    const clearBtn = button({ label: 'Clear All', iconName: 'trash', variant: 'danger', doc });

    buttonGroup.appendChild(addFieldBtn);
    buttonGroup.appendChild(permAllBtn);
    buttonGroup.appendChild(clearBtn);

    // Table Container
    const tableContainer = doc.createElement('div');
    tableContainer.classList.add('sfdt-frame');
    body.appendChild(tableContainer);

    const table = doc.createElement('table');
    table.classList.add('sfdt-table');
    const thead = doc.createElement('thead');
    const headTr = doc.createElement('tr');
    const cols = ['Actions', 'Label', 'Developer Name (__c)', 'Data Type', 'Options', 'FLS', 'Status'];
    for (const c of cols) {
      const th = doc.createElement('th');
      th.textContent = c;
      th.classList.add('sfdt-sticky-head');
      headTr.appendChild(th);
    }
    thead.appendChild(headTr);
    table.appendChild(thead);

    const tbody = doc.createElement('tbody');
    table.appendChild(tbody);
    tableContainer.appendChild(table);

    // Bottom Action Row
    const actionRow = doc.createElement('div');
    actionRow.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end; align-items: center; border-top: 1px solid var(--sfdt-color-border-2); padding-top: 16px;';
    body.appendChild(actionRow);

    const deployBtn = button({ label: 'Deploy Fields', iconName: 'rocket', variant: 'primary', doc });
    deployBtn.disabled = true;
    actionRow.appendChild(deployBtn);

    view = presentView({
      title: 'Bulk Field Creator',
      iconName: 'field-creator',
      body,
      doc,
      width: '1000px',
      onClose: () => { view = null; },
    });

    // Load SObject list
    try {
      const desc = await getGlobalDescribe();
      sObjectList = desc.sobjects
        .filter(s => s.updateable)
        .map(s => s.name)
        .sort();

      while (sobjSelect.firstChild) sobjSelect.removeChild(sobjSelect.firstChild);
      const placeholder = doc.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '-- Select Target Object --';
      sobjSelect.appendChild(placeholder);

      for (const name of sObjectList) {
        const opt = doc.createElement('option');
        opt.value = name;
        opt.textContent = name;
        sobjSelect.appendChild(opt);
      }
    } catch (err) {
      console.error(err);
      // The org's reason is the whole message here: a describe can fail because
      // API access is off, because the user's profile cannot see any object, or
      // because the session really did expire — and the user can only act on
      // one of those if we say which.
      showToast(
        `Failed to load SObject list — ${err instanceof Error ? err.message : String(err)}`,
        { doc, kind: 'error' },
      );
    }

    sobjSelect.addEventListener('change', () => {
      selectedSObject = sobjSelect.value;
      validateReady();
    });

    addFieldBtn.addEventListener('click', () => {
      fields.push({ label: '', name: '', type: 'Text' });
      renderRows();
      validateReady();
    });

    clearBtn.addEventListener('click', () => {
      fields = [{ label: '', name: '', type: 'Text' }];
      renderRows();
      validateReady();
    });

    permAllBtn.addEventListener('click', () => {
      openFLSModal(null);
    });

    deployBtn.addEventListener('click', () => {
      void startDeployment();
    });

    function validateReady() {
      if (!selectedSObject) {
        deployBtn.disabled = true;
        return;
      }
      const hasValid = fields.every(f => f.label.trim() && f.name.trim());
      deployBtn.disabled = fields.length === 0 || !hasValid;
    }

    function renderRows() {
      while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

      fields.forEach((field, idx) => {
        const tr = doc.createElement('tr');
        tr.classList.add('sfdt-divider');
        // Actions
        const tdActions = doc.createElement('td');
        tdActions.classList.add('sfdt-row', 'sfdt-snug', 'sfdt-prose');
        const cloneRowBtn = button({
          iconName: 'clipboard',
          variant: 'ghost',
          small: true,
          title: 'Clone field definition',
          doc,
        });
        cloneRowBtn.addEventListener('click', () => {
          fields.push({ ...field, deploymentStatus: undefined, deploymentError: undefined });
          renderRows();
          validateReady();
        });
        const delRowBtn = button({
          iconName: 'trash',
          variant: 'ghost',
          small: true,
          title: 'Delete field definition',
          doc,
        });
        delRowBtn.addEventListener('click', () => {
          fields.splice(idx, 1);
          if (fields.length === 0) {
            fields.push({ label: '', name: '', type: 'Text' });
          }
          renderRows();
          validateReady();
        });
        tdActions.appendChild(cloneRowBtn);
        tdActions.appendChild(delRowBtn);

        // Label
        const tdLabel = doc.createElement('td');
        tdLabel.classList.add('sfdt-prose', 'sfdt-flush-x');
        const labelInput = doc.createElement('input');
        labelInput.type = 'text';
        labelInput.value = field.label;
        labelInput.placeholder = 'Field Label...';
        labelInput.className = 'sfdt-field sfdt-auto';
        labelInput.addEventListener('input', () => {
          field.label = labelInput.value;
          field.name = formatApiName(labelInput.value);
          nameInput.value = field.name;
          validateReady();
        });
        tdLabel.appendChild(labelInput);

        // Name
        const tdName = doc.createElement('td');
        tdName.classList.add('sfdt-prose', 'sfdt-flush-x');
        const nameInput = doc.createElement('input');
        nameInput.type = 'text';
        nameInput.value = field.name;
        nameInput.placeholder = 'Developer_Name';
        nameInput.className = 'sfdt-field sfdt-auto';
        nameInput.addEventListener('input', () => {
          field.name = nameInput.value;
          validateReady();
        });
        tdName.appendChild(nameInput);

        // Type
        const tdType = doc.createElement('td');
        tdType.classList.add('sfdt-prose', 'sfdt-flush-x');
        const typeSelect = doc.createElement('select');
        typeSelect.className = 'sfdt-field sfdt-auto';
        const types = [
          'Text', 'Checkbox', 'Currency', 'Date', 'DateTime', 'Email',
          'Location', 'Number', 'Percent', 'Phone', 'Picklist',
          'MultiselectPicklist', 'TextArea', 'LongTextArea', 'Html', 'Url'
        ];
        for (const t of types) {
          const opt = doc.createElement('option');
          opt.value = t;
          opt.textContent = t;
          if (field.type === t) opt.selected = true;
          typeSelect.appendChild(opt);
        }
        typeSelect.addEventListener('change', () => {
          field.type = typeSelect.value;
        });
        tdType.appendChild(typeSelect);

        // Options
        const tdOpt = doc.createElement('td');
        tdOpt.classList.add('sfdt-prose', 'sfdt-flush-x');
        const optBtn = button({ label: 'Options', iconName: 'settings', small: true, doc });
        optBtn.addEventListener('click', () => {
          openOptionsModal(field);
        });
        tdOpt.appendChild(optBtn);

        // FLS
        const tdFLS = doc.createElement('td');
        tdFLS.classList.add('sfdt-prose', 'sfdt-flush-x');
        const flsBtn = button({ label: 'FLS', iconName: 'setup-tabs', small: true, doc });
        if (field.profiles && field.profiles.length > 0) {
          setLabel(flsBtn, `FLS (${field.profiles.length})`);
          setTone(flsBtn, 'ok');
        }
        flsBtn.addEventListener('click', () => {
          openFLSModal(field, () => {
            renderRows();
          });
        });
        tdFLS.appendChild(flsBtn);

        // Status
        const tdStatus = doc.createElement('td');
        tdStatus.classList.add('sfdt-prose', 'sfdt-flush-x', 'sfdt-strong');
        if (field.deploymentStatus === 'pending') {
          tdStatus.textContent = 'Pending';
          setTone(tdStatus, 'info');
        } else if (field.deploymentStatus === 'success') {
          tdStatus.textContent = 'Success';
          setTone(tdStatus, 'ok');
        } else if (field.deploymentStatus === 'error') {
          tdStatus.textContent = 'Error';
          setTone(tdStatus, 'bad');
          tdStatus.title = field.deploymentError || 'Unknown error';
        } else {
          tdStatus.textContent = '-';
          setTone(tdStatus, 'muted');
        }
        tr.appendChild(tdActions);
        tr.appendChild(tdLabel);
        tr.appendChild(tdName);
        tr.appendChild(tdType);
        tr.appendChild(tdOpt);
        tr.appendChild(tdFLS);
        tr.appendChild(tdStatus);

        tbody.appendChild(tr);
      });
    }

    function openOptionsModal(field: CustomFieldDefinition) {
      const optOverlay = doc.createElement('div');
      optOverlay.className = 'sfdt-overlay';
      
      const optModal = doc.createElement('div');
      optModal.className = 'sfdt-card sfdt-stack sfdt-modal-card';
      optModal.style.width = '450px';
      optModal.style.maxHeight = '80vh';
      
      const optTitle = doc.createElement('span');
      optTitle.textContent = `Configure Field: ${field.label || 'New Field'} (${field.type})`;
      optTitle.style.cssText = 'font-weight: 600; font-size: 14px; border-bottom: 1px solid var(--sfdt-color-border-2); padding-bottom: 8px;';
      optModal.appendChild(optTitle);

      const fieldsContainer = doc.createElement('div');
      fieldsContainer.style.cssText = 'display: flex; flex-direction: column; gap: 10px; overflow-y: auto; flex: 1;';
      optModal.appendChild(fieldsContainer);

      // Common: Description, Help Text, Required, Unique, External ID
      const createInput = (labelVal: string, typeVal: string, key: keyof CustomFieldDefinition, defaultVal: any) => {
        const row = doc.createElement('div');
        row.classList.add('sfdt-stack', 'sfdt-tight');
        const lbl = doc.createElement('label');
        lbl.textContent = labelVal;
        lbl.className = 'sfdt-label';
        row.appendChild(lbl);

        if (typeVal === 'text') {
          const inp = doc.createElement('input');
          inp.type = 'text';
          inp.value = String(field[key] ?? defaultVal);
          inp.className = 'sfdt-field sfdt-auto';
          inp.addEventListener('input', () => {
            (field as any)[key] = inp.value;
          });
          row.appendChild(inp);
        } else if (typeVal === 'number') {
          const inp = doc.createElement('input');
          inp.type = 'number';
          inp.value = String(field[key] ?? defaultVal);
          inp.className = 'sfdt-field sfdt-auto';
          inp.addEventListener('input', () => {
            (field as any)[key] = parseInt(inp.value) || 0;
          });
          row.appendChild(inp);
        } else if (typeVal === 'checkbox') {
          row.classList.add('sfdt-row');
          const inp = doc.createElement('input');
          inp.type = 'checkbox';
          inp.checked = !!(field[key] ?? defaultVal);
          inp.classList.add('sfdt-clickable');
          inp.addEventListener('change', () => {
            (field as any)[key] = inp.checked;
          });
          row.insertBefore(inp, lbl);
        }
        fieldsContainer.appendChild(row);
      };

      createInput('Description', 'text', 'description', '');
      createInput('Help Text', 'text', 'helptext', '');
      
      if (['Text', 'Number', 'Currency', 'Percent', 'Email', 'Url'].includes(field.type)) {
        createInput('Required', 'checkbox', 'required', false);
      }
      if (['Text', 'Number', 'Currency', 'Email'].includes(field.type)) {
        createInput('Unique', 'checkbox', 'uniqueSetting', false);
        createInput('External ID', 'checkbox', 'external', false);
      }

      // Specific options by type
      if (field.type === 'Text') {
        createInput('Length', 'number', 'length', 255);
      } else if (['Number', 'Currency', 'Percent'].includes(field.type)) {
        createInput('Precision (Digits before decimal + decimal places, max 18)', 'number', 'precision', 18);
        createInput('Decimal Places', 'number', 'decimal', 0);
      } else if (field.type === 'Checkbox') {
        const row = doc.createElement('div');
        row.classList.add('sfdt-stack', 'sfdt-tight');
        const lbl = doc.createElement('label');
        lbl.textContent = 'Default Value';
        lbl.className = 'sfdt-label';
        const sel = doc.createElement('select');
        sel.className = 'sfdt-field sfdt-auto';
        const optUnchecked = doc.createElement('option');
        optUnchecked.value = 'unchecked';
        optUnchecked.textContent = 'Unchecked';
        const optChecked = doc.createElement('option');
        optChecked.value = 'checked';
        optChecked.textContent = 'Checked';
        sel.appendChild(optUnchecked);
        sel.appendChild(optChecked);
        sel.value = field.checkboxDefault || 'unchecked';
        sel.addEventListener('change', () => {
          field.checkboxDefault = sel.value as any;
        });
        row.appendChild(lbl);
        row.appendChild(sel);
        fieldsContainer.appendChild(row);
      } else if (field.type === 'Location') {
        createInput('Decimal Places', 'number', 'decimal', 0);
        const row = doc.createElement('div');
        row.classList.add('sfdt-stack', 'sfdt-tight');
        const lbl = doc.createElement('label');
        lbl.textContent = 'Display Format';
        lbl.className = 'sfdt-label';
        const sel = doc.createElement('select');
        sel.className = 'sfdt-field sfdt-auto';
        const optDec = doc.createElement('option');
        optDec.value = 'decimal';
        optDec.textContent = 'Decimal Degrees';
        const optDeg = doc.createElement('option');
        optDeg.value = 'degrees';
        optDeg.textContent = 'Degrees, Minutes, Seconds';
        sel.appendChild(optDec);
        sel.appendChild(optDeg);
        sel.value = field.geodisplay || 'decimal';
        sel.addEventListener('change', () => {
          field.geodisplay = sel.value as any;
        });
        row.appendChild(lbl);
        row.appendChild(sel);
        fieldsContainer.appendChild(row);
      } else if (['Picklist', 'MultiselectPicklist'].includes(field.type)) {
        const row = doc.createElement('div');
        row.classList.add('sfdt-stack', 'sfdt-tight');
        const lbl = doc.createElement('label');
        lbl.textContent = 'Picklist Values (Enter values, one per line)';
        lbl.className = 'sfdt-label';
        const area = doc.createElement('textarea');
        area.value = field.picklistvalues || '';
        area.placeholder = 'Value1\nValue2\nValue3';
        area.className = 'sfdt-field sfdt-auto';
        area.style.height = '80px';
        area.addEventListener('input', () => {
          field.picklistvalues = area.value;
        });
        row.appendChild(lbl);
        row.appendChild(area);
        fieldsContainer.appendChild(row);

        createInput('Sort Alphabetically', 'checkbox', 'sortalpha', false);
        createInput('First Value as Default', 'checkbox', 'firstvaluedefault', false);
        
        if (field.type === 'MultiselectPicklist') {
          createInput('Visible Lines', 'number', 'vislines', 4);
        }
      } else if (['LongTextArea', 'Html'].includes(field.type)) {
        createInput('Length (Max 131,072)', 'number', 'length', 32768);
        createInput('Visible Lines', 'number', 'vislines', 6);
      }

      const buttons = doc.createElement('div');
      buttons.style.cssText = 'display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--sfdt-color-border-2); padding-top: 12px; margin-top: 8px;';
      const saveBtn = button({ label: 'Save', iconName: 'save', variant: 'primary', doc });
      saveBtn.addEventListener('click', () => {
        optOverlay.remove();
      });
      buttons.appendChild(saveBtn);
      optModal.appendChild(buttons);
      
      optOverlay.appendChild(optModal);
      doc.body.appendChild(optOverlay);
    }

    function openFLSModal(targetField: CustomFieldDefinition | null, callback?: () => void) {
      const flsOverlay = doc.createElement('div');
      flsOverlay.className = 'sfdt-overlay';
      
      const flsModal = doc.createElement('div');
      flsModal.className = 'sfdt-card sfdt-stack sfdt-modal-card';
      flsModal.style.width = '650px';
      flsModal.style.height = '80vh';
      
      const title = doc.createElement('span');
      title.textContent = targetField 
        ? `Field-Level Security (FLS) for ${targetField.label || 'New Field'}`
        : 'Grant Permissions to All Fields';
      title.style.cssText = 'font-weight: 600; font-size: 14px; border-bottom: 1px solid var(--sfdt-color-border-2); padding-bottom: 8px;';
      flsModal.appendChild(title);

      const searchInp = doc.createElement('input');
      searchInp.placeholder = 'Search Profiles or Permission Sets...';
      searchInp.className = 'sfdt-field sfdt-auto';
      flsModal.appendChild(searchInp);

      const tableDiv = doc.createElement('div');
      tableDiv.style.cssText = 'flex: 1; overflow-y: auto; border: 1px solid var(--sfdt-color-border); border-radius: 4px;';
      flsModal.appendChild(tableDiv);

      const flsTable = doc.createElement('table');
      flsTable.classList.add('sfdt-table');
      const flsThead = doc.createElement('thead');
      const trHead = doc.createElement('tr');
      const thName = doc.createElement('th');
      thName.textContent = 'Name';
      thName.classList.add('sfdt-sticky-head');
      const thType = doc.createElement('th');
      thType.textContent = 'Type';
      thType.classList.add('sfdt-sticky-head');
      const thRead = doc.createElement('th');
      thRead.textContent = 'Visible';
      thRead.classList.add('sfdt-sticky-head');
      const readAll = doc.createElement('input');
      readAll.type = 'checkbox';
      thRead.appendChild(doc.createElement('br'));
      thRead.appendChild(readAll);

      const thEdit = doc.createElement('th');
      thEdit.textContent = 'Read-Write';
      thEdit.classList.add('sfdt-sticky-head');
      const editAll = doc.createElement('input');
      editAll.type = 'checkbox';
      thEdit.appendChild(doc.createElement('br'));
      thEdit.appendChild(editAll);

      trHead.appendChild(thName);
      trHead.appendChild(thType);
      trHead.appendChild(thRead);
      trHead.appendChild(thEdit);
      flsThead.appendChild(trHead);
      flsTable.appendChild(flsThead);

      const flsTbody = doc.createElement('tbody');
      flsTable.appendChild(flsTbody);
      tableDiv.appendChild(flsTable);

      // Local State permissions dictionary
      // Key: PermissionSet name. Value: { read: boolean, edit: boolean }
      const permissionsLocal: Record<string, { read: boolean; edit: boolean }> = {};
      Object.keys(permissionSets).forEach(name => {
        permissionsLocal[name] = { read: false, edit: false };
      });

      if (targetField && targetField.profiles) {
        targetField.profiles.forEach(p => {
          if (permissionsLocal[p.name]) {
            permissionsLocal[p.name] = {
              edit: p.access === 'edit',
              read: p.access === 'edit' || p.access === 'read'
            };
          }
        });
      }

      function updateAllCheckboxes() {
        const sorted = getFilteredFLSItems();
        readAll.checked = sorted.length > 0 && sorted.every(([name]) => permissionsLocal[name]!.read);
        editAll.checked = sorted.length > 0 && sorted.every(([name]) => permissionsLocal[name]!.edit);
      }

      function getFilteredFLSItems(): [string, string | null][] {
        const queryTerm = searchInp.value.toLowerCase();
        return Object.entries(permissionSets)
          .filter(([name, profile]) => {
            const displayName = profile || name;
            return displayName.toLowerCase().includes(queryTerm);
          })
          .sort((a, b) => {
            const dispA = a[1] || a[0];
            const dispB = b[1] || b[0];
            return dispA.localeCompare(dispB);
          });
      }

      function renderFLSRows() {
        while (flsTbody.firstChild) flsTbody.removeChild(flsTbody.firstChild);
        const filtered = getFilteredFLSItems();

        filtered.forEach(([name, profile]) => {
          const tr = doc.createElement('tr');
          tr.classList.add('sfdt-divider');
          const tdName = doc.createElement('td');
          tdName.textContent = profile || name;
          tdName.style.cssText = 'padding: 6px 10px; font-weight: 500;';

          const tdType = doc.createElement('td');
          tdType.textContent = profile ? 'Profile' : 'Permission Set';
          tdType.classList.add('sfdt-prose', 'sfdt-muted');
          const tdReadVal = doc.createElement('td');
          tdReadVal.style.cssText = 'padding: 6px 10px; text-align: center;';
          const chkRead = doc.createElement('input');
          chkRead.type = 'checkbox';
          chkRead.checked = permissionsLocal[name]!.read;
          chkRead.addEventListener('change', () => {
            permissionsLocal[name]!.read = chkRead.checked;
            if (!chkRead.checked) {
              permissionsLocal[name]!.edit = false;
              chkEdit.checked = false;
            }
            updateAllCheckboxes();
          });
          tdReadVal.appendChild(chkRead);

          const tdEditVal = doc.createElement('td');
          tdEditVal.style.cssText = 'padding: 6px 10px; text-align: center;';
          const chkEdit = doc.createElement('input');
          chkEdit.type = 'checkbox';
          chkEdit.checked = permissionsLocal[name]!.edit;
          chkEdit.addEventListener('change', () => {
            permissionsLocal[name]!.edit = chkEdit.checked;
            if (chkEdit.checked) {
              permissionsLocal[name]!.read = true;
              chkRead.checked = true;
            }
            updateAllCheckboxes();
          });
          tdEditVal.appendChild(chkEdit);

          tr.appendChild(tdName);
          tr.appendChild(tdType);
          tr.appendChild(tdReadVal);
          tr.appendChild(tdEditVal);
          flsTbody.appendChild(tr);
        });

        updateAllCheckboxes();
      }

      searchInp.addEventListener('input', renderFLSRows);

      readAll.addEventListener('change', () => {
        const sorted = getFilteredFLSItems();
        const next = readAll.checked;
        sorted.forEach(([name]) => {
          permissionsLocal[name]!.read = next;
          if (!next) {
            permissionsLocal[name]!.edit = false;
          }
        });
        renderFLSRows();
      });

      editAll.addEventListener('change', () => {
        const sorted = getFilteredFLSItems();
        const next = editAll.checked;
        sorted.forEach(([name]) => {
          permissionsLocal[name]!.edit = next;
          if (next) {
            permissionsLocal[name]!.read = true;
          }
        });
        renderFLSRows();
      });

      const buttons = doc.createElement('div');
      buttons.style.cssText = 'display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--sfdt-color-border-2); padding-top: 12px; margin-top: 8px;';
      
      const cancelBtn = button({ label: 'Cancel', doc });
      cancelBtn.addEventListener('click', () => {
        flsOverlay.remove();
      });

      const saveBtn = button({ label: 'Save Permissions', iconName: 'save', variant: 'primary', doc });
      saveBtn.addEventListener('click', () => {
        const mappedProfiles = Object.entries(permissionsLocal)
          .filter(([_, perm]) => perm.read || perm.edit)
          .map(([name, perm]) => ({
            name,
            access: perm.edit ? 'edit' as const : 'read' as const
          }));

        if (targetField) {
          targetField.profiles = mappedProfiles;
        } else {
          // Apply to all fields
          fields.forEach(f => {
            f.profiles = mappedProfiles.map(p => ({ ...p }));
          });
        }
        
        flsOverlay.remove();
        if (callback) callback();
      });

      buttons.appendChild(cancelBtn);
      buttons.appendChild(saveBtn);
      flsModal.appendChild(buttons);

      flsOverlay.appendChild(flsModal);
      doc.body.appendChild(flsOverlay);

      renderFLSRows();
    }

    async function setFieldPermissions(field: CustomFieldDefinition, objectName: string) {
      if (!field.profiles || !Array.isArray(field.profiles)) {
        return;
      }
      // Strip a trailing __c the user may have manually typed so the field
      // reference matches the deployed Name__c rather than Name__c__c.
      const fieldApiName = field.name.replace(/__c$/i, '');
      const permissionPromises = field.profiles.map(profile => {
        const permissionSetId = permissionSetMap[profile.name] || profile.name;
        const fieldPermissionBody = {
          ParentId: permissionSetId,
          SobjectType: objectName,
          Field: `${objectName}.${fieldApiName}__c`,
          PermissionsEdit: profile.access === 'edit',
          PermissionsRead: profile.access === 'edit' || profile.access === 'read'
        };

        const apiVersion = api.apiVersion;
        return api.apiRequest('POST', `/services/data/${apiVersion}/sobjects/FieldPermissions/`, fieldPermissionBody);
      });

      await Promise.all(permissionPromises);
    }

    async function deploySingleField(field: CustomFieldDefinition, objectName: string) {
      // Strip a trailing __c the user may have manually typed so we don't
      // produce Name__c__c when re-appending the custom-field suffix.
      const fieldApiName = field.name.replace(/__c$/i, '');
      const newField: any = {
        FullName: `${objectName}.${fieldApiName}__c`,
        Metadata: {
          label: field.label,
          type: mapFieldType(field.type),
          description: field.description || '',
          inlineHelpText: field.helptext || '',
          required: field.required || false,
          unique: field.uniqueSetting || false,
          externalId: field.external || false,
          trackFeedHistory: false,
          trackHistory: false,
          trackTrending: false
        }
      };

      // Add specific options based on field type
      switch (field.type) {
        case 'Checkbox':
          newField.Metadata.defaultValue = field.checkboxDefault === 'checked';
          break;

        case 'Currency':
        case 'Number':
        case 'Percent':
          newField.Metadata.precision = field.precision || 18;
          newField.Metadata.scale = field.decimal || 0;
          break;

        case 'Location':
          newField.Metadata.displayLocationInDecimal = field.geodisplay === 'decimal';
          newField.Metadata.scale = field.decimal || 0;
          break;

        case 'Picklist':
        case 'MultiselectPicklist':
          newField.Metadata.valueSet = {
            valueSetDefinition: {
              sorted: field.sortalpha || false,
              value: (field.picklistvalues || '')
                .split('\n')
                .map(v => v.trim())
                .filter(v => v.length > 0)
                .map((v, index) => ({
                  fullName: v,
                  default: field.firstvaluedefault && index === 0
                }))
            }
          };
          if (field.type === 'MultiselectPicklist') {
            newField.Metadata.visibleLines = field.vislines || 4;
          }
          break;

        case 'Text':
          newField.Metadata.length = field.length || 255;
          break;

        case 'LongTextArea':
        case 'Html':
          newField.Metadata.length = field.length || 32768;
          newField.Metadata.visibleLines = field.vislines || 6;
          break;
      }

      const apiVersion = api.apiVersion;
      await api.apiRequest('POST', `/services/data/${apiVersion}/tooling/sobjects/CustomField`, newField);

      // Now set FLS permissions if any are chosen
      await setFieldPermissions(field, objectName);
    }

    async function startDeployment() {
      deployBtn.disabled = true;
      sobjSelect.disabled = true;
      addFieldBtn.disabled = true;
      permAllBtn.disabled = true;
      clearBtn.disabled = true;

      for (const field of fields) {
        if (field.deploymentStatus === 'success') continue;
        field.deploymentStatus = 'pending';
        renderRows();

        try {
          await deploySingleField(field, selectedSObject);
          field.deploymentStatus = 'success';
        } catch (err) {
          field.deploymentStatus = 'error';
          field.deploymentError = err instanceof Error ? err.message : String(err);
        }
        renderRows();
      }

      deployBtn.disabled = false;
      sobjSelect.disabled = false;
      addFieldBtn.disabled = false;
      permAllBtn.disabled = false;
      clearBtn.disabled = false;
      validateReady();

      const succeeded = fields.filter(f => f.deploymentStatus === 'success').length;
      const failed = fields.filter(f => f.deploymentStatus === 'error').length;
      showToast(`Field Deployment complete. Succeeded: ${succeeded}, Failed: ${failed}.`, { doc, kind: failed > 0 ? 'warning' : 'success' });
    }

    renderRows();
  }

  return {
    manifest: {
      id: 'field-creator',
      name: 'Bulk Field Creator',
      contexts: [
        CONTEXTS.SETUP_FLOWS,
        CONTEXTS.SETUP_OTHER,
        CONTEXTS.FLOW_BUILDER,
        CONTEXTS.FLOW_TRIGGER_EXPLORER,
        CONTEXTS.RECORD_PAGE,
      ],
    },
    async onActivate() {
      await open();
    },
  };
}

export function _fieldCreatorTestApi() {
  return { formatApiName, mapFieldType };
}
