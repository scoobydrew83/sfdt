import { describe, it, expect } from 'vitest';
import { describeFinding } from '../src/health-findings.js';

describe('flow-core/health-findings', () => {
  describe('describeFinding', () => {
    it('renders a deprecated API-version finding with its type prefix', () => {
      expect(
        describeFinding({ type: 'ApexClass', name: 'AcctService', apiVersion: '40.0' }),
      ).toBe('ApexClass AcctService (API 40.0)');
    });

    it('omits the type prefix when no type is present', () => {
      expect(describeFinding({ name: 'AcctService', apiVersion: 41 })).toBe(
        'AcctService (API 41)',
      );
    });

    it('renders an inactive/MFA user with name, username and last login', () => {
      expect(
        describeFinding({ username: 'jo@x.com', name: 'Jo Bloggs', lastLogin: '2026-06-01' }),
      ).toBe('Jo Bloggs <jo@x.com> — last login 2026-06-01');
    });

    it('falls back to the username when no display name is present', () => {
      expect(describeFinding({ username: 'jo@x.com' })).toBe('jo@x.com <jo@x.com>');
    });

    it('renders a setup audit-trail entry', () => {
      expect(
        describeFinding({ date: '2026-06-01', action: 'changedProfile', section: 'Manage Users', user: 'admin' }),
      ).toBe('2026-06-01: changedProfile (Manage Users) by admin');
    });

    it('renders a failed async Apex job, with and without an extended status', () => {
      expect(
        describeFinding({ date: '2026-06-01', job: 'NightlyBatch', type: 'BatchApex', errors: 3 }),
      ).toBe('2026-06-01: NightlyBatch (BatchApex) — 3 error(s)');
      expect(
        describeFinding({
          date: '2026-06-01',
          job: 'NightlyBatch',
          type: 'BatchApex',
          errors: 3,
          status: 'First error: boom',
        }),
      ).toBe('2026-06-01: NightlyBatch (BatchApex) — 3 error(s) — First error: boom');
    });

    it('renders license usage (total denominator) without a ratio', () => {
      expect(describeFinding({ name: 'Salesforce', used: 90, total: 100 })).toBe(
        'Salesforce: 90/100',
      );
    });

    it('renders governor-limit usage (max denominator) with a rounded ratio percentage', () => {
      expect(
        describeFinding({ name: 'DailyApiRequests', used: 4500, max: 5000, ratio: 0.9 }),
      ).toBe('DailyApiRequests: 4500/5000 (90%)');
    });

    it('renders a security health-check score', () => {
      expect(describeFinding({ score: 85, floor: 90 })).toBe('score 85% (floor 90%)');
    });

    it('renders a backup batch error', () => {
      expect(describeFinding({ error: 'row lock contention' })).toBe('row lock contention');
    });

    it('renders a bare name finding', () => {
      expect(describeFinding({ name: 'SomeThing' })).toBe('SomeThing');
    });

    it('falls back to JSON for an unrecognised shape', () => {
      expect(describeFinding({ foo: 'bar' })).toBe('{"foo":"bar"}');
    });
  });
});
