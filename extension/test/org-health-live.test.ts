import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createOrgHealthLiveFeature,
  _orgHealthLiveTestApi,
  type OrgHealthLiveOptions,
} from '../features/org-health-live.js';
import { setWorkspaceViewSink } from '../ui/present-view.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

const {
  coverageBand,
  usageBand,
  worstBand,
  inactiveBand,
  summariseCoverage,
  summariseInactiveUsers,
  summariseLicenses,
  summariseApiVersions,
  summariseLimits,
} = _orgHealthLiveTestApi();

function clearBody(): void {
  document.body.innerHTML = '';
  setWorkspaceViewSink(null);
  window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/setup/SetupOneHome/home');
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const envelope = (records: unknown[]) => ({ records, size: records.length, totalSize: records.length, done: true });

function fakeApi(overrides: Record<string, unknown> = {}): OrgHealthLiveOptions['api'] {
  return {
    toolingQuery: vi.fn(async () => envelope([])),
    query: vi.fn(async () => envelope([])),
    limits: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as SalesforceApiClient;
}

// ---------------------------------------------------------------------------
// Pure summarisers
// ---------------------------------------------------------------------------

describe('bands', () => {
  it('coverageBand: red <75, amber 75–90, green ≥90', () => {
    expect(coverageBand(60)).toBe('red');
    expect(coverageBand(75)).toBe('amber');
    expect(coverageBand(89)).toBe('amber');
    expect(coverageBand(90)).toBe('green');
  });

  it('usageBand: green <75%, amber ≥75%, red ≥90%', () => {
    expect(usageBand(0.5)).toBe('green');
    expect(usageBand(0.75)).toBe('amber');
    expect(usageBand(0.9)).toBe('red');
  });

  it('worstBand: any red wins, then amber, else green', () => {
    expect(worstBand(['green', 'amber', 'red'])).toBe('red');
    expect(worstBand(['green', 'amber'])).toBe('amber');
    expect(worstBand(['green', 'green'])).toBe('green');
    expect(worstBand([])).toBe('green');
  });

  it('inactiveBand: 0 green, <10 amber, ≥10 red', () => {
    expect(inactiveBand(0)).toBe('green');
    expect(inactiveBand(9)).toBe('amber');
    expect(inactiveBand(10)).toBe('red');
  });
});

describe('summariseCoverage', () => {
  it('reports org-wide pct and band', () => {
    expect(summariseCoverage([{ PercentCovered: 82 }]).status).toBe('amber');
    expect(summariseCoverage([{ PercentCovered: 82 }]).summary).toContain('82%');
    expect(summariseCoverage([{ PercentCovered: 95 }]).findings).toEqual([]);
  });

  it('treats missing data as amber', () => {
    const out = summariseCoverage([]);
    expect(out.status).toBe('amber');
    expect(out.summary).toContain('No coverage data');
  });
});

describe('summariseInactiveUsers', () => {
  it('green with no rows', () => {
    expect(summariseInactiveUsers([]).status).toBe('green');
  });

  it('lists user names as findings, amber under 10', () => {
    const out = summariseInactiveUsers([
      { Name: 'Old Bot', LastLoginDate: null },
      { Name: 'Jane Doe', LastLoginDate: '2019-05-10T00:00:00Z' },
    ]);
    expect(out.status).toBe('amber');
    expect(out.findings[0]!).toContain('Old Bot');
    expect(out.findings[0]!).toContain('never');
    expect(out.findings[1]!).toContain('Jane Doe');
  });
});

describe('summariseLicenses', () => {
  it('flags types at/over thresholds and ignores unlimited (-1)', () => {
    const out = summariseLicenses([
      { Name: 'Salesforce', TotalLicenses: 100, UsedLicenses: 95 }, // red
      { Name: 'Chatter', TotalLicenses: 100, UsedLicenses: 80 }, // amber
      { Name: 'Identity', TotalLicenses: 100, UsedLicenses: 10 }, // green
      { Name: 'Unlimited', TotalLicenses: -1, UsedLicenses: 5 }, // skipped
    ]);
    expect(out.status).toBe('red');
    expect(out.summary).toContain('2 of 3');
    expect(out.findings).toHaveLength(3);
    expect(out.findings[0]!).toContain('Salesforce: 95/100 (95%)');
  });

  it('green when all under 75%', () => {
    const out = summariseLicenses([{ Name: 'Identity', TotalLicenses: 100, UsedLicenses: 10 }]);
    expect(out.status).toBe('green');
    expect(out.summary).toContain('under 75%');
  });
});

describe('summariseApiVersions', () => {
  it('buckets versions and flags those far behind the max', () => {
    const out = summariseApiVersions([
      { ApiVersion: 62 },
      { ApiVersion: 62 },
      { ApiVersion: 40 }, // 22 behind → lagging
      { ApiVersion: 40 },
    ]);
    expect(out.status).toBe('amber');
    expect(out.findings[0]!).toBe('2 classes on v40 (newest v62)');
    expect(out.summary).toContain('newest v62');
  });

  it('green when all versions are recent', () => {
    expect(summariseApiVersions([{ ApiVersion: 62 }, { ApiVersion: 60 }]).status).toBe('green');
  });

  it('green with no classes', () => {
    expect(summariseApiVersions([]).status).toBe('green');
  });
});

describe('summariseLimits', () => {
  it('flags limits near cap, ignores zero-max', () => {
    const out = summariseLimits({
      DailyApiRequests: { Max: 100, Remaining: 5 }, // 95% red
      DataStorageMB: { Max: 100, Remaining: 20 }, // 80% amber
      Quiet: { Max: 100, Remaining: 100 }, // 0% green
      Bogus: { Max: 0, Remaining: 0 }, // skipped
    });
    expect(out.status).toBe('red');
    expect(out.summary).toContain('2 of 3');
    expect(out.findings[0]!).toContain('DailyApiRequests: 95/100 (95%)'); // worst first
  });
});

// ---------------------------------------------------------------------------
// Feature wiring
// ---------------------------------------------------------------------------

describe('org-health-live feature', () => {
  beforeEach(clearBody);

  it('runs all checks and renders dot+title rows', async () => {
    const toolingQuery = vi.fn(async (soql: string) => {
      if (soql.includes('ApexOrgWideCoverage')) return envelope([{ PercentCovered: 95 }]);
      if (soql.includes('ApexClass')) return envelope([{ ApiVersion: 62 }]);
      return envelope([]);
    });
    const query = vi.fn(async (soql: string) => {
      if (soql.includes('UserLicense')) return envelope([{ Name: 'Salesforce', TotalLicenses: 100, UsedLicenses: 10 }]);
      return envelope([]); // no inactive users
    });
    const limits = vi.fn(async () => ({ DailyApiRequests: { Max: 100, Remaining: 90 } }));
    const feature = createOrgHealthLiveFeature({ api: fakeApi({ toolingQuery, query, limits }) });
    await feature.onActivate?.();
    await flush();

    expect(toolingQuery).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(2);
    expect(limits).toHaveBeenCalledTimes(1);
    const text = document.body.textContent ?? '';
    expect(text).toContain('Apex coverage');
    expect(text).toContain('95% org-wide Apex coverage');
    expect(text).toContain('License utilisation');
    expect(text).toContain('Org limits near cap');
    expect(text).toContain('0 issues'); // all green
  });

  it('a single failing query renders a red "could not run" row, others still render', async () => {
    const toolingQuery = vi.fn(async (soql: string) => {
      if (soql.includes('ApexOrgWideCoverage')) throw new Error('INVALID_TYPE: coverage');
      return envelope([{ ApiVersion: 62 }]);
    });
    const feature = createOrgHealthLiveFeature({ api: fakeApi({ toolingQuery }) });
    await feature.onActivate?.();
    await flush();

    const text = document.body.textContent ?? '';
    expect(text).toContain('Could not run: INVALID_TYPE: coverage');
    expect(text).toContain('Apex API-version spread'); // sibling check still ran
  });
});
