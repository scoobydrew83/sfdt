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
//
// Three domain families are supported (P0-5 added gov-cloud + China):
//   .com  — standard commercial cloud
//   .mil  — US gov-cloud (GovCloud) — <org>.my.salesforce.mil / .lightning.force.mil
//   .cn   — China (Alibaba-operated) — <org>.my.sfcrmapps.cn / .lightning.sfcrmapps.cn
// Microsoft Defender (`.mcas.ms`) reverse-proxied hosts do NOT map to a
// canonical my.* API host — the sid cookie lives on the proxy origin and the
// API must go back through the proxy — so they resolve to null here and the
// proxy falls back to the page (proxied) origin.

const KNOWN_MIDDLE_SEGMENTS = ['sandbox', 'develop', 'scratch', 'trailblaze'] as const;

interface HostFamily {
  // Suffix of the REST/Tooling API host (also the host this family builds).
  api: string;
  // Suffix of the Lightning UI host.
  lightning: string;
  // Suffix of the Setup host, when known for this family.
  setup?: string;
}

// Suffixes are the fully-built host suffixes (e.g. `.my.salesforce-setup.com`),
// so a real host both matches (endsWith) and is reconstructed from them.
const FAMILIES: readonly HostFamily[] = [
  { api: '.my.salesforce.com', lightning: '.lightning.force.com', setup: '.my.salesforce-setup.com' },
  // US gov-cloud (GovCloud). Mirrors the .com structure on the .mil TLD.
  { api: '.my.salesforce.mil', lightning: '.lightning.force.mil', setup: '.my.salesforce-setup.mil' },
  // Salesforce China (数据驻留中国 / Alibaba Cloud operated). Setup host suffix
  // is not documented, so setup is omitted — Setup pages fall back cleanly.
  { api: '.my.sfcrmapps.cn', lightning: '.lightning.sfcrmapps.cn' },
];

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

// Rebuild `<org>[.<middle>]<suffix>` from an existing Salesforce hostname.
function rebuild(hostname: string, suffix: string): string {
  const middle = middleSegmentOf(hostname);
  const org = orgIdentifier(hostname);
  return middle === null ? `${org}${suffix}` : `${org}.${middle}${suffix}`;
}

export function setupHostname(hostname: string): string {
  for (const fam of FAMILIES) {
    if (fam.setup && hasSuffix(hostname, fam.setup)) return hostname;
  }
  for (const fam of FAMILIES) {
    if (!fam.setup) continue;
    if (hasSuffix(hostname, fam.api) || hasSuffix(hostname, fam.lightning)) {
      // Setup hosts never carry the sandbox middle segment (historical behaviour).
      return `${orgIdentifier(hostname)}${fam.setup}`;
    }
  }
  return `${orgIdentifier(hostname)}.my.salesforce-setup.com`;
}

export function lightningHostname(hostname: string): string {
  for (const fam of FAMILIES) {
    if (hasSuffix(hostname, fam.lightning)) return hostname;
  }
  for (const fam of FAMILIES) {
    if (hasSuffix(hostname, fam.api) || (fam.setup && hasSuffix(hostname, fam.setup))) {
      return rebuild(hostname, fam.lightning);
    }
  }
  // Unknown host — default to the .com Lightning suffix (prior behaviour).
  return rebuild(hostname, '.lightning.force.com');
}

// Symmetric with lightningHostname: sandbox / scratch / develop / trailblaze
// orgs keep the middle segment (e.g. <org>.develop.my.salesforce.com). Stripping
// it produces a non-existent host and the cookie lookup returns nothing,
// surfacing as 401 INVALID_SESSION_ID. Returns null for hosts that don't belong
// to a known family (e.g. Defender `.mcas.ms` proxies), so the caller falls back
// to the page origin instead of fabricating an unreachable API host.
export function mySalesforceHostname(hostname: string): string | null {
  for (const fam of FAMILIES) {
    if (hasSuffix(hostname, fam.api)) return hostname;
  }
  for (const fam of FAMILIES) {
    if (hasSuffix(hostname, fam.lightning) || (fam.setup && hasSuffix(hostname, fam.setup))) {
      return rebuild(hostname, fam.api);
    }
  }
  return null;
}
