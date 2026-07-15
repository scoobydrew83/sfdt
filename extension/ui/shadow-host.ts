// One CLOSED shadow root hosts every piece of content-script-injected UI (the
// ⚡ side button + its menu, present-view page-mode modals, toasts). Salesforce's
// global CSS cannot restyle nodes inside a shadow tree and our inline styles
// cannot leak back onto the host page — isolation in both directions
// (CONVENTIONS.md item 13; realises the P0-3 item).
//
// DARK MODE (P0-2) THROUGH THE BOUNDARY: CSS custom properties inherit ACROSS a
// shadow boundary, so `var(--sfdt-color-*)` used inside this root still resolves
// against the `:root { --sfdt-* }` block that `ensureTokens(document)` injects on
// the HOST document — and re-themes live when `applyTheme` (lib/theme.ts) flips
// `data-sfdt-theme` on the host <html>. So tokens stay on the host; we only adopt
// a tiny reset here. (Deliberately NOT re-injecting tokens into the root — doing
// so would shadow the host definitions and break the theme toggle.)

const HOST_ID = 'sfdt-shadow-host';
const CONTENT_CLASS = 'sfdt-shadow-content';

// Adopted into the root. `all: initial` on the content wrapper severs
// inheritance of any host-set inheritable property (a hostile
// `* { color: red !important }` sets `color` on our host element, which would
// otherwise inherit inward) and re-establishes our own baseline. `all`
// excludes custom properties by spec, so `var(--sfdt-*)` still inherits from the
// host :root — dark mode keeps working. display is restored (initial => inline).
const BASE_CSS = `.${CONTENT_CLASS} {
  all: initial;
  display: block;
  color: var(--sfdt-color-text);
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 13px;
}`;

export interface ShadowHost {
  /** The closed shadow root. */
  root: ShadowRoot;
  /** The `.sfdt-shadow-content` wrapper injected UI should mount into. */
  mount: HTMLElement;
  /** Remove the host element (and its shadow tree) from the page. */
  destroy(): void;
}

let singleton: ShadowHost | null = null;

/**
 * Get (creating once) the shared closed shadow host for injected UI. Idempotent:
 * repeated calls return the same root+mount unless it was destroyed or its host
 * element was detached from the page.
 */
export function getShadowHost(doc: Document = document): ShadowHost {
  if (singleton && singleton.root.host.isConnected) return singleton;

  const host = doc.createElement('div');
  host.id = HOST_ID;
  // The host element lives in light DOM; keep it inert and zero-footprint so it
  // cannot itself be a layout/style surface for the page.
  host.style.cssText = 'all: initial;';

  const root = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(BASE_CSS);
  root.adoptedStyleSheets = [sheet];

  const mount = doc.createElement('div');
  mount.className = CONTENT_CLASS;
  root.appendChild(mount);

  (doc.body ?? doc.documentElement).appendChild(host);

  singleton = {
    root,
    mount,
    destroy() {
      host.remove();
      if (singleton && singleton.root === root) singleton = null;
    },
  };
  return singleton;
}

/** Tear down the shared shadow host (used by tests; harmless if none exists). */
export function resetShadowHost(): void {
  singleton?.destroy();
  singleton = null;
}
