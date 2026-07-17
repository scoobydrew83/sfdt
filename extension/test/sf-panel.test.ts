// Unit tests for the pure side-panel decision helpers (lib/sf-panel.ts) — the
// chrome-free logic behind org-follow (behaviour A) and auto-enable (behaviour
// B) in P2-3 PR-2. The chrome glue (background listeners, the panel's message
// handler) is esbuild-bundled and delegates to these, so testing these covers
// the make-or-break logic.

import { describe, it, expect } from 'vitest';
import {
  isAllowedSfHost,
  panelOrgForUrl,
  panelEnabledForUrl,
  shouldRebindPanel,
} from '../lib/sf-panel.js';

const ACME_LIGHTNING = 'https://acme.lightning.force.com/lightning/page/home';
const ACME_MY = 'https://acme.my.salesforce.com/0015g00000abcde';
const GLOBEX_LIGHTNING = 'https://globex.lightning.force.com/lightning/setup/SetupOneHome/home';

describe('isAllowedSfHost', () => {
  it.each(['acme.lightning.force.com', 'acme.my.salesforce.com', 'acme.salesforce-setup.com'])(
    'accepts %s',
    (host) => expect(isAllowedSfHost(host)).toBe(true),
  );
  it.each(['example.com', 'evil.lightning.force.com.attacker.net', ''])('rejects %s', (host) =>
    expect(isAllowedSfHost(host)).toBe(false),
  );
});

describe('panelOrgForUrl / panelEnabledForUrl (auto-enable predicate, behaviour B)', () => {
  it('returns the org host for a Salesforce tab', () => {
    expect(panelOrgForUrl(ACME_LIGHTNING)).toBe('acme.lightning.force.com');
    expect(panelEnabledForUrl(ACME_LIGHTNING)).toBe(true);
  });
  it('is null/false for a non-Salesforce tab', () => {
    expect(panelOrgForUrl('https://example.com/')).toBeNull();
    expect(panelEnabledForUrl('https://example.com/')).toBe(false);
  });
  it('is null/false for http (non-https) and undefined', () => {
    expect(panelEnabledForUrl('http://acme.lightning.force.com/')).toBe(false);
    expect(panelEnabledForUrl(undefined)).toBe(false);
    expect(panelOrgForUrl(null)).toBeNull();
  });
});

describe('shouldRebindPanel (org-follow, behaviour A)', () => {
  it('does NOT rebind when switching to the SAME org (different hostname of it)', () => {
    // Panel bound to the my.salesforce.com host; user tabs to the org's Lightning
    // UI — same org, so no needless rebind.
    expect(shouldRebindPanel('acme.my.salesforce.com', ACME_LIGHTNING)).toBeNull();
    // And the exact same host is trivially no rebind.
    expect(shouldRebindPanel('acme.lightning.force.com', ACME_LIGHTNING)).toBeNull();
  });

  it('rebinds when switching to a DIFFERENT allowed org', () => {
    expect(shouldRebindPanel('acme.lightning.force.com', GLOBEX_LIGHTNING)).toBe(
      'globex.lightning.force.com',
    );
  });

  it('does NOT rebind (keeps current org) on a non-Salesforce tab', () => {
    expect(shouldRebindPanel('acme.lightning.force.com', 'https://example.com/')).toBeNull();
    expect(shouldRebindPanel('acme.lightning.force.com', undefined)).toBeNull();
    expect(shouldRebindPanel('acme.lightning.force.com', null)).toBeNull();
  });

  it('follows across the my.salesforce.com / lightning.force.com identity boundary', () => {
    // Bound to acme lightning; a globex my.salesforce.com API host tab → rebind.
    expect(shouldRebindPanel('acme.lightning.force.com', ACME_MY)).toBeNull(); // same org
    expect(shouldRebindPanel('globex.lightning.force.com', ACME_MY)).toBe('acme.my.salesforce.com');
  });
});
