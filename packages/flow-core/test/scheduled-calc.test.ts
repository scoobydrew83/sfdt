import { describe, it, expect } from 'vitest';
import {
  FREQUENCY,
  type FlowRecord,
  buildSummarySentence,
  calculateNextRun,
  formatDateLong,
  formatDateTimeLong,
  formatFilters,
  formatRelative,
  formatTime,
  getRunsInRange,
  getScheduleStartDateTime,
  isExpired,
  parseActivationDate,
  parseSchedule,
} from '../src/scheduled-calc.js';

function dailyFlow(startDate: string, startTime: string): FlowRecord {
  return {
    Metadata: {
      start: {
        triggerType: 'Scheduled',
        schedule: { frequency: FREQUENCY.DAILY, startDate, startTime },
        object: 'Account',
        filterLogic: 'and',
        filters: [],
      },
    },
  };
}

function weeklyFlow(startDate: string, startTime: string): FlowRecord {
  return {
    Metadata: {
      start: {
        triggerType: 'Scheduled',
        schedule: { frequency: FREQUENCY.WEEKLY, startDate, startTime },
        object: 'Opportunity',
        filterLogic: 'and',
        filters: [],
      },
    },
  };
}

function onceFlow(startDate: string, startTime: string): FlowRecord {
  return {
    Metadata: {
      start: {
        triggerType: 'Scheduled',
        schedule: { frequency: FREQUENCY.ONCE, startDate, startTime },
        object: 'Case',
        filterLogic: 'and',
        filters: [],
      },
    },
  };
}

// All test fixtures use specific dates only to assert relative ordering and
// day-of-week. 2026-04-30 is a Thursday (also asserted as one of the tests);
// other dates are chosen to be unambiguously past/future relative to the
// explicit `now` values each test passes in.

describe('flow-core/scheduled-calc', () => {
  describe('parseSchedule', () => {
    it('parses a Daily flow', () => {
      const parsed = parseSchedule(dailyFlow('2026-04-30', '22:00:00.000Z'))!;
      expect(parsed.frequency).toBe('Daily');
      expect(parsed.startTimeHours).toBe(22);
      expect(parsed.startTimeMinutes).toBe(0);
      expect(parsed.weeklyDayOfWeek).toBeNull();
      expect(parsed.targetObject).toBe('Account');
    });

    it('parses a Weekly flow and derives day-of-week from startDate', () => {
      // 2026-04-30 is a Thursday.
      const parsed = parseSchedule(weeklyFlow('2026-04-30', '07:30:00.000Z'))!;
      expect(parsed.frequency).toBe('Weekly');
      expect(parsed.weeklyDayOfWeek).toBe(4); // Thursday
    });

    it('returns null for an Autolaunched flow (not Scheduled)', () => {
      const flow: FlowRecord = {
        Metadata: { start: { triggerType: 'RecordAfterSave' } },
      };
      expect(parseSchedule(flow)).toBeNull();
    });

    it('returns null when the schedule block is missing required fields', () => {
      const partial: FlowRecord = {
        Metadata: { start: { triggerType: 'Scheduled', schedule: { frequency: 'Daily' } } },
      };
      expect(parseSchedule(partial)).toBeNull();
    });

    it('rejects impossible calendar dates that JS would silently roll forward', () => {
      // April has 30 days. JS Date(2026, 3, 31) silently rolls to May 1, which
      // we explicitly catch.
      expect(parseSchedule(dailyFlow('2026-04-31', '08:00:00.000Z'))).toBeNull();
    });

    it('rejects out-of-range times', () => {
      expect(parseSchedule(dailyFlow('2026-04-30', '24:00:00.000Z'))).toBeNull();
      expect(parseSchedule(dailyFlow('2026-04-30', '12:60:00.000Z'))).toBeNull();
    });

    it('rejects unknown frequencies', () => {
      const flow: FlowRecord = {
        Metadata: {
          start: {
            triggerType: 'Scheduled',
            schedule: {
              frequency: 'Hourly',
              startDate: '2026-04-30',
              startTime: '08:00:00.000Z',
            },
          },
        },
      };
      expect(parseSchedule(flow)).toBeNull();
    });

    it('handles null/undefined input', () => {
      expect(parseSchedule(null)).toBeNull();
      expect(parseSchedule(undefined)).toBeNull();
      expect(parseSchedule({})).toBeNull();
    });
  });

  describe('parseActivationDate', () => {
    it('parses ISO timestamps', () => {
      const d = parseActivationDate('2026-04-29T10:15:00.000Z')!;
      expect(d).toBeInstanceOf(Date);
    });

    it('returns null on invalid input', () => {
      expect(parseActivationDate(null)).toBeNull();
      expect(parseActivationDate('')).toBeNull();
      expect(parseActivationDate('not a date')).toBeNull();
    });
  });

  describe('calculateNextRun — Once', () => {
    it('returns the scheduled datetime when in the future', () => {
      const parsed = parseSchedule(onceFlow('2030-12-31', '23:59:00.000Z'))!;
      const next = calculateNextRun(parsed, null, new Date(2026, 5, 1, 0, 0, 0));
      expect(next).not.toBeNull();
      expect(next!.getFullYear()).toBe(2030);
    });

    it('returns null when the scheduled datetime has passed', () => {
      const parsed = parseSchedule(onceFlow('2020-06-15', '08:00:00.000Z'))!;
      expect(calculateNextRun(parsed, null, new Date(2026, 5, 1))).toBeNull();
    });

    it('returns null when scheduleStart is before activationDate', () => {
      // Once flow whose scheduled time was already past when activated → never runs.
      const parsed = parseSchedule(onceFlow('2026-04-30', '08:00:00.000Z'))!;
      const activation = new Date(2026, 5, 1, 0, 0, 0);
      expect(calculateNextRun(parsed, activation, new Date(2026, 5, 2))).toBeNull();
    });
  });

  describe('calculateNextRun — Daily', () => {
    it('returns today\'s scheduled time when "now" is earlier in the same day', () => {
      const parsed = parseSchedule(dailyFlow('2026-04-30', '22:00:00.000Z'))!;
      const next = calculateNextRun(parsed, null, new Date(2026, 5, 1, 10, 0, 0))!;
      expect(next.getHours()).toBe(22);
      expect(next.getDate()).toBe(1);
      expect(next.getMonth()).toBe(5); // June
    });

    it('returns tomorrow\'s scheduled time when "now" is past today\'s', () => {
      const parsed = parseSchedule(dailyFlow('2026-04-30', '08:00:00.000Z'))!;
      const next = calculateNextRun(parsed, null, new Date(2026, 5, 1, 10, 0, 0))!;
      expect(next.getHours()).toBe(8);
      expect(next.getDate()).toBe(2);
    });

    it('respects activationDate when later than schedule start', () => {
      const parsed = parseSchedule(dailyFlow('2026-04-30', '08:00:00.000Z'))!;
      const activation = new Date(2026, 5, 15, 12, 0, 0); // 15 June, after 08:00
      const next = calculateNextRun(parsed, activation, new Date(2026, 5, 1))!;
      // After activation on 15 June at 12:00, the next 08:00 run is 16 June.
      expect(next.getDate()).toBe(16);
      expect(next.getMonth()).toBe(5);
    });
  });

  describe('calculateNextRun — Weekly', () => {
    it('snaps forward to the target day-of-week', () => {
      // 2026-04-30 is a Thursday → weeklyDayOfWeek = 4.
      const parsed = parseSchedule(weeklyFlow('2026-04-30', '09:00:00.000Z'))!;
      // Starting from a Monday (2026-06-08), the next run is Thursday 2026-06-11.
      const next = calculateNextRun(parsed, null, new Date(2026, 5, 8, 7, 0, 0))!;
      expect(next.getDay()).toBe(4);
      expect(next.getDate()).toBe(11);
    });

    it('returns one week later when "now" is past the target hour on the right DOW', () => {
      const parsed = parseSchedule(weeklyFlow('2026-04-30', '09:00:00.000Z'))!;
      // 2026-06-11 is also a Thursday; afternoon means next run is the following Thursday.
      const next = calculateNextRun(parsed, null, new Date(2026, 5, 11, 14, 0, 0))!;
      expect(next.getDay()).toBe(4);
      expect(next.getDate()).toBe(18);
    });
  });

  describe('isExpired', () => {
    it('returns true for an expired Once flow', () => {
      const parsed = parseSchedule(onceFlow('2020-06-15', '08:00:00.000Z'))!;
      expect(isExpired(parsed, null, new Date(2026, 5, 1))).toBe(true);
    });

    it('returns false for a future Once flow', () => {
      const parsed = parseSchedule(onceFlow('2030-04-30', '08:00:00.000Z'))!;
      expect(isExpired(parsed, null, new Date(2026, 5, 1))).toBe(false);
    });

    it('returns false for recurring flows', () => {
      const parsed = parseSchedule(dailyFlow('2020-06-15', '08:00:00.000Z'))!;
      expect(isExpired(parsed, null, new Date(2026, 5, 1))).toBe(false);
    });
  });

  describe('getRunsInRange', () => {
    it('enumerates daily runs within a 5-day window', () => {
      const parsed = parseSchedule(dailyFlow('2026-04-30', '08:00:00.000Z'))!;
      const runs = getRunsInRange(
        parsed,
        null,
        new Date(2026, 5, 1, 0, 0, 0),
        new Date(2026, 5, 5, 23, 59, 59),
      );
      expect(runs).toHaveLength(5);
      expect(runs.every((r) => r.getHours() === 8)).toBe(true);
    });

    it('enumerates weekly runs within a 1-month window', () => {
      // 2026-04-30 is a Thursday; in June 2026 the Thursdays are 4, 11, 18, 25.
      const parsed = parseSchedule(weeklyFlow('2026-04-30', '09:00:00.000Z'))!;
      const runs = getRunsInRange(
        parsed,
        null,
        new Date(2026, 5, 1, 0, 0, 0),
        new Date(2026, 5, 30, 23, 59, 59),
      );
      expect(runs).toHaveLength(4);
      expect(runs.every((r) => r.getDay() === 4)).toBe(true);
    });

    it('returns a single run for a Once flow inside the range', () => {
      const parsed = parseSchedule(onceFlow('2026-06-15', '12:00:00.000Z'))!;
      const runs = getRunsInRange(
        parsed,
        null,
        new Date(2026, 5, 1),
        new Date(2026, 5, 30, 23, 59, 59),
      );
      expect(runs).toHaveLength(1);
      expect(runs[0]!.getDate()).toBe(15);
    });

    it('returns an empty array when the range is invalid', () => {
      const parsed = parseSchedule(dailyFlow('2026-04-30', '08:00:00.000Z'))!;
      expect(getRunsInRange(parsed, null, new Date(2026, 5, 5), new Date(2026, 5, 1))).toEqual([]);
    });
  });

  describe('getScheduleStartDateTime', () => {
    it('combines startDate and startTime into a single Date', () => {
      const parsed = parseSchedule(dailyFlow('2026-04-30', '22:00:00.000Z'))!;
      const dt = getScheduleStartDateTime(parsed);
      expect(dt.getFullYear()).toBe(2026);
      expect(dt.getMonth()).toBe(3); // April
      expect(dt.getDate()).toBe(30);
      expect(dt.getHours()).toBe(22);
    });
  });

  describe('buildSummarySentence', () => {
    it('describes a Daily flow against all records', () => {
      const parsed = parseSchedule(dailyFlow('2026-04-30', '22:00:00.000Z'))!;
      expect(buildSummarySentence(parsed)).toBe(
        'This flow runs daily at 22:00 against all Account records.',
      );
    });

    it('describes a Weekly flow', () => {
      // 2026-04-30 is Thursday.
      const parsed = parseSchedule(weeklyFlow('2026-04-30', '07:30:00.000Z'))!;
      expect(buildSummarySentence(parsed)).toBe(
        'This flow runs every Thursday at 07:30 against all Opportunity records.',
      );
    });

    it('describes a Once flow with the long-form date', () => {
      const parsed = parseSchedule(onceFlow('2026-04-30', '02:00:00.000Z'))!;
      expect(buildSummarySentence(parsed)).toBe(
        'This flow runs once on Thu, 30 Apr 2026 at 02:00 against all Case records.',
      );
    });

    it('describes filters with AND/OR logic', () => {
      const flow: FlowRecord = {
        Metadata: {
          start: {
            triggerType: 'Scheduled',
            schedule: {
              frequency: FREQUENCY.DAILY,
              startDate: '2026-04-30',
              startTime: '08:00:00.000Z',
            },
            object: 'Opportunity',
            filterLogic: 'and',
            filters: [
              { field: 'StageName', operator: 'EqualTo', value: { stringValue: 'Prospecting' } },
              { field: 'Amount', operator: 'GreaterThan', value: { numberValue: 10000 } },
            ],
          },
        },
      };
      const parsed = parseSchedule(flow)!;
      expect(buildSummarySentence(parsed)).toContain(
        "against Opportunity records where StageName = 'Prospecting' AND Amount > 10000",
      );
    });

    it('describes a flow with no target object', () => {
      const flow: FlowRecord = {
        Metadata: {
          start: {
            triggerType: 'Scheduled',
            schedule: {
              frequency: FREQUENCY.DAILY,
              startDate: '2026-04-30',
              startTime: '08:00:00.000Z',
            },
          },
        },
      };
      const parsed = parseSchedule(flow)!;
      expect(buildSummarySentence(parsed)).toBe(
        'This flow runs daily at 08:00 with no target object.',
      );
    });
  });

  describe('formatFilters', () => {
    it('renders custom filterLogic as a numbered list', () => {
      const flow: FlowRecord = {
        Metadata: {
          start: {
            triggerType: 'Scheduled',
            schedule: {
              frequency: FREQUENCY.DAILY,
              startDate: '2026-04-30',
              startTime: '08:00:00.000Z',
            },
            object: 'Lead',
            filterLogic: '1 AND (2 OR 3)',
            filters: [
              { field: 'Status', operator: 'EqualTo', value: { stringValue: 'New' } },
              { field: 'AnnualRevenue', operator: 'GreaterThan', value: { numberValue: 1_000_000 } },
              { field: 'NumberOfEmployees', operator: 'GreaterThan', value: { numberValue: 500 } },
            ],
          },
        },
      };
      const parsed = parseSchedule(flow)!;
      const text = formatFilters(parsed);
      expect(text).toContain('1.');
      expect(text).toContain('2.');
      expect(text).toContain('3.');
    });

    it('renders elementReference values with {!Name} syntax', () => {
      const flow: FlowRecord = {
        Metadata: {
          start: {
            triggerType: 'Scheduled',
            schedule: {
              frequency: FREQUENCY.DAILY,
              startDate: '2026-04-30',
              startTime: '08:00:00.000Z',
            },
            object: 'Lead',
            filterLogic: 'and',
            filters: [
              { field: 'OwnerId', operator: 'EqualTo', value: { elementReference: 'CurrentUser' } },
            ],
          },
        },
      };
      const parsed = parseSchedule(flow)!;
      expect(formatFilters(parsed)).toBe('OwnerId = {!CurrentUser}');
    });
  });

  describe('formatters', () => {
    it('formatTime pads single-digit hours and minutes', () => {
      expect(formatTime(7, 5)).toBe('07:05');
      expect(formatTime(22, 30)).toBe('22:30');
    });

    it('formatDateLong / formatDateTimeLong', () => {
      // Thursday, 30 April 2026 at 22:00.
      const d = new Date(2026, 3, 30, 22, 0, 0);
      expect(formatDateLong(d)).toBe('Thu, 30 Apr 2026');
      expect(formatDateTimeLong(d)).toBe('Thu, 30 Apr 2026 at 22:00');
    });

    it('formatRelative — Today/Tomorrow/Yesterday', () => {
      const now = new Date(2026, 5, 15);
      expect(formatRelative(new Date(2026, 5, 15), now)).toBe('Today');
      expect(formatRelative(new Date(2026, 5, 16), now)).toBe('Tomorrow');
      expect(formatRelative(new Date(2026, 5, 14), now)).toBe('Yesterday');
    });

    it('formatRelative — days, weeks, months, years', () => {
      const now = new Date(2026, 5, 15);
      expect(formatRelative(new Date(2026, 5, 18), now)).toBe('in 3 days');
      expect(formatRelative(new Date(2026, 5, 12), now)).toBe('3 days ago');
      expect(formatRelative(new Date(2026, 5, 25), now)).toBe('in 1 week');
      expect(formatRelative(new Date(2026, 7, 15), now)).toBe('in 2 months');
      expect(formatRelative(new Date(2028, 5, 15), now)).toBe('in 2 years');
    });

    it('formatRelative — past weeks, months, and years', () => {
      const now = new Date(2026, 5, 15);
      expect(formatRelative(new Date(2026, 5, 1), now)).toBe('2 weeks ago');
      expect(formatRelative(new Date(2026, 3, 15), now)).toBe('2 months ago');
      expect(formatRelative(new Date(2024, 5, 15), now)).toBe('2 years ago');
    });

    it('formatRelative — non-Date target returns empty; non-Date now falls back to today', () => {
      expect(formatRelative('nope' as never)).toBe('');
      // now is invalid → defaults to the real current date; the target is also
      // "now-ish" so this just confirms no throw and a non-empty label.
      expect(typeof formatRelative(new Date(), 'bad' as never)).toBe('string');
    });

    it('formatDateLong / formatDateTimeLong reject non-Date input', () => {
      expect(formatDateLong('nope' as never)).toBe('');
      expect(formatDateTimeLong('nope' as never)).toBe('');
    });
  });

  describe('parseSchedule — malformed time and date fields', () => {
    function scheduledFlow(startDate: unknown, startTime: unknown): FlowRecord {
      return {
        Metadata: {
          start: {
            triggerType: 'Scheduled',
            schedule: { frequency: FREQUENCY.DAILY, startDate, startTime } as never,
          },
        },
      };
    }

    it('rejects a non-string startTime', () => {
      expect(parseSchedule(scheduledFlow('2026-04-30', 800))).toBeNull();
    });

    it('rejects a startTime without minutes', () => {
      expect(parseSchedule(scheduledFlow('2026-04-30', '0800'))).toBeNull();
    });

    it('rejects a non-numeric startTime', () => {
      expect(parseSchedule(scheduledFlow('2026-04-30', 'ab:cd:00'))).toBeNull();
    });

    it('rejects a non-string startDate', () => {
      expect(parseSchedule(scheduledFlow(20260430, '08:00:00.000Z'))).toBeNull();
    });

    it('rejects a startDate that does not match YYYY-MM-DD', () => {
      expect(parseSchedule(scheduledFlow('2026/04/30', '08:00:00.000Z'))).toBeNull();
    });
  });

  describe('calculateNextRun / getRunsInRange — guards and activation windows', () => {
    it('calculateNextRun returns null for a null schedule', () => {
      expect(calculateNextRun(null, null, new Date(2026, 5, 1))).toBeNull();
    });

    it('calculateNextRun tolerates a non-Date "from" by treating it as now', () => {
      const parsed = parseSchedule(dailyFlow('2026-04-30', '08:00:00.000Z'))!;
      expect(calculateNextRun(parsed, null, 'not a date' as never)).toBeInstanceOf(Date);
    });

    it('getRunsInRange returns [] for a null schedule or non-Date range bounds', () => {
      const parsed = parseSchedule(dailyFlow('2026-04-30', '08:00:00.000Z'))!;
      expect(getRunsInRange(null, null, new Date(2026, 5, 1), new Date(2026, 5, 5))).toEqual([]);
      expect(getRunsInRange(parsed, null, 'x' as never, new Date(2026, 5, 5))).toEqual([]);
    });

    it('getRunsInRange skips a Once flow whose schedule predates activation', () => {
      const parsed = parseSchedule(onceFlow('2026-04-30', '08:00:00.000Z'))!;
      const activation = new Date(2026, 5, 1);
      expect(getRunsInRange(parsed, activation, new Date(2026, 5, 1), new Date(2026, 5, 30))).toEqual([]);
    });

    it('getRunsInRange honours an activationDate later than the schedule start (daily)', () => {
      const parsed = parseSchedule(dailyFlow('2026-04-30', '08:00:00.000Z'))!;
      const activation = new Date(2026, 5, 10, 12, 0, 0); // 10 June, after 08:00
      const runs = getRunsInRange(parsed, activation, new Date(2026, 5, 1), new Date(2026, 5, 15, 23, 59, 59));
      // First run is 11 June (08:00 on the 10th already passed at activation).
      expect(runs[0]!.getDate()).toBe(11);
      expect(runs.every((r) => r.getDate() >= 11)).toBe(true);
    });

    it('getRunsInRange honours an activationDate later than the schedule start (weekly)', () => {
      const parsed = parseSchedule(weeklyFlow('2026-04-30', '09:00:00.000Z'))!; // Thursdays
      const activation = new Date(2026, 5, 20); // Sat 20 June
      const runs = getRunsInRange(parsed, activation, new Date(2026, 5, 1), new Date(2026, 6, 15, 23, 59, 59));
      expect(runs.length).toBeGreaterThan(0);
      expect(runs.every((r) => r.getDay() === 4 && r >= activation)).toBe(true);
    });

    it('calculateNextRun (weekly) anchors on the activation date when it is the later bound', () => {
      const parsed = parseSchedule(weeklyFlow('2026-04-30', '09:00:00.000Z'))!; // Thursdays
      const activation = new Date(2026, 5, 20); // Sat 20 June
      const next = calculateNextRun(parsed, activation, new Date(2026, 5, 1))!;
      expect(next.getDay()).toBe(4);
      expect(next >= activation).toBe(true);
    });
  });

  describe('formatFilters — value and clause variants', () => {
    function filterFlow(filters: unknown[], filterLogic = 'and'): FlowRecord {
      return {
        Metadata: {
          start: {
            triggerType: 'Scheduled',
            schedule: {
              frequency: FREQUENCY.DAILY,
              startDate: '2026-04-30',
              startTime: '08:00:00.000Z',
            },
            object: 'Account',
            filterLogic,
            filters: filters as never,
          },
        },
      };
    }

    it('renders boolean, date, datetime, raw, null, and empty-object values', () => {
      const parsed = parseSchedule(
        filterFlow([
          { field: 'IsActive', operator: 'EqualTo', value: { booleanValue: true } },
          { field: 'Closed', operator: 'EqualTo', value: { booleanValue: false } },
          { field: 'CloseDate', operator: 'EqualTo', value: { dateValue: '2026-06-09' } },
          { field: 'CreatedDate', operator: 'EqualTo', value: { dateTimeValue: '2026-06-09T00:00:00Z' } },
          { field: 'Name', operator: 'EqualTo', value: 'rawstring' },
          { field: 'Owner', operator: 'EqualTo', value: null },
          { field: 'Empty', operator: 'EqualTo', value: {} },
        ]),
      )!;
      const text = formatFilters(parsed);
      expect(text).toContain('IsActive = true');
      expect(text).toContain('Closed = false');
      expect(text).toContain('CloseDate = 2026-06-09');
      expect(text).toContain('CreatedDate = 2026-06-09T00:00:00Z');
      expect(text).toContain('Name = rawstring');
      expect(text).toContain('Owner = null');
      expect(text).toContain('Empty = ?');
    });

    it('drops clauses missing a field or operator and passes unknown operators through verbatim', () => {
      const parsed = parseSchedule(
        filterFlow([
          { field: 'OnlyField' }, // no operator → dropped
          { operator: 'EqualTo' }, // no field → dropped
          { field: 'Stage', operator: 'CustomOp', value: { stringValue: 'x' } },
        ]),
      )!;
      expect(formatFilters(parsed)).toBe("Stage CustomOp 'x'");
    });

    it('returns an empty string when no clause is renderable', () => {
      const parsed = parseSchedule(filterFlow([{ field: 'OnlyField' }]))!;
      expect(formatFilters(parsed)).toBe('');
    });

    it('formatFilters and buildSummarySentence return empty for a null schedule', () => {
      expect(formatFilters(null)).toBe('');
      expect(buildSummarySentence(null)).toBe('');
    });
  });
});
