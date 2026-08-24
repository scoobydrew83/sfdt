// Installed package inventory.
//
// What is installed in an org, at what version, and — the part that takes work —
// whether that version is behind something.
//
// ---------------------------------------------------------------------------
// What "is there an update?" can and cannot mean here
// ---------------------------------------------------------------------------
// For a third-party managed package there is NO API that answers it:
//
//   - AppExchange has no public REST API and no per-listing version feed.
//   - `SubscriberPackageVersion` is queryable only in a Dev Hub for packages you
//     OWN. In a subscriber org it says nothing about someone else's package.
//   - `InstalledSubscriberPackage` gives the installed version and nothing about
//     what exists upstream.
//
// So this module never claims to have checked. Two things it CAN do honestly:
//
//   1. Compare the same package across orgs you are already authenticated to —
//      "prod is behind UAT" is the question people actually have, and it is
//      fully supported.
//   2. Compare against a version a human recorded from the vendor. The result is
//      labelled with where that number came from, so nobody reads it as an API
//      answer.

/** A package version, as Salesforce models it: four numeric components. */
export interface PackageVersion {
  major: number;
  minor: number;
  patch: number;
  build: number;
}

export interface InstalledPackageRow {
  /** Namespace prefix, or null for an unmanaged package. */
  namespace: string | null;
  name: string;
  /** `SubscriberPackageId` (033…) — per-org, so NOT the annotation key. */
  packageId: string | null;
  /** `SubscriberPackageVersionId` (04t…) — identifies the exact installed build. */
  versionId: string | null;
  version: PackageVersion | null;
  /** `3.10.0.2`, or null when the version could not be read. */
  versionText: string | null;
  /** Vendor-supplied version name, e.g. "Winter '26". */
  versionName: string | null;
}

/**
 * Tooling SOQL for everything installed in the org.
 *
 * `InstalledSubscriberPackage` is Tooling-only. The version's numeric components
 * are selected individually rather than relying on a formatted string, because a
 * string is what invites a lexical comparison — see `compareVersions`.
 */
export function installedPackagesQuery(): string {
  return (
    'SELECT Id, SubscriberPackageId, SubscriberPackage.Name,' +
    ' SubscriberPackage.NamespacePrefix, SubscriberPackageVersionId,' +
    ' SubscriberPackageVersion.Name, SubscriberPackageVersion.MajorVersion,' +
    ' SubscriberPackageVersion.MinorVersion, SubscriberPackageVersion.PatchVersion,' +
    ' SubscriberPackageVersion.BuildNumber' +
    ' FROM InstalledSubscriberPackage ORDER BY SubscriberPackage.NamespacePrefix'
  );
}

/**
 * Parse `3.10.0.2` (or `3.10`, or `3`) into components.
 *
 * Returns null rather than a zeroed version for anything unparseable, because a
 * version that silently became `0.0.0.0` would compare as "behind everything"
 * and generate a confident wrong answer.
 */
export function parseVersion(text: string | null | undefined): PackageVersion | null {
  if (text === null || text === undefined) return null;
  const trimmed = String(text).trim().replace(/^v/i, '');
  if (!/^\d+(\.\d+)*$/.test(trimmed)) return null;
  const parts = trimmed.split('.').map((n) => Number(n));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return {
    major: parts[0] ?? 0,
    minor: parts[1] ?? 0,
    patch: parts[2] ?? 0,
    build: parts[3] ?? 0,
  };
}

/** Build a version from the four numeric fields Salesforce returns. */
export function versionFromParts(
  major: unknown,
  minor: unknown,
  patch: unknown,
  build: unknown,
): PackageVersion | null {
  const n = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const num = Number(v);
    return Number.isFinite(num) ? num : null;
  };
  const M = n(major);
  // A package with no readable major version is not a version at all.
  if (M === null) return null;
  return { major: M, minor: n(minor) ?? 0, patch: n(patch) ?? 0, build: n(build) ?? 0 };
}

export function formatVersion(v: PackageVersion | null): string | null {
  if (!v) return null;
  return `${v.major}.${v.minor}.${v.patch}.${v.build}`;
}

/**
 * Compare two versions NUMERICALLY, component by component.
 *
 * The bug this exists to prevent is a string comparison, under which `3.10.0`
 * sorts BELOW `3.9.0` — so an org two minor versions ahead reports as behind,
 * and a drift gate fires backwards. Every comparison in this module goes
 * through here.
 *
 * @returns negative when a < b, 0 when equal, positive when a > b.
 */
export function compareVersions(a: PackageVersion, b: PackageVersion): number {
  return (
    a.major - b.major || a.minor - b.minor || a.patch - b.patch || a.build - b.build
  );
}

/** Map one Tooling row onto the row shape. Tolerant: a missing sub-object is not an error. */
export function toInstalledRow(record: Record<string, unknown>): InstalledPackageRow {
  const pkg = (record.SubscriberPackage ?? {}) as Record<string, unknown>;
  const ver = (record.SubscriberPackageVersion ?? {}) as Record<string, unknown>;
  const version = versionFromParts(
    ver.MajorVersion,
    ver.MinorVersion,
    ver.PatchVersion,
    ver.BuildNumber,
  );
  const namespace = typeof pkg.NamespacePrefix === 'string' && pkg.NamespacePrefix
    ? pkg.NamespacePrefix
    : null;
  return {
    namespace,
    // An unmanaged package has no namespace; its name is all there is.
    name: typeof pkg.Name === 'string' && pkg.Name ? pkg.Name : (namespace ?? '(unnamed package)'),
    packageId: typeof record.SubscriberPackageId === 'string' ? record.SubscriberPackageId : null,
    versionId:
      typeof record.SubscriberPackageVersionId === 'string' ? record.SubscriberPackageVersionId : null,
    version,
    versionText: formatVersion(version),
    versionName: typeof ver.Name === 'string' && ver.Name ? ver.Name : null,
  };
}

/**
 * The key an annotation is filed under.
 *
 * Namespace, not `SubscriberPackageId`: the id is assigned per org, and the
 * annotation ("here is the vendor's listing, here is the version we know is
 * current") is about the PRODUCT, so it has to survive being looked at from a
 * different org. An unmanaged package has no namespace and falls back to its
 * name, which is the only stable thing it has.
 */
export function packageKey(row: Pick<InstalledPackageRow, 'namespace' | 'name'>): string {
  return row.namespace ?? row.name;
}

// --------------------------------------------------------------------------
// Annotations and the viewmodel
// --------------------------------------------------------------------------

/** One package's entry in `.sfdt/packages.json`. */
export interface PackageNote {
  /** Vendor listing / release-notes URL. */
  url?: string | null;
  /** The version a human recorded as current, from the vendor. */
  latestKnown?: string | null;
  /** Who owns the relationship internally. */
  owner?: string | null;
  notes?: string | null;
  /** When the `latestKnown` was recorded — an old note is weak evidence. */
  latestCheckedAt?: string | null;
}

/**
 * How the installed version compares to what we know about.
 *
 * `unknown` is a first-class value, not a fallback: with no recorded version
 * there is nothing to compare against, and reporting that as "current" would be
 * the false-clean this whole module is shaped to avoid.
 */
export type UpdateStatus = 'unknown' | 'current' | 'update-available' | 'ahead-of-record';

export interface PackageRow extends InstalledPackageRow {
  key: string;
  note: PackageNote | null;
  updateStatus: UpdateStatus;
  /** Human sentence naming WHERE the comparison came from. Never implies an API check. */
  updateDetail: string | null;
}

export interface PackageVM {
  org: string | null;
  rows: PackageRow[];
  counts: { total: number; managed: number; unmanaged: number; updateAvailable: number; unknown: number };
  notes: string[];
}

/**
 * Adjudicate one package against its recorded note.
 *
 * Every branch states its evidence. The one thing this must never do is produce
 * a bare "up to date", because we did not check anything — a human did, once,
 * and possibly a year ago.
 */
export function classifyUpdate(
  installed: PackageVersion | null,
  note: PackageNote | null,
): { status: UpdateStatus; detail: string | null } {
  const recordedText = note?.latestKnown ?? null;
  if (!recordedText) {
    return {
      status: 'unknown',
      detail: 'No version recorded. There is no API that reports the latest available version of a managed package.',
    };
  }
  const recorded = parseVersion(recordedText);
  if (!recorded) {
    return { status: 'unknown', detail: `Recorded version "${recordedText}" is not a version number.` };
  }
  if (!installed) {
    return { status: 'unknown', detail: 'The installed version could not be read.' };
  }
  const when = note?.latestCheckedAt ? `, recorded ${note.latestCheckedAt}` : '';
  const cmp = compareVersions(installed, recorded);
  if (cmp < 0) {
    return {
      status: 'update-available',
      detail: `Installed ${formatVersion(installed)} is behind the recorded ${formatVersion(recorded)}${when}.`,
    };
  }
  if (cmp > 0) {
    // Not an error — the note is simply stale. Saying so is more useful than
    // silently treating it as current.
    return {
      status: 'ahead-of-record',
      detail: `Installed ${formatVersion(installed)} is NEWER than the recorded ${formatVersion(recorded)}${when} — the note is out of date.`,
    };
  }
  return {
    status: 'current',
    detail: `Matches the recorded ${formatVersion(recorded)}${when}. This is a human-recorded number, not an API check.`,
  };
}

export interface PackageQueries {
  /** Tooling SOQL. Rejections MUST throw, never resolve empty. */
  toolingQuery<T>(soql: string): Promise<{ records: T[] }>;
}

/**
 * List what is installed, folded together with any recorded annotations.
 *
 * Unlike the field scans this one DOES throw when its single query fails: there
 * is exactly one source here, so a failure leaves nothing to report and an empty
 * list would read as "this org has no packages installed" — a materially wrong
 * answer rather than a partial one.
 */
export async function analyzePackages(
  q: PackageQueries,
  { org = null, notes = {} }: { org?: string | null; notes?: Record<string, PackageNote> } = {},
): Promise<PackageVM> {
  const result = await q.toolingQuery<Record<string, unknown>>(installedPackagesQuery());
  const scopeNotes: string[] = [];

  const rows: PackageRow[] = result.records.map((record) => {
    const base = toInstalledRow(record);
    const key = packageKey(base);
    const note = notes[key] ?? null;
    const { status, detail } = classifyUpdate(base.version, note);
    return { ...base, key, note, updateStatus: status, updateDetail: detail };
  });

  rows.sort((a, b) => a.name.localeCompare(b.name));

  const unknown = rows.filter((r) => r.updateStatus === 'unknown').length;
  if (unknown > 0) {
    scopeNotes.push(
      `${unknown} package(s) have no recorded latest version, so nothing could be compared. ` +
        `Salesforce exposes no API for the latest available version of a managed package — ` +
        `record one with \`sfdt packages note <namespace> --latest <version>\`.`,
    );
  }
  scopeNotes.push(
    'Update status is derived from versions recorded by a human, never from an API check. ' +
      'For a comparison against a live org, use `sfdt packages compare --source <a> --target <b>`.',
  );

  return {
    org,
    rows,
    counts: {
      total: rows.length,
      managed: rows.filter((r) => r.namespace !== null).length,
      unmanaged: rows.filter((r) => r.namespace === null).length,
      updateAvailable: rows.filter((r) => r.updateStatus === 'update-available').length,
      unknown,
    },
    notes: scopeNotes,
  };
}

// --------------------------------------------------------------------------
// Cross-org drift
// --------------------------------------------------------------------------
//
// The one update question that IS fully answerable: is this org behind that one?
// No new auth, no vendor API, and it is what people actually want to know before
// a release.

export type DriftVerdict =
  | 'same'
  | 'source-ahead'
  | 'target-ahead'
  | 'only-in-source'
  | 'only-in-target'
  | 'unknown';

export interface PackageDriftRow {
  key: string;
  name: string;
  namespace: string | null;
  sourceVersion: string | null;
  targetVersion: string | null;
  verdict: DriftVerdict;
  detail: string;
}

export interface PackageDriftVM {
  source: string;
  target: string;
  rows: PackageDriftRow[];
  counts: { total: number; same: number; drifted: number; unknown: number };
  notes: string[];
}

/**
 * Compare two orgs' installed packages.
 *
 * Deliberately NOT `src/lib/org-diff.js`. That is a set-membership diff — it can
 * say a member is present in one side and absent in the other, and nothing else.
 * The verdict this cares about is `changed`, which set membership cannot express
 * at all, so it gets its own comparator rather than a strained extension.
 *
 * `unknown` is kept distinct from `same`: two packages whose versions could not
 * be read are not thereby equal, and folding them together would let a drift
 * gate pass on an org it never actually compared.
 */
export function comparePackageSets(
  source: { org: string; rows: readonly InstalledPackageRow[] },
  target: { org: string; rows: readonly InstalledPackageRow[] },
): PackageDriftVM {
  const byKey = new Map<string, { s?: InstalledPackageRow; t?: InstalledPackageRow }>();
  for (const row of source.rows) {
    const k = packageKey(row);
    byKey.set(k, { ...(byKey.get(k) ?? {}), s: row });
  }
  for (const row of target.rows) {
    const k = packageKey(row);
    byKey.set(k, { ...(byKey.get(k) ?? {}), t: row });
  }

  const rows: PackageDriftRow[] = [];
  for (const [key, { s, t }] of byKey) {
    const name = s?.name ?? t?.name ?? key;
    const namespace = s?.namespace ?? t?.namespace ?? null;
    const sv = s?.versionText ?? null;
    const tv = t?.versionText ?? null;

    let verdict: DriftVerdict;
    let detail: string;
    if (s && !t) {
      verdict = 'only-in-source';
      detail = `Installed in ${source.org} (${sv ?? 'version unknown'}), absent from ${target.org}.`;
    } else if (!s && t) {
      verdict = 'only-in-target';
      detail = `Installed in ${target.org} (${tv ?? 'version unknown'}), absent from ${source.org}.`;
    } else if (!s?.version || !t?.version) {
      verdict = 'unknown';
      detail = 'Installed in both, but at least one version could not be read — NOT compared.';
    } else {
      const cmp = compareVersions(s.version, t.version);
      if (cmp === 0) {
        verdict = 'same';
        detail = `Both on ${sv}.`;
      } else if (cmp > 0) {
        verdict = 'source-ahead';
        detail = `${source.org} is on ${sv}; ${target.org} is behind on ${tv}.`;
      } else {
        verdict = 'target-ahead';
        detail = `${target.org} is on ${tv}; ${source.org} is behind on ${sv}.`;
      }
    }
    rows.push({ key, name, namespace, sourceVersion: sv, targetVersion: tv, verdict, detail });
  }

  // Drifted first — that is what the reader came for — then alphabetical.
  rows.sort((a, b) => {
    const rank = (r: PackageDriftRow) =>
      r.verdict === 'same' ? 2 : r.verdict === 'unknown' ? 1 : 0;
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });

  const same = rows.filter((r) => r.verdict === 'same').length;
  const unknown = rows.filter((r) => r.verdict === 'unknown').length;
  const notes: string[] = [];
  if (unknown > 0) {
    notes.push(
      `${unknown} package(s) are installed in both orgs but could not be compared because a ` +
        `version was unreadable. They are reported as unknown, not as matching.`,
    );
  }
  notes.push(
    'This compares two orgs you are authenticated to. It says nothing about whether a NEWER ' +
      'version exists upstream — Salesforce exposes no API for that.',
  );

  return {
    source: source.org,
    target: target.org,
    rows,
    counts: { total: rows.length, same, drifted: rows.length - same - unknown, unknown },
    notes,
  };
}
