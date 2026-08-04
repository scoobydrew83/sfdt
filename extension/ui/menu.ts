// Anchored command menu — the floating list of actions that hangs off a cell,
// a chip or a toolbar button.
//
// Three of these were hand-rolled independently (the SOQL runner's record-Id
// menu and its history dropdown, the SOAP explorer's history dropdown). They
// each re-implemented positioning and dismissal, and each got some of it wrong:
// the SOQL cell menu registered a `document` click listener on every open and
// only removed it on outside-click, so choosing an item leaked the listener —
// permanently, once per record Id you ever clicked. None of them were reachable
// by keyboard.
//
// So the reusable part here is the BEHAVIOUR, not just the look: focus moves in,
// Esc closes and restores focus, outside-click closes across a shadow boundary,
// and every listener is torn down exactly once. The surface itself is the shared
// `.sfdt-card` + `.sfdt-nav-item` from lib/ui-styles.ts.
//
// createElement + textContent only (extension rule #1).

import { icon } from '../lib/icons.js';
import { getContentRoot } from './content-root.js';

export interface MenuAction {
  /** Row label. Rendered as text — never parsed as markup. */
  label: string;
  /** Glyph name from lib/icons.ts. */
  iconName: string;
  /** Invoked on click/Enter. The menu closes first, so a handler that opens
   *  another overlay isn't immediately dismissed by this menu's own teardown. */
  onSelect: () => void | Promise<void>;
  /** Draws a separator above this row. */
  separatorBefore?: boolean;
}

export interface MenuHandle {
  /** Close and tear down every listener. Safe to call more than once. */
  close(): void;
  /** The menu element, for tests. */
  element: HTMLElement;
}

export interface OpenMenuOptions {
  /** Element the menu is positioned under, and focus returns to on Esc. */
  anchor: HTMLElement;
  items: readonly MenuAction[];
  /** Accessible name for the menu itself. */
  label?: string;
  doc?: Document;
  win?: Window;
}

const MENU_CLASS = 'sfdt-menu-surface';

/**
 * Dismiss wiring shared by any transient overlay: Esc (closes and restores
 * focus to the trigger) and outside-click. Returns a teardown that is safe to
 * call repeatedly and that ALWAYS removes both listeners — the bug this
 * replaces removed one of them only on one of the two exit paths.
 *
 * Outside-click uses `composedPath()` so it works whether the overlay sits in
 * the light DOM (own pages) or inside the closed shadow root used on Salesforce
 * pages, where `event.target` is retargeted to the host and `contains()` would
 * wrongly report every click as outside.
 */
export function attachDismiss(opts: {
  element: HTMLElement;
  trigger?: HTMLElement;
  onDismiss: () => void;
  doc?: Document;
}): () => void {
  const doc = opts.doc ?? document;
  let done = false;

  const teardown = (): void => {
    if (done) return;
    done = true;
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('keydown', onKey, true);
  };

  function onClick(e: MouseEvent): void {
    const path = e.composedPath();
    if (path.includes(opts.element)) return;
    if (opts.trigger && path.includes(opts.trigger)) return;
    teardown();
    opts.onDismiss();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    teardown();
    opts.onDismiss();
    opts.trigger?.focus();
  }

  // Capture phase: a row handler that stops propagation must not be able to
  // strand the menu open.
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('keydown', onKey, true);
  return teardown;
}

/**
 * Open a command menu under `anchor`. Returns a handle; the menu also closes on
 * Esc, outside-click, or after an item is chosen.
 */
export function openMenu(opts: OpenMenuOptions): MenuHandle {
  const doc = opts.doc ?? document;
  const win = opts.win ?? window;

  // Same root injected UI uses, so the menu inherits the adopted component
  // sheet on a Salesforce page instead of escaping the shadow tree.
  const mount = getContentRoot() ?? doc.body;
  mount.querySelector(`.${MENU_CLASS}`)?.remove();

  const menu = doc.createElement('div');
  menu.className = `${MENU_CLASS} sfdt-card`;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', opts.label ?? 'Actions');
  menu.style.cssText = [
    'position: absolute',
    'z-index: 100030',
    'min-width: 200px',
    'padding: var(--sfdt-space-1) 0',
    'box-shadow: var(--sfdt-shadow-2)',
  ].join('; ');

  let closed = false;
  let detach: (() => void) | null = null;

  const handle: MenuHandle = {
    element: menu,
    close() {
      if (closed) return;
      closed = true;
      detach?.();
      menu.remove();
    },
  };

  for (const item of opts.items) {
    if (item.separatorBefore) {
      const sep = doc.createElement('div');
      sep.style.cssText =
        'height: 1px; margin: var(--sfdt-space-1) 0; background: var(--sfdt-color-border);';
      menu.appendChild(sep);
    }
    // A real <button>: these rows were <div>s with click handlers, so the menu
    // could be opened and then nothing inside it reached from the keyboard.
    const row = doc.createElement('button');
    row.type = 'button';
    row.className = 'sfdt-nav-item';
    row.setAttribute('role', 'menuitem');
    row.style.cssText = 'padding-left: var(--sfdt-space-4); padding-right: var(--sfdt-space-4);';

    const glyph = doc.createElement('span');
    glyph.className = 'sfdt-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.appendChild(icon(item.iconName, 18, doc));

    const label = doc.createElement('span');
    label.className = 'sfdt-nav-label';
    label.textContent = item.label;

    row.appendChild(glyph);
    row.appendChild(label);
    row.addEventListener('click', () => {
      // Close BEFORE running the action: a handler that opens a modal or
      // another menu would otherwise be torn down by this menu's own dismissal.
      handle.close();
      void item.onSelect();
    });
    menu.appendChild(row);
  }

  mount.appendChild(menu);

  // Position under the anchor, then pull back inside the viewport if the menu
  // would hang off the right or bottom edge — a menu on the last column of a
  // wide results table otherwise opens where it cannot be read.
  // Geometry comes from the DOCUMENT we're rendering into, not from whatever
  // window the caller passed. The Workspace hands features a synthetic window
  // proxy (ui/workspace-host.ts) whose whole job is to lie about `location`;
  // asking it for scroll offsets couples this to that proxy's fidelity for no
  // benefit, and reading a brand-checked accessor off a proxy is exactly what
  // used to throw "Illegal invocation" here.
  const view = doc.defaultView ?? win;
  const rect = opts.anchor.getBoundingClientRect();
  const scrollY = doc.documentElement.scrollTop || view.scrollY || 0;
  const scrollX = doc.documentElement.scrollLeft || view.scrollX || 0;
  const width = menu.offsetWidth || 200;
  const height = menu.offsetHeight || 0;
  const viewportW = doc.documentElement.clientWidth || view.innerWidth || 0;
  const viewportH = doc.documentElement.clientHeight || view.innerHeight || 0;

  const left = viewportW && rect.left + width > viewportW ? Math.max(0, viewportW - width - 8) : rect.left;
  const flipUp = !!viewportH && height > 0 && rect.bottom + height > viewportH && rect.top > height;
  const top = flipUp ? rect.top - height : rect.bottom;

  menu.style.left = `${left + scrollX}px`;
  menu.style.top = `${top + scrollY}px`;

  detach = attachDismiss({
    element: menu,
    trigger: opts.anchor,
    doc,
    onDismiss: () => handle.close(),
  });

  // Land on the first command rather than making the user tab the whole page.
  menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus();

  return handle;
}
