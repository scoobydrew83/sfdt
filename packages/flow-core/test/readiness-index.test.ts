import { describe, it, expect } from 'vitest';
import {
  READINESS_INDEX_DIMENSIONS,
  READINESS_INDEX_CONTEXT_CHECKS,
  bandToStatus,
  worstIndexStatus,
  buildIndexEvidence,
  renderIndexMarkdown,
} from '../src/readiness-index.js';

// The check ids each runner registers today (src/lib/audit-runner.js CHECKS,
// src/lib/monitor-runner.js CHECKS, extension/features/org-health-checks.ts).
// If a runner gains a check, this list and the Index mapping must both move.
const AUDIT_IDS = [
  'audittrail', 'licenses', 'mfa', 'mfa-readiness', 'soap-logins', 'unused-apex',
  'inactive-users', 'api-versions', 'inactive-flows', 'unused-permsets', 'connected-apps',
  'field-descriptions', 'apex-unreferenced', 'lint-access', 'inactive-validations',
  'inactive-workflows', 'lint-access-fields',
];
const MONITOR_IDS = ['limits', 'errors', 'health', 'org-info', 'deploy-history', 'deprecated-api', 'flow-errors'];
const LIVE_IDS = ['apex-coverage', 'inactive-users', 'license-utilisation', 'apex-api-version', 'org-limits'];

const check = (id: string, status = 'ok') => ({ id, title: id, status, summary: `${id} summary`, findings: [] });

describe('READINESS_INDEX_DIMENSIONS', () => {
  it('has the eight Index dimensions in published order', () => {
    expect(READINESS_INDEX_DIMENSIONS.map((d) => d.title)).toEqual([
      'Automation sprawl',
      'Dependency risk',
      'Documentation coverage',
      'Permissions hygiene',
      'Dead metadata',
      'Data quality',
      'Change safety',
      'AI-groundability',
    ]);
  });

  it('claims every check a runner produces (dimension or context)', () => {
    const claimed = new Set([
      ...READINESS_INDEX_DIMENSIONS.flatMap((d) => d.checks.map((c) => `${c.source}:${c.id}`)),
      ...READINESS_INDEX_CONTEXT_CHECKS.map((c) => `${c.source}:${c.id}`),
    ]);
    const all = [
      ...AUDIT_IDS.map((id) => `audit:${id}`),
      ...MONITOR_IDS.map((id) => `monitor:${id}`),
      ...LIVE_IDS.map((id) => `live:${id}`),
    ];
    expect(all.filter((k) => !claimed.has(k))).toEqual([]);
  });

  it('every dimension tells the assessor what the checks cannot see', () => {
    for (const d of READINESS_INDEX_DIMENSIONS) expect(d.manualNote.length).toBeGreaterThan(20);
  });
});

describe('status helpers', () => {
  it('bandToStatus maps live bands onto CLI statuses', () => {
    expect(bandToStatus('green')).toBe('ok');
    expect(bandToStatus('amber')).toBe('warn');
    expect(bandToStatus('red')).toBe('fail');
    expect(bandToStatus('purple')).toBe('error');
  });

  it('worstIndexStatus orders ok < warn < error < fail (matches src/lib/check-status.js)', () => {
    expect(worstIndexStatus([])).toBe('none');
    expect(worstIndexStatus([{ status: 'ok' }, { status: 'warn' }])).toBe('warn');
    expect(worstIndexStatus([{ status: 'fail' }, { status: 'error' }])).toBe('fail');
    expect(worstIndexStatus([{ status: 'error' }, { status: 'warn' }])).toBe('error');
  });
});

describe('buildIndexEvidence', () => {
  it('groups CLI snapshots under dimensions and rolls up the worst status', () => {
    const ev = buildIndexEvidence({
      audit: { org: 'acme', timestamp: '2026-09-01T00:00:00Z', checks: [check('unused-permsets', 'warn'), check('mfa', 'fail')] },
      monitor: { timestamp: '2026-09-02T00:00:00Z', checks: [check('health'), check('org-info')] },
    });
    const perms = ev.dimensions.find((d) => d.id === 'permissions-hygiene')!;
    expect(perms.status).toBe('fail');
    expect(perms.checks.map((c) => c.id).sort()).toEqual(['health', 'mfa', 'unused-permsets']);
    expect(ev.org).toBe('acme');
    expect(ev.timestamp).toBe('2026-09-02T00:00:00Z');
    expect(ev.context.map((c) => c.id)).toEqual(['org-info']);
    expect(ev.unmapped).toEqual([]);
  });

  it('with only live checks (bridge offline), live checks fill their dimensions', () => {
    const ev = buildIndexEvidence({ live: [check('inactive-users', 'amber'), check('apex-coverage', 'red')] });
    const perms = ev.dimensions.find((d) => d.id === 'permissions-hygiene')!;
    expect(perms.checks).toHaveLength(1);
    expect(perms.checks[0]).toMatchObject({ source: 'live', id: 'inactive-users', status: 'warn' });
    expect(ev.dimensions.find((d) => d.id === 'change-safety')!.status).toBe('fail');
    // CLI refs with no snapshot are reported as not run; superseded live refs are not.
    expect(perms.missing.some((m) => m.source === 'audit' && m.id === 'mfa')).toBe(true);
    expect(perms.missing.some((m) => m.source === 'live')).toBe(false);
  });

  it('prefers the CLI check over its live twin when both ran', () => {
    const ev = buildIndexEvidence({
      audit: { checks: [check('inactive-users', 'warn')] },
      live: [check('inactive-users', 'green')],
    });
    const perms = ev.dimensions.find((d) => d.id === 'permissions-hygiene')!;
    expect(perms.checks.filter((c) => c.id === 'inactive-users')).toEqual([
      expect.objectContaining({ source: 'audit', status: 'warn' }),
    ]);
  });

  it('reports a check no dimension claims instead of dropping it', () => {
    const ev = buildIndexEvidence({ audit: { checks: [check('brand-new-check', 'warn')] } });
    expect(ev.unmapped.map((c) => c.id)).toEqual(['brand-new-check']);
  });

  it('Data quality has no automated evidence', () => {
    const ev = buildIndexEvidence({ audit: { checks: AUDIT_IDS.map((id) => check(id)) } });
    expect(ev.dimensions.find((d) => d.id === 'data-quality')!.status).toBe('none');
  });

  it('carries no numeric score anywhere (the Index is scored by a person)', () => {
    const ev = buildIndexEvidence({ audit: { checks: AUDIT_IDS.map((id) => check(id)) } });
    expect(JSON.stringify(ev)).not.toMatch(/"score"|"index"\s*:\s*\d/i);
  });

  it('tolerates null / partial inputs', () => {
    const ev = buildIndexEvidence({ audit: null, monitor: { checks: undefined }, live: null });
    expect(ev.dimensions).toHaveLength(8);
    expect(ev.dimensions.every((d) => d.status === 'none')).toBe(true);
  });
});

describe('renderIndexMarkdown', () => {
  it('renders one section per dimension, caps findings, and names the manual part', () => {
    const findings = Array.from({ length: 12 }, (_, i) => `user${i}`);
    const md = renderIndexMarkdown(
      buildIndexEvidence({
        audit: { org: 'acme', checks: [{ ...check('inactive-users', 'warn'), findings }] },
      }),
      { maxFindings: 3 },
    );
    expect(md).toContain('# AI-Readiness Index — evidence pack');
    expect(md).toContain('- Org: acme');
    expect(md).toContain('## Permissions hygiene — WARN');
    expect(md).toContain('## Data quality — NO DATA');
    expect(md).toContain('  - user2');
    expect(md).not.toContain('  - user3');
    expect(md).toContain('… and 9 more');
    expect(md).toContain('Assessor: Not measured by sfdt.');
  });
});
