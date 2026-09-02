# @sfdt/trailhead-client

Typed, cache-friendly client for the **public** Trailhead profile GraphQL API.

Built for WEB-2. Its consumers are the public surfaces of the sfdt web app —
the leaderboard, profile pages, the LinkedIn banner and README shield routes —
plus the D1 sync job that backs them (WEB-3/4/5).

```ts
import { createTrailheadClient } from '@sfdt/trailhead-client';

const client = createTrailheadClient({ cacheTtlMs: 5 * 60_000 });
const profile = await client.getProfile('some-handle');

profile.stats.points;        // 35550 | null
profile.stats.rank?.title;   // "Expeditioner"
profile.certifications;      // [{ title, dateCompleted: "2023-09-12", statusTitle, expired }, …]
```

## What it will and will not do

| | |
|---|---|
| **Endpoint** | `https://profile.api.trailhead.com/graphql`, unauthenticated |
| **Credentials** | None. Every request sets `credentials: 'omit'`; no cookie, `Authorization` or API-key header is ever sent |
| **Secrets** | None to hold — the endpoint answers anonymous requests, so this package stores no key anywhere (golden principle #4) |
| **Private profiles** | Refused. A `__typename: "PrivateProfile"` throws `TrailheadProfilePrivateError`; the client will not return a partial profile for one |
| **Runtime** | No DOM, no `chrome.*`, no Node-specific APIs, zero runtime dependencies. Runs in a browser, a Web Worker, a Cloudflare Worker, and Node ≥ 18 |
| **Data written anywhere** | None. This package reads; it never persists |

## API

### `createTrailheadClient(options?)` → `TrailheadClient`

#### `getProfile(handle)` → `Promise<TrailheadProfile>`

One round trip for rank, points, badge/trail/superbadge counts and
certifications.

#### `getEarnedAwards(handle, { first?, after? })` → `Promise<TrailheadEarnedAwardsPage>`

One page of earned badges/modules from the Relay connection. If you only need
a badge **count**, read `profile.stats.badgeCount` instead — one request beats
paging.

#### `clearCache()`

Drops every memoized response. No-op when the cache is off.

### Errors

Every failure is a subclass of `TrailheadError`, so `catch (e) { if (e
instanceof TrailheadError) … }` covers the surface:

| Class | Meaning |
|---|---|
| `TrailheadInvalidHandleError` | Handle failed validation — **no request was made** |
| `TrailheadProfileNotFoundError` | API returned `NOT_FOUND` for the slug |
| `TrailheadProfilePrivateError` | Profile exists but is not public |
| `TrailheadRateLimitError` | HTTP 429 after every retry; carries `retryAfterSeconds` |
| `TrailheadTransportError` | Network failure, non-2xx status, or a non-JSON body |
| `TrailheadGraphQLError` | HTTP 200 with GraphQL errors we could not classify |

## Caching

**The origin makes nothing cacheable on its own.** Every response comes back
with `Cache-Control: max-age=0, private, must-revalidate` (verified
2026-09-02), so no browser, CDN or edge cache in the path will store it unless
you say so. Two independent knobs, both **off by default** — a cache nobody
asked for is a stale-data bug waiting to happen:

- **`cacheTtlMs`** — an in-process memo, keyed by handle. This is what turns a
  burst of leaderboard renders for one handle into a single request. Bounded by
  `cacheMaxEntries` (default 500) so a long-lived edge isolate cannot grow
  without limit. Failures are never cached.
- **`cfCacheTtlSeconds`** — passed to `fetch` as `cf.cacheTtl`, which is how a
  Cloudflare Worker overrides an origin's `must-revalidate`. Ignored
  (harmlessly) by Node and browsers.

Suggested starting point for the public hub: `cfCacheTtlSeconds: 300` at the
edge with a longer D1 row TTL behind it. Trailhead profile stats move on the
order of hours, not seconds.

## Rate limiting

Trailhead publishes no rate-limit policy or headers for this endpoint, and the
sampled responses carry no `X-RateLimit-*`. So the client is defensive rather
than clever:

- **`minRequestIntervalMs`** (default `0`, off) serializes outbound requests
  from one client instance and spaces them apart. Set it for any batch or cron
  job — a leaderboard sync should not fan out unthrottled against a public API
  we do not pay for.
- **Retries** (`maxRetries`, default 2) cover 429 and 5xx only, with
  exponential backoff from `retryBaseDelayMs` (default 500ms), capped at
  `maxRetryDelayMs` (default 30s). A served `Retry-After` wins over the
  computed backoff — and is capped too, so a hostile or mistaken header cannot
  park a Worker for a day.
- After the last retry a 429 becomes `TrailheadRateLimitError` with
  `retryAfterSeconds`, so a caller can schedule rather than spin.

`fetch`, `now` and `sleep` are all injectable, which is why the retry and
throttle tests need neither timers nor a network.

## Testing

The suite is fixture-based and **cannot** reach the network:
`test/setup-no-network.ts` swaps the global `fetch` for a thrower, and
`test/no-network.test.ts` asserts that guard is installed. See
`test/fixtures/README.md` for what was recorded and how to refresh it.

```bash
npm run test -w @sfdt/trailhead-client                       # fixtures only, offline
SFDT_TRAILHEAD_LIVE=1 npm run test -w @sfdt/trailhead-client # + the opt-in live schema check
```

The live tests are opt-in by design and should never run in CI: they reach a
third-party API SFDT does not own, and a red build caused by someone else's
outage teaches nobody anything. Run them when you suspect schema drift.

## Notes for downstream tickets

- **Certification status is passed through verbatim.** `statusTitle` is
  Trailhead's own label (`"Active"`, `"Maintenance Due"`, …) and `expired` is
  its own boolean. This package deliberately does not derive an
  `is_maintained`; WEB-3 owns that policy and should map from these two fields.
- **Dates arrive non-padded** (`"2023-9-12"`). Each certification carries both
  the raw value (`dateCompletedRaw`) and a zero-padded `YYYY-MM-DD`
  (`dateCompleted`), which is `null` rather than a guess when the raw value
  does not parse.
- **`profileId` is a Salesforce user id.** It comes back from the public API,
  but it identifies a person — think before persisting it. The WEB-3 D1 sketch
  keys on the slug, not on this.
- **This package is `private: true`.** It has one consumer inside the monorepo
  and no publishing decision has been made; wiring it into the release flow is
  a separate, human call.

## Schema provenance

Introspection is disabled on this endpoint (`__schema` and `__type` both
resolve to "doesn't exist on type 'Query'"), so the documents in
`src/queries.ts` were confirmed field-by-field against the live API on
2026-09-02 by checking each selection set for an `undefinedField` error.
`test/live.test.ts` is the standing check that they still hold.
