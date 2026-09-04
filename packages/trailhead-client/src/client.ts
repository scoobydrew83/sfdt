/**
 * `TrailheadClient` — the public surface of `@sfdt/trailhead-client`.
 *
 * Reads *public* Trailblazer profiles from `profile.api.trailhead.com/graphql`
 * and nothing else. Constraints this file exists to enforce, from the WEB
 * spec:
 *
 *  - **Public GraphQL only.** One endpoint, two documents, both anonymous.
 *  - **No cookies.** Every request goes out with `credentials: 'omit'`, and
 *    the client never reads `Set-Cookie` or forwards an `Authorization`
 *    header. `test/client.test.ts` asserts both from the recorded request.
 *  - **No secrets.** There is no API key to hold — the endpoint answers
 *    unauthenticated — so this package stores none, in config or otherwise
 *    (golden principle #4).
 *  - **Private profiles are refused,** not partially read: a
 *    `__typename: "PrivateProfile"` becomes `TrailheadProfilePrivateError`.
 *
 * Retries, throttling and caching are all injectable (`fetch`, `now`, `sleep`)
 * so the whole class is testable from fixtures with no timers and no network.
 */

import { TtlCache } from './cache.js';
import {
  TrailheadGraphQLError,
  TrailheadInvalidHandleError,
  TrailheadProfileNotFoundError,
  TrailheadRateLimitError,
  TrailheadTransportError,
} from './errors.js';
import { isValidHandle, normalizeEarnedAwards, normalizeProfile } from './normalize.js';
import {
  GET_EARNED_AWARDS,
  GET_EARNED_AWARDS_OPERATION,
  GET_PUBLIC_PROFILE,
  GET_PUBLIC_PROFILE_OPERATION,
  TRAILHEAD_GRAPHQL_ENDPOINT,
} from './queries.js';
import type {
  FetchLike,
  RawEarnedAwardsQueryData,
  RawGraphQLError,
  RawGraphQLResponse,
  RawProfileQueryData,
  TrailheadEarnedAwardsPage,
  TrailheadProfile,
} from './types.js';

export interface TrailheadClientOptions {
  /** Override the endpoint (a proxy, or a fixture server in an integration test). */
  endpoint?: string;
  /**
   * `fetch` implementation. Defaults to `globalThis.fetch`, which exists on
   * every runtime this package targets (Node >= 18, browsers, Workers).
   */
  fetch?: FetchLike;
  /** Sent as-is. Defaults to a self-identifying string, per Trailhead's ToS. */
  userAgent?: string;
  /** Per-request timeout. `0` disables it. Default 10s. */
  timeoutMs?: number;
  /** Attempts *after* the first for retryable failures. Default 2. */
  maxRetries?: number;
  /** Base backoff, doubled per attempt. Default 500ms. */
  retryBaseDelayMs?: number;
  /** Upper bound on any single backoff, including a served `Retry-After`. */
  maxRetryDelayMs?: number;
  /**
   * Minimum spacing between outbound requests from this client instance. A
   * courtesy throttle against a public API we do not pay for; default 0 (off).
   */
  minRequestIntervalMs?: number;
  /**
   * In-process response cache lifetime. Default 0 (off) — see `cache.ts` for
   * why caching is opt-in.
   */
  cacheTtlMs?: number;
  /** Max entries held by that cache. Default 500. */
  cacheMaxEntries?: number;
  /**
   * Passed to `fetch` as `cf.cacheTtl` (seconds). On Cloudflare this is what
   * overrides the origin's `must-revalidate` and makes the response cacheable
   * at the edge; elsewhere the property is ignored.
   */
  cfCacheTtlSeconds?: number;
  /** Injectable clock. */
  now?: () => Date;
  /** Injectable delay, so retry/throttle tests need no real timers. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * `setTimeout` and `AbortController` exist on every runtime this package
 * targets, but they live in the `DOM` / `@types/node` libs — and pulling
 * either one in would tie a runtime-agnostic package to a single environment.
 * Reaching for them through a locally-declared view of `globalThis` keeps the
 * build on plain `ES2022` and ships no ambient globals to consumers.
 */
interface RuntimeGlobals {
  setTimeout(handler: () => void, timeout: number): unknown;
  clearTimeout(handle: unknown): void;
  AbortController?: new () => { readonly signal: unknown; abort(): void };
}
const runtime = globalThis as unknown as RuntimeGlobals;

const DEFAULT_USER_AGENT = '@sfdt/trailhead-client (+https://github.com/scoobydrew83/sfdt)';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const DEFAULT_AWARDS_PAGE_SIZE = 50;

/** 5xx is transient; 429 is rate limiting; everything else is the caller's. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => runtime.setTimeout(() => resolve(), ms));
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const asDate = Date.parse(value);
  if (Number.isNaN(asDate)) return null;
  return Math.max(0, Math.round((asDate - Date.now()) / 1000));
}

/** `NOT_FOUND` is the API's own code for "no profile with this slug". */
function isNotFound(errors: RawGraphQLError[] | undefined): boolean {
  return (errors ?? []).some(
    (e) => e.extensions?.code === 'NOT_FOUND' || e.extensions?.statusCode === 404
  );
}

export class TrailheadClient {
  readonly endpoint: string;
  readonly #fetch: FetchLike;
  readonly #userAgent: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #retryBaseDelayMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #minRequestIntervalMs: number;
  readonly #cfCacheTtlSeconds: number | undefined;
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #cache: TtlCache<unknown> | null;
  /** Tail of the throttle queue; requests chain off it to stay serialized. */
  #throttleChain: Promise<void> = Promise.resolve();
  #lastRequestAt = Number.NEGATIVE_INFINITY;

  constructor(options: TrailheadClientOptions = {}) {
    const resolvedFetch = options.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
    if (typeof resolvedFetch !== 'function') {
      throw new TrailheadTransportError(
        'No fetch implementation available. Pass options.fetch on a runtime without a global fetch.',
        null
      );
    }
    this.endpoint = options.endpoint ?? TRAILHEAD_GRAPHQL_ENDPOINT;
    this.#fetch = resolvedFetch;
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    this.#minRequestIntervalMs = options.minRequestIntervalMs ?? 0;
    this.#cfCacheTtlSeconds = options.cfCacheTtlSeconds;
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? defaultSleep;
    this.#cache =
      options.cacheTtlMs && options.cacheTtlMs > 0
        ? new TtlCache<unknown>({
            ttlMs: options.cacheTtlMs,
            maxEntries: options.cacheMaxEntries,
            now: () => this.#now().getTime(),
          })
        : null;
  }

  /** Drop every memoized response. No-op when the cache is off. */
  clearCache(): void {
    this.#cache?.clear();
  }

  /**
   * Fetch one public profile — rank, points, badge counts and certifications.
   *
   * @throws {TrailheadInvalidHandleError} the handle is malformed (no request made).
   * @throws {TrailheadProfileNotFoundError} no profile for this slug.
   * @throws {TrailheadProfilePrivateError} the profile exists but is not public.
   * @throws {TrailheadRateLimitError} rate-limited after every retry.
   * @throws {TrailheadTransportError} network failure, non-2xx, or non-JSON body.
   * @throws {TrailheadGraphQLError} HTTP 200 with unclassified GraphQL errors.
   */
  async getProfile(handle: string): Promise<TrailheadProfile> {
    const slug = this.#assertHandle(handle);
    return this.#memoized(`profile:${slug}`, async () => {
      const data = await this.#request<RawProfileQueryData>(
        GET_PUBLIC_PROFILE_OPERATION,
        GET_PUBLIC_PROFILE,
        { slug },
        slug
      );
      return normalizeProfile(data, slug, this.#now);
    });
  }

  /**
   * One page of earned awards (badges, projects, superbadges).
   *
   * Callers that only need a *count* should read `stats.badgeCount` from
   * `getProfile` rather than paging this — it is one request instead of many.
   */
  async getEarnedAwards(
    handle: string,
    options: { first?: number; after?: string | null } = {}
  ): Promise<TrailheadEarnedAwardsPage> {
    const slug = this.#assertHandle(handle);
    const first = options.first ?? DEFAULT_AWARDS_PAGE_SIZE;
    const after = options.after ?? null;
    return this.#memoized(`awards:${slug}:${first}:${after ?? ''}`, async () => {
      const data = await this.#request<RawEarnedAwardsQueryData>(
        GET_EARNED_AWARDS_OPERATION,
        GET_EARNED_AWARDS,
        { slug, first, after },
        slug
      );
      return normalizeEarnedAwards(data, slug, this.#now);
    });
  }

  #assertHandle(handle: string): string {
    if (!isValidHandle(handle)) throw new TrailheadInvalidHandleError(String(handle));
    return handle;
  }

  async #memoized<T>(key: string, load: () => Promise<T>): Promise<T> {
    const cache = this.#cache;
    if (!cache) return load();
    const hit = cache.get(key) as T | undefined;
    if (hit !== undefined) return hit;
    const value = await load();
    cache.set(key, value);
    return value;
  }

  /**
   * One GraphQL round trip: throttle → send → retry on transient failure →
   * classify. Returns the `data` object; every failure path throws a typed
   * error from `errors.ts`.
   */
  async #request<T>(
    operationName: string,
    query: string,
    variables: Record<string, unknown>,
    handle: string
  ): Promise<T> {
    const body = JSON.stringify({ operationName, query, variables });
    let lastRateLimit: TrailheadRateLimitError | null = null;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      await this.#throttle();

      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await this.#send(body);
      } catch (cause) {
        // Transport failures are retryable; the last one surfaces as-is.
        if (attempt < this.#maxRetries) {
          await this.#sleep(this.#backoffMs(attempt, null));
          continue;
        }
        throw new TrailheadTransportError(
          `Request to the Trailhead API failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          null,
          { cause }
        );
      }

      if (!response.ok) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        if (RETRYABLE_STATUSES.has(response.status)) {
          if (response.status === 429) {
            lastRateLimit = new TrailheadRateLimitError(response.status, retryAfter);
          }
          if (attempt < this.#maxRetries) {
            await this.#sleep(this.#backoffMs(attempt, retryAfter));
            continue;
          }
          if (lastRateLimit) throw lastRateLimit;
        }
        throw new TrailheadTransportError(
          `Trailhead API responded with HTTP ${response.status}.`,
          response.status
        );
      }

      const raw = await response.text();
      let payload: RawGraphQLResponse<T>;
      try {
        payload = JSON.parse(raw) as RawGraphQLResponse<T>;
      } catch (cause) {
        throw new TrailheadTransportError(
          'Trailhead API returned a body that is not JSON.',
          response.status,
          { cause }
        );
      }

      if (isNotFound(payload.errors)) throw new TrailheadProfileNotFoundError(handle);
      if (payload.errors?.length && (payload.data === null || payload.data === undefined)) {
        throw new TrailheadGraphQLError(
          `Trailhead API returned GraphQL errors: ${payload.errors
            .map((e) => e.message ?? 'unknown error')
            .join('; ')}`,
          payload.errors
        );
      }
      // A partial response (data + errors) is normalized on its merits;
      // `normalize.ts` treats every field as optional, so a dropped field
      // degrades to null instead of throwing.
      return (payload.data ?? null) as T;
    }

    /* c8 ignore next -- the loop always returns or throws before falling out. */
    throw lastRateLimit ?? new TrailheadTransportError('Request loop exhausted.', null);
  }

  async #send(body: string): Promise<Awaited<ReturnType<FetchLike>>> {
    const init: Parameters<FetchLike>[1] = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': this.#userAgent,
      },
      body,
      // Public, unauthenticated API: never let a runtime attach a cookie or
      // any other ambient credential to these requests.
      credentials: 'omit',
    };
    if (this.#cfCacheTtlSeconds !== undefined) {
      init.cf = { cacheTtl: this.#cfCacheTtlSeconds, cacheEverything: true };
    }

    const Abort = runtime.AbortController;
    if (!this.#timeoutMs || !Abort) return this.#fetch(this.endpoint, init);

    const controller = new Abort();
    const timer = runtime.setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      init.signal = controller.signal;
      return await this.#fetch(this.endpoint, init);
    } finally {
      runtime.clearTimeout(timer);
    }
  }

  #backoffMs(attempt: number, retryAfterSeconds: number | null): number {
    const base =
      retryAfterSeconds !== null
        ? retryAfterSeconds * 1000
        : this.#retryBaseDelayMs * 2 ** attempt;
    return Math.min(base, this.#maxRetryDelayMs);
  }

  /**
   * Serialize requests far enough apart to honour `minRequestIntervalMs`.
   * Chaining off a single promise (rather than checking a timestamp) is what
   * makes concurrent callers queue instead of all passing the same check.
   */
  #throttle(): Promise<void> {
    if (this.#minRequestIntervalMs <= 0) return Promise.resolve();
    const next = this.#throttleChain.then(async () => {
      const nowMs = this.#now().getTime();
      const waitMs = this.#lastRequestAt + this.#minRequestIntervalMs - nowMs;
      if (waitMs > 0) await this.#sleep(waitMs);
      this.#lastRequestAt = this.#now().getTime();
    });
    // Keep the chain alive even if a link rejects, so one failure does not
    // wedge every later request behind it.
    this.#throttleChain = next.catch(() => undefined);
    return next;
  }
}

/** Convenience factory mirroring the rest of the monorepo's `create*` helpers. */
export function createTrailheadClient(options?: TrailheadClientOptions): TrailheadClient {
  return new TrailheadClient(options);
}
