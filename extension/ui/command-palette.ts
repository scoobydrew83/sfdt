// The command palette: a global, keyboard-first overlay listing every action the
// user can reach on the current Salesforce page — features, Setup deep-links,
// custom shortcuts, the current record, and (loaded lazily) the org's objects.
//
// Candidate assembly and ranking are NOT reimplemented here: candidates come
// from lib/palette-sources (buildPaletteSources) and ranking from lib/fuzzy
// (fuzzyScoreFields + stableSortByScore). This module owns only the overlay: the
// searchable listbox, the keyboard contract (Arrow/Enter/Esc + focus trap), and
// dispatching a chosen candidate through injected executors.
//
// House rules honoured: zero innerHTML (createElement + textContent — untrusted
// feature/object/setup labels are text-only), design tokens via var(--sfdt-*),
// shadow-root mounting via getContentRoot(), composedPath() for shadow-safe
// click-outside, and a capture-phase Esc listener removed on close.

import {
  buildPaletteSources,
  type PaletteCandidate,
  type PaletteSection,
  type PaletteSourceInputs,
} from '../lib/palette-sources.js';
import { fuzzyScoreFields, stableSortByScore } from '../lib/fuzzy.js';
import { getContentRoot } from './content-root.js';

/** A describe-cache sobject, narrowed to what the Objects category needs. */
export interface PaletteObject {
  name: string;
  label: string;
}

/** How the overlay carries out a chosen candidate. The opener wires these to the
 *  registry / navigation / inspector so the overlay stays free of chrome.* and
 *  the Salesforce API. */
export interface PaletteExecutors {
  activateFeature: (featureId: string) => void | Promise<void>;
  navigate: (url: string, newTab: boolean) => void;
  inspectRecord: (recordId: string) => void | Promise<void>;
  openObject: (objectName: string) => void | Promise<void>;
}

export interface CommandPaletteOptions {
  /** Synchronous inputs for buildPaletteSources — every category except Objects.
   *  No api/network access happens while building these (AC-1). */
  sourceInputs: PaletteSourceInputs;
  /** Loads the Objects category. Invoked AFTER first paint, never on the open
   *  path, so the describe round-trip can't block the palette showing (AC-1). */
  loadObjects?: () => Promise<PaletteObject[]>;
  executors: PaletteExecutors;
  /** Record an executed candidate id for recent-first ordering (palette-recents). */
  onExecute?: (candidateId: string) => void | Promise<void>;
  doc?: Document;
  win?: Window;
}

export interface CommandPaletteHandle {
  close: () => void;
  isOpen: () => boolean;
}

const OVERLAY_ID = 'sfdt-command-palette';

const OVERLAY_STYLE = [
  'position: fixed',
  'inset: 0',
  'background: rgba(0,0,0,0.4)',
  'z-index: 100030',
  'display: flex',
  'align-items: flex-start',
  'justify-content: center',
  'padding-top: 12vh',
  'font-family: system-ui, -apple-system, sans-serif',
].join('; ');

const CARD_STYLE = [
  'background: var(--sfdt-color-surface)',
  'color: var(--sfdt-color-text)',
  'width: 560px',
  'max-width: 92vw',
  'max-height: 70vh',
  'border: 1px solid var(--sfdt-color-border)',
  'border-radius: 8px',
  'box-shadow: 0 8px 32px rgba(0,0,0,0.25)',
  'display: flex',
  'flex-direction: column',
  'overflow: hidden',
].join('; ');

const HEADER_STYLE = [
  'display: flex',
  'align-items: center',
  'gap: 8px',
  'padding: 10px 12px',
  'border-bottom: 1px solid var(--sfdt-color-border)',
].join('; ');

const INPUT_STYLE = [
  'flex: 1',
  'border: 0',
  'outline: none',
  'background: transparent',
  'color: var(--sfdt-color-text)',
  'font-size: 15px',
  'padding: 4px 2px',
].join('; ');

const LIST_STYLE = ['flex: 1', 'overflow-y: auto', 'padding: 4px 0'].join('; ');

const HEADER_ROW_STYLE = [
  'padding: 8px 14px 2px',
  'font-size: 11px',
  'font-weight: 600',
  'text-transform: uppercase',
  'letter-spacing: 0.04em',
  'color: var(--sfdt-color-text-icon)',
].join('; ');

const OPTION_STYLE = [
  'padding: 8px 14px',
  'cursor: pointer',
  'display: flex',
  'align-items: center',
  'gap: 10px',
  'font-size: 13px',
].join('; ');

/** Filter each section to matching candidates and rank them; drop empty sections.
 *  Empty query keeps the source order (recents first). */
function filterSections(sections: readonly PaletteSection[], query: string): PaletteSection[] {
  const q = query.trim();
  if (q === '') return sections.filter((s) => s.candidates.length > 0);
  return sections
    .map((s) => {
      const matched = s.candidates.filter(
        (c) => fuzzyScoreFields(q, c.label, c.apiName) !== null,
      );
      const ranked = stableSortByScore(matched, (c) => fuzzyScoreFields(q, c.label, c.apiName) ?? 0);
      return { ...s, candidates: ranked };
    })
    .filter((s) => s.candidates.length > 0);
}

/** DOM-id-safe suffix for a candidate id (aria-activedescendant target). */
function optionDomId(candidateId: string): string {
  return `sfdt-cp-opt-${candidateId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

export function openCommandPalette(opts: CommandPaletteOptions): CommandPaletteHandle {
  const doc = opts.doc ?? document;
  const mount = getContentRoot() ?? doc.body;

  // One palette at a time — a re-open replaces any stray previous overlay.
  mount.querySelector(`#${OVERLAY_ID}`)?.remove();

  // Focus restore (checklist item 4): remember where focus was before opening.
  const previouslyFocused = doc.activeElement as HTMLElement | null;

  // Synchronous categories (recents/record/features/setup/shortcuts). The
  // Objects section is filled after first paint from loadObjects().
  const syncSections = buildPaletteSources(opts.sourceInputs);
  let objectSection: PaletteSection | null = null;

  let closed = false;
  let activeIndex = -1;
  let visible: Array<{ candidate: PaletteCandidate; el: HTMLElement }> = [];

  const overlay = doc.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.cssText = OVERLAY_STYLE;

  const card = doc.createElement('div');
  card.style.cssText = CARD_STYLE;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', 'Command palette');

  // --- Header: search input + close button ---
  const header = doc.createElement('div');
  header.style.cssText = HEADER_STYLE;

  const searchIcon = doc.createElement('span');
  searchIcon.textContent = '🔍';
  searchIcon.setAttribute('aria-hidden', 'true');

  const listId = 'sfdt-cp-listbox';
  const input = doc.createElement('input');
  input.type = 'text';
  input.style.cssText = INPUT_STYLE;
  input.setAttribute('aria-label', 'Search commands');
  input.setAttribute('placeholder', 'Search commands…');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('spellcheck', 'false');

  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.style.cssText =
    'background: none; border: 0; font-size: 20px; line-height: 1; cursor: pointer; color: var(--sfdt-color-text-icon);';

  header.append(searchIcon, input, closeBtn);

  // --- Results listbox ---
  const listbox = doc.createElement('div');
  listbox.id = listId;
  listbox.style.cssText = LIST_STYLE;
  listbox.setAttribute('role', 'listbox');
  listbox.setAttribute('aria-label', 'Results');

  card.append(header, listbox);
  overlay.appendChild(card);

  function setActive(index: number): void {
    if (visible.length === 0) {
      activeIndex = -1;
      input.removeAttribute('aria-activedescendant');
      return;
    }
    // Wrap so ArrowDown past the end returns to the top and vice-versa.
    const next = ((index % visible.length) + visible.length) % visible.length;
    const prev = visible[activeIndex];
    if (prev) {
      prev.el.setAttribute('aria-selected', 'false');
      prev.el.style.background = 'transparent';
    }
    activeIndex = next;
    const cur = visible[next]!;
    cur.el.setAttribute('aria-selected', 'true');
    cur.el.style.background = 'var(--sfdt-color-surface-shade)';
    input.setAttribute('aria-activedescendant', cur.el.id);
    cur.el.scrollIntoView({ block: 'nearest' });
  }

  function render(query: string): void {
    while (listbox.firstChild) listbox.removeChild(listbox.firstChild);
    visible = [];

    const sections = filterSections(
      objectSection ? [...syncSections, objectSection] : syncSections,
      query,
    );

    if (sections.length === 0) {
      const empty = doc.createElement('div');
      empty.style.cssText = 'padding: 16px; text-align: center; color: var(--sfdt-color-text-icon);';
      empty.textContent = 'No matching commands';
      listbox.appendChild(empty);
      activeIndex = -1;
      input.removeAttribute('aria-activedescendant');
      return;
    }

    for (const section of sections) {
      const group = doc.createElement('div');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', section.label);

      const heading = doc.createElement('div');
      heading.style.cssText = HEADER_ROW_STYLE;
      heading.textContent = section.label;
      group.appendChild(heading);

      for (const candidate of section.candidates) {
        const option = doc.createElement('div');
        option.id = optionDomId(candidate.id);
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        option.style.cssText = OPTION_STYLE;

        if (candidate.icon) {
          const icon = doc.createElement('span');
          icon.textContent = candidate.icon;
          icon.setAttribute('aria-hidden', 'true');
          option.appendChild(icon);
        }
        const label = doc.createElement('span');
        label.style.flex = '1';
        label.textContent = candidate.label;
        option.appendChild(label);

        // A secondary api-name hint (feature id / object api name) so the
        // accessible name and the visible row both carry the match key.
        if (candidate.apiName && candidate.apiName !== candidate.label) {
          const hint = doc.createElement('span');
          hint.style.cssText = 'font-size: 11px; color: var(--sfdt-color-text-icon);';
          hint.textContent = candidate.apiName;
          option.appendChild(hint);
        }

        const idx = visible.length;
        option.addEventListener('click', () => void execute(candidate));
        option.addEventListener('mousemove', () => {
          if (activeIndex !== idx) setActive(idx);
        });
        group.appendChild(option);
        visible.push({ candidate, el: option });
      }
      listbox.appendChild(group);
    }
    setActive(0);
  }

  async function execute(candidate: PaletteCandidate): Promise<void> {
    const action = candidate.action;
    try {
      switch (action.kind) {
        case 'feature':
          await opts.executors.activateFeature(action.featureId);
          break;
        case 'url':
          opts.executors.navigate(action.url, action.newTab);
          break;
        case 'inspect-record':
          await opts.executors.inspectRecord(action.recordId);
          break;
        case 'object':
          await opts.executors.openObject(action.objectName);
          break;
      }
      await opts.onExecute?.(candidate.id);
    } finally {
      close();
    }
  }

  // Focus trap (checklist item 3): Tab cycles only within [input, closeBtn];
  // options are reached via Arrow keys + aria-activedescendant, not Tab.
  function trapTab(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return;
    const focusables: HTMLElement[] = [input, closeBtn];
    const idx = focusables.indexOf(doc.activeElement as HTMLElement);
    const dir = e.shiftKey ? -1 : 1;
    const nextIdx = ((idx === -1 ? 0 : idx + dir) + focusables.length) % focusables.length;
    e.preventDefault();
    focusables[nextIdx]!.focus();
  }
  card.addEventListener('keydown', trapTab);

  input.addEventListener('input', () => render(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(activeIndex + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(activeIndex - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cur = visible[activeIndex];
      if (cur) void execute(cur.candidate);
    }
  });

  closeBtn.addEventListener('click', () => close());

  // Click-outside dismiss — composedPath() so it works inside the closed shadow
  // root, where e.target is retargeted to the host (checklist item 2 / item 13).
  overlay.addEventListener('click', (e) => {
    if (!e.composedPath().includes(card)) close();
  });

  // Esc closes — capture phase on the document so it fires even if focus somehow
  // sits in a host widget; removed on close so it can't leak (checklist item 1).
  const escHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  doc.addEventListener('keydown', escHandler, true);

  function close(): void {
    if (closed) return;
    closed = true;
    doc.removeEventListener('keydown', escHandler, true);
    overlay.remove();
    previouslyFocused?.focus?.();
  }

  // First paint: mount, render the synchronous sections, focus the input.
  render('');
  mount.appendChild(overlay);
  input.focus();

  // AFTER first paint: kick off the Objects describe. queueMicrotask keeps it off
  // the synchronous open path, so open() itself makes zero api calls (AC-1).
  if (opts.loadObjects) {
    queueMicrotask(async () => {
      try {
        const objects = await opts.loadObjects!();
        if (closed || objects.length === 0) return;
        objectSection = {
          category: 'object',
          label: 'Objects',
          candidates: objects.map((o) => ({
            id: `object:${o.name}`,
            category: 'object',
            label: o.label || o.name,
            apiName: o.name,
            icon: '🗂',
            action: { kind: 'object', objectName: o.name },
          })),
        };
        if (!closed) render(input.value);
      } catch {
        // Objects are best-effort — a describe failure must never break the palette.
      }
    });
  }

  return { close, isOpen: () => !closed };
}
