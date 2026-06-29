/**
 * Resolve the initial theme for the dashboard. Precedence:
 *   1. `?theme=dark|light` query param — set by the VS Code extension so the
 *      embedded dashboard matches the editor theme.
 *   2. The `sfdt-theme` localStorage value (the user's saved toggle).
 *   3. Default to dark.
 * Returns true for dark, false for light. Pure so it can be unit-tested.
 *
 * @param {string} search  window.location.search (e.g. "?token=…&theme=light")
 * @param {string|null} saved  localStorage 'sfdt-theme' value
 * @returns {boolean} true = dark
 */
export function resolveInitialTheme(search, saved) {
  const param = new URLSearchParams(search).get('theme');
  if (param === 'light') return false;
  if (param === 'dark') return true;
  if (saved === 'light') return false;
  if (saved === 'dark') return true;
  return true;
}
