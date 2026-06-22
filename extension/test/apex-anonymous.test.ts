import { describe, it, expect } from 'vitest';
import {
  _apexAnonymousTestApi,
  type ExecuteAnonymousResult,
} from '../features/apex-anonymous.js';

const {
  summariseResult,
  DEBUG_LEVEL_DEVELOPER_NAME,
  buildDebugLevelLookup,
  buildTraceFlagLookup,
  buildLatestApexLogLookup,
  debugLevelCreatePayload,
  traceFlagWindow,
  traceFlagCreatePayload,
  traceFlagIsActive,
  pickNewLogId,
} = _apexAnonymousTestApi();

function result(overrides: Partial<ExecuteAnonymousResult>): ExecuteAnonymousResult {
  return {
    compiled: true,
    compileProblem: null,
    success: true,
    line: -1,
    column: -1,
    exceptionMessage: null,
    exceptionStackTrace: null,
    ...overrides,
  };
}

describe('apex-anonymous — summariseResult', () => {
  it('reports success when compiled and executed', () => {
    expect(summariseResult(result({}))).toEqual({
      ok: true,
      message: 'Compiled and executed successfully.',
    });
  });

  it('reports compile errors with line/column', () => {
    const s = summariseResult(
      result({ compiled: false, success: false, line: 3, column: 7, compileProblem: 'Unexpected token' }),
    );
    expect(s.ok).toBe(false);
    expect(s.message).toContain('line 3');
    expect(s.message).toContain('col 7');
    expect(s.message).toContain('Unexpected token');
  });

  it('reports runtime exceptions', () => {
    const s = summariseResult(
      result({ success: false, exceptionMessage: 'System.NullPointerException' }),
    );
    expect(s.ok).toBe(false);
    expect(s.message).toContain('System.NullPointerException');
  });
});

describe('apex-anonymous — log capture SOQL builders', () => {
  it('looks up the feature-owned DebugLevel by developer name', () => {
    const q = buildDebugLevelLookup();
    expect(q).toContain('FROM DebugLevel');
    expect(q).toContain(`DeveloperName = '${DEBUG_LEVEL_DEVELOPER_NAME}'`);
    expect(q).toContain('LIMIT 1');
  });

  it('scopes the trace-flag lookup to the user and DEVELOPER_LOG', () => {
    const q = buildTraceFlagLookup('005000000000001');
    expect(q).toContain('FROM TraceFlag');
    expect(q).toContain("TracedEntityId = '005000000000001'");
    expect(q).toContain("LogType = 'DEVELOPER_LOG'");
  });

  it('escapes single quotes in the user id to avoid SOQL injection', () => {
    const q = buildTraceFlagLookup("005' OR Id != null --");
    expect(q).toContain("005\\' OR Id != null --");
  });

  it('finds the newest ApexLog for the user', () => {
    const q = buildLatestApexLogLookup('005000000000001');
    expect(q).toContain('FROM ApexLog');
    expect(q).toContain("LogUserId = '005000000000001'");
    expect(q).toContain('ORDER BY StartTime DESC');
    expect(q).toContain('LIMIT 1');
  });
});

describe('apex-anonymous — trace-flag payloads', () => {
  it('builds a FINEST DebugLevel payload', () => {
    const p = debugLevelCreatePayload();
    expect(p.DeveloperName).toBe(DEBUG_LEVEL_DEVELOPER_NAME);
    expect(p.ApexCode).toBe('FINEST');
  });

  it('holds the trace-flag window to exactly 24h from a back-dated start', () => {
    const now = Date.parse('2026-06-22T12:00:00.000Z');
    const w = traceFlagWindow(now);
    // start is back-dated 60s to dodge clock skew
    expect(w.StartDate).toBe('2026-06-22T11:59:00.000Z');
    // expiration is exactly 24h after the (back-dated) start — within the cap
    const span = Date.parse(w.ExpirationDate) - Date.parse(w.StartDate);
    expect(span).toBe(24 * 60 * 60 * 1000);
  });

  it('targets the trace flag at the user, debug level, and DEVELOPER_LOG', () => {
    const now = Date.parse('2026-06-22T12:00:00.000Z');
    const p = traceFlagCreatePayload('005xx', '7dlxx', now);
    expect(p.TracedEntityId).toBe('005xx');
    expect(p.DebugLevelId).toBe('7dlxx');
    expect(p.LogType).toBe('DEVELOPER_LOG');
    expect(p.StartDate).toBe('2026-06-22T11:59:00.000Z');
  });
});

describe('apex-anonymous — trace-flag/log decisions', () => {
  const now = Date.parse('2026-06-22T12:00:00.000Z');

  it('treats a future-dated flag as active', () => {
    expect(traceFlagIsActive({ ExpirationDate: '2026-06-22T13:00:00.000Z' }, now)).toBe(true);
  });

  it('treats an expired flag as inactive', () => {
    expect(traceFlagIsActive({ ExpirationDate: '2026-06-22T11:00:00.000Z' }, now)).toBe(false);
  });

  it('treats a missing/empty flag as inactive', () => {
    expect(traceFlagIsActive(undefined, now)).toBe(false);
    expect(traceFlagIsActive(null, now)).toBe(false);
    expect(traceFlagIsActive({}, now)).toBe(false);
  });

  it('returns the latest log id only when it differs from the baseline', () => {
    expect(pickNewLogId('07Lnew', '07Lold')).toBe('07Lnew');
    expect(pickNewLogId('07Lsame', '07Lsame')).toBeNull();
    expect(pickNewLogId('07Lfirst', null)).toBe('07Lfirst');
    expect(pickNewLogId(null, '07Lold')).toBeNull();
  });
});
