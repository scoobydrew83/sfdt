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

// `writeText` takes its argument so a test can assert on what was COPIED, not
// merely that copying happened — which is the whole point for the export menu.
function fakeWin(
  href = SETUP_URL,
  writeText: (text: string) => Promise<void> = vi.fn(async () => {}),
): Window {
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
    const writeText = vi.fn(async (_text: string) => {});
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

describe('schema-browser — SOQL insert + export selection (P2-1 PR-3)', () => {
  const fixtures: Fixtures = {
    sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }],
    describes: {
      Account: {
        name: 'Account',
        label: 'Account',
        fields: [
          field({ name: 'Name', label: 'Account Name', type: 'string', nillable: false }),
          field({ name: 'Industry', label: 'Industry', type: 'picklist' }),
          field({ name: 'Phone', label: 'Phone', type: 'phone' }),
        ],
        childRelationships: [],
      },
    },
  };

  const byText = (text: string) =>
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text) as
      | HTMLButtonElement
      | undefined;

  it('per-field "Insert into query" calls insertFieldIntoDraft with the API name', async () => {
    const insertFieldIntoDraft = vi.fn();
    const api = makeApi(fixtures);
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api, insertFieldIntoDraft });
    await feature.openFor('Account');
    await tick();

    const insertBtn = byText('Insert into query');
    expect(insertBtn).toBeTruthy();
    insertBtn!.click();
    expect(insertFieldIntoDraft).toHaveBeenCalledWith('Name');
  });

  it('hides the insert action when no hook is wired', async () => {
    const api = makeApi(fixtures);
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api });
    await feature.openFor('Account');
    await tick();
    expect(byText('Insert into query')).toBeUndefined();
  });

  it('pre-selects every field and exports only the still-selected subset', async () => {
    const exportForPrompt = vi.fn();
    const api = makeApi(fixtures);
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api, exportForPrompt });
    await feature.openFor('Account');
    await tick();

    const boxes = Array.from(
      document.querySelectorAll('input[type="checkbox"]'),
    ) as HTMLInputElement[];
    expect(boxes).toHaveLength(3);
    // Default: all selected.
    expect(boxes.every((b) => b.checked)).toBe(true);

    // Unselect "Industry" (aria-label carries the field name).
    const industry = boxes.find((b) =>
      b.getAttribute('aria-label')?.includes('Industry'),
    ) as HTMLInputElement;
    industry.checked = false;
    industry.dispatchEvent(new Event('change'));

    byText('Export selected for prompt')!.click();
    expect(exportForPrompt).toHaveBeenCalledWith('Account', ['Name', 'Phone']);
  });

  it('supports clear-all then select-all, and refuses an empty export', async () => {
    const exportForPrompt = vi.fn();
    const api = makeApi(fixtures);
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api, exportForPrompt });
    await feature.openFor('Account');
    await tick();

    byText('Clear all')!.click();
    await tick();
    let boxes = Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(boxes.some((b) => b.checked)).toBe(false);

    // Exporting with nothing selected warns and does not call the hook.
    byText('Export selected for prompt')!.click();
    expect(exportForPrompt).not.toHaveBeenCalled();

    byText('Select all')!.click();
    await tick();
    boxes = Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(boxes.every((b) => b.checked)).toBe(true);

    byText('Export selected for prompt')!.click();
    expect(exportForPrompt).toHaveBeenCalledWith('Account', ['Name', 'Industry', 'Phone']);
  });

  it('does not render selection UI when no export hook is wired', async () => {
    const api = makeApi(fixtures);
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api });
    await feature.openFor('Account');
    await tick();
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(byText('Export selected for prompt')).toBeUndefined();
  });
});

describe('schema-browser — field table columns and rail', () => {
  const RICH: Fixtures = {
    sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }],
    describes: {
      Account: {
        name: 'Account',
        label: 'Account',
        labelPlural: 'Accounts',
        keyPrefix: '001',
        custom: false,
        searchable: true,
        queryable: true,
        createable: true,
        updateable: true,
        deletable: false,
        fields: [
          field({ name: 'Name', label: 'Account Name', type: 'string', length: 255, nillable: false }),
          {
            ...field({ name: 'AccountNumber', label: 'Account Number', type: 'string', length: 40 }),
            unique: true,
            externalId: true,
            inlineHelpText: 'Unique ID used for financial tracking.',
          },
          field({
            name: 'ParentId',
            label: 'Parent Account',
            type: 'reference',
            referenceTo: ['Account'],
          }),
          field({ name: 'OwnerId', label: 'Owner', type: 'reference', referenceTo: ['User'] }),
        ],
        childRelationships: [
          { childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts' },
        ],
      },
    },
  };

  function makeRichApi(over: Partial<SalesforceApiClient> = {}): SalesforceApiClient {
    const base = makeApi(RICH) as unknown as Record<string, unknown>;
    const apiGet = base.apiGet as (e: string) => Promise<unknown>;
    return {
      ...base,
      apiGet: vi.fn(async (endpoint: string) => {
        if (endpoint.includes('/limits/recordCount')) {
          return { sObjects: [{ name: 'Account', count: 1402892 }] };
        }
        return apiGet(endpoint);
      }),
      ...over,
    } as unknown as SalesforceApiClient;
  }

  function cellsOf(rowText: string): string[] {
    const tr = Array.from(document.querySelectorAll('tbody tr')).find((r) =>
      r.textContent?.includes(rowText),
    )!;
    return Array.from(tr.querySelectorAll('td')).map((td) => td.textContent ?? '');
  }

  it('renders the type with its precision, and length beside it', async () => {
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api: makeRichApi() });
    await feature.openFor('Account');
    await tick();
    expect(cellsOf('AccountNumber')).toContain('Text(40)');
    expect(cellsOf('ParentId')).toContain('Lookup');
  });

  it('marks Req/Unq/Ext with a labelled glyph, and leaves a false flag empty', async () => {
    // The glyph is aria-hidden, so the meaning has to ride on hidden text —
    // otherwise a screen reader gets an empty cell either way.
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api: makeRichApi() });
    await feature.openFor('Account');
    await tick();

    const nameRow = Array.from(document.querySelectorAll('tbody tr')).find((r) =>
      r.textContent?.includes('Account Name'),
    )!;
    expect(nameRow.querySelector('.sfdt-sr')?.textContent).toBe('Required');

    const numberRow = Array.from(document.querySelectorAll('tbody tr')).find((r) =>
      r.textContent?.includes('AccountNumber'),
    )!;
    const flags = Array.from(numberRow.querySelectorAll('.sfdt-sr')).map((s) => s.textContent);
    expect(flags).toEqual(['Unique', 'External Id']);

    // ParentId has none of the three — three empty cells, no stray glyphs.
    const parentRow = Array.from(document.querySelectorAll('tbody tr')).find((r) =>
      r.textContent?.includes('ParentId'),
    )!;
    expect(parentRow.querySelectorAll('.sfdt-sr')).toHaveLength(0);
  });

  it('shows the admin help text', async () => {
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api: makeRichApi() });
    await feature.openFor('Account');
    await tick();
    expect(cellsOf('AccountNumber')).toContain('Unique ID used for financial tracking.');
  });

  it('fills the object-metadata rail from the describe already fetched', async () => {
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api: makeRichApi() });
    await feature.openFor('Account');
    await tick();
    const rail = document.querySelector('.sfdt-split-end')!;
    expect(rail.textContent).toContain('Key prefix');
    expect(rail.textContent).toContain('001');
    expect(rail.textContent).toContain('Object metadata');
  });

  it('states the custom-field ceiling is an assumption, not measured data', async () => {
    // The mockup's "88th percentile" had nothing behind it. This replaces it
    // with a real count against an edition constant — and says which constant.
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api: makeRichApi() });
    await feature.openFor('Account');
    await tick();
    const rail = document.querySelector('.sfdt-split-end')!;
    expect(rail.textContent).toContain('Custom field budget');
    expect(rail.textContent).toContain('Professional orgs cap at 100');
  });

  it('says why a standard object has no audit trail instead of showing dashes', async () => {
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api: makeRichApi() });
    await feature.openFor('Account');
    await tick();
    const rail = document.querySelector('.sfdt-split-end')!;
    expect(rail.textContent).toContain('Standard objects carry no audit trail');
  });

  it('loads the record count and marks it approximate', async () => {
    const api = makeRichApi();
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api });
    await feature.openFor('Account');
    await tick();
    await tick();
    const rail = document.querySelector('.sfdt-split-end')!;
    expect(rail.textContent).toContain('1,402,892');
    expect(rail.textContent).toContain('Approximate');
  });

  it('keeps the rest of the rail when the record count fails', async () => {
    // The usual cause is no "View All Data", which the user cannot fix here —
    // so it degrades one section rather than the view.
    const api = makeRichApi({
      apiGet: vi.fn(async (endpoint: string) => {
        if (endpoint.includes('/limits/recordCount')) throw new Error('INSUFFICIENT_ACCESS');
        if (endpoint.endsWith('/sobjects/')) return { sobjects: RICH.sobjects };
        const m = /\/sobjects\/([^/]+)\/describe/.exec(endpoint);
        return m ? RICH.describes[m[1]!] : {};
      }) as unknown as SalesforceApiClient['apiGet'],
    });
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api });
    await feature.openFor('Account');
    await tick();
    await tick();
    const rail = document.querySelector('.sfdt-split-end')!;
    expect(rail.textContent).toContain('INSUFFICIENT_ACCESS');
    expect(rail.textContent).toContain('Key prefix');
  });

  it('draws the relationship graph and lets a node navigate', async () => {
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api: makeRichApi() });
    await feature.openFor('Account');
    await tick();
    // Scope by the node role, not by 'svg' — every rail section heading also
    // renders an icon <svg>, so a bare selector picks one of those.
    const nodes = Array.from(document.querySelectorAll('.sfdt-split-end g[role="button"]'));
    // Contact (child) + Account (root) + User (lookup target). The Account
    // self-reference on ParentId is deliberately not a node.
    expect(nodes).toHaveLength(3);

    const userNode = nodes.find((g) => g.getAttribute('aria-label') === 'User')!;
    userNode.dispatchEvent(new MouseEvent('click'));
    await tick();
    expect(document.querySelector('h2')?.textContent).toBe('User');
  });
});

describe('schema-browser — Generate SOQL', () => {
  const SIMPLE: Fixtures = {
    sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }],
    describes: {
      Account: {
        name: 'Account',
        label: 'Account',
        fields: [
          field({ name: 'Name', label: 'Name', type: 'string' }),
          field({ name: 'Industry', label: 'Industry', type: 'picklist' }),
          field({ name: 'Phone', label: 'Phone', type: 'phone' }),
        ],
        childRelationships: [],
      },
    },
  };

  const byText = (text: string) =>
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text) as
      | HTMLButtonElement
      | undefined;

  it('builds a query from the checked fields, in describe order', async () => {
    // Describe order, not click order: the query should read like the table.
    const runQueryInRunner = vi.fn();
    const feature = createSchemaBrowserFeature({
      win: fakeWin(),
      api: makeApi(SIMPLE),
      runQueryInRunner,
    });
    await feature.openFor('Account');
    await tick();

    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    const name = boxes.find((b) => b.getAttribute('aria-label')?.includes('Name'))!;
    name.checked = false;
    name.dispatchEvent(new Event('change'));

    byText('Generate SOQL')!.click();
    expect(runQueryInRunner).toHaveBeenCalledWith('SELECT Industry, Phone\nFROM Account\nLIMIT 200');
  });

  it('refuses to build an empty query', async () => {
    const runQueryInRunner = vi.fn();
    const feature = createSchemaBrowserFeature({
      win: fakeWin(),
      api: makeApi(SIMPLE),
      runQueryInRunner,
    });
    await feature.openFor('Account');
    await tick();
    byText('Clear all')!.click();
    await tick();
    byText('Generate SOQL')!.click();
    expect(runQueryInRunner).not.toHaveBeenCalled();
  });

  it('is hidden when no runner hook is wired', async () => {
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api: makeApi(SIMPLE) });
    await feature.openFor('Account');
    await tick();
    expect(byText('Generate SOQL')).toBeUndefined();
  });

  it('offers selection when only the runner hook is wired, with no export button', async () => {
    // Selection feeds BOTH features now, so it must not depend on the export
    // hook the way it did when export was its only consumer.
    const feature = createSchemaBrowserFeature({
      win: fakeWin(),
      api: makeApi(SIMPLE),
      runQueryInRunner: vi.fn(),
    });
    await feature.openFor('Account');
    await tick();
    expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    expect(byText('Export selected for prompt')).toBeUndefined();
  });
});

describe('schema-browser — export menu and graph re-centring', () => {
  const TWO: Fixtures = {
    sobjects: [
      { name: 'Account', label: 'Account', keyPrefix: '001' },
      { name: 'User', label: 'User', keyPrefix: '005' },
    ],
    describes: {
      Account: {
        name: 'Account',
        label: 'Account',
        fields: [
          field({ name: 'Name', label: 'Account Name', type: 'string', length: 255, nillable: false }),
          field({ name: 'OwnerId', label: 'Owner', type: 'reference', referenceTo: ['User'] }),
        ],
        childRelationships: [{ childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts' }],
      },
      User: {
        name: 'User',
        label: 'User',
        fields: [field({ name: 'Username', label: 'Username', type: 'string', length: 80 })],
        childRelationships: [{ childSObject: 'Account', field: 'OwnerId', relationshipName: 'Accounts' }],
      },
    },
  };

  const byText = (text: string) =>
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text) as
      | HTMLButtonElement
      | undefined;

  const menuItem = (fragment: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('.sfdt-menu-surface button')).find((b) =>
      b.textContent?.includes(fragment),
    );

  it('offers formats instead of performing one unadvertised action', async () => {
    // The button used to copy AI markdown silently. A noun that performs one
    // hidden verb is the complaint this fixes.
    const feature = createSchemaBrowserFeature({
      win: fakeWin(),
      api: makeApi(TWO),
      exportForPrompt: vi.fn(),
    });
    await feature.openFor('Account');
    await tick();

    byText('Export schema')!.click();
    await tick();
    for (const label of ['Copy for AI', 'Copy as JSON', 'Copy as CSV', 'Download JSON', 'Download CSV']) {
      expect(menuItem(label), label).toBeTruthy();
    }
  });

  it('copies CSV of the SELECTED fields, in describe order', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    const feature = createSchemaBrowserFeature({
      win: fakeWin(SETUP_URL, writeText),
      api: makeApi(TWO),
      exportForPrompt: vi.fn(),
    });
    await feature.openFor('Account');
    await tick();

    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    const owner = boxes.find((b) => b.getAttribute('aria-label')?.includes('OwnerId'))!;
    owner.checked = false;
    owner.dispatchEvent(new Event('change'));

    byText('Export schema')!.click();
    await tick();
    menuItem('Copy as CSV')!.click();
    await tick();

    const csv = writeText.mock.calls[0]![0];
    expect(csv).toContain('Label,API Name,Type');
    expect(csv).toContain('Account Name');
    // The unselected field is gone; the header row is not mistaken for data.
    expect(csv).not.toContain('OwnerId');
    expect(csv.trim().split('\n')).toHaveLength(2);
  });

  it('re-centres the expanded graph on the clicked node', async () => {
    // The regression: the modal rendered once from a captured viewmodel, so a
    // node click updated the list BEHIND it while the graph kept showing the
    // previous object — the picture and the thing it described diverged.
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api: makeApi(TWO) });
    await feature.openFor('Account');
    await tick();

    byText('Expand graph')!.click();
    await tick();

    const overlays = () => document.querySelectorAll('.sfdt-view-overlay');
    expect(overlays()).toHaveLength(2);
    const modal = overlays()[1]!;
    expect(modal.querySelector('h2')?.textContent).toBe('Account relationships');

    const userNode = Array.from(modal.querySelectorAll('g[role="button"]')).find(
      (g) => g.getAttribute('aria-label') === 'User',
    )!;
    userNode.dispatchEvent(new MouseEvent('click'));
    await tick();
    await tick();

    // The graph itself re-rooted — not just the browser underneath it.
    expect(modal.querySelector('h2')?.textContent).toBe('User relationships');
    const labels = Array.from(modal.querySelectorAll('g[role="button"]')).map((g) =>
      g.getAttribute('aria-label'),
    );
    expect(labels).toContain('User');
    expect(labels).toContain('Account');
    // …and the browser behind it followed.
    expect(document.querySelector('h2')?.textContent).toBe('User');
  });

  it('shows a loading state while the clicked object is still being described', async () => {
    // The object just clicked is normally NOT in the cache, so the view has to
    // paint something and repaint when the fetch lands rather than render an
    // empty box.
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api: makeApi(TWO) });
    await feature.openFor('Account');
    await tick();
    byText('Expand graph')!.click();
    await tick();
    const modal = document.querySelectorAll('.sfdt-view-overlay')[1]!;
    expect(modal.textContent).toContain('Account relationships');
    expect(modal.querySelector('g[role="button"]')).not.toBeNull();
  });
});
