import { describe, expect, it } from 'vitest';
import { createTrailheadClient } from '../src/client.js';
import {
  TrailheadGraphQLError,
  TrailheadInvalidHandleError,
  TrailheadProfileNotFoundError,
  TrailheadProfilePrivateError,
  TrailheadProfileUnavailableError,
  TrailheadRateLimitError,
  TrailheadTransportError,
} from '../src/errors.js';
import { GET_PUBLIC_PROFILE_OPERATION, TRAILHEAD_GRAPHQL_ENDPOINT } from '../src/queries.js';
import { readFixture, recordingSleep, stubFetch, stubFixture } from './helpers.js';

const FIXED_NOW = () => new Date('2026-09-02T12:00:00.000Z');

describe('TrailheadClient.getProfile — the WEB-2 acceptance criterion', () => {
  it('returns a typed profile for a handle, from a recorded fixture', async () => {
    const { fetch, requests } = stubFixture('profile-public.json');
    const client = createTrailheadClient({ fetch, now: FIXED_NOW });

    const profile = await client.getProfile('example-handle');

    expect(profile.handle).toBe('example-handle');
    expect(profile.typename).toBe('PublicProfile');
    expect(profile.stats.points).toBe(35550);
    expect(profile.stats.badgeCount).toBe(63);
    expect(profile.stats.rank?.title).toBe('Expeditioner');
    expect(profile.certifications).toHaveLength(3);
    expect(profile.certifications[0]?.dateCompleted).toBe('2023-09-12');

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(TRAILHEAD_GRAPHQL_ENDPOINT);
    expect(requests[0]?.body.operationName).toBe(GET_PUBLIC_PROFILE_OPERATION);
    expect(requests[0]?.body.variables).toEqual({ slug: 'example-handle' });
  });
});

describe('request shape — the hard constraints from the board row', () => {
  it('sends no cookies and no credentials', async () => {
    const { fetch, requests } = stubFixture('profile-public.json');
    await createTrailheadClient({ fetch }).getProfile('example-handle');

    const init = requests[0]!.init;
    expect(init.credentials).toBe('omit');

    const headerNames = Object.keys(init.headers).map((h) => h.toLowerCase());
    expect(headerNames).not.toContain('cookie');
    expect(headerNames).not.toContain('authorization');
    expect(headerNames).not.toContain('x-api-key');
  });

  it('carries no secret-shaped value in the request at all', async () => {
    const { fetch, requests } = stubFixture('profile-public.json');
    await createTrailheadClient({ fetch }).getProfile('example-handle');

    // The endpoint is unauthenticated, so there is no key for this package to
    // hold and none should appear anywhere in what it sends (principle #4).
    const serialized = JSON.stringify(requests[0]).toLowerCase();
    for (const marker of ['bearer ', 'apikey', 'api_key', 'sessionid', 'access_token']) {
      expect(serialized, marker).not.toContain(marker);
    }
  });

  it('identifies itself with a user agent', async () => {
    const { fetch, requests } = stubFixture('profile-public.json');
    await createTrailheadClient({ fetch }).getProfile('example-handle');
    expect(requests[0]?.init.headers['user-agent']).toContain('@sfdt/trailhead-client');
  });

  it('only sets Cloudflare cache properties when a TTL was asked for', async () => {
    const off = stubFixture('profile-public.json');
    await createTrailheadClient({ fetch: off.fetch }).getProfile('example-handle');
    expect(off.requests[0]?.init.cf).toBeUndefined();

    const on = stubFixture('profile-public.json');
    await createTrailheadClient({ fetch: on.fetch, cfCacheTtlSeconds: 300 }).getProfile('example-handle');
    expect(on.requests[0]?.init.cf).toEqual({ cacheTtl: 300, cacheEverything: true });
  });
});

describe('error classification', () => {
  it('rejects a malformed handle without making a request', async () => {
    const { fetch, requests } = stubFetch([]);
    const client = createTrailheadClient({ fetch });

    await expect(client.getProfile('not a handle')).rejects.toThrow(TrailheadInvalidHandleError);
    expect(requests).toHaveLength(0);
  });

  it('maps the API NOT_FOUND code to a not-found error', async () => {
    const { fetch } = stubFetch([{ status: 200, body: readFixture('profile-not-found.json') }]);
    await expect(createTrailheadClient({ fetch }).getProfile('nobody')).rejects.toThrow(
      TrailheadProfileNotFoundError
    );
  });

  it('refuses a private profile', async () => {
    const { fetch } = stubFetch([{ status: 200, body: readFixture('profile-private.json') }]);
    await expect(createTrailheadClient({ fetch }).getProfile('someone')).rejects.toThrow(
      TrailheadProfilePrivateError
    );
  });

  it('reports unclassified GraphQL errors with their messages', async () => {
    const { fetch } = stubFetch([
      {
        status: 200,
        body: JSON.stringify({
          data: null,
          errors: [{ message: "Field 'zzz' doesn't exist", extensions: { code: 'undefinedField' } }],
        }),
      },
    ]);

    await expect(createTrailheadClient({ fetch }).getProfile('someone')).rejects.toThrow(
      TrailheadGraphQLError
    );
  });

  it('surfaces a non-retryable HTTP status as a transport error', async () => {
    const { fetch } = stubFetch([{ status: 400, body: 'nope' }]);
    await expect(
      createTrailheadClient({ fetch, maxRetries: 0 }).getProfile('someone')
    ).rejects.toMatchObject({ name: 'TrailheadTransportError', status: 400 });
  });

  it('surfaces a body that is not JSON as a transport error', async () => {
    const { fetch } = stubFetch([{ status: 200, body: '<html>maintenance</html>' }]);
    await expect(createTrailheadClient({ fetch }).getProfile('someone')).rejects.toThrow(
      TrailheadTransportError
    );
  });
});

describe('retries, rate limiting and backoff', () => {
  it('retries a 503 and succeeds on the next attempt', async () => {
    const { fetch, requests } = stubFetch([
      { status: 503 },
      { status: 200, body: readFixture('profile-public.json') },
    ]);
    const { sleep, waits } = recordingSleep();

    const profile = await createTrailheadClient({ fetch, sleep, now: FIXED_NOW }).getProfile('example-handle');

    expect(profile.stats.points).toBe(35550);
    expect(requests).toHaveLength(2);
    expect(waits).toEqual([500]);
  });

  it('doubles the backoff per attempt', async () => {
    const { fetch } = stubFetch([{ status: 500 }, { status: 500 }, { status: 500 }]);
    const { sleep, waits } = recordingSleep();

    await expect(
      createTrailheadClient({ fetch, sleep, maxRetries: 2 }).getProfile('someone')
    ).rejects.toThrow(TrailheadTransportError);
    expect(waits).toEqual([500, 1000]);
  });

  it('honours Retry-After on a 429 and then throws a rate-limit error', async () => {
    const { fetch } = stubFetch([
      { status: 429, headers: { 'Retry-After': '7' } },
      { status: 429, headers: { 'Retry-After': '7' } },
    ]);
    const { sleep, waits } = recordingSleep();

    const failure = createTrailheadClient({ fetch, sleep, maxRetries: 1 }).getProfile('someone');

    await expect(failure).rejects.toThrow(TrailheadRateLimitError);
    await expect(failure).rejects.toMatchObject({ status: 429, retryAfterSeconds: 7 });
    expect(waits).toEqual([7000]);
  });

  it('caps a hostile Retry-After at maxRetryDelayMs', async () => {
    const { fetch } = stubFetch([
      { status: 429, headers: { 'retry-after': '86400' } },
      { status: 200, body: readFixture('profile-public.json') },
    ]);
    const { sleep, waits } = recordingSleep();

    await createTrailheadClient({ fetch, sleep, maxRetryDelayMs: 5000, now: FIXED_NOW }).getProfile(
      'example-handle'
    );
    expect(waits).toEqual([5000]);
  });

  it('retries a transport failure and reports the last one if it keeps failing', async () => {
    const { fetch, requests } = stubFetch([
      new Error('ECONNRESET'),
      new Error('ECONNRESET'),
      new Error('ECONNRESET'),
    ]);
    const { sleep } = recordingSleep();

    await expect(
      createTrailheadClient({ fetch, sleep, maxRetries: 2 }).getProfile('someone')
    ).rejects.toThrow(/ECONNRESET/);
    expect(requests).toHaveLength(3);
  });

  it('spaces requests out when a minimum interval is configured', async () => {
    const { fetch } = stubFixture('profile-public.json', 2);
    const { sleep, waits } = recordingSleep();
    // A frozen clock is the worst case for a throttle: every request looks
    // instantaneous, so the full interval must be waited each time.
    const client = createTrailheadClient({ fetch, sleep, now: FIXED_NOW, minRequestIntervalMs: 250 });

    await client.getProfile('handle-one');
    await client.getProfile('handle-two');

    expect(waits).toEqual([250]);
  });
});

describe('opt-in response cache', () => {
  it('is off by default — two calls make two requests', async () => {
    const { fetch, requests } = stubFixture('profile-public.json', 2);
    const client = createTrailheadClient({ fetch, now: FIXED_NOW });

    await client.getProfile('example-handle');
    await client.getProfile('example-handle');

    expect(requests).toHaveLength(2);
  });

  it('serves a second call from memory once a TTL is set', async () => {
    const { fetch, requests } = stubFixture('profile-public.json');
    const client = createTrailheadClient({ fetch, now: FIXED_NOW, cacheTtlMs: 60_000 });

    const first = await client.getProfile('example-handle');
    const second = await client.getProfile('example-handle');

    expect(requests).toHaveLength(1);
    expect(second).toBe(first);
  });

  it('keys the cache by handle', async () => {
    const { fetch, requests } = stubFixture('profile-public.json', 2);
    const client = createTrailheadClient({ fetch, now: FIXED_NOW, cacheTtlMs: 60_000 });

    await client.getProfile('handle-one');
    await client.getProfile('handle-two');

    expect(requests).toHaveLength(2);
  });

  it('re-requests after clearCache()', async () => {
    const { fetch, requests } = stubFixture('profile-public.json', 2);
    const client = createTrailheadClient({ fetch, now: FIXED_NOW, cacheTtlMs: 60_000 });

    await client.getProfile('example-handle');
    client.clearCache();
    await client.getProfile('example-handle');

    expect(requests).toHaveLength(2);
  });

  it('does not cache failures', async () => {
    const { fetch, requests } = stubFetch([
      { status: 200, body: readFixture('profile-not-found.json') },
      { status: 200, body: readFixture('profile-public.json') },
    ]);
    const client = createTrailheadClient({ fetch, now: FIXED_NOW, cacheTtlMs: 60_000 });

    await expect(client.getProfile('example-handle')).rejects.toThrow(TrailheadProfileNotFoundError);
    await expect(client.getProfile('example-handle')).resolves.toMatchObject({
      typename: 'PublicProfile',
    });
    expect(requests).toHaveLength(2);
  });
});

describe('getEarnedAwards', () => {
  it('pages the awards connection with the requested cursor', async () => {
    const { fetch, requests } = stubFixture('earned-awards-page1.json');
    const client = createTrailheadClient({ fetch, now: FIXED_NOW });

    const page = await client.getEarnedAwards('example-handle', { first: 3, after: 'CURSOR' });

    expect(requests[0]?.body.variables).toEqual({ slug: 'example-handle', first: 3, after: 'CURSOR' });
    expect(page.awards.length).toBeGreaterThan(0);
    expect(page.hasNextPage).toBe(true);
  });

  it('defaults to a 50-item first page with no cursor', async () => {
    const { fetch, requests } = stubFixture('earned-awards-page1.json');
    await createTrailheadClient({ fetch, now: FIXED_NOW }).getEarnedAwards('example-handle');
    expect(requests[0]?.body.variables).toEqual({ slug: 'example-handle', first: 50, after: null });
  });

  it('validates the handle before requesting', async () => {
    const { fetch, requests } = stubFetch([]);
    await expect(
      createTrailheadClient({ fetch }).getEarnedAwards('bad handle')
    ).rejects.toThrow(TrailheadInvalidHandleError);
    expect(requests).toHaveLength(0);
  });
});

describe('construction', () => {
  it('explains itself when the runtime has no fetch at all', () => {
    const globals = globalThis as { fetch?: unknown };
    const saved = globals.fetch;
    delete globals.fetch;
    try {
      expect(() => createTrailheadClient()).toThrow(/No fetch implementation available/);
    } finally {
      globals.fetch = saved;
    }
  });

  it('accepts an endpoint override', async () => {
    const { fetch, requests } = stubFixture('profile-public.json');
    await createTrailheadClient({ fetch, endpoint: 'https://proxy.example/graphql' }).getProfile(
      'example-handle'
    );
    expect(requests[0]?.url).toBe('https://proxy.example/graphql');
  });
});

describe('error classification is accurate, not just safe (issue #21)', () => {
  it('reports the status that actually ended the loop, not a stale 429', async () => {
    // lastRateLimit was set on any 429 and never cleared, so a 429 followed by a
    // 503 threw a rate-limit error for a response that was not one — a caller
    // branching on the type to honour retryAfterSeconds got a wrong diagnosis.
    const { sleep } = recordingSleep();
    const { fetch } = stubFetch([
      { status: 429, headers: { 'retry-after': '1' } },
      { status: 503 },
    ]);
    const client = createTrailheadClient({ fetch, sleep, maxRetries: 1 });

    const err = await client.getProfile('example-handle').catch((e) => e);
    expect(err).toBeInstanceOf(TrailheadTransportError);
    expect(err).not.toBeInstanceOf(TrailheadRateLimitError);
    expect(err.status).toBe(503);   // the response that actually ended the loop
  });

  it('still reports a rate limit when 429 is what exhausted the retries', async () => {
    const { sleep } = recordingSleep();
    const { fetch } = stubFetch([
      { status: 429, headers: { 'retry-after': '1' } },
      { status: 429, headers: { 'retry-after': '1' } },
    ]);
    const client = createTrailheadClient({ fetch, sleep, maxRetries: 1 });

    await expect(client.getProfile('example-handle')).rejects.toBeInstanceOf(TrailheadRateLimitError);
  });

  it('surfaces a GraphQL error when data is an empty object', async () => {
    // Only null/undefined counted as "no data", so an unrecognised error beside
    // `data: {}` was dropped and normalize then threw NotFound — reporting a
    // transient server error as "this handle does not exist", permanently.
    const { fetch } = stubFetch([
      {
        status: 200,
        body: JSON.stringify({
          data: {},
          errors: [{ message: 'internal error', extensions: { code: 'INTERNAL' } }],
        }),
      },
    ]);
    const client = createTrailheadClient({ fetch });

    await expect(client.getProfile('example-handle')).rejects.toBeInstanceOf(TrailheadGraphQLError);
  });
});

describe('an unknown profile typename is not called "private" (issue #21)', () => {
  const withTypename = (typename: string) =>
    stubFetch([{ status: 200, body: JSON.stringify({ data: { profile: { __typename: typename } } }) }]);

  it('still reports a genuinely private profile as private', async () => {
    const { fetch } = withTypename('PrivateProfile');
    await expect(createTrailheadClient({ fetch }).getProfile('example-handle'))
      .rejects.toBeInstanceOf(TrailheadProfilePrivateError);
  });

  it.each(['SuspendedProfile', 'DeletedProfile', 'SomethingNew'])(
    'reports %s as unavailable, naming the typename',
    async (typename) => {
      const { fetch } = withTypename(typename);
      const err = await createTrailheadClient({ fetch }).getProfile('example-handle').catch((e) => e);
      expect(err).toBeInstanceOf(TrailheadProfileUnavailableError);
      expect(err).not.toBeInstanceOf(TrailheadProfilePrivateError);
      expect(err.typename).toBe(typename);
      // it must still refuse to read — failing safe was never the problem
      expect(err.message).not.toMatch(/is private/);
    },
  );
});

describe('concurrent calls for one handle make one request (issue #21)', () => {
  it('de-duplicates in-flight loads, not just resolved ones', async () => {
    // The cache was only consulted before load() started and only stored the
    // resolved value, so a burst racing the first request all missed — the
    // opposite of what cache.ts says the cache is for.
    const { fetch, requests } = stubFixture('profile-public.json');
    const client = createTrailheadClient({ fetch, now: FIXED_NOW, cacheTtlMs: 60_000 });

    const results = await Promise.all(
      Array.from({ length: 20 }, () => client.getProfile('example-handle')),
    );

    expect(requests).toHaveLength(1);
    expect(new Set(results.map((r) => r.handle)).size).toBe(1);
  });
});
