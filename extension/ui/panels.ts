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
// The error block is the one that owns more than chrome. `renderSfError()` also
// owns the SHAPE of a Salesforce failure — the org's own text and every line we
// appended to it, each as its own node. The single-string builder it replaces
// left that composition to the caller, and 16 callers each got it slightly
// wrong (PR #308). Nothing outside this file may build that block; the class
// pair is a contract, enforced by test/sf-error-panel-contract.test.ts.
//
// DOM discipline (CLAUDE.md rule 1): createElement + textContent throughout.

import { sfErrorParts } from '../lib/sf-error-guidance.js';
import { glyph } from '../lib/ui-controls.js';
import { ensureComponentStyles } from '../lib/ui-styles.js';
import { getContentRoot } from './content-root.js';

/**
 * The chrome of the Salesforce-error block. Declared once, applied by the
 * builders below and by nothing else — `test/sf-error-panel-contract.test.ts`
 * fails any other file that names this class pair.
 *
 * `.sfdt-console` is not a stylistic choice: it brings `white-space: pre-wrap`,
 * and since lib/sf-error-guidance.ts a Salesforce error's `.message` is
 * multi-line (the org's text, then the "what to do" line). Rendered without a
 * white-space rule the guidance runs into the org's own text —
 * `test/error-render-newlines.test.ts` exists because that shipped once.
 */
const SF_ERROR_CLASSES = ['sfdt-console', 'sfdt-error'] as const;

export interface SfErrorOptions {
  doc?: Document;
  /**
   * Our own "what to do" prose, appended as its own node below whatever the org
   * said. Use it for surface-specific advice; the guidance keyed off the org's
   * `errorCode` is already inside the error's message and needs no help here.
   */
  guidance?: string;
}

/**
 * Render a Salesforce error as a panel: the org's own text in one node, every
 * line we appended to it in a node of its own.
 *
 * This is the helper whose absence caused PR #308. The builder it replaces took
 * ONE string, so each of 16 surfaces had to keep the org's text and the
 * guidance line apart by itself — via a `white-space` rule that several of them
 * omitted and several more resolved by discarding the org's message entirely.
 * Separate element nodes make that class of mistake unavailable: a block box
 * cannot run into the one above it, and a caller can no longer choose which
 * half to keep because it no longer does the joining.
 *
 * Accepts whatever `catch` produced — an `Error`, a string, anything — because
 * that is what the call sites have. Pass the ERROR, not `err.message`: a
 * failure raised by `lib/salesforce-api.ts` carries its composition on
 * `.userFacing`, and stringifying it at the call site throws that away and
 * leaves this with one undifferentiated blob. DOM discipline: `createElement` +
 * `textContent`, so an org message is never markup.
 *
 * Renders nothing at all for `null`/`undefined` — including the `role="alert"`,
 * which an empty panel must not carry. Four surfaces mount a hidden panel at
 * open() and fill it later; a live announcement region sitting empty in the
 * tree is what `clearSfError` exists to avoid, and building one would be the
 * same defect at the other end of the lifecycle.
 *
 * `null`/`undefined` ONLY, though. An error with an empty message is not a
 * request to render nothing — see `setSfError`.
 */
export function renderSfError(error: unknown, opts: SfErrorOptions = {}): HTMLElement {
  const doc = opts.doc ?? document;
  ensureComponentStyles(doc);
  const el = doc.createElement('div');
  return setSfError(el, error, opts);
}

/**
 * The same rendering, into an element the caller already owns.
 *
 * Four surfaces keep one long-lived pane and swap its contents (the SOQL and
 * SOAP explorers hide/show a pre-built panel; the debug-log and Execute
 * Anonymous panes re-purpose the console they render output into). Rebuilding
 * the node would break their layout and their show/hide state, and leaving them
 * to re-apply the classes by hand is exactly the hand-roll this item removes —
 * so the fill step is its own export rather than a second copy at each site.
 *
 * Applies the panel's classes and `role="alert"` too: a pane that was a plain
 * console a moment ago must become a real alert when it starts carrying a
 * failure, or a screen reader never announces it.
 *
 * Given nothing to say, it does the opposite — see `clearSfError`. An empty
 * panel is not a failure, and the three surfaces that mount one hidden at
 * `open()` must not park a live announcement region in the tree.
 *
 * "Nothing to say" means `null`/`undefined`, and the distinction is the whole
 * point. An `Error` whose message is empty used to take the clear branch too,
 * because `sfErrorParts()` falls back to `errorText()` and that is `''` — so a
 * caught `new Error('')` rendered as no panel, no `role="alert"` and no text,
 * from every call site that forwards a caught error. That is the #308 defect
 * (a failure the user never sees) reintroduced through this helper's own null
 * contract, and it is invisible to the sweep because the CALL SITE is correct.
 * A thrown value always produces a panel now, whatever it had to say.
 */
export function setSfError(el: HTMLElement, error: unknown, opts: SfErrorOptions = {}): HTMLElement {
  const doc = opts.doc ?? el.ownerDocument ?? document;
  ensureComponentStyles(doc);

  const { orgText, notes } = sfErrorParts(error);
  const parts: HTMLElement[] = [];
  if (orgText !== '') parts.push(sfErrorLine(doc, 'sfdt-sf-error-text', orgText));
  for (const note of notes) parts.push(sfErrorLine(doc, 'sfdt-sf-error-note', note));
  if (opts.guidance) parts.push(sfErrorLine(doc, 'sfdt-sf-error-note', opts.guidance));

  if (parts.length === 0) {
    // Nothing thrown and nothing to say: the deliberate clear. See below.
    if (error === null || error === undefined) {
      clearSfError(el);
      return el;
    }
    // Something WAS thrown and it had no text — `new Error('')`, or a bare
    // `throw new Error()`. Rendering nothing for that is the #308 defect
    // arriving through the null contract this helper introduced: the caller
    // handled a failure, the user sees an empty pane, and every guard in
    // `test/sf-error-panel-contract.test.ts` is satisfied because the call site
    // is correct. A failure with no message is still a failure, so it gets the
    // classes, the `role="alert"` and a line saying exactly that.
    parts.push(sfErrorLine(doc, 'sfdt-sf-error-text', 'The request failed with no message.'));
  }
  el.classList.add(...SF_ERROR_CLASSES);
  el.setAttribute('role', 'alert');
  el.replaceChildren(...parts);
  return el;
}

/**
 * Empty a panel and stop it being an alert.
 *
 * An empty `role="alert"` region left in the tree is a live announcement point
 * for whatever lands in it next — which for the reused panes (the debug-log
 * console, the Execute Anonymous result pane) is the SUCCESS path's output.
 *
 * `.sfdt-console` is deliberately left alone: for those panes it is the
 * caller's own class, not part of the error chrome, and taking it off would
 * unstyle the log body they are about to render.
 */
export function clearSfError(el: HTMLElement): void {
  el.replaceChildren();
  el.classList.remove('sfdt-error');
  el.removeAttribute('role');
}

// `<span>`, not `<div>`: two of the panes this fills are `<pre>` elements,
// whose content model is phrasing content. The block layout comes from the
// class.
function sfErrorLine(doc: Document, className: string, text: string): HTMLElement {
  const line = doc.createElement('span');
  line.className = className;
  line.textContent = text;
  return line;
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
