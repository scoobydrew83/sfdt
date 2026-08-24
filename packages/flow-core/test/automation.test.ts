import { describe, it, expect } from 'vitest';
import {
  AUTOMATION_TYPES,
  findAutomationType,
  automationListQuery,
  metadataFetchQuery,
  toAutomationRow,
  toggledMetadata,
  activeMetadataKey,
  buildAutomationGrid,
  type AutomationQueries,
} from '../src/automation.js';

// The failure this module is shaped against is a uniform on/off button over five
// things that are written three different ways — and one of them (an Apex
// trigger in production) cannot be written as a record at all. Most of what
// follows checks that the difference survives into the data, plus the one
// operation that can destroy metadata if it is got wrong.

function fakeQueries(handlers: Array<[RegExp, unknown[] | Error]>): AutomationQueries & { seen: string[] } {
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

const type = (id: string) => findAutomationType(id)!;

describe('the type model', () => {
  it('does NOT list Process Builder as its own type', () => {
    // A Process Builder process IS a Flow, differing only by ProcessType.
    // Listing it separately would be marketing, not modelling.
    expect(AUTOMATION_TYPES.map((t) => t.id)).toEqual([
      'flow', 'validation-rule', 'duplicate-rule', 'workflow-rule', 'apex-trigger',
    ]);
    expect(type('flow').label).toContain('Process Builder');
  });

  it('records that two of the five need a metadata deploy, not a record write', () => {
    const deploy = AUTOMATION_TYPES.filter((t) => t.writeMode === 'metadata-deploy').map((t) => t.id);
    expect(deploy).toEqual(['workflow-rule', 'apex-trigger']);
  });

  it("says out loud that a trigger's status cannot be a record update in production", () => {
    expect(type('apex-trigger').writeNote).toContain('CANNOT be changed by a record update');
  });

  it('resolves a type by id or by sObject name', () => {
    expect(findAutomationType('ValidationRule')?.id).toBe('validation-rule');
    expect(findAutomationType('  FLOW  ')?.id).toBe('flow');
    expect(findAutomationType('nonsense')).toBeNull();
  });
});

describe('list queries', () => {
  it('select Id — without which a row cannot be acted on', () => {
    // The `audit inactive-*` checks omit Id, which is why they can report a
    // problem but never fix one.
    for (const t of AUTOMATION_TYPES) {
      expect(automationListQuery(t)).toMatch(/SELECT Id\b/);
    }
  });

  it('query BOTH states, unlike the audit checks', () => {
    // `checkInactiveValidations` filters `WHERE Active = false`; a grid needs
    // everything.
    expect(automationListQuery(type('validation-rule'))).not.toContain('Active = false');
    expect(automationListQuery(type('workflow-rule'))).not.toContain('Active = false');
  });

  it('captures the active flow VERSION, which deactivating discards', () => {
    expect(automationListQuery(type('flow'))).toContain('ActiveVersion.VersionNumber');
  });

  it('escapes the id in a metadata fetch', () => {
    expect(metadataFetchQuery(type('flow'), "0Ao'x")).toContain("\\'");
  });
});

describe('toAutomationRow', () => {
  it('reads a flow as active from ActiveVersionId, and keeps the version number', () => {
    const row = toAutomationRow(type('flow'), {
      Id: '300x', DeveloperName: 'Set_Region', ActiveVersionId: '301x',
      ActiveVersion: { VersionNumber: 4 },
    })!;
    expect(row).toMatchObject({ active: true, activeVersion: 4, name: 'Set_Region' });
  });

  it('reads a flow with no active version as off', () => {
    const row = toAutomationRow(type('flow'), { Id: '300x', DeveloperName: 'X', ActiveVersionId: null })!;
    expect(row.active).toBe(false);
    expect(row.activeVersion).toBeNull();
  });

  it('qualifies a validation rule by its object', () => {
    const row = toAutomationRow(type('validation-rule'), {
      Id: '03dx', ValidationName: 'Region_Required', Active: true,
      EntityDefinition: { QualifiedApiName: 'Account' },
    })!;
    expect(row).toMatchObject({ object: 'Account', active: true });
  });

  it("treats a trigger as on ONLY when its status is exactly Active", () => {
    // A trigger has three statuses. Lumping 'Deleted' in with Inactive would
    // offer a toggle that cannot work.
    const t = type('apex-trigger');
    expect(toAutomationRow(t, { Id: '01qx', Name: 'A', Status: 'Active' })!.active).toBe(true);
    expect(toAutomationRow(t, { Id: '01qx', Name: 'A', Status: 'Inactive' })!.active).toBe(false);
    expect(toAutomationRow(t, { Id: '01qx', Name: 'A', Status: 'Deleted' })!.active).toBe(false);
  });

  it('returns null for a record with no Id', () => {
    expect(toAutomationRow(type('flow'), {})).toBeNull();
  });
});

describe('toggledMetadata — the dangerous one', () => {
  it('preserves every other key', () => {
    // A Metadata write REPLACES the object. `{ active: false }` alone would
    // discard a validation rule's formula and error message.
    const metadata = { active: true, errorConditionFormula: 'ISBLANK(Region__c)', errorMessage: 'Required' };
    const next = toggledMetadata(metadata, 'active', false);

    expect(next).toEqual({ ...metadata, active: false });
    expect(next.errorConditionFormula).toBe('ISBLANK(Region__c)');
  });

  it('REFUSES to build a write from metadata that was never read', () => {
    // The whole failure mode, made impossible rather than documented.
    expect(() => toggledMetadata(null, 'active', false)).toThrow(/never read/);
    expect(() => toggledMetadata(undefined, 'active', false)).toThrow(/REPLACES/);
  });

  it('names the right key per type', () => {
    expect(activeMetadataKey(type('flow'))).toBe('activeVersionNumber');
    expect(activeMetadataKey(type('validation-rule'))).toBe('active');
    expect(activeMetadataKey(type('duplicate-rule'))).toBe('isActive');
  });

  it('refuses a key for a type that is not written that way', () => {
    expect(() => activeMetadataKey(type('apex-trigger'))).toThrow(/not toggled through Tooling/);
    expect(() => activeMetadataKey(type('workflow-rule'))).toThrow(/not toggled through Tooling/);
  });
});

describe('buildAutomationGrid', () => {
  it('collects every type into one grid', async () => {
    const q = fakeQueries([
      [/FROM FlowDefinition/, [{ Id: '300x', DeveloperName: 'F', ActiveVersionId: '301x', ActiveVersion: { VersionNumber: 2 } }]],
      [/FROM ValidationRule/, [{ Id: '03dx', ValidationName: 'V', Active: false, EntityDefinition: { QualifiedApiName: 'Account' } }]],
    ]);
    const vm = await buildAutomationGrid(q, { org: 'dev' });

    expect(vm.counts).toMatchObject({ total: 2, active: 1, inactive: 1 });
    expect(vm.rows.map((r) => r.typeId)).toEqual(['flow', 'validation-rule']);
  });

  it('always states that two types do not cost the same to toggle', async () => {
    const q = fakeQueries([[/FROM WorkflowRule/, [{ Id: '01Qx', Name: 'W', TableEnumOrId: 'Account', Active: true }]]]);
    const vm = await buildAutomationGrid(q, {});

    expect(vm.notes.some((n) => n.includes('metadata deploy'))).toBe(true);
    expect(vm.notes.some((n) => n.includes('they do not cost the same'))).toBe(true);
  });

  it('distinguishes "not available in this org" from "none exist"', async () => {
    // An org without the workflow feature rejects the object outright. That is
    // not a failure, and it is not a finding that the org has none.
    const q = fakeQueries([[/FROM WorkflowRule/, new Error("Cannot use: WorkflowRule in this organization")]]);
    const vm = await buildAutomationGrid(q, { types: [type('workflow-rule')] });

    expect(vm.notes.some((n) => n.includes('not available in this org'))).toBe(true);
    expect(vm.notes.some((n) => n.includes('failed query'))).toBe(false);
  });

  it('reports a REFUSED query as unchecked, never as empty', async () => {
    const q = fakeQueries([[/FROM ValidationRule/, new Error('INSUFFICIENT_ACCESS')]]);
    const vm = await buildAutomationGrid(q, { types: [type('validation-rule')] });

    expect(vm.notes.some((n) => n.includes('not a finding that this org has none'))).toBe(true);
    expect(vm.counts.total).toBe(0);
  });

  it('does not lose four types because one was rejected', async () => {
    const q = fakeQueries([
      [/FROM FlowDefinition/, [{ Id: '300x', DeveloperName: 'F', ActiveVersionId: null }]],
      [/FROM WorkflowRule/, new Error('nope')],
    ]);
    const vm = await buildAutomationGrid(q, {});

    expect(vm.rows).toHaveLength(1);
    expect(vm.notes.length).toBeGreaterThan(0);
  });
});
