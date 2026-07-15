// Design tokens — the single source of truth for every colour value in the
// extension UI. All three surfaces (content-script features on Salesforce
// pages, the standalone Workspace app page, and the options page) reference
// these as `var(--sfdt-color-*)` custom properties; the raw hex literals live
// ONLY in this file. Consolidating them here is what lets a future dark theme
// (P0-2) swap values in one place instead of hunting hard-coded colours across
// forty-odd files.
//
// This file is the documented exception to the "no hard-coded colours" rule
// (the extension's design-token grep gate points here). The only other place a
// raw hex is allowed is the user-configurable highlight colour default in
// features/canvas-search.ts, which is a runtime data value string-concatenated
// with an alpha suffix (`${colour}80`) and therefore cannot be a CSS variable.

/**
 * Palette derived from the Salesforce Lightning Design System values the UI was
 * already using. Each token maps 1:1 to exactly one former hex literal, so this
 * refactor is provably pixel-for-pixel identical — a token always resolves to
 * the single value it replaced.
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
};

const TOKENS_STYLE_ID = 'sfdt-design-tokens';

/** The `:root { --sfdt-*: … }` block. The one place raw hex literals live. */
export const SFDT_TOKENS_CSS = `:root {\n${Object.entries(SFDT_TOKENS)
  .map(([name, value]) => `  --sfdt-${name}: ${value};`)
  .join('\n')}\n}`;

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
