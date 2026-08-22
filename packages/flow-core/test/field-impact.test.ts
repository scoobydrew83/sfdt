import { describe, it, expect } from 'vitest';
import {
  analyzeFieldImpact,
  buildFieldImpactVM,
  flowBuilderUrl,
  setupRecordUrl,
  customFieldIdQuery,
  flowCandidateQuery,
  apexSearchSosl,
  otherReferencesQuery,
  FLOW_CANDIDATE_CAP,
  REFERENCE_CAP,
  APEX_HIT_CAP,
  type FieldImpactQueries,
} from '../src/field-impact.js';

// The Chrome extension's suite (extension/test/field-impact.test.ts) drives this
// same module through its re-export shim and covers the rendering. What is
// asserted HERE is the contract that makes the module shareable at all:
//
//   1. a headless caller (no `origin`) gets null links, not root-relative ones;
//   2. a REFUSED query becomes a note that says so — never silence that reads
//      as "your org has none of these";
//   3. the scan never throws outward, so one dead source cannot lose the
//      answers the other two produced.
//
// Those three are exactly what a second, CLI-only implementation would have got
// subtly wrong.

/** A `FieldImpactQueries` driven by a table of SOQL-substring → response. */
function fakeQueries(
  soqlHandlers: Array<[RegExp, unknown[] | Error]>,
  searchResult: Array<{ Id?: string; Name?: string; attributes?: { type?: string } }> | Error = [],
): FieldImpactQueries & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    async toolingQuery<T>(soql: string): Promise<{ records: T[] }> {
      seen.push(soql);
      for (const [pattern, response] of soqlHandlers) {
        if (pattern.test(soql)) {
          if (response instanceof Error) throw response;
          return { records: response as T[] };
        }
      }
      return { records: [] };
    },
    async toolingSearch(sosl: string) {
      seen.push(sosl);
      if (searchResult instanceof Error) throw searchResult;
      return searchResult;
    },
  };
}

describe('pure query builders', () => {
  it('strips the __c suffix when resolving a CustomField id', () => {
    const q = customFieldIdQuery('Account', 'Region__c');
    expect(q).toContain("DeveloperName = 'Region'");
    expect(q).toContain("EntityDefinition.QualifiedApiName = 'Account'");
  });

  it('escapes a quote rather than letting it close the literal', () => {
    // The builders are the only place user input reaches SOQL text, so this is
    // the injection boundary for every surface at once.
    expect(customFieldIdQuery("Acc'ount", 'X__c')).toContain("\\'");
  });

  it('embeds the shared cap in the candidate query', () => {
    expect(flowCandidateQuery('01I000000000001')).toContain(`LIMIT ${FLOW_CANDIDATE_CAP}`);
  });

  it('refuses to build a SOSL term from a non-API-name', () => {
    // Returning null makes the caller disclose a skipped scan; interpolating
    // would put SOSL syntax inside the braces.
    expect(apexSearchSosl('Region__c')).toContain(`FIND {Region__c}`);
    expect(apexSearchSosl('Region c}')).toBeNull();
    expect(apexSearchSosl('')).toBeNull();
  });

  it('caps the Apex search per returned type as well as overall', () => {
    const sosl = apexSearchSosl('Region__c')!;
    expect(sosl.match(new RegExp(`LIMIT ${APEX_HIT_CAP}`, 'g'))).toHaveLength(3);
  });
});

describe('deep links for headless callers', () => {
  it('returns null rather than a root-relative path when origin is empty', () => {
    // The CLI has no host unless it pays for one. `/builder_…` printed in a
    // terminal is a broken link wearing the shape of a real one.
    expect(flowBuilderUrl('', '301000000000001')).toBeNull();
    expect(setupRecordUrl('', 'ApexClasses', '01p000000000001')).toBeNull();
  });

  it('builds real links when an origin is supplied', () => {
    expect(flowBuilderUrl('https://acme.lightning.force.com/', '301x')).toBe(
      'https://acme.lightning.force.com/builder_platform_interaction/flowBuilder.app?flowId=301x',
    );
    expect(setupRecordUrl('https://acme.lightning.force.com', 'ApexClasses', '01px')).toContain(
      'address=%2F01px',
    );
  });
});

describe('analyzeFieldImpact — refusals are reported, not swallowed', () => {
  it('says the CustomField lookup was REFUSED rather than implying no edge exists', async () => {
    const q = fakeQueries([[/FROM CustomField/, new Error('INSUFFICIENT_ACCESS')]]);
    const vm = await analyzeFieldImpact(q, { object: 'Account', field: 'Region__c' });

    const refusal = vm.notes.find((n) => n.includes('was refused'));
    expect(refusal).toBeDefined();
    expect(refusal).toContain('INSUFFICIENT_ACCESS');
    // The distinction the whole vocabulary rests on.
    expect(refusal).toContain('this is a failed query, not a finding about your org');
  });

  it('reports a failed workflow listing as unchecked, not as "nothing updates it"', async () => {
    const q = fakeQueries([[/FROM WorkflowFieldUpdate/, new Error('boom')]]);
    const vm = await analyzeFieldImpact(q, { object: 'Account', field: 'Region__c' });

    expect(vm.notes.some((n) => n.includes('NONE were checked'))).toBe(true);
  });

  it('reports an unavailable Apex search instead of an empty Apex section', async () => {
    const q = fakeQueries([], new Error('search endpoint refused'));
    const vm = await analyzeFieldImpact(q, { object: 'Account', field: 'Region__c' });

    expect(vm.notes.some((n) => n.includes('Apex text search unavailable'))).toBe(true);
  });

  it('does not throw when every single source fails — it returns the gaps', async () => {
    // One dead source must never cost the answers the others produced, so the
    // scan converts failures to notes rather than rejecting.
    const q = fakeQueries(
      [
        [/FROM CustomField/, new Error('a')],
        [/FROM FlowDefinition/, new Error('b')],
        [/FROM WorkflowFieldUpdate/, new Error('c')],
      ],
      new Error('d'),
    );
    const vm = await analyzeFieldImpact(q, { object: 'Account', field: 'Region__c' });

    expect(vm.rows).toEqual([]);
    expect(vm.counts.total).toBe(0);
    expect(vm.notes.length).toBeGreaterThanOrEqual(3);
  });
});

describe('analyzeFieldImpact — standard fields take the broad-scan path', () => {
  it('says a standard field has no CustomField record, and never runs that query', async () => {
    const q = fakeQueries([[/FROM FlowDefinition/, []]]);
    const vm = await analyzeFieldImpact(q, { object: 'Opportunity', field: 'StageName' });

    expect(q.seen.some((s) => /FROM CustomField/.test(s))).toBe(false);
    expect(vm.notes.some((n) => n.includes('is a standard field'))).toBe(true);
  });

  it('does not present an empty broad scan as "nothing writes it"', async () => {
    const q = fakeQueries([[/FROM FlowDefinition/, []]]);
    const vm = await analyzeFieldImpact(q, { object: 'Opportunity', field: 'StageName' });

    // Zero flows scanned is zero coverage, not a clean result.
    expect(vm.notes.some((n) => n.includes('NO flow was examined'))).toBe(true);
  });
});

describe('analyzeFieldImpact — a confirmed write', () => {
  it('marks a parsed Flow field assignment confirmed and links it when given an origin', async () => {
    const metadata = {
      start: { object: 'Account' },
      recordUpdates: [
        {
          name: 'Set_Region',
          label: 'Set Region',
          object: 'Account',
          inputAssignments: [{ field: 'Region__c', value: { stringValue: 'EMEA' } }],
        },
      ],
    };
    const q = fakeQueries([
      [/FROM CustomField/, [{ Id: '00N000000000001' }]],
      [/FROM MetadataComponentDependency/, [{ MetadataComponentId: '301000000000001' }]],
      [
        /FROM Flow\b/,
        [
          {
            Id: '301000000000001',
            MasterLabel: 'Account Region',
            Status: 'Active',
            Definition: { DeveloperName: 'Account_Region' },
            Metadata: metadata,
          },
        ],
      ],
    ]);

    const vm = await analyzeFieldImpact(q, {
      object: 'Account',
      field: 'Region__c',
      origin: 'https://acme.lightning.force.com',
    });

    const flow = vm.rows.find((r) => r.sourceType === 'Flow');
    expect(flow).toBeDefined();
    expect(flow!.status).toBe('confirmed');
    expect(flow!.name).toBe('Account_Region');
    expect(flow!.url).toContain('flowId=301000000000001');
    expect(vm.counts.confirmed).toBe(1);
  });

  it('always discloses the Flow parser\'s own unmodelled constructs once it parsed anything', async () => {
    // A flow writing the field only through a Transform or an invocable action
    // produces no row and no other note — so this caveat is the only trace.
    const q = fakeQueries([
      [/FROM CustomField/, [{ Id: '00N1' }]],
      [/FROM MetadataComponentDependency/, [{ MetadataComponentId: '301x' }]],
      [/FROM Flow\b/, [{ Id: '301x', MasterLabel: 'F', Metadata: { start: { object: 'Account' } } }]],
    ]);
    const vm = await analyzeFieldImpact(q, { object: 'Account', field: 'Region__c' });

    expect(vm.notes.some((n) => n.includes('Transform elements'))).toBe(true);
  });
});

describe('buildFieldImpactVM ordering', () => {
  it('puts confirmed rows before inferred ones', () => {
    const vm = buildFieldImpactVM({
      object: 'Account',
      field: 'Region__c',
      origin: '',
      apexHits: [{ id: '01p1', name: 'ZClass', type: 'ApexClass' }],
      workflowFieldUpdates: [
        { id: '04Y1', name: 'Account.Set', label: 'Set', object: 'Account', field: 'Region__c', unresolved: false },
      ],
    });

    expect(vm.rows[0].status).toBe('confirmed');
    expect(vm.rows[0].sourceType).toBe('WorkflowFieldUpdate');
    expect(vm.rows[1].status).toBe('inferred');
    expect(vm.counts).toEqual({ confirmed: 1, inferred: 1, total: 2 });
  });
});

describe('other references — "where does this field appear?"', () => {
  it('excludes flows, which are analysed properly elsewhere', () => {
    // A flow that merely READS the field must not surface as though it writes
    // it, so the reference query leaves flows to the write analysis.
    const q = otherReferencesQuery('00N1');
    expect(q).toContain("MetadataComponentType != 'Flow'");
    expect(q).toContain(`LIMIT ${REFERENCE_CAP}`);
  });

  it('reports validation rules, layouts and reports in ONE query, grouped by type', async () => {
    // Four bespoke per-type scans would each need a list-then-read-Metadata
    // pass and still miss whatever type nobody added. One dependency query gets
    // every type Salesforce records.
    const q = fakeQueries([
      [/FROM CustomField/, [{ Id: '00N1' }]],
      [/MetadataComponentType != 'Flow'/, [
        { MetadataComponentName: 'Account_Region_Required', MetadataComponentType: 'ValidationRule' },
        { MetadataComponentName: 'Account Layout', MetadataComponentType: 'Layout' },
        { MetadataComponentName: 'Regional Pipeline', MetadataComponentType: 'Report' },
        { MetadataComponentName: 'Welcome', MetadataComponentType: 'EmailTemplate' },
      ]],
    ]);
    const vm = await analyzeFieldImpact(q, { object: 'Account', field: 'Region__c' });

    expect(vm.referenceCount).toBe(4);
    expect(vm.references.map((g) => g.type).sort()).toEqual([
      'EmailTemplate', 'Layout', 'Report', 'ValidationRule',
    ]);
  });

  it('keeps references OUT of the writer rows', async () => {
    // The whole point of the split: a validation rule is not a writer, and
    // counting it as one would answer the wrong question.
    const q = fakeQueries([
      [/FROM CustomField/, [{ Id: '00N1' }]],
      [/MetadataComponentType != 'Flow'/, [
        { MetadataComponentName: 'VR', MetadataComponentType: 'ValidationRule' },
      ]],
    ]);
    const vm = await analyzeFieldImpact(q, { object: 'Account', field: 'Region__c' });

    expect(vm.rows).toEqual([]);
    expect(vm.counts.total).toBe(0);
    expect(vm.referenceCount).toBe(1);
    expect(vm.notes.some((n) => n.includes('without necessarily writing'))).toBe(true);
  });

  it('does not query references for a standard field, and does not repeat the reason', async () => {
    // No CustomField id exists; the flow scan already explains that in words.
    const q = fakeQueries([[/FROM FlowDefinition/, []]]);
    const vm = await analyzeFieldImpact(q, { object: 'Opportunity', field: 'StageName' });

    expect(q.seen.some((x) => /MetadataComponentType != 'Flow'/.test(x))).toBe(false);
    expect(vm.references).toEqual([]);
    expect(vm.notes.filter((n) => n.includes('is a standard field'))).toHaveLength(1);
  });

  it('reports a refused reference query as unchecked, not as "nothing else uses it"', async () => {
    const q = fakeQueries([
      [/FROM CustomField/, [{ Id: '00N1' }]],
      [/MetadataComponentType != 'Flow'/, new Error('INSUFFICIENT_ACCESS')],
    ]);
    const vm = await analyzeFieldImpact(q, { object: 'Account', field: 'Region__c' });

    expect(vm.notes.some((n) => n.includes('NONE were checked'))).toBe(true);
    expect(vm.referenceCount).toBe(0);
  });

  it('discloses a capped reference list', async () => {
    const rows = Array.from({ length: REFERENCE_CAP }, (_, i) => ({
      MetadataComponentName: `R${i}`,
      MetadataComponentType: 'Report',
    }));
    const q = fakeQueries([
      [/FROM CustomField/, [{ Id: '00N1' }]],
      [/MetadataComponentType != 'Flow'/, rows],
    ]);
    const vm = await analyzeFieldImpact(q, { object: 'Account', field: 'Region__c' });

    expect(vm.notes.some((n) => n.includes('hit its cap'))).toBe(true);
  });

  it('resolves the CustomField id ONCE for both scans', async () => {
    const q = fakeQueries([
      [/FROM CustomField/, [{ Id: '00N1' }]],
      [/MetadataComponentType != 'Flow'/, []],
    ]);
    await analyzeFieldImpact(q, { object: 'Account', field: 'Region__c' });

    expect(q.seen.filter((x) => /FROM CustomField/.test(x))).toHaveLength(1);
  });
});
