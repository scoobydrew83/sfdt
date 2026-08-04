import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openMenu, attachDismiss, type MenuAction } from '../ui/menu.js';
import { setContentRoot } from '../ui/content-root.js';

function anchor(): HTMLElement {
  const b = document.createElement('button');
  b.textContent = 'anchor';
  document.body.appendChild(b);
  return b;
}

const ITEMS: MenuAction[] = [
  { label: 'Copy Id', iconName: 'clipboard', onSelect: () => {} },
  { label: 'Open in Salesforce', iconName: 'external', separatorBefore: true, onSelect: () => {} },
];

describe('ui/menu', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    setContentRoot(null);
  });
  afterEach(() => setContentRoot(null));

  it('builds menu rows as real buttons with menu semantics', () => {
    // The three hand-rolled menus this replaces rendered <div>s with click
    // handlers — openable, then nothing inside reachable from the keyboard.
    const handle = openMenu({ anchor: anchor(), items: ITEMS });
    expect(handle.element.getAttribute('role')).toBe('menu');
    expect(handle.element.getAttribute('aria-label')).toBeTruthy();
    const rows = handle.element.querySelectorAll('[role="menuitem"]');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.tagName).toBe('BUTTON');
      expect(row.classList.contains('sfdt-nav-item')).toBe(true);
    }
  });

  it('renders labels as text and glyphs as inline SVG', () => {
    const handle = openMenu({
      anchor: anchor(),
      items: [{ label: '<img src=x onerror=alert(1)>', iconName: 'clipboard', onSelect: () => {} }],
    });
    expect(handle.element.querySelector('img')).toBeNull();
    expect(handle.element.querySelector('.sfdt-nav-label')?.textContent).toBe(
      '<img src=x onerror=alert(1)>',
    );
    expect(handle.element.querySelector('svg')).not.toBeNull();
  });

  it('draws a separator only where asked', () => {
    const handle = openMenu({ anchor: anchor(), items: ITEMS });
    // Two rows + one separator.
    expect(handle.element.children).toHaveLength(3);
  });

  it('moves focus to the first command', () => {
    const handle = openMenu({ anchor: anchor(), items: ITEMS });
    expect(document.activeElement).toBe(handle.element.querySelector('[role="menuitem"]'));
  });

  it('closes BEFORE running the action', () => {
    // A handler that opens another overlay would otherwise be torn down by this
    // menu's own dismissal a tick later.
    let openWhenInvoked: boolean | null = null;
    const a = anchor();
    const handle = openMenu({
      anchor: a,
      items: [
        {
          label: 'x',
          iconName: 'clipboard',
          onSelect: () => {
            openWhenInvoked = handle.element.isConnected;
          },
        },
      ],
    });
    handle.element.querySelector<HTMLElement>('[role="menuitem"]')!.click();
    expect(openWhenInvoked).toBe(false);
  });

  it('closes on Esc and returns focus to the anchor', () => {
    const a = anchor();
    const handle = openMenu({ anchor: a, items: ITEMS });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(handle.element.isConnected).toBe(false);
    expect(document.activeElement).toBe(a);
  });

  it('closes on an outside click but not on a click inside', () => {
    const handle = openMenu({ anchor: anchor(), items: ITEMS });
    handle.element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(handle.element.isConnected).toBe(true);
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(handle.element.isConnected).toBe(false);
  });

  it('replaces an already-open menu rather than stacking them', () => {
    const first = openMenu({ anchor: anchor(), items: ITEMS });
    const second = openMenu({ anchor: anchor(), items: ITEMS });
    expect(first.element.isConnected).toBe(false);
    expect(second.element.isConnected).toBe(true);
    expect(document.querySelectorAll('.sfdt-menu-surface')).toHaveLength(1);
  });

  it('close() is idempotent', () => {
    const handle = openMenu({ anchor: anchor(), items: ITEMS });
    handle.close();
    expect(() => handle.close()).not.toThrow();
    expect(handle.element.isConnected).toBe(false);
  });

  it('mounts into the shared content root when one is set', () => {
    // On a Salesforce page injected UI lives in a closed shadow root; a menu
    // appended to document.body would escape it and lose the adopted sheet.
    const root = document.createElement('div');
    document.body.appendChild(root);
    setContentRoot(root);
    const handle = openMenu({ anchor: anchor(), items: ITEMS });
    expect(handle.element.parentElement).toBe(root);
  });

  describe('attachDismiss', () => {
    it('removes BOTH listeners on teardown, whichever path closed it', () => {
      // The leak this replaces: the SOQL cell menu bound a document click
      // listener on every open and removed it only on outside-click, so
      // choosing an item leaked one listener per record Id ever clicked.
      const addSpy = vi.spyOn(document, 'addEventListener');
      const removeSpy = vi.spyOn(document, 'removeEventListener');
      const el = document.createElement('div');
      document.body.appendChild(el);

      const teardown = attachDismiss({ element: el, onDismiss: () => {} });
      const added = addSpy.mock.calls.filter(([type]) => type === 'click' || type === 'keydown');
      expect(added.length).toBe(2);

      teardown();
      const removed = removeSpy.mock.calls.filter(([type]) => type === 'click' || type === 'keydown');
      expect(removed.length).toBe(2);

      // Idempotent — a second teardown must not double-remove or throw.
      teardown();
      expect(
        removeSpy.mock.calls.filter(([type]) => type === 'click' || type === 'keydown').length,
      ).toBe(2);

      addSpy.mockRestore();
      removeSpy.mockRestore();
    });

    it('fires onDismiss once per open, not once per stray click', () => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      const onDismiss = vi.fn();
      attachDismiss({ element: el, onDismiss });

      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('ignores clicks on the trigger, so a toggle does not immediately reopen', () => {
      const el = document.createElement('div');
      const trigger = anchor();
      document.body.appendChild(el);
      const onDismiss = vi.fn();
      attachDismiss({ element: el, trigger, onDismiss });
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(onDismiss).not.toHaveBeenCalled();
    });
  });
});
