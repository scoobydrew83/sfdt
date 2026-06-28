import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createOrgLimitsFeature, _orgLimitsTestApi } from '../features/org-limits.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

const { shapeLimits, bandFor } = _orgLimitsTestApi();

function fakeApi(overrides: Partial<SalesforceApiClient> = {}): SalesforceApiClient {
  return {
    limits: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as SalesforceApiClient;
}

function clearBody(): void {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
}

beforeEach(() => {
  clearBody();
});

describe('org-limits — shapeLimits', () => {
  it('computes used + percentage and sorts by descending utilisation', () => {
    const rows = shapeLimits({
      DataStorageMB: { Max: 1024, Remaining: 1000 }, // ~2.3% used
      DailyApiRequests: { Max: 1000, Remaining: 100 }, // 90% used
      FileStorageMB: { Max: 2048, Remaining: 1024 }, // 50% used
    });
    expect(rows.map((r) => r.name)).toEqual([
      'DailyApiRequests',
      'FileStorageMB',
      'DataStorageMB',
    ]);
    expect(rows[0]?.used).toBe(900);
    expect(rows[0]?.pct).toBeCloseTo(0.9, 5);
  });

  it('skips entries missing Max or Remaining', () => {
    const rows = shapeLimits({
      OK: { Max: 10, Remaining: 5 },
      Broken: { Max: 10 } as unknown as { Max: number; Remaining: number },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('OK');
  });

  it('handles a zero-max limit without dividing by zero', () => {
    const rows = shapeLimits({ Zero: { Max: 0, Remaining: 0 } });
    expect(rows[0]?.pct).toBe(0);
  });
});

describe('org-limits — bandFor', () => {
  it('maps utilisation into colour bands', () => {
    expect(bandFor(0)).toBe('green');
    expect(bandFor(0.69)).toBe('green');
    expect(bandFor(0.7)).toBe('amber');
    expect(bandFor(0.89)).toBe('amber');
    expect(bandFor(0.9)).toBe('red');
    expect(bandFor(1)).toBe('red');
  });
});

describe('org-limits — modal', () => {
  function setSalesforceUrl(): void {
    window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/setup/SetupOneHome/home');
  }

  it('renders one card per limit, sorted by utilisation', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      limits: vi.fn(async () => ({
        DataStorageMB: { Max: 1024, Remaining: 1000 },
        DailyApiRequests: { Max: 1000, Remaining: 100 },
      })) as unknown as SalesforceApiClient['limits'],
    });
    const feature = createOrgLimitsFeature({ api });
    await feature.onActivate?.();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(api.limits).toHaveBeenCalled();
    const cards = document.querySelectorAll('.sfdt-view-overlay [style*="grid-template-columns"] > div');
    expect(cards.length).toBeGreaterThanOrEqual(2);
    const body = document.body.textContent ?? '';
    expect(body).toContain('Daily Api Requests');
    expect(body).toContain('Data Storage MB');
  });

  it('shows an error panel when limits() throws', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      limits: vi.fn(async () => {
        throw new Error('boom');
      }) as unknown as SalesforceApiClient['limits'],
    });
    const feature = createOrgLimitsFeature({ api });
    await feature.onActivate?.();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(document.body.textContent).toContain('boom');
  });
});
