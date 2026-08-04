// createElement + textContent only — every label and icon is escaped
// automatically, so a rogue feature label has zero XSS surface here.
// Gating is the caller's responsibility (see entrypoints/content.ts);
// the menu rebuilds on every open so dynamic labels stay accurate.
//
// Mounts into the shared content root when one is set (the closed shadow root on
// a Salesforce page — ui/shadow-host.ts + ui/content-root.ts), else document.body.

import { getContentRoot } from './content-root.js';
import { icon } from '../lib/icons.js';

export interface MenuItem {
  featureId: string;
  /**
   * Name of a glyph in lib/icons.ts — NOT an emoji, and not raw markup.
   *
   * Renamed from `icon` when the injected UI moved to the line-icon set: the
   * field's meaning changed from "character to print" to "glyph to look up", and
   * a rename makes a stale caller a compile error instead of a silent fallback
   * dot. Unknown names resolve to a neutral dot; nothing here is ever parsed as
   * HTML, so a hostile value is inert either way.
   */
  iconName: string;
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
  /** Programmatically open the menu (e.g. from the open-palette command). */
  open: () => void;
  destroy: () => void;
  isMounted: () => boolean;
}

const BUTTON_ID = 'sfdt-side-button';
const MENU_ID = 'sfdt-menu';
const MENU_HIDDEN_CLASS = 'sfdt-menu-hidden';
const MENU_VISIBLE_CLASS = 'sfdt-menu-visible';

const BUTTON_STYLE = [
  'position: fixed',
  'top: 50%',
  'right: 0',
  'transform: translateY(-50%)',
  'width: 32px',
  'height: 48px',
  // A native <button> brings a UA border and its own font; strip both so the
  // launcher looks identical to the <div> it replaced.
  'border: 0',
  'padding: 0',
  'font: inherit',
  'background: var(--sfdt-color-brand)',
  'color: var(--sfdt-color-on-accent)',
  'border-radius: var(--sfdt-radius-md) 0 0 var(--sfdt-radius-md)',
  'display: flex',
  'align-items: center',
  'justify-content: center',
  'cursor: pointer',
  'z-index: 100000',
  'box-shadow: var(--sfdt-shadow-2)',
  'user-select: none',
].join('; ');

// Matches the toolbar popup: header, scrollable command list, pinned footer.
// Width tracks the popup's 320px so the two launchers feel like one thing.
const MENU_STYLE = [
  'position: fixed',
  'top: 50%',
  'right: 40px',
  'transform: translateY(-50%)',
  'background: var(--sfdt-color-surface)',
  'border: 1px solid var(--sfdt-color-border)',
  'border-radius: var(--sfdt-radius-xl)',
  'box-shadow: var(--sfdt-shadow-2)',
  'width: 320px',
  'max-width: calc(100vw - 56px)',
  'overflow: hidden',
  'z-index: 100000',
  'font: var(--sfdt-type-body-md)',
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
      open: () => {},
      destroy: () => {},
      isMounted: () => false,
    };
  }

  // Shadow root (Salesforce page) when set, else the light-DOM body (own pages
  // + unit tests). Query our own nodes within the mount, not `doc`, since the
  // closed shadow root is invisible to document.getElementById.
  const mount = getContentRoot() ?? doc.body;

  // Re-mounts on the same page must not accumulate duplicate buttons.
  mount.querySelector(`#${BUTTON_ID}`)?.remove();
  mount.querySelector(`#${MENU_ID}`)?.remove();

  // A real <button>, not a <div> with a click handler: the launcher for every
  // on-page tool was previously unreachable by keyboard, which made the whole
  // injected menu mouse-only.
  const button = styled(doc, 'button', BUTTON_STYLE, {
    id: BUTTON_ID,
    type: 'button',
    title: 'SFDT for Salesforce',
    'aria-label': 'Open SFDT menu',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    'aria-controls': MENU_ID,
  });
  button.className = 'sfdt-side-button';
  const buttonIcon = doc.createElement('span');
  buttonIcon.className = 'sfdt-side-button-icon sfdt-glyph';
  buttonIcon.setAttribute('aria-hidden', 'true');
  buttonIcon.appendChild(icon('bolt', 20, doc));
  button.appendChild(buttonIcon);

  const menu = styled(doc, 'div', MENU_STYLE, { id: MENU_ID });
  menu.className = `sfdt-menu ${MENU_HIDDEN_CLASS}`;

  const header = doc.createElement('div');
  // Shared with the toolbar popup (lib/ui-styles.ts). This row's padding,
  // border and gap were previously an inline cssText string here and a
  // byte-identical rule in the popup's stylesheet.
  header.className = 'sfdt-menu-header sfdt-panel-head';
  const headerIcon = doc.createElement('span');
  headerIcon.className = 'sfdt-glyph';
  headerIcon.setAttribute('aria-hidden', 'true');
  headerIcon.appendChild(icon('bolt', 20, doc));
  const headerTitle = doc.createElement('span');
  headerTitle.className = 'sfdt-menu-title sfdt-panel-title';
  headerTitle.textContent = 'SFDT for Salesforce';
  // A real <button>, not a styled <span>: the close affordance has to be
  // reachable and activatable from the keyboard (CONVENTIONS.md a11y checklist).
  const headerClose = doc.createElement('button');
  headerClose.type = 'button';
  headerClose.className = 'sfdt-menu-close sfdt-btn sfdt-ghost';
  headerClose.setAttribute('aria-label', 'Close menu');
  headerClose.appendChild(icon('close', 18, doc));
  header.appendChild(headerIcon);
  header.appendChild(headerTitle);
  header.appendChild(headerClose);

  const content = doc.createElement('div');
  content.id = 'sfdt-menu-content';
  content.className = 'sfdt-menu-content';
  content.style.cssText = 'max-height: 60vh; overflow-y: auto; padding: var(--sfdt-space-2) 0;';

  const footer = doc.createElement('div');
  footer.className = 'sfdt-menu-footer';
  footer.style.cssText =
    'border-top: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface-alt);';
  // Was an <a href="#"> whose only job was to be clicked — a button that
  // performs an in-page action, spelled as a link, with a fake target.
  const settingsLink = doc.createElement('button');
  settingsLink.type = 'button';
  settingsLink.id = 'sfdt-settings-link';
  settingsLink.className = 'sfdt-menu-settings-link sfdt-nav-item';
  settingsLink.style.cssText =
    'padding-left: var(--sfdt-space-4); padding-right: var(--sfdt-space-4); color: var(--sfdt-color-brand-text); font-weight: 600;';
  const settingsIcon = doc.createElement('span');
  settingsIcon.className = 'sfdt-glyph';
  settingsIcon.setAttribute('aria-hidden', 'true');
  settingsIcon.appendChild(icon('settings', 18, doc));
  const settingsLabel = doc.createElement('span');
  settingsLabel.className = 'sfdt-nav-label';
  settingsLabel.textContent = 'Settings';
  settingsLink.appendChild(settingsIcon);
  settingsLink.appendChild(settingsLabel);
  footer.appendChild(settingsLink);

  menu.appendChild(header);
  menu.appendChild(content);
  menu.appendChild(footer);

  mount.appendChild(button);
  mount.appendChild(menu);

  let isOpen = false;
  let destroyed = false;

  function clearContent(): void {
    while (content.firstChild) content.removeChild(content.firstChild);
  }

  function buildMenuItemNode(item: MenuItem): HTMLButtonElement {
    // A real <button>: these were <div>s with click handlers, so the menu had no
    // keyboard path at all — you could open it and then not reach anything in it.
    const node = doc.createElement('button');
    node.type = 'button';
    node.className = 'sfdt-menu-item sfdt-nav-item';
    node.dataset.feature = item.featureId;
    node.dataset.action = item.action ?? 'activate';
    node.style.cssText =
      'padding-left: var(--sfdt-space-4); padding-right: var(--sfdt-space-4);';
    const iconNode = doc.createElement('span');
    iconNode.className = 'sfdt-menu-item-icon sfdt-glyph';
    iconNode.setAttribute('aria-hidden', 'true');
    iconNode.appendChild(icon(item.iconName, 20, doc));
    const labelNode = doc.createElement('span');
    labelNode.className = 'sfdt-menu-item-label sfdt-nav-label';
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
    empty.className = 'sfdt-menu-empty';
    empty.style.cssText =
      'padding: var(--sfdt-space-4); text-align: center; color: var(--sfdt-color-text-weak); font: var(--sfdt-type-body-sm);';
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
    button.setAttribute('aria-expanded', String(state));
    // Move focus into the menu on open, so a keyboard user lands on the first
    // command instead of having to tab through the whole host page to reach it.
    if (state) content.querySelector<HTMLElement>('.sfdt-menu-item')?.focus();
  }

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!isOpen);
  });
  headerClose.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(false);
  });
  settingsLink.addEventListener('click', () => {
    opts.handlers.onOpenSettings();
    setOpen(false);
  });

  // Esc closes the menu and returns focus to the launcher — the overlay rule
  // from CONVENTIONS.md, which this menu previously did not honour.
  const keyHandler = (e: KeyboardEvent): void => {
    if (!isOpen || e.key !== 'Escape') return;
    e.stopPropagation();
    setOpen(false);
    button.focus();
  };
  doc.addEventListener('keydown', keyHandler);

  const docClickHandler = (e: MouseEvent): void => {
    if (!isOpen) return;
    // composedPath() crosses the shadow boundary, so this works whether the menu
    // lives in light DOM or inside the closed shadow root (where e.target is
    // retargeted to the host and menu.contains(target) would wrongly miss).
    const path = e.composedPath();
    if (path.includes(menu) || path.includes(button)) return;
    setOpen(false);
  };
  doc.addEventListener('click', docClickHandler);

  // Initial render so the menu structure exists before the first open.
  renderMenu();

  return {
    refresh: renderMenu,
    open: () => setOpen(true),
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      doc.removeEventListener('click', docClickHandler);
      doc.removeEventListener('keydown', keyHandler);
      button.remove();
      menu.remove();
    },
    isMounted: () => !destroyed && button.isConnected,
  };
}
