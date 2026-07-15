import { CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import {
  getSalesforceApi,
  type SalesforceApiClient,
} from '../lib/salesforce-api.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';

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
    body.style.cssText = 'padding: 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 16px;';

    // Top Controls
    const topRow = doc.createElement('div');
    topRow.style.cssText = 'display: flex; gap: 16px; align-items: center; border-bottom: 1px solid #e0e0e0; padding-bottom: 16px;';
    body.appendChild(topRow);

    const sobjDiv = doc.createElement('div');
    sobjDiv.style.cssText = 'display: flex; flex-direction: column; gap: 4px; min-width: 250px;';
    const sobjLabel = doc.createElement('label');
    sobjLabel.textContent = 'Select Target SObject';
    sobjLabel.style.cssText = 'font-size: 11px; font-weight: 600; color: #54698d;';
    const sobjSelect = doc.createElement('select');
    sobjSelect.style.cssText = 'padding: 6px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 13px; outline: none;';
    sobjDiv.appendChild(sobjLabel);
    sobjDiv.appendChild(sobjSelect);
    topRow.appendChild(sobjDiv);

    const buttonGroup = doc.createElement('div');
    buttonGroup.style.cssText = 'display: flex; gap: 8px; margin-top: auto;';
    topRow.appendChild(buttonGroup);

    const addFieldBtn = doc.createElement('button');
    addFieldBtn.textContent = '➕ Add Field';
    addFieldBtn.style.cssText = 'padding: 6px 12px; background: #fff; color: #0070d2; border: 1px solid #d8dde6; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600;';
    const permAllBtn = doc.createElement('button');
    permAllBtn.textContent = '🔒 Permissions for All';
    permAllBtn.style.cssText = 'padding: 6px 12px; background: #fff; color: #54698d; border: 1px solid #d8dde6; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600;';
    const clearBtn = doc.createElement('button');
    clearBtn.textContent = '🗑 Clear All';
    clearBtn.style.cssText = 'padding: 6px 12px; background: #fff; color: #c23934; border: 1px solid #c23934; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600;';

    buttonGroup.appendChild(addFieldBtn);
    buttonGroup.appendChild(permAllBtn);
    buttonGroup.appendChild(clearBtn);

    // Table Container
    const tableContainer = doc.createElement('div');
    tableContainer.style.cssText = 'border: 1px solid #d8dde6; border-radius: 4px; overflow: auto; max-height: 40vh;';
    body.appendChild(tableContainer);

    const table = doc.createElement('table');
    table.style.cssText = 'width: 100%; border-collapse: collapse; font-size: 12px; text-align: left;';
    const thead = doc.createElement('thead');
    const headTr = doc.createElement('tr');
    const cols = ['Actions', 'Label', 'Developer Name (__c)', 'Data Type', 'Options', 'FLS', 'Status'];
    for (const c of cols) {
      const th = doc.createElement('th');
      th.textContent = c;
      th.style.cssText = 'padding: 8px 12px; background: #fafaf9; border-bottom: 1px solid #d8dde6; font-weight: 600; position: sticky; top: 0; z-index: 1;';
      headTr.appendChild(th);
    }
    thead.appendChild(headTr);
    table.appendChild(thead);

    const tbody = doc.createElement('tbody');
    table.appendChild(tbody);
    tableContainer.appendChild(table);

    // Bottom Action Row
    const actionRow = doc.createElement('div');
    actionRow.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end; align-items: center; border-top: 1px solid #e0e0e0; padding-top: 16px;';
    body.appendChild(actionRow);

    const deployBtn = doc.createElement('button');
    deployBtn.textContent = 'Deploy Fields';
    deployBtn.style.cssText = 'padding: 8px 20px; background: #04844b; color: #fff; border: 0; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 600;';
    deployBtn.disabled = true;
    actionRow.appendChild(deployBtn);

    view = presentView({
      title: '🛠 Bulk Field Creator',
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
      showToast('Failed to load SObject list', { doc, kind: 'error' });
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
        tr.style.cssText = 'border-bottom: 1px solid #f3f3f3;';

        // Actions
        const tdActions = doc.createElement('td');
        tdActions.style.cssText = 'padding: 8px 12px; display: flex; gap: 6px;';
        const cloneRowBtn = doc.createElement('button');
        cloneRowBtn.textContent = '📋';
        cloneRowBtn.title = 'Clone field definition';
        cloneRowBtn.style.cssText = 'background: none; border: 0; cursor: pointer; font-size: 14px;';
        cloneRowBtn.addEventListener('click', () => {
          fields.push({ ...field, deploymentStatus: undefined, deploymentError: undefined });
          renderRows();
          validateReady();
        });
        const delRowBtn = doc.createElement('button');
        delRowBtn.textContent = '❌';
        delRowBtn.title = 'Delete field definition';
        delRowBtn.style.cssText = 'background: none; border: 0; cursor: pointer; font-size: 12px;';
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
        tdLabel.style.cssText = 'padding: 8px 12px;';
        const labelInput = doc.createElement('input');
        labelInput.type = 'text';
        labelInput.value = field.label;
        labelInput.placeholder = 'Field Label...';
        labelInput.style.cssText = 'width: 140px; padding: 4px 6px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 12px;';
        labelInput.addEventListener('input', () => {
          field.label = labelInput.value;
          field.name = formatApiName(labelInput.value);
          nameInput.value = field.name;
          validateReady();
        });
        tdLabel.appendChild(labelInput);

        // Name
        const tdName = doc.createElement('td');
        tdName.style.cssText = 'padding: 8px 12px;';
        const nameInput = doc.createElement('input');
        nameInput.type = 'text';
        nameInput.value = field.name;
        nameInput.placeholder = 'Developer_Name';
        nameInput.style.cssText = 'width: 140px; padding: 4px 6px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 12px;';
        nameInput.addEventListener('input', () => {
          field.name = nameInput.value;
          validateReady();
        });
        tdName.appendChild(nameInput);

        // Type
        const tdType = doc.createElement('td');
        tdType.style.cssText = 'padding: 8px 12px;';
        const typeSelect = doc.createElement('select');
        typeSelect.style.cssText = 'padding: 4px 6px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 12px;';
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
        tdOpt.style.cssText = 'padding: 8px 12px;';
        const optBtn = doc.createElement('button');
        optBtn.textContent = '⚙️ Options';
        optBtn.style.cssText = 'padding: 4px 8px; background: #fff; border: 1px solid #d8dde6; border-radius: 4px; cursor: pointer; font-size: 11px;';
        optBtn.addEventListener('click', () => {
          openOptionsModal(field);
        });
        tdOpt.appendChild(optBtn);

        // FLS
        const tdFLS = doc.createElement('td');
        tdFLS.style.cssText = 'padding: 8px 12px;';
        const flsBtn = doc.createElement('button');
        flsBtn.textContent = '🔒 FLS';
        flsBtn.style.cssText = 'padding: 4px 8px; background: #fff; border: 1px solid #d8dde6; border-radius: 4px; cursor: pointer; font-size: 11px;';
        if (field.profiles && field.profiles.length > 0) {
          flsBtn.textContent = `🔒 FLS (${field.profiles.length})`;
          flsBtn.style.color = '#04844b';
          flsBtn.style.borderColor = '#04844b';
        }
        flsBtn.addEventListener('click', () => {
          openFLSModal(field, () => {
            renderRows();
          });
        });
        tdFLS.appendChild(flsBtn);

        // Status
        const tdStatus = doc.createElement('td');
        tdStatus.style.cssText = 'padding: 8px 12px; font-weight: bold;';
        if (field.deploymentStatus === 'pending') {
          tdStatus.textContent = '⏳ Pending';
          tdStatus.style.color = '#0070d2';
        } else if (field.deploymentStatus === 'success') {
          tdStatus.textContent = '✅ Success';
          tdStatus.style.color = '#04844b';
        } else if (field.deploymentStatus === 'error') {
          tdStatus.textContent = '❌ Error';
          tdStatus.style.color = '#c23934';
          tdStatus.title = field.deploymentError || 'Unknown error';
        } else {
          tdStatus.textContent = '-';
          tdStatus.style.color = '#80868d';
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
      optOverlay.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.3); z-index: 100030; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif;';
      
      const optModal = doc.createElement('div');
      optModal.style.cssText = 'background: #fff; border-radius: 4px; width: 450px; max-height: 80vh; display: flex; flex-direction: column; padding: 16px; gap: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.1);';
      
      const optTitle = doc.createElement('span');
      optTitle.textContent = `Configure Field: ${field.label || 'New Field'} (${field.type})`;
      optTitle.style.cssText = 'font-weight: 600; font-size: 14px; border-bottom: 1px solid #e0e0e0; padding-bottom: 8px;';
      optModal.appendChild(optTitle);

      const fieldsContainer = doc.createElement('div');
      fieldsContainer.style.cssText = 'display: flex; flex-direction: column; gap: 10px; overflow-y: auto; flex: 1;';
      optModal.appendChild(fieldsContainer);

      // Common: Description, Help Text, Required, Unique, External ID
      const createInput = (labelVal: string, typeVal: string, key: keyof CustomFieldDefinition, defaultVal: any) => {
        const row = doc.createElement('div');
        row.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';
        const lbl = doc.createElement('label');
        lbl.textContent = labelVal;
        lbl.style.cssText = 'font-size: 11px; font-weight: 600; color: #54698d;';
        row.appendChild(lbl);

        if (typeVal === 'text') {
          const inp = doc.createElement('input');
          inp.type = 'text';
          inp.value = String(field[key] ?? defaultVal);
          inp.style.cssText = 'padding: 4px 8px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 12px;';
          inp.addEventListener('input', () => {
            (field as any)[key] = inp.value;
          });
          row.appendChild(inp);
        } else if (typeVal === 'number') {
          const inp = doc.createElement('input');
          inp.type = 'number';
          inp.value = String(field[key] ?? defaultVal);
          inp.style.cssText = 'padding: 4px 8px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 12px;';
          inp.addEventListener('input', () => {
            (field as any)[key] = parseInt(inp.value) || 0;
          });
          row.appendChild(inp);
        } else if (typeVal === 'checkbox') {
          row.style.flexDirection = 'row';
          row.style.alignItems = 'center';
          row.style.gap = '8px';
          const inp = doc.createElement('input');
          inp.type = 'checkbox';
          inp.checked = !!(field[key] ?? defaultVal);
          inp.style.cssText = 'cursor: pointer;';
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
        row.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';
        const lbl = doc.createElement('label');
        lbl.textContent = 'Default Value';
        lbl.style.cssText = 'font-size: 11px; font-weight: 600; color: #54698d;';
        const sel = doc.createElement('select');
        sel.style.cssText = 'padding: 4px 6px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 12px;';
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
        row.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';
        const lbl = doc.createElement('label');
        lbl.textContent = 'Display Format';
        lbl.style.cssText = 'font-size: 11px; font-weight: 600; color: #54698d;';
        const sel = doc.createElement('select');
        sel.style.cssText = 'padding: 4px 6px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 12px;';
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
        row.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';
        const lbl = doc.createElement('label');
        lbl.textContent = 'Picklist Values (Enter values, one per line)';
        lbl.style.cssText = 'font-size: 11px; font-weight: 600; color: #54698d;';
        const area = doc.createElement('textarea');
        area.value = field.picklistvalues || '';
        area.placeholder = 'Value1\nValue2\nValue3';
        area.style.cssText = 'height: 80px; padding: 6px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 12px; resize: vertical;';
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
      buttons.style.cssText = 'display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid #e0e0e0; padding-top: 12px; margin-top: 8px;';
      const saveBtn = doc.createElement('button');
      saveBtn.textContent = 'Save';
      saveBtn.style.cssText = 'padding: 6px 14px; background: #0070d2; color: #fff; border: 0; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600;';
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
      flsOverlay.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.3); z-index: 100030; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif;';
      
      const flsModal = doc.createElement('div');
      flsModal.style.cssText = 'background: #fff; border-radius: 4px; width: 650px; height: 80vh; display: flex; flex-direction: column; padding: 16px; gap: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.1);';
      
      const title = doc.createElement('span');
      title.textContent = targetField 
        ? `Field-Level Security (FLS) for ${targetField.label || 'New Field'}`
        : 'Grant Permissions to All Fields';
      title.style.cssText = 'font-weight: 600; font-size: 14px; border-bottom: 1px solid #e0e0e0; padding-bottom: 8px;';
      flsModal.appendChild(title);

      const searchInp = doc.createElement('input');
      searchInp.placeholder = 'Search Profiles or Permission Sets...';
      searchInp.style.cssText = 'padding: 6px 10px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 12px; outline: none;';
      flsModal.appendChild(searchInp);

      const tableDiv = doc.createElement('div');
      tableDiv.style.cssText = 'flex: 1; overflow-y: auto; border: 1px solid #d8dde6; border-radius: 4px;';
      flsModal.appendChild(tableDiv);

      const flsTable = doc.createElement('table');
      flsTable.style.cssText = 'width: 100%; border-collapse: collapse; font-size: 11px; text-align: left;';
      
      const flsThead = doc.createElement('thead');
      const trHead = doc.createElement('tr');
      const thName = doc.createElement('th');
      thName.textContent = 'Name';
      thName.style.cssText = 'padding: 6px 10px; background: #fafaf9; border-bottom: 1px solid #d8dde6; font-weight: 600; position: sticky; top: 0; z-index: 1;';
      
      const thType = doc.createElement('th');
      thType.textContent = 'Type';
      thType.style.cssText = 'padding: 6px 10px; background: #fafaf9; border-bottom: 1px solid #d8dde6; font-weight: 600; position: sticky; top: 0; z-index: 1;';

      const thRead = doc.createElement('th');
      thRead.textContent = 'Visible';
      thRead.style.cssText = 'padding: 6px 10px; background: #fafaf9; border-bottom: 1px solid #d8dde6; font-weight: 600; position: sticky; top: 0; z-index: 1; text-align: center;';
      const readAll = doc.createElement('input');
      readAll.type = 'checkbox';
      thRead.appendChild(doc.createElement('br'));
      thRead.appendChild(readAll);

      const thEdit = doc.createElement('th');
      thEdit.textContent = 'Read-Write';
      thEdit.style.cssText = 'padding: 6px 10px; background: #fafaf9; border-bottom: 1px solid #d8dde6; font-weight: 600; position: sticky; top: 0; z-index: 1; text-align: center;';
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
          tr.style.cssText = 'border-bottom: 1px solid #f3f3f3;';

          const tdName = doc.createElement('td');
          tdName.textContent = profile || name;
          tdName.style.cssText = 'padding: 6px 10px; font-weight: 500;';

          const tdType = doc.createElement('td');
          tdType.textContent = profile ? 'Profile' : 'Permission Set';
          tdType.style.cssText = 'padding: 6px 10px; color: #54698d;';

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
      buttons.style.cssText = 'display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid #e0e0e0; padding-top: 12px; margin-top: 8px;';
      
      const cancelBtn = doc.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.cssText = 'padding: 6px 12px; background: #fff; border: 1px solid #d8dde6; border-radius: 4px; cursor: pointer; font-size: 12px;';
      cancelBtn.addEventListener('click', () => {
        flsOverlay.remove();
      });

      const saveBtn = doc.createElement('button');
      saveBtn.textContent = 'Save Permissions';
      saveBtn.style.cssText = 'padding: 6px 14px; background: #0070d2; color: #fff; border: 0; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600;';
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
