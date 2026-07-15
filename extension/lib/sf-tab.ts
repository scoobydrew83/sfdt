// Shared "is the active browser tab a Salesforce page, and which org?" helper.
// Kept pure (no chrome.*) so both the action popup (lib/popup.ts) and the
// background command router (lib/commands.ts) can unit-test against it. The
// suffix list mirrors the content script's match patterns and the background
// cookie allowlist — a URL only counts as Salesforce over https on one of these
// suffixes.

const SALESFORCE_HOST_SUFFIXES = [
  '.salesforce.com',
  '.salesforce-setup.com',
  '.lightning.force.com',
  '.force.com',
  '.visualforce.com',
] as const;

/**
 * Return the Salesforce host of a tab URL, or null when the URL is not a
 * Salesforce page (non-https, unparseable, or a non-Salesforce host). The org
 * identity downstream code needs is just this hostname.
 */
export function salesforceHostFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  return SALESFORCE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ? host : null;
}
