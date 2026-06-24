import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { loadSettings, onSettingsChange, registerSettingsShape } from '../lib/settings.js';
import { z } from 'zod';

const CANVAS_SEARCH_SETTINGS_SCHEMA = z.object({
  shortcut: z.string().default('Ctrl+Shift+F'),
  highlightColour: z.string().default('#FFD700'),
});

registerSettingsShape('canvas-search', CANVAS_SEARCH_SETTINGS_SCHEMA);

interface ShortcutParts {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string;
}

interface Match {
  card: Element;
  label: string;
  type: string;
  isBadge?: boolean;
  isToolbox?: boolean;
  toolboxSection?: Element | null;
}

const HIGHLIGHT_CLASS = 'sfdt-canvas-highlight';
const FOCUS_CLASS = 'sfdt-canvas-highlight-focus';
const DYNAMIC_STYLE_ID = 'sfdt-canvas-search-dynamic';

// Salesforce LWC custom-element tags contain underscores
// (e.g. `builder_platform_interaction-alc-canvas`). Real browsers accept these
// in CSS selectors; some DOM emulators (happy-dom >=20) reject them via stricter
// CSS-identifier validation. getElementsByTagName bypasses CSS parsing entirely,
// so route LWC tag lookups through it and apply any inner selector via
// querySelectorAll on each match.
function queryByLwcTag(
  root: Document | Element,
  tagNames: string[],
  innerSelector?: string,
): Element[] {
  const results: Element[] = [];
  for (const tag of tagNames) {
    const matches =
      root instanceof Document || (root as Element).getElementsByTagName
        ? root.getElementsByTagName(tag)
        : [];
    for (const el of Array.from(matches) as Element[]) {
      if (!innerSelector) {
        results.push(el);
      } else {
        for (const inner of el.querySelectorAll(innerSelector)) {
          results.push(inner);
        }
      }
    }
  }
  return results;
}

export function parseShortcut(str: string): ShortcutParts {
  const parts = str.split('+').map((p) => p.trim().toLowerCase());
  return {
    ctrl: parts.includes('ctrl'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
    meta: parts.includes('meta') || parts.includes('cmd'),
    key: parts.filter((p) => !['ctrl', 'shift', 'alt', 'meta', 'cmd'].includes(p))[0] ?? '',
  };
}

export function shortcutMatches(parts: ShortcutParts | null, e: KeyboardEvent): boolean {
  if (!parts) return false;
  return (
    e.ctrlKey === parts.ctrl &&
    e.shiftKey === parts.shift &&
    e.altKey === parts.alt &&
    e.metaKey === parts.meta &&
    e.key.toLowerCase() === parts.key
  );
}

function injectDynamicStyles(doc: Document, colour: string): void {
  doc.getElementById(DYNAMIC_STYLE_ID)?.remove();
  const style = doc.createElement('style');
  style.id = DYNAMIC_STYLE_ID;
  // textContent on a <style> element is treated as CSS text by the parser;
  // it is never parsed as HTML, so no escape pathway is needed.
  style.textContent = `
    .element-card.${HIGHLIGHT_CLASS} .base-card,
    .connector-badge.${HIGHLIGHT_CLASS} {
      box-shadow: 0 0 0 3px ${colour} !important;
      border-color: ${colour} !important;
    }
    .element-card.${FOCUS_CLASS} .base-card,
    .connector-badge.${FOCUS_CLASS} {
      box-shadow: 0 0 0 3px ${colour}, 0 0 12px 4px ${colour}80 !important;
      border-color: ${colour} !important;
    }
  `;
  doc.head.appendChild(style);
}

function findMatches(doc: Document, query: string): Match[] {
  const matches: Match[] = [];
  const lower = query.toLowerCase();
  if (!lower) return matches;

  const cards = doc.querySelectorAll('.element-card');
  for (const card of cards) {
    const labelEl = card.querySelector('span.text-element-label[title]');
    const label = labelEl?.getAttribute('title') ?? '';
    const typeEl = card.querySelector('span.element-type-label[title]');
    const type = typeEl?.getAttribute('title') ?? '';
    if (label.toLowerCase().includes(lower) || type.toLowerCase().includes(lower)) {
      matches.push({ card, label, type });
    }
  }

  const badges = doc.querySelectorAll('.connector-badge span.slds-truncate[title]');
  for (const badge of badges) {
    const text = badge.getAttribute('title') ?? '';
    if (!text.toLowerCase().includes(lower)) continue;
    const container = badge.closest('.connector-badge');
    if (container) matches.push({ card: container, label: text, type: 'Connector', isBadge: true });
  }

  const paletteItems = queryByLwcTag(
    doc,
    ['builder_platform_interaction-left-panel-resources'],
    'tr.palette-item',
  );
  for (const row of paletteItems) {
    const paletteItemEls = queryByLwcTag(
      row,
      ['builder_platform_interaction-palette-item'],
      '.slds-truncate',
    );
    const nameEl = paletteItemEls[0] ?? null;
    const itemName = (nameEl?.textContent ?? '').trim();
    if (!itemName || !itemName.toLowerCase().includes(lower)) continue;
    const section = row.closest('lightning-accordion-section');
    const sectionTitle = section
      ?.querySelector('.slds-accordion__summary-content')
      ?.getAttribute('title');
    matches.push({
      card: row,
      label: itemName,
      type: sectionTitle ?? 'Toolbox',
      isToolbox: true,
      toolboxSection: section ?? null,
    });
  }

  return matches;
}

interface ScrollCanvasOptions {
  doc?: Document;
}

// scrollIntoView doesn't work with the matrix transform on `.flow-container`;
// adjust the translation portion of the matrix directly instead.
export function scrollCanvasToElement(el: Element, options: ScrollCanvasOptions = {}): void {
  const doc = options.doc ?? document;
  const canvas = (queryByLwcTag(
    doc,
    ['builder_platform_interaction-alc-canvas'],
    '.canvas',
  )[0] ?? null) as HTMLElement | null;
  const flowContainer = canvas?.querySelector('.flow-container') as HTMLElement | null;
  if (!canvas || !flowContainer) {
    (el as HTMLElement).scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'center' });
    return;
  }

  const style = flowContainer.style.transform || '';
  let tx = 0;
  let ty = 0;
  let scale = 1;
  const matrixMatch = style.match(/matrix\(([^)]+)\)/);
  if (matrixMatch) {
    const v = matrixMatch[1]!.split(',').map(Number);
    scale = v[0] ?? 1;
    tx = v[4] ?? 0;
    ty = v[5] ?? 0;
  } else {
    const translateMatch = style.match(/translate\(([^,]+),\s*([^)]+)\)/);
    if (translateMatch) {
      tx = parseFloat(translateMatch[1]!) || 0;
      ty = parseFloat(translateMatch[2]!) || 0;
    }
  }

  const elRect = el.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  const dx = canvasRect.left + canvasRect.width / 2 - (elRect.left + elRect.width / 2);
  const dy = canvasRect.top + canvasRect.height / 2 - (elRect.top + elRect.height / 2);

  flowContainer.style.transition = 'transform 0.35s ease';
  flowContainer.style.transform = `matrix(${scale}, 0, 0, ${scale}, ${tx + dx}, ${ty + dy})`;
  setTimeout(() => {
    flowContainer.style.transition = '';
  }, 400);
}

export interface CanvasSearchOptions {
  doc?: Document;
  win?: Window;
}

export function createCanvasSearchFeature(options: CanvasSearchOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;

  let isOpen = false;
  let matches: Match[] = [];
  let currentIndex = -1;
  let highlightColour = '#FFD700';
  let shortcutParts: ShortcutParts | null = null;

  let bar: HTMLDivElement | null = null;
  let input: HTMLInputElement | null = null;
  let countLabel: HTMLSpanElement | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function clearHighlights(): void {
    for (const el of doc.querySelectorAll(`.${HIGHLIGHT_CLASS}`)) {
      el.classList.remove(HIGHLIGHT_CLASS);
      el.classList.remove(FOCUS_CLASS);
    }
  }

  function updateCount(): void {
    if (!countLabel) return;
    if (matches.length === 0) {
      const hasQuery = !!input && input.value.trim().length > 0;
      countLabel.textContent = hasQuery ? 'No matches' : '';
      countLabel.classList.toggle('sfdt-canvas-search-bar-no-results', hasQuery);
    } else {
      countLabel.textContent = `${currentIndex + 1} of ${matches.length}`;
      countLabel.classList.remove('sfdt-canvas-search-bar-no-results');
    }
  }

  function focusMatch(index: number): void {
    const match = matches[index];
    if (!match) return;
    match.card.classList.add(FOCUS_CLASS);

    if (match.isToolbox) {
      const sectionEl = match.toolboxSection?.querySelector('.slds-accordion__section');
      if (sectionEl && !sectionEl.classList.contains('slds-is-open')) {
        const expandBtn = match.toolboxSection?.querySelector<HTMLElement>(
          '.slds-accordion__summary-action',
        );
        expandBtn?.click();
      }
      const leftPanel = doc.querySelector('.left-panel');
      if (leftPanel && !leftPanel.classList.contains('slds-is-open')) {
        const toolboxBtn = doc.querySelector<HTMLElement>('button[title="Show Toolbox"]');
        toolboxBtn?.click();
      }
      (match.card as HTMLElement).scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    } else {
      scrollCanvasToElement(match.card, { doc });
    }
  }

  function navigate(delta: 1 | -1): void {
    if (matches.length === 0) return;
    if (currentIndex >= 0) matches[currentIndex]?.card.classList.remove(FOCUS_CLASS);
    currentIndex = (currentIndex + delta + matches.length) % matches.length;
    focusMatch(currentIndex);
    updateCount();
  }

  function performSearch(query: string): void {
    clearHighlights();
    matches = findMatches(doc, query);
    currentIndex = -1;
    for (const match of matches) match.card.classList.add(HIGHLIGHT_CLASS);
    if (matches.length > 0) {
      currentIndex = 0;
      focusMatch(0);
    }
    updateCount();
  }

  function openSearch(): void {
    if (isOpen) return;
    isOpen = true;
    bar = createOverlay();
    input?.focus();
  }

  function closeSearch(): void {
    if (!isOpen) return;
    isOpen = false;
    clearHighlights();
    matches = [];
    currentIndex = -1;
    bar?.remove();
    bar = null;
    input = null;
    countLabel = null;
  }

  function createOverlay(): HTMLDivElement {
    doc.querySelector('.sfdt-canvas-search-bar')?.remove();

    const container = doc.createElement('div');
    container.className = 'sfdt-canvas-search-bar';

    const icon = doc.createElement('span');
    icon.className = 'sfdt-canvas-search-bar-icon';
    icon.textContent = '🔍';
    container.appendChild(icon);

    const inputEl = doc.createElement('input');
    inputEl.type = 'text';
    inputEl.className = 'sfdt-canvas-search-bar-input';
    inputEl.placeholder = 'Search elements…';
    inputEl.setAttribute('autocomplete', 'off');
    inputEl.setAttribute('spellcheck', 'false');
    container.appendChild(inputEl);

    const prevBtn = doc.createElement('button');
    prevBtn.className = 'sfdt-canvas-search-bar-nav';
    prevBtn.textContent = '▲';
    prevBtn.title = 'Previous match (Shift+Enter)';
    prevBtn.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(-1);
      inputEl.focus();
    });
    container.appendChild(prevBtn);

    const nextBtn = doc.createElement('button');
    nextBtn.className = 'sfdt-canvas-search-bar-nav';
    nextBtn.textContent = '▼';
    nextBtn.title = 'Next match (Enter)';
    nextBtn.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(1);
      inputEl.focus();
    });
    container.appendChild(nextBtn);

    const count = doc.createElement('span');
    count.className = 'sfdt-canvas-search-bar-count';
    container.appendChild(count);

    const closeBtn = doc.createElement('button');
    closeBtn.className = 'sfdt-canvas-search-bar-close';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close (Escape)';
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      closeSearch();
    });
    container.appendChild(closeBtn);

    inputEl.addEventListener('input', () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => performSearch(inputEl.value.trim()), 150);
    });

    const canvasHost =
      (queryByLwcTag(doc, [
        'builder_platform_interaction-alc-canvas-container',
        'builder_platform_interaction-alc-canvas',
      ])[0] as HTMLElement | undefined) ?? doc.body;
    if (canvasHost !== doc.body) {
      canvasHost.style.position = canvasHost.style.position || 'relative';
    }
    canvasHost.appendChild(container);

    input = inputEl;
    countLabel = count;
    return container;
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (shortcutMatches(shortcutParts, e)) {
      e.preventDefault();
      e.stopPropagation();
      if (isOpen) {
        input?.focus();
        input?.select();
      } else {
        openSearch();
      }
      return;
    }
    if (!isOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeSearch();
      return;
    }
    if (e.key === 'Enter' || (e.key === 'ArrowDown' && e.target === input)) {
      e.preventDefault();
      e.stopPropagation();
      navigate(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === 'ArrowUp' && e.target === input) {
      e.preventDefault();
      e.stopPropagation();
      navigate(-1);
    }
  }

  let boundKeydownListener: ((e: KeyboardEvent) => void) | null = null;
  let unsubscribeSettings: (() => void) | null = null;

  async function teardown(): Promise<void> {
    try {
      closeSearch();
    } catch {
      // closeSearch is defensive; ignore failure paths.
    }
    doc.getElementById(DYNAMIC_STYLE_ID)?.remove();
    if (boundKeydownListener) {
      doc.removeEventListener('keydown', boundKeydownListener, true);
      boundKeydownListener = null;
    }
    if (unsubscribeSettings) {
      unsubscribeSettings();
      unsubscribeSettings = null;
    }
  }

  return {
    manifest: {
      id: 'canvas-search',
      name: 'Search & Highlight',
      contexts: [CONTEXTS.FLOW_BUILDER],
      settingsSchema: CANVAS_SEARCH_SETTINGS_SCHEMA,
    },

    async init() {
      if (detectContext({ location: { href: win.location.href } }, doc) !== CONTEXTS.FLOW_BUILDER) {
        return;
      }
      type CanvasConfig = z.infer<typeof CANVAS_SEARCH_SETTINGS_SCHEMA>;
      const settings = await loadSettings();
      const canvasConfig = (settings.featureSettings?.['canvas-search'] ?? settings.canvasSearch) as CanvasConfig;
      highlightColour = canvasConfig.highlightColour;
      shortcutParts = parseShortcut(canvasConfig.shortcut);
      injectDynamicStyles(doc, highlightColour);
      boundKeydownListener = onKeyDown;
      doc.addEventListener('keydown', boundKeydownListener, true);

      unsubscribeSettings = onSettingsChange((next) => {
        const nextCanvasConfig = (next.featureSettings?.['canvas-search'] ?? next.canvasSearch) as CanvasConfig;
        if (nextCanvasConfig.highlightColour !== highlightColour) {
          highlightColour = nextCanvasConfig.highlightColour;
          injectDynamicStyles(doc, highlightColour);
        }
        shortcutParts = parseShortcut(nextCanvasConfig.shortcut);
      });
    },

    onActivate() {
      openSearch();
    },

    teardown,
  };
}

export function _canvasSearchTestApi() {
  return { HIGHLIGHT_CLASS, FOCUS_CLASS, DYNAMIC_STYLE_ID, findMatches };
}
