/**
 * `@sfdt/trailhead-client` — typed, cache-friendly access to the **public**
 * Trailhead profile GraphQL API.
 *
 * ```ts
 * import { createTrailheadClient } from '@sfdt/trailhead-client';
 *
 * const client = createTrailheadClient({ cacheTtlMs: 5 * 60_000 });
 * const profile = await client.getProfile('some-handle');
 * profile.stats.points;      // number | null
 * profile.certifications;    // TrailheadCertification[]
 * ```
 *
 * Public, unauthenticated data only: no cookies, no credentials, no API key,
 * and private profiles are refused rather than partially read. See README.md
 * for the rate-limit and cache-TTL guidance.
 */

export { TrailheadClient, createTrailheadClient } from './client.js';
export type { TrailheadClientOptions } from './client.js';

export { TtlCache } from './cache.js';
export type { TtlCacheOptions } from './cache.js';

export { isValidHandle, normalizeEarnedAwards, normalizeProfile, toIsoDate } from './normalize.js';

export {
  GET_EARNED_AWARDS,
  GET_EARNED_AWARDS_OPERATION,
  GET_PUBLIC_PROFILE,
  GET_PUBLIC_PROFILE_OPERATION,
  TRAILHEAD_GRAPHQL_ENDPOINT,
} from './queries.js';

export {
  TrailheadError,
  TrailheadGraphQLError,
  TrailheadInvalidHandleError,
  TrailheadProfileNotFoundError,
  TrailheadProfilePrivateError,
  TrailheadRateLimitError,
  TrailheadTransportError,
} from './errors.js';

export type {
  FetchLike,
  HttpRequestInit,
  HttpResponseLike,
  RawCertification,
  RawCertificationStatus,
  RawCredential,
  RawEarnedAwardsQueryData,
  RawGraphQLError,
  RawGraphQLResponse,
  RawProfile,
  RawProfileQueryData,
  RawRank,
  RawTrailheadStats,
  TrailheadCertification,
  TrailheadEarnedAward,
  TrailheadEarnedAwardsPage,
  TrailheadProfile,
  TrailheadProfileStats,
  TrailheadRank,
} from './types.js';
