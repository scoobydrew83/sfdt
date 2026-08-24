import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/org-query.js', () => ({
  query: vi.fn(),
  search: vi.fn(),
  count: vi.fn(),
}));
vi.mock('../../src/lib/soql-runner.js', () => ({
  describeSObject: vi.fn(),
}));
vi.mock('../../src/lib/org-session.js', () => ({
  getOrgInstanceUrl: vi.fn(),
}));

import { query, search, count } from '../../src/lib/org-query.js';
import { describeSObject } from '../../src/lib/soql-runner.js';
import { getOrgInstanceUrl } from '../../src/lib/org-session.js';
import {
  parseFieldRef,
  toolingQueriesFor,
  runFieldImpact,
  runFieldUsage,
} from '../../src/lib/field-impact-runner.js';

// The ANALYSIS is flow-core's and is tested there
// (packages/flow-core/test/field-impact.test.ts). What is asserted here is the
// transport contract this file owes it — the three things that, if got wrong,
// would make the CLI quietly disagree with the browser about the same org:
//
//   1. every SOQL goes out with --use-tooling-api;
//   2. a REFUSED query propagates as a throw, so the scan can report it as
//      refused rather than reading it as "your org has none of these";
//   3. `--links` is opt-in, and a failure to resolve the host costs links only,
//      never the analysis.

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(search).mockReset();
  vi.mocked(count).mockReset();
  vi.mocked(describeSObject).mockReset();
  vi.mocked(getOrgInstanceUrl).mockReset();
  vi.mocked(query).mockResolvedValue([]);
  vi.mocked(search).mockResolvedValue([]);
});

describe('SOQL identifiers are validated, not escaped', () => {
  // `FROM ${object}` and `WHERE ${field} != null` are identifier positions.
  // Quoting does not apply there, so escapeSoql has nothing to grip — the only
  // defence is refusing a name that is not shaped like an API name.
  it.each([
    'Account WHERE Id != null OR Name != null',
    "Account'",
    'Account;DROP',
    '1Account',
    '',
  ])('refuses %j', (bad) => {
    expect(() => parseFieldRef(`${bad}.Region__c`)).toThrow(/not a valid object API name|Expected <Object>/);
  });

  it('accepts a namespaced custom field', () => {
    expect(parseFieldRef('ns__Account__c.ns__Region__c')).toEqual({
      object: 'ns__Account__c',
      field: 'ns__Region__c',
    });
  });
});

describe('parseFieldRef', () => {
  it('splits Object.Field', () => {
    expect(parseFieldRef('Account.Region__c')).toEqual({ object: 'Account', field: 'Region__c' });
  });

  it('names the expected shape when the reference is malformed', () => {
    for (const bad of ['Account', '.Region__c', 'Account.', '', '   ']) {
      expect(() => parseFieldRef(bad)).toThrow(/Expected <Object>\.<Field>/);
    }
  });

  it('keeps a namespaced field intact after the first dot', () => {
    // `ns__Obj__c.ns__Field__c` — splitting on the LAST dot would mangle this.
    expect(parseFieldRef('ns__Obj__c.ns__Field__c')).toEqual({
      object: 'ns__Obj__c',
      field: 'ns__Field__c',
    });
  });
});

describe('toolingQueriesFor', () => {
  it('sends every SOQL through the Tooling API', async () => {
    vi.mocked(query).mockResolvedValue([{ Id: '1' }]);
    const q = toolingQueriesFor('dev');
    const result = await q.toolingQuery('SELECT Id FROM CustomField');

    expect(query).toHaveBeenCalledWith('dev', 'SELECT Id FROM CustomField', { tooling: true });
    // flow-core expects `{ records }`, not a bare array.
    expect(result).toEqual({ records: [{ Id: '1' }] });
  });

  it('sends SOSL through the Tooling search', async () => {
    vi.mocked(search).mockResolvedValue([{ Id: '01p', Name: 'A' }]);
    const q = toolingQueriesFor('dev');

    await expect(q.toolingSearch('FIND {X}')).resolves.toEqual([{ Id: '01p', Name: 'A' }]);
    expect(search).toHaveBeenCalledWith('dev', 'FIND {X}', { tooling: true });
  });

  it('lets a refusal THROW rather than resolving empty', async () => {
    // This is the load-bearing one. Swallowing here would hand flow-core an
    // empty result, which it can only read as "your org has none of these" —
    // turning a permissions failure into a clean bill of health.
    vi.mocked(query).mockRejectedValue(new Error('INSUFFICIENT_ACCESS'));
    const q = toolingQueriesFor('dev');

    await expect(q.toolingQuery('SELECT Id FROM CustomField')).rejects.toThrow('INSUFFICIENT_ACCESS');
  });

  it('lets a refused search THROW too', async () => {
    vi.mocked(search).mockRejectedValue(new Error('no tooling search'));
    const q = toolingQueriesFor('dev');

    await expect(q.toolingSearch('FIND {X}')).rejects.toThrow('no tooling search');
  });
});

describe('runFieldImpact', () => {
  it('returns the viewmodel and does not resolve the host by default', async () => {
    const vm = await runFieldImpact('dev', 'Account.Region__c');

    expect(getOrgInstanceUrl).not.toHaveBeenCalled();
    expect(vm.object).toBe('Account');
    expect(vm.field).toBe('Region__c');
    // No origin ⇒ no links, rather than root-relative ones.
    expect(vm.rows.every((r) => r.url === null)).toBe(true);
  });

  it('resolves the host only when --links is asked for', async () => {
    vi.mocked(getOrgInstanceUrl).mockResolvedValue('https://acme.my.salesforce.com');
    await runFieldImpact('dev', 'Account.Region__c', { links: true });

    expect(getOrgInstanceUrl).toHaveBeenCalledWith('dev');
  });

  it('still returns the analysis when the host cannot be resolved', async () => {
    // A missing instance URL costs deep links, not the scan.
    vi.mocked(getOrgInstanceUrl).mockRejectedValue(new Error('no auth'));

    const vm = await runFieldImpact('dev', 'Account.Region__c', { links: true });
    expect(vm.field).toBe('Region__c');
  });

  it('surfaces a malformed reference before touching the org', async () => {
    await expect(runFieldImpact('dev', 'Account')).rejects.toThrow(/Expected <Object>\.<Field>/);
    expect(query).not.toHaveBeenCalled();
  });

  it('carries the scan-scope notes out of flow-core', async () => {
    // The notes are the product; a runner that dropped them would leave an
    // empty row list looking like proof.
    vi.mocked(query).mockRejectedValue(new Error('INSUFFICIENT_ACCESS'));

    const vm = await runFieldImpact('dev', 'Account.Region__c');
    expect(vm.notes.some((n) => n.includes('INSUFFICIENT_ACCESS'))).toBe(true);
  });
});

// --------------------------------------------------------------------------
// runFieldUsage — the sweep
// --------------------------------------------------------------------------
//
// The adjudication is flow-core's and is tested there. What is asserted here is
// what THIS layer decides: which fields are worth a COUNT(), that a failed count
// stays null rather than becoming zero, and that skipping --population is stated
// rather than left as a column of nulls.

describe('runFieldUsage', () => {
  const config = { _projectRoot: '/p', defaultOrg: 'dev' };

  /** Route SOQL to a handler table; anything unmatched returns []. */
  function routeQueries(handlers) {
    vi.mocked(query).mockImplementation(async (_org, soql) => {
      for (const [pattern, rows] of handlers) {
        if (pattern.test(soql)) {
          if (rows instanceof Error) throw rows;
          return rows;
        }
      }
      return [];
    });
  }

  beforeEach(() => {
    vi.mocked(describeSObject).mockResolvedValue({
      org: 'dev',
      name: 'Account',
      fields: [
        { name: 'Id', label: 'Id', type: 'id', custom: false, nillable: false, unique: false },
        { name: 'Region__c', label: 'Region', type: 'picklist', custom: true, nillable: true, unique: false },
        { name: 'Legacy__c', label: 'Legacy', type: 'string', custom: true, nillable: true, unique: false },
      ],
    });
    routeQueries([[/FROM CustomField/, [
      { Id: '00N1', DeveloperName: 'Region' },
      { Id: '00N2', DeveloperName: 'Legacy' },
    ]]]);
    vi.mocked(count).mockResolvedValue(0);
  });

  it('says the data was not counted when --population is omitted', async () => {
    const vm = await runFieldUsage(config, 'dev', 'Account');

    expect(count).not.toHaveBeenCalled();
    expect(vm.rows.every((r) => r.safeToRemove === null)).toBe(true);
    expect(vm.notes.some((n) => n.includes('was NOT counted'))).toBe(true);
  });

  it('counts only the unreferenced custom fields, not every field', async () => {
    // A referenced field is not a candidate whatever its data says, so counting
    // it is a query spent to learn nothing.
    routeQueries([
      [/FROM CustomField/, [
        { Id: '00N1', DeveloperName: 'Region' },
        { Id: '00N2', DeveloperName: 'Legacy' },
      ]],
      [/MetadataComponentDependency/, [
        { RefMetadataComponentId: '00N1', MetadataComponentName: 'T', MetadataComponentType: 'ApexTrigger' },
      ]],
    ]);

    await runFieldUsage(config, 'dev', 'Account', { population: true });

    const counted = vi.mocked(count).mock.calls.map(([, soql]) => soql);
    expect(counted.some((s) => s.includes('Legacy__c != null'))).toBe(true);
    expect(counted.some((s) => s.includes('Region__c != null'))).toBe(false);
    // Plus the object total.
    expect(counted.some((s) => s === 'SELECT COUNT() FROM Account')).toBe(true);
  });

  it('flags an unreferenced, empty field as safe to remove', async () => {
    vi.mocked(count).mockResolvedValue(0);
    const vm = await runFieldUsage(config, 'dev', 'Account', { population: true });

    expect(vm.rows.find((r) => r.name === 'Legacy__c').safeToRemove).toBe(true);
  });

  it('does not flag a field whose count failed', async () => {
    // A count that did not run is not a count of zero.
    vi.mocked(count).mockRejectedValue(new Error('QUERY_TIMEOUT'));
    const vm = await runFieldUsage(config, 'dev', 'Account', { population: true });

    expect(vm.rows.find((r) => r.name === 'Legacy__c').safeToRemove).toBe(false);
    expect(vm.notes.some((n) => n.includes('is not a count of zero'))).toBe(true);
  });

  it('warns that an empty object makes every count meaningless', async () => {
    vi.mocked(count).mockResolvedValue(0);
    const vm = await runFieldUsage(config, 'dev', 'Account', { population: true });

    expect(vm.notes.some((n) => n.includes('no records at all'))).toBe(true);
  });

  it('maps a describe nillable:false to required', async () => {
    vi.mocked(describeSObject).mockResolvedValue({
      org: 'dev',
      name: 'Account',
      fields: [
        { name: 'Req__c', label: 'Req', type: 'string', custom: true, nillable: false, unique: false },
      ],
    });
    routeQueries([[/FROM CustomField/, [{ Id: '00N9', DeveloperName: 'Req' }]]]);
    vi.mocked(count).mockResolvedValue(0);

    const vm = await runFieldUsage(config, 'dev', 'Account', { population: true });
    expect(vm.rows.find((r) => r.name === 'Req__c').keepReason).toBe('required');
  });
});
