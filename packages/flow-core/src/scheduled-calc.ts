// Schedule-Triggered Flow calculator — ported from
// /Users/dkennedy/dev/2.0.2_0 copy/utils/scheduled-flow-calculator.js.
//
// Pure logic. No DOM, no API, no chrome.*. Date handling matches v2.0.2
// semantics: Salesforce stores the schedule's startTime as `HH:MM:SS.SSSZ`
// but the Z suffix is misleading — it is wall-clock time in the org's
// timezone, not UTC. We strip the Z and treat the time-of-day as local-tz so
// `new Date(...)` operations stay self-consistent inside the calculator.

export const FREQUENCY = {
  ONCE: 'Once',
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
} as const;
export type Frequency = (typeof FREQUENCY)[keyof typeof FREQUENCY];

export const DAYS_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

export interface FlowFilterClause {
  field?: string;
  operator?: string;
  value?: FlowFilterValue | string | number | boolean | null;
}

export interface FlowFilterValue {
  stringValue?: string | null;
  numberValue?: number | null;
  booleanValue?: boolean | null;
  dateValue?: string | null;
  dateTimeValue?: string | null;
  elementReference?: string | null;
}

export interface FlowScheduleBlock {
  frequency?: string;
  startDate?: string;
  startTime?: string;
}

export interface FlowStartBlock {
  triggerType?: string;
  schedule?: FlowScheduleBlock;
  object?: string | null;
  filterLogic?: string | null;
  filters?: FlowFilterClause[];
}

export interface FlowMetadata {
  start?: FlowStartBlock;
}

export interface FlowRecord {
  Metadata?: FlowMetadata;
}

export interface ParsedSchedule {
  frequency: Frequency;
  startDate: Date;
  startTimeHours: number;
  startTimeMinutes: number;
  weeklyDayOfWeek: number | null;
  targetObject: string | null;
  filterLogic: string | null;
  filters: FlowFilterClause[];
}

// ---------- Parsing ----------

function parseStartTime(raw: unknown): { hours: number; minutes: number } | null {
  if (typeof raw !== 'string') return null;
  const stripped = (raw.replace(/Z$/, '').split('.')[0] ?? '').trim();
  const parts = stripped.split(':');
  if (parts.length < 2) return null;
  const hours = parseInt(parts[0]!, 10);
  const minutes = parseInt(parts[1]!, 10);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

function parseStartDate(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = parseInt(m[1]!, 10);
  const month = parseInt(m[2]!, 10) - 1;
  const day = parseInt(m[3]!, 10);
  const d = new Date(year, month, day);
  if (Number.isNaN(d.getTime())) return null;
  // Reject impossible calendar dates (e.g. Feb 30) that JS silently rolls forward.
  if (d.getFullYear() !== year || d.getMonth() !== month || d.getDate() !== day) return null;
  return d;
}

export function parseSchedule(flowRecord: FlowRecord | null | undefined): ParsedSchedule | null {
  if (!flowRecord?.Metadata) return null;
  const start = flowRecord.Metadata.start ?? {};
  if (start.triggerType !== 'Scheduled') return null;

  const schedule = start.schedule;
  if (!schedule?.frequency || !schedule.startDate || !schedule.startTime) return null;

  const frequency = schedule.frequency as Frequency;
  if (
    frequency !== FREQUENCY.ONCE &&
    frequency !== FREQUENCY.DAILY &&
    frequency !== FREQUENCY.WEEKLY
  ) {
    return null;
  }

  const time = parseStartTime(schedule.startTime);
  if (!time) return null;
  const startDate = parseStartDate(schedule.startDate);
  if (!startDate) return null;

  const weeklyDayOfWeek = frequency === FREQUENCY.WEEKLY ? startDate.getDay() : null;

  return {
    frequency,
    startDate,
    startTimeHours: time.hours,
    startTimeMinutes: time.minutes,
    weeklyDayOfWeek,
    targetObject: start.object ?? null,
    filterLogic: start.filterLogic ?? null,
    filters: Array.isArray(start.filters) ? start.filters : [],
  };
}

export function parseActivationDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function getScheduleStartDateTime(parsedSchedule: ParsedSchedule): Date {
  const d = new Date(parsedSchedule.startDate);
  d.setHours(parsedSchedule.startTimeHours, parsedSchedule.startTimeMinutes, 0, 0);
  return d;
}

// ---------- Next-run calculation ----------

function nextDailyRun(schedule: ParsedSchedule, effectiveStart: Date, from: Date): Date {
  const baseDay = effectiveStart > from ? effectiveStart : from;
  const candidate = new Date(
    baseDay.getFullYear(),
    baseDay.getMonth(),
    baseDay.getDate(),
    schedule.startTimeHours,
    schedule.startTimeMinutes,
    0,
    0,
  );
  while (candidate < effectiveStart || candidate < from) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

function nextWeeklyRun(schedule: ParsedSchedule, effectiveStart: Date, from: Date): Date {
  const baseDay = effectiveStart > from ? effectiveStart : from;
  const candidate = new Date(
    baseDay.getFullYear(),
    baseDay.getMonth(),
    baseDay.getDate(),
    schedule.startTimeHours,
    schedule.startTimeMinutes,
    0,
    0,
  );
  const targetDow = schedule.weeklyDayOfWeek ?? candidate.getDay();
  const daysUntil = (targetDow - candidate.getDay() + 7) % 7;
  candidate.setDate(candidate.getDate() + daysUntil);
  while (candidate < effectiveStart || candidate < from) {
    candidate.setDate(candidate.getDate() + 7);
  }
  return candidate;
}

export function calculateNextRun(
  parsedSchedule: ParsedSchedule | null,
  activationDate: Date | null,
  from: Date = new Date(),
): Date | null {
  if (!parsedSchedule) return null;
  const reference = from instanceof Date ? from : new Date();

  const scheduleStart = getScheduleStartDateTime(parsedSchedule);
  const effectiveStart =
    activationDate && activationDate > scheduleStart
      ? new Date(activationDate)
      : new Date(scheduleStart);
  effectiveStart.setSeconds(0, 0);

  if (parsedSchedule.frequency === FREQUENCY.ONCE) {
    if (activationDate && scheduleStart < activationDate) return null;
    return scheduleStart >= reference ? new Date(scheduleStart) : null;
  }

  if (parsedSchedule.frequency === FREQUENCY.DAILY) {
    return nextDailyRun(parsedSchedule, effectiveStart, reference);
  }
  if (parsedSchedule.frequency === FREQUENCY.WEEKLY) {
    return nextWeeklyRun(parsedSchedule, effectiveStart, reference);
  }
  return null;
}

export function isExpired(
  parsedSchedule: ParsedSchedule | null,
  activationDate: Date | null,
  now: Date = new Date(),
): boolean {
  if (!parsedSchedule || parsedSchedule.frequency !== FREQUENCY.ONCE) return false;
  return calculateNextRun(parsedSchedule, activationDate, now) === null;
}

// ---------- Range enumeration ----------

export function getRunsInRange(
  parsedSchedule: ParsedSchedule | null,
  activationDate: Date | null,
  rangeStart: Date,
  rangeEnd: Date,
): Date[] {
  if (!parsedSchedule) return [];
  if (!(rangeStart instanceof Date) || !(rangeEnd instanceof Date)) return [];
  if (rangeEnd < rangeStart) return [];

  const scheduleStart = getScheduleStartDateTime(parsedSchedule);
  const effectiveStart =
    activationDate && activationDate > scheduleStart
      ? new Date(activationDate)
      : new Date(scheduleStart);

  const runs: Date[] = [];

  if (parsedSchedule.frequency === FREQUENCY.ONCE) {
    if (activationDate && scheduleStart < activationDate) return [];
    if (scheduleStart >= rangeStart && scheduleStart <= rangeEnd) runs.push(new Date(scheduleStart));
    return runs;
  }

  if (parsedSchedule.frequency === FREQUENCY.DAILY) {
    const cur = new Date(Math.max(rangeStart.getTime(), effectiveStart.getTime()));
    cur.setHours(parsedSchedule.startTimeHours, parsedSchedule.startTimeMinutes, 0, 0);
    while (cur < rangeStart || cur < effectiveStart) cur.setDate(cur.getDate() + 1);
    while (cur <= rangeEnd) {
      runs.push(new Date(cur));
      cur.setDate(cur.getDate() + 1);
    }
    return runs;
  }

  if (parsedSchedule.frequency === FREQUENCY.WEEKLY) {
    const targetDow = parsedSchedule.weeklyDayOfWeek ?? 0;
    const cur = new Date(Math.max(rangeStart.getTime(), effectiveStart.getTime()));
    cur.setHours(parsedSchedule.startTimeHours, parsedSchedule.startTimeMinutes, 0, 0);
    const daysUntil = (targetDow - cur.getDay() + 7) % 7;
    cur.setDate(cur.getDate() + daysUntil);
    while (cur < rangeStart || cur < effectiveStart) cur.setDate(cur.getDate() + 7);
    while (cur <= rangeEnd) {
      runs.push(new Date(cur));
      cur.setDate(cur.getDate() + 7);
    }
    return runs;
  }
  return runs;
}

// ---------- Summary sentence ----------

const OPERATOR_HUMAN: Record<string, string> = {
  EqualTo: '=',
  NotEqualTo: '!=',
  GreaterThan: '>',
  GreaterThanOrEqualTo: '>=',
  LessThan: '<',
  LessThanOrEqualTo: '<=',
  StartsWith: 'starts with',
  EndsWith: 'ends with',
  Contains: 'contains',
  DoesNotContain: 'does not contain',
  IsNull: 'is null',
  In: 'IN',
  NotIn: 'NOT IN',
};

function formatFilterValue(value: FlowFilterClause['value']): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return String(value);
  const v = value as FlowFilterValue;
  if (v.stringValue != null) return `'${v.stringValue}'`;
  if (v.numberValue != null) return String(v.numberValue);
  if (v.booleanValue != null) return v.booleanValue ? 'true' : 'false';
  if (v.dateValue != null) return v.dateValue;
  if (v.dateTimeValue != null) return v.dateTimeValue;
  if (v.elementReference != null) return `{!${v.elementReference}}`;
  return '?';
}

function formatFilterClause(clause: FlowFilterClause): string {
  if (!clause?.field || !clause.operator) return '';
  const operator = OPERATOR_HUMAN[clause.operator] ?? clause.operator;
  const value = formatFilterValue(clause.value);
  return `${clause.field} ${operator} ${value}`;
}

export function formatFilters(parsedSchedule: ParsedSchedule | null): string {
  if (!parsedSchedule?.filters) return '';
  const parts = parsedSchedule.filters.map(formatFilterClause).filter(Boolean);
  if (parts.length === 0) return '';
  const logic = (parsedSchedule.filterLogic ?? 'and').toLowerCase();
  if (logic === 'and' || logic === 'or') return parts.join(` ${logic.toUpperCase()} `);
  return parts.map((p, i) => `${i + 1}. ${p}`).join('; ');
}

export function buildSummarySentence(parsedSchedule: ParsedSchedule | null): string {
  if (!parsedSchedule) return '';
  const time = formatTime(parsedSchedule.startTimeHours, parsedSchedule.startTimeMinutes);

  let frequencyClause: string;
  if (parsedSchedule.frequency === FREQUENCY.ONCE) {
    frequencyClause = `runs once on ${formatDateLong(parsedSchedule.startDate)} at ${time}`;
  } else if (parsedSchedule.frequency === FREQUENCY.DAILY) {
    frequencyClause = `runs daily at ${time}`;
  } else if (parsedSchedule.frequency === FREQUENCY.WEEKLY) {
    const dow = parsedSchedule.weeklyDayOfWeek ?? 0;
    frequencyClause = `runs every ${DAYS_LONG[dow]} at ${time}`;
  } else {
    frequencyClause = 'runs on a schedule';
  }

  let targetClause: string;
  if (!parsedSchedule.targetObject) {
    targetClause = 'with no target object';
  } else if (!parsedSchedule.filters || parsedSchedule.filters.length === 0) {
    targetClause = `against all ${parsedSchedule.targetObject} records`;
  } else {
    targetClause = `against ${parsedSchedule.targetObject} records where ${formatFilters(parsedSchedule)}`;
  }

  return `This flow ${frequencyClause} ${targetClause}.`;
}

// ---------- Formatting helpers ----------

export function formatTime(hours: number, minutes: number): string {
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function formatDateLong(date: Date): string {
  if (!(date instanceof Date)) return '';
  return `${DAYS_SHORT[date.getDay()]}, ${date.getDate()} ${MONTHS_SHORT[date.getMonth()]} ${date.getFullYear()}`;
}

export function formatDateTimeLong(date: Date): string {
  if (!(date instanceof Date)) return '';
  return `${formatDateLong(date)} at ${formatTime(date.getHours(), date.getMinutes())}`;
}

export function formatRelative(target: Date, now: Date = new Date()): string {
  if (!(target instanceof Date)) return '';
  const reference = now instanceof Date ? now : new Date();

  const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  const todayDay = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
  const diffDays = Math.round((targetDay.getTime() - todayDay.getTime()) / (24 * 60 * 60 * 1000));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays === -1) return 'Yesterday';
  if (diffDays > 1 && diffDays < 7) return `in ${diffDays} days`;
  if (diffDays < 0 && diffDays > -7) return `${-diffDays} days ago`;
  if (diffDays >= 7 && diffDays < 30) {
    const weeks = Math.round(diffDays / 7);
    return `in ${weeks} week${weeks === 1 ? '' : 's'}`;
  }
  if (diffDays <= -7 && diffDays > -30) {
    const weeks = Math.round(-diffDays / 7);
    return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  }
  if (diffDays >= 30 && diffDays < 365) {
    const months = Math.round(diffDays / 30);
    return `in ${months} month${months === 1 ? '' : 's'}`;
  }
  if (diffDays <= -30 && diffDays > -365) {
    const months = Math.round(-diffDays / 30);
    return `${months} month${months === 1 ? '' : 's'} ago`;
  }
  const years = Math.round(diffDays / 365);
  return diffDays > 0
    ? `in ${years} year${years === 1 ? '' : 's'}`
    : `${-years} year${-years === 1 ? '' : 's'} ago`;
}
