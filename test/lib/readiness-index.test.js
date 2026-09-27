import { describe, it, expect, vi } from 'vitest';
import { READINESS_INDEX_DIMENSIONS, READINESS_INDEX_CONTEXT_CHECKS, worstIndexStatus } from '@sfdt/flow-core';
import { CHECK_IDS as AUDIT_IDS } from '../../src/lib/audit-runner.js';
import { CHECK_IDS as MONITOR_IDS } from '../../src/lib/monitor-runner.js';
import { maxStatus } from '../../src/lib/check-status.js';

vi.mock('../../src/lib/audit-runner.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runAudit: vi.fn() };
});
vi.mock('../../src/lib/monitor-runner.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runMonitor: vi.fn() };
});

import { runAudit } from '../../src/lib/audit-runner.js';
import { runMonitor } from '../../src/lib/monitor-runner.js';
import { runIndexEvidence } from '../../src/lib/readiness-index.js';

const claimed = new Set([
  ...READINESS_INDEX_DIMENSIONS.flatMap((d) => d.checks.map((c) => `${c.source}:${c.id}`)),
  ...READINESS_INDEX_CONTEXT_CHECKS.map((c) => `${c.source}:${c.id}`),
]);

describe('AI-Readiness Index ↔ CLI runners', () => {
  // The mapping lives in @sfdt/flow-core; the check registries live here. This
  // is the test that fails when a runner gains a check the Index doesn't place.
  it('every audit check is placed in a dimension', () => {
    expect(AUDIT_IDS.filter((id) => !claimed.has(`audit:${id}`))).toEqual([]);
  });

  it('every monitor check is placed in a dimension or context', () => {
    expect(MONITOR_IDS.filter((id) => !claimed.has(`monitor:${id}`))).toEqual([]);
  });

  it('the Index names no CLI check that no longer exists', () => {
    const known = new Set([...AUDIT_IDS.map((id) => `audit:${id}`), ...MONITOR_IDS.map((id) => `monitor:${id}`), 'monitor:backup']);
    const stale = [...claimed].filter((k) => !k.startsWith('live:') && !known.has(k));
    expect(stale).toEqual([]);
  });

  it('rolls up status in the same order as check-status.maxStatus', () => {
    for (const set of [['ok', 'warn'], ['warn', 'error'], ['error', 'fail'], ['fail', 'ok', 'warn']]) {
      const checks = set.map((status) => ({ status }));
      expect(worstIndexStatus(checks)).toBe(maxStatus(checks));
    }
  });

  it('runIndexEvidence runs both runners with their params and groups the result', async () => {
    runAudit.mockResolvedValue({ org: 'o', checks: [{ id: 'mfa', status: 'fail' }], summary: {} });
    runMonitor.mockResolvedValue({ org: 'o', checks: [], summary: {} });
    const cfg = { monitoring: {} };
    const { evidence } = await runIndexEvidence('o', cfg, { auditParams: { a: 1 }, monitorParams: { m: 1 } });
    expect(runAudit).toHaveBeenCalledWith('o', { params: { a: 1 } });
    expect(runMonitor).toHaveBeenCalledWith('o', cfg, { params: { m: 1 } });
    expect(evidence.dimensions.find((d) => d.id === 'permissions-hygiene').status).toBe('fail');
  });
});
