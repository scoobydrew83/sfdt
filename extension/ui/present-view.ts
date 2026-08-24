// Shared view presenter. A feature builds its `body` (and optional `footer`)
// and hands it to `presentView()`, which places it in one of two ways:
//
//   • On a Salesforce page (content script) — a centered modal overlay, matching
//     the long-standing look. Clicking the backdrop closes it.
//   • In the Workspace tab — the body is mounted into a persistent tab pane via
//     a registered "sink"; there is NO backdrop and NO click-outside dismiss, so
//     a stray click can never discard the user's work. The tab chrome (title + ×)
//     is supplied by the Workspace, so the in-card header is omitted there.
//
// Features call the same `presentView()` either way and never branch on context.
//
// On a Salesforce page the modal mounts into the shared content root (the closed
// shadow root — ui/shadow-host.ts + ui/content-root.ts) so the host page's CSS
// can't restyle it; on our own pages / in tests it falls back to document.body.

import { getContentRoot } from './content-root.js';
import { icon } from '../lib/icons.js';
import { ensureComponentStyles } from '../lib/ui-styles.js';

export interface PresentOpts {
  /** Title shown in the modal header (page) or the tab chip (workspace). */
  title: string;
  /** The feature's content. It owns its own padding/scroll (flex:1 expected). */
  body: HTMLElement;
  /** Optional action bar pinned below the body. */
  footer?: HTMLElement;
  /** Called when the view is closed (modal dismissed or tab closed). */
  onClose?: () => void;
  /**
   * Veto hook for the *dismissal* paths — Escape and the backdrop click.
   *
   * A surface holding unsaved user input must not click-outside-dismiss
   * (CONVENTIONS.md item 2), and only the feature knows whether it is dirty.
   * Return false to keep the view open. It deliberately does NOT gate
   * `handle.close()`: a feature closing itself has already decided, and routing
   * that through a confirm would double-prompt.
   */
  confirmClose?: () => boolean;
  /** Modal card width (page mode only). Default 860px. */
  width?: string;
  /** Document to build in (defaults to the global document). */
  doc?: Document;
  /** Leading glyph name (lib/icons.ts). Omitted → no glyph, as before. */
  iconName?: string;
  /**
   * Context line under the title — what this view is currently showing
   * ("Account › 001aj…"), as opposed to what the tool is. Rendered in BOTH
   * presentations: in the workspace the tab chip carries the title but nothing
   * carries the record, so without this it would simply be lost.
   */
  subtitle?: string | HTMLElement;
  /** Controls that belong to the view's identity, placed before the ×. */
  headerActions?: HTMLElement;
}

/**
 * The header shared by both presentations. In a modal it carries glyph, title,
 * subtitle, actions and ×; in a workspace pane the tab chip already supplies
 * the title and the × , so only the subtitle and actions are rendered — and if
 * there are neither, the caller skips the header entirely.
 *
 * One builder rather than two because the drift it prevents is exactly the kind
 * this design system exists to stop: a feature's header looking like a
 * different product depending on which surface opened it.
 */
export function buildViewHead(
  opts: PresentOpts,
  doc: Document,
  parts: { title: boolean; close?: () => void },
): HTMLElement {
  const head = doc.createElement('div');
  head.className = 'sfdt-panel-head';

  if (parts.title && opts.iconName) {
    const glyph = doc.createElement('span');
    glyph.className = 'sfdt-glyph';
    glyph.appendChild(icon(opts.iconName, 20, doc));
    head.appendChild(glyph);
  }

  const titles = doc.createElement('div');
  titles.className = 'sfdt-panel-titles';
  if (parts.title) {
    // A <span>, not an <h2>: features put their own <h2>s inside the body, and
    // a heading here would sit above them at the same level. The dialog's
    // accessible name comes from aria-label on the card instead.
    const label = doc.createElement('span');
    label.className = 'sfdt-panel-title';
    label.textContent = opts.title;
    titles.appendChild(label);
  }
  if (opts.subtitle !== undefined) {
    const sub = doc.createElement('div');
    sub.className = 'sfdt-panel-sub';
    if (typeof opts.subtitle === 'string') {
      const t = doc.createElement('span');
      t.textContent = opts.subtitle;
      sub.appendChild(t);
    } else {
      sub.appendChild(opts.subtitle);
    }
    titles.appendChild(sub);
  }
  head.appendChild(titles);

  const actions = doc.createElement('div');
  actions.className = 'sfdt-panel-actions';
  if (opts.headerActions) actions.appendChild(opts.headerActions);
  if (parts.close) {
    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'sfdt-btn sfdt-ghost';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.appendChild(icon('close', 18, doc));
    closeBtn.addEventListener('click', parts.close);
    actions.appendChild(closeBtn);
  }
  if (actions.firstChild) head.appendChild(actions);

  return head;
}

export interface ViewHandle {
  /** Close the view (remove the modal, or close the workspace tab). */
  close(): void;
  /** The element the body/footer were mounted into (card in page, pane in workspace). */
  root: HTMLElement;
}

export type ViewSink = (opts: PresentOpts) => ViewHandle;

let workspaceSink: ViewSink | null = null;

/** The Workspace registers a sink so features render into tab panes, not modals. */
export function setWorkspaceViewSink(sink: ViewSink | null): void {
  workspaceSink = sink;
}

/** True when running inside the Workspace tab (a sink is registered). */
export function inWorkspace(): boolean {
  return workspaceSink !== null;
}

/** Present a feature view — workspace tab pane if available, else a modal. */
export function presentView(opts: PresentOpts): ViewHandle {
  if (workspaceSink) return workspaceSink(opts);
  return presentAsModal(opts);
}

/** Build the classic centered modal overlay. Exported for the page context and tests. */
export function presentAsModal(opts: PresentOpts): ViewHandle {
  const doc = opts.doc ?? document;
  // The card and its header are `.sfdt-*` component classes now, so the sheet
  // has to be present. Injecting it is idempotent and every selector in it is
  // prefixed, so this is safe even in the doc.body fallback on a live
  // Salesforce page — it cannot restyle the host.
  ensureComponentStyles(doc);

  const card = doc.createElement('div');
  card.className = 'sfdt-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', opts.title);
  card.style.cssText = `width: ${opts.width ?? '860px'}; max-width: 95vw; max-height: 90vh; display: flex; flex-direction: column; overflow: hidden;`;

  let overlay: HTMLDivElement | null = doc.createElement('div');
  overlay.className = 'sfdt-view-overlay';
  overlay.style.cssText =
    'position: fixed; inset: 0; background: var(--sfdt-color-scrim); z-index: 100020; display: flex; align-items: center; justify-content: center; font-family: var(--sfdt-font-sans, system-ui, sans-serif);';

  // Captured before mounting so focus can go back where the user left it.
  const returnFocusTo = doc.activeElement as HTMLElement | null;
  let onKey: ((e: KeyboardEvent) => void) | null = null;

  const close = (): void => {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    if (onKey) {
      doc.removeEventListener('keydown', onKey);
      onKey = null;
    }
    if (returnFocusTo && typeof returnFocusTo.focus === 'function') returnFocusTo.focus();
    opts.onClose?.();
  };
  // Dismissal paths ask first; `close()` itself does not, so a feature calling
  // handle.close() is never second-guessed.
  const dismiss = (): void => {
    if (opts.confirmClose && opts.confirmClose() === false) return;
    close();
  };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) dismiss();
  });

  // Bubble phase on purpose: ui/menu.ts listens in the CAPTURE phase and calls
  // stopPropagation on Escape, so dismissing an open menu inside this modal
  // never reaches here and closes the whole view.
  onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !overlay) return;
    // Modals stack (a feature opens an analyzer over itself), and every one of
    // them has a listener on the same document — so without this, one Escape
    // collapses the whole stack instead of the view on top. Last-mounted wins.
    const siblings = overlay.parentNode?.querySelectorAll('.sfdt-view-overlay');
    if (siblings?.length && siblings[siblings.length - 1] !== overlay) return;
    dismiss();
  };
  doc.addEventListener('keydown', onKey);

  // Focus trap. This lived, byte-similar, in features/schema-browser.ts and
  // features/field-impact.ts before it lived here — both had hand-rolled it
  // against `view.root`, which IS this card. A modal that leaks Tab to the
  // Salesforce page behind it is a CONVENTIONS.md item 3 failure, and leaving
  // the trap to each feature meant every new `presentView` caller either
  // rewrote it or silently shipped without one. Only modal mode needs it: a
  // Workspace tab pane is a persistent surface, not a trap, and the workspace
  // path never reaches this function.
  card.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Tab' || !overlay) return;
      // Same last-mounted-wins rule as Escape: with two stacked modals the
      // lower card must not cycle focus for a dialog sitting on top of it.
      const siblings = overlay.parentNode?.querySelectorAll('.sfdt-view-overlay');
      if (siblings?.length && siblings[siblings.length - 1] !== overlay) return;
      const focusables = card.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const activeEl = doc.activeElement;
      if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    },
    true,
  );

  card.append(buildViewHead(opts, doc, { title: true, close }), opts.body);
  if (opts.footer) card.append(opts.footer);
  overlay.appendChild(card);
  (getContentRoot() ?? doc.body).appendChild(overlay);

  return { close, root: card };
}
