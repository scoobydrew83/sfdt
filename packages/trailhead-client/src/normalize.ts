/**
 * Raw GraphQL payloads → the normalized surface in `types.ts`.
 *
 * Everything here is pure and synchronous: no fetch, no clock beyond the
 * injectable `now`, no throwing on shapes the API is allowed to vary. The one
 * exception is profile *visibility* — a private profile is an error, not a
 * sparse profile, because the spec forbids reading non-public data.
 */

import { TrailheadProfilePrivateError,
  TrailheadProfileUnavailableError, TrailheadProfileNotFoundError } from './errors.js';
import type {
  RawCertification,
  RawEarnedAwardsQueryData,
  RawProfileQueryData,
  TrailheadCertification,
  TrailheadEarnedAward,
  TrailheadEarnedAwardsPage,
  TrailheadProfile,
  TrailheadRank,
} from './types.js';

/** Slugs are a path segment on trailblazer.me; keep the accepted set tight. */
const HANDLE_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export function isValidHandle(handle: unknown): handle is string {
  return typeof handle === 'string' && HANDLE_PATTERN.test(handle);
}

/**
 * The API returns non-padded dates (`"2023-9-12"`), which sort and compare
 * wrong as strings and are not valid ISO-8601. Pad to `YYYY-MM-DD`, and return
 * `null` rather than guessing when the value is not three numeric parts —
 * a wrong date silently written into D1 is worse than a missing one.
 */
export function toIsoDate(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw.trim());
  if (!match) return null;
  const [, year, month, day] = match as unknown as [string, string, string, string];
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function normalizeNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeString(value: string | null | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function normalizeCertification(raw: RawCertification): TrailheadCertification {
  const dateCompletedRaw = normalizeString(raw.dateCompleted);
  const dateExpiredRaw = normalizeString(raw.dateExpired);
  return {
    title: normalizeString(raw.title),
    dateCompletedRaw,
    dateCompleted: toIsoDate(dateCompletedRaw),
    dateExpiredRaw,
    dateExpired: toIsoDate(dateExpiredRaw),
    statusTitle: normalizeString(raw.status?.title),
    expired: typeof raw.status?.expired === 'boolean' ? raw.status.expired : null,
  };
}

function normalizeRank(raw: RawProfileQueryData['profile']): TrailheadRank | null {
  const rank = raw?.trailheadStats?.rank;
  if (!rank) return null;
  return {
    title: normalizeString(rank.title),
    imageUrl: normalizeString(rank.imageUrl),
  };
}

/**
 * @throws {TrailheadProfileNotFoundError} when `data.profile` is absent — the
 *   API also signals this with a GraphQL error, but a null profile on an
 *   otherwise clean response means the same thing.
 * @throws {TrailheadProfilePrivateError} when the profile is not public.
 */
export function normalizeProfile(
  data: RawProfileQueryData | null | undefined,
  handle: string,
  now: () => Date = () => new Date()
): TrailheadProfile {
  const profile = data?.profile;
  if (!profile) throw new TrailheadProfileNotFoundError(handle);

  const typename = normalizeString(profile.__typename) ?? 'Unknown';
  // Private stays private; anything else is *unrecognised*, not private. The
  // union is Trailhead's, not ours, so a new member is expected eventually and
  // asserting "this user hid their profile" for a deleted account is a wrong
  // answer dressed as a safe one. Both still refuse to read. (sfdt-private#21)
  if (typename === 'PrivateProfile') throw new TrailheadProfilePrivateError(handle);
  if (typename !== 'PublicProfile') throw new TrailheadProfileUnavailableError(handle, typename);

  const stats = profile.trailheadStats;
  const certifications = (profile.credential?.certifications ?? [])
    .filter((c): c is RawCertification => c != null)
    .map(normalizeCertification);

  return {
    handle,
    typename,
    profileId: normalizeString(profile.id),
    companyName: normalizeString(profile.companyName),
    title: normalizeString(profile.title),
    stats: {
      points: normalizeNumber(stats?.earnedPointsSum),
      badgeCount: normalizeNumber(stats?.earnedBadgesCount),
      superbadgeCount: normalizeNumber(stats?.superbadgeCount),
      trailCount: normalizeNumber(stats?.completedTrailCount),
      rank: normalizeRank(profile),
    },
    certifications,
    fetchedAt: now().toISOString(),
  };
}

/**
 * @throws {TrailheadProfileNotFoundError} when `data.profile` is absent.
 * @throws {TrailheadProfilePrivateError} when the profile is not public.
 */
export function normalizeEarnedAwards(
  data: RawEarnedAwardsQueryData | null | undefined,
  handle: string,
  now: () => Date = () => new Date()
): TrailheadEarnedAwardsPage {
  const profile = data?.profile;
  if (!profile) throw new TrailheadProfileNotFoundError(handle);

  const typename = normalizeString(profile.__typename) ?? 'Unknown';
  // Private stays private; anything else is *unrecognised*, not private. The
  // union is Trailhead's, not ours, so a new member is expected eventually and
  // asserting "this user hid their profile" for a deleted account is a wrong
  // answer dressed as a safe one. Both still refuse to read. (sfdt-private#21)
  if (typename === 'PrivateProfile') throw new TrailheadProfilePrivateError(handle);
  if (typename !== 'PublicProfile') throw new TrailheadProfileUnavailableError(handle, typename);

  const connection = profile.earnedAwards;
  const awards: TrailheadEarnedAward[] = (connection?.edges ?? [])
    .filter((edge): edge is NonNullable<typeof edge> => edge != null)
    .map((edge) => ({
      earnedAwardId: normalizeString(edge.node?.id),
      awardId: normalizeString(edge.node?.award?.id),
      title: normalizeString(edge.node?.award?.title),
      type: normalizeString(edge.node?.award?.type),
      cursor: normalizeString(edge.cursor),
    }));

  return {
    handle,
    awards,
    hasNextPage: connection?.pageInfo?.hasNextPage === true,
    endCursor: normalizeString(connection?.pageInfo?.endCursor),
    fetchedAt: now().toISOString(),
  };
}
