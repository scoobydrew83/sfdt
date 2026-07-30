import { describe, it, expect } from 'vitest';
import {
  extractFieldWrites,
  filterFieldWrites,
  FIELD_WRITE_KIND_LABELS,
  type FlowFieldWrite,
} from '../src/field-writes.js';
import {
  afterSaveAccountFlow,
  beforeSaveCaseFlow,
  loopUpdateFlow,
  malformedFlow,
  readOnlyFlow,
  sobjectVariableFlow,
} from './fixtures/field-write-flows.js';

const key = (w: FlowFieldWrite): string => `${w.object ?? '?'}.${w.field}:${w.kind}:${w.status}`;
const keys = (writes: FlowFieldWrite[]): string[] => writes.map(key);

describe('flow-core/field-writes', () => {
  describe('extractFieldWrites — assignments on $Record (before-save pattern)', () => {
    const writes = extractFieldWrites(beforeSaveCaseFlow);

    it('resolves $Record to the record-triggered start object and confirms both writes', () => {
      expect(keys(writes)).toEqual([
        'Case.Priority:assignment:confirmed',
        'Case.Status:assignment:confirmed',
      ]);
    });

    it('carries the writing element name and label', () => {
      expect(writes[0]).toMatchObject({
        elementName: 'Set_Priority',
        elementLabel: 'Set Priority',
        evidence: 'Assignment "Set Priority" sets $Record.Priority',
      });
    });

    it('ignores plain variable assignments (no dot = not a field write)', () => {
      expect(writes.some((w) => w.field === 'counterVar')).toBe(false);
    });

    it('ignores non-record globals like $Flow.CurrentDateTime', () => {
      expect(writes.some((w) => w.field === 'CurrentDateTime')).toBe(false);
    });

    it('never reports a READ as a write (Get Records, entry criteria, filters)', () => {
      // Industry is read by the entry criteria and by Get_Account's filter;
      // Origin is the start filter; Subject/Id are queried fields.
      for (const readOnlyField of ['Industry', 'Origin', 'Id']) {
        expect(writes.some((w) => w.field === readOnlyField)).toBe(false);
      }
    });
  });

  describe('extractFieldWrites — Create / Update Records elements', () => {
    const writes = extractFieldWrites(afterSaveAccountFlow);

    it('reads the field from inputAssignments and the object from the element', () => {
      expect(keys(writes)).toEqual([
        'Task.Status:recordCreate:confirmed',
        'Task.Subject:recordCreate:confirmed',
        'Account.Industry:recordUpdate:confirmed',
        'Account.Rating:recordUpdate:confirmed',
      ]);
    });

    it('writes to an object OTHER than the triggering one are still confirmed', () => {
      const rating = writes.find((w) => w.field === 'Rating')!;
      expect(rating.object).toBe('Account');
      expect(rating.status).toBe('confirmed');
      expect(rating.evidence).toBe(
        'Update Records "Update Account Rating" sets Account.Rating',
      );
    });

    it('does not treat the element filters as writes', () => {
      // Id appears only in Update_Account_Rating's filter.
      expect(writes.some((w) => w.field === 'Id')).toBe(false);
    });
  });

  describe('extractFieldWrites — object resolution through variables and loops', () => {
    it('resolves an sObject variable via objectType, and an inputReference create', () => {
      const writes = extractFieldWrites(sobjectVariableFlow);
      expect(keys(writes)).toEqual([
        'Contact.Email:assignment:confirmed',
        '?.Email:assignment:inferred',
        'Contact.FirstName:assignment:confirmed',
      ]);
    });

    it('marks an unresolvable head as inferred rather than dropping or confirming it', () => {
      const writes = extractFieldWrites(sobjectVariableFlow);
      const apexWrite = writes.find((w) => w.object === null)!;
      expect(apexWrite.status).toBe('inferred');
      expect(apexWrite.evidence).toContain('wrapper.Email');
    });

    it('resolves a loop variable from the collection it iterates', () => {
      const writes = extractFieldWrites(loopUpdateFlow);
      expect(keys(writes)).toEqual([
        'Case.Description:assignment:confirmed',
        '?.Name:assignment:inferred',
      ]);
    });

    it('a relationship hop is reported but never confirmed', () => {
      const hop = extractFieldWrites(loopUpdateFlow).find((w) => w.field === 'Name')!;
      expect(hop.object).toBeNull();
      expect(hop.status).toBe('inferred');
    });
  });

  describe('extractFieldWrites — degenerate input', () => {
    it('returns [] for a read-only flow', () => {
      expect(extractFieldWrites(readOnlyFlow)).toEqual([]);
    });

    it('returns [] for null / undefined / empty metadata', () => {
      expect(extractFieldWrites(null)).toEqual([]);
      expect(extractFieldWrites(undefined)).toEqual([]);
      expect(extractFieldWrites({})).toEqual([]);
    });

    it('never throws on ragged metadata and skips unusable entries', () => {
      expect(() => extractFieldWrites(malformedFlow)).not.toThrow();
      expect(extractFieldWrites(malformedFlow)).toEqual([]);
    });

    it('is deterministic and de-duplicated across repeated calls', () => {
      const a = extractFieldWrites(afterSaveAccountFlow);
      const b = extractFieldWrites(afterSaveAccountFlow);
      expect(a).toEqual(b);
      expect(new Set(a.map(key)).size).toBe(a.length);
    });
  });

  describe('filterFieldWrites', () => {
    const writes = [
      ...extractFieldWrites(beforeSaveCaseFlow),
      ...extractFieldWrites(afterSaveAccountFlow),
      ...extractFieldWrites(sobjectVariableFlow),
    ];

    it('matches field name case-insensitively', () => {
      expect(filterFieldWrites(writes, { field: 'rating', object: 'Account' })).toHaveLength(1);
      expect(filterFieldWrites(writes, { field: 'RATING', object: 'ACCOUNT' })).toHaveLength(1);
    });

    it('scopes to the requested object', () => {
      const statusOnCase = filterFieldWrites(writes, { field: 'Status', object: 'Case' });
      expect(keys(statusOnCase)).toEqual(['Case.Status:assignment:confirmed']);
    });

    it('keeps unresolved-object writes so a real write is never hidden', () => {
      const emailOnContact = filterFieldWrites(writes, { field: 'Email', object: 'Contact' });
      expect(keys(emailOnContact)).toEqual([
        'Contact.Email:assignment:confirmed',
        '?.Email:assignment:inferred',
      ]);
    });

    it('matches any object when none is supplied', () => {
      expect(filterFieldWrites(writes, { field: 'Status' })).toHaveLength(2);
    });

    it('returns [] for an empty field name', () => {
      expect(filterFieldWrites(writes, { field: '  ' })).toEqual([]);
    });

    describe('requireResolvedObject — for callers with no per-flow backing', () => {
      it('drops the unresolved-object write instead of keeping it', () => {
        const strict = filterFieldWrites(writes, {
          field: 'Email',
          object: 'Contact',
          requireResolvedObject: true,
        });
        expect(keys(strict)).toEqual(['Contact.Email:assignment:confirmed']);
      });

      it('leaves every object-bound write untouched', () => {
        const lenient = filterFieldWrites(writes, { field: 'Status', object: 'Case' });
        const strict = filterFieldWrites(writes, {
          field: 'Status',
          object: 'Case',
          requireResolvedObject: true,
        });
        expect(strict).toEqual(lenient);
      });

      it('never rescues a same-named write on a DIFFERENT object', () => {
        // Task.Status is a real, bound write — it must not answer a Case.Status query
        // under either mode.
        for (const requireResolvedObject of [false, true]) {
          const rows = filterFieldWrites(writes, {
            field: 'Status',
            object: 'Case',
            requireResolvedObject,
          });
          expect(rows.every((w) => w.object === 'Case')).toBe(true);
        }
      });

      it('drops unbindable writes even when no object is supplied', () => {
        expect(
          filterFieldWrites(writes, { field: 'Email', requireResolvedObject: true }).every(
            (w) => w.object !== null,
          ),
        ).toBe(true);
      });

      it('defaults to the lenient behaviour when the flag is omitted', () => {
        expect(filterFieldWrites(writes, { field: 'Email', object: 'Contact' })).toHaveLength(2);
      });
    });
  });

  it('exports a display label for every write kind', () => {
    expect(Object.keys(FIELD_WRITE_KIND_LABELS).sort()).toEqual([
      'assignment',
      'recordCreate',
      'recordUpdate',
    ]);
  });
});
