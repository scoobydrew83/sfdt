import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('../../src/lib/org-query.js', () => ({
  safeParse: (t) => { try { return JSON.parse(t); } catch { return null; } },
}));

import { execa } from 'execa';
import {
  expectedGaApiVersion,
  detectOrgRelease,
  compareOrgReleases,
  releaseMismatchWarning,
} from '../../src/lib/org-release.js';

beforeEach(() => vi.resetAllMocks());

/** Build a `sf api request rest /services/data` response body. */
const versionList = (...vs) =>
  ({ stdout: JSON.stringify(vs.map((v) => ({ version: String(v.toFixed(1)), label: `Release v${v}` }))) });

describe('expectedGaApiVersion', () => {
  it('follows the three-release cadence anchored at Spring 23 = v57', () => {
    expect(expectedGaApiVersion(new Date('2023-03-01T00:00:00Z'))).toBe(57); // Spring '23
    expect(expectedGaApiVersion(new Date('2023-07-01T00:00:00Z'))).toBe(58); // Summer '23
    expect(expectedGaApiVersion(new Date('2023-11-01T00:00:00Z'))).toBe(59); // Winter '24
    expect(expectedGaApiVersion(new Date('2024-01-15T00:00:00Z'))).toBe(59); // Jan: prior Winter
    expect(expectedGaApiVersion(new Date('2026-07-01T00:00:00Z'))).toBe(67); // Summer '26
  });
});

describe('detectOrgRelease', () => {
  it('returns the newest version entry and flags a preview instance', async () => {
    const ga = expectedGaApiVersion();
    execa.mockResolvedValueOnce(versionList(ga - 1, ga + 1)); // ahead of GA -> preview
    const r = await detectOrgRelease('dev');
    expect(r).toMatchObject({ apiVersion: ga + 1, preview: true });
  });

  it('is not preview when the max version matches GA', async () => {
    const ga = expectedGaApiVersion();
    execa.mockResolvedValueOnce(versionList(ga - 2, ga));
    const r = await detectOrgRelease('dev');
    expect(r).toMatchObject({ apiVersion: ga, preview: false });
  });

  it('degrades to null on any failure (old CLI, unreachable org, junk output)', async () => {
    execa.mockRejectedValueOnce(new Error('unknown command "api"'));
    expect(await detectOrgRelease('dev')).toBeNull();
    execa.mockResolvedValueOnce({ stdout: 'not json' });
    expect(await detectOrgRelease('dev')).toBeNull();
    execa.mockResolvedValueOnce({ stdout: '[]' });
    expect(await detectOrgRelease('dev')).toBeNull();
  });
});

describe('compareOrgReleases', () => {
  it('is not applicable for missing, identical, or local aliases', async () => {
    expect(await compareOrgReleases(null, 'b')).toBeNull();
    expect(await compareOrgReleases('a', undefined)).toBeNull();
    expect(await compareOrgReleases('a', 'a')).toBeNull();
    expect(await compareOrgReleases('local', 'b')).toBeNull();
    expect(await compareOrgReleases('a', 'local')).toBeNull();
    expect(execa).not.toHaveBeenCalled();
  });

  it('differ=true when the two orgs report different API versions', async () => {
    const ga = expectedGaApiVersion();
    execa
      .mockResolvedValueOnce(versionList(ga))       // source: GA
      .mockResolvedValueOnce(versionList(ga + 1));  // target: preview
    const cmp = await compareOrgReleases('src', 'tgt');
    expect(cmp.differ).toBe(true);
    expect(cmp.source.apiVersion).toBe(ga);
    expect(cmp.target.apiVersion).toBe(ga + 1);
  });

  it('differ=false when both orgs are on the same release', async () => {
    const ga = expectedGaApiVersion();
    execa.mockResolvedValueOnce(versionList(ga)).mockResolvedValueOnce(versionList(ga));
    expect((await compareOrgReleases('src', 'tgt')).differ).toBe(false);
  });

  it('differ=null (no false warning) when either release is undetectable', async () => {
    const ga = expectedGaApiVersion();
    execa.mockResolvedValueOnce(versionList(ga)).mockRejectedValueOnce(new Error('x'));
    const cmp = await compareOrgReleases('src', 'tgt');
    expect(cmp.differ).toBeNull();
    expect(cmp.target).toBeNull();
  });
});

describe('releaseMismatchWarning', () => {
  const src = { release: "Summer '26", apiVersion: 67 };
  const tgt = { release: "Winter '27", apiVersion: 68 };

  it('produces a message only when differ === true', () => {
    expect(releaseMismatchWarning(null, 'a', 'b')).toBeNull();
    expect(releaseMismatchWarning({ differ: false, source: src, target: tgt }, 'a', 'b')).toBeNull();
    expect(releaseMismatchWarning({ differ: null, source: src, target: null }, 'a', 'b')).toBeNull();
    const msg = releaseMismatchWarning({ differ: true, source: src, target: tgt }, 'prod', 'sandbox');
    expect(msg).toContain('prod');
    expect(msg).toContain('sandbox');
    expect(msg).toContain("Summer '26");
    expect(msg).toContain("Winter '27");
  });
});
