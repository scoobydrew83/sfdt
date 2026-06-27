/**
 * Pure helpers for the embedded dashboard: extract the one-time launch token
 * from `sfdt ui` stdout, and build a deep-linked, tokened GUI URL. Free of any
 * `vscode` import so it is unit-testable.
 */

/** Pull the launch token out of an `sfdt ui` stdout chunk (ANSI-tolerant). */
export function parseLaunchToken(text: string): string | undefined {
  const match = text.match(/[?&]token=([A-Za-z0-9_-]+)/);
  return match ? match[1] : undefined;
}

/** Build the embedded GUI URL for a page, appending the token when known. */
export function dashboardPageUrl(port: number, page?: string, token?: string): string {
  const path = page ? `/${page.replace(/^\/+/, '')}` : '/';
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  return `http://localhost:${port}${path}${query}`;
}
