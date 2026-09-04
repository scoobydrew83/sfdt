/**
 * Guards the guard.
 *
 * "Fixture tests" is a hard constraint on WEB-2, and the only way it stays
 * true through future edits is if breaking it fails a test. These assertions
 * prove `setup-no-network.ts` is actually installed for this suite — if
 * someone drops the `setupFiles` entry from `vitest.config.ts`, this file goes
 * red before any test quietly starts calling Trailhead for real.
 */

import { describe, expect, it } from 'vitest';
import { createTrailheadClient } from '../src/client.js';

describe('the suite cannot reach the network', () => {
  it('replaces the global fetch with a thrower', () => {
    // Throws synchronously rather than rejecting: a caller that forgets to
    // await still fails, instead of leaving an unhandled rejection behind.
    expect(() => (globalThis.fetch as unknown as () => unknown)()).toThrow(
      /Network access is disabled in this test suite/
    );
  });

  it('makes a client that forgot to inject a fetch fail loudly', async () => {
    const client = createTrailheadClient();
    await expect(client.getProfile('example-handle')).rejects.toThrow(
      /Network access is disabled in this test suite/
    );
  });

  it('names the endpoint it refused, so the failure is diagnosable', async () => {
    const client = createTrailheadClient({ maxRetries: 0 });
    // Substring assertion on the error *message*, not a URL check. An unanchored
    // host-shaped regex here reads to CodeQL (js/regex/missing-regexp-anchor) as a
    // permissive host validator; toThrow(string) already means "message contains",
    // so the regex bought nothing and cost a false-positive alert.
    await expect(client.getProfile('example-handle')).rejects.toThrow(
      'profile.api.trailhead.com'
    );
  });
});
