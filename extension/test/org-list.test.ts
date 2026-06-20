import { describe, it, expect } from 'vitest';
import { dedupeOrgs } from '../lib/org-list.js';

const SF_SUFFIXES = [
  '.salesforce.com',
  '.salesforce-setup.com',
  '.lightning.force.com',
  '.force.com',
];
const isAllowed = (d: string): boolean => SF_SUFFIXES.some((s) => d.endsWith(s));

describe('org-list — dedupeOrgs', () => {
  it('collapses an org’s lightning/my/setup cookies into a single entry', () => {
    const orgs = dedupeOrgs(
      [
        { domain: 'acme.lightning.force.com' },
        { domain: 'acme.my.salesforce.com' },
        { domain: 'acme.my.salesforce-setup.com' },
      ],
      isAllowed,
    );
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toEqual({ host: 'acme.my.salesforce.com', displayName: 'acme' });
  });

  it('drops non-Salesforce domains', () => {
    const orgs = dedupeOrgs(
      [{ domain: 'evil.example.com' }, { domain: 'acme.my.salesforce.com' }],
      isAllowed,
    );
    expect(orgs.map((o) => o.host)).toEqual(['acme.my.salesforce.com']);
  });

  it('keeps prod and sandbox of the same base org distinct', () => {
    const orgs = dedupeOrgs(
      [
        { domain: 'acme.lightning.force.com' },
        { domain: 'acme.sandbox.lightning.force.com' },
      ],
      isAllowed,
    );
    expect(orgs.map((o) => o.host).sort()).toEqual([
      'acme.my.salesforce.com',
      'acme.sandbox.my.salesforce.com',
    ]);
  });

  it('strips a leading dot from cookie domains', () => {
    const orgs = dedupeOrgs([{ domain: '.acme.my.salesforce.com' }], isAllowed);
    expect(orgs[0]?.host).toBe('acme.my.salesforce.com');
  });

  it('returns an empty list when nothing matches', () => {
    expect(dedupeOrgs([], isAllowed)).toEqual([]);
  });
});
