// createElement + textContent only — every label and icon is escaped
// automatically, so a rogue feature label has zero XSS surface here.
// Gating is the caller's responsibility (see entrypoints/content.ts);
// the menu rebuilds on every open so dynamic labels stay accurate.

export interface MenuItem {
  featureId: string;
  icon: string;
  label: string;
  action?: 'activate' | 'refresh';
}

export type MenuItemsProvider = () => MenuItem[];

export interface SideButtonHandlers {
  /** Called when the user clicks a feature menu item. */
  onActivate: (item: MenuItem) => void | Promise<void>;
  /** Called when the user clicks the Settings link in the menu footer. */
  onOpenSettings: () => void;
}

export interface SideButtonHandle {
  refresh: () => void;
  destroy: () => void;
  isMounted: () => boolean;
}

const BUTTON_ID = 'sfut-side-button';
const MENU_ID = 'sfut-menu';
const MENU_HIDDEN_CLASS = 'sfut-menu-hidden';
const MENU_VISIBLE_CLASS = 'sfut-menu-visible';

const BUTTON_STYLE = [
  'position: fixed',
  'top: 50%',
  'right: 0',
  'transform: translateY(-50%)',
  'width: 32px',
  'height: 48px',
  'background: #0070d2',
  'color: #fff',
  'border-radius: 4px 0 0 4px',
  'display: flex',
  'align-items: center',
  'justify-content: center',
  'cursor: pointer',
  'z-index: 100000',
  'box-shadow: 0 0 6px rgba(0,0,0,0.2)',
  'user-select: none',
].join('; ');

const MENU_STYLE = [
  'position: fixed',
  'top: 50%',
  'right: 40px',
  'transform: translateY(-50%)',
  'background: #fff',
  'border: 1px solid #d8dde6',
  'border-radius: 4px',
  'box-shadow: 0 2px 8px rgba(0,0,0,0.15)',
  'min-width: 240px',
  'max-width: 320px',
  'z-index: 100000',
  'font-family: system-ui, -apple-system, sans-serif',
  'font-size: 13px',
  'display: none',
].join('; ');

function styled<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  cssText: string,
  attrs: Partial<Record<string, string>> = {},
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  el.style.cssText = cssText;
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) el.setAttribute(k, v);
  }
  return el;
}

// The caller supplies menuItemsProvider so this module stays oblivious
// to the registry shape.
export function mountSideButton(opts: {
  doc?: Document;
  win?: Window;
  menuItemsProvider: MenuItemsProvider;
  handlers: SideButtonHandlers;
}): SideButtonHandle {
  const doc = opts.doc ?? document;
  const win = opts.win ?? window;

  // Only render in the top window, never inside Salesforce VF iframes.
  if (win.top !== win.self) {
    return {
      refresh: () => {},
      destroy: () => {},
      isMounted: () => false,
    };
  }

  // Re-mounts on the same page must not accumulate duplicate buttons.
  doc.getElementById(BUTTON_ID)?.remove();
  doc.getElementById(MENU_ID)?.remove();

  const button = styled(doc, 'div', BUTTON_STYLE, { id: BUTTON_ID, title: 'SFDT SF Helper' });
  button.className = 'sfut-side-button';
  const buttonIcon = doc.createElement('span');
  buttonIcon.className = 'sfut-side-button-icon';
  buttonIcon.textContent = '⚡';
  button.appendChild(buttonIcon);

  const menu = styled(doc, 'div', MENU_STYLE, { id: MENU_ID });
  menu.className = `sfut-menu ${MENU_HIDDEN_CLASS}`;

  const header = doc.createElement('div');
  header.className = 'sfut-menu-header';
  header.style.cssText =
    'padding: 10px 14px; border-bottom: 1px solid #d8dde6; display: flex; justify-content: space-between; align-items: center;';
  const headerTitle = doc.createElement('span');
  headerTitle.className = 'sfut-menu-title';
  headerTitle.style.fontWeight = '600';
  headerTitle.textContent = 'SFDT SF Helper';
  const headerClose = doc.createElement('span');
  headerClose.className = 'sfut-menu-close';
  headerClose.style.cssText = 'cursor: pointer; font-size: 18px; color: #80868d;';
  headerClose.textContent = '×';
  header.appendChild(headerTitle);
  header.appendChild(headerClose);

  const content = doc.createElement('div');
  content.id = 'sfut-menu-content';
  content.className = 'sfut-menu-content';
  content.style.cssText = 'max-height: 60vh; overflow-y: auto;';

  const footer = doc.createElement('div');
  footer.className = 'sfut-menu-footer';
  footer.style.cssText = 'padding: 8px 14px; border-top: 1px solid #d8dde6;';
  const settingsLink = doc.createElement('a');
  settingsLink.href = '#';
  settingsLink.id = 'sfut-settings-link';
  settingsLink.className = 'sfut-menu-settings-link';
  settingsLink.style.cssText = 'color: #0070d2; text-decoration: none; font-size: 12px;';
  settingsLink.textContent = '⚙ Settings';
  footer.appendChild(settingsLink);

  menu.appendChild(header);
  menu.appendChild(content);
  menu.appendChild(footer);

  doc.body.appendChild(button);
  doc.body.appendChild(menu);

  let isOpen = false;
  let destroyed = false;

  function clearContent(): void {
    while (content.firstChild) content.removeChild(content.firstChild);
  }

  function buildMenuItemNode(item: MenuItem): HTMLDivElement {
    const node = doc.createElement('div');
    node.className = 'sfut-menu-item';
    node.dataset.feature = item.featureId;
    node.dataset.action = item.action ?? 'activate';
    node.style.cssText =
      'padding: 10px 14px; cursor: pointer; display: flex; align-items: center; gap: 10px;';
    const iconNode = doc.createElement('span');
    iconNode.className = 'sfut-menu-item-icon';
    iconNode.style.fontSize = '16px';
    iconNode.textContent = item.icon;
    const labelNode = doc.createElement('span');
    labelNode.className = 'sfut-menu-item-label';
    labelNode.textContent = item.label;
    node.appendChild(iconNode);
    node.appendChild(labelNode);
    node.addEventListener('click', () => {
      const live = opts.menuItemsProvider().find((i) => i.featureId === item.featureId);
      if (live) void opts.handlers.onActivate({ ...live, action: item.action ?? 'activate' });
      setOpen(false);
    });
    return node;
  }

  function buildEmptyState(): HTMLDivElement {
    const empty = doc.createElement('div');
    empty.className = 'sfut-menu-empty';
    empty.style.cssText = 'padding: 16px; text-align: center; color: #80868d;';
    empty.textContent = 'No tools available for this page.';
    return empty;
  }

  function renderMenu(): void {
    const items = opts.menuItemsProvider();
    clearContent();
    if (items.length === 0) {
      content.appendChild(buildEmptyState());
      return;
    }
    for (const item of items) content.appendChild(buildMenuItemNode(item));
  }

  function setOpen(state: boolean): void {
    if (destroyed) return;
    isOpen = state;
    if (state) renderMenu();
    menu.style.display = state ? 'block' : 'none';
    menu.classList.toggle(MENU_HIDDEN_CLASS, !state);
    menu.classList.toggle(MENU_VISIBLE_CLASS, state);
  }

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!isOpen);
  });
  headerClose.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(false);
  });
  settingsLink.addEventListener('click', (e) => {
    e.preventDefault();
    opts.handlers.onOpenSettings();
    setOpen(false);
  });

  const docClickHandler = (e: MouseEvent): void => {
    if (!isOpen) return;
    const target = e.target as Node | null;
    if (target && (menu.contains(target) || button.contains(target))) return;
    setOpen(false);
  };
  doc.addEventListener('click', docClickHandler);

  // Initial render so the menu structure exists before the first open.
  renderMenu();

  return {
    refresh: renderMenu,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      doc.removeEventListener('click', docClickHandler);
      button.remove();
      menu.remove();
    },
    isMounted: () => !destroyed && !!doc.getElementById(BUTTON_ID),
  };
}
