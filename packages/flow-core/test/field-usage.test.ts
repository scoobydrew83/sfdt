import { describe, it, expect } from 'vitest';
import {
  analyzeFieldUsage,
  applyPopulation,
  chunk,
  customFieldsForObjectQuery,
  dependencyBatchQuery,
  DEPENDENCY_CHUNK,
  DEPENDENCY_ROW_CAP,
  type FieldUsageQueries,
  type FieldUsageVM,
} from '../src/field-usage.js';

// This module exists to avoid ONE mistake: calling a field "unused" when all
// that was established is that a bounded scan found no edge. Nearly every test
// here is a guard against some path that would silently collapse a three-state
// answer (referenced / unreferenced / UNKNOWN) into two.

function fakeQueries(
  handlers: Array<[RegExp, unknown[] | Error]>,
): FieldUsageQueries & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    async toolingQuery<T>(soql: string): Promise<{ records: T[] }> {
      seen.push(soql);
      for (const [pattern, response] of handlers) {
        if (pattern.test(soql)) {
          if (response instanceof Error) throw response;
          return { records: response as T[] };
        }
      }
      return { records: [] };
    },
  };
}

const FIELDS = [
  { name: 'Id', type: 'id', custom: false },
  { name: 'Name', type: 'string', custom: false },
  { name: 'Region__c', type: 'picklist', custom: true },
  { name: 'Legacy__c', type: 'string', custom: true },
];

describe('chunking', () => {
  it('splits into fixed-size batches with a short tail', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 10)).toEqual([]);
  });

  it('refuses a non-positive size instead of looping forever', () => {
    expect(() => chunk([1], 0)).toThrow(/positive/);
  });

  it('batches so N fields cost ceil(N / DEPENDENCY_CHUNK) queries', () => {
    const ids = Array.from({ length: DEPENDENCY_CHUNK * 2 + 1 }, (_, i) => `id${i}`);
    expect(chunk(ids, DEPENDENCY_CHUNK)).toHaveLength(3);
  });
});

describe('query builders', () => {
  it('escapes the object name', () => {
    expect(customFieldsForObjectQuery("Acc'ount")).toContain("\\'");
  });

  it('selects RefMetadataComponentId so rows can be attributed back to a field', () => {
    // Without it a batch is a bag of references with no owner — which is the
    // whole reason the naive version queries one field at a time.
    const q = dependencyBatchQuery(['00N1', '00N2']);
    expect(q).toContain('SELECT RefMetadataComponentId');
    expect(q).toContain("IN ('00N1','00N2')");
    expect(q).toContain(`LIMIT ${DEPENDENCY_ROW_CAP}`);
  });
});

describe('analyzeFieldUsage — the three-state answer', () => {
  it('separates referenced, unreferenced and unknown', async () => {
    const q = fakeQueries([
      [/FROM CustomField/, [
        { Id: '00N1', DeveloperName: 'Region' },
        { Id: '00N2', DeveloperName: 'Legacy' },
      ]],
      [/MetadataComponentDependency/, [
        { RefMetadataComponentId: '00N1', MetadataComponentName: 'AccountTrigger', MetadataComponentType: 'ApexTrigger' },
      ]],
    ]);

    const vm = await analyzeFieldUsage(q, { object: 'Account', fields: FIELDS });
    const byName = Object.fromEntries(vm.rows.map((r) => [r.name, r]));

    expect(byName.Region__c.unreferenced).toBe(false);
    expect(byName.Region__c.referenceCount).toBe(1);
    expect(byName.Region__c.references[0]).toEqual({ type: 'ApexTrigger', names: ['AccountTrigger'] });

    expect(byName.Legacy__c.unreferenced).toBe(true);

    // Standard fields have no CustomField row — unknown, never "unreferenced".
    expect(byName.Id.unreferenced).toBeNull();
    expect(byName.Name.unreferenced).toBeNull();

    expect(vm.counts).toMatchObject({ total: 4, scanned: 2, unreferenced: 1, unknown: 2 });
  });

  it('says WHY standard fields are unknown instead of leaving them unexplained', async () => {
    const q = fakeQueries([[/FROM CustomField/, []]]);
    const vm = await analyzeFieldUsage(q, { object: 'Account', fields: FIELDS });

    expect(vm.notes.some((n) => n.includes('no CustomField record'))).toBe(true);
    expect(vm.notes.some((n) => n.includes('NOT as unreferenced'))).toBe(true);
  });

  it('reports every field as unknown when the CustomField lookup is refused', async () => {
    // The dangerous failure: an empty id list looks exactly like "this object
    // has no custom fields", which would mark every custom field unreferenced.
    const q = fakeQueries([[/FROM CustomField/, new Error('INSUFFICIENT_ACCESS')]]);
    const vm = await analyzeFieldUsage(q, { object: 'Account', fields: FIELDS });

    expect(vm.rows.every((r) => r.unreferenced === null)).toBe(true);
    expect(vm.counts.unreferenced).toBe(0);
    expect(vm.notes.some((n) => n.includes('NO field could be checked'))).toBe(true);
  });

  it('marks a failed dependency batch unknown rather than clean', async () => {
    const q = fakeQueries([
      [/FROM CustomField/, [{ Id: '00N1', DeveloperName: 'Region' }]],
      [/MetadataComponentDependency/, new Error('QUERY_TIMEOUT')],
    ]);
    const vm = await analyzeFieldUsage(q, { object: 'Account', fields: FIELDS });

    expect(vm.rows.find((r) => r.name === 'Region__c')!.unreferenced).toBeNull();
    expect(vm.notes.some((n) => n.includes('dependency batch(es) failed'))).toBe(true);
  });

  it('discloses a batch that came back at the row cap', async () => {
    const rows = Array.from({ length: DEPENDENCY_ROW_CAP }, (_, i) => ({
      RefMetadataComponentId: '00N1',
      MetadataComponentName: `C${i}`,
      MetadataComponentType: 'ApexClass',
    }));
    const q = fakeQueries([
      [/FROM CustomField/, [{ Id: '00N1', DeveloperName: 'Region' }]],
      [/MetadataComponentDependency/, rows],
    ]);
    const vm = await analyzeFieldUsage(q, { object: 'Account', fields: FIELDS });

    expect(vm.notes.some((n) => n.includes('maximum'))).toBe(true);
  });

  it('always states that the dependency API is incomplete once it scanned anything', async () => {
    const q = fakeQueries([[/FROM CustomField/, [{ Id: '00N1', DeveloperName: 'Region' }]]]);
    const vm = await analyzeFieldUsage(q, { object: 'Account', fields: FIELDS });

    expect(vm.notes.some((n) => n.includes('not proof the field is unused'))).toBe(true);
  });

  it('sorts unreferenced first, then unknown, then referenced', async () => {
    const q = fakeQueries([
      [/FROM CustomField/, [
        { Id: '00N1', DeveloperName: 'Region' },
        { Id: '00N2', DeveloperName: 'Legacy' },
      ]],
      [/MetadataComponentDependency/, [
        { RefMetadataComponentId: '00N1', MetadataComponentName: 'T', MetadataComponentType: 'ApexTrigger' },
      ]],
    ]);
    const vm = await analyzeFieldUsage(q, { object: 'Account', fields: FIELDS });

    expect(vm.rows.map((r) => r.name)).toEqual(['Legacy__c', 'Id', 'Name', 'Region__c']);
  });
});

describe('applyPopulation — what "safe to remove" requires', () => {
  async function swept(): Promise<FieldUsageVM> {
    const q = fakeQueries([
      [/FROM CustomField/, [
        { Id: '00N1', DeveloperName: 'Region' },
        { Id: '00N2', DeveloperName: 'Legacy' },
      ]],
      [/MetadataComponentDependency/, [
        { RefMetadataComponentId: '00N1', MetadataComponentName: 'T', MetadataComponentType: 'ApexTrigger' },
      ]],
    ]);
    return analyzeFieldUsage(q, { object: 'Account', fields: FIELDS });
  }

  it('flags an unreferenced, empty, optional custom field', async () => {
    const vm = applyPopulation(await swept(), [{ field: 'Legacy__c', populated: 0 }], {
      totalRecords: 5000,
    });
    const row = vm.rows.find((r) => r.name === 'Legacy__c')!;

    expect(row.safeToRemove).toBe(true);
    expect(row.keepReason).toBeNull();
    expect(row.totalRecords).toBe(5000);
    expect(vm.counts.safeToRemove).toBe(1);
  });

  it('refuses an unreferenced field that still holds data', async () => {
    // THE case that separates this from a metadata-only tool. A field with no
    // dependency edge and two million values is not a cleanup candidate.
    const vm = applyPopulation(await swept(), [{ field: 'Legacy__c', populated: 2_000_000 }]);
    const row = vm.rows.find((r) => r.name === 'Legacy__c')!;

    expect(row.safeToRemove).toBe(false);
    expect(row.keepReason).toContain('2000000 value(s)');
  });

  it('refuses a field whose count FAILED — a missing count is not zero', async () => {
    const vm = applyPopulation(await swept(), [{ field: 'Legacy__c', populated: null }]);
    const row = vm.rows.find((r) => r.name === 'Legacy__c')!;

    expect(row.safeToRemove).toBe(false);
    expect(row.keepReason).toBe('population not measured');
  });

  it('refuses a field that was never counted at all', async () => {
    const vm = applyPopulation(await swept(), []);
    expect(vm.rows.find((r) => r.name === 'Legacy__c')!.keepReason).toBe('population not measured');
    expect(vm.counts.safeToRemove).toBe(0);
  });

  it('refuses required and unique fields even when empty and unreferenced', async () => {
    const base = await analyzeFieldUsage(
      fakeQueries([
        [/FROM CustomField/, [
          { Id: '00N3', DeveloperName: 'Req' },
          { Id: '00N4', DeveloperName: 'Ext' },
        ]],
      ]),
      {
        object: 'Account',
        fields: [
          { name: 'Req__c', type: 'string', custom: true, required: true },
          { name: 'Ext__c', type: 'string', custom: true, unique: true },
        ],
      },
    );
    const vm = applyPopulation(base, [
      { field: 'Req__c', populated: 0 },
      { field: 'Ext__c', populated: 0 },
    ]);

    expect(vm.rows.find((r) => r.name === 'Req__c')!.keepReason).toBe('required');
    expect(vm.rows.find((r) => r.name === 'Ext__c')!.keepReason).toContain('external key');
    expect(vm.counts.safeToRemove).toBe(0);
  });

  it('never flags a standard field, and never flags an unscanned one', async () => {
    const vm = applyPopulation(await swept(), [
      { field: 'Name', populated: 0 },
      { field: 'Id', populated: 0 },
    ]);

    expect(vm.rows.find((r) => r.name === 'Name')!.keepReason).toBe('standard field');
    // Unknown reference status can never become a removal recommendation.
    expect(vm.rows.every((r) => r.unreferenced === null && r.safeToRemove === true)).toBe(false);
  });

  it('explains a referenced field rather than silently omitting it', async () => {
    const vm = applyPopulation(await swept(), [{ field: 'Region__c', populated: 0 }]);
    expect(vm.rows.find((r) => r.name === 'Region__c')!.keepReason).toContain('referenced by 1');
  });
});
