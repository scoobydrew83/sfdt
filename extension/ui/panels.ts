// The four blocks every feature re-invented.
//
// Before this file: ten features hand-built an error panel with their own
// `error-bg` / `error-text` / padding / radius string, six built their own
// "Loading…" div, and several built their own empty state. None of them were
// wrong; they were just each 6 lines of slightly different CSS, which is how a
// UI ends up looking assembled rather than designed.
//
// The rule these follow: a builder here owns the CHROME (which class, which
// glyph, which spacing) and the caller owns the WORDS. If you find yourself
// wanting a variant, add a parameter — do not copy the function.
//
// DOM discipline (CLAUDE.md rule 1): createElement + textContent throughout.

import { glyph } from '../lib/ui-controls.js';
import { ensureComponentStyles } from '../lib/ui-styles.js';
import { getContentRoot } from './content-root.js';

/**
 * A failure block carrying an org error.
 *
 * `.sfdt-console` is not a stylistic choice: it brings `white-space: pre-wrap`,
 * and since lib/sf-error-guidance.ts a Salesforce error's `.message` is
 * multi-line (the org's text, then the "what to do" line). Rendered without a
 * white-space rule the guidance runs into the org's own text —
 * `test/error-render-newlines.test.ts` exists because that shipped once.
 */
export function errorPanel(message: string, doc: Document = document): HTMLElement {
  ensureComponentStyles(doc);
  const el = doc.createElement('div');
  el.className = 'sfdt-console sfdt-error';
  el.setAttribute('role', 'alert');
  el.textContent = message;
  return el;
}

/** Inline "working on it" line. `role="status"` so it is announced, not silent. */
export function loadingPanel(message = 'Loading…', doc: Document = document): HTMLElement {
  ensureComponentStyles(doc);
  const el = doc.createElement('div');
  el.className = 'sfdt-muted sfdt-panel-loading';
  el.setAttribute('role', 'status');
  el.textContent = message;
  return el;
}

/**
 * Nothing-to-show block. Takes a `hint` because "No results" on its own is a
 * dead end — the useful version says what would produce some.
 */
export function emptyPanel(
  message: string,
  opts: { hint?: string; iconName?: string; doc?: Document } = {},
): HTMLElement {
  const doc = opts.doc ?? document;
  ensureComponentStyles(doc);
  const el = doc.createElement('div');
  el.className = 'sfdt-stack sfdt-panel-empty';

  if (opts.iconName) el.appendChild(glyph(opts.iconName, 24, doc));

  const main = doc.createElement('div');
  main.className = 'sfdt-muted sfdt-msg';
  main.textContent = message;
  el.appendChild(main);

  if (opts.hint) {
    const hint = doc.createElement('div');
    hint.className = 'sfdt-muted';
    hint.textContent = opts.hint;
    el.appendChild(hint);
  }
  return el;
}

export interface BusyOverlay {
  /** Swap the message in place — used to report a failure before dismissing. */
  setMessage(text: string): void;
  /** Remove it. Safe to call more than once. */
  close(): void;
}

/**
 * A blocking "working…" scrim, for the gap between activating a feature and
 * having a view to show a spinner inside.
 *
 * Mounts into the shared content root, not `doc.body`. The three copies this
 * replaces all used `doc.body`, which on a Salesforce page puts the scrim
 * OUTSIDE the closed shadow root — so the host page's CSS could restyle it and
 * it sat in a different stacking context from every other overlay we own.
 */
export function busyOverlay(message: string, doc: Document = document): BusyOverlay {
  ensureComponentStyles(doc);
  const el = doc.createElement('div');
  el.className = 'sfdt-busy';
  el.setAttribute('role', 'status');

  const spinner = doc.createElement('div');
  spinner.className = 'sfdt-spinner';
  spinner.setAttribute('aria-hidden', 'true');
  // '.sfdt-msg' keeps newlines: callers report a failure through setMessage()
  // before dismissing, and a Salesforce error's message is multi-line.
  const text = doc.createElement('span');
  text.className = 'sfdt-msg';
  text.textContent = message;
  el.append(spinner, text);

  (getContentRoot() ?? doc.body).appendChild(el);
  return {
    setMessage(next: string) {
      text.textContent = next;
    },
    close() {
      el.remove();
    },
  };
}
