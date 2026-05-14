// Hostname construction helpers — extracted from
// /Users/dkennedy/dev/2.0.2_0 copy/features/setup-tabs.js:415-447.
//
// Salesforce serves the same org through three different hostnames:
//
//   <org>.lightning.force.com       — the Lightning Experience UI
//   <org>.my.salesforce-setup.com   — the Setup tree
//   <org>.my.salesforce.com         — the REST/Tooling APIs
//
// Setup Tabs and the side button need to navigate between these without
// silently producing a non-existent hostname. v1.2.2 fixed a class of bugs
// where a two-segment construction like `<org>.<segment>.my.salesforce-
// setup.com` was emitted regardless of whether the source org actually had
// a `.my.` segment — newer dev-edition orgs and post-Enhanced-Domains
// rollouts only have one segment before the suffix, so the wrong DNS name
// is generated and the browser shows DNS_PROBE_FINISHED_NXDOMAIN. The
// forward-port to v2.0.0 (CHANGELOG-v2.0.0.md:60-95) preserves the v1.2.2
// behaviour: extract just the first segment (the org identifier) and
// rebuild from there.
//
// Salesforce sandbox / scratch hosts keep the middle segment in their
// Lightning hostname (e.g. `<org>.sandbox.lightning.force.com`); detect
// that from the input hostname and re-insert it.

const KNOWN_MIDDLE_SEGMENTS = ['sandbox', 'develop', 'scratch', 'trailblaze'] as const;

function orgIdentifier(hostname: string): string {
  const first = hostname.split('.')[0];
  return first ?? hostname;
}

function middleSegmentOf(hostname: string): string | null {
  for (const segment of KNOWN_MIDDLE_SEGMENTS) {
    if (hostname.includes(`.${segment}.`)) return segment;
  }
  return null;
}

/**
 * Return the Setup hostname for whichever org the input hostname belongs to.
 * Always returns a `.my.salesforce-setup.com` variant rooted on the org's
 * first-segment identifier.
 */
export function setupHostname(hostname: string): string {
  if (hostname.includes('.salesforce-setup.com')) return hostname;
  return `${orgIdentifier(hostname)}.my.salesforce-setup.com`;
}

/**
 * Return the Lightning hostname for the org. Honours the sandbox /
 * develop / scratch / trailblaze middle segment so e.g.
 * `<org>.sandbox.lightning.force.com` is generated for sandbox sources.
 */
export function lightningHostname(hostname: string): string {
  if (hostname.includes('.lightning.force.com')) return hostname;
  const middle = middleSegmentOf(hostname);
  return middle === null
    ? `${orgIdentifier(hostname)}.lightning.force.com`
    : `${orgIdentifier(hostname)}.${middle}.lightning.force.com`;
}

/**
 * Return the `.my.salesforce.com` host for API calls. Used by the
 * Salesforce REST/Tooling-API client. Mirrors the mapping in
 * /Users/dkennedy/dev/2.0.2_0 copy/utils/salesforce-api.js:70-88.
 */
export function mySalesforceHostname(hostname: string): string | null {
  if (hostname.includes('.my.salesforce.com')) return hostname;
  if (
    hostname.includes('.lightning.force.com') ||
    hostname.includes('.salesforce-setup.com')
  ) {
    return `${orgIdentifier(hostname)}.my.salesforce.com`;
  }
  return null;
}
