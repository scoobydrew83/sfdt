import { describe, it, expect, afterEach, vi } from 'vitest';
import { getShadowHost, resetShadowHost } from '../ui/shadow-host.js';
import { setContentRoot } from '../ui/content-root.js';
import { mountSideButton } from '../ui/side-button.js';
import { presentAsModal } from '../ui/present-view.js';
import { showToast } from '../ui/toast.js';
import { ensureTokens } from '../lib/tokens.js';
import { applyTheme } from '../lib/theme.js';

// NOTE on happy-dom: its getComputedStyle does NOT scope a host `* { … }` rule to
// the shadow boundary the way a real browser does (a hostile `*` incorrectly
// resolves onto shadow-tree elements under getComputedStyle). So these tests
// assert the REAL isolation guarantee that holds in both happy-dom and browsers:
// structural isolation (our nodes live in the closed shadow root, unreachable
// from document light-DOM queries) plus inline-style integrity (our token-based
// inline styles are untouched by the host sheet). Computed-style assertions
// would only be meaningful in a real browser and are covered by manual QA.

function noopHandlers() {
  return { onActivate: vi.fn(), onOpenSettings: vi.fn() };
}

describe('ui/shadow-host', () => {
  afterEach(() => {
    resetShadowHost();
    setContentRoot(null);
    document.head.replaceChildren();
    document.body.replaceChildren();
    document.documentElement.removeAttribute('data-sfdt-theme');
  });

  it('creates ONE closed shadow root with an adopted reset stylesheet', () => {
    const h = getShadowHost(document);
    // Closed mode: the host element does not expose its shadow root.
    expect(h.root.host.shadowRoot).toBeNull();
    expect(h.root.mode).toBe('closed');
    // Mount wrapper is inside the root.
    expect(h.mount.className).toBe('sfdt-shadow-content');
    expect(h.mount.getRootNode()).toBe(h.root);
    // Styles are ADOPTED (not <style> nodes) and carry the isolation reset.
    expect(h.root.adoptedStyleSheets).toHaveLength(1);
    expect(h.root.querySelectorAll('style')).toHaveLength(0);
  });

  it('is idempotent — repeated calls return the same root+mount', () => {
    const a = getShadowHost(document);
    const b = getShadowHost(document);
    expect(b.root).toBe(a.root);
    expect(b.mount).toBe(a.mount);
    // And only one host element exists in the page.
    expect(document.querySelectorAll('#sfdt-shadow-host')).toHaveLength(1);
  });

  it('destroy()/reset removes the host element from the page', () => {
    const h = getShadowHost(document);
    expect(document.getElementById('sfdt-shadow-host')).not.toBeNull();
    h.destroy();
    expect(document.getElementById('sfdt-shadow-host')).toBeNull();
    // A subsequent get recreates it fresh.
    const h2 = getShadowHost(document);
    expect(h2.root).not.toBe(h.root);
  });

  it('injected UI mounts inside the shadow root, not the light DOM', () => {
    setContentRoot(getShadowHost(document).mount);
    const handle = mountSideButton({ menuItemsProvider: () => [], handlers: noopHandlers() });
    // Structurally isolated: unreachable from document light-DOM queries…
    expect(document.getElementById('sfdt-side-button')).toBeNull();
    // …but present inside the shadow mount, and reported mounted.
    const root = getShadowHost(document);
    expect(root.mount.querySelector('#sfdt-side-button')).not.toBeNull();
    expect(handle.isMounted()).toBe(true);
    handle.destroy();
    expect(handle.isMounted()).toBe(false);
  });

  it('HOSTILE host stylesheet cannot reach our shadow UI (isolation)', () => {
    ensureTokens(document);
    setContentRoot(getShadowHost(document).mount);
    mountSideButton({ menuItemsProvider: () => [], handlers: noopHandlers() });

    // Attacker/host page injects a maximally aggressive global rule.
    const hostile = document.createElement('style');
    hostile.id = 'hostile';
    hostile.textContent = '* { color: red !important; font-size: 40px !important; }';
    document.head.appendChild(hostile);

    const root = getShadowHost(document);
    const button = root.mount.querySelector<HTMLElement>('#sfdt-side-button')!;
    // Our node is inside the closed shadow tree — the `*` rule from the host
    // document does not match across the boundary in a real browser.
    expect(button.getRootNode()).toBe(root.root);
    expect(document.getElementById('sfdt-side-button')).toBeNull();
    // Our inline token styling is intact (never overwritten by the host sheet).
    expect(button.style.background).toBe('var(--sfdt-color-brand)');
    expect(button.style.color).toBe('var(--sfdt-color-on-accent)');
    // The hostile stylesheet lives only in the host document, never in our root.
    expect(root.root.querySelector('#hostile')).toBeNull();
    expect(root.root.querySelectorAll('style')).toHaveLength(0);
  });

  it('shadow UI uses var(--sfdt-*) (inherits host tokens) — dark mode survives the boundary', () => {
    ensureTokens(document);
    setContentRoot(getShadowHost(document).mount);
    mountSideButton({
      menuItemsProvider: () => [{ featureId: 'x', icon: '⚡', label: 'X' }],
      handlers: noopHandlers(),
    });
    const root = getShadowHost(document);
    const button = root.mount.querySelector<HTMLElement>('#sfdt-side-button')!;

    // Tokens are defined ONCE on the host document, not duplicated in the root —
    // custom properties inherit across the boundary, so they must NOT be re-injected.
    expect(document.getElementById('sfdt-design-tokens')).not.toBeNull();
    expect(root.root.querySelector('#sfdt-design-tokens')).toBeNull();

    // Our UI references tokens (var()) rather than hard-coded colours, so flipping
    // the host theme attribute re-themes it via inheritance.
    expect(button.style.background).toContain('var(--sfdt-color-');

    applyTheme('dark', document);
    // The theme attribute is set on the HOST root (where the tokens live), which
    // is what the shadow UI inherits from — not inside the shadow tree.
    expect(document.documentElement.getAttribute('data-sfdt-theme')).toBe('dark');
    // The button still points at the same var() (value now resolves to the dark token).
    expect(button.style.background).toBe('var(--sfdt-color-brand)');
  });

  it('click-outside dismiss works across the shadow boundary (composedPath)', () => {
    setContentRoot(getShadowHost(document).mount);
    mountSideButton({ menuItemsProvider: () => [], handlers: noopHandlers() });
    const root = getShadowHost(document);
    const button = root.mount.querySelector<HTMLElement>('#sfdt-side-button')!;
    const menu = root.mount.querySelector<HTMLElement>('#sfdt-menu')!;

    button.click(); // opens
    expect(menu.style.display).toBe('block');

    // A click whose composedPath includes the menu (inside the shadow) keeps it open.
    menu.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(menu.style.display).toBe('block');

    // A click outside the shadow subtree (host page) closes it.
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(menu.style.display).toBe('none');
  });

  it('present-view modals and toasts also mount into the shared shadow root', () => {
    setContentRoot(getShadowHost(document).mount);
    const root = getShadowHost(document);

    presentAsModal({ title: 'T', body: document.createElement('div') });
    showToast('hello');

    // Neither appears in the light DOM…
    expect(document.querySelector('.sfdt-view-overlay')).toBeNull();
    expect(document.getElementById('sfdt-toast-container')).toBeNull();
    // …both live inside the shadow root.
    expect(root.mount.querySelector('.sfdt-view-overlay')).not.toBeNull();
    expect(root.mount.querySelector('#sfdt-toast-container')).not.toBeNull();
  });
});
