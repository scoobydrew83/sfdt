/**
 * Types for the public Trailhead profile GraphQL API.
 *
 * Two layers live here on purpose:
 *
 *  - `Raw*` types mirror the wire shape of `profile.api.trailhead.com/graphql`
 *    exactly as the live schema returns it (see `queries.ts` for the documents
 *    and the date they were verified). They are deliberately permissive —
 *    every field is optional/nullable, because a public API we do not own can
 *    drop a field without telling us and a hard cast would turn that into a
 *    `TypeError` deep in a caller.
 *  - `Trailhead*` types are ours: the normalized, stable surface callers code
 *    against. `normalize.ts` is the only bridge between the two.
 *
 * No DOM, no `chrome.*`, no Node-specific APIs — this package has to run in a
 * browser, in a Web Worker, on Cloudflare's edge runtime, and under Node.
 */

// ---------------------------------------------------------------------------
// Runtime-agnostic fetch typing
// ---------------------------------------------------------------------------

/**
 * The slice of the `Response` interface this client actually reads. Declaring
 * it structurally means the package needs neither the `DOM` lib nor
 * `@types/node`, so the same build is valid on every target runtime — and it
 * makes a fixture-backed stub in tests a plain object literal rather than a
 * mock of the whole `Response` class.
 */
export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  /** Header lookup is case-insensitive, matching the real `Headers`. */
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** The request options this client passes; a superset is always allowed. */
export interface HttpRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  /**
   * Always `'omit'`. The public Trailhead API is unauthenticated and the WEB
   * spec forbids cookies outright, so the client never lets the platform
   * attach ambient credentials.
   */
  credentials: 'omit';
  /** Optional abort signal, passed straight through when a timeout is set. */
  signal?: unknown;
  /**
   * Cloudflare-specific fetch properties. Ignored by Node and by browsers;
   * on Workers this is what actually makes a response cacheable, because the
   * origin sends `Cache-Control: max-age=0, private, must-revalidate`.
   */
  cf?: { cacheTtl?: number; cacheEverything?: boolean };
}

/** Any `fetch`-shaped function. Injectable so tests never need the network. */
export type FetchLike = (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>;

// ---------------------------------------------------------------------------
// Wire shapes (verified against the live schema — see queries.ts)
// ---------------------------------------------------------------------------

export interface RawGraphQLError {
  message?: string;
  path?: unknown;
  extensions?: { code?: string; statusCode?: number; clientMessage?: string };
}

export interface RawGraphQLResponse<T> {
  data?: T | null;
  errors?: RawGraphQLError[];
}

export interface RawRank {
  title?: string | null;
  imageUrl?: string | null;
}

export interface RawTrailheadStats {
  earnedBadgesCount?: number | null;
  completedTrailCount?: number | null;
  earnedPointsSum?: number | null;
  superbadgeCount?: number | null;
  rank?: RawRank | null;
}

export interface RawCertificationStatus {
  title?: string | null;
  expired?: boolean | null;
}

export interface RawCertification {
  title?: string | null;
  /** Non-padded date, e.g. `"2023-9-12"`. Normalized by `normalize.ts`. */
  dateCompleted?: string | null;
  dateExpired?: string | null;
  status?: RawCertificationStatus | null;
}

export interface RawCredential {
  certifications?: (RawCertification | null)[] | null;
}

export interface RawProfile {
  __typename?: string;
  id?: string | null;
  companyName?: string | null;
  title?: string | null;
  trailheadStats?: RawTrailheadStats | null;
  credential?: RawCredential | null;
}

export interface RawProfileQueryData {
  profile?: RawProfile | null;
}

export interface RawAward {
  id?: string | null;
  title?: string | null;
  type?: string | null;
}

export interface RawEarnedAwardEdge {
  cursor?: string | null;
  node?: { id?: string | null; award?: RawAward | null } | null;
}

export interface RawEarnedAwardsQueryData {
  profile?: {
    __typename?: string;
    earnedAwards?: {
      pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
      edges?: (RawEarnedAwardEdge | null)[] | null;
    } | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Normalized surface
// ---------------------------------------------------------------------------

export interface TrailheadRank {
  title: string | null;
  imageUrl: string | null;
}

export interface TrailheadCertification {
  title: string | null;
  /** Exactly what the API returned, e.g. `"2023-9-12"`. */
  dateCompletedRaw: string | null;
  /** Zero-padded `YYYY-MM-DD`, or `null` if the raw value did not parse. */
  dateCompleted: string | null;
  dateExpiredRaw: string | null;
  dateExpired: string | null;
  /**
   * The API's own status label, verbatim (`"Active"`, `"Maintenance Due"`, …).
   * Deliberately not mapped to a boolean: this client reports what Trailhead
   * says and leaves the maintenance policy to its callers.
   */
  statusTitle: string | null;
  /** The API's own `expired` flag. `null` when the API omitted it. */
  expired: boolean | null;
}

export interface TrailheadProfileStats {
  points: number | null;
  badgeCount: number | null;
  superbadgeCount: number | null;
  trailCount: number | null;
  rank: TrailheadRank | null;
}

export interface TrailheadProfile {
  /** The slug the caller asked for, after validation. */
  handle: string;
  /**
   * The API's `__typename`. `PublicProfile` is the only shape this client
   * reads; `PrivateProfile` is surfaced as a `TrailheadProfilePrivateError`
   * rather than a partially-filled profile.
   */
  typename: string;
  /** Salesforce user id from the public API. `null` when not returned. */
  profileId: string | null;
  companyName: string | null;
  title: string | null;
  stats: TrailheadProfileStats;
  certifications: TrailheadCertification[];
  /** ISO-8601 instant the response was normalized. */
  fetchedAt: string;
}

export interface TrailheadEarnedAward {
  earnedAwardId: string | null;
  awardId: string | null;
  title: string | null;
  /** e.g. `"MODULE"`, `"PROJECT"`, `"SUPERBADGE"` — passed through verbatim. */
  type: string | null;
  cursor: string | null;
}

export interface TrailheadEarnedAwardsPage {
  handle: string;
  awards: TrailheadEarnedAward[];
  hasNextPage: boolean;
  endCursor: string | null;
  fetchedAt: string;
}
