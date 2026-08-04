import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import {
  getSalesforceApi,
  type SalesforceApiClient,
} from '../lib/salesforce-api.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import {
  resolveQueryFor,
  referencesQuery,
  referencedByQuery,
  groupByType,
  METADATA_TYPES,
  type DependencyGroup,
} from '@sfdt/flow-core';
import { button, toolbar } from '../lib/ui-controls.js';

// Resolution/grouping/query logic now lives in @sfdt/flow-core so the Chrome
// explorer, the GUI Dependency page, and `sfdt dependencies` resolve and group
// identically. Re-exported so this module's test keeps importing them by name.
export { resolveQueryFor, referencesQuery, referencedByQuery, groupByType, METADATA_TYPES };

export interface DependencyExplorerOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
}

/** The Dependency Explorer feature, plus an imperative opener for cross-links. */
export type DependencyExplorerFeature = Feature & {
  /** Open the explorer pre-filled for a component and run the search immediately. */
  openFor: (type: string, name: string) => Promise<void>;
};

export function createDependencyExplorerFeature(
  options: DependencyExplorerOptions = {},
): DependencyExplorerFeature {
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
      'display: inline-block; padding: 1px 7px; border-radius: 10px; background: var(--sfdt-color-surface-shade-5); color: var(--sfdt-color-text-weak); font-size: 11px; font-weight: 600; white-space: nowrap;';
    badge.textContent = type;
    return badge;
  }

  function renderSection(title: string, groups: DependencyGroup[]): HTMLElement {
    const section = doc.createElement('div');
    section.style.cssText = 'margin-top: 16px;';

    const count = groups.reduce((n, g) => n + g.names.length, 0);
    const heading = doc.createElement('div');
    heading.style.cssText =
      'font-weight: 600; font-size: 13px; margin-bottom: 8px; border-bottom: 1px solid var(--sfdt-color-border); padding-bottom: 4px;';
    heading.textContent = `${title} (${count})`;
    section.appendChild(heading);

    if (count === 0) {
      const empty = doc.createElement('div');
      empty.classList.add('sfdt-prose', 'sfdt-muted');
      empty.textContent = 'None.';
      section.appendChild(empty);
      return section;
    }

    for (const group of groups) {
      for (const name of group.names) {
        const row = doc.createElement('div');
        row.classList.add('sfdt-row', 'sfdt-snug', 'sfdt-prose');
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
        msg.classList.add('sfdt-prose', 'sfdt-muted');
        msg.textContent = `No ${type} named "${name.trim()}" found in this org.`;
        results.appendChild(msg);
        return;
      }

      // CustomField DeveloperName is not unique (same field name on many
      // objects) — we resolve against the first match and say so.
      if (type === 'CustomField' && resolved.records.length > 1) {
        const note = doc.createElement('div');
        note.style.cssText =
          'padding: 8px 12px; margin-bottom: 6px; background: var(--sfdt-color-warning-bg); border: 1px solid var(--sfdt-color-warning-border); border-radius: 4px; font-size: 12px; color: var(--sfdt-color-warning-text-2);';
        note.textContent = `${resolved.records.length} fields share this name — showing dependencies for the first match (${id}).`;
        results.appendChild(note);
      }

      status.textContent = 'Loading dependencies…';
      const [refs, refBy] = await Promise.all([
        api.toolingQuery<Record<string, unknown>>(referencesQuery(id)),
        api.toolingQuery<Record<string, unknown>>(referencedByQuery(id)),
      ]);

      const refGroups = groupByType(refs.records, 'RefMetadataComponentName', 'RefMetadataComponentType');
      const refByGroups = groupByType(refBy.records, 'MetadataComponentName', 'MetadataComponentType');
      status.textContent = `${name.trim()} (${type})`;

      if (refs.records.length === 0 && refBy.records.length === 0) {
        const empty = doc.createElement('div');
        empty.classList.add('sfdt-prose', 'sfdt-muted');
        empty.textContent = 'No metadata dependencies recorded for this component.';
        results.appendChild(empty);
        return;
      }

      results.appendChild(renderSection('References (this → others)', refGroups));
      results.appendChild(renderSection('Referenced by (others → this)', refByGroups));
    } catch (err) {
      const errorPanel = doc.createElement('div');
      errorPanel.classList.add('sfdt-console', 'sfdt-error');
      errorPanel.textContent = err instanceof Error ? err.message : String(err);
      results.appendChild(errorPanel);
      status.textContent = 'Failed';
    }
  }

  async function open(preset?: { type: string; name: string }): Promise<void> {
    close();

    const body = doc.createElement('div');
    body.className = 'sfdt-view-body';
    // The search row IS this view's toolbar — presentView's header is title + ×
    // only, so the controls live at the top of the body as a real strip.
    const searchRow = toolbar(doc);
    searchRow.classList.add('sfdt-wrap');
    const nameInput = doc.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Component name';
    nameInput.className = 'sfdt-field';
    nameInput.classList.add('sfdt-search');
    const typeSelect = doc.createElement('select');
    typeSelect.className = 'sfdt-field sfdt-auto';
    for (const t of METADATA_TYPES) {
      const opt = doc.createElement('option');
      opt.value = t;
      opt.textContent = t;
      typeSelect.appendChild(opt);
    }

    const findBtn = button({ label: 'Find', iconName: 'search', variant: 'primary', small: true, doc });

    const status = doc.createElement('span');
    status.style.cssText = 'color: var(--sfdt-color-text-weak); font-size: 12px; margin-left: 4px;';

    searchRow.append(nameInput, typeSelect, findBtn, status);
    body.appendChild(searchRow);
    const main = doc.createElement('div');
    main.className = 'sfdt-view-main';
    body.appendChild(main);

    const results = doc.createElement('div');
    main.appendChild(results);

    view = presentView({
      title: 'Dependency Explorer',
      iconName: 'graph',
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

    // Cross-link entry (e.g. from the Flow Scanner): pre-fill and search now.
    if (preset) {
      nameInput.value = preset.name;
      if (METADATA_TYPES.includes(preset.type)) typeSelect.value = preset.type;
      void run();
    }
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

    // Explicit programmatic open (cross-link target) — skips the context gate
    // since the caller is already inside an open workspace tool.
    async openFor(type: string, name: string) {
      await open({ type, name });
    },
  };
}

export function _dependencyExplorerTestApi() {
  return { resolveQueryFor, groupByType, METADATA_TYPES };
}
