import { describe, it, expect } from 'vitest';
import { expectedGaApiVersion, releaseFromVersionList } from '../src/org-release.js';

/** Build a `/services/data` version list. */
const versionList = (...vs: number[]) =>
  vs.map((v) => ({ version: v.toFixed(1), label: `Release v${v}` }));

describe('expectedGaApiVersion', () => {
  it('follows the three-release cadence anchored at Spring 23 = v57', () => {
    expect(expectedGaApiVersion(new Date('2023-03-01T00:00:00Z'))).toBe(57); // Spring '23
    expect(expectedGaApiVersion(new Date('2023-07-01T00:00:00Z'))).toBe(58); // Summer '23
    expect(expectedGaApiVersion(new Date('2023-11-01T00:00:00Z'))).toBe(59); // Winter '24
    expect(expectedGaApiVersion(new Date('2024-01-15T00:00:00Z'))).toBe(59); // Jan: prior Winter
    expect(expectedGaApiVersion(new Date('2026-07-01T00:00:00Z'))).toBe(67); // Summer '26
  });
});

describe('releaseFromVersionList', () => {
  const now = new Date('2026-07-01T00:00:00Z'); // GA = 67

  it('returns the newest entry and flags a preview instance', () => {
    const r = releaseFromVersionList(versionList(66, 68), now); // 68 > 67 GA
    expect(r).toEqual({ release: 'Release v68', apiVersion: 68, preview: true });
  });

  it('is not preview when the max version matches GA', () => {
    const r = releaseFromVersionList(versionList(65, 67), now);
    expect(r).toMatchObject({ apiVersion: 67, preview: false });
  });

  it('picks the numerically-latest version regardless of array order', () => {
    expect(releaseFromVersionList(versionList(67, 62, 66), now)?.apiVersion).toBe(67);
  });

  it('falls back to `API v<n>` when an entry has no label', () => {
    const r = releaseFromVersionList([{ version: '67.0' }], now);
    expect(r?.release).toBe('API v67');
  });

  it('returns null for empty, non-array, or unparseable input', () => {
    expect(releaseFromVersionList([], now)).toBeNull();
    expect(releaseFromVersionList(null, now)).toBeNull();
    expect(releaseFromVersionList('nope', now)).toBeNull();
    expect(releaseFromVersionList([{ version: 'x', label: 'y' }], now)).toBeNull();
  });
});
