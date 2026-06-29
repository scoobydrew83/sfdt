import { describe, it, expect } from 'vitest';
import {
  makeErrorResponse,
  makeSuccessResponse,
  validateSfdtRequest,
} from '../src/bridge-contract.js';

describe('flow-core/bridge-contract', () => {
  describe('validateSfdtRequest — common envelope', () => {
    it('rejects non-objects', () => {
      const result = validateSfdtRequest(null);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0]!.field).toBe('(root)');
    });

    it('rejects missing requestId', () => {
      const result = validateSfdtRequest({ kind: 'ping' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.some((e) => e.field === 'requestId')).toBe(true);
    });

    it('rejects unknown kind', () => {
      const result = validateSfdtRequest({ requestId: 'r1', kind: 'totallymadeup' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0]!.field).toBe('kind');
    });
  });

  describe('validateSfdtRequest — per-kind', () => {
    it('ping needs only requestId and kind', () => {
      const result = validateSfdtRequest({ requestId: 'r1', kind: 'ping' });
      expect(result.ok).toBe(true);
    });

    it('deploy requires flowId', () => {
      expect(validateSfdtRequest({ requestId: 'r1', kind: 'deploy' }).ok).toBe(false);
      expect(validateSfdtRequest({ requestId: 'r1', kind: 'deploy', flowId: '301AB' }).ok).toBe(true);
    });

    it('rollback requires a flow identifier and a non-negative integer toVersion', () => {
      // No identifier at all
      expect(
        validateSfdtRequest({ requestId: 'r1', kind: 'rollback', toVersion: 1 }).ok,
      ).toBe(false);
      // Identifier present but no toVersion
      expect(
        validateSfdtRequest({ requestId: 'r1', kind: 'rollback', flowApiName: 'My_Flow' }).ok,
      ).toBe(false);
      // Negative toVersion
      expect(
        validateSfdtRequest({
          requestId: 'r1',
          kind: 'rollback',
          flowApiName: 'My_Flow',
          toVersion: -1,
        }).ok,
      ).toBe(false);
      // Non-integer
      expect(
        validateSfdtRequest({
          requestId: 'r1',
          kind: 'rollback',
          flowApiName: 'My_Flow',
          toVersion: 1.5,
        }).ok,
      ).toBe(false);
      // toVersion=0 is now the documented way to deactivate
      expect(
        validateSfdtRequest({
          requestId: 'r1',
          kind: 'rollback',
          flowApiName: 'My_Flow',
          toVersion: 0,
        }).ok,
      ).toBe(true);
      // Legacy callers passing flowId still work
      expect(
        validateSfdtRequest({
          requestId: 'r1',
          kind: 'rollback',
          flowId: '301AB',
          toVersion: 3,
        }).ok,
      ).toBe(true);
      // New canonical shape
      expect(
        validateSfdtRequest({
          requestId: 'r1',
          kind: 'rollback',
          flowApiName: 'My_Flow',
          toVersion: 3,
        }).ok,
      ).toBe(true);
    });

    it('quality requires a non-empty flowXml', () => {
      expect(validateSfdtRequest({ requestId: 'r1', kind: 'quality' }).ok).toBe(false);
      expect(validateSfdtRequest({ requestId: 'r1', kind: 'quality', flowXml: '<Flow/>' }).ok).toBe(
        true,
      );
    });

    it('ai requires a prompt string and accepts optional context object', () => {
      expect(validateSfdtRequest({ requestId: 'r1', kind: 'ai' }).ok).toBe(false);
      expect(validateSfdtRequest({ requestId: 'r1', kind: 'ai', prompt: 'hi' }).ok).toBe(true);
      expect(
        validateSfdtRequest({ requestId: 'r1', kind: 'ai', prompt: 'hi', context: { x: 1 } }).ok,
      ).toBe(true);
      expect(
        validateSfdtRequest({ requestId: 'r1', kind: 'ai', prompt: 'hi', context: 'not obj' }).ok,
      ).toBe(false);
    });

    it("scan restricts scanType to 'scheduled' | 'all'", () => {
      expect(
        validateSfdtRequest({ requestId: 'r1', kind: 'scan', scanType: 'scheduled' }).ok,
      ).toBe(true);
      expect(validateSfdtRequest({ requestId: 'r1', kind: 'scan', scanType: 'all' }).ok).toBe(true);
      expect(
        validateSfdtRequest({ requestId: 'r1', kind: 'scan', scanType: 'anything' }).ok,
      ).toBe(false);
    });

    it('compare requires both left and right', () => {
      expect(
        validateSfdtRequest({ requestId: 'r1', kind: 'compare', left: 'a' }).ok,
      ).toBe(false);
      expect(
        validateSfdtRequest({ requestId: 'r1', kind: 'compare', left: 'a', right: 'b' }).ok,
      ).toBe(true);
    });

    it('org-health needs only the envelope (no extra fields)', () => {
      expect(validateSfdtRequest({ requestId: 'r1', kind: 'org-health' }).ok).toBe(true);
    });

    it('rejects a requestId longer than 256 characters', () => {
      const result = validateSfdtRequest({
        requestId: 'a'.repeat(257),
        kind: 'ping',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.some((e) => e.field === 'requestId')).toBe(true);
    });

    it('accepts a requestId of exactly 256 characters', () => {
      const result = validateSfdtRequest({
        requestId: 'a'.repeat(256),
        kind: 'ping',
      });
      expect(result.ok).toBe(true);
    });

    it('rejects telemetry.snapshot with more than 500 counter keys', () => {
      const counters: Record<string, { activated: number; errored: number; disabled_remote: number }> = {};
      for (let i = 0; i < 501; i++) {
        counters[`feat_${i}`] = { activated: 0, errored: 0, disabled_remote: 0 };
      }
      const result = validateSfdtRequest({
        requestId: 'r1',
        kind: 'telemetry.snapshot',
        monthKey: '2026-05',
        counters,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.some((e) => e.field === 'counters')).toBe(true);
    });

    it('accepts telemetry.snapshot with at most 500 counter keys', () => {
      const counters: Record<string, { activated: number; errored: number; disabled_remote: number }> = {};
      for (let i = 0; i < 500; i++) {
        counters[`feat_${i}`] = { activated: 0, errored: 0, disabled_remote: 0 };
      }
      const result = validateSfdtRequest({
        requestId: 'r1',
        kind: 'telemetry.snapshot',
        monthKey: '2026-05',
        counters,
      });
      expect(result.ok).toBe(true);
    });

    it('aggregates multiple errors in one response', () => {
      const result = validateSfdtRequest({ requestId: '', kind: 'rollback', toVersion: -1 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const fields = result.errors.map((e) => e.field);
        expect(fields).toContain('requestId');
        // Either flowApiName or flowId must be present — validator surfaces
        // the canonical name in its error message.
        expect(fields).toContain('flowApiName');
        expect(fields).toContain('toVersion');
      }
    });
  });

  describe('validateSfdtRequest — field-level validation', () => {
    it('deploy: accepts a valid targetOrg and rejects bad ones', () => {
      expect(
        validateSfdtRequest({ requestId: 'r1', kind: 'deploy', flowApiName: 'My_Flow', targetOrg: 'my-org@example' }).ok,
      ).toBe(true);
      const bad = validateSfdtRequest({
        requestId: 'r1',
        kind: 'deploy',
        flowApiName: 'My_Flow',
        targetOrg: '--inject',
      });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.errors.some((e) => e.field === 'targetOrg')).toBe(true);
    });

    it('deploy: rejects a malformed flowApiName, a blank flowId, and a non-boolean validateOnly', () => {
      const result = validateSfdtRequest({
        requestId: 'r1',
        kind: 'deploy',
        flowApiName: '1bad', // starts with a digit
        flowId: '', // present but empty
        validateOnly: 'yes', // not a boolean
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const fields = result.errors.map((e) => e.field);
        expect(fields).toContain('flowApiName');
        expect(fields).toContain('flowId');
        expect(fields).toContain('validateOnly');
      }
    });

    it('rollback: rejects a malformed flowApiName and a bad targetOrg', () => {
      const result = validateSfdtRequest({
        requestId: 'r1',
        kind: 'rollback',
        flowApiName: '9nope',
        toVersion: 2,
        targetOrg: 'has space',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const fields = result.errors.map((e) => e.field);
        expect(fields).toContain('flowApiName');
        expect(fields).toContain('targetOrg');
      }
    });

    it('drift: requires a non-empty component', () => {
      const result = validateSfdtRequest({ requestId: 'r1', kind: 'drift' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0]!.field).toBe('component');
      expect(validateSfdtRequest({ requestId: 'r1', kind: 'drift', component: 'Acct_Flow' }).ok).toBe(true);
    });

    it('compare: surfaces a missing left when only right is given', () => {
      const result = validateSfdtRequest({ requestId: 'r1', kind: 'compare', right: 'b' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.some((e) => e.field === 'left')).toBe(true);
    });

    it('telemetry.snapshot: rejects a missing monthKey', () => {
      const result = validateSfdtRequest({
        requestId: 'r1',
        kind: 'telemetry.snapshot',
        counters: {},
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.some((e) => e.field === 'monthKey')).toBe(true);
    });

    it('telemetry.snapshot: rejects a monthKey in the wrong format and a non-object counters', () => {
      const result = validateSfdtRequest({
        requestId: 'r1',
        kind: 'telemetry.snapshot',
        monthKey: '2026/05',
        counters: 'nope',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const fields = result.errors.map((e) => e.field);
        expect(fields).toContain('monthKey');
        expect(fields).toContain('counters');
      }
    });

    it('telemetry.snapshot: rejects a non-object counter and a non-numeric counter field', () => {
      const result = validateSfdtRequest({
        requestId: 'r1',
        kind: 'telemetry.snapshot',
        monthKey: '2026-05',
        counters: {
          good: { activated: 1, errored: 0, disabled_remote: 0 },
          notObject: 5,
          badField: { activated: 'x', errored: 0, disabled_remote: 0 },
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const fields = result.errors.map((e) => e.field);
        expect(fields).toContain('counters.notObject');
        expect(fields).toContain('counters.badField.activated');
      }
    });

    it('telemetry.snapshot: accepts a well-formed payload', () => {
      const result = validateSfdtRequest({
        requestId: 'r1',
        kind: 'telemetry.snapshot',
        monthKey: '2026-05',
        counters: { feat_a: { activated: 3, errored: 1, disabled_remote: 0 } },
      });
      expect(result.ok).toBe(true);
    });
  });

  describe('response helpers', () => {
    it('makeSuccessResponse echoes the requestId', () => {
      expect(makeSuccessResponse('r1', { pong: true, serverVersion: '0.8.1', transport: 'localhost' })).toEqual({
        ok: true,
        requestId: 'r1',
        data: { pong: true, serverVersion: '0.8.1', transport: 'localhost' },
      });
    });

    it('makeErrorResponse omits code when not supplied', () => {
      const resp = makeErrorResponse('r2', 'something bad');
      expect(resp).toEqual({ ok: false, requestId: 'r2', error: 'something bad' });
      expect('code' in resp).toBe(false);
    });

    it('makeErrorResponse includes code when supplied', () => {
      const resp = makeErrorResponse('r3', 'no token', 'BRIDGE_UNAUTHORIZED');
      expect(resp).toEqual({
        ok: false,
        requestId: 'r3',
        error: 'no token',
        code: 'BRIDGE_UNAUTHORIZED',
      });
    });
  });
});
