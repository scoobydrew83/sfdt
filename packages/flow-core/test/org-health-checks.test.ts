import { describe, it, expect } from 'vitest';
import {
  ORG_HEALTH_THRESHOLDS,
  coverageBand,
  usageBand,
  inactiveBand,
  worstBand,
  summariseCoverage,
  summariseInactiveUsers,
  summariseLicenses,
  summariseApiVersions,
  summariseLimits,
} from '../src/org-health-checks.js';

describe('band functions', () => {
  it('coverageBand: org-wide percent → green ≥90, amber ≥75, red below', () => {
    expect(coverageBand(95)).toBe('green');
    expect(coverageBand(80)).toBe('amber');
    expect(coverageBand(74)).toBe('red');
  });
  it('usageBand: amber ≥0.75, red ≥0.9 (unified across CLI + Chrome)', () => {
    expect(usageBand(0.5)).toBe('green');
    expect(usageBand(0.75)).toBe('amber');
    expect(usageBand(0.9)).toBe('red');
  });
  it('inactiveBand: 0 green, ≥1 amber, ≥10 red', () => {
    expect(inactiveBand(0)).toBe('green');
    expect(inactiveBand(3)).toBe('amber');
    expect(inactiveBand(10)).toBe('red');
  });
  it('worstBand: worst wins', () => {
    expect(worstBand(['green', 'amber', 'red'])).toBe('red');
    expect(worstBand(['green', 'amber'])).toBe('amber');
    expect(worstBand(['green', 'green'])).toBe('green');
    expect(worstBand([])).toBe('green');
  });
  it('thresholds resolve the historical divergence to one usage band', () => {
    expect(ORG_HEALTH_THRESHOLDS.usageAmber).toBe(0.75);
    expect(ORG_HEALTH_THRESHOLDS.usageRed).toBe(0.9);
  });
});

describe('summarisers', () => {
  it('summariseCoverage handles a percent and a missing value', () => {
    expect(summariseCoverage([{ PercentCovered: 82 }])).toMatchObject({ status: 'amber' });
    expect(summariseCoverage([{ PercentCovered: 95 }]).status).toBe('green');
    expect(summariseCoverage([]).status).toBe('amber'); // no data
  });

  it('summariseInactiveUsers counts and bands', () => {
    const out = summariseInactiveUsers([
      { Name: 'Old User', LastLoginDate: '2026-06-01' },
      { Name: 'Never', LastLoginDate: null },
    ]);
    expect(out.status).toBe('amber');
    expect(out.findings).toHaveLength(2);
    expect(out.findings[1]).toContain('never');
    expect(summariseInactiveUsers([]).status).toBe('green');
  });

  it('summariseLicenses bands at 75/90 and skips unlimited/zero', () => {
    const out = summariseLicenses([
      { Name: 'Salesforce', TotalLicenses: 100, UsedLicenses: 92 }, // red
      { Name: 'Platform', TotalLicenses: 100, UsedLicenses: 50 }, // green
      { Name: 'Unlimited', TotalLicenses: -1, UsedLicenses: 5 }, // skipped
    ]);
    expect(out.status).toBe('red');
    expect(out.findings).toHaveLength(2); // unlimited skipped
  });

  it('summariseApiVersions flags classes ≥10 behind newest', () => {
    const out = summariseApiVersions([
      { ApiVersion: 62 },
      { ApiVersion: 62 },
      { ApiVersion: 50 }, // 12 behind → stale
    ]);
    expect(out.status).toBe('amber');
    expect(out.findings[0]).toContain('v50');
    expect(summariseApiVersions([{ ApiVersion: 62 }]).status).toBe('green');
  });

  it('summariseLimits bands and sorts worst-first', () => {
    const out = summariseLimits({
      DailyApiRequests: { Max: 100, Remaining: 5 }, // 95% red
      DataStorageMB: { Max: 100, Remaining: 80 }, // 20% green
      Zero: { Max: 0, Remaining: 0 }, // skipped
    });
    expect(out.status).toBe('red');
    expect(out.findings[0]).toContain('DailyApiRequests');
  });
});
