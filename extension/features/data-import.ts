import { asArray } from '../lib/collections.js';
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

interface FieldDescribe {
  name: string;
  label: string;
  type: string;
  updateable: boolean;
  createable: boolean;
  idLookup: boolean;
  externalId: boolean;
  soapType: string;
}

interface SObjectDescribe {
  name: string;
  label: string;
  fields: FieldDescribe[];
}

export function csvParse(csv: string, separator: string): string[][] {
  const table: string[][] = [];
  let row: string[] = [];
  let offset = 0;
  for (;;) {
    if (offset !== csv.length && csv[offset] === '"') { // quoted
      let next = csv.indexOf('"', offset + 1);
      let text = '';
      for (;;) {
        if (next === -1) {
          throw new Error('Quote not closed at offset ' + offset);
        }
        text += csv.substring(offset + 1, next);
        offset = next + 1;
        if (offset === csv.length || csv[offset] !== '"') {
          break;
        }
        text += '"';
        next = csv.indexOf('"', offset + 1);
      }
      row.push(text);
    } else { // unquoted
      let next = csv.length;
      let i = csv.indexOf(separator, offset);
      if (i !== -1 && i < next) next = i;
      i = csv.indexOf('\n', offset);
      if (i !== -1 && i < next) next = i;
      i = csv.indexOf('\r', offset);
      if (i !== -1 && i < next) next = i;
      const text = csv.substring(offset, next);
      offset = next;
      row.push(text);
    }
    if (offset === csv.length) {
      if (row.length !== 1 || row[0] !== '') {
        table.push(row);
      }
      if (table.length === 0) {
        throw new Error('No data found');
      }
      const len = table[0]!.length;
      for (let r = 0; r < table.length; r++) {
        if (table[r]!.length !== len) {
          throw new Error(`Row ${r + 1} has ${table[r]!.length} cells, expected ${len}`);
        }
      }
      return table;
    } else if (csv[offset] === '\n' || csv[offset] === '\r') {
      if (csv[offset] === '\r' && offset + 1 < csv.length && csv[offset + 1] === '\n') {
        offset += 2;
      } else {
        offset++;
      }
      if (row.length !== 1 || row[0] !== '') {
        table.push(row);
      }
      row = [];
    } else if (csv[offset] === separator) {
      offset++;
    }
  }
}

export function detectSeparator(text: string): string {
  const trimmed = text.trim();
  if (trimmed.includes('\t')) return '\t';
  if (trimmed.includes(',')) return ',';
  if (trimmed.includes(';')) return ';';
  return '\t';
}


interface ImportRow {
  index: number;
  cells: string[];
  status: 'Queued' | 'Processing' | 'Succeeded' | 'Failed';
  action: string;
  resultId: string;
  errors: string;
}

export function createDataImportFeature(options: {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
} = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();

  let view: ViewHandle | null = null;
  let globalDescribeCached: GlobalDescribe | null = null;
  const sobjectDescribesCached = new Map<string, SObjectDescribe>();

  // State
  let headers: string[] = [];
  let originalData: string[][] = [];
  let sObjectList: string[] = [];
  let selectedSObject = '';
  let selectedOperation: 'create' | 'update' | 'upsert' | 'delete' | 'undelete' = 'create';
  let externalIdField = '';
  let batchSize = 200;
  let concurrency = 2;
  let columnMappings: string[] = []; // maps CSV header index to API Name (or empty string/ignored)

  let importRows: ImportRow[] = [];
  let isImporting = false;
  let activeThreads = 0;

  function close(): void {
    // Stop in-flight import workers (their loops check isImporting), then drop
    // the view. Closing the tab fires onClose, which also flips isImporting off.
    isImporting = false;
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

  async function open(): Promise<void> {
    close();

    // Body
    const body = doc.createElement('div');
    body.style.cssText = 'padding: 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 16px;';

    // Configuration Row
    const configRow = doc.createElement('div');
    configRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: 16px; border-bottom: 1px solid #e0e0e0; padding-bottom: 16px;';
    body.appendChild(configRow);

    // Target SObject Select
    const sobjDiv = doc.createElement('div');
    sobjDiv.style.cssText = 'display: flex; flex-direction: column; gap: 4px; min-width: 180px;';
    const sobjLabel = doc.createElement('label');
    sobjLabel.textContent = 'SObject Name';
    sobjLabel.style.cssText = 'font-size: 11px; font-weight: 600; color: #54698d;';
    const sobjSelect = doc.createElement('select');
    sobjSelect.style.cssText = 'padding: 6px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 13px; outline: none;';
    sobjDiv.appendChild(sobjLabel);
    sobjDiv.appendChild(sobjSelect);
    configRow.appendChild(sobjDiv);

    // Operation Select
    const opDiv = doc.createElement('div');
    opDiv.style.cssText = 'display: flex; flex-direction: column; gap: 4px; min-width: 120px;';
    const opLabel = doc.createElement('label');
    opLabel.textContent = 'Operation';
    opLabel.style.cssText = 'font-size: 11px; font-weight: 600; color: #54698d;';
    const opSelect = doc.createElement('select');
    opSelect.style.cssText = 'padding: 6px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 13px; outline: none;';
    const ops = [
      { v: 'create', l: 'Insert' },
      { v: 'update', l: 'Update' },
      { v: 'upsert', l: 'Upsert' },
      { v: 'delete', l: 'Delete' },
      { v: 'undelete', l: 'Undelete' },
    ];
    for (const op of ops) {
      const opt = doc.createElement('option');
      opt.value = op.v;
      opt.textContent = op.l;
      opSelect.appendChild(opt);
    }
    opDiv.appendChild(opLabel);
    opDiv.appendChild(opSelect);
    configRow.appendChild(opDiv);

    // External ID Field Select (only visible for Upsert)
    const extIdDiv = doc.createElement('div');
    extIdDiv.style.cssText = 'display: none; flex-direction: column; gap: 4px; min-width: 150px;';
    const extIdLabel = doc.createElement('label');
    extIdLabel.textContent = 'External ID Field';
    extIdLabel.style.cssText = 'font-size: 11px; font-weight: 600; color: #54698d;';
    const extIdSelect = doc.createElement('select');
    extIdSelect.style.cssText = 'padding: 6px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 13px; outline: none;';
    extIdDiv.appendChild(extIdLabel);
    extIdDiv.appendChild(extIdSelect);
    configRow.appendChild(extIdDiv);

    // Batch Size
    const batchDiv = doc.createElement('div');
    batchDiv.style.cssText = 'display: flex; flex-direction: column; gap: 4px; width: 80px;';
    const batchLabel = doc.createElement('label');
    batchLabel.textContent = 'Batch Size';
    batchLabel.style.cssText = 'font-size: 11px; font-weight: 600; color: #54698d;';
    const batchInput = doc.createElement('input');
    batchInput.type = 'number';
    batchInput.min = '1';
    batchInput.max = '200';
    batchInput.value = '200';
    batchInput.style.cssText = 'padding: 6px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 13px; outline: none;';
    batchDiv.appendChild(batchLabel);
    batchDiv.appendChild(batchInput);
    configRow.appendChild(batchDiv);

    // Thread Concurrency
    const concDiv = doc.createElement('div');
    concDiv.style.cssText = 'display: flex; flex-direction: column; gap: 4px; width: 80px;';
    const concLabel = doc.createElement('label');
    concLabel.textContent = 'Threads';
    concLabel.style.cssText = 'font-size: 11px; font-weight: 600; color: #54698d;';
    const concInput = doc.createElement('input');
    concInput.type = 'number';
    concInput.min = '1';
    concInput.max = '10';
    concInput.value = '2';
    concInput.style.cssText = 'padding: 6px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 13px; outline: none;';
    concDiv.appendChild(concLabel);
    concDiv.appendChild(concInput);
    configRow.appendChild(concDiv);

    // Paste Text Area
    const pasteDiv = doc.createElement('div');
    pasteDiv.style.cssText = 'display: flex; flex-direction: column; gap: 6px;';
    const pasteLabel = doc.createElement('span');
    pasteLabel.textContent = 'Paste CSV / Excel Data (Tab or Comma delimited)';
    pasteLabel.style.cssText = 'font-size: 12px; font-weight: 600; color: #3e3e3c;';
    const pasteArea = doc.createElement('textarea');
    pasteArea.placeholder = 'First row must contain headers. E.g.\nFirstName\tLastName\tEmail\nJohn\tDoe\tjohn.doe@example.com';
    pasteArea.style.cssText = 'height: 100px; padding: 10px; border: 1px solid #d8dde6; border-radius: 4px; font-family: monospace; font-size: 12px; outline: none; resize: vertical;';
    pasteDiv.appendChild(pasteLabel);
    pasteDiv.appendChild(pasteArea);
    body.appendChild(pasteDiv);

    // Mapping Grid Container
    const mappingContainer = doc.createElement('div');
    mappingContainer.style.cssText = 'display: none; flex-direction: column; gap: 6px; border: 1px solid #d8dde6; border-radius: 4px; padding: 12px;';
    const mappingHeader = doc.createElement('span');
    mappingHeader.textContent = 'Field Mappings';
    mappingHeader.style.cssText = 'font-weight: 600; font-size: 13px; color: #16325c;';
    mappingContainer.appendChild(mappingHeader);
    const mappingGrid = doc.createElement('div');
    mappingGrid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; max-height: 200px; overflow-y: auto; padding: 4px;';
    mappingContainer.appendChild(mappingGrid);
    body.appendChild(mappingContainer);

    // Action Row (Import button, Cancel, Download error, etc.)
    const actionRow = doc.createElement('div');
    actionRow.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end; align-items: center; border-top: 1px solid #e0e0e0; padding-top: 16px;';
    body.appendChild(actionRow);

    const importBtn = doc.createElement('button');
    importBtn.textContent = 'Start Import';
    importBtn.style.cssText = 'padding: 8px 20px; background: #0070d2; color: #fff; border: 0; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 600;';
    importBtn.disabled = true;

    const downloadErrorsBtn = doc.createElement('button');
    downloadErrorsBtn.textContent = 'Download Errors CSV';
    downloadErrorsBtn.style.cssText = 'padding: 8px 14px; background: #fff; color: #c23934; border: 1px solid #c23934; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 600; display: none;';

    actionRow.appendChild(downloadErrorsBtn);
    actionRow.appendChild(importBtn);

    // Progress Section
    const progressSection = doc.createElement('div');
    progressSection.style.cssText = 'display: none; flex-direction: column; gap: 12px;';
    const progressInfo = doc.createElement('div');
    progressInfo.style.cssText = 'display: flex; justify-content: space-between; font-size: 13px; font-weight: 600;';
    const progressLabel = doc.createElement('span');
    progressLabel.textContent = 'Import Progress';
    const progressStats = doc.createElement('span');
    progressStats.style.cssText = 'color: #54698d;';
    progressInfo.appendChild(progressLabel);
    progressInfo.appendChild(progressStats);
    progressSection.appendChild(progressInfo);

    const progressOuter = doc.createElement('div');
    progressOuter.style.cssText = 'height: 8px; background: #e0e0e0; border-radius: 4px; overflow: hidden;';
    const progressInner = doc.createElement('div');
    progressInner.style.cssText = 'height: 100%; width: 0%; background: #0070d2; transition: width 0.2s;';
    progressOuter.appendChild(progressInner);
    progressSection.appendChild(progressOuter);

    const statsGrid = doc.createElement('div');
    statsGrid.style.cssText = 'display: flex; gap: 20px; font-size: 12px; justify-content: flex-start; background: #fafaf9; padding: 10px; border-radius: 4px;';
    const queuedStat = doc.createElement('span');
    queuedStat.textContent = 'Queued: 0';
    queuedStat.style.color = '#54698d';
    const processingStat = doc.createElement('span');
    processingStat.textContent = 'Processing: 0';
    processingStat.style.color = '#0070d2';
    const succeededStat = doc.createElement('span');
    succeededStat.textContent = 'Succeeded: 0';
    succeededStat.style.color = '#04844b';
    const failedStat = doc.createElement('span');
    failedStat.textContent = 'Failed: 0';
    failedStat.style.color = '#c23934';
    statsGrid.appendChild(queuedStat);
    statsGrid.appendChild(processingStat);
    statsGrid.appendChild(succeededStat);
    statsGrid.appendChild(failedStat);
    progressSection.appendChild(statsGrid);

    // Results Table Container
    const resultsContainer = doc.createElement('div');
    resultsContainer.style.cssText = 'display: none; border: 1px solid #d8dde6; border-radius: 4px; overflow: auto; max-height: 250px;';
    const resultsTable = doc.createElement('table');
    resultsTable.style.cssText = 'width: 100%; border-collapse: collapse; font-size: 11px; text-align: left;';
    const resultsTHead = doc.createElement('thead');
    const headTr = doc.createElement('tr');
    const headerCols = ['Row #', 'Status', 'Operation / Action', 'Record ID', 'Message / Errors'];
    for (const hCol of headerCols) {
      const th = doc.createElement('th');
      th.textContent = hCol;
      th.style.cssText = 'padding: 6px 10px; background: #fafaf9; border-bottom: 1px solid #d8dde6; font-weight: 600; position: sticky; top: 0; z-index: 1;';
      headTr.appendChild(th);
    }
    resultsTHead.appendChild(headTr);
    resultsTable.appendChild(resultsTHead);
    const resultsTBody = doc.createElement('tbody');
    resultsTable.appendChild(resultsTBody);
    resultsContainer.appendChild(resultsTable);
    progressSection.appendChild(resultsContainer);

    body.appendChild(progressSection);

    view = presentView({
      title: '📥 Data Import Wizard',
      body,
      doc,
      width: '1000px',
      onClose: () => {
        isImporting = false;
        view = null;
      },
    });

    // Load SObject names
    try {
      const globalDesc = await getGlobalDescribe();
      sObjectList = globalDesc.sobjects
        .filter(s => s.queryable)
        .map(s => s.name)
        .sort();
      
      while (sobjSelect.firstChild) sobjSelect.removeChild(sobjSelect.firstChild);
      const placeholderOpt = doc.createElement('option');
      placeholderOpt.value = '';
      placeholderOpt.textContent = '-- Select Target SObject --';
      sobjSelect.appendChild(placeholderOpt);

      for (const name of sObjectList) {
        const opt = doc.createElement('option');
        opt.value = name;
        opt.textContent = name;
        sobjSelect.appendChild(opt);
      }
    } catch (err) {
      showToast('Failed to load SObject list: ' + (err instanceof Error ? err.message : String(err)), { doc, kind: 'error' });
    }

    // Event Handlers
    let activeSobjectFields: FieldDescribe[] = [];

    async function loadFieldsForSelectedObject(sobjectName: string) {
      if (!sobjectName) {
        activeSobjectFields = [];
        mappingContainer.style.display = 'none';
        importBtn.disabled = true;
        return;
      }

      try {
        const desc = await getSObjectDescribe(sobjectName);
        activeSobjectFields = desc.fields;

        // Auto guess mappings if table is loaded
        autoGuessMappings();
        renderMappingGrid();

        // Populate External ID Dropdown
        while (extIdSelect.firstChild) extIdSelect.removeChild(extIdSelect.firstChild);
        const lookups = activeSobjectFields.filter(f => f.externalId || f.idLookup || f.name.toLowerCase() === 'id');
        for (const f of lookups) {
          const opt = doc.createElement('option');
          opt.value = f.name;
          opt.textContent = `${f.label} (${f.name})`;
          extIdSelect.appendChild(opt);
        }
        if (lookups.length > 0) {
          // pre-select ID or externalId
          const externalIdMatch = lookups.find(f => f.externalId);
          const idMatch = lookups.find(f => f.name.toLowerCase() === 'id');
          extIdSelect.value = (externalIdMatch || idMatch || lookups[0])!.name;
          externalIdField = extIdSelect.value;
        }

        validateReadyToImport();
      } catch (err) {
        showToast('Describe failed: ' + (err instanceof Error ? err.message : String(err)), { doc, kind: 'error' });
      }
    }

    sobjSelect.addEventListener('change', async () => {
      selectedSObject = sobjSelect.value;
      // Auto toggle to metadata API type for custom metadata
      const isMdt = selectedSObject.endsWith('__mdt');
      if (isMdt) {
        opSelect.value = 'upsert';
        selectedOperation = 'upsert';
        opSelect.disabled = true;
      } else {
        opSelect.disabled = false;
      }
      await loadFieldsForSelectedObject(selectedSObject);
    });

    opSelect.addEventListener('change', () => {
      selectedOperation = opSelect.value as any;
      if (selectedOperation === 'upsert') {
        extIdDiv.style.display = 'flex';
      } else {
        extIdDiv.style.display = 'none';
      }
      validateReadyToImport();
    });

    extIdSelect.addEventListener('change', () => {
      externalIdField = extIdSelect.value;
    });

    batchInput.addEventListener('input', () => {
      batchSize = Math.max(1, Math.min(200, parseInt(batchInput.value) || 200));
    });

    concInput.addEventListener('input', () => {
      concurrency = Math.max(1, Math.min(10, parseInt(concInput.value) || 2));
    });

    pasteArea.addEventListener('input', () => {
      const text = pasteArea.value;
      if (!text.trim()) {
        headers = [];
        originalData = [];
        mappingContainer.style.display = 'none';
        importBtn.disabled = true;
        return;
      }

      try {
        const separator = detectSeparator(text);
        const parsed = csvParse(text, separator);
        if (parsed.length < 2) {
          throw new Error('Requires at least a header row and 1 data row');
        }
        headers = parsed[0]!.map(h => h.trim());
        originalData = parsed.slice(1);

        // Auto guess target SObject if header has an ID and a key prefix match
        guessSObjectType(originalData);

        if (selectedSObject) {
          autoGuessMappings();
          renderMappingGrid();
        }
        validateReadyToImport();
      } catch (err) {
        importBtn.disabled = true;
        showToast('CSV Parse Error: ' + (err instanceof Error ? err.message : String(err)), { doc, kind: 'error' });
      }
    });

    function guessSObjectType(rows: string[][]) {
      const idIdx = headers.findIndex(h => h.toLowerCase() === 'id');
      if (idIdx !== -1 && rows.length > 0 && rows[0]![idIdx]) {
        const idVal = rows[0]![idIdx]!;
        if (idVal.length >= 3) {
          const prefix = idVal.substring(0, 3);
          const globalDesc = globalDescribeCached;
          if (globalDesc) {
            const match = globalDesc.sobjects.find(s => s.keyPrefix === prefix);
            if (match) {
              sobjSelect.value = match.name;
              selectedSObject = match.name;
              selectedOperation = 'update';
              opSelect.value = 'update';
              void loadFieldsForSelectedObject(selectedSObject);
            }
          }
        }
      }
    }

    function autoGuessMappings() {
      columnMappings = headers.map(h => {
        // Find field in activeSobjectFields where name matches h or label matches h
        const cleanHeader = h.toLowerCase().replace(/[\s_-]/g, '');
        const match = activeSobjectFields.find(f => {
          const cleanFieldName = f.name.toLowerCase().replace(/[\s_-]/g, '');
          const cleanLabel = f.label.toLowerCase().replace(/[\s_-]/g, '');
          return cleanFieldName === cleanHeader || cleanLabel === cleanHeader;
        });
        return match ? match.name : '';
      });
    }

    function renderMappingGrid() {
      while (mappingGrid.firstChild) mappingGrid.removeChild(mappingGrid.firstChild);
      mappingContainer.style.display = 'flex';

      headers.forEach((h, idx) => {
        const colDiv = doc.createElement('div');
        colDiv.style.cssText = 'display: flex; flex-direction: column; gap: 2px; border: 1px solid #f3f3f3; padding: 6px; border-radius: 4px; background: #fafaf9;';
        
        const headerLabel = doc.createElement('span');
        headerLabel.textContent = h;
        headerLabel.style.cssText = 'font-weight: 600; font-size: 11px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;';
        
        const select = doc.createElement('select');
        select.style.cssText = 'padding: 4px; font-size: 11px; border: 1px solid #d8dde6; border-radius: 4px; outline: none;';
        
        const optSkip = doc.createElement('option');
        optSkip.value = '';
        optSkip.textContent = '✖ Skip field';
        select.appendChild(optSkip);

        // Populate fields
        activeSobjectFields.forEach(f => {
          const opt = doc.createElement('option');
          opt.value = f.name;
          opt.textContent = `${f.label} (${f.name})`;
          if (columnMappings[idx] === f.name) {
            opt.selected = true;
          }
          select.appendChild(opt);
        });

        select.addEventListener('change', () => {
          columnMappings[idx] = select.value;
          validateReadyToImport();
        });

        colDiv.appendChild(headerLabel);
        colDiv.appendChild(select);
        mappingGrid.appendChild(colDiv);
      });
    }

    function validateReadyToImport() {
      if (!selectedSObject) {
        importBtn.disabled = true;
        return;
      }
      if (originalData.length === 0) {
        importBtn.disabled = true;
        return;
      }
      // Delete/undelete require an Id column to be mapped
      if (selectedOperation === 'delete' || selectedOperation === 'undelete') {
        const hasId = columnMappings.some(m => m.toLowerCase() === 'id');
        if (!hasId) {
          importBtn.disabled = true;
          return;
        }
        importBtn.disabled = false;
        return;
      }
      // Check if at least one column is mapped
      const hasMapped = columnMappings.some(m => m !== '');
      if (!hasMapped) {
        importBtn.disabled = true;
        return;
      }
      importBtn.disabled = false;
    }

    // Batch execute import
    importBtn.addEventListener('click', () => {
      if (isImporting) return;
      isImporting = true;
      importBtn.disabled = true;
      pasteArea.disabled = true;
      sobjSelect.disabled = true;
      opSelect.disabled = true;
      extIdSelect.disabled = true;
      batchInput.disabled = true;
      concInput.disabled = true;

      // Initialize rows
      importRows = originalData.map((cells, idx) => ({
        index: idx + 1,
        cells,
        status: 'Queued',
        action: '',
        resultId: '',
        errors: '',
      }));

      progressSection.style.display = 'flex';
      resultsContainer.style.display = 'block';

      renderStats();
      renderResultsTable();

      void startQueueProcess();
    });

    function renderStats() {
      const total = importRows.length;
      const queued = importRows.filter(r => r.status === 'Queued').length;
      const processing = importRows.filter(r => r.status === 'Processing').length;
      const succeeded = importRows.filter(r => r.status === 'Succeeded').length;
      const failed = importRows.filter(r => r.status === 'Failed').length;

      progressStats.textContent = `${succeeded + failed} of ${total} imported`;
      const pct = total > 0 ? ((succeeded + failed) / total) * 100 : 0;
      progressInner.style.width = `${pct}%`;

      queuedStat.textContent = `Queued: ${queued}`;
      processingStat.textContent = `Processing: ${processing}`;
      succeededStat.textContent = `Succeeded: ${succeeded}`;
      failedStat.textContent = `Failed: ${failed}`;

      if (failed > 0) {
        downloadErrorsBtn.style.display = 'inline-block';
      } else {
        downloadErrorsBtn.style.display = 'none';
      }
    }

    function renderResultsTable() {
      while (resultsTBody.firstChild) resultsTBody.removeChild(resultsTBody.firstChild);

      // Render only a subset of rows to avoid freezing the DOM if there are thousands
      const slice = importRows.slice(0, 1000);
      for (const row of slice) {
        const tr = doc.createElement('tr');
        tr.style.cssText = 'border-bottom: 1px solid #f3f3f3;';
        if (row.status === 'Succeeded') {
          tr.style.background = '#f4fbf7';
        } else if (row.status === 'Failed') {
          tr.style.background = '#fdf3f2';
        }

        const tdIndex = doc.createElement('td');
        tdIndex.textContent = String(row.index);
        tdIndex.style.cssText = 'padding: 6px 10px; font-weight: bold; color: #54698d;';

        const tdStatus = doc.createElement('td');
        tdStatus.textContent = row.status;
        tdStatus.style.cssText = 'padding: 6px 10px; font-weight: 600;';
        if (row.status === 'Succeeded') tdStatus.style.color = '#04844b';
        else if (row.status === 'Failed') tdStatus.style.color = '#c23934';
        else if (row.status === 'Processing') tdStatus.style.color = '#0070d2';

        const tdAction = doc.createElement('td');
        tdAction.textContent = row.action || '-';
        tdAction.style.cssText = 'padding: 6px 10px; color: #54698d;';

        const tdId = doc.createElement('td');
        tdId.style.cssText = 'padding: 6px 10px;';
        if (row.resultId) {
          const idLink = doc.createElement('span');
          idLink.textContent = row.resultId;
          idLink.style.cssText = 'color: #0070d2; text-decoration: underline; cursor: pointer;';
          idLink.addEventListener('click', () => {
            // open view-all-data or inspect-record
            // Just copy it or open a link
            win.open(`/lightning/r/${selectedSObject}/${row.resultId}/view`, '_blank');
          });
          tdId.appendChild(idLink);
        } else {
          tdId.textContent = '-';
        }

        const tdErrors = doc.createElement('td');
        tdErrors.textContent = row.errors || '-';
        tdErrors.style.cssText = 'padding: 6px 10px;';
        if (row.errors) {
          tdErrors.style.color = '#c23934';
          tdErrors.style.fontWeight = '500';
        }

        tr.appendChild(tdIndex);
        tr.appendChild(tdStatus);
        tr.appendChild(tdAction);
        tr.appendChild(tdId);
        tr.appendChild(tdErrors);
        resultsTBody.appendChild(tr);
      }

      if (importRows.length > 1000) {
        const tr = doc.createElement('tr');
        const td = doc.createElement('td');
        td.colSpan = 5;
        td.textContent = `... and ${importRows.length - 1000} more rows (errors will still download completely) ...`;
        td.style.cssText = 'padding: 8px; text-align: center; color: #80868d; font-style: italic; background: #fafaf9;';
        tr.appendChild(td);
        resultsTBody.appendChild(tr);
      }
    }

    async function startQueueProcess() {
      activeThreads = 0;
      for (let i = 0; i < concurrency; i++) {
        void spawnWorker();
      }
    }

    async function spawnWorker() {
      if (!isImporting) return;
      activeThreads++;
      
      while (isImporting) {
        // Find next chunk of queued items
        const queued = importRows.filter(r => r.status === 'Queued');
        if (queued.length === 0) break;

        const chunk = queued.slice(0, batchSize);
        chunk.forEach(r => { r.status = 'Processing'; });
        renderStats();

        try {
          await executeBatchRequest(chunk);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          chunk.forEach(r => {
            r.status = 'Failed';
            r.errors = errorMsg;
          });
        }

        renderStats();
        renderResultsTable();
      }

      activeThreads--;
      if (activeThreads === 0) {
        isImporting = false;
        importBtn.disabled = false;
        pasteArea.disabled = false;
        sobjSelect.disabled = false;
        opSelect.disabled = false;
        extIdSelect.disabled = false;
        batchInput.disabled = false;
        concInput.disabled = false;
        showToast('Data Import finished.', { doc, kind: 'success' });
      }
    }

    async function executeBatchRequest(chunk: ImportRow[]) {
      const isDelete = selectedOperation === 'delete' || selectedOperation === 'undelete';
      let idColIdx = -1;
      if (isDelete || selectedOperation === 'update' || selectedOperation === 'upsert') {
        idColIdx = columnMappings.findIndex(m => m.toLowerCase() === 'id');
      }

      const importArgs: any = {};
      if (selectedOperation === 'upsert') {
        importArgs.externalIDFieldName = externalIdField;
      }

      if (selectedOperation === 'delete' || selectedOperation === 'undelete') {
        // Delete needs the list of IDs
        const ids = chunk.map(r => {
          const cellId = idColIdx !== -1 ? r.cells[idColIdx] : '';
          return cellId ? cellId.trim() : '';
        });
        importArgs.ID = ids;
      } else {
        // Create, Update, Upsert
        const sObjects = chunk.map(r => {
          const sobj: any = {
            '$xsi:type': selectedSObject,
            fieldsToNull: [] as string[]
          };

          headers.forEach((h, colIdx) => {
            const mappedField = columnMappings[colIdx];
            if (!mappedField) return; // skip

            const value = r.cells[colIdx]?.trim() ?? '';
            if (value === '') {
              // Only null fields that are not the ID lookup field
              if (mappedField.toLowerCase() !== 'id' && mappedField !== externalIdField) {
                sobj.fieldsToNull.push(mappedField);
              }
            } else {
              sobj[mappedField] = value;
            }
          });

          return sobj;
        });

        importArgs.sObjects = sObjects;
      }

      const soapMethod = selectedOperation === 'create' ? 'create' : selectedOperation;
      const res = await api.apiSoap<any>('Partner', soapMethod, importArgs);
      const results = asArray(res);

      for (let i = 0; i < chunk.length; i++) {
        const row = chunk[i]!;
        const result = results[i];
        if (result) {
          if (result.success === 'true') {
            row.status = 'Succeeded';
            row.resultId = result.id || '';
            row.action = selectedOperation === 'create' ? 'Inserted'
              : selectedOperation === 'update' ? 'Updated'
              : selectedOperation === 'upsert' ? (result.created === 'true' ? 'Inserted' : 'Updated')
              : selectedOperation === 'delete' ? 'Deleted'
              : 'Undeleted';
          } else {
            row.status = 'Failed';
            row.resultId = result.id || '';
            row.errors = asArray(result.errors).map(e => `${e.statusCode}: ${e.message} [${asArray(e.fields).join(', ')}]`).join(', ');
          }
        } else {
          row.status = 'Failed';
          row.errors = 'No result returned from SOAP API for this row.';
        }
      }
    }

    downloadErrorsBtn.addEventListener('click', () => {
      const failed = importRows.filter(r => r.status === 'Failed');
      if (failed.length === 0) return;

      const csvHeader = [...headers, '__RowNumber', '__Errors'];
      const csvRows = failed.map(r => [...r.cells, String(r.index), r.errors]);
      
      const serialized = csvSerialize([csvHeader, ...csvRows], ',');
      const blob = new Blob([serialized], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = doc.createElement('a');
      link.href = url;
      link.setAttribute('download', `${selectedSObject}_import_errors.csv`);
      doc.body.appendChild(link);
      link.click();
      doc.body.removeChild(link);
    });
  }

  return {
    manifest: {
      id: 'data-import',
      name: 'Data Import Wizard',
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

function csvSerialize(table: string[][], separator: string): string {
  return table.map(row => row.map(text => '"' + ('' + (text == null ? '' : text)).split('"').join('""') + '"').join(separator)).join('\r\n');
}

export function _dataImportTestApi() {
  return { csvParse, detectSeparator, csvSerialize };
}
