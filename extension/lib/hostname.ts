// Salesforce serves one org through three hostnames:
//   <org>.lightning.force.com       — Lightning UI
//   <org>.my.salesforce-setup.com   — Setup tree
//   <org>.my.salesforce.com         — REST/Tooling APIs
//
// Always rebuild target hostnames from the first segment (the org id) only.
// Post-Enhanced-Domains and dev-edition orgs have one segment before the
// suffix, so blindly reusing the input's middle segments produces
// non-existent DNS names (DNS_PROBE_FINISHED_NXDOMAIN).
//
// Exception: sandbox / scratch / develop / trailblaze orgs carry the middle
// segment in their Lightning + API hostnames, so detect and re-insert it.

const KNOWN_MIDDLE_SEGMENTS = ['sandbox', 'develop', 'scratch', 'trailblaze'] as const;

// Suffix-anchored matches. `includes` would also accept hostile hostnames like
// `evil.lightning.force.com.attacker.com`; `endsWith` requires the Salesforce
// suffix to be the actual end of the hostname.
function hasSuffix(hostname: string, suffix: string): boolean {
  return hostname.endsWith(suffix);
}

function orgIdentifier(hostname: string): string {
  const first = hostname.split('.')[0];
  return first ?? hostname;
}

function middleSegmentOf(hostname: string): string | null {
  // Only meaningful when the caller has already confirmed the input is a
  // Salesforce hostname via hasSuffix(). Detects "<org>.<segment>.<suffix>".
  for (const segment of KNOWN_MIDDLE_SEGMENTS) {
    if (hostname.includes(`.${segment}.`)) return segment;
  }
  return null;
}

export function setupHostname(hostname: string): string {
  if (hasSuffix(hostname, '.salesforce-setup.com')) return hostname;
  return `${orgIdentifier(hostname)}.my.salesforce-setup.com`;
}

export function lightningHostname(hostname: string): string {
  if (hasSuffix(hostname, '.lightning.force.com')) return hostname;
  const middle = middleSegmentOf(hostname);
  return middle === null
    ? `${orgIdentifier(hostname)}.lightning.force.com`
    : `${orgIdentifier(hostname)}.${middle}.lightning.force.com`;
}

// Symmetric with lightningHostname: sandbox / scratch / develop / trailblaze
// orgs keep the middle segment (e.g. <org>.develop.my.salesforce.com). Stripping
// it produces a non-existent host and the cookie lookup returns nothing,
// surfacing as 401 INVALID_SESSION_ID.
export function mySalesforceHostname(hostname: string): string | null {
  if (hasSuffix(hostname, '.my.salesforce.com')) return hostname;
  if (
    hasSuffix(hostname, '.lightning.force.com') ||
    hasSuffix(hostname, '.salesforce-setup.com')
  ) {
    const middle = middleSegmentOf(hostname);
    return middle === null
      ? `${orgIdentifier(hostname)}.my.salesforce.com`
      : `${orgIdentifier(hostname)}.${middle}.my.salesforce.com`;
  }
  return null;
}
