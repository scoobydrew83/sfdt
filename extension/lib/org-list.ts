// Pure helper for the Multi-org switcher: turn the browser's `sid` cookies into
// a deduped list of Salesforce orgs the user is currently logged in to. Kept
// pure (no chrome.* access) so it is unit-testable; the background service
// worker supplies the cookies and the host allowlist.

import { mySalesforceHostname } from './hostname.js';

export interface OrgEntry {
  /** Canonical my.salesforce.com host — the org's API identity. */
  host: string;
  /** Friendly label (the org subdomain). */
  displayName: string;
}

export interface CookieLike {
  domain: string;
}

// One org serves three cookie domains (lightning.force.com, my.salesforce.com,
// salesforce-setup.com). Collapse each to its my.salesforce.com host so the
// switcher shows one entry per org. Sandboxes keep their middle segment via
// mySalesforceHostname(), so prod and sandbox of the same base org stay
// distinct. Non-Salesforce domains are dropped.
export function dedupeOrgs(
  cookies: readonly CookieLike[],
  isAllowedDomain: (domain: string) => boolean,
): OrgEntry[] {
  const byHost = new Map<string, OrgEntry>();
  for (const c of cookies) {
    const domain = c.domain.replace(/^\./, '').toLowerCase();
    if (!isAllowedDomain(domain)) continue;
    const canonical = mySalesforceHostname(domain) ?? domain;
    if (!byHost.has(canonical)) {
      byHost.set(canonical, {
        host: canonical,
        displayName: canonical.split('.')[0] ?? canonical,
      });
    }
  }
  return Array.from(byHost.values()).sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );
}
