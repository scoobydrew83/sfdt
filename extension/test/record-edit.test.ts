import { describe, it, expect } from 'vitest';
import type { FieldDescribe } from '../lib/describe-cache.js';
import type { SalesforceRestErrorDetail } from '../lib/salesforce-api.js';
import {
  EDITABLE_TYPES,
  SYSTEM_FIELD_NAMES,
  isEditableType,
  classifyFieldEditability,
  formatForInput,
  coerceForWire,
  buildDirtyDiff,
  mapSaveErrors,
} from '../lib/record-edit.js';

// Minimal describe field. Everything the model reads is optional on
// FieldDescribe, so the helper mirrors a real payload's defaults: writable,
// not calculated, not auto-number.
function fld(over: Partial<FieldDescribe> & { name: string; type: string }): FieldDescribe {
  return {
    label: over.name,
    relationshipName: null,
    referenceTo: [],
    picklistValues: [],
    nillable: true,
    calculated: false,
    updateable: true,
    createable: true,
    ...over,
  } as FieldDescribe;
}

describe('EDITABLE_TYPES', () => {
  it('contains exactly the types the mini-plan puts in scope', () => {
    expect([...EDITABLE_TYPES].sort()).toEqual(
      [
        'boolean',
        'currency',
        'date',
        'datetime',
        'double',
        'email',
        'int',
        'long',
        'multipicklist',
        'percent',
        'phone',
        'picklist',
        'reference',
        'string',
        'textarea',
        'time',
        'url',
      ].sort(),
    );
  });

  it('excludes every type the plan lists as read-only in v1', () => {
    for (const t of ['richtext', 'address', 'location', 'encryptedstring', 'base64', 'combobox', 'anytype', 'json', 'id']) {
      expect(isEditableType(t)).toBe(false);
    }
  });
});

describe('classifyFieldEditability', () => {
  it('reports a formula field as calculated, not as a permission problem', () => {
    const r = classifyFieldEditability(fld({ name: 'Total__c', type: 'currency', calculated: true, updateable: false }));
    expect(r.editable).toBe(false);
    expect(r).toMatchObject({ reason: 'formula' });
  });

  it('reports an auto-number field as auto-number', () => {
    const r = classifyFieldEditability(fld({ name: 'Ref__c', type: 'string', autoNumber: true, updateable: false }));
    expect(r).toMatchObject({ editable: false, reason: 'auto-number' });
  });

  it('reports platform-maintained fields as system', () => {
    for (const name of SYSTEM_FIELD_NAMES) {
      const r = classifyFieldEditability(
        fld({ name, type: 'datetime', updateable: false, createable: false }),
      );
      expect(r, name).toMatchObject({ editable: false, reason: 'system' });
    }
  });

  it('does NOT claim "system" for an audit field the org has made writable', () => {
    // Set Audit Fields turns CreatedDate into a genuine create-time input.
    // Describe is authoritative over the name list.
    const r = classifyFieldEditability(
      fld({ name: 'CreatedDate', type: 'datetime', updateable: false, createable: true }),
      'create',
    );
    expect(r).toMatchObject({ editable: true, type: 'datetime' });
  });

  it('still calls that audit field "system" in update mode, not a permission problem', () => {
    // The same field, asked the update question. CreatedDate is not updateable
    // in any org under any FLS configuration, so "field-level security" would
    // be a wrong explanation, not merely a vague one — it sends the user
    // hunting through profiles for a permission that does not exist.
    const r = classifyFieldEditability(
      fld({ name: 'CreatedDate', type: 'datetime', updateable: false, createable: true }),
      'update',
    );
    expect(r).toMatchObject({ editable: false, reason: 'system' });
    expect(r.editable === false && r.message).not.toMatch(/field-level security/i);
  });

  it('matches the system field list regardless of casing', () => {
    const r = classifyFieldEditability(
      fld({ name: 'systemmodstamp', type: 'datetime', updateable: false, createable: false }),
    );
    expect(r).toMatchObject({ editable: false, reason: 'system' });
  });

  it('names the offending type in the unsupported-type reason', () => {
    const r = classifyFieldEditability(fld({ name: 'Geo__c', type: 'location', updateable: true }));
    expect(r).toMatchObject({ editable: false, reason: 'unsupported-type' });
    expect(r.editable === false && r.message).toContain('location');
  });

  it('excludes a rich-text area even though its type is textarea', () => {
    const plain = classifyFieldEditability(fld({ name: 'Notes__c', type: 'textarea' }));
    expect(plain).toMatchObject({ editable: true });

    const rich = classifyFieldEditability(fld({ name: 'Body__c', type: 'textarea', htmlFormatted: true }));
    expect(rich).toMatchObject({ editable: false, reason: 'unsupported-type' });
  });

  it('excludes an encrypted field whose type looks ordinary', () => {
    const r = classifyFieldEditability(fld({ name: 'SSN__c', type: 'string', encrypted: true }));
    expect(r).toMatchObject({ editable: false, reason: 'unsupported-type' });
    expect(r.editable === false && r.message).toMatch(/masked/i);
  });

  it('falls back to a non-committal no-permission reason', () => {
    const r = classifyFieldEditability(fld({ name: 'Locked__c', type: 'string', updateable: false }));
    expect(r).toMatchObject({ editable: false, reason: 'no-permission' });
    // We cannot tell "you may not" from "nobody may", so we must not assert one.
    expect(r.editable === false && r.message).toMatch(/field-level security|object permissions/i);
  });

  it('asks the createable question in create mode and the updateable one in update mode', () => {
    // Classic "set on create, locked thereafter" field.
    const f = fld({ name: 'ExternalKey__c', type: 'string', updateable: false, createable: true });
    expect(classifyFieldEditability(f, 'update')).toMatchObject({ editable: false, reason: 'no-permission' });
    expect(classifyFieldEditability(f, 'create')).toMatchObject({ editable: true, type: 'string' });
  });

  it('treats a missing permission attribute as "no", never as "yes"', () => {
    // Absence is not permission: describe always sends these, but a partial
    // fixture must not become writable by omission.
    const bare = { name: 'Mystery__c', type: 'string' } as unknown as FieldDescribe;
    expect(classifyFieldEditability(bare)).toMatchObject({ editable: false, reason: 'no-permission' });
  });

  it('leaves compound components individually editable', () => {
    const street = fld({ name: 'BillingStreet', type: 'textarea', compoundFieldName: 'BillingAddress' });
    expect(classifyFieldEditability(street)).toMatchObject({ editable: true });
  });
});

describe('formatForInput / coerceForWire round trips', () => {
  it('boolean: coerces both ways without passing through a string', () => {
    const f = fld({ name: 'IsActive__c', type: 'boolean' });
    expect(formatForInput(f, true)).toBe(true);
    expect(formatForInput(f, null)).toBe(false);
    expect(formatForInput(f, 'true')).toBe(true);
    expect(coerceForWire(f, true)).toBe(true);
    expect(coerceForWire(f, false)).toBe(false);
    // A checkbox never yields null: unchecked is a real value, not an absence.
    expect(coerceForWire(f, null)).toBe(false);
  });

  it('date: never parsed through a Date, so it cannot shift a day', () => {
    const f = fld({ name: 'CloseDate', type: 'date' });
    expect(formatForInput(f, '2026-01-01')).toBe('2026-01-01');
    expect(coerceForWire(f, '2026-01-01')).toBe('2026-01-01');
    // Round trip is byte-stable regardless of the host zone.
    expect(coerceForWire(f, formatForInput(f, '2026-01-01'))).toBe('2026-01-01');
    expect(coerceForWire(f, '')).toBeNull();
  });

  // A round-trip fixture whose seconds are zero is structurally incapable of
  // detecting a truncating formatter — the assertion passes either way. Every
  // datetime/time fixture below therefore carries NON-ZERO seconds, and the
  // millisecond cases carry non-zero milliseconds.
  it('datetime: reads to browser local, writes back the same instant in ISO UTC', () => {
    const f = fld({ name: 'When__c', type: 'datetime' });
    const wire = '2026-07-30T14:35:45.000Z';
    const local = formatForInput(f, wire) as string;
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    // The round trip must land on the same INSTANT — seconds included.
    expect(new Date(coerceForWire(f, local) as string).getTime()).toBe(new Date(wire).getTime());
    expect(coerceForWire(f, '')).toBeNull();
  });

  it('datetime: the round trip preserves seconds and milliseconds exactly', () => {
    const f = fld({ name: 'When__c', type: 'datetime' });
    for (const wire of [
      '2026-07-30T14:35:45.000Z',
      '2026-07-30T14:35:00.123Z',
      '2026-07-30T14:35:45.678Z',
      '2026-01-01T00:00:01.001Z',
    ]) {
      expect(coerceForWire(f, formatForInput(f, wire)), wire).toBe(wire);
    }
  });

  it('datetime: milliseconds are emitted only when non-zero', () => {
    const f = fld({ name: 'When__c', type: 'datetime' });
    expect(formatForInput(f, '2026-07-30T14:35:45.000Z')).not.toContain('.');
    expect(formatForInput(f, '2026-07-30T14:35:45.250Z')).toContain('.250');
  });

  it('time: reads to HH:mm:ss and writes back the Salesforce time literal', () => {
    const f = fld({ name: 'Opens__c', type: 'time' });
    expect(formatForInput(f, '09:30:45.000Z')).toBe('09:30:45');
    expect(coerceForWire(f, '09:30:45')).toBe('09:30:45.000Z');
    // A control with no `step` yields 'HH:mm'; that must still be a valid write.
    expect(coerceForWire(f, '09:30')).toBe('09:30:00.000Z');
    expect(coerceForWire(f, '')).toBeNull();
  });

  it('time: the round trip preserves seconds and milliseconds exactly', () => {
    const f = fld({ name: 'Opens__c', type: 'time' });
    for (const wire of ['09:30:45.000Z', '09:30:00.500Z', '23:59:59.999Z']) {
      expect(coerceForWire(f, formatForInput(f, wire)), wire).toBe(wire);
    }
    expect(formatForInput(f, '09:30:45.000Z')).not.toContain('.');
    expect(formatForInput(f, '09:30:45.500Z')).toBe('09:30:45.500');
  });

  it('numbers: empty becomes null, numeric text becomes a number', () => {
    const f = fld({ name: 'Amount', type: 'currency', scale: 2 });
    expect(formatForInput(f, 1234.5)).toBe('1234.5');
    expect(coerceForWire(f, '1234.50')).toBe(1234.5);
    expect(coerceForWire(f, 1234.5)).toBe(1234.5);
    expect(coerceForWire(f, '')).toBeNull();
    expect(coerceForWire(f, '   ')).toBeNull();
    expect(coerceForWire(f, 0)).toBe(0);
  });

  it('numbers: unparseable text is handed to the org rather than guessed at', () => {
    const f = fld({ name: 'Amount', type: 'double' });
    expect(coerceForWire(f, 'twelve')).toBe('twelve');
  });

  it('multipicklist: array in the control, semicolon-joined on the wire', () => {
    const f = fld({ name: 'Tags__c', type: 'multipicklist' });
    expect(formatForInput(f, 'A;B;C')).toEqual(['A', 'B', 'C']);
    expect(formatForInput(f, null)).toEqual([]);
    expect(coerceForWire(f, ['A', 'B'])).toBe('A;B');
    expect(coerceForWire(f, [])).toBeNull();
    expect(coerceForWire(f, 'A;B')).toBe('A;B');
  });

  it('text-ish types: blank becomes null, everything else passes through', () => {
    for (const type of ['string', 'textarea', 'email', 'phone', 'url', 'picklist', 'reference']) {
      const f = fld({ name: 'F__c', type });
      expect(coerceForWire(f, ''), type).toBeNull();
      expect(coerceForWire(f, '   '), type).toBeNull();
      expect(coerceForWire(f, 'x'), type).toBe('x');
      expect(formatForInput(f, null), type).toBe('');
    }
  });

  it('coerceForWire is idempotent for every editable type', () => {
    // buildDirtyDiff runs it over already-coerced values; if it were not
    // idempotent, a second pass would manufacture a phantom change.
    const samples: [string, unknown][] = [
      ['boolean', true],
      ['string', 'hello'],
      ['textarea', 'multi\nline'],
      ['email', 'a@b.com'],
      ['phone', '555-1234'],
      ['url', 'https://example.com'],
      ['int', 7],
      ['double', 1.5],
      ['long', 900719925474099],
      ['currency', 10.25],
      ['percent', 33],
      ['date', '2026-02-28'],
      ['datetime', '2026-02-28T10:11:12.345Z'],
      ['time', '10:11:12.345Z'],
      ['picklist', 'Open'],
      ['multipicklist', 'A;B'],
      ['reference', '001800000000001AAA'],
    ];
    for (const [type, value] of samples) {
      const f = fld({ name: 'F__c', type });
      const once = coerceForWire(f, value);
      expect(coerceForWire(f, once), type).toEqual(once);
    }
  });
});

describe('buildDirtyDiff', () => {
  const describeStub = {
    fields: [
      fld({ name: 'Name', type: 'string' }),
      fld({ name: 'Amount', type: 'currency' }),
      fld({ name: 'IsActive__c', type: 'boolean' }),
      fld({ name: 'CloseDate', type: 'date' }),
      fld({ name: 'Formula__c', type: 'currency', calculated: true, updateable: false }),
      fld({ name: 'Locked__c', type: 'string', updateable: false }),
      fld({ name: 'Id', type: 'id', updateable: false, createable: false }),
    ],
  };

  it('returns one answer for both the save bar and the PATCH body', () => {
    const original = { Name: 'A', Amount: 10, IsActive__c: false, CloseDate: '2026-01-01' };
    const edited = { Name: 'B', Amount: 10, IsActive__c: true, CloseDate: '2026-01-01' };
    const diff = buildDirtyDiff(describeStub, original, edited);
    expect(diff.patchBody).toEqual({ Name: 'B', IsActive__c: true });
    expect(diff.changedFieldNames).toEqual(['Name', 'IsActive__c']);
    expect(diff.changedFieldNames).toEqual(Object.keys(diff.patchBody));
  });

  it('is empty when nothing changed', () => {
    const rec = { Name: 'A', Amount: 10, IsActive__c: false, CloseDate: '2026-01-01' };
    expect(buildDirtyDiff(describeStub, rec, { ...rec })).toEqual({
      patchBody: {},
      changedFieldNames: [],
    });
  });

  it('normalises before comparing: numeric string vs number is not a change', () => {
    const diff = buildDirtyDiff(describeStub, { Amount: 10 }, { Amount: '10' });
    expect(diff.changedFieldNames).toEqual([]);
  });

  it('normalises before comparing: empty string vs null is not a change', () => {
    const diff = buildDirtyDiff(describeStub, { Name: null }, { Name: '' });
    expect(diff.changedFieldNames).toEqual([]);
  });

  it('normalises before comparing: two spellings of one instant are not a change', () => {
    const dt = { fields: [fld({ name: 'When__c', type: 'datetime' })] };
    const diff = buildDirtyDiff(
      dt,
      { When__c: '2026-07-30T14:35:45.000+0000' },
      { When__c: '2026-07-30T14:35:45Z' },
    );
    expect(diff.changedFieldNames).toEqual([]);
  });

  // The regression this PR was held for. Reading a record into the controls and
  // saving without touching anything must produce an EMPTY diff. A formatter
  // that truncates makes an untouched field dirty AND silently rewrites it.
  it('a read->render->save cycle with no user edit is never dirty', () => {
    const d = {
      fields: [
        fld({ name: 'When__c', type: 'datetime' }),
        fld({ name: 'Opens__c', type: 'time' }),
        fld({ name: 'CloseDate', type: 'date' }),
        fld({ name: 'Amount', type: 'currency' }),
        fld({ name: 'Tags__c', type: 'multipicklist' }),
        fld({ name: 'IsActive__c', type: 'boolean' }),
        fld({ name: 'Name', type: 'string' }),
      ],
    };
    const record = {
      When__c: '2026-07-30T14:35:45.678Z',
      Opens__c: '09:30:45.500Z',
      CloseDate: '2026-07-30',
      Amount: 1234.5,
      Tags__c: 'C;A',
      IsActive__c: true,
      Name: 'Acme',
    };
    // What PR-2's controls will hold after rendering the record.
    const edited = Object.fromEntries(
      d.fields.map((f) => [f.name, formatForInput(f, record[f.name as keyof typeof record])]),
    );
    expect(buildDirtyDiff(d, record, edited)).toEqual({ patchBody: {}, changedFieldNames: [] });
  });

  it('datetime: a real edit writes the edited instant with its seconds intact', () => {
    const f = fld({ name: 'When__c', type: 'datetime' });
    const original = '2026-07-30T14:35:45.000Z';
    // The user nudges the minute in the control; everything else is untouched.
    // Derived from the formatted value rather than by string-substituting UTC
    // digits, so this holds in every host zone including half-hour offsets.
    const local = formatForInput(f, original) as string;
    const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}):(\d{2})(:\d{2})$/.exec(local);
    expect(parts).not.toBeNull();
    const [, head = '', minute = '', tail = ''] = parts ?? [];
    const edited = `${head}:${String((Number(minute) + 5) % 60).padStart(2, '0')}${tail}`;
    const diff = buildDirtyDiff({ fields: [f] }, { When__c: original }, { When__c: edited });
    expect(diff.changedFieldNames).toEqual(['When__c']);
    expect(diff.patchBody.When__c).toBe(new Date(edited).toISOString());
    // The seconds survived the edit rather than being zeroed on the way through.
    expect(diff.patchBody.When__c).toContain(':45.000Z');
  });

  it('multipicklist: a reorder is not a change (order is not part of the value)', () => {
    // A <select multiple> reads back in DOM order, which is picklist-definition
    // order — not the order the record happened to store.
    const mp = { fields: [fld({ name: 'Tags__c', type: 'multipicklist' })] };
    expect(buildDirtyDiff(mp, { Tags__c: 'C;A' }, { Tags__c: ['A', 'C'] }).changedFieldNames).toEqual(
      [],
    );
    expect(buildDirtyDiff(mp, { Tags__c: 'C;A' }, { Tags__c: 'A;C' }).changedFieldNames).toEqual([]);
  });

  it('multipicklist: adding or removing a value IS a change, written in control order', () => {
    const mp = { fields: [fld({ name: 'Tags__c', type: 'multipicklist' })] };
    expect(buildDirtyDiff(mp, { Tags__c: 'C;A' }, { Tags__c: ['A', 'B', 'C'] }).patchBody).toEqual({
      Tags__c: 'A;B;C',
    });
    expect(buildDirtyDiff(mp, { Tags__c: 'C;A' }, { Tags__c: ['A'] }).patchBody).toEqual({
      Tags__c: 'A',
    });
    expect(buildDirtyDiff(mp, { Tags__c: 'C;A' }, { Tags__c: [] }).patchBody).toEqual({
      Tags__c: null,
    });
  });

  it('clearing a value emits an explicit null', () => {
    const diff = buildDirtyDiff(describeStub, { Name: 'A' }, { Name: '' });
    expect(diff.patchBody).toEqual({ Name: null });
  });

  it('ignores non-editable fields even when their edited value differs', () => {
    const original = { Formula__c: 1, Locked__c: 'x', Id: '001800000000001AAA' };
    const edited = { Formula__c: 2, Locked__c: 'y', Id: '001800000000002AAA' };
    expect(buildDirtyDiff(describeStub, original, edited)).toEqual({
      patchBody: {},
      changedFieldNames: [],
    });
  });

  it('ignores fields describe does not know about', () => {
    const diff = buildDirtyDiff(describeStub, { Ghost__c: 'a' }, { Ghost__c: 'b' });
    expect(diff.changedFieldNames).toEqual([]);
  });

  // --- The security-relevant one -------------------------------------------
  it('omits a field absent from the original GET payload (FLS-hidden)', () => {
    // A field the running user cannot read is simply missing from the record
    // JSON. If the diff treated `undefined` as "was empty", a stray entry in
    // the edited map would PATCH over a value the user was never shown.
    const original = { Name: 'A' }; // Amount hidden by FLS — not a key at all
    const edited = { Name: 'A', Amount: 999 };
    const diff = buildDirtyDiff(describeStub, original, edited);
    expect(diff.patchBody).not.toHaveProperty('Amount');
    expect(diff.patchBody).toEqual({});
  });

  it('omits an FLS-hidden field even when the edited value is null', () => {
    // The dangerous direction: nulling out data the user cannot see.
    const diff = buildDirtyDiff(describeStub, { Name: 'A' }, { Name: 'A', Amount: null });
    expect(diff.patchBody).toEqual({});
  });

  it('still edits a field that is present but legitimately null', () => {
    // Presence is the test, not truthiness — an empty-but-readable field must
    // stay editable.
    const diff = buildDirtyDiff(describeStub, { Amount: null }, { Amount: 5 });
    expect(diff.patchBody).toEqual({ Amount: 5 });
  });

  it('ignores a field the edit map never mentions', () => {
    const diff = buildDirtyDiff(describeStub, { Name: 'A', Amount: 10 }, { Name: 'A' });
    expect(diff.patchBody).toEqual({});
  });

  it('survives a missing or malformed describe', () => {
    expect(buildDirtyDiff(null, { a: 1 }, { a: 2 })).toEqual({ patchBody: {}, changedFieldNames: [] });
    expect(buildDirtyDiff(undefined, { a: 1 }, { a: 2 })).toEqual({ patchBody: {}, changedFieldNames: [] });
    expect(buildDirtyDiff({ fields: [] }, { a: 1 }, { a: 2 })).toEqual({
      patchBody: {},
      changedFieldNames: [],
    });
  });

  it('skips a malformed field entry instead of throwing', () => {
    // A save must not be able to die on a bad describe element.
    const d = {
      fields: [null, undefined, 42, { type: 'string' }, fld({ name: 'Name', type: 'string' })],
    } as unknown as { fields: FieldDescribe[] };
    expect(buildDirtyDiff(d, { Name: 'a' }, { Name: 'b' })).toEqual({
      patchBody: { Name: 'b' },
      changedFieldNames: ['Name'],
    });
  });

  it('ignores an own key whose value is explicitly undefined', () => {
    // JSON.parse cannot produce this, but a hand-built `original` can — and if
    // it did, filter 2 would otherwise stop guarding.
    const original = { Name: 'A', Amount: undefined };
    const diff = buildDirtyDiff(describeStub, original, { Name: 'A', Amount: 999 });
    expect(diff.patchBody).toEqual({});
  });

  it('keeps the save bar and the PATCH body in agreement for any field name', () => {
    // `__proto__` is not a reachable Salesforce API name, but the two outputs
    // disagreeing is the one failure this function must never have.
    const d = { fields: [fld({ name: '__proto__', type: 'string' })] };
    const diff = buildDirtyDiff(d, { ['__proto__']: 'a' }, { ['__proto__']: 'b' });
    expect(diff.changedFieldNames).toEqual(['__proto__']);
    expect(Object.keys(diff.patchBody)).toEqual(diff.changedFieldNames);
    // NB: a `{ __proto__: 'b' }` object literal would set the prototype, not an
    // own key — which is precisely the trap this test exists to close, so the
    // assertion is made on the serialised body the PATCH would actually send.
    expect(JSON.stringify(diff.patchBody)).toBe('{"__proto__":"b"}');
  });
});

describe('mapSaveErrors', () => {
  const detail = (over: Partial<SalesforceRestErrorDetail>): SalesforceRestErrorDetail => ({
    message: 'boom',
    errorCode: 'X',
    fields: [],
    ...over,
  });

  it('routes an error naming a rendered field to that field', () => {
    const r = mapSaveErrors(
      [detail({ message: 'Value too long', errorCode: 'STRING_TOO_LONG', fields: ['Name'] })],
      ['Name', 'Amount'],
    );
    expect(r.fieldErrors).toEqual([
      { field: 'Name', message: 'Value too long', errorCode: 'STRING_TOO_LONG' },
    ]);
    expect(r.bannerErrors).toEqual([]);
  });

  it('routes an error naming a NOT-rendered field to a banner that names it', () => {
    // Hidden by the field filter or the show-nulls toggle — the error must not
    // disappear with the row.
    const r = mapSaveErrors(
      [detail({ message: 'Value too long', errorCode: 'STRING_TOO_LONG', fields: ['Foo__c'] })],
      ['Name'],
    );
    expect(r.fieldErrors).toEqual([]);
    expect(r.bannerErrors).toEqual([
      { text: 'Foo__c: Value too long', field: 'Foo__c', errorCode: 'STRING_TOO_LONG' },
    ]);
  });

  it('routes a field-less error to a banner carrying the errorCode', () => {
    // Object-level validation rules, row locks, trigger addError() on the record.
    const r = mapSaveErrors(
      [detail({ message: 'Close date must be in the future', errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' })],
      ['Name'],
    );
    expect(r.fieldErrors).toEqual([]);
    expect(r.bannerErrors).toEqual([
      {
        text: 'Close date must be in the future',
        field: null,
        errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
      },
    ]);
  });

  it('splits one record that names both a rendered and a hidden field', () => {
    const r = mapSaveErrors(
      [detail({ message: 'Required', errorCode: 'REQUIRED_FIELD_MISSING', fields: ['Name', 'Foo__c'] })],
      ['Name'],
    );
    expect(r.fieldErrors).toHaveLength(1);
    expect(r.fieldErrors[0]?.field).toBe('Name');
    expect(r.bannerErrors).toHaveLength(1);
    expect(r.bannerErrors[0]?.text).toBe('Foo__c: Required');
  });

  it('matches rendered field names case-insensitively', () => {
    const r = mapSaveErrors([detail({ fields: ['name'] })], ['Name']);
    expect(r.fieldErrors.map((e) => e.field)).toEqual(['name']);
    expect(r.bannerErrors).toEqual([]);
  });

  it('loses nothing: every record produces at least one rendered destination', () => {
    const details = [
      detail({ message: 'a', fields: ['Name'] }),
      detail({ message: 'b', fields: ['Hidden__c'] }),
      detail({ message: 'c' }),
    ];
    const r = mapSaveErrors(details, ['Name']);
    expect(r.fieldErrors.length + r.bannerErrors.length).toBe(3);
  });

  it('handles an absent or empty detail list', () => {
    expect(mapSaveErrors(null, ['Name'])).toEqual({ fieldErrors: [], bannerErrors: [] });
    expect(mapSaveErrors(undefined, ['Name'])).toEqual({ fieldErrors: [], bannerErrors: [] });
    expect(mapSaveErrors([], ['Name'])).toEqual({ fieldErrors: [], bannerErrors: [] });
  });

  it('skips malformed entries instead of throwing', () => {
    // The error renderer is the last thing that may fail: a throw here costs
    // the user the edits the error was supposed to help them fix.
    const hostile = [
      null,
      undefined,
      42,
      'nope',
      { message: null, fields: 'NotAnArray' },
      { message: 'ok', errorCode: 7, fields: [1, null, 'Name'] },
    ] as unknown as SalesforceRestErrorDetail[];
    const r = mapSaveErrors(hostile, ['Name']);
    expect(r.fieldErrors).toEqual([{ field: 'Name', message: 'ok', errorCode: '' }]);
    // The message-less record still lands somewhere rather than vanishing.
    expect(r.bannerErrors).toHaveLength(1);
  });

  it('tolerates a non-array detail list and non-string rendered names', () => {
    expect(mapSaveErrors('boom' as unknown as SalesforceRestErrorDetail[], ['Name'])).toEqual({
      fieldErrors: [],
      bannerErrors: [],
    });
    const r = mapSaveErrors([detail({ fields: ['Name'] })], [
      null,
      'Name',
    ] as unknown as string[]);
    expect(r.fieldErrors).toHaveLength(1);
  });
});
