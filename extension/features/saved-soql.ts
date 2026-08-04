import { z } from 'zod';
import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { loadSettings, registerSettingsShape } from '../lib/settings.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import {
  readSavedQueries,
  deleteSavedQuery,
  readSoqlHistory,
  writePendingQuery,
  entryLang,
  type QueryLang,
  type SavedQuery,
} from './soql-runner.js';
import { SOQL_TEMPLATES } from './soql-templates.js';
import { button } from '../lib/ui-controls.js';

const SAVED_SOQL_SETTINGS_SCHEMA = z.object({
  showHistory: z.boolean().default(true),
});

registerSettingsShape('saved-soql', SAVED_SOQL_SETTINGS_SCHEMA);

export interface SavedSoqlOptions {
  doc?: Document;
  win?: Window;
  /**
   * Workspace hook: invoked after a query is stashed so the shell can open the
   * SOQL Runner panel (which then consumes the pending query). When absent
   * (e.g. on a Salesforce page), the user is told to open the runner manually.
   */
  onLoadQuery?: () => void;
}

export function createSavedSoqlFeature(options: SavedSoqlOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;

  let view: ViewHandle | null = null;

  function close(): void {
    view?.close();
    view = null;
  }

  async function loadInRunner(q: string, api: SavedQuery['api'], lang: QueryLang): Promise<void> {
    await writePendingQuery({ q, api, lang });
    close();
    if (options.onLoadQuery) {
      options.onLoadQuery();
    } else {
      showToast('Query staged — open the SOQL Runner to use it.', { doc, kind: 'success' });
    }
  }

  async function open(): Promise<void> {
    close();
    const settings = await loadSettings();
    const config = (settings.featureSettings?.['saved-soql'] ?? {
      showHistory: true,
    }) as z.infer<typeof SAVED_SOQL_SETTINGS_SCHEMA>;

    const bodyEl = doc.createElement('div');
    bodyEl.classList.add('sfdt-view-main');
    view = presentView({
      title: '⭐ Saved SOQL',
      body: bodyEl,
      doc,
      width: '720px',
      onClose: () => { view = null; },
    });

    function sectionTitle(text: string): HTMLDivElement {
      const t = doc.createElement('div');
      t.textContent = text;
      t.classList.add('sfdt-subhead');
      return t;
    }

    function queryRow(
      q: string,
      apiMode: SavedQuery['api'],
      lang: QueryLang,
      onDelete?: () => void,
    ): HTMLDivElement {
      const row = doc.createElement('div');
      row.style.cssText =
        'display: flex; gap: 8px; align-items: center; padding: 6px 8px; border: 1px solid var(--sfdt-color-surface-shade-3); border-radius: 4px;';
      // Query language first — it decides how the entry runs; the API mode
      // (REST/Tooling) only applies to SOQL.
      const langBadge = doc.createElement('span');
      langBadge.textContent = lang === 'sosl' ? 'SOSL' : 'SOQL';
      langBadge.style.cssText =
        'min-width: 44px; text-align: center; font-size: 10px; padding: 2px 4px; border-radius: 3px; background: var(--sfdt-color-surface-shade-3); color: var(--sfdt-color-text-weak);';
      const badge = doc.createElement('span');
      badge.textContent = apiMode === 'tooling' ? 'Tooling' : 'REST';
      badge.style.cssText =
        'min-width: 54px; text-align: center; font-size: 10px; padding: 2px 4px; border-radius: 3px; background: var(--sfdt-color-brand-deep); color: var(--sfdt-color-on-accent);';
      const text = doc.createElement('span');
      text.textContent = q;
      text.style.cssText =
        'flex: 1; font-family: ui-monospace, monospace; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
      const loadBtn = button({ label: 'Load', variant: 'primary', small: true, doc });
      loadBtn.addEventListener('click', () => void loadInRunner(q, apiMode, lang));
      row.appendChild(langBadge);
      row.appendChild(badge);
      row.appendChild(text);
      row.appendChild(loadBtn);
      if (onDelete) {
        // Was a bare '🗑' with no accessible name.
        const delBtn = button({ iconName: 'trash', ariaLabel: `Delete bookmark ${q}`, variant: 'danger', small: true, doc });
        delBtn.addEventListener('click', onDelete);
        row.appendChild(delBtn);
      }
      return row;
    }

    // --- Saved (bookmarked) queries ---
    const savedSection = doc.createElement('div');
    savedSection.classList.add('sfdt-stack', 'sfdt-snug');
    savedSection.appendChild(sectionTitle('Bookmarks'));
    const savedList = doc.createElement('div');
    savedList.classList.add('sfdt-stack', 'sfdt-tight');
    savedSection.appendChild(savedList);
    bodyEl.appendChild(savedSection);

    async function renderSaved(): Promise<void> {
      while (savedList.firstChild) savedList.removeChild(savedList.firstChild);
      const saved = await readSavedQueries();
      if (saved.length === 0) {
        const empty = doc.createElement('div');
        empty.className = 'sfdt-faint';
        empty.textContent = 'No bookmarks yet. Save queries from the SOQL Runner using Save.';
        savedList.appendChild(empty);
        return;
      }
      for (const item of saved) {
        const nameLabel = doc.createElement('div');
        nameLabel.textContent = item.name;
        nameLabel.classList.add('sfdt-muted');
        savedList.appendChild(nameLabel);
        savedList.appendChild(
          queryRow(item.q, item.api, entryLang(item), async () => {
            await deleteSavedQuery(item.name);
            await renderSaved();
          }),
        );
      }
    }
    await renderSaved();

    // --- Built-in templates (read-only, no delete affordance) ---
    const tplSection = doc.createElement('div');
    tplSection.classList.add('sfdt-stack', 'sfdt-snug');
    tplSection.appendChild(sectionTitle('Templates'));
    const tplHint = doc.createElement('div');
    tplHint.textContent = 'Built-in admin & dev queries — click Load to copy into the runner.';
    tplHint.className = 'sfdt-faint';
    tplSection.appendChild(tplHint);
    const tplList = doc.createElement('div');
    tplList.setAttribute('role', 'list');
    tplList.setAttribute('aria-label', 'Built-in SOQL templates');
    tplList.classList.add('sfdt-stack', 'sfdt-snug');
    tplSection.appendChild(tplList);
    bodyEl.appendChild(tplSection);

    for (const tpl of SOQL_TEMPLATES) {
      // Visually distinct from user bookmarks: brand-accent left border + a
      // "Built-in" tag. No delete button is rendered (queryRow omits onDelete),
      // so built-ins cannot be deleted (AC3).
      const wrap = doc.createElement('div');
      wrap.setAttribute('role', 'listitem');
      wrap.style.cssText =
        'display: flex; flex-direction: column; gap: 2px; padding-left: 8px; border-left: 3px solid var(--sfdt-color-brand);';
      const nameRow = doc.createElement('div');
      nameRow.classList.add('sfdt-row');
      const nameLabel = doc.createElement('span');
      nameLabel.textContent = tpl.name;
      nameLabel.classList.add('sfdt-subhead');
      const tag = doc.createElement('span');
      tag.textContent = 'Built-in';
      tag.style.cssText =
        'font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; padding: 1px 5px; border-radius: 3px; background: var(--sfdt-color-surface-shade-3); color: var(--sfdt-color-text-weak);';
      nameRow.appendChild(nameLabel);
      nameRow.appendChild(tag);
      const desc = doc.createElement('div');
      desc.textContent = tpl.description;
      desc.className = 'sfdt-muted';
      wrap.appendChild(nameRow);
      wrap.appendChild(desc);
      wrap.appendChild(queryRow(tpl.q, tpl.api, entryLang(tpl)));
      tplList.appendChild(wrap);
    }

    // --- Recent history ---
    if (config.showHistory) {
      const histSection = doc.createElement('div');
      histSection.classList.add('sfdt-stack', 'sfdt-snug');
      histSection.appendChild(sectionTitle('Recent'));
      const histList = doc.createElement('div');
      histList.classList.add('sfdt-stack', 'sfdt-tight');
      histSection.appendChild(histList);
      bodyEl.appendChild(histSection);

      const history = await readSoqlHistory();
      if (history.length === 0) {
        const empty = doc.createElement('div');
        empty.className = 'sfdt-faint';
        empty.textContent = 'No recent queries.';
        histList.appendChild(empty);
      } else {
        for (const entry of history) {
          histList.appendChild(queryRow(entry.q, entry.api, entryLang(entry)));
        }
      }
    }
  }

  return {
    manifest: {
      id: 'saved-soql',
      name: 'Saved SOQL',
      contexts: [CONTEXTS.WORKSPACE],
      settingsSchema: SAVED_SOQL_SETTINGS_SCHEMA,
    },

    async onActivate() {
      const ctx = detectContext({ location: { href: win.location.href } }, doc);
      if (ctx === CONTEXTS.NONE) {
        showToast('Open the Workspace to browse saved SOQL.', { doc, kind: 'warning' });
        return;
      }
      await open();
    },
  };
}
