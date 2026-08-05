// Metadata Retrieve & Deploy — the extension's manifest builder (P5-4/P5-5).
//
// Two data paths, one UI (docs/design/visual-manifest-builder.md §PR-4):
//   bridge-connected — type/member discovery via the read-only bridge kind
//     `manifest.discover`, and manifest XML via `manifest.render`, so every
//     byte of XML comes from the CLI's single writer (renderPackageXml in
//     src/lib/metadata-mapper.js). The extension NEVER assembles XML itself
//     on this path.
//   offline — the original worker-proxied SOAP path (describeMetadata /
//     listMetadata + the private writer below), kept unchanged as the
//     fallback when no bridge answers.
// Retrieve/deploy always run over SOAP — the bridge has no retrieve kind.

import type {
  ManifestDiscoverResponseData,
  ManifestRenderResponseData,
  SfdtRequest,
  SfdtResponse,
} from '@sfdt/flow-core/bridge-contract';
import { asArray } from '../lib/collections.js';
import { CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import {
  getSalesforceApi,
  type SalesforceApiClient,
} from '../lib/salesforce-api.js';
import { loadSettings } from '../lib/settings.js';
import {
  createBridgeClient,
  getBridgeData,
  LONG_RUNNING_TIMEOUT_MS,
} from '../lib/sfdt-bridge.js';
import { showToast } from '../ui/toast.js';
import { recordActivity } from '../lib/activity-log.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { glyph, setTone, toolbar } from '../lib/ui-controls.js';
import { SF_API_VERSION } from '../lib/api-version.js';
import { copyToClipboard } from '../ui/clipboard.js';
import { triggerDownload, triggerDownloadBlob } from '../lib/download.js';

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
  // True only once this type's real member list has been fetched from the org
  // (bridge or SOAP). Children seeded from a persisted selection or an
  // imported package.xml leave it false, so expanding still fetches — a
  // length check alone would truncate the tree to the seeded members forever.
  membersLoaded?: boolean;
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
  membersLoaded?: boolean;
}

type BridgeReq = Omit<SfdtRequest, 'requestId'>;

/** Minimal bridge surface this feature needs (mirrors bridge-tools). */
export interface ManifestBridge {
  call(request: BridgeReq, options?: { timeoutMs?: number }): Promise<SfdtResponse>;
}

type ManifestMode = 'additive' | 'destructive';

interface DestructivePair {
  destructiveChangesXml: string;
  emptyPackageXml: string;
}

// Where the destructive-changes pairing + deploy timing (SFDT_DESTRUCTIVE_TIMING)
// are documented — the same target the GUI builder links to.
const DESTRUCTIVE_DOCS_URL = 'https://sfdt.dev/cli/dashboard#manifest-builder';

// Selections persist per org host so a half-built manifest survives closing
// the tool (P5-4 AC-3). One key per Salesforce host in chrome.storage.local.
const SELECTION_STORE_PREFIX = 'sfdt-manifest-selections:';

function defaultBridgeFactory(): () => Promise<ManifestBridge> {
  return async () => {
    const settings = await loadSettings();
    return createBridgeClient({
      token: settings.bridge.token,
      preferredTransport: settings.bridge.preferredTransport,
      localhostPort: settings.bridge.localhostPort,
      connectNativeImpl: chrome.runtime?.connectNative?.bind(chrome.runtime),
    });
  };
}

function storageAvailable(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage?.local;
}

function storageGet(key: string): Promise<unknown> {
  if (!storageAvailable()) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(key, (items: Record<string, unknown>) => {
        resolve(items ? items[key] : undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

function storageSet(key: string, value: unknown): Promise<void> {
  if (!storageAvailable()) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [key]: value }, () => resolve());
    } catch {
      resolve();
    }
  });
}

function storageRemove(key: string): Promise<void> {
  if (!storageAvailable()) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      chrome.storage.local.remove(key, () => resolve());
    } catch {
      resolve();
    }
  });
}

export function createMetadataRetrieveFeature(options: {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
  bridgeFactory?: () => Promise<ManifestBridge>;
} = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();
  const bridgeFactory = options.bridgeFactory ?? defaultBridgeFactory();

  let view: ViewHandle | null = null;
  let metadataObjects: MetadataObject[] = [];
  let packageXml = '';
  let metadataFilter = '';
  let includeManagedPackage = false;
  const sortMetadataBy: 'fullName' | 'fileName' = 'fullName';

  // Bridge-path state. `bridge` is non-null only after a successful
  // manifest.discover probe — everything else falls back to SOAP.
  let bridge: ManifestBridge | null = null;
  let bridgeOrg = '';
  let manifestMode: ManifestMode = 'additive';
  let destructivePair: DestructivePair | null = null;
  // Monotonic guard so a slow manifest.render response can never overwrite
  // the preview of a newer selection.
  let renderSeq = 0;

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
    bridge = null;
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
      // Glyph + tone, not an emoji prefix. The glyph is aria-hidden and the
      // tone is colour, so the LEVEL is also spelled out in the text — colour
      // is never the only signal (CONVENTIONS.md).
      const item = doc.createElement('div');
      item.className = 'sfdt-row sfdt-mono';
      const level =
        msg.level === 'error'
          ? { tone: 'bad' as const, icon: 'alert', word: 'Error' }
          : msg.level === 'success'
            ? { tone: 'ok' as const, icon: 'check', word: 'Done' }
            : msg.level === 'working'
              ? { tone: 'info' as const, icon: 'clock', word: 'Working' }
              : { tone: 'muted' as const, icon: 'panel', word: 'Info' };
      setTone(item, level.tone);
      item.appendChild(glyph(level.icon, 12, doc));
      const text = doc.createElement('span');
      text.textContent = `${level.word}: ${msg.text}`;
      item.appendChild(text);
      logsContainer.appendChild(item);
    }
    logsContainer.scrollTop = logsContainer.scrollHeight;
  }

  function cleanApiVersion(): string {
    return api.apiVersion.replace(/^v/, '');
  }

  // -------------------------------------------------------------------------
  // Selection model (shared by both data paths)
  // -------------------------------------------------------------------------

  /** Flatten the tree selection into the [{type, member}] shape the bridge
   *  render kind takes (P5-4 AC-2). A ticked type means "entire type" and
   *  stays the `*` wildcard even after the node is expanded (the wildcard is
   *  sticky, matching the GUI builder — expanding never narrows a selection);
   *  explicit members are sent only when individual children are ticked
   *  without the whole-type tick. */
  function collectSelectedItems(): Array<{ type: string; member: string }> {
    const items: Array<{ type: string; member: string }> = [];
    for (const meta of metadataObjects) {
      if (meta.selected) {
        items.push({ type: meta.xmlName, member: '*' });
        continue;
      }
      const children: FileProperty[] = meta.childXmlNames ?? [];
      for (const c of children) {
        if (c.selected) items.push({ type: meta.xmlName, member: c.fullName });
      }
    }
    return items;
  }

  function selectionStoreKey(): string {
    return SELECTION_STORE_PREFIX + win.location.hostname;
  }

  /** Persistence must never break the builder — best-effort, errors swallowed
   *  inside the storage helpers. */
  async function persistSelections(): Promise<void> {
    const items = collectSelectedItems();
    if (items.length === 0) await storageRemove(selectionStoreKey());
    else await storageSet(selectionStoreKey(), { items });
  }

  /** Re-apply the stored per-org selection onto the freshly loaded type list.
   *  Member selections seed children directly (the same convention as
   *  importing a package.xml), so they are visible without an org round-trip.
   *  Seeded nodes deliberately leave `membersLoaded` false — expanding one
   *  still fetches the type's real member list and merges these ticks into
   *  it, so a restored selection never truncates the tree. */
  async function restoreSelections(): Promise<void> {
    const stored = (await storageGet(selectionStoreKey())) as
      | { items?: Array<{ type?: unknown; member?: unknown }> }
      | undefined;
    const items = stored?.items;
    if (!Array.isArray(items) || items.length === 0) return;
    let restored = 0;
    for (const entry of items) {
      const type = entry?.type;
      const member = entry?.member;
      if (typeof type !== 'string' || typeof member !== 'string' || !member) continue;
      const match = metadataObjects.find((o) => o.xmlName === type);
      if (!match) continue;
      if (member === '*') {
        match.selected = true;
        restored++;
        continue;
      }
      // Deliberately left COLLAPSED. An expanded seeded node would present a
      // one-member list as if it were the type's complete membership, and the
      // only way to load the rest would be an undiscoverable
      // collapse-then-expand. Collapsed, the first expand does the real fetch
      // and merges these ticks; the tree still shows the selection exists via
      // the partial-tick (indeterminate) state on the type row.
      match.expanded = false;
      const existing = (match.childXmlNames ?? []).find(
        (c: FileProperty) => c.fullName === member,
      );
      if (existing) {
        existing.selected = true;
      } else {
        match.childXmlNames.push({
          fullName: member,
          fileName: member,
          type,
          id: '',
          selected: true,
          expanded: false,
          childXmlNames: [],
        });
      }
      restored++;
    }
    if (restored > 0) {
      addLog('info', `Restored ${restored} saved selection(s) for ${win.location.hostname}.`);
    }
  }

  function clearAllSelections(): void {
    for (const meta of metadataObjects) {
      meta.selected = false;
      for (const child of meta.childXmlNames ?? []) child.selected = false;
    }
    void storageRemove(selectionStoreKey());
    void updatePreview();
    renderTree();
    addLog('info', 'Cleared all selections.');
  }

  /** Every selection change funnels through here: persist + re-render preview. */
  function onSelectionChanged(): void {
    void persistSelections();
    void updatePreview();
  }

  // -------------------------------------------------------------------------
  // Data source bootstrap: bridge first, SOAP fallback
  // -------------------------------------------------------------------------

  async function initDataSource(): Promise<void> {
    isWorking = true;
    updateSpinner();
    addLog('working', 'Checking for a connected sfdt bridge...');
    try {
      const client = await bridgeFactory();
      const res = await client.call(
        { kind: 'manifest.discover' } as BridgeReq,
        { timeoutMs: LONG_RUNNING_TIMEOUT_MS },
      );
      if (res.ok) {
        const data = getBridgeData<ManifestDiscoverResponseData>(res);
        if (Array.isArray(data.types)) {
          bridge = client;
          bridgeOrg = typeof data.org === 'string' ? data.org : '';
          metadataObjects = data.types
            .filter((t): t is string => typeof t === 'string' && t.length > 0)
            .map((xmlName) => ({
              xmlName,
              childXmlNames: [],
              isFolder: false,
              selected: false,
              expanded: false,
              inFolder: false,
            }));
          metadataObjects.sort((a, b) => a.xmlName.localeCompare(b.xmlName));
          addLog(
            'success',
            `sfdt bridge connected — ${metadataObjects.length} metadata types from org ${bridgeOrg || '(default)'}; XML renders through the sfdt CLI.`,
          );
        } else {
          addLog('error', 'Bridge manifest.discover returned no type list — falling back to the Salesforce API.');
        }
      } else {
        addLog('info', `sfdt bridge unavailable (${res.error}) — using the Salesforce SOAP API directly.`);
      }
    } catch (err: any) {
      addLog('info', `sfdt bridge probe failed (${err.message}) — using the Salesforce SOAP API directly.`);
    } finally {
      isWorking = false;
      updateSpinner();
    }
    updateBridgeDom();
    if (!bridge) {
      await loadMetadataDescribe();
    }
    await restoreSelections();
    await updatePreview();
    renderTree();
  }

  async function loadMetadataDescribe(): Promise<void> {
    isWorking = true;
    updateSpinner();
    addLog('working', 'Loading metadata describe details...');
    try {
      const cleanVersion = cleanApiVersion();
      // Pure read: describes the org's metadata types, changes nothing.
      const res = await api.apiSoap<any>('Metadata', 'describeMetadata', { apiVersion: cleanVersion }, { mutating: false });
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
        void updatePreview();
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

  /** Stable signature of the effective manifest selection, used to tell a
   *  genuine selection change from a pure browse action (expand/collapse). */
  function selectionSignature(): string {
    return collectSelectedItems()
      .map(({ type, member }) => `${type}:${member}`)
      .join('|');
  }

  /** Members the user had ticked before a member-list fetch replaces the
   *  node's children — their ticks must survive the merge (that is the whole
   *  point of persistence). */
  function selectedMemberNames(meta: any): Set<string> {
    const names = new Set<string>();
    for (const child of (meta.childXmlNames ?? []) as FileProperty[]) {
      if (child.selected && child.fullName) names.add(child.fullName);
    }
    return names;
  }

  /** Re-attach ticks the fetch would otherwise have dropped, and keep any
   *  previously-selected member the org no longer lists rather than silently
   *  discarding the user's selection. */
  function mergeRestoredSelection(anyMeta: any, previouslySelected: Set<string>): void {
    if (previouslySelected.size === 0) return;
    const fetched = new Set<string>();
    for (const child of anyMeta.childXmlNames as FileProperty[]) {
      fetched.add(child.fullName);
      if (previouslySelected.has(child.fullName)) child.selected = true;
    }
    const missing = [...previouslySelected].filter((name) => !fetched.has(name));
    for (const name of missing) {
      anyMeta.childXmlNames.push({
        fullName: name,
        fileName: name,
        type: anyMeta.xmlName,
        id: '',
        selected: true,
        expanded: false,
        childXmlNames: [],
      });
    }
    if (missing.length > 0) {
      addLog(
        'info',
        `${missing.length} selected ${anyMeta.xmlName} member(s) were not returned by the org and are kept as-is: ${missing.join(', ')}.`,
      );
    }
  }

  async function toggleExpand(meta: MetadataObject | FileProperty): Promise<void> {
    const anyMeta = meta as any;
    const signatureBefore = selectionSignature();
    anyMeta.expanded = !anyMeta.expanded;
    // Fetch on completeness, not on emptiness: a node whose children were
    // seeded from storage (or an imported package.xml) has entries but has
    // never been loaded, and must still fetch its real member list.
    if (anyMeta.expanded && !anyMeta.membersLoaded) {
      const previouslySelected = selectedMemberNames(anyMeta);
      isWorking = true;
      updateSpinner();
      addLog('working', `Fetching components for ${anyMeta.xmlName ?? anyMeta.fullName}...`);
      try {
        if (bridge) {
          // Bridge path: one manifest.discover round-trip per type. A failure
          // surfaces as an error and the node collapses again — never a
          // fabricated empty member list.
          const res = await bridge.call(
            { kind: 'manifest.discover', type: anyMeta.xmlName } as BridgeReq,
            { timeoutMs: LONG_RUNNING_TIMEOUT_MS },
          );
          if (!res.ok) {
            anyMeta.expanded = false;
            throw new Error(res.error);
          }
          const data = getBridgeData<ManifestDiscoverResponseData>(res);
          // An ok:true response without a `members` array is a contract
          // violation, NOT an empty type. Coercing it to [] and marking the
          // node loaded would make a fabricated empty tree permanent — the
          // exact failure mode the "never a fabricated empty tree" invariant
          // exists to prevent. Treat it as a failure: the node collapses,
          // stays re-fetchable, and its seeded children/ticks are untouched.
          if (!Array.isArray(data.members)) {
            anyMeta.expanded = false;
            throw new Error(
              `Bridge returned no member list for ${anyMeta.xmlName} — the response is missing its "members" array.`,
            );
          }
          const members = data.members;
          anyMeta.childXmlNames = members
            .filter((m): m is string => typeof m === 'string' && m.length > 0)
            .map((fullName) => ({
              fullName,
              fileName: fullName,
              type: anyMeta.xmlName,
              id: '',
              selected: !!anyMeta.selected,
              expanded: false,
              childXmlNames: [],
            }));
          anyMeta.membersLoaded = true;
          mergeRestoredSelection(anyMeta, previouslySelected);
          addLog('success', `Loaded ${anyMeta.childXmlNames.length} members for ${anyMeta.xmlName} from the sfdt bridge.`);
        } else {
          const cleanVersion = cleanApiVersion();
          const folderProof = getMetaFolderProof(anyMeta);
          // Pure read: enumerates existing components, changes nothing.
          const res = await api.apiSoap<any>('Metadata', 'listMetadata', {
            queries: {
              type: folderProof.xmlName,
              folder: folderProof.directoryName !== '*' ? folderProof.directoryName : undefined,
            },
            asOfVersion: cleanVersion,
          }, { mutating: false });

          // No bridge-style hole on this path: `apiSoap` throws on every
          // transport error and SOAP fault, so reaching here with a falsy
          // `res` genuinely means the type has zero members — marking it
          // loaded is correct rather than a fabricated empty tree.
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
          anyMeta.membersLoaded = true;
          mergeRestoredSelection(anyMeta, previouslySelected);
          addLog('success', `Loaded ${anyMeta.childXmlNames.length} members for ${anyMeta.xmlName ?? anyMeta.fullName}.`);
        }
      } catch (err: any) {
        // membersLoaded stays false so a retry re-fetches rather than showing
        // a partial tree; the seeded children (and their ticks) are untouched.
        addLog('error', `Failed to load members: ${err.message}`);
      } finally {
        isWorking = false;
        updateSpinner();
      }
    }
    // Expand/collapse is browsing, not selecting — only persist + re-render
    // when the effective selection actually moved (a seeded-member merge can
    // move it, a plain expand cannot). Keeps the live-preview-on-every-
    // selection-change contract without a bridge round-trip per click.
    if (selectionSignature() !== signatureBefore) onSelectionChanged();
    renderTree();
  }

  function selectMetaItem(meta: MetadataObject | FileProperty, selected: boolean): void {
    cascadeSelect(meta, selected);
    onSelectionChanged();
    renderTree();
  }

  // Cascade without the per-node preview/persist side effects.
  function cascadeSelect(meta: MetadataObject | FileProperty, selected: boolean): void {
    meta.selected = selected;
    if (meta.childXmlNames) {
      meta.childXmlNames.forEach((c: any) => cascadeSelect(c, selected));
    }
  }

  // -------------------------------------------------------------------------
  // Manifest preview — single writer over the bridge, private writer offline
  // -------------------------------------------------------------------------

  /** The extension's private writer — OFFLINE FALLBACK ONLY. On the bridge
   *  path all XML comes from the CLI via manifest.render. */
  function buildOfflinePackageXml(grouped: Record<string, Set<string>>): string {
    const cleanVersion = cleanApiVersion();
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
    return xml;
  }

  function groupSelectedItems(): Record<string, Set<string>> {
    const grouped: Record<string, Set<string>> = {};
    for (const { type, member } of collectSelectedItems()) {
      if (!grouped[type]) grouped[type] = new Set();
      grouped[type]!.add(member);
    }
    return grouped;
  }

  async function updatePreview(): Promise<void> {
    const items = collectSelectedItems();

    if (bridge) {
      if (items.length === 0) {
        renderSeq++;
        packageXml = '';
        destructivePair = null;
        syncPreviewDom();
        return;
      }
      const seq = ++renderSeq;
      const res = await bridge.call({
        kind: 'manifest.render',
        items,
        mode: manifestMode,
        apiVersion: cleanApiVersion(),
      } as BridgeReq);
      if (seq !== renderSeq) return; // a newer selection superseded this render
      if (!res.ok) {
        addLog('error', `Manifest render failed: ${res.error}`);
        return;
      }
      const data = getBridgeData<ManifestRenderResponseData>(res);
      if (data.mode === 'destructive') {
        const pair = data as Partial<Extract<ManifestRenderResponseData, { mode: 'destructive' }>>;
        destructivePair = {
          destructiveChangesXml: pair.destructiveChangesXml ?? '',
          emptyPackageXml: pair.emptyPackageXml ?? '',
        };
        packageXml = destructivePair.destructiveChangesXml;
      } else {
        destructivePair = null;
        packageXml = (data as { xml?: string }).xml ?? '';
      }
      syncPreviewDom();
      return;
    }

    // Offline path — the kept SOAP-era writer.
    const grouped = groupSelectedItems();
    if (manifestMode === 'destructive') {
      destructivePair = items.length === 0
        ? null
        : {
            destructiveChangesXml: buildOfflinePackageXml(grouped),
            emptyPackageXml: buildOfflinePackageXml({}),
          };
      packageXml = destructivePair?.destructiveChangesXml ?? '';
    } else {
      destructivePair = null;
      packageXml = buildOfflinePackageXml(grouped);
    }
    syncPreviewDom();
  }

  function syncPreviewDom(): void {
    if (xmlTextareaEl) xmlTextareaEl.value = packageXml;
    if (pairTextareaEl) pairTextareaEl.value = destructivePair?.emptyPackageXml ?? '';
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

      // Reset tree selections first. Clearing children also clears the
      // loaded flag, so an imported type re-fetches its real member list on
      // the next expand instead of showing only the imported members.
      metadataObjects.forEach(o => {
        o.selected = false;
        o.expanded = false;
        o.childXmlNames = [];
        o.membersLoaded = false;
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

      // Re-render through the active writer (the bridge when connected) so
      // the preview always reflects what would actually be produced.
      onSelectionChanged();
      renderTree();
      addLog('success', 'package.xml imported successfully and tree updated.');
    } catch (err: any) {
      addLog('error', `Import package.xml failed: ${err.message}`);
    }
  }

  async function runRetrieve(): Promise<void> {
    if (isWorking) return;
    if (manifestMode === 'destructive') {
      showToast('Retrieve works from package.xml — switch to Additive mode first.', { doc, kind: 'warning' });
      return;
    }
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

      const cleanVersion = cleanApiVersion();
      const retrieveRequest = {
        apiVersion: cleanVersion,
        unpackaged: {
          types: typeList,
          version: cleanVersion,
        },
      };

      // Starts a read-only export job — it reads metadata out of the org and
      // writes nothing into it, so a timeout here cannot have changed anything.
      const result = await api.apiSoap<any>('Metadata', 'retrieve', { retrieveRequest }, { mutating: false });
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
        // Status poll in a loop: a read. Must not carry the write framing.
        const statusRes = await api.apiSoap<any>('Metadata', 'checkRetrieveStatus', { id: jobId }, { mutating: false });
        if (statusRes.done === 'true' || statusRes.done === true) {
          done = true;
          if (statusRes.success === 'true' || statusRes.success === true) {
            addLog('success', 'Retrieve job completed successfully.');
            void recordActivity({
              featureId: 'metadata-retrieve',
              action: 'Retrieve',
              resource: `job ${jobId}`,
              status: 'success',
            });
            // Download zipFile
            if (statusRes.zipFile) {
              const binaryString = atob(statusRes.zipFile);
              const bytes = new Uint8Array(binaryString.length);
              for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
              }
              // Was a hand-rolled blob/anchor with NO revokeObjectURL — and a
              // retrieved metadata zip is routinely tens of megabytes, pinned for
              // the life of the tab. lib/download.ts revokes.
              triggerDownloadBlob(doc, `metadata_retrieve_${jobId}.zip`, bytes, 'application/zip');
              addLog('success', 'Metadata zip downloaded successfully.');
            } else {
              addLog('error', 'Completed retrieve status contains no zipFile payload.');
            }
          } else {
            addLog('error', `Retrieve job failed. Status: ${statusRes.status || 'Unknown'}`);
            void recordActivity({
              featureId: 'metadata-retrieve',
              action: 'Retrieve',
              resource: `job ${jobId}`,
              status: 'failed',
            });
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

      // The genuine write on this feature: a timeout here really may have
      // started a deploy that lands.
      const result = await api.apiSoap<any>('Metadata', 'deploy', {
        zipFile: zipBase64,
        deployOptions: reqOpts,
      }, { mutating: true });

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
        // Status poll in a loop, with no try/catch around it: a read. Declaring
        // this mutating told the user their change "may already have been saved"
        // once per poll of a slow deploy, for a call that wrote nothing.
        const statusRes = await api.apiSoap<any>('Metadata', 'checkDeployStatus', {
          id: jobId,
          includeDetails: true,
        }, { mutating: false });

        if (statusRes.done === 'true' || statusRes.done === true) {
          done = true;
          const details = statusRes.details;
          if (statusRes.success === 'true' || statusRes.success === true) {
            addLog('success', 'Deployment completed successfully!');
            void recordActivity({
              featureId: 'metadata-retrieve',
              action: 'Deploy',
              resource: `job ${jobId}`,
              status: 'success',
            });
          } else {
            addLog('error', 'Deployment failed.');
            void recordActivity({
              featureId: 'metadata-retrieve',
              action: 'Deploy',
              resource: `job ${jobId}`,
              status: 'failed',
            });
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
      empty.classList.add('sfdt-prose', 'sfdt-muted');
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
      expBtn.setAttribute('aria-label', `${obj.expanded ? 'Collapse' : 'Expand'} ${obj.xmlName}`);
      expBtn.setAttribute('aria-expanded', obj.expanded ? 'true' : 'false');
      expBtn.className = 'sfdt-btn sfdt-ghost sfdt-sm sfdt-icon';
      expBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void toggleExpand(obj);
      });
      row.appendChild(expBtn);

      const chk = doc.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'sfdt-tree-chk';
      chk.checked = !!obj.selected;
      // Partial tick when individual members are selected without the
      // whole-type tick. This is what makes a restored member-level selection
      // visible on a collapsed node — the selection is never hidden just
      // because the member list hasn't been fetched yet.
      const partiallySelected =
        !obj.selected && (obj.childXmlNames ?? []).some((c: FileProperty) => c.selected);
      chk.indeterminate = partiallySelected;
      chk.setAttribute(
        'aria-label',
        partiallySelected
          ? `Select all ${obj.xmlName} (some members selected)`
          : `Select all ${obj.xmlName}`,
      );
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
            childLi.classList.add('sfdt-row', 'sfdt-snug');
            const childChk = doc.createElement('input');
            childChk.type = 'checkbox';
            childChk.checked = !!child.selected;
            childChk.setAttribute('aria-label', `Select ${obj.xmlName} ${child.fullName}`);
            childChk.addEventListener('change', () => {
              child.selected = childChk.checked;
              // Unticking a member while the whole type is ticked narrows the
              // sticky `*` wildcard down to the remaining explicit members.
              if (!childChk.checked && obj.selected) obj.selected = false;
              onSelectionChanged();
              renderTree();
            });
            childLi.appendChild(childChk);

            const childLabel = doc.createElement('span');
            childLabel.textContent = child.fullName;
            childLabel.className = 'sfdt-muted';
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

  // Mode/bridge-dependent DOM handles
  let bridgeStatusEl: HTMLElement | null = null;
  let managedLabelEl: HTMLLabelElement | null = null;
  let warningBannerEl: HTMLDivElement | null = null;
  let pairSectionEl: HTMLDivElement | null = null;
  let pairTextareaEl: HTMLTextAreaElement | null = null;
  let xmlLabelEl: HTMLSpanElement | null = null;
  let retrieveBtnEl: HTMLButtonElement | null = null;
  let modeAdditiveBtnEl: HTMLButtonElement | null = null;
  let modeDestructiveBtnEl: HTMLButtonElement | null = null;

  function updateBridgeDom(): void {
    if (bridgeStatusEl) {
      bridgeStatusEl.textContent = bridge
        ? `sfdt bridge connected${bridgeOrg ? ` (org: ${bridgeOrg})` : ''} — discovery and XML come from the sfdt CLI.`
        : 'sfdt bridge offline — using the Salesforce SOAP API directly. Run `sfdt ui` in your project to connect.';
    }
    // Managed-package filtering is a SOAP-describe concept; the bridge path
    // returns the CLI's org inventory as-is.
    if (managedLabelEl) managedLabelEl.style.display = bridge ? 'none' : 'flex';
  }

  function applyModeDom(): void {
    const destructive = manifestMode === 'destructive';
    if (modeAdditiveBtnEl && modeDestructiveBtnEl) {
      // '.sfdt-segment' already paints the pressed row — the aria state IS the
      // style hook, so setting both an attribute and four colours was saying the
      // same thing twice and only one of them was theme-correct.
      modeAdditiveBtnEl.setAttribute('aria-pressed', destructive ? 'false' : 'true');
      modeDestructiveBtnEl.setAttribute('aria-pressed', destructive ? 'true' : 'false');
    }
    if (warningBannerEl) warningBannerEl.style.display = destructive ? 'block' : 'none';
    if (pairSectionEl) pairSectionEl.style.display = destructive ? 'flex' : 'none';
    if (xmlLabelEl) xmlLabelEl.textContent = destructive ? 'destructiveChanges.xml preview' : 'package.xml preview';
    if (retrieveBtnEl) {
      retrieveBtnEl.disabled = destructive;
      retrieveBtnEl.title = destructive ? 'Retrieve works from package.xml — switch to Additive mode.' : '';
    }
  }

  function setManifestMode(mode: ManifestMode): void {
    if (manifestMode === mode) return;
    manifestMode = mode;
    applyModeDom();
    void updatePreview();
  }

  function downloadFile(filename: string, content: string): void {
    triggerDownload(doc, filename, content, 'text/xml');
  }

  async function open(): Promise<void> {
    close();
    manifestMode = 'additive';
    destructivePair = null;

    // Body wrapper presented into a Workspace tab (or a modal on a Salesforce page).
    const body = doc.createElement('div');
    body.className = 'sfdt-view-body';

    // Tabs. '.sfdt-tab', NOT '.sfdt-nav-item' — see the note in lib/ui-styles.ts:
    // a nav item is a vertical sidebar row and marks "current" with a LEFT
    // border, which in a horizontal strip stretches every tab and puts the
    // indicator on the wrong edge.
    const tabsRow = doc.createElement('div');
    tabsRow.className = 'sfdt-tabs';
    tabsRow.setAttribute('role', 'tablist');
    const rTab = doc.createElement('button');
    rTab.type = 'button';
    rTab.textContent = 'Retrieve';
    rTab.className = 'sfdt-tab';
    rTab.setAttribute('aria-current', 'page');
    const dTab = doc.createElement('button');
    dTab.type = 'button';
    dTab.textContent = 'Deploy';
    dTab.className = 'sfdt-tab';

    // The busy indicator sits with the tabs rather than in its own strip: it
    // marks the WHOLE tool as working, and a row that exists only to hold a
    // 14px dot is a row of empty space the rest of the time.
    spinnerEl = doc.createElement('div');
    spinnerEl.className = 'sfdt-spinner sfdt-toolbar-end';
    spinnerEl.setAttribute('role', 'status');
    spinnerEl.setAttribute('aria-label', 'Working');
    spinnerEl.style.display = 'none';

    tabsRow.append(rTab, dTab, spinnerEl);
    body.appendChild(tabsRow);

    // Main Content wrapper
    const mainWrap = doc.createElement('div');
    mainWrap.className = 'sfdt-split-main';
    body.appendChild(mainWrap);

    // Retrieve Panel — two equal columns: pick on the left, see the manifest
    // you built on the right.
    const rPanel = doc.createElement('div');
    rPanel.className = 'sfdt-split';
    mainWrap.appendChild(rPanel);

    // Left half (Tree & Filter)
    const treeDiv = doc.createElement('div');
    treeDiv.className = 'sfdt-split-half sfdt-stack';
    rPanel.appendChild(treeDiv);

    const filterRow = doc.createElement('div');
    filterRow.classList.add('sfdt-row');
    const search = doc.createElement('input');
    search.type = 'text';
    search.placeholder = 'Filter metadata type or member...';
    search.setAttribute('aria-label', 'Filter metadata type or member');
    search.className = 'sfdt-field';
    search.addEventListener('input', () => {
      metadataFilter = search.value.toLowerCase();
      renderTree();
    });
    filterRow.appendChild(search);

    managedLabelEl = doc.createElement('label');
    managedLabelEl.className = 'sfdt-check';
    const managedChk = doc.createElement('input');
    managedChk.type = 'checkbox';
    managedChk.checked = includeManagedPackage;
    managedChk.addEventListener('change', () => {
      includeManagedPackage = managedChk.checked;
      void loadMetadataDescribe().then(async () => {
        await restoreSelections();
        await updatePreview();
        renderTree();
      });
    });
    managedLabelEl.appendChild(managedChk);
    managedLabelEl.appendChild(doc.createTextNode('Managed'));
    filterRow.appendChild(managedLabelEl);

    const clearAllBtn = doc.createElement('button');
    clearAllBtn.textContent = 'Clear all';
    clearAllBtn.setAttribute('aria-label', 'Clear all selections');
    clearAllBtn.className = 'sfdt-btn sfdt-sm';
    clearAllBtn.addEventListener('click', () => {
      clearAllSelections();
    });
    filterRow.appendChild(clearAllBtn);

    treeDiv.appendChild(filterRow);

    treeContainer = doc.createElement('div');
    treeContainer.className = 'sfdt-scroll sfdt-frame';
    treeDiv.appendChild(treeContainer);

    // Right half (XML Output)
    const xmlDiv = doc.createElement('div');
    xmlDiv.className = 'sfdt-split-half sfdt-stack';
    rPanel.appendChild(xmlDiv);

    // Mode toggle: Additive (package.xml) | Destructive (destructiveChanges.xml pair)
    const modeRow = doc.createElement('div');
    modeRow.setAttribute('role', 'group');
    modeRow.setAttribute('aria-label', 'Manifest mode');
    modeRow.classList.add('sfdt-row', 'sfdt-tight');
    modeAdditiveBtnEl = doc.createElement('button');
    modeAdditiveBtnEl.textContent = 'Additive';
    modeAdditiveBtnEl.classList.add('sfdt-grow');
    modeAdditiveBtnEl.addEventListener('click', () => setManifestMode('additive'));
    modeDestructiveBtnEl = doc.createElement('button');
    modeDestructiveBtnEl.textContent = 'Destructive';
    modeDestructiveBtnEl.classList.add('sfdt-grow');
    modeDestructiveBtnEl.addEventListener('click', () => setManifestMode('destructive'));
    modeRow.appendChild(modeAdditiveBtnEl);
    modeRow.appendChild(modeDestructiveBtnEl);
    xmlDiv.appendChild(modeRow);

    // Destructive warning banner (P5-5): deploying the pair DELETES components.
    //
    // '.sfdt-callout.sfdt-bad', not the error console. It carries OUR prose, not
    // an org error — the distinction lib/ui-styles.ts draws at '.sfdt-callout':
    // the console is a monospace block for the org's own text. It had been
    // wearing the error console's classes, which made it the one static banner
    // that looked like a Salesforce failure and put it inside every sweep aimed
    // at the org-error path.
    warningBannerEl = doc.createElement('div');
    warningBannerEl.setAttribute('role', 'alert');
    warningBannerEl.classList.add('sfdt-callout', 'sfdt-bad');
    warningBannerEl.style.display = 'none';
    const warnStrong = doc.createElement('strong');
    warnStrong.textContent = 'Destructive manifest — deploying this pair DELETES the listed components from the org. ';
    warningBannerEl.appendChild(warnStrong);
    warningBannerEl.appendChild(doc.createTextNode(
      'destructiveChanges.xml must be deployed together with the empty package.xml below. Deploy timing (pre/post) is controlled by SFDT_DESTRUCTIVE_TIMING — ',
    ));
    const warnLink = doc.createElement('a');
    warnLink.textContent = 'read the docs before deploying';
    warnLink.href = DESTRUCTIVE_DOCS_URL;
    warnLink.target = '_blank';
    warnLink.rel = 'noreferrer noopener';
    warnLink.classList.add('sfdt-link', 'sfdt-text-bad');
    warningBannerEl.appendChild(warnLink);
    warningBannerEl.appendChild(doc.createTextNode('.'));
    xmlDiv.appendChild(warningBannerEl);

    xmlLabelEl = doc.createElement('span');
    xmlLabelEl.textContent = 'package.xml preview';
    xmlLabelEl.className = 'sfdt-label';
    xmlDiv.appendChild(xmlLabelEl);

    const xmlTextarea = doc.createElement('textarea');
    xmlTextarea.id = 'sfdt-meta-xml-textarea';
    xmlTextarea.readOnly = true;
    xmlTextarea.value = packageXml;
    xmlTextarea.placeholder = 'Select components to preview the manifest.';
    xmlTextarea.setAttribute('aria-label', 'Manifest XML preview');
    xmlTextarea.className = 'sfdt-field sfdt-mono';
    xmlTextareaEl = xmlTextarea;
    xmlDiv.appendChild(xmlTextarea);

    // The destructive deploy pair: an empty package.xml deployed alongside.
    pairSectionEl = doc.createElement('div');
    pairSectionEl.className = 'sfdt-stack sfdt-tight';
    pairSectionEl.style.display = 'none';
    pairSectionEl.style.height = '110px';
    const pairLabel = doc.createElement('span');
    pairLabel.textContent = 'package.xml (empty deploy pair)';
    pairLabel.className = 'sfdt-label';
    pairSectionEl.appendChild(pairLabel);
    pairTextareaEl = doc.createElement('textarea');
    pairTextareaEl.id = 'sfdt-meta-pair-textarea';
    pairTextareaEl.readOnly = true;
    pairTextareaEl.setAttribute('aria-label', 'Empty package.xml deploy pair preview');
    pairTextareaEl.className = 'sfdt-field sfdt-mono sfdt-grow sfdt-fixed';
    pairSectionEl.appendChild(pairTextareaEl);
    xmlDiv.appendChild(pairSectionEl);

    const rActions = doc.createElement('div');
    rActions.classList.add('sfdt-row');
    const copyXmlBtn = doc.createElement('button');
    copyXmlBtn.textContent = 'Copy XML';
    copyXmlBtn.className = 'sfdt-btn sfdt-sm';
    copyXmlBtn.addEventListener('click', () => {
      void copyToClipboard(packageXml, { doc, win, label: 'package.xml' });
      showToast(
        manifestMode === 'destructive'
          ? 'destructiveChanges.xml copied to clipboard'
          : 'package.xml copied to clipboard',
        { doc, kind: 'success' },
      );
    });
    const downloadXmlBtn = doc.createElement('button');
    downloadXmlBtn.textContent = 'Download XML';
    downloadXmlBtn.className = 'sfdt-btn sfdt-sm';
    downloadXmlBtn.addEventListener('click', () => {
      if (manifestMode === 'destructive') {
        // The pair only makes sense together — download both files.
        downloadFile('destructiveChanges.xml', packageXml);
        downloadFile('package.xml', destructivePair?.emptyPackageXml ?? '');
      } else {
        downloadFile('package.xml', packageXml);
      }
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
    importXmlBtn.className = 'sfdt-btn sfdt-sm';
    importXmlBtn.addEventListener('click', () => {
      fileUploadXml.click();
    });

    retrieveBtnEl = doc.createElement('button');
    retrieveBtnEl.textContent = 'Retrieve Zip';
    retrieveBtnEl.className = 'sfdt-btn sfdt-primary sfdt-sm sfdt-toolbar-end';
    retrieveBtnEl.addEventListener('click', () => {
      void runRetrieve();
    });

    rActions.appendChild(copyXmlBtn);
    rActions.appendChild(downloadXmlBtn);
    rActions.appendChild(importXmlBtn);
    rActions.appendChild(retrieveBtnEl);
    xmlDiv.appendChild(rActions);

    // Deploy Panel (initially hidden)
    const dPanel = doc.createElement('div');
    dPanel.classList.add('sfdt-view-main');
    mainWrap.appendChild(dPanel);

    const deployForm = doc.createElement('div');
    deployForm.style.cssText = 'display: flex; flex-direction: column; gap: 12px; max-width: 500px;';
    dPanel.appendChild(deployForm);

    const fileRow = doc.createElement('div');
    fileRow.classList.add('sfdt-stack', 'sfdt-tight');
    const fileLabel = doc.createElement('label');
    fileLabel.textContent = 'Select Metadata ZIP File';
    fileLabel.classList.add('sfdt-subhead');
    const fileInput = doc.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.zip';
    // A file input's chooser button is UA-drawn, but the filename beside it takes
    // the inherited colour — which was unset, so it rendered dark-on-dark.
    fileInput.className = 'sfdt-field sfdt-auto';
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
    testLevelRow.classList.add('sfdt-stack', 'sfdt-tight');
    const testLevelLabel = doc.createElement('label');
    testLevelLabel.textContent = 'Test Level';
    testLevelLabel.className = 'sfdt-label';
    const testLevelSelect = doc.createElement('select');
    testLevelSelect.className = 'sfdt-field sfdt-auto';
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
    runTestsLabel.className = 'sfdt-label';
    const runTestsInput = doc.createElement('input');
    runTestsInput.type = 'text';
    runTestsInput.placeholder = 'MyTestClass1, MyTestClass2';
    runTestsInput.className = 'sfdt-field sfdt-auto';
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
    deployBtn.className = 'sfdt-btn sfdt-primary';
    deployBtn.classList.add('sfdt-selfstart');
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
    // Execution log — a fixed-height bottom pane, like a terminal drawer. The
    // header is a real toolbar so its Clear action matches every other toolbar
    // action in the product.
    const logsWrap = doc.createElement('div');
    logsWrap.className = 'sfdt-stack sfdt-tight sfdt-drawer';
    logsWrap.style.height = '150px';
    body.appendChild(logsWrap);

    const logsLabel = toolbar(doc);
    logsLabel.textContent = 'Execution Log';
    const clearLogsBtn = doc.createElement('button');
    clearLogsBtn.textContent = 'Clear Logs';
    clearLogsBtn.className = 'sfdt-btn sfdt-ghost sfdt-sm sfdt-toolbar-end';
    clearLogsBtn.addEventListener('click', clearLogs);
    logsLabel.appendChild(clearLogsBtn);
    logsWrap.appendChild(logsLabel);

    logsContainer = doc.createElement('div');
    logsContainer.className = 'sfdt-console sfdt-scroll';
    logsContainer.style.maxHeight = 'none';
    logsWrap.appendChild(logsContainer);

    // Status bar: which data path is live, and against which API. The bridge
    // line used to be a loose row under the tabs, where it read as content
    // rather than as chrome.
    const statusBar = toolbar(doc, true);
    const bridgeLine = doc.createElement('span');
    bridgeLine.className = 'sfdt-muted';
    bridgeLine.textContent = 'Checking for a connected sfdt bridge...';
    bridgeStatusEl = bridgeLine;
    const apiLine = doc.createElement('span');
    apiLine.className = 'sfdt-muted sfdt-toolbar-end';
    apiLine.textContent = `Salesforce API ${SF_API_VERSION}`;
    statusBar.append(bridgeLine, apiLine);
    body.appendChild(statusBar);

    // Tab Event listeners
    // The tab pair is a '.sfdt-nav-item' group; 'aria-current' is both the
    // accessible state and the style hook, so switching tabs is one attribute
    // each rather than six colour writes.
    rTab.addEventListener('click', () => {
      rTab.setAttribute('aria-current', 'page');
      dTab.removeAttribute('aria-current');
      rPanel.style.display = 'flex';
      dPanel.style.display = 'none';
    });

    dTab.addEventListener('click', () => {
      dTab.setAttribute('aria-current', 'page');
      rTab.removeAttribute('aria-current');
      dPanel.style.display = 'flex';
      rPanel.style.display = 'none';
    });

    view = presentView({
      title: 'Metadata Retrieve & Deploy',
      iconName: 'metadata-retrieve',
      body,
      doc,
      width: '960px',
      onClose: () => { isWorking = false; view = null; bridge = null; },
    });

    applyModeDom();
    await initDataSource();
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
