import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import { escapeSoql } from '../lib/escape.js';
import type { Feature } from '../lib/feature-registry.js';
import {
  getSalesforceApi,
  type SalesforceApiClient,
} from '../lib/salesforce-api.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';

/** Metadata types the explorer can resolve to a component Id. */
export type MetadataType =
  | 'ApexClass'
  | 'ApexTrigger'
  | 'ApexPage'
  | 'Flow'
  | 'CustomField'
  | 'LightningComponentBundle';

// Per type: which Tooling object holds the Id, and which field carries the
// developer-entered name. Apex* objects key on `Name`; Flow/LWC/CustomField
// are stored under their own definition objects keyed on `DeveloperName`.
const RESOLVE: Record<string, { object: string; nameField: 'Name' | 'DeveloperName' }> = {
  ApexClass: { object: 'ApexClass', nameField: 'Name' },
  ApexTrigger: { object: 'ApexTrigger', nameField: 'Name' },
  ApexPage: { object: 'ApexPage', nameField: 'Name' },
  Flow: { object: 'FlowDefinition', nameField: 'DeveloperName' },
  LightningComponentBundle: { object: 'LightningComponentBundle', nameField: 'DeveloperName' },
  CustomField: { object: 'CustomField', nameField: 'DeveloperName' },
};

/** The order types appear in the picker. */
export const METADATA_TYPES = Object.keys(RESOLVE);

/** Build the SOQL that resolves a name+type to its component Id (quote-escaped). */
export function resolveQueryFor(type: string, name: string): string {
  const cfg = RESOLVE[type];
  if (!cfg) throw new Error(`Unsupported metadata type: ${type}`);
  return `SELECT Id FROM ${cfg.object} WHERE ${cfg.nameField}='${escapeSoql(name)}'`;
}

export interface DependencyGroup {
  type: string;
  names: string[];
}

/**
 * Collapse dependency rows into per-type groups, sorted by type then name.
 * `nameKey`/`typeKey` differ between the two dependency queries
 * (Ref* for references, plain for referenced-by).
 */
export function groupByType(
  rows: Array<Record<string, unknown>>,
  nameKey: string,
  typeKey: string,
): DependencyGroup[] {
  const byType = new Map<string, string[]>();
  for (const row of rows) {
    const type = String(row[typeKey] ?? '(unknown)');
    const name = String(row[nameKey] ?? '(unknown)');
    const list = byType.get(type) ?? [];
    list.push(name);
    byType.set(type, list);
  }
  return [...byType.entries()]
    .map(([type, names]) => ({ type, names: names.sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

export interface DependencyExplorerOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
}

export function createDependencyExplorerFeature(
  options: DependencyExplorerOptions = {},
): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();

  let view: ViewHandle | null = null;

  function close(): void {
    view?.close();
    view = null;
  }

  function typeBadge(type: string): HTMLElement {
    const badge = doc.createElement('span');
    badge.style.cssText =
      'display: inline-block; padding: 1px 7px; border-radius: 10px; background: #eef1f6; color: #54698d; font-size: 11px; font-weight: 600; white-space: nowrap;';
    badge.textContent = type;
    return badge;
  }

  function renderSection(title: string, groups: DependencyGroup[]): HTMLElement {
    const section = doc.createElement('div');
    section.style.cssText = 'margin-top: 16px;';

    const count = groups.reduce((n, g) => n + g.names.length, 0);
    const heading = doc.createElement('div');
    heading.style.cssText =
      'font-weight: 600; font-size: 13px; margin-bottom: 8px; border-bottom: 1px solid #d8dde6; padding-bottom: 4px;';
    heading.textContent = `${title} (${count})`;
    section.appendChild(heading);

    if (count === 0) {
      const empty = doc.createElement('div');
      empty.style.cssText = 'padding: 6px 0; color: #80868d; font-size: 12px;';
      empty.textContent = 'None.';
      section.appendChild(empty);
      return section;
    }

    for (const group of groups) {
      for (const name of group.names) {
        const row = doc.createElement('div');
        row.style.cssText =
          'display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12px;';
        row.appendChild(typeBadge(group.type));
        const label = doc.createElement('span');
        label.style.cssText = 'word-break: break-all;';
        label.textContent = name;
        row.appendChild(label);
        section.appendChild(row);
      }
    }
    return section;
  }

  async function search(
    name: string,
    type: string,
    results: HTMLElement,
    status: HTMLSpanElement,
  ): Promise<void> {
    while (results.firstChild) results.removeChild(results.firstChild);
    if (!name.trim()) {
      status.textContent = 'Enter a component name.';
      return;
    }
    status.textContent = 'Resolving…';
    try {
      const resolved = await api.toolingQuery<{ Id?: string }>(resolveQueryFor(type, name.trim()));
      const id = resolved.records[0]?.Id;
      if (!id) {
        status.textContent = '';
        const msg = doc.createElement('div');
        msg.style.cssText = 'padding: 12px; color: #80868d;';
        msg.textContent = `No ${type} named "${name.trim()}" found in this org.`;
        results.appendChild(msg);
        return;
      }

      // CustomField DeveloperName is not unique (same field name on many
      // objects) — we resolve against the first match and say so.
      if (type === 'CustomField' && resolved.records.length > 1) {
        const note = doc.createElement('div');
        note.style.cssText =
          'padding: 8px 12px; margin-bottom: 6px; background: #fff8e5; border: 1px solid #f4d27a; border-radius: 4px; font-size: 12px; color: #6b5a1f;';
        note.textContent = `${resolved.records.length} fields share this name — showing dependencies for the first match (${id}).`;
        results.appendChild(note);
      }

      status.textContent = 'Loading dependencies…';
      const [refs, refBy] = await Promise.all([
        api.toolingQuery<Record<string, unknown>>(
          `SELECT RefMetadataComponentName, RefMetadataComponentType FROM MetadataComponentDependency WHERE MetadataComponentId = '${id}' ORDER BY RefMetadataComponentType, RefMetadataComponentName`,
        ),
        api.toolingQuery<Record<string, unknown>>(
          `SELECT MetadataComponentName, MetadataComponentType FROM MetadataComponentDependency WHERE RefMetadataComponentId = '${id}' ORDER BY MetadataComponentType, MetadataComponentName`,
        ),
      ]);

      const refGroups = groupByType(refs.records, 'RefMetadataComponentName', 'RefMetadataComponentType');
      const refByGroups = groupByType(refBy.records, 'MetadataComponentName', 'MetadataComponentType');
      status.textContent = `${name.trim()} (${type})`;

      if (refs.records.length === 0 && refBy.records.length === 0) {
        const empty = doc.createElement('div');
        empty.style.cssText = 'padding: 12px; color: #80868d;';
        empty.textContent = 'No metadata dependencies recorded for this component.';
        results.appendChild(empty);
        return;
      }

      results.appendChild(renderSection('References (this → others)', refGroups));
      results.appendChild(renderSection('Referenced by (others → this)', refByGroups));
    } catch (err) {
      const errorPanel = doc.createElement('div');
      errorPanel.style.cssText =
        'border: 1px solid #c23934; background: #fef2f1; color: #c23934; padding: 8px 12px; border-radius: 4px; font-size: 13px;';
      errorPanel.textContent = err instanceof Error ? err.message : String(err);
      results.appendChild(errorPanel);
      status.textContent = 'Failed';
    }
  }

  async function open(): Promise<void> {
    close();

    const body = doc.createElement('div');
    body.style.cssText =
      'padding: 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column;';

    // Search row — name input + type picker + Find, plus a status span. Lives in
    // the body since presentView's header is title + × only.
    const searchRow = doc.createElement('div');
    searchRow.style.cssText = 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;';

    const nameInput = doc.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Component name';
    nameInput.style.cssText =
      'flex: 1; min-width: 180px; padding: 5px 8px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 13px;';

    const typeSelect = doc.createElement('select');
    typeSelect.style.cssText =
      'padding: 5px 8px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 13px;';
    for (const t of METADATA_TYPES) {
      const opt = doc.createElement('option');
      opt.value = t;
      opt.textContent = t;
      typeSelect.appendChild(opt);
    }

    const findBtn = doc.createElement('button');
    findBtn.textContent = 'Find';
    findBtn.style.cssText =
      'padding: 5px 14px; border: 1px solid #0070d2; background: #0070d2; color: #fff; border-radius: 4px; cursor: pointer; font-size: 13px;';

    const status = doc.createElement('span');
    status.style.cssText = 'color: #54698d; font-size: 12px; margin-left: 4px;';

    searchRow.append(nameInput, typeSelect, findBtn, status);
    body.appendChild(searchRow);

    const results = doc.createElement('div');
    body.appendChild(results);

    view = presentView({
      title: '🔗 Dependency Explorer',
      body,
      doc,
      width: '720px',
      onClose: () => { view = null; },
    });

    const run = async (): Promise<void> => {
      findBtn.disabled = true;
      await search(nameInput.value, typeSelect.value, results, status);
      findBtn.disabled = false;
    };
    findBtn.addEventListener('click', run);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void run();
    });
  }

  return {
    manifest: {
      id: 'dependency-explorer',
      name: 'Dependency Explorer',
      contexts: [
        CONTEXTS.SETUP_FLOWS,
        CONTEXTS.SETUP_OTHER,
        CONTEXTS.FLOW_BUILDER,
        CONTEXTS.FLOW_TRIGGER_EXPLORER,
      ],
    },

    async onActivate() {
      const ctx = detectContext({ location: { href: win.location.href } }, doc);
      if (ctx === CONTEXTS.NONE) {
        showToast('Open a Salesforce page to explore dependencies.', { doc, kind: 'warning' });
        return;
      }
      await open();
    },
  };
}

export function _dependencyExplorerTestApi() {
  return { resolveQueryFor, groupByType, METADATA_TYPES };
}
