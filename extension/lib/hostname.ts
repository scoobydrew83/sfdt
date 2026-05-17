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

export function setupHostname(hostname: string): string {
  if (hostname.includes('.salesforce-setup.com')) return hostname;
  return `${orgIdentifier(hostname)}.my.salesforce-setup.com`;
}

export function lightningHostname(hostname: string): string {
  if (hostname.includes('.lightning.force.com')) return hostname;
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
  if (hostname.includes('.my.salesforce.com')) return hostname;
  if (
    hostname.includes('.lightning.force.com') ||
    hostname.includes('.salesforce-setup.com')
  ) {
    const middle = middleSegmentOf(hostname);
    return middle === null
      ? `${orgIdentifier(hostname)}.my.salesforce.com`
      : `${orgIdentifier(hostname)}.${middle}.my.salesforce.com`;
  }
  return null;
}
