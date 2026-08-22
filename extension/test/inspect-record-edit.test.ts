// P4-1 PR-2: edit mode in inspect-record.
//
// Two layers. The pure functions (`formatSaveOutcome`, `classifySaveError`,
// `buildEditor`) are asserted directly, because the three save claims ARE the
// contract and a test that pins their wording is what stops a later edit
// softening them back into one vague "save failed". The DOM layer then proves
// the feature actually routes through them.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createInspectRecordFeature,
  formatSaveOutcome,
  classifySaveError,
  buildEditor,
  readEditor,
} from '../features/inspect-record.js';
import { classifyFieldEditability } from '../lib/record-edit.js';
import { SalesforceRestError, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { _resetSettingsShapesForTests, _clearSettingsCacheForTests } from '../lib/settings.js';
import { _resetDescribeCachesForTests } from '../lib/describe-cache.js';
import type { FieldDescribe } from '../lib/describe-cache.js';

function field(over: Partial<FieldDescribe> & { name: string; type: string }): FieldDescribe {
  return {
    label: over.name, relationshipName: null, referenceTo: [],
    picklistValues: [], nillable: true, calculated: false,
    updateable: true, createable: true,
    ...over,
  } as FieldDescribe;
}

const editableOf = (f: FieldDescribe) => {
  const e = classifyFieldEditability(f, 'update');
  if (!e.editable) throw new Error(`expected ${f.name} editable`);
  return e;
};

// ---------------------------------------------------------------------------
// The three claims
// ---------------------------------------------------------------------------

describe('formatSaveOutcome', () => {
  it('counts saved fields, singular and plural', () => {
    expect(formatSaveOutcome({ status: 'saved', fieldCount: 1 })).toBe('Saved 1 field.');
    expect(formatSaveOutcome({ status: 'saved', fieldCount: 3 })).toBe('Saved 3 fields.');
  });

  it('says nothing was saved when the org rejected the write', () => {
    expect(formatSaveOutcome({ status: 'rejected', bannerText: 'Too long.' }))
      .toBe('No changes were saved. Too long.');
  });

  it('never claims nothing was saved when the outcome is unknown', () => {
    const text = formatSaveOutcome({ status: 'unknown', detail: 'timed out after 120s' });
    expect(text).toMatch(/Save outcome unknown/);
    expect(text).toMatch(/reloaded/);
    expect(text).not.toMatch(/No changes were saved/);
  });
});

describe('classifySaveError', () => {
  const tagged = (kind: string) => Object.assign(new Error('boom'), { sfdtKind: kind });

  it('an http-error is the only kind that may claim nothing was saved', () => {
    expect(classifySaveError(tagged('http-error'), 'b').status).toBe('rejected');
  });

  it('a timeout is unknown — the write may have committed', () => {
    expect(classifySaveError(tagged('timeout'), 'b').status).toBe('unknown');
  });

  it('a no-session definitely did not run', () => {
    expect(classifySaveError(tagged('no-session'), 'b').status).toBe('no-session');
  });

  it('an unrecognised error is unknown, not rejected', () => {
    // If we cannot tell the org answered, we must not claim it did.
    expect(classifySaveError(new Error('who knows'), 'b').status).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Per-type editors
// ---------------------------------------------------------------------------

describe('buildEditor', () => {
  const doc = document;

  it('maps each editable type to its native control', () => {
    const cases: Array<[string, string]> = [
      ['string', 'text'], ['email', 'email'], ['phone', 'tel'], ['url', 'url'],
      ['int', 'number'], ['currency', 'number'], ['date', 'date'],
      ['datetime', 'datetime-local'], ['time', 'time'], ['reference', 'text'],
    ];
    for (const [type, expected] of cases) {
      const f = field({ name: 'F', type });
      const el = buildEditor(doc, f, editableOf(f), null) as HTMLInputElement;
      expect(`${type}->${el.type}`).toBe(`${type}->${expected}`);
    }
  });

  it('renders a textarea for textarea and a select for picklist', () => {
    const ta = field({ name: 'Desc', type: 'textarea' });
    expect(buildEditor(doc, ta, editableOf(ta), 'x').tagName).toBe('TEXTAREA');
    const pl = field({ name: 'Stage', type: 'picklist', picklistValues: [{ value: 'A', label: 'A' }] });
    expect(buildEditor(doc, pl, editableOf(pl), 'A').tagName).toBe('SELECT');
  });

  it('keeps a value the picklist does not list — unrestricted picklists accept it', () => {
    const f = field({ name: 'Stage', type: 'picklist', picklistValues: [{ value: 'A', label: 'A' }] });
    const el = buildEditor(doc, f, editableOf(f), 'Legacy') as HTMLSelectElement;
    const values = Array.from(el.options).map((o) => o.value);
    expect(values).toContain('Legacy');
    expect(el.value).toBe('Legacy');
  });

  it('renders a dependent picklist in full, with a hint rather than a filter', () => {
    const f = field({
      name: 'Sub', type: 'picklist', dependentPicklist: true, controllerName: 'Stage',
      picklistValues: [{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }],
    });
    const el = buildEditor(doc, f, editableOf(f), 'A') as HTMLSelectElement;
    expect(Array.from(el.options).map((o) => o.value)).toEqual(expect.arrayContaining(['A', 'B']));
    expect(el.title).toMatch(/Stage/);
  });

  it('multipicklist is a multi-select and reads back as an array', () => {
    const f = field({
      name: 'Tags', type: 'multipicklist',
      picklistValues: [{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }],
    });
    const el = buildEditor(doc, f, editableOf(f), 'A;B') as HTMLSelectElement;
    expect(el.multiple).toBe(true);
    expect(readEditor(el)).toEqual(['A', 'B']);
  });

  it('gives datetime and time a step, or the browser rejects the seconds we carry', () => {
    const dt = field({ name: 'When', type: 'datetime' });
    const el = buildEditor(doc, dt, editableOf(dt), '2026-07-30T14:35:45.000+0000') as HTMLInputElement;
    expect(el.step).toBe('1');
    const tm = field({ name: 'At', type: 'time' });
    expect((buildEditor(doc, tm, editableOf(tm), '09:30:45.123Z') as HTMLInputElement).step).toBe('0.001');
  });

  it('takes a date as a plain string — never through Date, which shifts the day', () => {
    const f = field({ name: 'Close', type: 'date' });
    const el = buildEditor(doc, f, editableOf(f), '2026-01-01') as HTMLInputElement;
    expect(el.value).toBe('2026-01-01');
  });

  it('derives the number step from describe scale', () => {
    const f = field({ name: 'Amt', type: 'currency', scale: 2 });
    expect((buildEditor(doc, f, editableOf(f), 10) as HTMLInputElement).step).toBe('0.01');
  });
});

// ---------------------------------------------------------------------------
// The feature
// ---------------------------------------------------------------------------

const ACCOUNT_FIELDS = [
  field({ name: 'Id', type: 'id', updateable: false, createable: false }),
  field({ name: 'Name', type: 'string', label: 'Account Name' }),
  field({ name: 'AnnualRevenue', type: 'currency', label: 'Revenue', scale: 2 }),
  field({ name: 'Formula__c', type: 'string', label: 'Calc', calculated: true }),
  field({ name: 'Locked__c', type: 'string', label: 'Locked', updateable: false, createable: false }),
];

const REC = '001800000000001AAA';

function mount(over: { record?: Record<string, unknown>; apiRequest?: unknown } = {}) {
  const record = over.record ?? {
    Id: REC, Name: 'Acme', AnnualRevenue: 100, Formula__c: 'calc', Locked__c: 'no',
  };
  const apiGet = vi.fn(async (path: string) => {
    if (path.includes('/describe')) return { name: 'Account', label: 'Account', fields: ACCOUNT_FIELDS };
    if (path.includes(`/sobjects/Account/${REC}`)) return record;
    return { sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }] };
  });
  const apiRequest = (over.apiRequest ?? vi.fn(async () => null)) as ReturnType<typeof vi.fn>;
  const api = { query: vi.fn(), toolingQuery: vi.fn(), queryMore: vi.fn(), apiGet, apiRequest } as unknown as SalesforceApiClient;
  return { api, apiGet, apiRequest, feature: createInspectRecordFeature({ api }) };
}

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const rowFor = (name: string) =>
  Array.from(document.querySelectorAll('tbody tr')).find(
    (tr) => tr.querySelector('td:nth-child(2)')?.textContent === name,
  );
const saveButton = () =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Save Changes'))!;

beforeEach(() => {
  _resetSettingsShapesForTests();
  _clearSettingsCacheForTests();
  _resetDescribeCachesForTests();
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  window.history.replaceState({}, '', `https://x.lightning.force.com/lightning/r/Account/${REC}/view`);
});

describe('inspect-record edit mode', () => {
  it('renders read-only fields with a stated reason rather than dropping them', async () => {
    const { feature } = mount();
    await feature.onActivate?.();
    await flush();

    // AC-2: still in the view, visibly not editable, and the reason is on it.
    const formulaRow = rowFor('Formula__c')!;
    expect(formulaRow).toBeTruthy();
    expect(formulaRow.querySelector('input')).toBeNull();
    const chip = formulaRow.querySelector('td:nth-child(4) .sfdt-pill');
    expect(chip?.textContent).toBe('formula');
    const value = formulaRow.querySelector('td:nth-child(4) span[aria-describedby]');
    expect(value?.getAttribute('aria-describedby')).toBe(chip?.id);

    expect(rowFor('Locked__c')!.querySelector('td:nth-child(4) .sfdt-pill')?.textContent)
      .toBe('read-only for you');
  });

  it('edits through one diff, so an untouched number is never phantom-dirty', async () => {
    const { feature, apiRequest } = mount();
    await feature.onActivate?.();
    await flush();

    // Re-rendering the currency control writes a STRING back into the editor;
    // before P4-1 that made 100 vs '100' read as a change.
    const revenue = rowFor('AnnualRevenue')!.querySelector('input')!;
    revenue.dispatchEvent(new Event('change'));
    await flush();
    expect(saveButton().closest('div')!.parentElement!.style.display).toBe('none');

    const name = rowFor('Name')!.querySelector('input') as HTMLInputElement;
    name.value = 'New Corp';
    name.dispatchEvent(new Event('change'));
    await flush();

    saveButton().click();
    await flush();
    expect(apiRequest).toHaveBeenCalledWith(
      'PATCH', expect.stringContaining(`/sobjects/Account/${REC}`), { Name: 'New Corp' },
    );
  });

  it('re-reads the record after a save instead of trusting its own echo', async () => {
    const { feature, apiGet, apiRequest } = mount();
    await feature.onActivate?.();
    await flush();
    const getsBefore = apiGet.mock.calls.filter((c) => String(c[0]).includes(`/Account/${REC}`)).length;

    const name = rowFor('Name')!.querySelector('input') as HTMLInputElement;
    name.value = 'New Corp';
    name.dispatchEvent(new Event('change'));
    await flush();
    saveButton().click();
    await flush();

    expect(apiRequest).toHaveBeenCalled();
    const getsAfter = apiGet.mock.calls.filter((c) => String(c[0]).includes(`/Account/${REC}`)).length;
    expect(getsAfter).toBeGreaterThan(getsBefore);
  });

  it('places a rejected field error on that exact field and keeps the edit', async () => {
    const rejection = new SalesforceRestError('bad', 400, [
      { message: 'Name is too long', errorCode: 'STRING_TOO_LONG', fields: ['Name'] },
    ]);
    const { feature } = mount({ apiRequest: vi.fn(async () => { throw rejection; }) });
    await feature.onActivate?.();
    await flush();

    const name = rowFor('Name')!.querySelector('input') as HTMLInputElement;
    name.value = 'x'.repeat(300);
    name.dispatchEvent(new Event('change'));
    await flush();
    saveButton().click();
    await flush();

    const err = rowFor('Name')!.querySelector('.sfdt-field-error');
    expect(err?.textContent).toBe('Name is too long');
    expect(rowFor('Name')!.querySelector('input')!.getAttribute('aria-describedby')).toBe(err!.id);
    // Nothing was saved, so the edit must survive for the user to fix.
    expect(rowFor('Name')!.querySelector('input')!.value).toBe('x'.repeat(300));
  });

  it('names an unrendered field in the banner rather than losing its error', async () => {
    const rejection = new SalesforceRestError('bad', 400, [
      { message: 'Value too long', errorCode: 'STRING_TOO_LONG', fields: ['Hidden__c'] },
    ]);
    const { feature } = mount({ apiRequest: vi.fn(async () => { throw rejection; }) });
    await feature.onActivate?.();
    await flush();
    const name = rowFor('Name')!.querySelector('input') as HTMLInputElement;
    name.value = 'New';
    name.dispatchEvent(new Event('change'));
    await flush();
    saveButton().click();
    await flush();

    const text = document.body.textContent ?? '';
    expect(text).toMatch(/No changes were saved/);
    expect(text).toMatch(/Hidden__c: Value too long/);
  });

  it('a timeout says the outcome is unknown and reloads — never "no session"', async () => {
    const timeout = Object.assign(new Error('Salesforce PATCH timed out after 120s'), {
      sfdtKind: 'timeout', mutating: true, status: 0,
    });
    const { feature, apiGet } = mount({ apiRequest: vi.fn(async () => { throw timeout; }) });
    await feature.onActivate?.();
    await flush();
    const getsBefore = apiGet.mock.calls.filter((c) => String(c[0]).includes(`/Account/${REC}`)).length;

    const name = rowFor('Name')!.querySelector('input') as HTMLInputElement;
    name.value = 'New Corp';
    name.dispatchEvent(new Event('change'));
    await flush();
    saveButton().click();
    await flush();

    const text = document.body.textContent ?? '';
    expect(text).toMatch(/Save outcome unknown/);
    expect(text).not.toMatch(/No Salesforce session available/);
    const getsAfter = apiGet.mock.calls.filter((c) => String(c[0]).includes(`/Account/${REC}`)).length;
    expect(getsAfter).toBeGreaterThan(getsBefore);
  });

  it('clears the filter on a field error, so the error cannot land on a hidden row', async () => {
    const rejection = new SalesforceRestError('bad', 400, [
      { message: 'nope', errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', fields: ['Name'] },
    ]);
    const { feature } = mount({ apiRequest: vi.fn(async () => { throw rejection; }) });
    await feature.onActivate?.();
    await flush();

    const name = rowFor('Name')!.querySelector('input') as HTMLInputElement;
    name.value = 'New Corp';
    name.dispatchEvent(new Event('change'));
    await flush();

    const filter = document.querySelector('input[type="search"]') as HTMLInputElement;
    filter.value = 'Revenue';
    filter.dispatchEvent(new Event('input'));
    await flush();
    expect(rowFor('Name')).toBeUndefined();

    saveButton().click();
    await flush();
    expect(filter.value).toBe('');
    expect(rowFor('Name')!.querySelector('.sfdt-field-error')?.textContent).toBe('nope');
  });

  it('asks before discarding unsaved edits on a backdrop dismissal', async () => {
    const { feature } = mount();
    await feature.onActivate?.();
    await flush();

    const overlay = document.querySelector('.sfdt-view-overlay') as HTMLElement;
    // happy-dom does not implement window.confirm, so install one to spy on.
    const confirmSpy = vi.fn().mockReturnValue(false);
    Object.defineProperty(window, 'confirm', { value: confirmSpy, configurable: true, writable: true });

    // Clean: no prompt, and it closes.
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(confirmSpy).not.toHaveBeenCalled();

    await feature.onActivate?.();
    await flush();
    const name = rowFor('Name')!.querySelector('input') as HTMLInputElement;
    name.value = 'Dirty';
    name.dispatchEvent(new Event('change'));
    await flush();

    const overlay2 = document.querySelector('.sfdt-view-overlay') as HTMLElement;
    overlay2.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/Discard 1 unsaved change/));
    // Declined, so the view is still there with the edit intact.
    expect(document.querySelector('.sfdt-view-overlay')).toBeTruthy();
    expect(rowFor('Name')!.querySelector('input')!.value).toBe('Dirty');

  });
});

// ---------------------------------------------------------------------------
// Clone (PR-3)
// ---------------------------------------------------------------------------

// Scoped to the clone pane: the fields table stays mounted (its container is
// merely hidden), so an unscoped `tbody tr` query matches the wrong table.
const clonePane = () => document.querySelector('.sfdt-clone-form')!;
const cloneButton = () =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Clone'))!;
const createButton = () =>
  Array.from(clonePane().querySelectorAll('button')).find((b) => b.textContent?.includes('Create'))!;
const cloneRowFor = (name: string) =>
  Array.from(clonePane().querySelectorAll('tbody tr')).find(
    (tr) => tr.querySelector('td:nth-child(2)')?.textContent === name,
  );

describe('inspect-record clone', () => {
  it('stages a form and creates nothing until Create is pressed', async () => {
    const { feature, apiRequest } = mount();
    await feature.onActivate?.();
    await flush();

    cloneButton().click();
    await flush();

    expect(document.body.textContent).toMatch(/Nothing is created until you press Create/);
    // Decision 6: clicking Clone must not insert.
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('prefills createable fields and renders the rest with their reason', async () => {
    const { feature } = mount();
    await feature.onActivate?.();
    await flush();
    cloneButton().click();
    await flush();

    expect((cloneRowFor('Name')!.querySelector('input') as HTMLInputElement).value).toBe('Acme');
    // Not createable: still shown, still explained, but no control.
    const formulaRow = cloneRowFor('Formula__c')!;
    expect(formulaRow.querySelector('input')).toBeNull();
    expect(formulaRow.querySelector('td:nth-child(3) .sfdt-pill')?.textContent).toBe('formula');
  });

  it('POSTs only createable fields and offers the new record', async () => {
    const apiRequest = vi.fn(async (_m: string, _p: string, _b?: unknown) => ({ id: '001800000000009AAA' }));
    const { feature } = mount({ apiRequest });
    await feature.onActivate?.();
    await flush();
    cloneButton().click();
    await flush();
    createButton().click();
    await flush();

    expect(apiRequest).toHaveBeenCalledWith('POST', expect.stringContaining('/sobjects/Account'), expect.anything());
    const body = (apiRequest.mock.calls[0]![2] ?? {}) as Record<string, unknown>;
    expect(Object.keys(body)).toContain('Name');
    expect(Object.keys(body)).not.toContain('Formula__c');
    expect(Object.keys(body)).not.toContain('Locked__c');

    expect(document.body.textContent).toMatch(/001800000000009AAA/);
    const labels = Array.from(document.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels.some((l) => l?.includes('Open in Salesforce'))).toBe(true);
  });

  it('maps a rejected create onto the exact field, and does not say a record was saved', async () => {
    const rejection = new SalesforceRestError('bad', 400, [
      { message: 'Name is required', errorCode: 'REQUIRED_FIELD_MISSING', fields: ['Name'] },
    ]);
    const { feature } = mount({ apiRequest: vi.fn(async () => { throw rejection; }) });
    await feature.onActivate?.();
    await flush();
    cloneButton().click();
    await flush();
    createButton().click();
    await flush();

    expect(cloneRowFor('Name')!.querySelector('.sfdt-field-error')?.textContent).toBe('Name is required');
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/The record was not created/);
    expect(text).not.toMatch(/No changes were saved/);
  });
});
