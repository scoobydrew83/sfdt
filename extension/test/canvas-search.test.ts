import { describe, it, expect, beforeEach } from 'vitest';
import {
  _canvasSearchTestApi,
  createCanvasSearchFeature,
  parseShortcut,
  shortcutMatches,
} from '../features/canvas-search.js';
const { HIGHLIGHT_CLASS, DYNAMIC_STYLE_ID, findMatches } = _canvasSearchTestApi();
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
      expect(document.querySelector('.sfut-canvas-search-bar')).not.toBeNull();
    });
    it('typing into the search bar highlights matching cards (after debounce)', async () => {
      const feature = createCanvasSearchFeature();
      await feature.init?.();
      document.body.appendChild(elementCard('Get Account', 'Get Records'));
      document.body.appendChild(elementCard('Send Email', 'Action'));
      feature.onActivate?.();
      const input = document.querySelector<HTMLInputElement>('.sfut-canvas-search-bar-input')!;
      input.value = 'account';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      const highlighted = document.querySelectorAll(`.${HIGHLIGHT_CLASS}`);
      expect(highlighted).toHaveLength(1);
      expect(document.querySelector('.sfut-canvas-search-bar-count')?.textContent).toBe('1 of 1');
    });
    it('the close button removes the search bar and clears highlights', () => {
      const feature = createCanvasSearchFeature();
      document.body.appendChild(elementCard('A', 'B'));
      feature.onActivate?.();
      document
        .querySelector<HTMLButtonElement>('.sfut-canvas-search-bar-close')!
        .click();
      expect(document.querySelector('.sfut-canvas-search-bar')).toBeNull();
      expect(document.querySelectorAll(`.${HIGHLIGHT_CLASS}`)).toHaveLength(0);
    });
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
    expect(document.getElementById('sfut-canvas-search-dynamic')).not.toBeNull();
    await feature.teardown?.();
    expect(document.getElementById('sfut-canvas-search-dynamic')).toBeNull();
  });
  it('does not throw when called twice', async () => {
    const feature = createCanvasSearchFeature();
    await feature.init?.();
    await feature.teardown?.();
    await expect(feature.teardown?.()).resolves.not.toThrow();
  });
});
