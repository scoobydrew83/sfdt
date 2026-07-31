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
  workflowFieldUpdateListQuery,
  workflowFieldUpdateDetailQuery,
  objectFromFullName,
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

  describe('broad-scan candidates cannot be attributed on a name collision', () => {
    // A flow that writes `Industry__c` into an UNTYPED wrapper variable. On the
    // dependency-narrowed path this is a real lead (something already told us
    // the flow references the field). On a broad scan it is nothing but a name
    // match, and reporting it would attribute another object's field to ours.
    const collision = {
      versionId: '301xx7',
      apiName: 'Unrelated_Writer',
      label: 'Unrelated Writer',
      metadata: writesIndustryUnbound,
    };

    it('is dropped on the broad-scan path — no false attribution', () => {
      const vm = vmFor({ flows: [{ ...collision, discovery: 'broad-scan' as const }] });
      expect(vm.rows).toEqual([]);
      expect(vm.counts).toEqual({ confirmed: 0, inferred: 0, total: 0 });
    });

    it('is still kept, as inferred, on the dependency-narrowed path', () => {
      const vm = vmFor({ flows: [{ ...collision, discovery: 'dependency' as const }] });
      expect(vm.rows).toHaveLength(1);
      expect(vm.rows[0]!.status).toBe('inferred');
    });

    it('defaults to the lenient dependency behaviour when provenance is absent', () => {
      expect(vmFor({ flows: [collision] }).rows).toHaveLength(1);
    });

    it('still reports an object-BOUND write found by a broad scan', () => {
      const vm = vmFor({
        flows: [
          {
            versionId: '301xx8',
            apiName: 'Account_Stamp',
            metadata: writesIndustry,
            discovery: 'broad-scan' as const,
          },
        ],
      });
      expect(vm.rows).toHaveLength(1);
      expect(vm.rows[0]!.status).toBe('confirmed');
    });
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
    expect(recentActiveFlowsQuery()).toMatch(
      /FROM FlowDefinition WHERE ActiveVersionId != null ORDER BY LastModifiedDate DESC LIMIT \d+/,
    );
  });

  // Regression: `Flow WHERE Status = 'Active'` returned nothing against orgs
  // that plainly had active flows, and the panel reported "a broad scan of the 0
  // most recently modified active flow(s)" as though that were a result.
  it('enumerates flows the way every other flow feature does, not by Flow.Status', () => {
    expect(recentActiveFlowsQuery()).not.toContain("Status = 'Active'");
    expect(recentActiveFlowsQuery()).toContain('ActiveVersionId');
  });

  it('fetches flow metadata one version at a time', () => {
    expect(flowMetadataQuery('301xx1')).toContain("WHERE Id = '301xx1' LIMIT 1");
  });

  // Regression: `TableEnumOrId` is a column on WorkflowRule, NOT on
  // WorkflowFieldUpdate. Asking for it made Salesforce reject the request, and
  // the per-row "fallback" built its SOQL from the same builder — so it failed
  // identically and field updates were never covered on any org.
  it('never asks WorkflowFieldUpdate for TableEnumOrId', () => {
    expect(workflowFieldUpdateListQuery()).not.toContain('TableEnumOrId');
    expect(workflowFieldUpdateDetailQuery('04Yxx1')).not.toContain('TableEnumOrId');
  });

  it('lists field updates cheaply, then reads FullName + Metadata one row at a time', () => {
    expect(workflowFieldUpdateListQuery()).toMatch(
      /^SELECT Id, Name FROM WorkflowFieldUpdate ORDER BY Name LIMIT \d+$/,
    );
    const detail = workflowFieldUpdateDetailQuery("O'Brien");
    expect(detail).toContain('FullName');
    expect(detail).toContain('Metadata');
    expect(detail).toContain("WHERE Id = 'O\\'Brien' LIMIT 1");
  });

  it('takes the target object from the FullName prefix, and refuses to guess without one', () => {
    expect(objectFromFullName('Account.Set_Industry')).toBe('Account');
    expect(objectFromFullName('My_Obj__c.Stamp')).toBe('My_Obj__c');
    expect(objectFromFullName('Set_Industry')).toBeNull();
    expect(objectFromFullName('.Leading')).toBeNull();
    expect(objectFromFullName(undefined)).toBeNull();
  });

  it('caps the Apex search per RETURNING object, not just at the statement end', () => {
    const sosl = apexSearchSosl('Industry__c')!;
    // A trailing LIMIT alone is not a reliable total across two returned types.
    expect(sosl).toContain('ApexClass(Id, Name LIMIT 25)');
    expect(sosl).toContain('ApexTrigger(Id, Name LIMIT 25)');
    expect(sosl.endsWith('LIMIT 25')).toBe(true);
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
    if (soql.includes('FROM FlowDefinition')) {
      return { records: [{ ActiveVersionId: '301xx1' }], size: 1, done: true };
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
    if (soql.includes("WorkflowFieldUpdate WHERE Id = '04Yxx1'")) {
      return {
        records: [
          { Id: '04Yxx1', FullName: 'Account.Set_Industry', Metadata: { field: 'Industry__c' } },
        ],
        size: 1,
        done: true,
      };
    }
    if (soql.includes('FROM WorkflowFieldUpdate')) {
      return { records: [{ Id: '04Yxx1', Name: 'Set Industry' }], size: 1, done: true };
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

  it('names every column header, including the actions column with no visible text', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: stubApi() });
    await feature.openFor('Account', 'Industry__c');
    await tick();

    const headers = [...document.querySelectorAll('th')];
    expect(headers.length).toBe(5);
    for (const th of headers) {
      expect(th.getAttribute('scope')).toBe('col');
      // A `scope="col"` header with neither text nor an accessible name is an
      // unnamed column (CONVENTIONS item 10).
      const name = (th.textContent ?? '').trim() || th.getAttribute('aria-label');
      expect(name).toBeTruthy();
    }
    expect(headers[4]!.getAttribute('aria-label')).toBe('Actions');
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

  // N1: named for what it asserts. A read-only flow is EXCLUDED from the result
  // set — the other two sources still report, so the count drops from 3 to 2.
  it('excludes a read-only flow from the results rather than listing it', async () => {
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
    expect(note.textContent).toContain('is a standard field');
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
      if (soql.includes('FROM FlowDefinition')) {
        return { records: [{ ActiveVersionId: '301xx1' }], size: 1, done: true };
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

describe('features/field-impact — broad-scan precision (standard fields)', () => {
  // A standard field name (`Status`) is the worst case: every org has flows
  // writing SOME object's Status. Two flows come back from the broad sweep —
  // one genuinely writes Case.Status, the other writes `Status` into an untyped
  // Apex wrapper and has nothing to do with Case.
  const writesCaseStatus = {
    label: 'Case Triage',
    start: { object: 'Case', triggerType: 'RecordBeforeSave', recordTriggerType: 'Create' },
    assignments: [
      {
        name: 'Set_Status',
        label: 'Set Status',
        assignmentItems: [{ assignToReference: '$Record.Status', operator: 'Assign', value: {} }],
      },
    ],
  };
  const writesSomeOtherStatus = {
    label: 'Order Wrapper Builder',
    variables: [{ name: 'wrapper', dataType: 'Apex', apexClass: 'OrderWrapper' }],
    assignments: [
      {
        name: 'Fill',
        label: 'Fill Wrapper',
        assignmentItems: [{ assignToReference: 'wrapper.Status', operator: 'Assign', value: {} }],
      },
    ],
  };

  function broadScanApi(): SalesforceApiClient {
    const toolingQuery = vi.fn(async (soql: string) => {
      if (soql.includes('FROM FlowDefinition')) {
        return { records: [{ ActiveVersionId: '301aaa' }, { ActiveVersionId: '301bbb' }], size: 2, done: true };
      }
      if (soql.includes("FROM Flow WHERE Id = '301aaa'")) {
        return {
          records: [
            {
              Id: '301aaa',
              MasterLabel: 'Case Triage',
              Status: 'Active',
              Definition: { DeveloperName: 'Case_Triage' },
              Metadata: writesCaseStatus,
            },
          ],
          size: 1,
          done: true,
        };
      }
      if (soql.includes("FROM Flow WHERE Id = '301bbb'")) {
        return {
          records: [
            {
              Id: '301bbb',
              MasterLabel: 'Order Wrapper Builder',
              Status: 'Active',
              Definition: { DeveloperName: 'Order_Wrapper_Builder' },
              Metadata: writesSomeOtherStatus,
            },
          ],
          size: 1,
          done: true,
        };
      }
      return { records: [], size: 0, done: true };
    });
    return {
      apiVersion: 'v62.0',
      orgOrigin: ORIGIN,
      apiGet: vi.fn(async () => ({})),
      query: vi.fn(),
      toolingQuery,
      apiRequest: vi.fn(),
    } as unknown as SalesforceApiClient;
  }

  it('never resolves a CustomField Id for a standard field (so there IS no dependency edge)', async () => {
    const api = broadScanApi();
    const feature = createFieldImpactFeature({ win: fakeWin(), api });
    await feature.openFor('Case', 'Status');
    await tick();
    const queries = (api.toolingQuery as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(queries.some((q: string) => q.includes('FROM CustomField'))).toBe(false);
    expect(queries.some((q: string) => q.includes('FROM FlowDefinition'))).toBe(true);
  });

  // An empty fallback is not "a scan that found nothing" — nothing was scanned.
  // The old wording ("a broad scan of the 0 most recently modified active
  // flow(s)") read like a cap bug and buried the fact that Flow coverage was
  // ZERO, so a "nothing writes this field" verdict looked scanned-for.
  it('says NO flow was examined when the fallback list comes back empty', async () => {
    const api = {
      apiVersion: 'v62.0',
      orgOrigin: ORIGIN,
      apiGet: vi.fn(async () => ({})),
      query: vi.fn(),
      toolingQuery: vi.fn(async () => ({ records: [], size: 0, done: true })),
      apiRequest: vi.fn(),
    } as unknown as SalesforceApiClient;
    const feature = createFieldImpactFeature({ win: fakeWin(), api });
    await feature.openFor('Case', 'Status');
    await tick();
    const note = document.querySelector('[role="note"]')!.textContent!;
    expect(note).toContain('that query returned no active flow versions, so NO flow was examined');
    expect(note).toContain('says nothing about whether a flow writes Case.Status');
    expect(note).not.toContain('broad scan of the 0');
    // The precision rule describes how scanned flows are adjudicated. With none
    // scanned there is nothing for it to describe, and printing it implies a
    // scan happened.
    expect(note).not.toContain('a flow is only reported when its metadata binds');
  });

  it('reports the flow that binds the write to the queried object', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: broadScanApi() });
    await feature.openFor('Case', 'Status');
    await tick();
    expect(document.body.textContent).toContain('Case Triage');
  });

  it('does NOT attribute an unrelated flow that merely writes a same-named field', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: broadScanApi() });
    await feature.openFor('Case', 'Status');
    await tick();
    expect(document.body.textContent).not.toContain('Order Wrapper Builder');
    expect(document.querySelector('[role="status"]')!.textContent).toContain('1 source(s)');
  });

  it('states the broad scan\'s PRECISION rule, not just its breadth', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: broadScanApi() });
    await feature.openFor('Case', 'Status');
    await tick();
    const note = document.querySelector('[role="note"]')!.textContent!;
    // Breadth (was already disclosed) …
    expect(note).toContain('not every flow in the org');
    // … and precision: what the strict rule skips, and why.
    expect(note).toContain('only reported when its metadata binds the write to Case');
    expect(note).toContain('SKIPPED rather than guessed at');
    expect(note).toContain('are therefore missing from these results');
  });
});

// ---------------------------------------------------------------------------
// The empty result is the dangerous one. A strict broad scan that just DROPPED
// a real writer renders no table at all, so the only thing left is the
// `role="status" aria-live="polite"` summary — the one region a screen reader
// announces, and the one a hurried user reads. The Scan-scope panel sits
// OUTSIDE the live region, so an unqualified "Nothing found" here is the
// "asks, sees nothing, edits the field, breaks a flow" path.
// ---------------------------------------------------------------------------
describe('features/field-impact — the empty result carries its own caveat', () => {
  // The org's one recently-modified flow DOES write Status, through a reference
  // the parser cannot bind to an object. Strict adjudication drops it, and the
  // user is left with zero rows.
  const writesStatusUnbindably = {
    label: 'Order Wrapper Builder',
    variables: [{ name: 'wrapper', dataType: 'Apex', apexClass: 'OrderWrapper' }],
    assignments: [
      {
        name: 'Fill',
        label: 'Fill Wrapper',
        assignmentItems: [{ assignToReference: 'wrapper.Status', operator: 'Assign', value: {} }],
      },
    ],
  };

  function emptyResultApi(): SalesforceApiClient {
    const toolingQuery = vi.fn(async (soql: string) => {
      if (soql.includes('FROM FlowDefinition')) {
        return { records: [{ ActiveVersionId: '301ccc' }], size: 1, done: true };
      }
      if (soql.includes('FROM Flow WHERE Id')) {
        return {
          records: [
            {
              Id: '301ccc',
              MasterLabel: 'Order Wrapper Builder',
              Status: 'Active',
              Definition: { DeveloperName: 'Order_Wrapper_Builder' },
              Metadata: writesStatusUnbindably,
            },
          ],
          size: 1,
          done: true,
        };
      }
      return { records: [], size: 0, done: true };
    });
    return {
      apiVersion: 'v62.0',
      orgOrigin: ORIGIN,
      apiGet: vi.fn(async () => ({})),
      query: vi.fn(),
      toolingQuery,
      apiRequest: vi.fn(),
    } as unknown as SalesforceApiClient;
  }

  it('produces no rows at all in this scenario (the premise of the rest)', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: emptyResultApi() });
    await feature.openFor('Case', 'Status');
    await tick();
    expect(document.querySelectorAll('tbody tr').length).toBe(0);
    expect(document.querySelector('table')).toBeNull();
  });

  it('HEDGES the announced summary rather than stating a flat negative', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: emptyResultApi() });
    await feature.openFor('Case', 'Status');
    await tick();

    const summary = document.querySelector('[role="status"]')!;
    // It is the live region that must carry the qualifier — the note panel is
    // never announced.
    expect(summary.getAttribute('aria-live')).toBe('polite');
    const text = summary.textContent!;
    expect(text).toContain('in the scanned set');
    expect(text).toContain('partial scan');
    expect(text).toContain('see Scan scope');
    // The unqualified sentence must NOT be what gets announced.
    expect(text).not.toBe('Nothing found that writes Case.Status.');
    expect(text).not.toMatch(/writes Case\.Status\.$/);
  });

  it('still renders the Scan scope note when there are zero rows', async () => {
    // buildNotes() sits OUTSIDE the `counts.total > 0` guard on purpose; an
    // empty result is exactly when the caveats matter most. Pinned so a later
    // refactor cannot quietly move it inside.
    const feature = createFieldImpactFeature({ win: fakeWin(), api: emptyResultApi() });
    await feature.openFor('Case', 'Status');
    await tick();

    const note = document.querySelector('[role="note"]');
    expect(note).not.toBeNull();
    expect(note!.getAttribute('aria-label')).toBe('Scan scope');
    expect(note!.textContent).toContain('not every flow in the org');
    expect(note!.textContent).toContain('are therefore missing from these results');
  });

  it('still renders the legend when there are zero rows', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: emptyResultApi() });
    await feature.openFor('Case', 'Status');
    await tick();
    expect(document.body.textContent).toContain(STATUS_LEGEND.confirmed);
    expect(document.body.textContent).toContain(STATUS_LEGEND.inferred);
  });

  it('leaves a populated result unhedged — the qualifier is not boilerplate', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: stubApi() });
    await feature.openFor('Account', 'Industry__c');
    await tick();
    const text = document.querySelector('[role="status"]')!.textContent!;
    expect(text).toContain('source(s)');
    expect(text).not.toContain('in the scanned set');
  });
});

// ---------------------------------------------------------------------------
// B2 — a refused query is a failed query, not a finding about the org. It also
// silently switches adjudication to the strict rule, so misattributing it is
// two wrongs compounding into one confident false story.
// ---------------------------------------------------------------------------
describe('features/field-impact — a refused query is never reported as a finding', () => {
  function refusedApi(which: 'customField' | 'dependency'): SalesforceApiClient {
    const toolingQuery = vi.fn(async (soql: string) => {
      if (soql.includes('FROM CustomField')) {
        if (which === 'customField') throw new Error('INSUFFICIENT_ACCESS_OR_READONLY');
        return { records: [{ Id: '00Nxx1' }], size: 1, done: true };
      }
      if (soql.includes('MetadataComponentDependency')) {
        throw new Error('sObject type MetadataComponentDependency is not supported');
      }
      return { records: [], size: 0, done: true };
    });
    return {
      apiVersion: 'v62.0',
      orgOrigin: ORIGIN,
      apiGet: vi.fn(async () => ({})),
      query: vi.fn(),
      toolingQuery,
      apiRequest: vi.fn(),
    } as unknown as SalesforceApiClient;
  }

  it('names a refused CustomField lookup and the reason it failed', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: refusedApi('customField') });
    await feature.openFor('Account', 'Industry__c');
    await tick();
    const note = document.querySelector('[role="note"]')!.textContent!;
    expect(note).toContain('The CustomField lookup for Account.Industry__c was refused');
    expect(note).toContain('INSUFFICIENT_ACCESS_OR_READONLY');
    expect(note).toContain('this is a failed query, not a finding about your org');
  });

  it('does NOT claim "No dependency edge" when the lookup was refused', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: refusedApi('customField') });
    await feature.openFor('Account', 'Industry__c');
    await tick();
    const note = document.querySelector('[role="note"]')!.textContent!;
    // Case-insensitive: the panel must not assert the absence of an edge in ANY
    // casing when the query that would have found one never ran.
    expect(note.toLowerCase()).not.toContain('dependency edge for');
    // …and the strictness is attributed to the real cause instead.
    expect(note).toContain('Because the lookup above failed');
    expect(note).toContain('could not be narrowed');
  });

  it('applies the same rule when MetadataComponentDependency itself is refused', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: refusedApi('dependency') });
    await feature.openFor('Account', 'Industry__c');
    await tick();
    const note = document.querySelector('[role="note"]')!.textContent!;
    expect(note).toContain('could not be narrowed via MetadataComponentDependency');
    expect(note.toLowerCase()).not.toContain('dependency edge for');
  });

  // N8: only ONE of the four reasons for falling back is a measurement. The
  // note must say which one applies rather than reaching for the strongest
  // phrasing, and "no dependency edge" is only earned when the query ran.
  it('says "No dependency edge was found" only when the query actually RAN and was empty', async () => {
    const toolingQuery = vi.fn(async (soql: string) => {
      // Custom field, CustomField row exists, dependency query returns nothing:
      // the one case where the absence of an edge was genuinely measured.
      if (soql.includes('FROM CustomField')) return { records: [{ Id: '00Nxx1' }], size: 1, done: true };
      return { records: [], size: 0, done: true };
    });
    const api = {
      apiVersion: 'v62.0',
      orgOrigin: ORIGIN,
      apiGet: vi.fn(async () => ({})),
      query: vi.fn(),
      toolingQuery,
      apiRequest: vi.fn(),
    } as unknown as SalesforceApiClient;
    const feature = createFieldImpactFeature({ win: fakeWin(), api });
    await feature.openFor('Account', 'Industry__c');
    await tick();
    const note = document.querySelector('[role="note"]')!.textContent!;
    expect(note).toContain('No dependency edge was found for Account.Industry__c');
    expect(note).not.toContain('was refused');
    expect(note).not.toContain('is a standard field');
  });

  it('does NOT claim a measured absence for a STANDARD field — the query never ran', async () => {
    const api = stubApi();
    const feature = createFieldImpactFeature({ win: fakeWin(), api });
    await feature.openFor('Account', 'Industry');
    await tick();
    const note = document.querySelector('[role="note"]')!.textContent!;
    expect(note).toContain('Account.Industry is a standard field');
    expect(note).toContain('no CustomField record for a dependency edge to point at');
    expect(note.toLowerCase()).not.toContain('no dependency edge was found');
    // …and the claim is honest because the query genuinely was short-circuited.
    const queries = (api.toolingQuery as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(queries.some((q: string) => q.includes('FROM CustomField'))).toBe(false);
  });

  it('says the CustomField record was missing when the lookup ran but found nothing', async () => {
    const toolingQuery = vi.fn(async () => ({ records: [], size: 0, done: true }));
    const api = {
      apiVersion: 'v62.0',
      orgOrigin: ORIGIN,
      apiGet: vi.fn(async () => ({})),
      query: vi.fn(),
      toolingQuery,
      apiRequest: vi.fn(),
    } as unknown as SalesforceApiClient;
    const feature = createFieldImpactFeature({ win: fakeWin(), api });
    await feature.openFor('Account', 'Ghost__c');
    await tick();
    const note = document.querySelector('[role="note"]')!.textContent!;
    expect(note).toContain('No CustomField record was found for Account.Ghost__c');
    expect(note.toLowerCase()).not.toContain('no dependency edge was found');
  });
});

// ---------------------------------------------------------------------------
// B3 — an un-analysable candidate must not assert a reference nobody
// established. On the broad scan the flow is in the set only for being recently
// modified, so with no metadata there is no evidence of ANYTHING: a row there
// would contradict the note printed above it and, by making counts.total === 1,
// silently disable the empty-state hedge on the exact path that needs it.
// Both ways the metadata can go missing are covered on both paths.
// ---------------------------------------------------------------------------
describe('features/field-impact — an unreadable flow never implies a reference', () => {
  const UNRELATED = 'Unrelated Opportunity Flow';

  /** @param mode how the metadata goes missing; @param custom drives which path. */
  function unreadableApi(mode: 'throws' | 'null-metadata', custom: boolean): SalesforceApiClient {
    const toolingQuery = vi.fn(async (soql: string) => {
      if (soql.includes('FROM CustomField')) {
        return custom ? { records: [{ Id: '00Nxx1' }], size: 1, done: true } : { records: [], size: 0, done: true };
      }
      if (soql.includes('MetadataComponentDependency')) {
        return { records: [{ MetadataComponentId: '301zzz' }], size: 1, done: true };
      }
      if (soql.includes('FROM FlowDefinition')) {
        return { records: [{ ActiveVersionId: '301zzz' }], size: 1, done: true };
      }
      if (soql.includes('FROM Flow WHERE Id')) {
        if (mode === 'throws') throw new Error('METADATA_TOO_LARGE');
        return {
          records: [
            {
              Id: '301zzz',
              MasterLabel: UNRELATED,
              Status: 'Active',
              Definition: { DeveloperName: 'Unrelated_Opportunity_Flow' },
              Metadata: null,
            },
          ],
          size: 1,
          done: true,
        };
      }
      return { records: [], size: 0, done: true };
    });
    return {
      apiVersion: 'v62.0',
      orgOrigin: ORIGIN,
      apiGet: vi.fn(async () => ({})),
      query: vi.fn(),
      toolingQuery,
      apiRequest: vi.fn(),
    } as unknown as SalesforceApiClient;
  }

  // S4: a THIRD way to end up with nothing to analyse — the metadata query
  // succeeds and returns no row at all (version deleted between the two
  // queries, or a dangling dependency edge). It used to `continue`, dropping
  // the candidate without counting it, so the note described a candidate the
  // result set did not contain. It must behave exactly like the other two.
  describe('a metadata query that returns NO ROW is treated like any other unreadable flow', () => {
    function noRowApi(custom: boolean): SalesforceApiClient {
      const toolingQuery = vi.fn(async (soql: string) => {
        if (soql.includes('FROM CustomField')) {
          return custom
            ? { records: [{ Id: '00Nxx1' }], size: 1, done: true }
            : { records: [], size: 0, done: true };
        }
        if (soql.includes('MetadataComponentDependency')) {
          return { records: [{ MetadataComponentId: '301qqq' }], size: 1, done: true };
        }
        if (soql.includes('FROM FlowDefinition')) {
          return { records: [{ ActiveVersionId: '301qqq' }], size: 1, done: true };
        }
        // The candidate exists as an id, but the version row is gone.
        if (soql.includes('FROM Flow WHERE Id')) return { records: [], size: 0, done: true };
        return { records: [], size: 0, done: true };
      });
      return {
        apiVersion: 'v62.0',
        orgOrigin: ORIGIN,
        apiGet: vi.fn(async () => ({})),
        query: vi.fn(),
        toolingQuery,
        apiRequest: vi.fn(),
      } as unknown as SalesforceApiClient;
    }

    it('counts and discloses it on the broad scan instead of dropping it silently', async () => {
      const feature = createFieldImpactFeature({ win: fakeWin(), api: noRowApi(false) });
      await feature.openFor('Account', 'Status');
      await tick();
      const note = document.querySelector('[role="note"]')!.textContent!;
      expect(note).toContain('1 flow(s) in the scanned set could not be read');
      expect(document.querySelectorAll('tbody tr').length).toBe(0);
      expect(document.querySelector('[role="status"]')!.textContent).toContain('in the scanned set');
    });

    it('keeps the dependency-path note truthful by actually listing the lead', async () => {
      // The note promises these are "listed as an inferred lead rather than
      // dropped". Dropping it here is what made the note contradict the result.
      const feature = createFieldImpactFeature({ win: fakeWin(), api: noRowApi(true) });
      await feature.openFor('Account', 'Industry__c');
      await tick();
      const note = document.querySelector('[role="note"]')!.textContent!;
      expect(note).toContain('1 flow(s) linked to Account.Industry__c could not be read');
      expect(note).toContain('inferred lead rather than dropped');
      // …and the promise holds: the lead is really there.
      expect(document.querySelectorAll('tbody tr').length).toBe(1);
      expect(document.querySelector('[role="status"]')!.textContent).toContain('1 source(s)');
    });
  });

  for (const mode of ['throws', 'null-metadata'] as const) {
    describe(`broad scan, metadata ${mode}`, () => {
      it('does not list the flow at all', async () => {
        const feature = createFieldImpactFeature({ win: fakeWin(), api: unreadableApi(mode, false) });
        await feature.openFor('Account', 'Status');
        await tick();
        expect(document.body.textContent).not.toContain(UNRELATED);
        expect(document.body.textContent).not.toContain('References this field');
        expect(document.querySelectorAll('tbody tr').length).toBe(0);
      });

      it('keeps the empty-state hedge instead of announcing a confident count', async () => {
        // The regression this guards: a single unreadable flow made
        // counts.total === 1, so the run took the populated branch and
        // announced "1 source(s)" — defeating the hedge entirely.
        const feature = createFieldImpactFeature({ win: fakeWin(), api: unreadableApi(mode, false) });
        await feature.openFor('Account', 'Status');
        await tick();
        const summary = document.querySelector('[role="status"]')!.textContent!;
        expect(summary).not.toContain('source(s)');
        expect(summary).toContain('in the scanned set');
        expect(summary).toContain('partial scan');
      });

      it('discloses the drop rather than performing it silently', async () => {
        const feature = createFieldImpactFeature({ win: fakeWin(), api: unreadableApi(mode, false) });
        await feature.openFor('Account', 'Status');
        await tick();
        const note = document.querySelector('[role="note"]')!.textContent!;
        expect(note).toContain('1 flow(s) in the scanned set could not be read');
        expect(note).toContain('are NOT listed');
        expect(note).toContain('no reference to report');
      });

      it('leaves the note\'s "only when its metadata binds the write" promise true', async () => {
        const feature = createFieldImpactFeature({ win: fakeWin(), api: unreadableApi(mode, false) });
        await feature.openFor('Account', 'Status');
        await tick();
        const note = document.querySelector('[role="note"]')!.textContent!;
        // The promise is printed…
        expect(note).toContain('only reported when its metadata binds the write to Account');
        // …and nothing is reported that would contradict it.
        expect(document.querySelectorAll('tbody tr').length).toBe(0);
      });
    });

    describe(`dependency path, metadata ${mode}`, () => {
      it('KEEPS the flow as an inferred lead — the edge established the reference', async () => {
        const feature = createFieldImpactFeature({ win: fakeWin(), api: unreadableApi(mode, true) });
        await feature.openFor('Account', 'Industry__c');
        await tick();
        expect(document.body.textContent).toContain('References this field');
        expect(document.querySelector('[role="status"]')!.textContent).toContain('1 source(s)');
      });

      it('discloses that the metadata was unreadable, without dropping it', async () => {
        const feature = createFieldImpactFeature({ win: fakeWin(), api: unreadableApi(mode, true) });
        await feature.openFor('Account', 'Industry__c');
        await tick();
        const note = document.querySelector('[role="note"]')!.textContent!;
        expect(note).toContain('1 flow(s) linked to Account.Industry__c could not be read');
        expect(note).toContain('inferred lead rather than dropped');
      });
    });
  }
});

// ---------------------------------------------------------------------------
// B1's user-facing half + the symmetric disclosure the lenient path was missing.
// ---------------------------------------------------------------------------
describe('features/field-impact — the parser states its OWN bound', () => {
  it('names the constructs it does not model whenever a flow was parsed', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: stubApi() });
    await feature.openFor('Account', 'Industry__c');
    await tick();
    const note = document.querySelector('[role="note"]')!.textContent!;
    expect(note).toContain('Transform elements');
    expect(note).toContain('invocable and quick actions');
    expect(note).toContain('bodies of called subflows');
    expect(note).toContain('are NOT parsed');
  });

  it('states it on the broad-scan path too — the class is invisible on BOTH', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: stubApi() });
    await feature.openFor('Account', 'Industry');
    await tick();
    expect(document.querySelector('[role="note"]')!.textContent).toContain('Transform elements');
  });

  it('omits it when no flow was parsed at all — nothing to caveat', async () => {
    const toolingQuery = vi.fn(async () => ({ records: [], size: 0, done: true }));
    const api = {
      apiVersion: 'v62.0',
      orgOrigin: ORIGIN,
      apiGet: vi.fn(async () => ({})),
      query: vi.fn(),
      toolingQuery,
      apiRequest: vi.fn(),
    } as unknown as SalesforceApiClient;
    const feature = createFieldImpactFeature({ win: fakeWin(), api });
    await feature.openFor('Account', 'Industry');
    await tick();
    expect(document.querySelector('[role="note"]')!.textContent).not.toContain('Transform elements');
  });

  it('discloses the LENIENT rule too, so the two paths are comparable', async () => {
    // Disclosing only the strict side is what makes the asymmetry confusing:
    // the same flow can be an inferred lead for a custom field and dropped for a
    // standard one, with nothing telling the user the rule changed.
    const feature = createFieldImpactFeature({ win: fakeWin(), api: stubApi() });
    await feature.openFor('Account', 'Industry__c');
    await tick();
    const note = document.querySelector('[role="note"]')!.textContent!;
    expect(note).toContain('linked to Account.Industry__c by a dependency edge');
    expect(note).toContain('inferred leads rather than dropped');
    expect(note).toContain('not directly comparable');
  });
});

// ---------------------------------------------------------------------------
// S1 — unreadable workflow `Metadata` turns a field update on the object into an
// inferred row against whatever field was asked about. That noise needs a stated
// cause. The list is ORG-WIDE (no object filter is possible), so the same
// section pins down what happens to rows that cannot be tied to an object at
// all — they must not land in this field's results.
// ---------------------------------------------------------------------------
describe('features/field-impact — unreadable workflow metadata explains itself', () => {
  /**
   * @param detail  per-Id behaviour: 'no-metadata' (FullName only), 'unbound'
   *                (neither), or 'refused' (the detail query throws).
   */
  function workflowApi(
    detail: 'no-metadata' | 'unbound' | 'refused' = 'no-metadata',
    listFailure?: string,
  ): SalesforceApiClient {
    const toolingQuery = vi.fn(async (soql: string) => {
      if (soql.includes("WHERE Id = '04Y")) {
        if (detail === 'refused') throw new Error('Metadata projection not supported');
        const id = soql.slice(soql.indexOf("'04Y") + 1, soql.indexOf("' LIMIT"));
        return {
          records: [
            detail === 'unbound'
              ? { Id: id }
              : { Id: id, FullName: `Account.${id}`, Metadata: null },
          ],
          size: 1,
          done: true,
        };
      }
      if (soql.includes('FROM WorkflowFieldUpdate')) {
        if (listFailure) throw new Error(listFailure);
        return {
          records: [
            { Id: '04Yxx1', Name: 'Set Something' },
            { Id: '04Yxx2', Name: 'Set Other' },
          ],
          size: 2,
          done: true,
        };
      }
      return { records: [], size: 0, done: true };
    });
    return {
      apiVersion: 'v62.0',
      orgOrigin: ORIGIN,
      apiGet: vi.fn(async () => ({})),
      query: vi.fn(),
      toolingQuery,
      apiRequest: vi.fn(),
    } as unknown as SalesforceApiClient;
  }

  it('counts and explains rows whose Metadata came back unreadable', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: workflowApi() });
    await feature.openFor('Account', 'Industry');
    await tick();
    const note = document.querySelector('[role="note"]')!.textContent!;
    expect(note).toContain('2 workflow field update(s) on Account returned no readable Metadata');
    expect(note).toContain('not evidence they write this field');
  });

  // The list is org-wide, so an update with no FullName may belong to ANY
  // object. Rendering it would drop every unreadable field update in the org
  // into this field's results.
  it('drops updates whose object could not be bound, and says so instead', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: workflowApi('unbound') });
    await feature.openFor('Account', 'Industry');
    await tick();
    const note = document.querySelector('[role="note"]')!.textContent!;
    expect(note).toContain('2 workflow field update(s) were read but carried no FullName');
    expect(note).toContain('They are NOT listed');
    expect(note).not.toContain('returned no readable Metadata');
    expect(document.body.textContent).not.toContain('Set Something');
  });

  it('treats a refused detail read the same as an unbindable one', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: workflowApi('refused') });
    await feature.openFor('Account', 'Industry');
    await tick();
    const note = document.querySelector('[role="note"]')!.textContent!;
    expect(note).toContain('carried no FullName');
  });

  // Regression: the old code queried a `TableEnumOrId` column that does not
  // exist on WorkflowFieldUpdate, then "fell back" to a second query built from
  // the same builder — which failed identically while the panel claimed each
  // update had been read individually.
  it('reports a failed list as a failed query, never as "nothing updates this"', async () => {
    const feature = createFieldImpactFeature({
      win: fakeWin(),
      api: workflowApi('no-metadata', "No such column 'TableEnumOrId'"),
    });
    await feature.openFor('Account', 'Industry');
    await tick();
    const note = document.querySelector('[role="note"]')!.textContent!;
    expect(note).toContain('Workflow field updates could not be listed');
    expect(note).toContain('so NONE were checked');
    expect(note).toContain('not a finding that nothing updates Account');
    expect(note).not.toContain('read individually');
  });
});

describe('features/field-impact — the Apex cap is a real bound', () => {
  function manyApexHitsApi(count: number): SalesforceApiClient {
    // SOSL applies a statement-trailing LIMIT per returned sObject type, so two
    // RETURNING types can hand back 2x the cap. The client-side truncation is
    // what makes APEX_HIT_CAP mean what its name says.
    const searchRecords = Array.from({ length: count }, (_, i) => ({
      Id: `01p${String(i).padStart(12, '0')}`,
      Name: `AccountService${String(i).padStart(3, '0')}`,
      attributes: { type: i % 2 === 0 ? 'ApexClass' : 'ApexTrigger' },
    }));
    return {
      apiVersion: 'v62.0',
      orgOrigin: ORIGIN,
      apiGet: vi.fn(async (endpoint: string) =>
        endpoint.includes('/tooling/search/') ? { searchRecords } : {},
      ),
      query: vi.fn(),
      toolingQuery: vi.fn(async () => ({ records: [], size: 0, done: true })),
      apiRequest: vi.fn(),
    } as unknown as SalesforceApiClient;
  }

  it('renders at most 25 Apex rows even when the search returns 50', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: manyApexHitsApi(50) });
    await feature.openFor('Account', 'Industry__c');
    await tick();
    const rows = document.querySelectorAll('tbody tr');
    expect(rows.length).toBe(25);
  });

  it('discloses the truncation as a scope note without claiming a true match count', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: manyApexHitsApi(50) });
    await feature.openFor('Account', 'Industry__c');
    await tick();
    const note = document.querySelector('[role="note"]')!.textContent!;
    expect(note).toContain('RETURNED 50 classes/triggers');
    expect(note).toContain('the first 25');
    expect(note).toContain('More may exist');
    // The count is measured AFTER the server-side per-object LIMITs, so it is
    // min(actual, 50) — never assert it as the number of matches (N5).
    expect(note).not.toContain('matched 50');
    expect(note).toContain('not the true number of matches');
  });

  it('adds no cap note when the result set is under the bound', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: manyApexHitsApi(4) });
    await feature.openFor('Account', 'Industry__c');
    await tick();
    expect(document.querySelectorAll('tbody tr').length).toBe(4);
    expect(document.body.textContent).not.toContain('More may exist');
  });

  it('truncates deterministically (by type, then name)', async () => {
    const feature = createFieldImpactFeature({ win: fakeWin(), api: manyApexHitsApi(50) });
    await feature.openFor('Account', 'Industry__c');
    await tick();
    const rows = [...document.querySelectorAll('tbody tr')];
    const names = rows.map((tr) => tr.querySelectorAll('td')[2]!.textContent);
    const types = rows.map((tr) => tr.querySelectorAll('td')[1]!.textContent);
    // 25 ApexClass + 25 ApexTrigger came back; sorting by type then name means
    // the retained window is exactly the classes, in name order.
    expect(new Set(types)).toEqual(new Set(['Apex Class']));
    expect(names[0]).toBe('AccountService000');
    expect(names[names.length - 1]).toBe('AccountService048');
    expect(names).toEqual([...names].sort());
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
