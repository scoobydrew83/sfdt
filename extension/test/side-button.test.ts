import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mountSideButton, type MenuItem } from '../ui/side-button.js';
function resetDom(): void {
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
    expect(document.getElementById('sfut-side-button')).not.toBeNull();
    expect(document.getElementById('sfut-menu')).not.toBeNull();
    expect(handle.isMounted()).toBe(true);
  });
  it('shows the empty state when no menu items are returned', () => {
    mountSideButton({
      menuItemsProvider: () => [],
      handlers: { onActivate: vi.fn(), onOpenSettings: vi.fn() },
    });
    expect(document.querySelector('.sfut-menu-empty')?.textContent).toContain(
      'No tools available',
    );
  });
  it('renders one menu item per provided MenuItem', () => {
    const items: MenuItem[] = [
      { featureId: 'flow-health-check', icon: '🩺', label: 'Run Health Check' },
      { featureId: 'setup-tabs', icon: '📑', label: 'Setup Tabs' },
    ];
    mountSideButton({
      menuItemsProvider: () => items,
      handlers: { onActivate: vi.fn(), onOpenSettings: vi.fn() },
    });
    const nodes = document.querySelectorAll('.sfut-menu-item');
    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.textContent).toContain('Run Health Check');
    expect(nodes[1]!.textContent).toContain('Setup Tabs');
  });
  it('opens the menu when the button is clicked', () => {
    mountSideButton({
      menuItemsProvider: () => [],
      handlers: { onActivate: vi.fn(), onOpenSettings: vi.fn() },
    });
    const button = document.getElementById('sfut-side-button')!;
    const menu = document.getElementById('sfut-menu')!;
    expect((menu as HTMLElement).style.display).toBe('none');
    button.click();
    expect((menu as HTMLElement).style.display).toBe('block');
  });
  it('escapes labels and icons — XSS-safe by construction', () => {
    mountSideButton({
      menuItemsProvider: () => [
        {
          featureId: 'evil',
          icon: '<img src=x onerror=alert(1)>',
          label: '<script>alert(2)</script>',
        },
      ],
      handlers: { onActivate: vi.fn(), onOpenSettings: vi.fn() },
    });
    expect(document.querySelector('.sfut-menu-item img')).toBeNull();
    expect(document.querySelector('.sfut-menu-item script')).toBeNull();
    expect(document.querySelector('.sfut-menu-item-label')?.textContent).toBe(
      '<script>alert(2)</script>',
    );
  });
  it('clicking a menu item dispatches onActivate with the item info', () => {
    const onActivate = vi.fn();
    mountSideButton({
      menuItemsProvider: () => [{ featureId: 'flow-health-check', icon: '🩺', label: 'Run' }],
      handlers: { onActivate, onOpenSettings: vi.fn() },
    });
    document.getElementById('sfut-side-button')!.click();
    document.querySelector<HTMLElement>('.sfut-menu-item')!.click();
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
    document.getElementById('sfut-side-button')!.click();
    document.getElementById('sfut-settings-link')!.click();
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect((document.getElementById('sfut-menu') as HTMLElement).style.display).toBe('none');
  });
  it('destroy() removes the button and menu from the DOM', () => {
    const handle = mountSideButton({
      menuItemsProvider: () => [],
      handlers: { onActivate: vi.fn(), onOpenSettings: vi.fn() },
    });
    handle.destroy();
    expect(document.getElementById('sfut-side-button')).toBeNull();
    expect(document.getElementById('sfut-menu')).toBeNull();
    expect(handle.isMounted()).toBe(false);
  });
  it('does not render when running in a sub-frame', () => {
    const fakeWin = { top: {}, self: {} } as unknown as Window;
    const handle = mountSideButton({
      win: fakeWin,
      menuItemsProvider: () => [],
      handlers: { onActivate: vi.fn(), onOpenSettings: vi.fn() },
    });
    expect(handle.isMounted()).toBe(false);
    expect(document.getElementById('sfut-side-button')).toBeNull();
  });
});
