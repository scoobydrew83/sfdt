/**
 * Fixture-backed fetch stubs. Nothing here touches the network — see
 * `setup-no-network.ts`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FetchLike, HttpRequestInit, HttpResponseLike } from '../src/types.js';

/**
 * Fixtures resolve from this module's own URL, not the cwd — golden principle
 * #8. `vitest run -w` from the repo root and `npm test` inside the package
 * have different working directories; only `import.meta.url` is stable.
 */
export function readFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf-8');
}

export function readFixtureJson<T = unknown>(name: string): T {
  return JSON.parse(readFixture(name)) as T;
}

export interface RecordedRequest {
  url: string;
  init: HttpRequestInit;
  /** The parsed GraphQL body, for asserting on operation/variables. */
  body: { operationName?: string; query?: string; variables?: Record<string, unknown> };
}

export interface StubResponse {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

function makeResponse(spec: StubResponse): HttpResponseLike {
  const status = spec.status ?? 200;
  const headers = new Map(
    Object.entries(spec.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    text: async () => spec.body ?? '',
  };
}

export interface FetchStub {
  fetch: FetchLike;
  requests: RecordedRequest[];
}

/**
 * A stub that answers each call with the next queued response, records every
 * request, and throws once the queue runs dry — an unexpected extra request is
 * a test failure, not a silent replay of the last answer.
 */
export function stubFetch(responses: (StubResponse | Error)[]): FetchStub {
  const queue = [...responses];
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    let body: RecordedRequest['body'] = {};
    try {
      body = JSON.parse(init.body) as RecordedRequest['body'];
    } catch {
      /* a malformed body is itself worth asserting on; keep it as {} */
    }
    requests.push({ url, init, body });
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`stubFetch: unexpected request #${requests.length} to ${url}`);
    }
    if (next instanceof Error) throw next;
    return makeResponse(next);
  };
  return { fetch, requests };
}

/** Convenience: one 200 response carrying a fixture body. */
export function stubFixture(name: string, times = 1): FetchStub {
  const body = readFixture(name);
  return stubFetch(Array.from({ length: times }, () => ({ status: 200, body })));
}

/** A `sleep` that records what it was asked to wait, and never actually waits. */
export function recordingSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}
