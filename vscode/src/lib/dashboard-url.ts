/**
 * Pure helpers for the embedded dashboard: extract the one-time launch token
 * from `sfdt ui` stdout, and build a deep-linked, tokened GUI URL. Free of any
 * `vscode` import so it is unit-testable.
 */

import { URLSearchParams } from 'node:url';

/** Pull the launch token out of an `sfdt ui` stdout chunk (ANSI-tolerant). */
export function parseLaunchToken(text: string): string | undefined {
  const match = text.match(/[?&]token=([A-Za-z0-9_-]+)/);
  return match ? match[1] : undefined;
}

/** Build the embedded GUI URL for a page, appending the token + theme when known. */
export function dashboardPageUrl(
  port: number,
  page?: string,
  token?: string,
  theme?: 'dark' | 'light',
): string {
  const path = page ? `/${page.replace(/^\/+/, '')}` : '/';
  const params = new URLSearchParams();
  if (token) params.set('token', token);
  if (theme) params.set('theme', theme);
  const query = params.toString();
  return `http://localhost:${port}${path}${query ? `?${query}` : ''}`;
}

/**
 * Map a VS Code `ColorThemeKind` to the GUI's theme hint. Light(1) and
 * HighContrastLight(4) are light; Dark(2) and HighContrast(3) are dark.
 * Takes the raw numeric kind so this stays free of the `vscode` import.
 */
export function themeQueryFromKind(kind: number): 'dark' | 'light' {
  return kind === 1 || kind === 4 ? 'light' : 'dark';
}
