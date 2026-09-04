/**
 * Makes "fixture tests" a fact rather than a claim.
 *
 * The WEB-2 constraint is that this package's suite must not touch the
 * network. A test that *intends* to use a fixture but quietly falls through to
 * `globalThis.fetch` would still pass — right up until CI runs offline, or
 * until a refactor points it at the real API. So the setup file swaps the
 * global out for a thrower: any unstubbed request fails loudly, naming itself.
 *
 * The real implementation is stashed on a symbol so `live.test.ts` — and only
 * `live.test.ts`, and only under `SFDT_TRAILHEAD_LIVE=1` — can restore it.
 */

export const REAL_FETCH = Symbol.for('@sfdt/trailhead-client:real-fetch');

const globals = globalThis as Record<string | symbol, unknown>;

if (typeof globals.fetch === 'function' && globals[REAL_FETCH] === undefined) {
  globals[REAL_FETCH] = globals.fetch;
}

globals.fetch = (input: unknown): never => {
  throw new Error(
    `Network access is disabled in this test suite (attempted fetch to "${String(input)}"). ` +
      'Pass a fixture-backed fetch via createTrailheadClient({ fetch }), or move the test ' +
      'into live.test.ts, which runs only with SFDT_TRAILHEAD_LIVE=1.'
  );
};
