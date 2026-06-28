import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  _canvasSearchTestApi,
  createCanvasSearchFeature,
  parseShortcut,
  scrollCanvasToElement,
  shortcutMatches,
} from '../features/canvas-search.js';
import { patchSettings } from '../lib/settings.js';

const { HIGHLIGHT_CLASS, FOCUS_CLASS, DYNAMIC_STYLE_ID, findMatches } = _canvasSearchTestApi();

// Builds the Flow Builder toolbox palette structure findMatches/focusMatch walk:
// left-panel-resources → accordion-section → tr.palette-item → palette-item → .slds-truncate.
function toolboxPanel(name: string, sectionTitle: string): HTMLElement {
  const panel = document.createElement('builder_platform_interaction-left-panel-resources');
  const section = document.createElement('lightning-accordion-section');

  const summary = document.createElement('div');
  summary.className = 'slds-accordion__summary-content';
  summary.setAttribute('title', sectionTitle);
  section.appendChild(summary);

  // A collapsed accordion section (no slds-is-open) with an expand action so
  // focusMatch's expand branch runs.
  const accSection = document.createElement('div');
  accSection.className = 'slds-accordion__section';
  const expandBtn = document.createElement('button');
  expandBtn.className = 'slds-accordion__summary-action';
  accSection.appendChild(expandBtn);
  section.appendChild(accSection);

  const row = document.createElement('tr');
  row.className = 'palette-item';
  const item = document.createElement('builder_platform_interaction-palette-item');
  const nameEl = document.createElement('span');
  nameEl.className = 'slds-truncate';
  nameEl.textContent = name;
  item.appendChild(nameEl);
  row.appendChild(item);
  section.appendChild(row);

  panel.appendChild(section);
  return panel;
}

// Builds the alc-canvas → .canvas → .flow-container chain scrollCanvasToElement walks.
function canvasWithTransform(transform: string): HTMLElement {
  const host = document.createElement('builder_platform_interaction-alc-canvas');
  const canvas = document.createElement('div');
  canvas.className = 'canvas';
  const flow = document.createElement('div');
  flow.className = 'flow-container';
  flow.style.transform = transform;
  canvas.appendChild(flow);
  host.appendChild(canvas);
  return host;
}

function elementCard(label: string, type: string): HTMLElement {
  const tpl = document.createElement('builder_platform_interaction-alc-element-card-template');
  const card = document.createElement('div');
  card.className = 'element-card';
  const lbl = document.createElement('span');
  lbl.className = 'text-element-label';
  lbl.setAttribute('title', label);
  card.appendChild(lbl);
  const t = document.createElement('span');
  t.className = 'element-type-label';
  t.setAttribute('title', type);
  card.appendChild(t);
  // Add the .base-card child so the CSS rule has a target.
  const base = document.createElement('div');
  base.className = 'base-card';
  card.appendChild(base);
  tpl.appendChild(card);
  return tpl;
}

function connectorBadge(text: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'connector-badge';
  const span = document.createElement('span');
  span.className = 'slds-truncate';
  span.setAttribute('title', text);
  wrap.appendChild(span);
  return wrap;
}

function flowBuilderHash(): void {
  history.replaceState(
    null,
    '',
    '/builder_platform_interaction/flowBuilder.app?flowId=1',
  );
}

beforeEach(() => {
  document.body.replaceChildren();
  document.head.querySelector(`#${DYNAMIC_STYLE_ID}`)?.remove();
});

describe('extension/features/canvas-search', () => {
  describe('parseShortcut + shortcutMatches', () => {
    it('parses Ctrl+Shift+F', () => {
      const parts = parseShortcut('Ctrl+Shift+F');
      expect(parts).toEqual({ ctrl: true, shift: true, alt: false, meta: false, key: 'f' });
    });

    it('accepts Cmd as a Meta synonym', () => {
      expect(parseShortcut('Cmd+K').meta).toBe(true);
    });

    it('matches the configured event modifiers and key', () => {
      const parts = parseShortcut('Ctrl+Shift+F');
      const event = new KeyboardEvent('keydown', {
        key: 'F',
        ctrlKey: true,
        shiftKey: true,
      });
      expect(shortcutMatches(parts, event)).toBe(true);
    });

    it('rejects an event missing a required modifier', () => {
      const parts = parseShortcut('Ctrl+Shift+F');
      const event = new KeyboardEvent('keydown', { key: 'F', ctrlKey: true });
      expect(shortcutMatches(parts, event)).toBe(false);
    });

    it('returns false when parts is null', () => {
      expect(shortcutMatches(null, new KeyboardEvent('keydown', { key: 'F' }))).toBe(false);
    });
  });

  describe('findMatches', () => {
    it('returns element cards whose label or type contains the query', () => {
      document.body.appendChild(elementCard('Get Account', 'Get Records'));
      document.body.appendChild(elementCard('Send Email', 'Action'));
      expect(findMatches(document, 'account').map((m: { label: string }) => m.label)).toEqual([
        'Get Account',
      ]);
      expect(findMatches(document, 'action').map((m: { label: string }) => m.label)).toEqual([
        'Send Email',
      ]);
    });

    it('matches connector badges by title text', () => {
      document.body.appendChild(connectorBadge('Approved'));
      const result = findMatches(document, 'approve');
      expect(result).toHaveLength(1);
      expect(result[0]!.isBadge).toBe(true);
    });

    it('returns an empty array when the query is empty', () => {
      document.body.appendChild(elementCard('Get Account', 'Get Records'));
      expect(findMatches(document, '')).toEqual([]);
    });

    it('is case-insensitive on label and type', () => {
      document.body.appendChild(elementCard('GetAccount', 'GetRecords'));
      expect(findMatches(document, 'GETACC')).toHaveLength(1);
    });
  });

  describe('feature lifecycle', () => {
    beforeEach(() => {
      flowBuilderHash();
    });

    it('init injects the dynamic stylesheet only when on Flow Builder', async () => {
      const feature = createCanvasSearchFeature();
      await feature.init?.();
      expect(document.getElementById(DYNAMIC_STYLE_ID)).not.toBeNull();
    });

    it('init is a no-op outside Flow Builder', async () => {
      history.replaceState(null, '', '/lightning/setup/Flows/home');
      const feature = createCanvasSearchFeature();
      await feature.init?.();
      expect(document.getElementById(DYNAMIC_STYLE_ID)).toBeNull();
    });

    it('onActivate mounts the search bar', () => {
      const feature = createCanvasSearchFeature();
      feature.onActivate?.();
      expect(document.querySelector('.sfdt-canvas-search-bar')).not.toBeNull();
    });

    it('typing into the search bar highlights matching cards (after debounce)', async () => {
      const feature = createCanvasSearchFeature();
      await feature.init?.();
      document.body.appendChild(elementCard('Get Account', 'Get Records'));
      document.body.appendChild(elementCard('Send Email', 'Action'));
      feature.onActivate?.();

      const input = document.querySelector<HTMLInputElement>('.sfdt-canvas-search-bar-input')!;
      input.value = 'account';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));

      const highlighted = document.querySelectorAll(`.${HIGHLIGHT_CLASS}`);
      expect(highlighted).toHaveLength(1);
      expect(document.querySelector('.sfdt-canvas-search-bar-count')?.textContent).toBe('1 of 1');
    });

    it('the close button removes the search bar and clears highlights', () => {
      const feature = createCanvasSearchFeature();
      document.body.appendChild(elementCard('A', 'B'));
      feature.onActivate?.();
      document
        .querySelector<HTMLButtonElement>('.sfdt-canvas-search-bar-close')!
        .click();
      expect(document.querySelector('.sfdt-canvas-search-bar')).toBeNull();
      expect(document.querySelectorAll(`.${HIGHLIGHT_CLASS}`)).toHaveLength(0);
    });
  });
});

describe('extension/features/canvas-search — findMatches extras', () => {
  it('skips connector badges that do not match the query', () => {
    document.body.appendChild(connectorBadge('Rejected'));
    expect(findMatches(document, 'approve')).toEqual([]);
  });

  it('matches toolbox palette items and reports the accordion section title', () => {
    document.body.appendChild(toolboxPanel('Decision', 'Logic'));
    const result = findMatches(document, 'decision');
    expect(result).toHaveLength(1);
    expect(result[0]!.isToolbox).toBe(true);
    expect(result[0]!.label).toBe('Decision');
    expect(result[0]!.type).toBe('Logic');
  });

  it('falls back to a default toolbox type when no section title is present', () => {
    const panel = toolboxPanel('Assignment', 'ignored');
    panel.querySelector('.slds-accordion__summary-content')?.removeAttribute('title');
    document.body.appendChild(panel);
    expect(findMatches(document, 'assignment')[0]!.type).toBe('Toolbox');
  });
});

describe('extension/features/canvas-search — scrollCanvasToElement', () => {
  it('falls back to scrollIntoView when no canvas is present', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    expect(() => scrollCanvasToElement(el)).not.toThrow();
  });

  it('adjusts an existing matrix transform on the flow container', () => {
    const host = canvasWithTransform('matrix(2, 0, 0, 2, 10, 20)');
    document.body.appendChild(host);
    const el = document.createElement('div');
    document.body.appendChild(el);
    scrollCanvasToElement(el, { doc: document });
    // getBoundingClientRect is all-zero under happy-dom, so dx/dy are 0 and the
    // existing translation/scale survive the rewrite.
    expect(host.querySelector<HTMLElement>('.flow-container')!.style.transform).toBe(
      'matrix(2, 0, 0, 2, 10, 20)',
    );
  });

  it('parses a translate() transform when no matrix is present', () => {
    const host = canvasWithTransform('translate(5px, 6px)');
    document.body.appendChild(host);
    const el = document.createElement('div');
    document.body.appendChild(el);
    scrollCanvasToElement(el, { doc: document });
    expect(host.querySelector<HTMLElement>('.flow-container')!.style.transform).toBe(
      'matrix(1, 0, 0, 1, 5, 6)',
    );
  });
});

describe('extension/features/canvas-search — search + navigation handlers', () => {
  // Each feature attaches a capturing keydown listener + settings subscription to
  // `document`; without teardown they accumulate and stale features react to
  // shortcuts fired by later tests. Track and tear down every feature created.
  const created: Array<ReturnType<typeof createCanvasSearchFeature>> = [];

  function makeFeature() {
    const feature = createCanvasSearchFeature();
    created.push(feature);
    return feature;
  }

  beforeEach(() => {
    flowBuilderHash();
  });

  afterEach(async () => {
    while (created.length) await created.pop()?.teardown?.();
  });

  function fireShortcut(): void {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true, bubbles: true }),
    );
  }

  async function openAndSearch(query: string) {
    const feature = makeFeature();
    await feature.init?.();
    document.body.appendChild(elementCard('Get Account', 'Get Records'));
    document.body.appendChild(elementCard('Get Contact', 'Get Records'));
    fireShortcut();
    const input = document.querySelector<HTMLInputElement>('.sfdt-canvas-search-bar-input')!;
    input.value = query;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    return { feature, input };
  }

  it('the keyboard shortcut opens the search bar', async () => {
    const feature = makeFeature();
    await feature.init?.();
    expect(document.querySelector('.sfdt-canvas-search-bar')).toBeNull();
    fireShortcut();
    expect(document.querySelector('.sfdt-canvas-search-bar')).not.toBeNull();
  });

  it('Enter and Shift+Enter cycle through matches with wraparound', async () => {
    await openAndSearch('get');
    const count = () => document.querySelector('.sfdt-canvas-search-bar-count')?.textContent;
    expect(count()).toBe('1 of 2');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(count()).toBe('2 of 2');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(count()).toBe('1 of 2'); // wrapped
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    expect(count()).toBe('2 of 2'); // back
  });

  it('ArrowDown / ArrowUp on the input navigate matches', async () => {
    const { input } = await openAndSearch('get');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.querySelector('.sfdt-canvas-search-bar-count')?.textContent).toBe('2 of 2');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.querySelector('.sfdt-canvas-search-bar-count')?.textContent).toBe('1 of 2');
  });

  it('the prev/next nav buttons navigate matches', async () => {
    await openAndSearch('get');
    document.querySelectorAll<HTMLButtonElement>('.sfdt-canvas-search-bar-nav')[1]!.click(); // next
    expect(document.querySelector('.sfdt-canvas-search-bar-count')?.textContent).toBe('2 of 2');
    document.querySelectorAll<HTMLButtonElement>('.sfdt-canvas-search-bar-nav')[0]!.click(); // prev
    expect(document.querySelector('.sfdt-canvas-search-bar-count')?.textContent).toBe('1 of 2');
  });

  it('shows "No matches" and clears prior highlights on a re-search', async () => {
    const { input } = await openAndSearch('get');
    expect(document.querySelectorAll(`.${HIGHLIGHT_CLASS}`)).toHaveLength(2);
    input.value = 'zzz';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    expect(document.querySelectorAll(`.${HIGHLIGHT_CLASS}`)).toHaveLength(0);
    expect(document.querySelector('.sfdt-canvas-search-bar-count')?.textContent).toBe('No matches');
  });

  it('Escape closes the search bar', async () => {
    await openAndSearch('get');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.sfdt-canvas-search-bar')).toBeNull();
  });

  it('re-firing the shortcut while open refocuses the input instead of reopening', async () => {
    const { input } = await openAndSearch('get');
    const before = document.querySelectorAll('.sfdt-canvas-search-bar').length;
    fireShortcut();
    expect(document.querySelectorAll('.sfdt-canvas-search-bar').length).toBe(before);
    expect(document.activeElement === input || document.querySelector('.sfdt-canvas-search-bar')).toBeTruthy();
  });

  it('onActivate is a no-op when the bar is already open', () => {
    const feature = makeFeature();
    feature.onActivate?.();
    feature.onActivate?.();
    expect(document.querySelectorAll('.sfdt-canvas-search-bar')).toHaveLength(1);
  });

  it('focusing a toolbox match does not throw and highlights the row', async () => {
    const feature = makeFeature();
    await feature.init?.();
    document.body.appendChild(toolboxPanel('Decision', 'Logic'));
    const leftPanel = document.createElement('div');
    leftPanel.className = 'left-panel';
    const toolboxBtn = document.createElement('button');
    toolboxBtn.setAttribute('title', 'Show Toolbox');
    leftPanel.appendChild(toolboxBtn);
    document.body.appendChild(leftPanel);

    fireShortcut();
    const input = document.querySelector<HTMLInputElement>('.sfdt-canvas-search-bar-input')!;
    input.value = 'decision';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));

    expect(document.querySelector(`tr.palette-item.${FOCUS_CLASS}`)).not.toBeNull();
  });

  it('re-injects the stylesheet with a new colour on a settings change', async () => {
    const feature = makeFeature();
    await feature.init?.();
    expect(document.getElementById(DYNAMIC_STYLE_ID)?.textContent).toContain('#FFD700');
    await patchSettings({ canvasSearch: { shortcut: 'Ctrl+K', highlightColour: '#00FF00' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById(DYNAMIC_STYLE_ID)?.textContent).toContain('#00FF00');
  });
});

describe('canvas-search teardown', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.head.replaceChildren();
    history.replaceState(
      null,
      '',
      '/builder_platform_interaction/flowBuilder.app?flowId=1',
    );
    chrome.storage.local.clear();
  });

  it('removes the dynamic style element', async () => {
    const feature = createCanvasSearchFeature();
    await feature.init?.();
    expect(document.getElementById('sfdt-canvas-search-dynamic')).not.toBeNull();
    await feature.teardown?.();
    expect(document.getElementById('sfdt-canvas-search-dynamic')).toBeNull();
  });

  it('does not throw when called twice', async () => {
    const feature = createCanvasSearchFeature();
    await feature.init?.();
    await feature.teardown?.();
    await expect(feature.teardown?.()).resolves.not.toThrow();
  });
});
