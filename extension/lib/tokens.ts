// Design tokens — the single source of truth for every colour value in the
// extension UI. All three surfaces (content-script features on Salesforce
// pages, the standalone Workspace app page, and the options page) reference
// these as `var(--sfdt-color-*)` custom properties; the raw hex literals live
// ONLY in this file. Consolidating them here is what lets the dark theme (P0-2)
// swap values in one place instead of hunting hard-coded colours across
// forty-odd files.
//
// This file is the documented exception to the "no hard-coded colours" rule
// (the extension's design-token grep gate points here). The only other place a
// raw hex is allowed is the user-configurable highlight colour default in
// features/canvas-search.ts, which is a runtime data value string-concatenated
// with an alpha suffix (`${colour}80`) and therefore cannot be a CSS variable.
//
// DARK MODE (P0-2): every token has a parallel dark value in SFDT_TOKENS_DARK.
// A few P0-1 tokens were overloaded — used as BOTH a saturated background (with
// white text on top) AND as coloured text on a light card. Those two roles need
// opposite values in dark, so the foreground role was split into dedicated
// alias tokens whose LIGHT value is byte-identical to the token they replaced
// (so light rendering is unchanged) and whose DARK value is a bright tint:
//   - color-on-accent   (was: color-surface used as `color:`)  white on fills
//   - color-text-strong (was: color-brand-deep used as `color:`) strong text
//   - color-brand-text  (was: color-brand used as `color:`)     link/accent text
//   - color-error-text  (was: color-error used as `color:`)     error text
//   - color-success-text(was: color-success used as `color:`)   success text
// The background role keeps the original token (color-surface, color-brand, …).

/**
 * Palette derived from the Salesforce Lightning Design System values the UI was
 * already using. Each ORIGINAL token maps 1:1 to exactly one former hex literal
 * (the P0-1 guarantee). The five *-text / on-accent aliases added for dark mode
 * carry the same light value as the token they split from, so light stays
 * pixel-for-pixel identical.
 */
export const SFDT_TOKENS: Record<string, string> = {
  // Brand blues
  'color-brand': '#0070d2',
  'color-brand-active': '#005fb2',
  'color-brand-deep': '#16325c',
  'color-info': '#1589ee',

  // Text / neutrals
  'color-text': '#3e3e3c',
  'color-text-weak': '#54698d',
  'color-text-muted': '#706e6b',
  'color-text-icon': '#80868d',
  'color-text-disabled': '#b0adab',
  'color-text-faint': '#a9a9a9',

  // Surfaces
  'color-surface': '#fff',
  'color-surface-alt': '#fafaf9',
  'color-bg': '#f3f3f3',
  'color-surface-shade': '#f4f6f9',
  'color-surface-shade-2': '#f3f6f9',
  'color-surface-shade-3': '#eef1f4',
  'color-surface-shade-4': '#e9eef3',
  'color-surface-shade-5': '#eef1f6',
  'color-surface-shade-6': '#e1e6eb',

  // Borders
  'color-border': '#d8dde6',
  'color-border-2': '#e0e0e0',
  'color-border-3': '#d4d4d4',

  // Error / red
  'color-error': '#c23934',
  'color-error-bg': '#fef2f1',
  'color-error-bg-2': '#fdf3f2',
  'color-error-bg-3': '#fef6f5',
  'color-error-bg-4': '#fde2e0',
  'color-error-bg-5': '#f9d4d2',
  'color-error-border': '#f4c7c3',

  // Success / green
  'color-success': '#04844b',
  'color-success-2': '#2e844a',
  'color-success-bg': '#ddf3e4',
  'color-success-bg-2': '#f4fbf7',

  // Warning / amber
  'color-warning': '#fe9339',
  'color-warning-text': '#b46600',
  'color-warning-text-2': '#6b5a1f',
  'color-warning-border': '#f4d27a',
  'color-warning-bg': '#fff8e5',
  'color-warning-bg-2': '#fff8e1',
  'color-warning-bg-3': '#fff7eb',
  'color-warning-bg-4': '#fef8f3',
  'color-warning-bg-5': '#fef4ec',
  'color-warning-bg-6': '#fef1e1',

  // Code / editor
  'color-code-bg': '#1e1e1e',

  // Foreground-on-accent + coloured-text aliases (see header note). Light
  // values equal the token each split from, so light rendering is unchanged.
  'color-on-accent': '#fff', // was color-surface used as `color:`
  'color-text-strong': '#16325c', // was color-brand-deep used as `color:`
  'color-brand-text': '#0070d2', // was color-brand used as `color:`
  'color-error-text': '#c23934', // was color-error used as `color:`
  'color-success-text': '#04844b', // was color-success used as `color:`
};

/**
 * Dark palette. Keyed identically to SFDT_TOKENS. Neutrals (surfaces, text,
 * borders, surface tints, semantic *-bg tints) invert to dark; saturated
 * accent FILLS used as button/badge backgrounds (brand, error, success,
 * warning, info) stay saturated so white (`color-on-accent`) text on them
 * keeps its contrast; the coloured-text aliases brighten so coloured text is
 * readable on the dark surface. Values tuned to pass WCAG AA on the key pairs
 * (see test/tokens.test.ts, which asserts the ratios).
 */
export const SFDT_TOKENS_DARK: Record<string, string> = {
  // Brand blues — brand stays a button-friendly blue (white text ≥ 4.5:1);
  // brand-deep stays a navy chrome/chip fill.
  'color-brand': '#1573cf',
  'color-brand-active': '#2a8ae0',
  'color-brand-deep': '#1c3a63',
  'color-info': '#3a97ec',

  // Text / neutrals — light on dark.
  'color-text': '#e6e6e8',
  'color-text-weak': '#aab4c4',
  'color-text-muted': '#adaba8',
  'color-text-icon': '#9aa0a8',
  'color-text-disabled': '#6f6f6d',
  'color-text-faint': '#7f7f7f',

  // Surfaces — near-black neutrals, subtly stepped.
  'color-surface': '#202024',
  'color-surface-alt': '#1a1a1d',
  'color-bg': '#141416',
  'color-surface-shade': '#26272c',
  'color-surface-shade-2': '#26272c',
  'color-surface-shade-3': '#2b2c31',
  'color-surface-shade-4': '#303137',
  'color-surface-shade-5': '#2c2d33',
  'color-surface-shade-6': '#34353b',

  // Borders — visible against the dark surfaces.
  'color-border': '#3a3a41',
  'color-border-2': '#3d3d3d',
  'color-border-3': '#464646',

  // Error / red — `color-error` doubles as button bg (white text) and border;
  // tuned so white (color-on-accent) on it clears AA (4.8:1).
  'color-error': '#c8453e',
  'color-error-bg': '#3a1e1c',
  'color-error-bg-2': '#3a1f1d',
  'color-error-bg-3': '#3d211f',
  'color-error-bg-4': '#4a2522',
  'color-error-bg-5': '#552a27',
  'color-error-border': '#6e3733',

  // Success / green — `color-success` doubles as button bg (white text);
  // tuned so white on it clears AA (5.0:1).
  'color-success': '#158048',
  'color-success-2': '#2e9a5c',
  'color-success-bg': '#153021',
  'color-success-bg-2': '#13251a',

  // Warning / amber — bright amber reads on dark; *-bg tints go dark amber.
  'color-warning': '#f5a04a',
  'color-warning-text': '#e0a94a',
  'color-warning-text-2': '#d8c58c',
  'color-warning-border': '#6e5a2f',
  'color-warning-bg': '#332a12',
  'color-warning-bg-2': '#332a10',
  'color-warning-bg-3': '#33290f',
  'color-warning-bg-4': '#302713',
  'color-warning-bg-5': '#2f2510',
  'color-warning-bg-6': '#2e2410',

  // Code / editor — keep dark.
  'color-code-bg': '#0d0d0d',

  // Foreground-on-accent + coloured-text aliases.
  'color-on-accent': '#ffffff',
  'color-text-strong': '#eef2f8',
  'color-brand-text': '#4aa3f5',
  'color-error-text': '#ff8a82',
  'color-success-text': '#3fce8b',
};

const TOKENS_STYLE_ID = 'sfdt-design-tokens';

/** Attribute the resolved theme is written to on the document root. */
export const THEME_ATTR = 'data-sfdt-theme';

function declarations(tokens: Record<string, string>, indent = '  '): string {
  return Object.entries(tokens)
    .map(([name, value]) => `${indent}--sfdt-${name}: ${value};`)
    .join('\n');
}

/**
 * The full token stylesheet:
 *   1. `:root { … }`                              — light (default; byte-identical to P0-1)
 *   2. `:root[data-sfdt-theme="dark"] { … }`      — explicit dark (manual override wins)
 *   3. `@media (prefers-color-scheme: dark)`      — `auto` fallback before JS resolves it,
 *        `:root:not([data-sfdt-theme])`             and never overriding an explicit choice
 *
 * JS (`applyTheme` in lib/theme.ts) sets the attribute to the resolved
 * light|dark value, so post-boot rendering is attribute-driven; the media
 * block only covers the pre-JS `auto` flash.
 */
export const SFDT_TOKENS_CSS = `:root {
${declarations(SFDT_TOKENS)}
}
:root[${THEME_ATTR}="dark"] {
${declarations(SFDT_TOKENS_DARK)}
}
@media (prefers-color-scheme: dark) {
  :root:not([${THEME_ATTR}]) {
${declarations(SFDT_TOKENS_DARK, '    ')}
  }
}`;

/**
 * Idempotently inject the token custom properties into a document's head so
 * every `var(--sfdt-*)` reference (inline styles on content-script elements,
 * SVG fills, injected stylesheets) resolves. Safe to call repeatedly.
 */
export function ensureTokens(doc: Document = document): void {
  if (doc.getElementById(TOKENS_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = TOKENS_STYLE_ID;
  style.textContent = SFDT_TOKENS_CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}
