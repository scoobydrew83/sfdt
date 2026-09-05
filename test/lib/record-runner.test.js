import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/org-rest.js', () => ({
  orgRest: vi.fn(),
  restErrorMessage: vi.fn((e) => e?.message ?? 'unknown error'),
  restErrorDetails: vi.fn(() => []),
}));

import { orgRest, restErrorDetails } from '../../src/lib/org-rest.js';
import {
  isRecordId,
  parseSetPairs,
  classifyWriteError,
  getRecord,
  editRecord,
  cloneRecord,
} from '../../src/lib/record-runner.js';

const REC = '001800000000001AAA';
const config = { _projectRoot: '/p', sourceApiVersion: 62 };

const field = (over) => ({
  label: over.name, type: 'string', picklistValues: [], nillable: true,
  calculated: false, updateable: true, createable: true, ...over,
});

const DESCRIBE = {
  name: 'Account', label: 'Account',
  fields: [
    field({ name: 'Id', type: 'id', updateable: false, createable: false }),
    field({ name: 'Name' }),
    field({ name: 'AnnualRevenue', type: 'currency', scale: 2 }),
    field({ name: 'Formula__c', calculated: true }),
    field({ name: 'Locked__c', updateable: false, createable: false }),
  ],
};
const RECORD = { Id: REC, Name: 'Acme', AnnualRevenue: 100, Formula__c: 'calc', Locked__c: 'no' };

function routeRest({ record = RECORD, onWrite } = {}) {
  orgRest.mockImplementation(async (org, url, opts) => {
    if (opts?.method && onWrite) return onWrite(url, opts);
    if (url.includes('/describe')) return DESCRIBE;
    if (url.endsWith('/sobjects/')) return { sobjects: [{ name: 'Account', keyPrefix: '001' }] };
    if (url.includes(`/sobjects/Account/${REC}`)) return record;
    return {};
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  restErrorDetails.mockReturnValue([]);
});

describe('isRecordId', () => {
  it('accepts 15 and 18 character ids and rejects the rest', () => {
    expect(isRecordId(REC)).toBe(true);
    expect(isRecordId('001800000000001')).toBe(true);
    expect(isRecordId('000000000000000')).toBe(false); // the null Id
    expect(isRecordId('nope')).toBe(false);
    expect(isRecordId(null)).toBe(false);
  });
});

describe('parseSetPairs', () => {
  it('splits on the first = only, so a value may contain one', () => {
    expect(parseSetPairs(['Url__c=https://x.test/?a=1&b=2'])).toEqual({
      Url__c: 'https://x.test/?a=1&b=2',
    });
  });

  it('keeps an empty value as an explicit clear', () => {
    expect(parseSetPairs(['Name='])).toEqual({ Name: '' });
  });

  it('trims the field name but never the value', () => {
    expect(parseSetPairs([' Name = Acme '])).toEqual({ Name: ' Acme ' });
  });

  it('rejects a pair with no = or an empty field name', () => {
    expect(() => parseSetPairs(['Name'])).toThrow(/Field=Value/);
    expect(() => parseSetPairs(['=Acme'])).toThrow(/Field=Value/);
  });

  it('is empty for no input', () => {
    expect(parseSetPairs(undefined)).toEqual({});
  });
});

describe('classifyWriteError', () => {
  it('calls a timeout UNKNOWN — the write may have committed', () => {
    const r = classifyWriteError({ timedOut: true, message: 'Command timed out' });
    expect(r.outcome).toBe('unknown');
    expect(r.message).toMatch(/may already have been saved/);
  });

  it('calls an org refusal rejected, and keeps its structured details', () => {
    restErrorDetails.mockReturnValue([{ message: 'bad', errorCode: 'X', fields: ['Name'] }]);
    const r = classifyWriteError({ message: 'HTTP 400' });
    expect(r.outcome).toBe('rejected');
    expect(r.details[0].fields).toEqual(['Name']);
  });
});

describe('getRecord', () => {
  it('reports which fields are editable and why the rest are not', async () => {
    routeRest();
    const r = await getRecord(config, REC, { org: 'dev' });
    expect(r.sobject).toBe('Account');
    const byName = Object.fromEntries(r.fields.map((f) => [f.name, f]));
    expect(byName.Name.editable).toBe(true);
    expect(byName.Formula__c.editable).toBe(false);
    expect(byName.Formula__c.reason).toBe('formula');
    expect(byName.Locked__c.reason).toBe('no-permission');
    // Nothing is dropped from the view — the same rule the browser follows.
    expect(r.fields).toHaveLength(DESCRIBE.fields.length);
  });

  it('rejects a malformed id before touching the org', async () => {
    await expect(getRecord(config, 'nope', { org: 'dev' })).rejects.toThrow(/not a 15 or 18 character/);
    expect(orgRest).not.toHaveBeenCalled();
  });

  it('skips key-prefix resolution when the object is named', async () => {
    routeRest();
    await getRecord(config, REC, { org: 'dev', sobject: 'Account' });
    expect(orgRest.mock.calls.some(([, url]) => url.endsWith('/sobjects/'))).toBe(false);
  });
});

describe('a write describes the object ONCE', () => {
  // editRecord used to call getRecord (which describes) and then describe
  // again — two of the largest payloads in the API, per write, for one answer.
  const describeCalls = () =>
    orgRest.mock.calls.filter(([, url]) => String(url).includes('/describe')).length;

  it('does not re-describe on edit', async () => {
    routeRest({ onWrite: async () => ({}) });
    await editRecord(config, REC, { Name: 'New' }, { org: 'dev' });
    expect(describeCalls()).toBe(1);
  });

  it('does not re-describe on clone', async () => {
    routeRest({ onWrite: async () => ({ id: '001800000000002AAA' }) });
    await cloneRecord(config, REC, {}, { org: 'dev' });
    expect(describeCalls()).toBe(1);
  });
});

describe('editRecord', () => {
  it('PATCHes only what changed', async () => {
    const writes = [];
    routeRest({ onWrite: (url, opts) => { writes.push({ url, opts }); return null; } });
    const r = await editRecord(config, REC, { Name: 'New Corp' }, { org: 'dev' });
    expect(r.outcome).toBe('saved');
    expect(r.changed).toEqual(['Name']);
    expect(writes[0].opts.method).toBe('PATCH');
    expect(writes[0].opts.body).toEqual({ Name: 'New Corp' });
  });

  it('refuses a non-editable field locally, naming the reason, without calling the org', async () => {
    const writes = [];
    routeRest({ onWrite: (url, opts) => { writes.push({ url, opts }); return null; } });
    await expect(editRecord(config, REC, { Formula__c: 'x' }, { org: 'dev' }))
      .rejects.toThrow(/Calculated server-side/);
    expect(writes).toHaveLength(0);
  });

  it('refuses an unknown field by name', async () => {
    routeRest();
    await expect(editRecord(config, REC, { Ghost__c: 'x' }, { org: 'dev' }))
      .rejects.toThrow(/No field named "Ghost__c"/);
  });

  it('is a no-op when the value already matches — 100 is not different from "100"', async () => {
    const writes = [];
    routeRest({ onWrite: (url, opts) => { writes.push({ url, opts }); return null; } });
    const r = await editRecord(config, REC, { AnnualRevenue: '100' }, { org: 'dev' });
    expect(r.outcome).toBe('no-op');
    expect(writes).toHaveLength(0);
  });

  it('--dry-run returns the exact body and sends nothing', async () => {
    const writes = [];
    routeRest({ onWrite: (url, opts) => { writes.push({ url, opts }); return null; } });
    const r = await editRecord(config, REC, { Name: 'X' }, { org: 'dev', dryRun: true });
    expect(r.outcome).toBe('dry-run');
    expect(r.body).toEqual({ Name: 'X' });
    expect(writes).toHaveLength(0);
  });

  it('maps a rejection onto the exact field', async () => {
    restErrorDetails.mockReturnValue([{ message: 'Too long', errorCode: 'STRING_TOO_LONG', fields: ['Name'] }]);
    routeRest({ onWrite: () => { throw new Error('HTTP 400'); } });
    const r = await editRecord(config, REC, { Name: 'X'.repeat(300) }, { org: 'dev' });
    expect(r.outcome).toBe('rejected');
    expect(r.fieldErrors[0]).toMatchObject({ field: 'Name', message: 'Too long' });
  });

  it('reports a timeout as unknown rather than as nothing-was-saved', async () => {
    routeRest({ onWrite: () => { const e = new Error('t'); e.timedOut = true; throw e; } });
    const r = await editRecord(config, REC, { Name: 'X' }, { org: 'dev' });
    expect(r.outcome).toBe('unknown');
    expect(r.error).toMatch(/may already have been saved/);
  });

  it('never PATCHes a field absent from the record payload (field-level security)', async () => {
    const writes = [];
    // Hidden__c is in the describe but not in the record the org returned.
    const describeWithHidden = { ...DESCRIBE, fields: [...DESCRIBE.fields, field({ name: 'Hidden__c' })] };
    orgRest.mockImplementation(async (org, url, opts) => {
      if (opts?.method) { writes.push(opts); return null; }
      if (url.includes('/describe')) return describeWithHidden;
      if (url.includes(`/sobjects/Account/${REC}`)) return RECORD;
      return { sobjects: [{ name: 'Account', keyPrefix: '001' }] };
    });
    const r = await editRecord(config, REC, { Name: 'New' }, { org: 'dev' });
    expect(r.changed).toEqual(['Name']);
    expect(writes[0].body).not.toHaveProperty('Hidden__c');
  });
});

describe('cloneRecord', () => {
  it('POSTs only createable fields', async () => {
    const writes = [];
    routeRest({ onWrite: (url, opts) => { writes.push(opts); return { id: '001800000000009AAA' }; } });
    const r = await cloneRecord(config, REC, {}, { org: 'dev' });
    expect(r.outcome).toBe('created');
    expect(r.id).toBe('001800000000009AAA');
    expect(Object.keys(writes[0].body)).toContain('Name');
    expect(Object.keys(writes[0].body)).not.toContain('Formula__c');
    expect(Object.keys(writes[0].body)).not.toContain('Locked__c');
    expect(Object.keys(writes[0].body)).not.toContain('Id');
  });

  it('applies overrides on top of the source record', async () => {
    const writes = [];
    routeRest({ onWrite: (url, opts) => { writes.push(opts); return { id: 'x' }; } });
    await cloneRecord(config, REC, { Name: 'Copy' }, { org: 'dev' });
    expect(writes[0].body.Name).toBe('Copy');
  });

  it('--dry-run sends nothing', async () => {
    const writes = [];
    routeRest({ onWrite: (url, opts) => { writes.push(opts); return { id: 'x' }; } });
    const r = await cloneRecord(config, REC, {}, { org: 'dev', dryRun: true });
    expect(r.outcome).toBe('dry-run');
    expect(writes).toHaveLength(0);
  });
});

describe('sobject is validated before it reaches a REST path (issue #23, H-1)', () => {
  // `recordId` was shape-checked; `sobject` was the other free path segment and
  // was not. It is a model-supplied MCP argument on sfdt_record_get (read-only,
  // NO confirmExecution), sfdt_record_edit and sfdt_record_clone. The sf CLI
  // builds a WHATWG URL, which collapses dot segments — so
  // `../tooling/sobjects/ApexClass` reaches the Tooling API: reading Apex source
  // with no prompt at all, or PATCHing it behind a prompt that says "update a
  // record". The v0.25.0 batch-1 commit fixed events-runner and
  // field-usage-offline and named these four siblings without converting them.
  const config = { apiVersion: '62.0' };
  const RECORD_ID = '001800000000001AAA';

  const TRAVERSALS = [
    ['tooling sObject write', '../tooling/sobjects/ApexClass'],
    ['tooling query read',    '../tooling/query?q=SELECT+Id,Body+FROM+ApexClass&z='],
    ['separator',             'Account/../ApexClass'],
    ['leading dot',           '.hidden'],
    ['query string',          'Account?x='],
  ];

  beforeEach(() => vi.mocked(orgRest).mockReset());

  it.each(TRAVERSALS)('getRecord refuses %s without calling the org', async (_label, sobject) => {
    await expect(getRecord(config, RECORD_ID, { org: 'dev', sobject }))
      .rejects.toThrow(/not a valid object API name/);
    expect(orgRest).not.toHaveBeenCalled();
  });

  it('still accepts a legitimate custom object', async () => {
    vi.mocked(orgRest)
      .mockResolvedValueOnce({ name: 'My_Object__c', label: 'My Object', fields: [] })
      .mockResolvedValueOnce({ Id: RECORD_ID });
    await expect(getRecord(config, RECORD_ID, { org: 'dev', sobject: 'My_Object__c' }))
      .resolves.toBeTruthy();
    expect(orgRest).toHaveBeenCalled();
  });
});
