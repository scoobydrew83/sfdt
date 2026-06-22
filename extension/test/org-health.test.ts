import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createOrgHealthFeature, bandFor, shapeChecks } from '../features/org-health.js';
import { describeFinding } from '@sfdt/flow-core';
import type { SfdtResponse } from '@sfdt/flow-core/bridge-contract';

function clearBody(): void {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
}

function setSalesforceUrl(): void {
  window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/setup/SetupOneHome/home');
}

function fakeBridge(response: SfdtResponse) {
  return { call: vi.fn(async () => response) };
}

beforeEach(() => clearBody());

describe('org-health — pure helpers', () => {
  it('bandFor maps check status to colour bands', () => {
    expect(bandFor('ok')).toBe('green');
    expect(bandFor('warn')).toBe('amber');
    expect(bandFor('fail')).toBe('red');
    expect(bandFor('error')).toBe('red');
    expect(bandFor('whatever')).toBe('grey');
  });

  it('describeFinding renders the common finding shapes', () => {
    expect(describeFinding({ username: 'a@x.com', name: 'A' })).toContain('a@x.com');
    expect(describeFinding({ name: 'OldClass', apiVersion: 30, type: 'ApexClass' })).toContain('API 30');
    expect(describeFinding({ name: 'DailyApiRequests', used: 95, max: 100 })).toBe('DailyApiRequests: 95/100');
    expect(describeFinding({ action: 'deactivateuser', section: 'Users', user: 'Admin', date: 'd' })).toContain('deactivateuser');
  });

  it('shapeChecks tolerates null and partial snapshots', () => {
    expect(shapeChecks(null)).toEqual([]);
    expect(shapeChecks({ checks: [{ id: 'mfa' }] } as never)[0]).toMatchObject({ id: 'mfa', status: 'ok', findings: [] });
  });
});

describe('org-health — modal', () => {
  it('requests org-health from the bridge and renders both sections', async () => {
    setSalesforceUrl();
    const bridge = fakeBridge({
      ok: true,
      requestId: 'r1',
      data: {
        audit: {
          timestamp: 't',
          data: { org: 'dev', checks: [{ id: 'mfa', title: 'MFA coverage', status: 'warn', summary: '2 users', findings: [{ username: 'a@x.com', name: 'A' }] }] },
        },
        monitor: {
          timestamp: 't',
          data: { org: 'dev', checks: [{ id: 'limits', title: 'Org limits', status: 'ok', summary: 'fine', findings: [] }] },
        },
      },
    });
    const feature = createOrgHealthFeature({ bridgeFactory: async () => bridge });
    await feature.onActivate?.();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Diagnostics & Audit'));

    expect(bridge.call).toHaveBeenCalledWith({ kind: 'org-health' });
    const body = document.body.textContent ?? '';
    expect(body).toContain('Diagnostics & Audit');
    expect(body).toContain('Monitoring');
    expect(body).toContain('MFA coverage');
    expect(body).toContain('a@x.com');
    expect(body).toContain('Org limits');
  });

  it('shows an error panel with a hint when the bridge is offline', async () => {
    setSalesforceUrl();
    const bridge = fakeBridge({ ok: false, requestId: 'r1', error: 'bridge offline', code: 'BRIDGE_OFFLINE' });
    const feature = createOrgHealthFeature({ bridgeFactory: async () => bridge });
    await feature.onActivate?.();
    await vi.waitFor(() => expect(document.body.textContent).toContain('bridge offline'));

    const body = document.body.textContent ?? '';
    expect(body).toContain('bridge offline');
    expect(body).toContain('sfdt ui');
  });

  it('shows an empty hint when a snapshot has no checks', async () => {
    setSalesforceUrl();
    const bridge = fakeBridge({ ok: true, requestId: 'r1', data: { audit: null, monitor: null } });
    const feature = createOrgHealthFeature({ bridgeFactory: async () => bridge });
    await feature.onActivate?.();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Run `sfdt'));

    expect(document.body.textContent).toContain('Run `sfdt');
  });
});
