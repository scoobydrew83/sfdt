import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openCommandPalette, type CommandPaletteHandle } from '../ui/command-palette.js';
import type { FeatureGate, PaletteSourceInputs } from '../lib/palette-sources.js';
import { BASE_TABS } from '../lib/setup-links.js';

const ICONS = {
  'soql-runner': { icon: '🗂', label: 'SOQL Query Runner' },
  'org-limits': { icon: '🚦', label: 'Org Limits' },
  'inspect-record': { icon: '🔍', label: 'Inspect Record' },
  'ai-assistant': { icon: '🤖', label: 'Flow AI Assistant' },
};

function gate(overrides: Partial<FeatureGate> = {}): FeatureGate {
  return {
    available: ['soql-runner'],
    isRegistered: () => true,
    disabledRemote: new Set(),
    isEnabled: () => true,
    ...overrides,
  };
}

function inputs(overrides: Partial<PaletteSourceInputs> = {}): PaletteSourceInputs {
  return {
    gate: gate(),
    featureIcons: ICONS,
    setupLinks: BASE_TABS,
    hostname: 'x.lightning.force.com',
    ...overrides,
  };
}

function noopExecutors() {
  return {
    activateFeature: vi.fn(),
    navigate: vi.fn(),
    inspectRecord: vi.fn(),
    openObject: vi.fn(),
  };
}

function overlay(): HTMLElement | null {
  return document.getElementById('sfdt-command-palette');
}
function searchInput(): HTMLInputElement {
  return overlay()!.querySelector('input')!;
}
function options(): HTMLElement[] {
  return Array.from(overlay()!.querySelectorAll('[role="option"]'));
}
function optionLabels(): string[] {
  return options().map((o) => o.textContent ?? '');
}
function key(el: EventTarget, k: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('extension/ui/command-palette', () => {
  let handle: CommandPaletteHandle | null = null;

  beforeEach(() => {
    document.body.replaceChildren();
  });
  afterEach(() => {
    handle?.close();
    handle = null;
  });

  // --- AC-1: no network on open; Objects come after an awaited describe ---
  describe('AC-1 — no api/network on open', () => {
    it('does not call loadObjects (the api seam) before first render', () => {
      const loadObjects = vi.fn().mockResolvedValue([]);
      handle = openCommandPalette({
        sourceInputs: inputs(),
        loadObjects,
        executors: noopExecutors(),
      });
      // Synchronously after open, the palette is painted but the describe seam
      // has not been touched.
      expect(overlay()).not.toBeNull();
      expect(loadObjects).not.toHaveBeenCalled();
    });

    it('fills the Objects section only after loadObjects resolves', async () => {
      const loadObjects = vi
        .fn()
        .mockResolvedValue([{ name: 'Account', label: 'Account' }]);
      handle = openCommandPalette({
        sourceInputs: inputs(),
        loadObjects,
        executors: noopExecutors(),
      });
      // No Objects group before the async describe resolves.
      expect(overlay()!.querySelector('[role="group"][aria-label="Objects"]')).toBeNull();

      await flush();

      expect(loadObjects).toHaveBeenCalledTimes(1);
      const objectsGroup = overlay()!.querySelector('[role="group"][aria-label="Objects"]');
      expect(objectsGroup).not.toBeNull();
      expect(optionLabels().some((l) => l.includes('Account'))).toBe(true);
    });
  });

  // --- AC-2: keyboard-first overlay ---
  describe('AC-2 — keyboard & a11y contract', () => {
    it('renders a labelled listbox of options and focuses the input on open', () => {
      handle = openCommandPalette({ sourceInputs: inputs(), executors: noopExecutors() });
      const list = overlay()!.querySelector('[role="listbox"]');
      expect(list).not.toBeNull();
      expect(options().length).toBeGreaterThan(0);
      // Every option carries an accessible name (its label text).
      expect(options().every((o) => (o.textContent ?? '').trim().length > 0)).toBe(true);
      expect(document.activeElement).toBe(searchInput());
    });

    it('filters the options as the query is typed', () => {
      handle = openCommandPalette({
        sourceInputs: inputs({ gate: gate({ available: ['soql-runner', 'org-limits'] }) }),
        executors: noopExecutors(),
      });
      const input = searchInput();
      input.value = 'soql';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const labels = optionLabels();
      expect(labels.some((l) => l.includes('SOQL Query Runner'))).toBe(true);
      expect(labels.some((l) => l.includes('Org Limits'))).toBe(false);
    });

    it('moves aria-activedescendant with the arrow keys', () => {
      handle = openCommandPalette({
        sourceInputs: inputs({ gate: gate({ available: ['soql-runner', 'org-limits'] }) }),
        executors: noopExecutors(),
      });
      const input = searchInput();
      const first = input.getAttribute('aria-activedescendant');
      expect(first).toBeTruthy();
      key(input, 'ArrowDown');
      const second = input.getAttribute('aria-activedescendant');
      expect(second).toBeTruthy();
      expect(second).not.toBe(first);
      // The active option reflects selection state, not colour alone.
      expect(overlay()!.querySelector(`#${second}`)!.getAttribute('aria-selected')).toBe('true');
    });

    it('executes the active option on Enter and closes', async () => {
      const executors = noopExecutors();
      handle = openCommandPalette({
        sourceInputs: inputs({ gate: gate({ available: ['soql-runner'] }) }),
        executors,
      });
      key(searchInput(), 'Enter');
      expect(executors.activateFeature).toHaveBeenCalledWith('soql-runner');
      await flush(); // execute() awaits the action, so close() lands next tick
      expect(overlay()).toBeNull();
    });

    it('records the executed candidate for recent-first ordering', async () => {
      const onExecute = vi.fn();
      handle = openCommandPalette({
        sourceInputs: inputs({ gate: gate({ available: ['soql-runner'] }) }),
        executors: noopExecutors(),
        onExecute,
      });
      key(searchInput(), 'Enter');
      await flush();
      expect(onExecute).toHaveBeenCalledWith('feature:soql-runner');
    });

    it('closes on Esc and restores focus to the pre-open element', () => {
      const trigger = document.createElement('button');
      document.body.appendChild(trigger);
      trigger.focus();
      expect(document.activeElement).toBe(trigger);

      handle = openCommandPalette({ sourceInputs: inputs(), executors: noopExecutors() });
      expect(document.activeElement).toBe(searchInput());

      key(document, 'Escape');
      expect(overlay()).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
  });

  // --- AC-3: disabled / kill-switched features are absent ---
  describe('AC-3 — gating is enforced (via buildPaletteSources)', () => {
    it('omits a user-disabled and a kill-switched feature; keeps the enabled one', () => {
      handle = openCommandPalette({
        sourceInputs: inputs({
          gate: gate({
            available: ['soql-runner', 'org-limits', 'inspect-record'],
            disabledRemote: new Set(['inspect-record']), // kill-switched
            isEnabled: (id) => id !== 'org-limits', // user-disabled
          }),
        }),
        executors: noopExecutors(),
      });
      const labels = optionLabels();
      expect(labels.some((l) => l.includes('SOQL Query Runner'))).toBe(true);
      expect(labels.some((l) => l.includes('Org Limits'))).toBe(false);
      expect(labels.some((l) => l.includes('Inspect Record'))).toBe(false);
    });
  });

  // --- AC-6: the palette reflects the current context's feature set ---
  describe('AC-6 — per-context feature listing', () => {
    it('lists the FLOW_BUILDER feature set', () => {
      handle = openCommandPalette({
        sourceInputs: inputs({ gate: gate({ available: ['ai-assistant'] }) }),
        executors: noopExecutors(),
      });
      const labels = optionLabels();
      expect(labels.some((l) => l.includes('Flow AI Assistant'))).toBe(true);
      expect(labels.some((l) => l.includes('Inspect Record'))).toBe(false);
    });

    it('lists the RECORD_PAGE feature set', () => {
      handle = openCommandPalette({
        sourceInputs: inputs({ gate: gate({ available: ['inspect-record'] }) }),
        executors: noopExecutors(),
      });
      const labels = optionLabels();
      expect(labels.some((l) => l.includes('Inspect Record'))).toBe(true);
      expect(labels.some((l) => l.includes('Flow AI Assistant'))).toBe(false);
    });
  });
});
