// lib/trace-flag.ts holds a Salesforce PLATFORM constraint that used to live in
// two features byte-identically. The 24h cap is the org's rule, not ours; these
// tests are what stops a change to it landing in one file and not the other.

import { describe, it, expect } from 'vitest';
import {
  traceFlagWindow,
  traceFlagCreatePayload,
  renewTraceFlagPayload,
  traceFlagIsActive,
  TRACE_FLAG_DURATION_MS,
  TRACE_FLAG_START_BUFFER_MS,
} from '../lib/trace-flag.js';

const NOW = Date.parse('2026-08-03T12:00:00.000Z');

describe('traceFlagWindow()', () => {
  it('back-dates the start so a fast browser clock cannot land it in the future', () => {
    // Client and server clocks disagree by seconds. Without the buffer the org
    // rejects the create, intermittently, and it reads as a permissions problem.
    const w = traceFlagWindow(NOW);
    expect(Date.parse(w.StartDate)).toBe(NOW - TRACE_FLAG_START_BUFFER_MS);
    expect(TRACE_FLAG_START_BUFFER_MS).toBe(60_000);
  });

  it('spans exactly the 24h Salesforce allows, measured from the START', () => {
    // Not from `now` — from the back-dated start. Measuring from `now` would put
    // the window a minute over the cap and Salesforce rejects it outright.
    const w = traceFlagWindow(NOW);
    const span = Date.parse(w.ExpirationDate) - Date.parse(w.StartDate);
    expect(span).toBe(TRACE_FLAG_DURATION_MS);
    expect(TRACE_FLAG_DURATION_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('emits ISO strings, which is what the Tooling API accepts', () => {
    const w = traceFlagWindow(NOW);
    expect(w.StartDate).toBe('2026-08-03T11:59:00.000Z');
    expect(w.ExpirationDate).toBe('2026-08-04T11:59:00.000Z');
  });
});

describe('traceFlagCreatePayload()', () => {
  it('describes a DEVELOPER_LOG flag against the traced entity', () => {
    const body = traceFlagCreatePayload('005xx0000012345', '7dlxx0000000001', NOW);
    expect(body).toEqual({
      TracedEntityId: '005xx0000012345',
      DebugLevelId: '7dlxx0000000001',
      LogType: 'DEVELOPER_LOG',
      StartDate: '2026-08-03T11:59:00.000Z',
      ExpirationDate: '2026-08-04T11:59:00.000Z',
    });
  });
});

describe('renewTraceFlagPayload()', () => {
  it('moves BOTH dates forward, not just the expiration', () => {
    // The obvious implementation — extend ExpirationDate, leave StartDate — is
    // the one that breaks: against a start that is already hours old the window
    // exceeds 24h and the update is rejected. Renewing an 8-hour-old flag is the
    // case that proves it.
    const eightHoursOn = NOW + 8 * 60 * 60 * 1000;
    const renewed = renewTraceFlagPayload(eightHoursOn);
    const span = Date.parse(renewed.ExpirationDate) - Date.parse(renewed.StartDate);
    expect(span).toBe(TRACE_FLAG_DURATION_MS);
    expect(Date.parse(renewed.StartDate)).toBeGreaterThan(Date.parse(traceFlagWindow(NOW).StartDate));
  });
});

describe('traceFlagIsActive()', () => {
  it('is true only while the expiration is still ahead', () => {
    expect(traceFlagIsActive({ ExpirationDate: '2026-08-04T11:59:00.000Z' }, NOW)).toBe(true);
    expect(traceFlagIsActive({ ExpirationDate: '2026-08-02T11:59:00.000Z' }, NOW)).toBe(false);
  });

  it('reports NOT active for a missing or unparseable date', () => {
    // Deliberately the safe direction: the caller's next move is to create a
    // flag, and a spurious "active" leaves the user with no logs and no
    // explanation for why.
    expect(traceFlagIsActive(undefined, NOW)).toBe(false);
    expect(traceFlagIsActive(null, NOW)).toBe(false);
    expect(traceFlagIsActive({}, NOW)).toBe(false);
    expect(traceFlagIsActive({ ExpirationDate: 'not a date' }, NOW)).toBe(false);
  });
});
