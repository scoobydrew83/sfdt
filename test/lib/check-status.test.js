import { describe, it, expect } from 'vitest';
import { STATUS_RANK, rankStatus, maxStatus, meetsThreshold } from '../../src/lib/check-status.js';

describe('check-status', () => {
  it('ranks fail above error above warn above ok', () => {
    expect(STATUS_RANK.fail).toBeGreaterThan(STATUS_RANK.error);
    expect(STATUS_RANK.error).toBeGreaterThan(STATUS_RANK.warn);
    expect(STATUS_RANK.warn).toBeGreaterThan(STATUS_RANK.ok);
  });

  it('rankStatus treats unknown status as ok', () => {
    expect(rankStatus('nonsense')).toBe(0);
    expect(rankStatus(undefined)).toBe(0);
  });

  it('maxStatus returns ok for empty or missing input', () => {
    expect(maxStatus([])).toBe('ok');
    expect(maxStatus(null)).toBe('ok');
    expect(maxStatus(undefined)).toBe('ok');
  });

  it('maxStatus finds the worst status across check objects', () => {
    expect(maxStatus([{ status: 'ok' }, { status: 'warn' }, { status: 'ok' }])).toBe('warn');
    expect(maxStatus([{ status: 'warn' }, { status: 'fail' }, { status: 'error' }])).toBe('fail');
    expect(maxStatus([{ status: 'ok' }, { status: 'error' }])).toBe('error');
  });

  it('maxStatus accepts raw status strings', () => {
    expect(maxStatus(['ok', 'warn', 'fail'])).toBe('fail');
  });

  it('maxStatus ignores malformed statuses', () => {
    expect(maxStatus([{ status: 'bogus' }, { status: 'warn' }])).toBe('warn');
    expect(maxStatus([{}, { status: 'ok' }])).toBe('ok');
  });

  it('meetsThreshold is inclusive at the boundary', () => {
    expect(meetsThreshold('warn', 'warn')).toBe(true);
    expect(meetsThreshold('fail', 'warn')).toBe(true);
    expect(meetsThreshold('ok', 'warn')).toBe(false);
    expect(meetsThreshold('warn', 'fail')).toBe(false);
  });
});
