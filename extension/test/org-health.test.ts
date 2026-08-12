import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createOrgHealthFeature, bandFor, shapeChecks } from '../features/org-health.js';
import { describeFinding } from '@sfdt/flow-core';
import type { SfdtResponse } from '@sfdt/flow-core/bridge-contract';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';
import { SFDT_COMPONENT_CSS } from '../lib/ui-styles.js';

// Read out of the sheet, not listed here — see the same derivation in
// test/error-render-newlines.test.ts and test/org-health-checks.test.ts.
const WHITE_SPACE_CLASSES: ReadonlySet<string> = (() => {
  const out = new Set<string>();
  for (const rule of SFDT_COMPONENT_CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/white-space:\s*(?:pre|pre-line|pre-wrap)\b/.test(rule[2]!)) continue;
    for (const sel of rule[1]!.matchAll(/\.(sfdt-[\w-]+)/g)) out.add(sel[1]!);
  }
  return out;
})();

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

// Org Health now ALWAYS runs the five in-browser checks before reaching for the
// bridge, so every test needs a Salesforce client — without one the real client
// is used and the panel hangs waiting on it.
function fakeLiveApi(): SalesforceApiClient {
  return {
    toolingQuery: vi.fn(async () => ({ records: [], size: 0, done: true })),
    query: vi.fn(async () => ({ records: [], size: 0, done: true })),
    apiGet: vi.fn(async () => ({})),
    limits: vi.fn(async () => ({})),
  } as unknown as SalesforceApiClient;
}

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
    const feature = createOrgHealthFeature({ bridgeFactory: async () => bridge, api: fakeLiveApi() });
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
    const feature = createOrgHealthFeature({ bridgeFactory: async () => bridge, api: fakeLiveApi() });
    await feature.onActivate?.();
    await vi.waitFor(() => expect(document.body.textContent).toContain('bridge offline'));

    const body = document.body.textContent ?? '';
    expect(body).toContain('bridge offline');
    expect(body).toContain('sfdt ui');
  });

  it('keeps a snapshot summary on two lines when the CLI reports a two-line failure', async () => {
    // The same field, the same span, the same missing rule as the live rows in
    // org-health-checks.ts — these ones just arrive from the CLI snapshot
    // instead of from a settled rejection. `sfdt audit` reports a failed check
    // by putting the error text in `summary`, and a Salesforce error has been
    // two lines since lib/sf-error-guidance.ts. Fixing only the live half would
    // have left the identical bug one function away, which is the shape this
    // line of work keeps shipping.
    setSalesforceUrl();
    const bridge = fakeBridge({
      ok: true,
      requestId: 'r1',
      data: {
        audit: {
          timestamp: 't',
          data: {
            org: 'dev',
            checks: [
              {
                id: 'mfa',
                title: 'MFA coverage',
                status: 'error',
                summary:
                  'INVALID_SESSION_ID: Session expired or invalid\nLog in again, then re-run the check.',
                findings: [],
              },
            ],
          },
        },
        monitor: null,
      },
    });
    const feature = createOrgHealthFeature({
      bridgeFactory: async () => bridge,
      api: fakeLiveApi(),
    });
    await feature.onActivate?.();
    await vi.waitFor(() => expect(document.body.textContent).toContain('INVALID_SESSION_ID'));

    const summary = [...document.querySelectorAll('span')].find((el) =>
      (el.textContent ?? '').startsWith('INVALID_SESSION_ID'),
    );
    expect(summary, 'the failed check must render a summary').toBeDefined();
    expect(summary!.textContent).toContain('\nLog in again');
    expect(
      [...summary!.classList].some((c) => WHITE_SPACE_CLASSES.has(c)),
      `the summary renders a multi-line failure but wears only [${[...summary!.classList].join(', ')}]`,
    ).toBe(true);
  });

  it('shows an empty hint when a snapshot has no checks', async () => {
    setSalesforceUrl();
    const bridge = fakeBridge({ ok: true, requestId: 'r1', data: { audit: null, monitor: null } });
    const feature = createOrgHealthFeature({ bridgeFactory: async () => bridge, api: fakeLiveApi() });
    await feature.onActivate?.();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Run `sfdt'));

    expect(document.body.textContent).toContain('Run `sfdt');
  });
});
