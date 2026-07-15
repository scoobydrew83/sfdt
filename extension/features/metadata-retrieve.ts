import { asArray } from '../lib/collections.js';
import { CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import {
  getSalesforceApi,
  type SalesforceApiClient,
} from '../lib/salesforce-api.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';

interface MetadataObject {
  xmlName: string;
  childXmlNames: any[];
  isFolder: boolean;
  selected?: boolean;
  expanded?: boolean;
  hidden?: boolean;
  icon?: string;
  directoryName?: string;
  inFolder?: boolean;
}

interface FileProperty {
  fullName: string;
  fileName: string;
  type: string;
  id: string;
  namespacePrefix?: string;
  selected?: boolean;
  hidden?: boolean;
  expanded?: boolean;
  childXmlNames?: any[];
  isFolder?: boolean;
}


export function createMetadataRetrieveFeature(options: {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
} = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();

  let view: ViewHandle | null = null;
  let metadataObjects: MetadataObject[] = [];
  let packageXml = '';
  let metadataFilter = '';
  let includeManagedPackage = false;
  const sortMetadataBy: 'fullName' | 'fileName' = 'fullName';

  // Deploy Options
  const deployOptions = {
    allowMissingFiles: false,
    checkOnly: false,
    ignoreWarnings: false,
    purgeOnDelete: false,
    singlePackage: true,
    performRetrieve: true,
    rollbackOnError: true,
    testLevel: 'NoTestRun',
    runTests: '',
  };

  // State
  let isWorking = false;
  const logMessages: { level: 'info' | 'working' | 'error' | 'success'; text: string }[] = [];

  function close(): void {
    view?.close();
    view = null;
    isWorking = false;
  }

  function addLog(level: 'info' | 'working' | 'error' | 'success', text: string): void {
    logMessages.push({ level, text });
    renderLogs();
  }

  function clearLogs(): void {
    logMessages.length = 0;
    renderLogs();
  }

  let xmlTextareaEl: HTMLTextAreaElement | null = null;
  let logsContainer: HTMLDivElement | null = null;
  function renderLogs(): void {
    if (!logsContainer) return;
    logsContainer.replaceChildren();
    for (const msg of logMessages) {
      const item = doc.createElement('div');
      item.style.cssText = 'padding: 2px 0; font-family: monospace; font-size: 11px; border-bottom: 1px solid var(--sfdt-color-bg);';
      if (msg.level === 'error') {
        item.style.color = 'var(--sfdt-color-error)';
        item.textContent = `❌ ${msg.text}`;
      } else if (msg.level === 'success') {
        item.style.color = 'var(--sfdt-color-success)';
        item.textContent = `✅ ${msg.text}`;
      } else if (msg.level === 'working') {
        item.style.color = 'var(--sfdt-color-brand)';
        item.textContent = `⏳ ${msg.text}`;
      } else {
        item.style.color = 'var(--sfdt-color-text-weak)';
        item.textContent = `ℹ️ ${msg.text}`;
      }
      logsContainer.appendChild(item);
    }
    logsContainer.scrollTop = logsContainer.scrollHeight;
  }

  async function loadMetadataDescribe(): Promise<void> {
    isWorking = true;
    updateSpinner();
    addLog('working', 'Loading metadata describe details...');
    try {
      const apiVersion = (api as any).apiVersion ?? 'v62.0';
      const cleanVersion = apiVersion.replace(/^v/, '');
      const res = await api.apiSoap<any>('Metadata', 'describeMetadata', { apiVersion: cleanVersion });
      if (res && res.metadataObjects) {
        const objs = asArray(res.metadataObjects).map((obj: any) => ({
          xmlName: obj.xmlName,
          childXmlNames: [],
          isFolder: false,
          selected: false,
          expanded: false,
          directoryName: obj.directoryName,
          inFolder: obj.inFolder === 'true' || obj.inFolder === true,
        }));

        // Push CustomField as a virtual item
        if (!objs.some(o => o.xmlName === 'CustomField')) {
          objs.push({
            xmlName: 'CustomField',
            childXmlNames: [],
            isFolder: false,
            selected: false,
            expanded: false,
            directoryName: 'fields',
            inFolder: false,
          });
        }

        objs.sort((a, b) => a.xmlName.localeCompare(b.xmlName));
        metadataObjects = objs;
        addLog('success', `Metadata describe loaded: ${metadataObjects.length} metadata types found.`);
        generatePackageXml();
        renderTree();
      } else {
        addLog('error', 'Failed to parse metadata describe response.');
      }
    } catch (err: any) {
      addLog('error', `Describe metadata failed: ${err.message}`);
    } finally {
      isWorking = false;
      updateSpinner();
    }
  }

  function getMetaFolderProof(meta: MetadataObject): { xmlName: string; directoryName: string } {
    if (meta.xmlName === 'Report' && !meta.isFolder) {
      return { xmlName: 'ReportFolder', directoryName: '*' };
    } else if ((meta.xmlName === 'Dashboard' || meta.xmlName === 'Document') && !meta.isFolder) {
      return { xmlName: meta.xmlName + 'Folder', directoryName: '*' };
    } else if (meta.xmlName === 'EmailTemplate' && !meta.isFolder) {
      return { xmlName: 'EmailFolder', directoryName: '*' };
    } else {
      return { xmlName: meta.xmlName, directoryName: meta.directoryName ?? '*' };
    }
  }

  async function toggleExpand(meta: MetadataObject | FileProperty): Promise<void> {
    const anyMeta = meta as any;
    anyMeta.expanded = !anyMeta.expanded;
    if (anyMeta.expanded && (!anyMeta.childXmlNames || anyMeta.childXmlNames.length === 0)) {
      isWorking = true;
      updateSpinner();
      addLog('working', `Fetching components for ${anyMeta.xmlName ?? anyMeta.fullName}...`);
      try {
        const apiVersion = (api as any).apiVersion ?? 'v62.0';
        const cleanVersion = apiVersion.replace(/^v/, '');
        const folderProof = getMetaFolderProof(anyMeta);
        const res = await api.apiSoap<any>('Metadata', 'listMetadata', {
          queries: {
            type: folderProof.xmlName,
            folder: folderProof.directoryName !== '*' ? folderProof.directoryName : undefined,
          },
          asOfVersion: cleanVersion,
        });

        anyMeta.childXmlNames = [];
        if (res) {
          const resArray = asArray(res);
          resArray.forEach((elt: any) => {
            const isFolder = elt.type && elt.type.endsWith('Folder');
            const child: FileProperty = {
              fullName: elt.fullName,
              fileName: elt.fileName,
              type: elt.type,
              id: elt.id,
              namespacePrefix: elt.namespacePrefix,
              selected: !!anyMeta.selected,
              expanded: false,
              childXmlNames: [],
              isFolder,
            };
            if (isFolder) {
              child.type = anyMeta.xmlName ?? anyMeta.type;
            }
            if (includeManagedPackage || !elt.namespacePrefix) {
              anyMeta.childXmlNames.push(child);
            }
          });
          anyMeta.childXmlNames.sort((a: any, b: any) => {
            const valA = a[sortMetadataBy] ?? '';
            const valB = b[sortMetadataBy] ?? '';
            return valA.localeCompare(valB);
          });
        }
        addLog('success', `Loaded ${anyMeta.childXmlNames.length} members for ${anyMeta.xmlName ?? anyMeta.fullName}.`);
      } catch (err: any) {
        addLog('error', `Failed to load members: ${err.message}`);
      } finally {
        isWorking = false;
        updateSpinner();
      }
    }
    generatePackageXml();
    renderTree();
  }

  function selectMetaItem(meta: MetadataObject | FileProperty, selected: boolean): void {
    meta.selected = selected;
    if (meta.childXmlNames) {
      meta.childXmlNames.forEach(c => selectMetaItem(c, selected));
    }
    generatePackageXml();
    renderTree();
  }

  function generatePackageXml(): void {
    const grouped: Record<string, Set<string>> = {};
    metadataObjects.forEach(meta => {
      if (meta.selected || (meta.childXmlNames && meta.childXmlNames.some(c => c.selected))) {
        const name = meta.xmlName;
        if (!grouped[name]) grouped[name] = new Set();
        const activeChildren = meta.childXmlNames.filter(c => c.selected);
        if (activeChildren.length > 0) {
          activeChildren.forEach(c => grouped[name]!.add(c.fullName));
        } else if (meta.selected) {
          grouped[name]!.add('*');
        }
      }
    });

    const apiVersion = (api as any).apiVersion ?? 'v62.0';
    const cleanVersion = apiVersion.replace(/^v/, '');

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n';
    Object.entries(grouped).forEach(([type, members]) => {
      xml += '    <types>\n';
      Array.from(members).sort().forEach(m => {
        xml += `        <members>${m}</members>\n`;
      });
      xml += `        <name>${type}</name>\n`;
      xml += '    </types>\n';
    });
    xml += `    <version>${cleanVersion}</version>\n`;
    xml += '</Package>';

    packageXml = xml;
    if (xmlTextareaEl) xmlTextareaEl.value = packageXml;
  }

  function loadFromPackageXml(xmlStr: string): void {
    try {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlStr, 'text/xml');
      const parseError = xmlDoc.querySelector('parsererror');
      if (parseError) {
        addLog('error', `XML parsing error: ${parseError.textContent}`);
        return;
      }

      // Reset tree selections first
      metadataObjects.forEach(o => {
        o.selected = false;
        o.expanded = false;
        o.childXmlNames = [];
      });

      const types = xmlDoc.getElementsByTagName('types');
      for (let i = 0; i < types.length; i++) {
        const typeNode = types[i]!;
        const nameNode = typeNode.getElementsByTagName('name')[0];
        const typeName = nameNode ? nameNode.textContent?.trim() : null;
        if (!typeName) continue;

        const members = Array.from(typeNode.getElementsByTagName('members')).map(m => m.textContent?.trim() ?? '').filter(Boolean);
        const match = metadataObjects.find(o => o.xmlName === typeName);
        if (match) {
          match.selected = members.includes('*');
          if (members.length > 0 && !members.includes('*')) {
            match.expanded = true;
            match.childXmlNames = members.map(m => ({
              fullName: m,
              fileName: m,
              type: typeName,
              id: '',
              selected: true,
              expanded: false,
              childXmlNames: [],
            }));
          }
        }
      }

      packageXml = xmlStr;
      if (xmlTextareaEl) xmlTextareaEl.value = packageXml;
      renderTree();
      addLog('success', 'package.xml imported successfully and tree updated.');
    } catch (err: any) {
      addLog('error', `Import package.xml failed: ${err.message}`);
    }
  }

  async function runRetrieve(): Promise<void> {
    if (isWorking) return;
    isWorking = true;
    updateSpinner();
    clearLogs();
    addLog('working', 'Initiating SOAP retrieve request...');

    try {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(packageXml, 'text/xml');
      const types = xmlDoc.getElementsByTagName('types');
      const typeList: any[] = [];
      for (let i = 0; i < types.length; i++) {
        const typeNode = types[i]!;
        const name = typeNode.getElementsByTagName('name')[0]?.textContent?.trim() ?? '';
        const members = Array.from(typeNode.getElementsByTagName('members')).map(m => m.textContent?.trim() ?? '').filter(Boolean);
        typeList.push({ name, members });
      }

      const apiVersion = (api as any).apiVersion ?? 'v62.0';
      const cleanVersion = apiVersion.replace(/^v/, '');
      const retrieveRequest = {
        apiVersion: cleanVersion,
        unpackaged: {
          types: typeList,
          version: cleanVersion,
        },
      };

      const result = await api.apiSoap<any>('Metadata', 'retrieve', { retrieveRequest });
      if (!result || !result.id) {
        throw new Error('No retrieve ID returned from SOAP API');
      }

      const jobId = result.id;
      addLog('working', `Retrieve job submitted. Job ID: ${jobId}`);

      // Polling loop (capped to avoid hanging forever if the job stalls)
      const pollDelayMs = 2000;
      const maxPollMs = 5 * 60 * 1000; // ~5 minutes total wait
      const maxChecks = Math.ceil(maxPollMs / pollDelayMs);
      let done = false;
      let checkCount = 0;
      while (!done) {
        if (checkCount >= maxChecks) {
          throw new Error(`Retrieve timed out after ${Math.round(maxPollMs / 1000)}s waiting for job ${jobId} to complete.`);
        }
        checkCount++;
        await new Promise(r => setTimeout(r, pollDelayMs));
        addLog('working', `Checking retrieve status (attempt ${checkCount})...`);
        const statusRes = await api.apiSoap<any>('Metadata', 'checkRetrieveStatus', { id: jobId });
        if (statusRes.done === 'true' || statusRes.done === true) {
          done = true;
          if (statusRes.success === 'true' || statusRes.success === true) {
            addLog('success', 'Retrieve job completed successfully.');
            // Download zipFile
            if (statusRes.zipFile) {
              const binaryString = atob(statusRes.zipFile);
              const bytes = new Uint8Array(binaryString.length);
              for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
              }
              const blob = new Blob([bytes], { type: 'application/zip' });
              const a = doc.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = `metadata_retrieve_${jobId}.zip`;
              doc.body.appendChild(a);
              a.click();
              a.remove();
              addLog('success', 'Metadata zip downloaded successfully.');
            } else {
              addLog('error', 'Completed retrieve status contains no zipFile payload.');
            }
          } else {
            addLog('error', `Retrieve job failed. Status: ${statusRes.status || 'Unknown'}`);
          }
        }
      }
    } catch (err: any) {
      addLog('error', `Retrieve failed: ${err.message}`);
    } finally {
      isWorking = false;
      updateSpinner();
    }
  }

  async function runDeploy(zipBytes: Uint8Array): Promise<void> {
    if (isWorking) return;
    isWorking = true;
    updateSpinner();
    clearLogs();
    addLog('working', 'Converting ZIP file to base64...');

    try {
      let binary = '';
      const len = zipBytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(zipBytes[i]!);
      }
      const zipBase64 = btoa(binary);

      addLog('working', 'Initiating SOAP deploy request...');
      const reqOpts: any = {
        allowMissingFiles: deployOptions.allowMissingFiles,
        checkOnly: deployOptions.checkOnly,
        ignoreWarnings: deployOptions.ignoreWarnings,
        purgeOnDelete: deployOptions.purgeOnDelete,
        singlePackage: deployOptions.singlePackage,
        rollbackOnError: deployOptions.rollbackOnError,
        testLevel: deployOptions.testLevel,
      };
      if (deployOptions.testLevel === 'RunSpecifiedTests' && deployOptions.runTests) {
        reqOpts.runTests = deployOptions.runTests.split(',').map(s => s.trim()).filter(Boolean);
      }

      const result = await api.apiSoap<any>('Metadata', 'deploy', {
        zipFile: zipBase64,
        deployOptions: reqOpts,
      });

      if (!result || !result.id) {
        throw new Error('No deployment job ID returned from SOAP API');
      }

      const jobId = result.id;
      addLog('working', `Deploy job submitted. Job ID: ${jobId}`);

      // Polling loop (capped to avoid hanging forever if the job stalls)
      const pollDelayMs = 2000;
      const maxPollMs = 5 * 60 * 1000; // ~5 minutes total wait
      const maxChecks = Math.ceil(maxPollMs / pollDelayMs);
      let done = false;
      let checkCount = 0;
      while (!done) {
        if (checkCount >= maxChecks) {
          throw new Error(`Deploy timed out after ${Math.round(maxPollMs / 1000)}s waiting for job ${jobId} to complete.`);
        }
        checkCount++;
        await new Promise(r => setTimeout(r, pollDelayMs));
        addLog('working', `Checking deploy status (attempt ${checkCount})...`);
        const statusRes = await api.apiSoap<any>('Metadata', 'checkDeployStatus', {
          id: jobId,
          includeDetails: true,
        });

        if (statusRes.done === 'true' || statusRes.done === true) {
          done = true;
          const details = statusRes.details;
          if (statusRes.success === 'true' || statusRes.success === true) {
            addLog('success', 'Deployment completed successfully!');
          } else {
            addLog('error', 'Deployment failed.');
            if (details && details.componentFailures) {
              const failures = asArray(details.componentFailures);
              failures.forEach(f => {
                addLog('error', `${f.componentType || 'Component'} "${f.fullName}": ${f.problem || 'Unknown failure'}`);
              });
            }
            if (details && details.runTestResult && details.runTestResult.failures) {
              const testFailures = asArray(details.runTestResult.failures);
              testFailures.forEach(f => {
                addLog('error', `Test failure in class ${f.name}.${f.methodName}: ${f.message}`);
              });
            }
          }
        }
      }
    } catch (err: any) {
      addLog('error', `Deploy failed: ${err.message}`);
    } finally {
      isWorking = false;
      updateSpinner();
    }
  }

  let treeContainer: HTMLDivElement | null = null;
  function renderTree(): void {
    if (!treeContainer) return;
    treeContainer.replaceChildren();

    const list = doc.createElement('ul');
    list.style.cssText = 'list-style: none; padding-left: 0; margin: 0;';

    const filtered = metadataObjects.filter(obj => {
      const matchParent = obj.xmlName.toLowerCase().includes(metadataFilter);
      if (matchParent) return true;
      return obj.childXmlNames && obj.childXmlNames.some(c => c.fullName.toLowerCase().includes(metadataFilter));
    });

    if (filtered.length === 0) {
      const empty = doc.createElement('li');
      empty.textContent = 'No matching metadata types';
      empty.style.cssText = 'color: var(--sfdt-color-text-icon); font-size: 12px; padding: 4px;';
      list.appendChild(empty);
      treeContainer.appendChild(list);
      return;
    }

    filtered.forEach(obj => {
      const li = doc.createElement('li');
      li.style.cssText = 'margin-bottom: 4px; border-bottom: 1px solid var(--sfdt-color-bg); padding-bottom: 4px;';

      const row = doc.createElement('div');
      row.style.cssText = 'display: flex; align-items: center; gap: 6px; cursor: pointer;';

      const expBtn = doc.createElement('button');
      expBtn.textContent = obj.expanded ? '▼' : '▶';
      expBtn.style.cssText = 'background: none; border: 0; padding: 0; font-size: 10px; cursor: pointer; width: 16px; color: var(--sfdt-color-text-weak);';
      expBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void toggleExpand(obj);
      });
      row.appendChild(expBtn);

      const chk = doc.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'sfdt-tree-chk';
      chk.checked = !!obj.selected;
      chk.addEventListener('change', (e) => {
        e.stopPropagation();
        selectMetaItem(obj, chk.checked);
      });
      row.appendChild(chk);

      const label = doc.createElement('span');
      label.textContent = obj.xmlName;
      label.style.cssText = 'font-size: 12px; font-weight: 500; color: var(--sfdt-color-text); flex: 1;';
      row.appendChild(label);

      row.addEventListener('click', () => {
        void toggleExpand(obj);
      });

      li.appendChild(row);

      if (obj.expanded && obj.childXmlNames && obj.childXmlNames.length > 0) {
        const childList = doc.createElement('ul');
        childList.style.cssText = 'list-style: none; padding-left: 20px; margin: 4px 0 0 0;';
        obj.childXmlNames
          .filter(c => c.fullName.toLowerCase().includes(metadataFilter))
          .forEach(child => {
            const childLi = doc.createElement('li');
            childLi.style.cssText = 'display: flex; align-items: center; gap: 6px; margin: 2px 0;';

            const childChk = doc.createElement('input');
            childChk.type = 'checkbox';
            childChk.checked = !!child.selected;
            childChk.addEventListener('change', () => {
              child.selected = childChk.checked;
              generatePackageXml();
              renderTree();
            });
            childLi.appendChild(childChk);

            const childLabel = doc.createElement('span');
            childLabel.textContent = child.fullName;
            childLabel.style.cssText = 'font-size: 11px; color: var(--sfdt-color-text-weak);';
            childLi.appendChild(childLabel);

            childList.appendChild(childLi);
          });
        li.appendChild(childList);
      }

      list.appendChild(li);
    });

    treeContainer.appendChild(list);
  }

  let spinnerEl: HTMLDivElement | null = null;
  function updateSpinner(): void {
    if (spinnerEl) {
      spinnerEl.style.display = isWorking ? 'block' : 'none';
    }
  }

  async function open(): Promise<void> {
    close();

    // Body wrapper presented into a Workspace tab (or a modal on a Salesforce page).
    const body = doc.createElement('div');
    body.style.cssText = 'flex: 1; display: flex; flex-direction: column; overflow: hidden;';

    // Spinner (shown while a SOAP job is in flight). Lived in the old modal
    // header next to the title; presentView owns the header now, so it is pinned
    // to the top of the body instead.
    const spinnerRow = doc.createElement('div');
    spinnerRow.style.cssText = 'padding: 6px 16px 0; display: flex; justify-content: flex-end;';
    spinnerEl = doc.createElement('div');
    spinnerEl.style.cssText = 'border: 2px solid var(--sfdt-color-bg); border-top: 2px solid var(--sfdt-color-brand); border-radius: 50%; width: 14px; height: 14px; animation: spin 1s linear infinite; display: none;';
    const style = doc.createElement('style');
    style.textContent = '@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }';
    doc.head.appendChild(style);
    spinnerRow.appendChild(spinnerEl);
    body.appendChild(spinnerRow);

    // Tab Header
    const tabsRow = doc.createElement('div');
    tabsRow.style.cssText = 'display: flex; border-bottom: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface-alt);';
    const rTab = doc.createElement('button');
    rTab.textContent = 'Retrieve';
    rTab.style.cssText = 'padding: 10px 20px; border: 0; background: var(--sfdt-color-surface); border-right: 1px solid var(--sfdt-color-border); border-bottom: 2px solid var(--sfdt-color-brand); font-weight: 600; cursor: pointer;';
    const dTab = doc.createElement('button');
    dTab.textContent = 'Deploy';
    dTab.style.cssText = 'padding: 10px 20px; border: 0; background: none; border-right: 1px solid var(--sfdt-color-border); font-weight: 600; cursor: pointer; color: var(--sfdt-color-text-weak);';

    tabsRow.appendChild(rTab);
    tabsRow.appendChild(dTab);
    body.appendChild(tabsRow);

    // Main Content wrapper
    const mainWrap = doc.createElement('div');
    mainWrap.style.cssText = 'flex: 1; overflow: hidden; display: flex; flex-direction: column;';
    body.appendChild(mainWrap);

    // Retrieve Panel
    const rPanel = doc.createElement('div');
    rPanel.style.cssText = 'flex: 1; display: flex; overflow: hidden; padding: 16px; gap: 16px;';
    mainWrap.appendChild(rPanel);

    // Left half (Tree & Filter)
    const treeDiv = doc.createElement('div');
    treeDiv.style.cssText = 'flex: 1; display: flex; flex-direction: column; gap: 10px; border-right: 1px solid var(--sfdt-color-border-2); padding-right: 16px; overflow: hidden;';
    rPanel.appendChild(treeDiv);

    const filterRow = doc.createElement('div');
    filterRow.style.cssText = 'display: flex; gap: 8px; align-items: center;';
    const search = doc.createElement('input');
    search.type = 'text';
    search.placeholder = 'Filter metadata type or member...';
    search.style.cssText = 'flex: 1; padding: 6px 8px; border: 1px solid var(--sfdt-color-border); border-radius: 4px; font-size: 13px;';
    search.addEventListener('input', () => {
      metadataFilter = search.value.toLowerCase();
      renderTree();
    });
    filterRow.appendChild(search);

    const managedLabel = doc.createElement('label');
    managedLabel.style.cssText = 'font-size: 11px; color: var(--sfdt-color-text-weak); display: flex; align-items: center; gap: 4px; cursor: pointer;';
    const managedChk = doc.createElement('input');
    managedChk.type = 'checkbox';
    managedChk.checked = includeManagedPackage;
    managedChk.addEventListener('change', () => {
      includeManagedPackage = managedChk.checked;
      void loadMetadataDescribe();
    });
    managedLabel.appendChild(managedChk);
    managedLabel.appendChild(doc.createTextNode('Managed'));
    filterRow.appendChild(managedLabel);

    treeDiv.appendChild(filterRow);

    treeContainer = doc.createElement('div');
    treeContainer.style.cssText = 'flex: 1; overflow-y: auto; border: 1px solid var(--sfdt-color-border); border-radius: 4px; padding: 8px;';
    treeDiv.appendChild(treeContainer);

    // Right half (XML Output)
    const xmlDiv = doc.createElement('div');
    xmlDiv.style.cssText = 'width: 400px; display: flex; flex-direction: column; gap: 10px; overflow: hidden;';
    rPanel.appendChild(xmlDiv);

    const xmlLabel = doc.createElement('span');
    xmlLabel.textContent = 'package.xml preview';
    xmlLabel.style.cssText = 'font-size: 12px; font-weight: 600; color: var(--sfdt-color-text);';
    xmlDiv.appendChild(xmlLabel);

    const xmlTextarea = doc.createElement('textarea');
    xmlTextarea.id = 'sfdt-meta-xml-textarea';
    xmlTextarea.readOnly = true;
    xmlTextarea.value = packageXml;
    xmlTextarea.style.cssText = 'flex: 1; padding: 8px; border: 1px solid var(--sfdt-color-border); border-radius: 4px; font-family: monospace; font-size: 11px; background: var(--sfdt-color-surface-alt); resize: none; outline: none;';
    xmlTextareaEl = xmlTextarea;
    xmlDiv.appendChild(xmlTextarea);

    const rActions = doc.createElement('div');
    rActions.style.cssText = 'display: flex; gap: 8px;';
    const copyXmlBtn = doc.createElement('button');
    copyXmlBtn.textContent = 'Copy XML';
    copyXmlBtn.style.cssText = 'padding: 6px 12px; border: 1px solid var(--sfdt-color-border); border-radius: 4px; background: var(--sfdt-color-surface); cursor: pointer; font-size: 12px;';
    copyXmlBtn.addEventListener('click', () => {
      void win.navigator.clipboard.writeText(packageXml);
      showToast('package.xml copied to clipboard', { doc, kind: 'success' });
    });
    const downloadXmlBtn = doc.createElement('button');
    downloadXmlBtn.textContent = 'Download XML';
    downloadXmlBtn.style.cssText = 'padding: 6px 12px; border: 1px solid var(--sfdt-color-border); border-radius: 4px; background: var(--sfdt-color-surface); cursor: pointer; font-size: 12px;';
    downloadXmlBtn.addEventListener('click', () => {
      const blob = new Blob([packageXml], { type: 'text/xml' });
      const a = doc.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'package.xml';
      doc.body.appendChild(a);
      a.click();
      a.remove();
    });

    const fileUploadXml = doc.createElement('input');
    fileUploadXml.type = 'file';
    fileUploadXml.accept = '.xml';
    fileUploadXml.style.display = 'none';
    fileUploadXml.addEventListener('change', () => {
      if (fileUploadXml.files?.length) {
        const file = fileUploadXml.files[0]!;
        const reader = new FileReader();
        reader.onload = (e) => {
          if (e.target?.result) {
            loadFromPackageXml(e.target.result as string);
          }
        };
        reader.readAsText(file);
      }
    });

    const importXmlBtn = doc.createElement('button');
    importXmlBtn.textContent = 'Import XML';
    importXmlBtn.style.cssText = 'padding: 6px 12px; border: 1px solid var(--sfdt-color-border); border-radius: 4px; background: var(--sfdt-color-surface); cursor: pointer; font-size: 12px;';
    importXmlBtn.addEventListener('click', () => {
      fileUploadXml.click();
    });

    const retrieveBtn = doc.createElement('button');
    retrieveBtn.textContent = 'Retrieve Zip';
    retrieveBtn.style.cssText = 'padding: 6px 16px; background: var(--sfdt-color-brand); color: var(--sfdt-color-on-accent); border: 0; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600; margin-left: auto;';
    retrieveBtn.addEventListener('click', () => {
      void runRetrieve();
    });

    rActions.appendChild(copyXmlBtn);
    rActions.appendChild(downloadXmlBtn);
    rActions.appendChild(importXmlBtn);
    rActions.appendChild(retrieveBtn);
    xmlDiv.appendChild(rActions);

    // Deploy Panel (initially hidden)
    const dPanel = doc.createElement('div');
    dPanel.style.cssText = 'flex: 1; display: none; flex-direction: column; padding: 16px; gap: 16px; overflow-y: auto;';
    mainWrap.appendChild(dPanel);

    const deployForm = doc.createElement('div');
    deployForm.style.cssText = 'display: flex; flex-direction: column; gap: 12px; max-width: 500px;';
    dPanel.appendChild(deployForm);

    const fileRow = doc.createElement('div');
    fileRow.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';
    const fileLabel = doc.createElement('label');
    fileLabel.textContent = 'Select Metadata ZIP File';
    fileLabel.style.cssText = 'font-size: 12px; font-weight: 600; color: var(--sfdt-color-text);';
    const fileInput = doc.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.zip';
    fileInput.style.cssText = 'font-size: 13px;';
    fileRow.appendChild(fileLabel);
    fileRow.appendChild(fileInput);
    deployForm.appendChild(fileRow);

    // Deploy Options Grid
    const optsGrid = doc.createElement('div');
    optsGrid.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 8px;';
    deployForm.appendChild(optsGrid);

    const optsList = [
      { key: 'checkOnly', label: 'Check Only (Validation)' },
      { key: 'rollbackOnError', label: 'Rollback on Error' },
      { key: 'singlePackage', label: 'Single Package' },
      { key: 'ignoreWarnings', label: 'Ignore Warnings' },
      { key: 'purgeOnDelete', label: 'Purge on Delete' },
      { key: 'allowMissingFiles', label: 'Allow Missing Files' },
    ] as const;

    optsList.forEach(opt => {
      const label = doc.createElement('label');
      label.style.cssText = 'display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; color: var(--sfdt-color-text);';
      const chk = doc.createElement('input');
      chk.type = 'checkbox';
      chk.checked = !!(deployOptions as any)[opt.key];
      chk.addEventListener('change', () => {
        (deployOptions as any)[opt.key] = chk.checked;
      });
      label.appendChild(chk);
      label.appendChild(doc.createTextNode(opt.label));
      optsGrid.appendChild(label);
    });

    const testLevelRow = doc.createElement('div');
    testLevelRow.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';
    const testLevelLabel = doc.createElement('label');
    testLevelLabel.textContent = 'Test Level';
    testLevelLabel.style.cssText = 'font-size: 11px; font-weight: 600; color: var(--sfdt-color-text-weak);';
    const testLevelSelect = doc.createElement('select');
    testLevelSelect.style.cssText = 'padding: 6px; border: 1px solid var(--sfdt-color-border); border-radius: 4px; font-size: 13px; outline: none;';
    ['NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg'].forEach(v => {
      const opt = doc.createElement('option');
      opt.value = v;
      opt.textContent = v;
      if (v === deployOptions.testLevel) opt.selected = true;
      testLevelSelect.appendChild(opt);
    });
    testLevelRow.appendChild(testLevelLabel);
    testLevelRow.appendChild(testLevelSelect);
    deployForm.appendChild(testLevelRow);

    const runTestsRow = doc.createElement('div');
    runTestsRow.style.cssText = 'display: none; flex-direction: column; gap: 4px;';
    const runTestsLabel = doc.createElement('label');
    runTestsLabel.textContent = 'Specified Tests (comma-separated class names)';
    runTestsLabel.style.cssText = 'font-size: 11px; font-weight: 600; color: var(--sfdt-color-text-weak);';
    const runTestsInput = doc.createElement('input');
    runTestsInput.type = 'text';
    runTestsInput.placeholder = 'MyTestClass1, MyTestClass2';
    runTestsInput.style.cssText = 'padding: 6px; border: 1px solid var(--sfdt-color-border); border-radius: 4px; font-size: 13px; outline: none;';
    runTestsInput.addEventListener('input', () => {
      deployOptions.runTests = runTestsInput.value;
    });
    runTestsRow.appendChild(runTestsLabel);
    runTestsRow.appendChild(runTestsInput);
    deployForm.appendChild(runTestsRow);

    testLevelSelect.addEventListener('change', () => {
      deployOptions.testLevel = testLevelSelect.value;
      runTestsRow.style.display = testLevelSelect.value === 'RunSpecifiedTests' ? 'flex' : 'none';
    });

    const deployBtn = doc.createElement('button');
    deployBtn.textContent = 'Deploy ZIP';
    deployBtn.style.cssText = 'padding: 8px 16px; background: var(--sfdt-color-success); color: var(--sfdt-color-on-accent); border: 0; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 600; align-self: flex-start;';
    deployBtn.addEventListener('click', () => {
      if (!fileInput.files?.length) {
        showToast('Please select a metadata ZIP file first.', { doc, kind: 'warning' });
        return;
      }
      const file = fileInput.files[0]!;
      const reader = new FileReader();
      reader.onload = (e) => {
        if (e.target?.result) {
          const bytes = new Uint8Array(e.target.result as ArrayBuffer);
          void runDeploy(bytes);
        }
      };
      reader.readAsArrayBuffer(file);
    });
    deployForm.appendChild(deployBtn);

    // Logs Container (Shared bottom panel)
    const logsWrap = doc.createElement('div');
    logsWrap.style.cssText = 'border-top: 1px solid var(--sfdt-color-border); height: 140px; padding: 12px 16px; display: flex; flex-direction: column; gap: 6px; background: var(--sfdt-color-surface-alt);';
    body.appendChild(logsWrap);

    const logsLabel = doc.createElement('div');
    logsLabel.style.cssText = 'font-size: 11px; font-weight: 600; color: var(--sfdt-color-text-weak); display: flex; justify-content: space-between;';
    logsLabel.textContent = 'Execution Log';
    const clearLogsBtn = doc.createElement('button');
    clearLogsBtn.textContent = 'Clear Logs';
    clearLogsBtn.style.cssText = 'background: none; border: 0; color: var(--sfdt-color-brand-text); font-size: 11px; cursor: pointer; padding: 0;';
    clearLogsBtn.addEventListener('click', clearLogs);
    logsLabel.appendChild(clearLogsBtn);
    logsWrap.appendChild(logsLabel);

    logsContainer = doc.createElement('div');
    logsContainer.style.cssText = 'flex: 1; overflow-y: auto; background: var(--sfdt-color-surface); border: 1px solid var(--sfdt-color-border); border-radius: 4px; padding: 6px;';
    logsWrap.appendChild(logsContainer);

    // Tab Event listeners
    rTab.addEventListener('click', () => {
      rTab.style.background = 'var(--sfdt-color-surface)';
      rTab.style.borderBottom = '2px solid var(--sfdt-color-brand)';
      rTab.style.color = 'var(--sfdt-color-text)';
      dTab.style.background = 'none';
      dTab.style.borderBottom = '0';
      dTab.style.color = 'var(--sfdt-color-text-weak)';
      rPanel.style.display = 'flex';
      dPanel.style.display = 'none';
    });

    dTab.addEventListener('click', () => {
      dTab.style.background = 'var(--sfdt-color-surface)';
      dTab.style.borderBottom = '2px solid var(--sfdt-color-brand)';
      dTab.style.color = 'var(--sfdt-color-text)';
      rTab.style.background = 'none';
      rTab.style.borderBottom = '0';
      rTab.style.color = 'var(--sfdt-color-text-weak)';
      dPanel.style.display = 'flex';
      rPanel.style.display = 'none';
    });

    view = presentView({
      title: '📦 Metadata Retrieve & Deploy',
      body,
      doc,
      width: '960px',
      onClose: () => { isWorking = false; view = null; },
    });

    await loadMetadataDescribe();
  }

  return {
    manifest: {
      id: 'metadata-retrieve',
      name: 'Metadata Retrieve & Deploy',
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

export function _metadataRetrieveTestApi() {
  return {
    asArray,
  };
}
