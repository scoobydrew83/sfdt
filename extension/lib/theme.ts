// Theme resolution + application (P0-2 dark mode).
//
// The user's choice is a single global preference (`settings.theme`:
// 'light' | 'dark' | 'auto', default 'auto') — NOT a kill-switchable content
// feature, so it lives on the top-level Settings shape alongside `telemetry`
// and `bridge`, not in the feature registry. `auto` follows the OS via
// `prefers-color-scheme`, live; a manual 'light'/'dark' wins over the OS.
//
// Rendering is CSS-token-driven (see lib/tokens.ts): applyTheme() writes the
// RESOLVED light|dark value to `data-sfdt-theme` on the document root, which
// selects the matching `:root[data-sfdt-theme=…]` block. The token stylesheet's
// `@media (prefers-color-scheme: dark)` block only covers the flash before this
// runs. Every surface calls watchTheme() on boot.

import { THEME_ATTR } from './tokens.js';
import { loadSettings, onSettingsChange } from './settings.js';

/**
 * For our OWN full-page surfaces (the Workspace app + options page) only:
 * make native form controls, scrollbars, and default backgrounds follow the
 * resolved theme. Deliberately NOT injected on Salesforce pages — there our
 * token block sits on the host document's `:root`, and a `color-scheme` there
 * would restyle Salesforce's own native controls.
 */
export const OWN_PAGE_COLOR_SCHEME_CSS = `:root[${THEME_ATTR}="dark"] { color-scheme: dark; }
:root[${THEME_ATTR}="light"] { color-scheme: light; }
@media (prefers-color-scheme: dark) { :root:not([${THEME_ATTR}]) { color-scheme: dark; } }`;

export type ThemeSetting = 'light' | 'dark' | 'auto';
export type EffectiveTheme = 'light' | 'dark';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Pure: the stored setting plus the OS preference → the theme actually
 * rendered. Manual choices ignore the OS; `auto` follows it.
 */
export function resolveEffectiveTheme(setting: ThemeSetting, prefersDark: boolean): EffectiveTheme {
  if (setting === 'light' || setting === 'dark') return setting;
  return prefersDark ? 'dark' : 'light';
}

function osPrefersDark(win: Window): boolean {
  return win.matchMedia ? win.matchMedia(DARK_QUERY).matches : false;
}

/**
 * Resolve `setting` against the OS and write the result to the document root.
 * Returns the effective theme applied.
 */
export function applyTheme(setting: ThemeSetting, doc: Document = document): EffectiveTheme {
  const win = doc.defaultView ?? globalThis.window;
  const effective = resolveEffectiveTheme(setting, win ? osPrefersDark(win) : false);
  doc.documentElement.setAttribute(THEME_ATTR, effective);
  return effective;
}

export interface ThemeController {
  /**
   * Override the active setting and apply it immediately — used by the options
   * page for unsaved live preview. Crucially it updates the tracked setting the
   * OS-scheme listener reads, so a `prefers-color-scheme` flip during an unsaved
   * preview re-applies the PREVIEWED choice (manual wins) instead of reverting
   * to the stored/`auto` value.
   */
  setSetting(next: ThemeSetting): void;
  /** Detach the OS-scheme and settings listeners. */
  stop(): void;
}

/**
 * Boot the theme on a surface: apply the stored setting immediately, then keep
 * it live — re-apply when the OS scheme flips (only changes anything while the
 * effective setting is `auto`) and when the setting itself changes (options
 * page / other tab, via chrome.storage). Returns a controller: `setSetting` for
 * live preview and `stop` to detach.
 */
export function watchTheme(doc: Document = document): ThemeController {
  const win = doc.defaultView ?? globalThis.window;
  let setting: ThemeSetting = 'auto';

  const setSetting = (next: ThemeSetting): void => {
    setting = next;
    applyTheme(setting, doc);
  };

  void loadSettings().then((s) => setSetting(s.theme));

  const mql = win?.matchMedia ? win.matchMedia(DARK_QUERY) : null;
  const onMediaChange = (): void => {
    applyTheme(setting, doc);
  };
  mql?.addEventListener('change', onMediaChange);

  const unsubscribeSettings = onSettingsChange((s) => setSetting(s.theme));

  return {
    setSetting,
    stop() {
      mql?.removeEventListener('change', onMediaChange);
      unsubscribeSettings();
    },
  };
}
