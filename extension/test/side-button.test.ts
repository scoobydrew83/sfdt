import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mountSideButton, type MenuItem } from '../ui/side-button.js';

function resetDom(): void {
  // Use replaceChildren() rather than the innerHTML setter so the test file
  // contains no innerHTML usage (the security-review hook flags any source
  // file that touches that property, even in test setup).
  document.body.replaceChildren();
}

describe('extension/ui/side-button', () => {
  beforeEach(() => {
    resetDom();
  });

  it('mounts the button and menu in document.body', () => {
    const handle = mountSideButton({
      menuItemsProvider: () => [],
      handlers: { onActivate: vi.fn(), onOpenSettings: vi.fn() },
    });
    expect(document.getElementById('sfdt-side-button')).not.toBeNull();
    expect(document.getElementById('sfdt-menu')).not.toBeNull();
    expect(handle.isMounted()).toBe(true);
  });

  it('shows the empty state when no menu items are returned', () => {
    mountSideButton({
      menuItemsProvider: () => [],
      handlers: { onActivate: vi.fn(), onOpenSettings: vi.fn() },
    });
    expect(document.querySelector('.sfdt-menu-empty')?.textContent).toContain(
      'No tools available',
    );
  });

  it('renders one menu item per provided MenuItem', () => {
    const items: MenuItem[] = [
      { featureId: 'flow-health-check', iconName: 'heart', label: 'Run Health Check' },
      { featureId: 'setup-tabs', iconName: 'panel', label: 'Setup Tabs' },
    ];
    mountSideButton({
      menuItemsProvider: () => items,
      handlers: { onActivate: vi.fn(), onOpenSettings: vi.fn() },
    });
    const nodes = document.querySelectorAll('.sfdt-menu-item');
    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.textContent).toContain('Run Health Check');
    expect(nodes[1]!.textContent).toContain('Setup Tabs');
  });

  it('opens the menu when the button is clicked', () => {
    mountSideButton({
      menuItemsProvider: () => [],
      handlers: { onActivate: vi.fn(), onOpenSettings: vi.fn() },
    });
    const button = document.getElementById('sfdt-side-button')!;
    const menu = document.getElementById('sfdt-menu')!;
    expect((menu as HTMLElement).style.display).toBe('none');
    button.click();
    expect((menu as HTMLElement).style.display).toBe('block');
  });

  it('escapes labels and icons — XSS-safe by construction', () => {
    mountSideButton({
      menuItemsProvider: () => [
        {
          featureId: 'evil',
          iconName: '<img src=x onerror=alert(1)>',
          label: '<script>alert(2)</script>',
        },
      ],
      handlers: { onActivate: vi.fn(), onOpenSettings: vi.fn() },
    });
    // textContent is the only way labels reach the DOM, so any injected HTML
    // is rendered as literal text. There should be no <img> or <script>
    // elements produced from those strings.
    expect(document.querySelector('.sfdt-menu-item img')).toBeNull();
    expect(document.querySelector('.sfdt-menu-item script')).toBeNull();
    expect(document.querySelector('.sfdt-menu-item-label')?.textContent).toBe(
      '<script>alert(2)</script>',
    );
    // `iconName` is a lookup key, not text and not markup: an unknown value
    // resolves to the neutral fallback glyph, so a hostile string produces an
    // <svg><circle> and nothing else.
    const glyph = document.querySelector('.sfdt-menu-item-icon svg');
    expect(glyph).not.toBeNull();
    expect(glyph!.children).toHaveLength(1);
    expect(glyph!.firstElementChild!.tagName).toBe('circle');
  });

  it('clicking a menu item dispatches onActivate with the item info', () => {
    const onActivate = vi.fn();
    mountSideButton({
      menuItemsProvider: () => [{ featureId: 'flow-health-check', iconName: 'heart', label: 'Run' }],
      handlers: { onActivate, onOpenSettings: vi.fn() },
    });
    document.getElementById('sfdt-side-button')!.click();
    document.querySelector<HTMLElement>('.sfdt-menu-item')!.click();
    expect(onActivate).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: 'flow-health-check', action: 'activate' }),
    );
  });

  it('clicking the settings link dispatches onOpenSettings and closes the menu', () => {
    const onOpenSettings = vi.fn();
    mountSideButton({
      menuItemsProvider: () => [],
      handlers: { onActivate: vi.fn(), onOpenSettings },
    });
    document.getElementById('sfdt-side-button')!.click();
    document.getElementById('sfdt-settings-link')!.click();
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect((document.getElementById('sfdt-menu') as HTMLElement).style.display).toBe('none');
  });

  it('destroy() removes the button and menu from the DOM', () => {
    const handle = mountSideButton({
      menuItemsProvider: () => [],
      handlers: { onActivate: vi.fn(), onOpenSettings: vi.fn() },
    });
    handle.destroy();
    expect(document.getElementById('sfdt-side-button')).toBeNull();
    expect(document.getElementById('sfdt-menu')).toBeNull();
    expect(handle.isMounted()).toBe(false);
  });

  it('does not render when running in a sub-frame', () => {
    // Simulate a sub-frame by passing a window where top !== self.
    const fakeWin = { top: {}, self: {} } as unknown as Window;
    const handle = mountSideButton({
      win: fakeWin,
      menuItemsProvider: () => [],
      handlers: { onActivate: vi.fn(), onOpenSettings: vi.fn() },
    });
    expect(handle.isMounted()).toBe(false);
    expect(document.getElementById('sfdt-side-button')).toBeNull();
  });

  // The launcher and every menu row were <div>s with click handlers, so the
  // entire injected tool menu was mouse-only — you could not reach it, open it,
  // or activate anything in it from the keyboard.
  describe('keyboard path', () => {
    const ITEMS: MenuItem[] = [
      { featureId: 'flow-health-check', iconName: 'heart', label: 'Run Health Check' },
      { featureId: 'setup-tabs', iconName: 'panel', label: 'Setup Tabs' },
    ];

    function mount() {
      const onOpenSettings = vi.fn();
      const handle = mountSideButton({
        menuItemsProvider: () => ITEMS,
        handlers: { onActivate: vi.fn(), onOpenSettings },
      });
      return { handle, onOpenSettings };
    }

    it('the launcher, the rows, close and Settings are all real buttons', () => {
      mount();
      expect(document.getElementById('sfdt-side-button')?.tagName).toBe('BUTTON');
      expect(document.getElementById('sfdt-settings-link')?.tagName).toBe('BUTTON');
      expect(document.querySelector('.sfdt-menu-close')?.tagName).toBe('BUTTON');
      for (const row of document.querySelectorAll('.sfdt-menu-item')) {
        expect(row.tagName).toBe('BUTTON');
      }
    });

    it('the launcher announces itself as a menu trigger and tracks open state', () => {
      const { handle } = mount();
      const button = document.getElementById('sfdt-side-button')!;
      expect(button.getAttribute('aria-haspopup')).toBe('menu');
      expect(button.getAttribute('aria-controls')).toBe('sfdt-menu');
      expect(button.getAttribute('aria-label')).toBeTruthy();
      expect(button.getAttribute('aria-expanded')).toBe('false');

      handle.open();
      expect(button.getAttribute('aria-expanded')).toBe('true');
      button.click();
      expect(button.getAttribute('aria-expanded')).toBe('false');
    });

    it('moves focus to the first command on open', () => {
      const { handle } = mount();
      handle.open();
      expect(document.activeElement).toBe(document.querySelector('.sfdt-menu-item'));
    });

    it('Esc closes the menu and returns focus to the launcher', () => {
      const { handle } = mount();
      handle.open();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect((document.getElementById('sfdt-menu') as HTMLElement).style.display).toBe('none');
      expect(document.activeElement).toBe(document.getElementById('sfdt-side-button'));
    });

    it('ignores Esc while the menu is closed', () => {
      mount();
      const onOther = vi.fn();
      document.addEventListener('keydown', onOther);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      // The handler stops propagation only when it actually closes something, so
      // a closed menu must not swallow Esc from the host Salesforce page.
      expect(onOther).toHaveBeenCalled();
      document.removeEventListener('keydown', onOther);
    });

    it('unbinds the key handler on destroy', () => {
      const { handle } = mount();
      handle.open();
      handle.destroy();
      // Must not throw against removed nodes.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(document.getElementById('sfdt-menu')).toBeNull();
    });
  });
});
