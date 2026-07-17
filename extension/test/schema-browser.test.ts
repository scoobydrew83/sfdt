import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSchemaBrowserFeature } from '../features/schema-browser.js';
import { _resetDescribeCachesForTests, getDescribeCache } from '../lib/describe-cache.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

const tick = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

const SETUP_URL = 'https://acme.lightning.force.com/lightning/setup/SetupOneHome/home';

let orgCounter = 0;

interface FieldFixture {
  name: string;
  label: string;
  type: string;
  nillable?: boolean;
  calculated?: boolean;
  calculatedFormula?: string | null;
  length?: number;
  relationshipName?: string | null;
  referenceTo?: string[];
  picklistValues?: { value: string; label: string }[];
  compoundFieldName?: string | null;
}

function field(f: FieldFixture) {
  return {
    nillable: true,
    calculated: false,
    relationshipName: null,
    referenceTo: [],
    picklistValues: [],
    ...f,
  };
}

interface Fixtures {
  sobjects: { name: string; label: string; keyPrefix: string | null }[];
  describes: Record<string, unknown>;
}

function makeApi(fixtures: Fixtures): SalesforceApiClient {
  const apiGet = vi.fn(async (endpoint: string) => {
    if (endpoint.endsWith('/sobjects/')) return { sobjects: fixtures.sobjects };
    const m = /\/sobjects\/([^/]+)\/describe/.exec(endpoint);
    if (m) {
      return (
        fixtures.describes[m[1]!] ?? { name: m[1], label: m[1], fields: [], childRelationships: [] }
      );
    }
    return {};
  });
  return {
    apiVersion: 'v62.0',
    orgOrigin: `https://t${orgCounter++}.my.salesforce.com`,
    apiGet,
    query: vi.fn(),
    toolingQuery: vi.fn(),
    apiRequest: vi.fn(),
  } as unknown as SalesforceApiClient;
}

function fakeWin(href = SETUP_URL, writeText = vi.fn(async () => {})): Window {
  return {
    location: { href },
    navigator: { clipboard: { writeText } },
  } as unknown as Window;
}

function clearBody(): void {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
}

beforeEach(() => clearBody());
afterEach(() => _resetDescribeCachesForTests());

describe('schema-browser — object list windowing (AC-1)', () => {
  function manyObjects(count: number): Fixtures {
    const sobjects = Array.from({ length: count }, (_, i) => ({
      name: `Obj${i}__c`,
      label: `Object ${i}`,
      keyPrefix: null,
    }));
    return { sobjects, describes: {} };
  }

  it('renders a bounded window over an 800+ object org', async () => {
    const api = makeApi(manyObjects(900));
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api });
    await feature.onActivate!();
    await tick();

    const options = document.querySelectorAll('[role="option"]');
    // Windowed: far fewer than 900 rows built up front.
    expect(options.length).toBeLessThanOrEqual(50);
    expect(options.length).toBeGreaterThan(0);
  });

  it('narrows the visible set as the filter is typed', async () => {
    const api = makeApi(manyObjects(900));
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api });
    await feature.onActivate!();
    await tick();

    const filter = document.getElementById('sfdt-schema-object-filter') as HTMLInputElement;
    expect(filter).toBeTruthy();
    // 'obj123' matches only Obj123__c (the label "Object 123" has a space).
    filter.value = 'obj123';
    filter.dispatchEvent(new Event('input'));

    const options = document.querySelectorAll('[role="option"]');
    expect(options.length).toBe(1);
    expect(options[0]!.textContent).toContain('Obj123__c');
  });
});

describe('schema-browser — field table (AC-2)', () => {
  const fixtures: Fixtures = {
    sobjects: [
      { name: 'Account', label: 'Account', keyPrefix: '001' },
      { name: 'Contact', label: 'Contact', keyPrefix: '003' },
    ],
    describes: {
      Account: {
        name: 'Account',
        label: 'Account',
        fields: [
          field({ name: 'Name', label: 'Account Name', type: 'string', length: 255, nillable: false }),
          field({
            name: 'Industry',
            label: 'Industry',
            type: 'picklist',
            picklistValues: [
              { value: 'Tech', label: 'Tech' },
              { value: 'Finance', label: 'Finance' },
            ],
          }),
          field({
            name: 'OwnerId',
            label: 'Owner',
            type: 'reference',
            nillable: false,
            relationshipName: 'Owner',
            referenceTo: ['Contact'],
          }),
          field({ name: 'BillingAddress', label: 'Billing Address', type: 'address' }),
          field({
            name: 'BillingStreet',
            label: 'Billing Street',
            type: 'string',
            compoundFieldName: 'BillingAddress',
          }),
        ],
        childRelationships: [{ childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts' }],
      },
      Contact: {
        name: 'Contact',
        label: 'Contact',
        fields: [field({ name: 'LastName', label: 'Last Name', type: 'string', length: 80, nillable: false })],
        childRelationships: [],
      },
    },
  };

  it('flattens a compound field onto its parent row', async () => {
    const api = makeApi(fixtures);
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api });
    await feature.openFor('Account');
    await tick();

    const bodyText = document.body.textContent ?? '';
    expect(bodyText).toContain('BillingAddress');
    // The compound parent lists its component fields inline.
    expect(bodyText).toContain('Components: BillingStreet');
  });

  it('expands a picklist to its values on demand', async () => {
    const api = makeApi(fixtures);
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api });
    await feature.openFor('Account');
    await tick();

    const toggle = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent?.startsWith('Picklist'),
    ) as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // The values are now visible next to the toggle.
    const values = toggle.nextElementSibling as HTMLElement;
    expect(values.style.display).toBe('block');
    expect(values.textContent).toContain('Tech');
    expect(values.textContent).toContain('Finance');
  });

  it('keeps an expanded picklist open when an unrelated describe resolves (shared cache)', async () => {
    const api = makeApi(fixtures);
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api });
    await feature.openFor('Account');
    await tick();

    const toggle = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent?.startsWith('Picklist'),
    ) as HTMLButtonElement;
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    // Another tool describes a DIFFERENT object through the same shared cache,
    // firing the cache's subscribe while Account is still shown. The detail pane
    // must NOT be torn down (which would collapse the open picklist).
    getDescribeCache(api).getSObject('rest', 'Contact');
    await tick();

    const toggleAfter = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent?.startsWith('Picklist'),
    ) as HTMLButtonElement;
    expect(toggleAfter).toBe(toggle); // same node — the pane was not rebuilt
    expect(toggleAfter.getAttribute('aria-expanded')).toBe('true');
  });

  it('renders a reference target as a link whose activation calls openFor(target)', async () => {
    const api = makeApi(fixtures);
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api });
    await feature.openFor('Account');
    await tick();
    expect(document.querySelector('h2')?.textContent).toBe('Account');

    const link = Array.from(document.querySelectorAll('a')).find((a) => a.textContent === 'Contact');
    expect(link).toBeTruthy();

    // Activating the reference link jumps the tool to the target object in place
    // (the link handler calls openFor(target) → selectObject).
    link!.click();
    await tick();
    expect(document.querySelector('h2')?.textContent).toBe('Contact');
  });

  it('copies the field API name via navigator.clipboard', async () => {
    const writeText = vi.fn(async () => {});
    const api = makeApi(fixtures);
    const feature = createSchemaBrowserFeature({ win: fakeWin(SETUP_URL, writeText), api });
    await feature.openFor('Account');
    await tick();

    const copyBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Copy API name Name',
    ) as HTMLButtonElement;
    expect(copyBtn).toBeTruthy();
    copyBtn.click();
    await tick();
    expect(writeText).toHaveBeenCalledWith('Name');
  });
});

describe('schema-browser — injected api + record-page seeding (AC-4)', () => {
  const fixtures: Fixtures = {
    sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }],
    describes: {
      Account: {
        name: 'Account',
        label: 'Account',
        fields: [field({ name: 'Name', label: 'Account Name', type: 'string' })],
        childRelationships: [],
      },
    },
  };

  it('consumes the injected api client', async () => {
    const api = makeApi(fixtures);
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api });
    await feature.openFor('Account');
    await tick();
    expect((api.apiGet as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('onActivate seeds the tool from the record-page sObject in the URL', async () => {
    const api = makeApi(fixtures);
    const url = 'https://acme.lightning.force.com/lightning/r/Account/001800000000001AAA/view';
    const feature = createSchemaBrowserFeature({ win: fakeWin(url), api });
    await feature.onActivate!();
    await tick();
    expect(document.querySelector('h2')?.textContent).toBe('Account');
  });
});

describe('schema-browser — a11y (P0-8)', () => {
  const fixtures: Fixtures = {
    sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }],
    describes: {},
  };

  it('labels the filter control', async () => {
    const api = makeApi(fixtures);
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api });
    await feature.onActivate!();
    await tick();
    const filter = document.getElementById('sfdt-schema-object-filter') as HTMLInputElement;
    expect(filter.getAttribute('aria-label')).toBe('Filter objects by label or API name');
  });

  it('closes on Esc and restores focus to the invoker', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const api = makeApi(fixtures);
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api });
    await feature.onActivate!();
    await tick();
    // Overlay is mounted.
    expect(document.querySelector('.sfdt-view-overlay')).toBeTruthy();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(document.querySelector('.sfdt-view-overlay')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
