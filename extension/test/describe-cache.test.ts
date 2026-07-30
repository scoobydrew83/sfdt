import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DescribeCache,
  getDescribeCache,
  _resetDescribeCachesForTests,
} from '../lib/describe-cache.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

function fakeApi(overrides: Partial<SalesforceApiClient> = {}): SalesforceApiClient {
  return {
    apiVersion: 'v62.0',
    orgOrigin: null,
    apiGet: vi.fn(async () => ({ sobjects: [], fields: [] })),
    ...overrides,
  } as unknown as SalesforceApiClient;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  _resetDescribeCachesForTests();
});

describe('describe-cache — session singleton (AC-5)', () => {
  it('reuses one instance per org origin across consumers', () => {
    const api = fakeApi({ orgOrigin: 'https://acme.my.salesforce.com' } as Partial<SalesforceApiClient>);
    const a = getDescribeCache(api);
    const b = getDescribeCache(api);
    expect(a).toBe(b);
  });

  it('issues one apiGet per object per session even with two consumers', async () => {
    const apiGet = vi.fn().mockResolvedValue({ name: 'Account', fields: [] });
    const api = fakeApi({ apiGet, orgOrigin: 'https://acme.my.salesforce.com' } as Partial<SalesforceApiClient>);

    // Two independent consumers reach for the shared cache.
    const consumerOne = getDescribeCache(api);
    const consumerTwo = getDescribeCache(api);

    consumerOne.getSObject('rest', 'Account');
    consumerTwo.getSObject('rest', 'Account');
    await tick();
    // A third read after the fetch resolves still hits the cache.
    consumerOne.getSObject('rest', 'Account');

    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it('clear() forces a re-fetch (org switch)', async () => {
    const apiGet = vi.fn().mockResolvedValue({ name: 'Account', fields: [] });
    const api = fakeApi({ apiGet, orgOrigin: 'https://acme.my.salesforce.com' } as Partial<SalesforceApiClient>);

    const cache = getDescribeCache(api);
    cache.getSObject('rest', 'Account');
    await tick();
    expect(apiGet).toHaveBeenCalledTimes(1);

    cache.clear();
    cache.getSObject('rest', 'Account');
    await tick();
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it('separates caches by org origin', () => {
    const orgA = getDescribeCache(fakeApi({ orgOrigin: 'https://a.my.salesforce.com' } as Partial<SalesforceApiClient>));
    const orgB = getDescribeCache(fakeApi({ orgOrigin: 'https://b.my.salesforce.com' } as Partial<SalesforceApiClient>));
    expect(orgA).not.toBe(orgB);
  });
});

describe('describe-cache — listeners', () => {
  it('notifies every subscriber when a describe resolves and unsubscribe stops it', async () => {
    const apiGet = vi.fn().mockResolvedValue({ sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }] });
    const cache = new DescribeCache(fakeApi({ apiGet }));

    const first = vi.fn();
    const second = vi.fn();
    cache.subscribe(first);
    const unsub = cache.subscribe(second);

    cache.getGlobal('rest');
    await tick();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    unsub();
    cache.getSObject('rest', 'Account');
    await tick();
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1); // unsubscribed — not called again
  });

  it('still fires a constructor-supplied onUpdate (back-compat)', async () => {
    const apiGet = vi.fn().mockResolvedValue({ sobjects: [] });
    const onUpdate = vi.fn();
    const cache = new DescribeCache(fakeApi({ apiGet }), onUpdate);
    cache.getGlobal('rest');
    await tick();
    expect(onUpdate).toHaveBeenCalled();
  });
});

// P4-1 declares the edit-relevant describe attributes on FieldDescribe. That is
// a types-only change, and the claim it rests on is behavioural: the cache
// stores the describe payload wholesale, so the attributes are already there.
// This pins that claim so a future "mapping" refactor cannot quietly drop them.
describe('describe-cache — edit-relevant field attributes (P4-1)', () => {
  it('passes the whole field payload through untouched', async () => {
    const wireField = {
      name: 'Status__c',
      label: 'Status',
      type: 'picklist',
      relationshipName: null,
      referenceTo: [],
      picklistValues: [{ value: 'Open', label: 'Open' }],
      nillable: true,
      calculated: false,
      updateable: true,
      createable: true,
      autoNumber: false,
      htmlFormatted: false,
      encrypted: false,
      restrictedPicklist: true,
      dependentPicklist: true,
      controllerName: 'Type__c',
    };
    const apiGet = vi
      .fn()
      .mockResolvedValue({ name: 'Account', label: 'Account', fields: [wireField] });
    const cache = new DescribeCache(fakeApi({ apiGet }));

    cache.getSObject('rest', 'Account');
    await tick();

    const entry = cache.getSObject('rest', 'Account');
    expect(entry.status).toBe('ready');
    expect(entry.data?.fields[0]).toEqual(wireField);
  });
});
