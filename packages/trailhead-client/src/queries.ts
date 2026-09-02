/**
 * GraphQL documents for the public Trailhead profile API.
 *
 * Endpoint: `https://profile.api.trailhead.com/graphql`
 *
 * These documents were verified field-by-field against the live endpoint on
 * 2026-09-02 by issuing each selection set and confirming the server did not
 * answer with an `undefinedField` error. Schema introspection is disabled on
 * that endpoint (`__schema` and `__type` both resolve to "doesn't exist on
 * type 'Query'"), so field-level probing is the only way to confirm the shape;
 * re-run `npm run test:live -w @sfdt/trailhead-client` to check they still
 * hold.
 *
 * Everything here is unauthenticated public data. No API key, no session, no
 * cookie: the endpoint answers an anonymous POST, and the client sends
 * `credentials: 'omit'` so no runtime attaches ambient ones.
 *
 * Keep the selection sets narrow. Every field added here is a field that lands
 * in a cache and, downstream, in D1 (WEB-3) — so ask for what a banner, a
 * shield or a leaderboard row needs and nothing more.
 */

export const TRAILHEAD_GRAPHQL_ENDPOINT = 'https://profile.api.trailhead.com/graphql';

/**
 * Profile + rank stats + certifications in one round trip.
 *
 * `profile` is a union; `PrivateProfile` members answer with just a
 * `__typename`, which `normalize.ts` turns into a `TrailheadProfilePrivateError`.
 */
export const GET_PUBLIC_PROFILE = `query SfdtGetPublicProfile($slug: String!) {
  profile(slug: $slug) {
    __typename
    ... on PublicProfile {
      id
      companyName
      title
      trailheadStats {
        earnedBadgesCount
        completedTrailCount
        earnedPointsSum
        superbadgeCount
        rank {
          title
          imageUrl
        }
      }
      credential {
        certifications {
          title
          dateCompleted
          dateExpired
          status {
            title
            expired
          }
        }
      }
    }
  }
}`;

export const GET_PUBLIC_PROFILE_OPERATION = 'SfdtGetPublicProfile';

/**
 * Earned badges/modules, paginated. Separate from the profile query because
 * it is a Relay connection: a caller that only needs a badge *count* should
 * read `trailheadStats.earnedBadgesCount` from the profile instead of paging
 * this.
 */
export const GET_EARNED_AWARDS = `query SfdtGetEarnedAwards($slug: String!, $first: Int!, $after: String) {
  profile(slug: $slug) {
    __typename
    ... on PublicProfile {
      earnedAwards(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          cursor
          node {
            id
            award {
              id
              title
              type
            }
          }
        }
      }
    }
  }
}`;

export const GET_EARNED_AWARDS_OPERATION = 'SfdtGetEarnedAwards';
