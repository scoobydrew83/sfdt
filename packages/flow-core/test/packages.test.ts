import { describe, it, expect } from 'vitest';
import {
  parseVersion,
  versionFromParts,
  formatVersion,
  compareVersions,
  toInstalledRow,
  packageKey,
  classifyUpdate,
  analyzePackages,
  comparePackageSets,
  installedPackagesQuery,
  type InstalledPackageRow,
  type PackageQueries,
} from '../src/packages.js';

// Two things decide whether this module is honest, and both are easy to get
// silently wrong:
//
//   1. **Version comparison must be numeric.** Under a string compare `3.10.0`
//      sorts BELOW `3.9.0`, so an org two minor versions ahead reports as
//      behind and a drift gate fires backwards.
//   2. **"I have nothing to compare against" is not "you are up to date."**
//      Salesforce exposes no API for the latest available version of a managed
//      package, so an un-annotated package must come back `unknown`.

const v = (major: number, minor = 0, patch = 0, build = 0) => ({ major, minor, patch, build });

describe('parseVersion', () => {
  it('parses full and partial versions', () => {
    expect(parseVersion('3.10.0.2')).toEqual(v(3, 10, 0, 2));
    expect(parseVersion('3.10')).toEqual(v(3, 10));
    expect(parseVersion('3')).toEqual(v(3));
    expect(parseVersion(' v3.1 ')).toEqual(v(3, 1));
  });

  it('returns null rather than a zeroed version for junk', () => {
    // A version that silently became 0.0.0.0 would compare as "behind
    // everything" and produce a confident wrong answer.
    for (const bad of ['', 'latest', '3.x', 'Winter 26', null, undefined, '3..1']) {
      expect(parseVersion(bad as string)).toBeNull();
    }
  });
});

describe('compareVersions', () => {
  it('compares NUMERICALLY, so 3.10.0 is newer than 3.9.0', () => {
    // The whole reason this function exists.
    expect(compareVersions(v(3, 10), v(3, 9))).toBeGreaterThan(0);
    expect(compareVersions(v(3, 9), v(3, 10))).toBeLessThan(0);
    // And the string form would have said the opposite.
    expect('3.10.0.0' > '3.9.0.0').toBe(false);
  });

  it('falls through each component in order', () => {
    expect(compareVersions(v(4), v(3, 99, 99, 99))).toBeGreaterThan(0);
    expect(compareVersions(v(3, 1, 0, 5), v(3, 1, 0, 4))).toBeGreaterThan(0);
    expect(compareVersions(v(3, 1, 0, 4), v(3, 1, 0, 4))).toBe(0);
  });
});

describe('versionFromParts', () => {
  it('defaults absent components to zero but refuses an absent major', () => {
    expect(versionFromParts(3, null, undefined, '')).toEqual(v(3));
    expect(versionFromParts(null, 1, 2, 3)).toBeNull();
    expect(versionFromParts('abc', 1, 2, 3)).toBeNull();
  });

  it('accepts the string numbers a JSON envelope may carry', () => {
    expect(versionFromParts('3', '10', '0', '2')).toEqual(v(3, 10, 0, 2));
  });
});

describe('toInstalledRow', () => {
  it('maps a Tooling row', () => {
    const row = toInstalledRow({
      SubscriberPackageId: '033000000000001',
      SubscriberPackageVersionId: '04t000000000001',
      SubscriberPackage: { Name: 'Acme Billing', NamespacePrefix: 'acme' },
      SubscriberPackageVersion: { Name: "Winter '26", MajorVersion: 3, MinorVersion: 10, PatchVersion: 0, BuildNumber: 2 },
    });
    expect(row).toMatchObject({
      namespace: 'acme',
      name: 'Acme Billing',
      versionText: '3.10.0.2',
      versionName: "Winter '26",
    });
  });

  it('handles an unmanaged package with no namespace', () => {
    const row = toInstalledRow({ SubscriberPackage: { Name: 'Legacy Tools' } });
    expect(row.namespace).toBeNull();
    expect(row.name).toBe('Legacy Tools');
    // No version sub-object at all — reported as unreadable, not as 0.0.0.0.
    expect(row.version).toBeNull();
    expect(row.versionText).toBeNull();
  });

  it('does not throw on a row missing every sub-object', () => {
    expect(() => toInstalledRow({})).not.toThrow();
  });
});

describe('packageKey', () => {
  it('keys on namespace, not the per-org package id', () => {
    // The annotation is about the PRODUCT, so it must survive being read from a
    // different org, where the SubscriberPackageId differs.
    expect(packageKey({ namespace: 'acme', name: 'Acme Billing' })).toBe('acme');
  });

  it('falls back to the name for an unmanaged package', () => {
    expect(packageKey({ namespace: null, name: 'Legacy Tools' })).toBe('Legacy Tools');
  });
});

describe('classifyUpdate — never claims an API was checked', () => {
  it('reports unknown when nothing was recorded, and says why', () => {
    const { status, detail } = classifyUpdate(v(3, 1), null);
    expect(status).toBe('unknown');
    expect(detail).toContain('no API that reports the latest available version');
  });

  it('reports unknown for an unparseable recorded version', () => {
    // Stored happily but comparable against nothing — the package would sit at
    // "unknown" forever while its owner believed it was watched.
    expect(classifyUpdate(v(3, 1), { latestKnown: 'Winter 26' }).status).toBe('unknown');
  });

  it('flags an update when installed is behind the record', () => {
    const { status, detail } = classifyUpdate(v(3, 9), { latestKnown: '3.10.0' });
    expect(status).toBe('update-available');
    expect(detail).toContain('3.9.0.0');
    expect(detail).toContain('3.10.0.0');
  });

  it('says the NOTE is stale when installed is newer, rather than calling it current', () => {
    const { status, detail } = classifyUpdate(v(4), { latestKnown: '3.10.0' });
    expect(status).toBe('ahead-of-record');
    expect(detail).toContain('out of date');
  });

  it('never says "up to date" without naming where the number came from', () => {
    const { status, detail } = classifyUpdate(v(3, 10), {
      latestKnown: '3.10.0',
      latestCheckedAt: '2026-01-04',
    });
    expect(status).toBe('current');
    expect(detail).toContain('2026-01-04');
    expect(detail).toContain('not an API check');
  });
});

describe('analyzePackages', () => {
  const queries = (records: unknown[], err?: Error): PackageQueries => ({
    async toolingQuery<T>() {
      if (err) throw err;
      return { records: records as T[] };
    },
  });

  const RECORDS = [
    {
      SubscriberPackage: { Name: 'Zeta', NamespacePrefix: 'zeta' },
      SubscriberPackageVersion: { MajorVersion: 1, MinorVersion: 0 },
    },
    {
      SubscriberPackage: { Name: 'Acme Billing', NamespacePrefix: 'acme' },
      SubscriberPackageVersion: { MajorVersion: 3, MinorVersion: 9 },
    },
    { SubscriberPackage: { Name: 'Legacy Tools' } },
  ];

  it('queries the Tooling object and sorts by name', async () => {
    expect(installedPackagesQuery()).toContain('FROM InstalledSubscriberPackage');
    const vm = await analyzePackages(queries(RECORDS));
    expect(vm.rows.map((r) => r.name)).toEqual(['Acme Billing', 'Legacy Tools', 'Zeta']);
  });

  it('folds annotations in by namespace and adjudicates each', async () => {
    const vm = await analyzePackages(queries(RECORDS), {
      org: 'prod',
      notes: { acme: { latestKnown: '3.10.0', url: 'https://example.com' } },
    });
    const acme = vm.rows.find((r) => r.namespace === 'acme')!;
    expect(acme.updateStatus).toBe('update-available');
    expect(acme.note?.url).toBe('https://example.com');
    expect(vm.counts).toMatchObject({ total: 3, managed: 2, unmanaged: 1, updateAvailable: 1, unknown: 2 });
  });

  it('always states that update status is not an API check', async () => {
    const vm = await analyzePackages(queries(RECORDS));
    expect(vm.notes.some((n) => n.includes('never from an API check'))).toBe(true);
    expect(vm.notes.some((n) => n.includes('no recorded latest version'))).toBe(true);
  });

  it('THROWS when the query fails, rather than reporting an empty org', async () => {
    // There is exactly one source here. An empty list would read as "this org
    // has no packages installed" — materially wrong, not merely partial.
    await expect(analyzePackages(queries([], new Error('INSUFFICIENT_ACCESS')))).rejects.toThrow(
      'INSUFFICIENT_ACCESS',
    );
  });
});

describe('comparePackageSets — cross-org drift', () => {
  const pkg = (namespace: string | null, name: string, version: string | null): InstalledPackageRow => ({
    namespace,
    name,
    packageId: null,
    versionId: null,
    version: version ? parseVersion(version) : null,
    versionText: version ? formatVersion(parseVersion(version)) : null,
    versionName: null,
  });

  it('names which org is behind, not just that they differ', () => {
    const vm = comparePackageSets(
      { org: 'uat', rows: [pkg('acme', 'Acme', '3.10.0')] },
      { org: 'prod', rows: [pkg('acme', 'Acme', '3.9.0')] },
    );
    expect(vm.rows[0].verdict).toBe('source-ahead');
    expect(vm.rows[0].detail).toContain('prod is behind');
  });

  it('uses numeric comparison, so 3.10 beats 3.9', () => {
    const vm = comparePackageSets(
      { org: 'a', rows: [pkg('x', 'X', '3.9.0')] },
      { org: 'b', rows: [pkg('x', 'X', '3.10.0')] },
    );
    expect(vm.rows[0].verdict).toBe('target-ahead');
  });

  it('reports presence differences in both directions', () => {
    const vm = comparePackageSets(
      { org: 'a', rows: [pkg('only-a', 'OnlyA', '1.0')] },
      { org: 'b', rows: [pkg('only-b', 'OnlyB', '1.0')] },
    );
    const byName = Object.fromEntries(vm.rows.map((r) => [r.name, r.verdict]));
    expect(byName.OnlyA).toBe('only-in-source');
    expect(byName.OnlyB).toBe('only-in-target');
  });

  it('keeps an unreadable version as unknown, NOT as matching', () => {
    // Folding it into `same` would let a drift gate pass on a comparison that
    // never happened.
    const vm = comparePackageSets(
      { org: 'a', rows: [pkg('x', 'X', null)] },
      { org: 'b', rows: [pkg('x', 'X', '1.0')] },
    );
    expect(vm.rows[0].verdict).toBe('unknown');
    expect(vm.counts.same).toBe(0);
    expect(vm.counts.unknown).toBe(1);
    expect(vm.notes.some((n) => n.includes('not as matching'))).toBe(true);
  });

  it('sorts drifted packages first', () => {
    const vm = comparePackageSets(
      { org: 'a', rows: [pkg('same', 'AAA Same', '1.0'), pkg('diff', 'ZZZ Diff', '2.0')] },
      { org: 'b', rows: [pkg('same', 'AAA Same', '1.0'), pkg('diff', 'ZZZ Diff', '1.0')] },
    );
    expect(vm.rows[0].name).toBe('ZZZ Diff');
    expect(vm.counts).toMatchObject({ total: 2, same: 1, drifted: 1, unknown: 0 });
  });

  it('matches an unmanaged package across orgs by name', () => {
    const vm = comparePackageSets(
      { org: 'a', rows: [pkg(null, 'Legacy Tools', '1.0')] },
      { org: 'b', rows: [pkg(null, 'Legacy Tools', '2.0')] },
    );
    expect(vm.rows[0].verdict).toBe('target-ahead');
  });

  it('says it cannot see upstream, even on a clean comparison', () => {
    const vm = comparePackageSets({ org: 'a', rows: [] }, { org: 'b', rows: [] });
    expect(vm.notes.some((n) => n.includes('says nothing about whether a NEWER version exists'))).toBe(true);
  });
});
