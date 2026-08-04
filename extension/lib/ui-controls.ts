// Shared control builders — the constructive half of the design system.
//
// lib/tokens.ts holds the VALUES, lib/ui-styles.ts holds the CLASSES, and this
// file holds the BUILDERS that put them together. It exists because a class on
// its own does not get used: at the time it was written the extension had 134
// hand-built `<button>` elements and only 11 of them wore `.sfdt-btn`. Every
// other one was `createElement('button')` + a `style.cssText` string, and
// because each site retyped that string from memory, the same button existed in
// four slightly different sizes with three different glyph conventions
// (`▶ Run`, `★ Save`, `🔎 Explain`).
//
// The fix is not a stricter rule, it is a shorter path: `button({...})` is less
// typing than the cssText line it replaces, so the correct thing is also the
// lazy thing. lib/popup.ts had already discovered this and grown a private
// `button()`; this is that helper promoted, with the variants the other
// surfaces needed.
//
// DOM discipline (CLAUDE.md rule 1) holds here: createElement + textContent,
// never innerHTML. Icons are inline SVG from lib/icons.ts.

import { icon } from './icons.js';

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger';

export interface ButtonOpts {
  /** Visible text. Omit for an icon-only button — then `title` or `ariaLabel` is required. */
  label?: string;
  /** Leading glyph, a name from lib/icons.ts. */
  iconName?: string;
  variant?: ButtonVariant;
  /** Compact density for toolbars and table rows. */
  small?: boolean;
  /** Native tooltip. Also serves as the accessible name when there is no label. */
  title?: string;
  /** Explicit accessible name, when it should differ from the visible text. */
  ariaLabel?: string;
  disabled?: boolean;
  onClick?: (e: MouseEvent) => void;
  doc?: Document;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: '',
  primary: ' sfdt-primary',
  ghost: ' sfdt-ghost',
  danger: ' sfdt-danger',
};

/**
 * Build a `.sfdt-btn`.
 *
 * Throws when the result would have no accessible name — an icon-only button
 * with no `title` and no `ariaLabel` is a screen-reader dead end, and it is the
 * single easiest a11y defect to ship by accident (the glyph looks self-evident
 * to the person who just chose it). Failing at construction makes it
 * deterministic: it cannot render once in a test and stay silent in Chrome.
 */
export function button(opts: ButtonOpts): HTMLButtonElement {
  const doc = opts.doc ?? document;
  const name = opts.ariaLabel ?? opts.title ?? opts.label;
  if (!name) {
    throw new Error('button(): needs a label, title or ariaLabel — an unnamed button is unreachable');
  }

  const b = doc.createElement('button');
  b.type = 'button';
  b.className =
    'sfdt-btn' +
    VARIANT_CLASS[opts.variant ?? 'default'] +
    (opts.small ? ' sfdt-sm' : '') +
    (opts.label ? '' : ' sfdt-icon');

  if (opts.iconName) b.appendChild(glyph(opts.iconName, opts.small ? 14 : 16, doc));
  if (opts.label) {
    const text = doc.createElement('span');
    text.className = 'sfdt-btn-label';
    text.textContent = opts.label;
    b.appendChild(text);
  }

  if (opts.title) b.title = opts.title;
  // Only set aria-label when it adds something: on a labelled button whose
  // visible text already IS the name, a redundant aria-label is noise that can
  // also drift out of sync with the text beside it.
  if (opts.ariaLabel || !opts.label) b.setAttribute('aria-label', name);
  if (opts.disabled) b.disabled = true;
  if (opts.onClick) b.addEventListener('click', opts.onClick);
  return b;
}

/**
 * Change a button's visible text without destroying its glyph.
 *
 * The obvious `btn.textContent = 'Loading…'` wipes every child, glyph included,
 * and the button silently loses its icon for the rest of its life. Since almost
 * every async action does exactly that ("Run" → "Running…" → "Run"), a setter
 * that only touches the label span is the difference between an icon system
 * that survives and one that erodes on first use.
 *
 * Falls back to the button itself for a plain `<button>` that wasn't built here,
 * so it is safe to call during a partial migration.
 */
export function setLabel(btn: HTMLButtonElement, text: string): void {
  const span = btn.querySelector('.sfdt-btn-label');
  if (span) span.textContent = text;
  else btn.textContent = text;
}

/**
 * A decorative icon in the wrapper the component sheet expects.
 *
 * `aria-hidden` is the point: the glyph never carries meaning on its own — the
 * button's label or aria-label does — so announcing it would just repeat the
 * name or, worse, read out an SVG.
 */
export function glyph(name: string, size = 16, doc: Document = document): HTMLElement {
  const span = doc.createElement('span');
  span.className = 'sfdt-glyph';
  span.setAttribute('aria-hidden', 'true');
  span.appendChild(icon(name, size, doc));
  return span;
}

/** A `.sfdt-toolbar` strip. `foot` pins it under the body instead of over it. */
export function toolbar(doc: Document = document, foot = false): HTMLDivElement {
  const bar = doc.createElement('div');
  bar.className = foot ? 'sfdt-toolbar sfdt-toolbar-foot' : 'sfdt-toolbar';
  return bar;
}

export interface FieldOpts {
  placeholder?: string;
  /** Accessible name. Required — a bare input is as unreachable as a bare button. */
  ariaLabel: string;
  type?: string;
  value?: string;
  mono?: boolean;
  doc?: Document;
}

/** Build a `.sfdt-field` input. See ui-styles.ts for why inputs need the class. */
export function field(opts: FieldOpts): HTMLInputElement {
  const doc = opts.doc ?? document;
  const input = doc.createElement('input');
  input.className = opts.mono ? 'sfdt-field sfdt-mono' : 'sfdt-field';
  input.type = opts.type ?? 'text';
  if (opts.placeholder) input.placeholder = opts.placeholder;
  if (opts.value !== undefined) input.value = opts.value;
  input.setAttribute('aria-label', opts.ariaLabel);
  return input;
}

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted' | '';

const TONE_CLASSES = [
  'sfdt-text-ok',
  'sfdt-text-warn',
  'sfdt-text-bad',
  'sfdt-text-info',
  'sfdt-muted',
];

/**
 * Set an element's status colour by MEANING, not by token.
 *
 * This exists because `el.style.color = 'var(--sfdt-color-success-text)'` was
 * the single most-repeated line in the codebase — 44 of them across 15
 * features, several with the wrong token (a fill used as a foreground, which
 * renders low-contrast in dark mode). One function, five names, and the tokens
 * go back to the sheet where a palette change reaches all of them.
 *
 * Removes the other tone classes rather than adding to them: these are
 * mutually-exclusive STATES, and a status line that goes error → success by
 * appending a class keeps the red.
 */
export function setTone(el: HTMLElement, tone: Tone): void {
  el.classList.remove(...TONE_CLASSES);
  if (tone === 'muted') el.classList.add('sfdt-muted');
  else if (tone) el.classList.add(`sfdt-text-${tone}`);
}
