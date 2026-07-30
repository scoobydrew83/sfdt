// Field Impact Analysis (P4-4) — "what writes this field?".
//
// Three layers are covered here:
//   1. lib/field-impact.ts   — the pure viewmodel, including the inferred vs
//                              confirmed labelling that AC-2 turns on.
//   2. features/field-impact.ts — query construction + the rendered surface
//                              (badges, legend, scope notes, open links, a11y).
//   3. the two AC-1 entry points — Schema Browser and Show API Names.
//
// The Flow parsing itself is flow-core's (`packages/flow-core/test/field-writes.test.ts`);
// what is asserted here is that the extension consumes it and never re-labels an
// inferred hit as confirmed.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildFieldImpactVM,
  flowBuilderUrl,
  setupRecordUrl,
  STATUS_LEGEND,
  type FieldImpactInput,
} from '../lib/field-impact.js';
import {
  createFieldImpactFeature,
  customFieldIdQuery,
  flowCandidateQuery,
  flowMetadataQuery,
  recentActiveFlowsQuery,
  workflowFieldUpdateQuery,
  apexSearchSosl,
} from '../features/field-impact.js';
import { createSchemaBrowserFeature } from '../features/schema-browser.js';
import { createShowApiNamesFeature } from '../features/show-api-names.js';
import { _resetDescribeCachesForTests } from '../lib/describe-cache.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

const ORIGIN = 'https://acme.lightning.force.com';
const SETUP_URL = `${ORIGIN}/lightning/setup/SetupOneHome/home`;

const tick = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

function clearBody(): void {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
}

beforeEach(() => {
  clearBody();
  _resetDescribeCachesForTests();
});

// --- Fixture flow metadata (Tooling `Flow.Metadata` shape) -----------------

const writesIndustry = {
  label: 'Account Stamp',
  start: { object: 'Account', triggerType: 'RecordBeforeSave', recordTriggerType: 'Create' },
  assignments: [
    {
      name: 'Stamp',
      label: 'Stamp Industry',
      assignmentItems: [{ assignToReference: '$Record.Industry__c', operator: 'Assign', value: {} }],
    },
  ],
};

const readsIndustryOnly = {
  label: 'Account Reader',
  start: { object: 'Account', triggerType: 'RecordAfterSave', recordTriggerType: 'Create' },
  recordLookups: [
    {
      name: 'Get_Account',
      label: 'Get Account',
      object: 'Account',
      filters: [{ field: 'Industry__c', operator: 'EqualTo', value: { stringValue: 'Tech' } }],
    },
  ],
};

const writesIndustryUnbound = {
  label: 'Wrapper Writer',
  variables: [{ name: 'wrapper', dataType: 'Apex', apexClass: 'AccountWrapper' }],
  assignments: [
    {
      name: 'Fill',
      label: 'Fill Wrapper',
      assignmentItems: [{ assignToReference: 'wrapper.Industry__c', operator: 'Assign', value: {} }],
    },
  ],
};

// ---------------------------------------------------------------------------
// 1. Pure viewmodel
// ---------------------------------------------------------------------------

function vmFor(overrides: Partial<FieldImpactInput> = {}) {
  return buildFieldImpactVM({
    object: 'Account',
    field: 'Industry__c',
    origin: ORIGIN,
    ...overrides,
  });
}

describe('lib/field-impact — viewmodel', () => {
  it('reports a parsed Flow write as confirmed, with the writing element as evidence', () => {
    const vm = vmFor({
      flows: [
        { versionId: '301xx1', apiName: 'Account_Stamp', label: 'Account Stamp', status: 'Active', metadata: writesIndustry },
      ],
    });
    expect(vm.rows).toHaveLength(1);
    expect(vm.rows[0]).toMatchObject({
      sourceType: 'Flow',
      typeLabel: 'Flow',
      name: 'Account_Stamp',
      status: 'confirmed',
    });
    expect(vm.rows[0]!.detail).toContain('Assignment "Stamp Industry"');
    expect(vm.rows[0]!.detail).toContain('Active');
    expect(vm.counts).toEqual({ confirmed: 1, inferred: 0, total: 1 });
  });

  it('drops a Flow that only READS the field — the flow-core edge over a raw dependency query', () => {
    const vm = vmFor({
      flows: [
        { versionId: '301xx2', apiName: 'Account_Reader', metadata: readsIndustryOnly },
      ],
    });
    expect(vm.rows).toEqual([]);
    expect(vm.counts.total).toBe(0);
  });

  it('labels a Flow write whose object could not be bound as inferred, never confirmed', () => {
    const vm = vmFor({
      flows: [{ versionId: '301xx3', apiName: 'Wrapper_Writer', metadata: writesIndustryUnbound }],
    });
    expect(vm.rows[0]!.status).toBe('inferred');
    expect(vm.rows[0]!.detail).toContain('object could not be bound');
  });

  it('labels an un-analysed Flow candidate as inferred and says why', () => {
    const vm = vmFor({
      flows: [{ versionId: '301xx4', apiName: 'Not_Scanned', metadata: null }],
    });
    expect(vm.rows[0]).toMatchObject({ status: 'inferred', sourceType: 'Flow' });
    expect(vm.rows[0]!.detail).toContain('metadata was not analysed');
  });

  it('confirms a workflow field update whose metadata names the field', () => {
    const vm = vmFor({
      workflowFieldUpdates: [
        { id: '04Yxx1', name: 'Set_Industry', label: 'Set Industry', object: 'Account', field: 'Industry__c' },
      ],
    });
    expect(vm.rows[0]).toMatchObject({
      sourceType: 'WorkflowFieldUpdate',
      typeLabel: 'Workflow Field Update',
      status: 'confirmed',
    });
  });

  it('excludes a workflow field update targeting a different field or object', () => {
    expect(
      vmFor({
        workflowFieldUpdates: [{ id: '04Yxx2', name: 'Other', object: 'Account', field: 'Rating__c' }],
      }).rows,
    ).toEqual([]);
    expect(
      vmFor({
        workflowFieldUpdates: [{ id: '04Yxx3', name: 'Other', object: 'Contact', field: 'Industry__c' }],
      }).rows,
    ).toEqual([]);
  });

  it('keeps an unreadable workflow field update as inferred rather than confirming or hiding it', () => {
    const vm = vmFor({
      workflowFieldUpdates: [
        { id: '04Yxx4', name: 'Unreadable', object: 'Account', field: null, unresolved: true },
      ],
    });
    expect(vm.rows[0]!.status).toBe('inferred');
    expect(vm.rows[0]!.detail).toContain('could not be read');
  });

  it('ALWAYS labels an Apex text-search hit inferred and says a hit is not a write', () => {
    const vm = vmFor({
      apexHits: [
        { id: '01pxx1', name: 'AccountService', type: 'ApexClass' },
        { id: '01qxx1', name: 'AccountTrigger', type: 'ApexTrigger' },
      ],
    });
    expect(vm.rows.map((r) => r.status)).toEqual(['inferred', 'inferred']);
    expect(vm.rows.map((r) => r.typeLabel)).toEqual(['Apex Trigger', 'Apex Class']);
    for (const row of vm.rows) {
      expect(row.detail).toContain('may read it, not write it');
    }
  });

  it('sorts confirmed rows ahead of inferred and counts each independently', () => {
    const vm = vmFor({
      flows: [
        { versionId: '301xx5', apiName: 'Zed_Writer', metadata: writesIndustry },
        { versionId: '301xx6', apiName: 'Unscanned', metadata: null },
      ],
      apexHits: [{ id: '01pxx2', name: 'AccountService', type: 'ApexClass' }],
      workflowFieldUpdates: [
        { id: '04Yxx5', name: 'Set_Industry', object: 'Account', field: 'Industry__c' },
      ],
    });
    expect(vm.rows.map((r) => r.status)).toEqual([
      'confirmed',
      'confirmed',
      'inferred',
      'inferred',
    ]);
    expect(vm.counts).toEqual({ confirmed: 2, inferred: 2, total: 4 });
  });

  it('carries scope notes through verbatim', () => {
    expect(vmFor({ notes: ['partial scan'] }).notes).toEqual(['partial scan']);
  });

  it('builds open links for every source type', () => {
    expect(flowBuilderUrl(ORIGIN, '301xx1')).toBe(
      `${ORIGIN}/builder_platform_interaction/flowBuilder.app?flowId=301xx1`,
    );
    expect(setupRecordUrl(ORIGIN, 'ApexClasses', '01pxx1')).toBe(
      `${ORIGIN}/lightning/setup/ApexClasses/page?address=%2F01pxx1`,
    );
    expect(flowBuilderUrl(ORIGIN, '')).toBeNull();
  });

  it('uses the same status vocabulary as the dependency gaps report', () => {
    expect(Object.keys(STATUS_LEGEND).sort()).toEqual(['confirmed', 'inferred']);
  });
});

// ---------------------------------------------------------------------------
// 2. Feature: queries + rendering
// ---------------------------------------------------------------------------

describe('features/field-impact — query construction', () => {
  it('resolves a custom field by developer name and entity, quote-escaped', () => {
    const q = customFieldIdQuery("O'Brien__c", 'Region__c');
    expect(q).toContain("DeveloperName = 'Region'");
    expect(q).toContain("EntityDefinition.QualifiedApiName = 'O\\'Brien__c'");
  });

  it('narrows flow candidates through MetadataComponentDependency', () => {
    const q = flowCandidateQuery('00Nxx1');
    expect(q).toContain("RefMetadataComponentId = '00Nxx1'");
    expect(q).toContain("MetadataComponentType = 'Flow'");
  });

  it('falls back to a bounded, most-recent active flow list', () => {
    expect(recentActiveFlowsQuery()).toMatch(/Status = 'Active'.*ORDER BY LastModifiedDate DESC LIMIT \d+/);
  });

  it('fetches flow metadata one version at a time', () => {
    expect(flowMetadataQuery('301xx1')).toContain("WHERE Id = '301xx1' LIMIT 1");
  });

  it('queries workflow field updates with and without Metadata', () => {
    expect(workflowFieldUpdateQuery('Account', true)).toContain('Metadata');
    expect(workflowFieldUpdateQuery('Account', false)).not.toContain('Metadata');
  });

  it('refuses to build an Apex search for anything that is not a plain API name', () => {
    expect(apexSearchSosl('Industry')).toContain('FIND {Industry}');
    expect(apexSearchSosl('Industry OR *')).toBeNull();
    expect(apexSearchSosl('a{b}')).toBeNull();
  });
});

interface StubOptions {
  flowWrites?: boolean;
  failApexSearch?: boolean;
}

function stubApi(options: StubOptions = {}): SalesforceApiClient {
  const toolingQuery = vi.fn(async (soql: string) => {
    if (soql.includes('FROM CustomField')) return { records: [{ Id: '00Nxx1' }], size: 1, done: true };
    if (soql.includes('MetadataComponentDependency')) {
      return { records: [{ MetadataComponentId: '301xx1' }], size: 1, done: true };
    }
    if (soql.includes("Status = 'Active'")) {
      return { records: [{ Id: '301xx1' }], size: 1, done: true };
    }
    if (soql.includes('FROM Flow WHERE Id')) {
      return {
        records: [
          {
            Id: '301xx1',
            MasterLabel: 'Account Stamp',
            Status: 'Active',
            Definition: { DeveloperName: 'Account_Stamp' },
            Metadata: options.flowWrites === false ? readsIndustryOnly : writesIndustry,
          },
        ],
        size: 1,
        done: true,
      };
    }
    if (soql.includes('WorkflowFieldUpdate')) {
      return {
        records: [
          { Id: '04Yxx1', Name: 'Set Industry', TableEnumOrId: 'Account', Metadata: { field: 'Industry__c' } },
        ],
        size: 1,
        done: true,
      };
    }
    return { records: [], size: 0, done: true };
  });
  const apiGet = vi.fn(async (endpoint: string) => {
    if (endpoint.includes('/tooling/search/')) {
      if (options.failApexSearch) throw new Error('SOSL refused');
      return { searchRecords: [{ Id: '01pxx1', Name: 'AccountService', attributes: { type: 'ApexClass' } }] };
    }
    return {};
  });
  return {
    apiVersion: 'v62.0',
    orgOrigin: ORIGIN,
    apiGet,
    query: vi.fn(),
    toolingQuery,
    apiRequest: vi.fn(),
  } as unknown as SalesforceApiClient;
}

function fakeWin(href = SETUP_URL): Window {
  return {
    location: { href, origin: new URL(href).origin },
    navigator: { clipboard: { writeText: vi.fn(async () => {}) } },
  } as unknown as Window;
}

describe('features/field-impact — rendered surface', () => {
  it('renders confirmed and inferred rows with a badge whose TEXT states the status', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: stubApi() });
    await feature.openFor('Account', 'Industry__c');
    await tick();

    const badges = [...document.querySelectorAll('td span')]
      .map((el) => el.textContent)
      .filter((t) => t === 'confirmed' || t === 'inferred');
    // Flow (confirmed) + workflow field update (confirmed) + Apex (inferred).
    expect(badges).toEqual(['confirmed', 'confirmed', 'inferred']);
  });

  it('summarises the confirmed/inferred split in an aria-live status', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: stubApi() });
    await feature.openFor('Account', 'Industry__c');
    await tick();

    const status = document.querySelector('[role="status"]')!;
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain('2 confirmed, 1 inferred');
  });

  it('always renders the legend so a reader knows what each label means', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: stubApi() });
    await feature.openFor('Account', 'Industry__c');
    await tick();
    expect(document.body.textContent).toContain(STATUS_LEGEND.confirmed);
    expect(document.body.textContent).toContain(STATUS_LEGEND.inferred);
  });

  it('gives every row an Open link with an accessible name', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: stubApi() });
    await feature.openFor('Account', 'Industry__c');
    await tick();

    const links = [...document.querySelectorAll('a')].filter((a) => a.textContent === 'Open');
    expect(links.length).toBe(3);
    for (const link of links) {
      expect(link.getAttribute('aria-label')).toMatch(/^Open /);
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.getAttribute('href')).toContain(ORIGIN);
    }
  });

  it('reports a read-only flow as "nothing found" rather than listing it', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: stubApi({ flowWrites: false }) });
    await feature.openFor('Account', 'Industry__c');
    await tick();
    expect(document.querySelector('[role="status"]')!.textContent).toContain('2 source(s)');
    // Only the workflow field update remains; no Flow row.
    expect(document.body.textContent).not.toContain('Account Stamp');
  });

  it('says plainly when a STANDARD field forced a partial flow scan', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: stubApi() });
    // A standard field has no CustomField row, so there is no dependency edge to
    // narrow with — the fallback scan must announce itself rather than look complete.
    await feature.openFor('Account', 'Industry');
    await tick();

    const note = document.querySelector('[role="note"]')!;
    expect(note.textContent).toContain('No dependency edge for Account.Industry');
    expect(note.textContent).toContain('not every flow in the org');
  });

  it('surfaces a degraded Apex search as a scope note, not as a result', async () => {
    const feature = createFieldImpactFeature({
      win: fakeWin(),
      api: stubApi({ failApexSearch: true }),
    });
    await feature.openFor('Account', 'Industry__c');
    await tick();

    const note = document.querySelector('[role="note"]')!;
    expect(note.textContent).toContain('Apex text search unavailable');
    expect(document.body.textContent).not.toContain('AccountService');
  });

  it('never uses innerHTML — org metadata renders as text nodes', async () => {
    const api = stubApi();
    (api.toolingQuery as ReturnType<typeof vi.fn>).mockImplementation(async (soql: string) => {
      if (soql.includes('FROM CustomField')) return { records: [{ Id: '00Nxx1' }], size: 1, done: true };
      if (soql.includes('MetadataComponentDependency')) {
        return { records: [{ MetadataComponentId: '301xx1' }], size: 1, done: true };
      }
      if (soql.includes("Status = 'Active'")) {
        return { records: [{ Id: '301xx1' }], size: 1, done: true };
      }
      if (soql.includes('FROM Flow WHERE Id')) {
        return {
          records: [
            {
              Id: '301xx1',
              MasterLabel: '<img src=x onerror=alert(1)>',
              Status: 'Active',
              Definition: { DeveloperName: 'Evil_Flow' },
              Metadata: writesIndustry,
            },
          ],
          size: 1,
          done: true,
        };
      }
      return { records: [], size: 0, done: true };
    });
    const feature = createFieldImpactFeature({ win: fakeWin(), api });
    await feature.openFor('Account', 'Industry__c');
    await tick();

    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('closes on Escape (capture phase) and removes the listener', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: stubApi() });
    await feature.openFor('Account', 'Industry__c');
    await tick();
    expect(document.querySelector('[role="status"]')).toBeTruthy();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('[role="status"]')).toBeNull();

    // A second Escape after close must not throw (listener was removed).
    expect(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    ).not.toThrow();
  });

  it('validates both inputs before touching the org', async () => {
    const api = stubApi();
    const feature = createFieldImpactFeature({ win: fakeWin(), api });
    await feature.onActivate!();
    await tick();

    const runBtn = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'What writes this field?',
    )!;
    runBtn.click();
    await tick();
    expect(document.querySelector('[role="status"]')!.textContent).toContain(
      'Enter both an object and a field',
    );
    expect(api.toolingQuery).not.toHaveBeenCalled();
  });

  it('labels both inputs and pre-fills the object from a record page', async () => {
    const feature = createFieldImpactFeature({
      win: fakeWin(`${ORIGIN}/lightning/r/Account/001xx0000000001/view`),
      api: stubApi(),
    });
    await feature.onActivate!();
    await tick();

    const objectInput = document.getElementById('sfdt-field-impact-object') as HTMLInputElement;
    const fieldInput = document.getElementById('sfdt-field-impact-field') as HTMLInputElement;
    expect(objectInput.value).toBe('Account');
    expect(fieldInput.value).toBe('');
    for (const input of [objectInput, fieldInput]) {
      const label = document.querySelector(`label[for="${input.id}"]`);
      expect(label?.textContent).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. AC-1 entry points
// ---------------------------------------------------------------------------

describe('field impact entry points (AC-1)', () => {
  const accountDescribe = {
    name: 'Account',
    label: 'Account',
    fields: [
      { name: 'Industry', label: 'Industry', type: 'picklist', nillable: true, createable: true, picklistValues: [], referenceTo: [] },
      { name: 'Name', label: 'Account Name', type: 'string', nillable: false, createable: true, picklistValues: [], referenceTo: [] },
    ],
    childRelationships: [],
  };

  function describeApi(): SalesforceApiClient {
    const apiGet = vi.fn(async (endpoint: string) => {
      if (endpoint.endsWith('/sobjects/')) {
        return { sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }] };
      }
      if (/\/sobjects\/Account\/describe/.test(endpoint)) return accountDescribe;
      if (/\/sobjects\/Account\/[^/]+$/.test(endpoint)) return { Id: '001xx0000000001', Name: 'Acme' };
      if (endpoint.includes('/describe/layouts/')) return { layouts: [{ detailLayoutSections: [] }] };
      return {};
    });
    return {
      apiVersion: 'v62.0',
      orgOrigin: `${ORIGIN.replace('lightning.force', 'my.salesforce')}`,
      apiGet,
      query: vi.fn(),
      toolingQuery: vi.fn(async () => ({ records: [], size: 0, done: true })),
      apiRequest: vi.fn(),
    } as unknown as SalesforceApiClient;
  }

  it('Schema Browser exposes a per-field "What writes this?" action wired to the analysis', async () => {
    const analyzeFieldImpact = vi.fn();
    const feature = createSchemaBrowserFeature({
      win: fakeWin(),
      api: describeApi(),
      analyzeFieldImpact,
    });
    await feature.openFor('Account');
    await tick();

    const buttons = [...document.querySelectorAll('button')].filter(
      (b) => b.textContent === 'What writes this?',
    );
    expect(buttons.length).toBe(accountDescribe.fields.length);
    expect(buttons[0]!.getAttribute('aria-label')).toBe(
      'What writes field Industry on Account?',
    );
    buttons[0]!.click();
    expect(analyzeFieldImpact).toHaveBeenCalledWith('Account', 'Industry');
  });

  it('Schema Browser hides the action entirely when the hook is not wired', async () => {
    const feature = createSchemaBrowserFeature({ win: fakeWin(), api: describeApi() });
    await feature.openFor('Account');
    await tick();
    expect(
      [...document.querySelectorAll('button')].some((b) => b.textContent === 'What writes this?'),
    ).toBe(false);
  });

  it('Show API Names offers a labelled field picker that launches the analysis', async () => {
    const analyzeFieldImpact = vi.fn();
    const feature = createShowApiNamesFeature({
      win: fakeWin(`${ORIGIN}/lightning/r/Account/001xx0000000001/view`),
      api: describeApi(),
      analyzeFieldImpact,
    });
    await feature.onActivate!();
    await tick();

    const select = document.getElementById(
      'sfdt-show-api-names-impact-field',
    ) as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.getAttribute('aria-label')).toBe('Choose a Account field to analyse');
    expect(document.querySelector(`label[for="${select.id}"]`)?.textContent).toBe('Field impact');
    expect([...select.options].map((o) => o.value)).toEqual(['Name', 'Industry']);

    select.value = 'Industry';
    const btn = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'What writes this field?',
    )!;
    btn.click();
    expect(analyzeFieldImpact).toHaveBeenCalledWith('Account', 'Industry');
  });

  it('Show API Names hides the picker when the hook is not wired', async () => {
    const feature = createShowApiNamesFeature({
      win: fakeWin(`${ORIGIN}/lightning/r/Account/001xx0000000001/view`),
      api: describeApi(),
    });
    await feature.onActivate!();
    await tick();
    expect(document.getElementById('sfdt-show-api-names-impact-field')).toBeNull();
  });
});
