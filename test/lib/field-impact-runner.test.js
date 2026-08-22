import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/org-query.js', () => ({
  query: vi.fn(),
  search: vi.fn(),
}));
vi.mock('../../src/lib/org-session.js', () => ({
  getOrgInstanceUrl: vi.fn(),
}));

import { query, search } from '../../src/lib/org-query.js';
import { getOrgInstanceUrl } from '../../src/lib/org-session.js';
import {
  parseFieldRef,
  toolingQueriesFor,
  runFieldImpact,
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
  vi.mocked(getOrgInstanceUrl).mockReset();
  vi.mocked(query).mockResolvedValue([]);
  vi.mocked(search).mockResolvedValue([]);
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
