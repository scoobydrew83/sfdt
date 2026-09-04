# Changelog — @sfdt/trailhead-client

All notable changes to this package. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this package uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial package (WEB-2). Typed client for the public Trailhead profile
  GraphQL API:
  - `createTrailheadClient()` / `TrailheadClient` with `getProfile(handle)` and
    `getEarnedAwards(handle, { first, after })`.
  - Normalized `TrailheadProfile` surface: rank, points, badge/trail/superbadge
    counts, certifications with both the raw non-padded date and a zero-padded
    `YYYY-MM-DD`.
  - Typed error taxonomy under a shared `TrailheadError` base, including
    `TrailheadProfilePrivateError` — private profiles are refused, not
    partially read.
  - Opt-in caching: an in-process `TtlCache` (`cacheTtlMs`) and Cloudflare
    `cf.cacheTtl` (`cfCacheTtlSeconds`). Both off by default, because the
    origin sends `must-revalidate` and nothing caches without being told to.
  - Rate-limit defence: optional `minRequestIntervalMs` throttle, plus retries
    on 429/5xx with capped exponential backoff that honours `Retry-After`.
  - Fixture-based test suite that provably cannot reach the network, and an
    opt-in live schema check behind `SFDT_TRAILHEAD_LIVE=1`.

### Security

- No cookies, no credentials, no API key: every request sets
  `credentials: 'omit'` and the package holds no secret of any kind.
- Public, unauthenticated Trailhead data only. Private profiles throw rather
  than returning a partial record.
