/**
 * Opt-in live check against the real public Trailhead API.
 *
 * Skipped by default. It exists to answer one question the fixtures cannot:
 * *has the upstream schema moved?* Fixtures are a snapshot, and a snapshot
 * that silently diverges from the API is worse than no test at all, so this
 * runs the same documents against the live endpoint and asserts the recorded
 * shape still holds.
 *
 * ```bash
 * SFDT_TRAILHEAD_LIVE=1 npm run test -w @sfdt/trailhead-client
 * # or, with a handle of your own:
 * SFDT_TRAILHEAD_LIVE=1 SFDT_TRAILHEAD_LIVE_HANDLE=some-handle npm run test -w @sfdt/trailhead-client
 * ```
 *
 * Never wire this into CI. It reaches a third-party API SFDT does not own,
 * over a public quota, and a red build caused by someone else's outage teaches
 * nobody anything.
 */

import { describe, expect, it } from 'vitest';
import { createTrailheadClient } from '../src/client.js';
import { TrailheadProfileNotFoundError } from '../src/errors.js';
import type { FetchLike } from '../src/types.js';
import { REAL_FETCH } from './setup-no-network.js';

const LIVE = process.env.SFDT_TRAILHEAD_LIVE === '1';
/** A Salesforce-run public profile, not a private individual's. */
const HANDLE = process.env.SFDT_TRAILHEAD_LIVE_HANDLE ?? 'sfdcdev';

/**
 * The real `fetch`, stashed by the setup file before it installed the thrower.
 * Reaching for it here — and only here — is what keeps the opt-in genuinely
 * opt-in.
 */
const realFetch = (globalThis as Record<symbol, unknown>)[REAL_FETCH] as FetchLike | undefined;

describe.skipIf(!LIVE)('live public Trailhead API', () => {
  const client = () =>
    createTrailheadClient({
      fetch: realFetch,
      // Be a considerate client of a public API we do not pay for.
      minRequestIntervalMs: 250,
      timeoutMs: 20_000,
    });

  it('still answers getProfile with the shape the fixtures record', async () => {
    const profile = await client().getProfile(HANDLE);

    expect(profile.typename).toBe('PublicProfile');
    expect(profile.handle).toBe(HANDLE);
    expect(typeof profile.stats.points).toBe('number');
    expect(typeof profile.stats.badgeCount).toBe('number');
    expect(typeof profile.stats.trailCount).toBe('number');
    expect(typeof profile.stats.superbadgeCount).toBe('number');
    expect(profile.stats.rank?.title).toEqual(expect.any(String));
    expect(profile.stats.rank?.imageUrl).toMatch(/^https:\/\//);

    for (const cert of profile.certifications) {
      expect(cert.title).toEqual(expect.any(String));
      // The non-padded upstream format is the reason toIsoDate exists; if this
      // ever stops matching, the normalizer needs revisiting.
      if (cert.dateCompletedRaw !== null) {
        expect(cert.dateCompletedRaw).toMatch(/^\d{4}-\d{1,2}-\d{1,2}$/);
        expect(cert.dateCompleted).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it('still answers getEarnedAwards with a Relay connection', async () => {
    const page = await client().getEarnedAwards(HANDLE, { first: 3 });

    expect(page.awards.length).toBeGreaterThan(0);
    expect(page.awards[0]?.title).toEqual(expect.any(String));
    expect(page.awards[0]?.type).toEqual(expect.any(String));
    expect(typeof page.hasNextPage).toBe('boolean');
  });

  it('still reports an unknown slug as NOT_FOUND', async () => {
    await expect(client().getProfile('sfdt-no-such-trailblazer-xyz')).rejects.toThrow(
      TrailheadProfileNotFoundError
    );
  });
});
