import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  sfApiFetch,
  deriveBaseUrls,
  orgIdFromSid,
  crossMatchByOrgId,
  type SessionCache,
  type SessionCacheEntry,
  type SfApiProxyDeps,
} from '../lib/sf-api-proxy.js';

// ── AC1: candidate-domain expansion matrix ─────────────────────────────────
// Each domain family resolves to the correct API instance host, OR (Defender
// proxy) fails cleanly by falling back to the page origin — never throws.
describe('deriveBaseUrls — resolution matrix (AC1)', () => {
  it('standard prod (lightning → my.salesforce.com)', () => {
    expect(deriveBaseUrls('https://acme.lightning.force.com')).toEqual([
      'https://acme.my.salesforce.com',
      'https://acme.lightning.force.com',
    ]);
  });

  it('my.salesforce.com origin collapses to a single candidate', () => {
    expect(deriveBaseUrls('https://acme.my.salesforce.com')).toEqual([
      'https://acme.my.salesforce.com',
    ]);
  });

  it('sandbox keeps its middle segment', () => {
    expect(deriveBaseUrls('https://acme.sandbox.lightning.force.com')).toEqual([
      'https://acme.sandbox.my.salesforce.com',
      'https://acme.sandbox.lightning.force.com',
    ]);
  });

  it('gov-cloud (.mil)', () => {
    expect(deriveBaseUrls('https://gov.lightning.force.mil')).toEqual([
      'https://gov.my.salesforce.mil',
      'https://gov.lightning.force.mil',
    ]);
  });

  it('China (.sfcrmapps.cn)', () => {
    expect(deriveBaseUrls('https://cn.lightning.sfcrmapps.cn')).toEqual([
      'https://cn.my.sfcrmapps.cn',
      'https://cn.lightning.sfcrmapps.cn',
    ]);
  });

  it('Defender .mcas.ms proxy falls back to the proxied origin', () => {
    expect(deriveBaseUrls('https://acme-my-salesforce-com.us.mcas.ms')).toEqual([
      'https://acme-my-salesforce-com.us.mcas.ms',
    ]);
  });

  it('an invalid origin fails cleanly through sfApiFetch (no throw/hang)', async () => {
    const deps = makeDeps({}, {}, memoryCache());
    const resp = await sfApiFetch(
      { kind: 'json', method: 'GET', endpoint: '/services/data', targetOrigin: 'not a url' },
      deps,
    );
    expect(resp).toEqual({ ok: false, errors: [] });
    expect(deps.cookieSpy).not.toHaveBeenCalled();
  });
});

// ── SID-prefix (Org ID) cross-matching ─────────────────────────────────────
describe('orgIdFromSid', () => {
  it('extracts the org id prefix before the first "!"', () => {
    expect(orgIdFromSid('00D5g000004abcd!AQEAQ.long.session.key')).toBe('00D5g000004abcd');
  });
  it('returns null when there is no "!" or a leading "!"', () => {
    expect(orgIdFromSid('nobang')).toBeNull();
    expect(orgIdFromSid('!leading')).toBeNull();
  });
});

describe('crossMatchByOrgId', () => {
  const A = 'https://acme.my.salesforce.com';
  const B = 'https://acme.lightning.force.com';

  it('keeps candidates sharing the reference org id', () => {
    const sids = new Map([
      [A, '00DORG1!tokenA'],
      [B, '00DORG1!tokenB'],
    ]);
    expect(crossMatchByOrgId([A, B], sids, B)).toEqual([A, B]);
  });

  it('drops a candidate whose sid is for a DIFFERENT org (stale cross-org cookie)', () => {
    const sids = new Map([
      [A, '00DOTHER!tokenA'], // a different org the user is also logged into
      [B, '00DORG1!tokenB'], // the page origin
    ]);
    expect(crossMatchByOrgId([A, B], sids, B)).toEqual([B]);
  });

  it('applies no filter when the reference origin has no usable org id', () => {
    const sids = new Map([
      [A, 'legacy-sid-without-bang'],
      [B, 'also-no-bang'],
    ]);
    expect(crossMatchByOrgId([A, B], sids, B)).toEqual([A, B]);
  });

  it('drops candidates with no sid at all', () => {
    const sids = new Map([[B, '00DORG1!t']]);
    expect(crossMatchByOrgId([A, B], sids, B)).toEqual([B]);
  });
});

// ── AC2: chrome.storage.session cache behaviour (through sfApiFetch) ────────
function memoryCache(seed?: Record<string, SessionCacheEntry>): SessionCache & {
  store: Map<string, SessionCacheEntry>;
} {
  const store = new Map<string, SessionCacheEntry>(Object.entries(seed ?? {}));
  return {
    store,
    async get(host) {
      return store.get(host) ?? null;
    },
    async set(host, entry) {
      store.set(host, entry);
    },
    async delete(host) {
      store.delete(host);
    },
  };
}

// cookieGet keyed by base URL; routes keyed by URL prefix → status/body.
function makeDeps(
  cookies: Record<string, string | null>,
  routes: Record<string, { status: number; body: string }>,
  cache?: SessionCache,
): SfApiProxyDeps & { cookieSpy: ReturnType<typeof vi.fn>; fetchSpy: ReturnType<typeof vi.fn> } {
  const cookieSpy = vi.fn(async (url: string) => cookies[url] ?? null);
  const fetchSpy = vi.fn(async (url: string | URL) => {
    const key = typeof url === 'string' ? url : url.toString();
    for (const [prefix, r] of Object.entries(routes)) {
      if (key.startsWith(prefix)) {
        const ok = r.status >= 200 && r.status < 300;
        return {
          ok,
          status: r.status,
          headers: { get: () => 'application/json' },
          async text() {
            return r.body;
          },
        } as unknown as Response;
      }
    }
    throw new Error(`no route for ${key}`);
  });
  return { fetchImpl: fetchSpy as unknown as typeof fetch, cookieGet: cookieSpy, cookieSpy, fetchSpy, cache };
}

const ORIGIN = 'https://acme.lightning.force.com';
const MY = 'https://acme.my.salesforce.com';
const REQ = { kind: 'json', method: 'GET', endpoint: '/services/data', targetOrigin: ORIGIN } as const;

describe('sfApiFetch session cache (AC2)', () => {
  it('caches the resolved base URL keyed by page host and does not store the sid', async () => {
    const cache = memoryCache();
    const deps = makeDeps(
      { [MY]: '00DORG1!secret', [ORIGIN]: '00DORG1!secret' },
      { [MY]: { status: 200, body: '{"records":[]}' } },
      cache,
    );
    const resp = await sfApiFetch(REQ, deps);
    expect(resp.ok).toBe(true);
    const entry = cache.store.get('acme.lightning.force.com');
    expect(entry).toEqual({ baseUrl: MY, orgId: '00DORG1' });
    // The cache never holds the sid.
    expect(JSON.stringify(entry)).not.toContain('secret');
  });

  it('fast path: a cache hit reads a single cookie instead of scanning candidates', async () => {
    const cache = memoryCache({ 'acme.lightning.force.com': { baseUrl: MY, orgId: '00DORG1' } });
    const deps = makeDeps(
      { [MY]: '00DORG1!secret', [ORIGIN]: '00DORG1!secret' },
      { [MY]: { status: 200, body: '{"records":[]}' } },
      cache,
    );
    const resp = await sfApiFetch(REQ, deps);
    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.baseUrl).toBe(MY);
    // Only the cached host's cookie was read — no candidate scan.
    expect(deps.cookieSpy).toHaveBeenCalledTimes(1);
    expect(deps.cookieSpy).toHaveBeenCalledWith(MY);
  });

  it('org switch on the host invalidates the fast path and re-resolves', async () => {
    // Cache says org1 @ my.salesforce, but the cookie is now org2 → stale entry.
    const cache = memoryCache({ 'acme.lightning.force.com': { baseUrl: MY, orgId: '00DORG1' } });
    const deps = makeDeps(
      { [MY]: '00DORG2!secret', [ORIGIN]: '00DORG2!secret' },
      { [MY]: { status: 200, body: '{"records":[]}' } },
      cache,
    );
    const resp = await sfApiFetch(REQ, deps);
    expect(resp.ok).toBe(true);
    expect(cache.store.get('acme.lightning.force.com')).toEqual({ baseUrl: MY, orgId: '00DORG2' });
  });

  it('401 on the cached host clears the cache and re-resolves (AC3), landing on the working host', async () => {
    const cache = memoryCache({ 'acme.lightning.force.com': { baseUrl: MY, orgId: '00DORG1' } });
    const deps = makeDeps(
      { [MY]: '00DORG1!secret', [ORIGIN]: '00DORG1!secret' },
      {
        [MY]: { status: 401, body: 'unauthorized' },
        [ORIGIN]: { status: 200, body: '{"records":[]}' },
      },
      cache,
    );
    const resp = await sfApiFetch(REQ, deps);
    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.baseUrl).toBe(ORIGIN);
    // Re-resolved: the cache now points at the host that actually worked.
    expect(cache.store.get('acme.lightning.force.com')).toEqual({ baseUrl: ORIGIN, orgId: '00DORG1' });
  });

  it('a cleared cache re-resolves with no user action', async () => {
    const cache = memoryCache({ 'acme.lightning.force.com': { baseUrl: MY, orgId: '00DORG1' } });
    cache.store.clear(); // browser closed / cache cleared
    const deps = makeDeps(
      { [MY]: '00DORG1!secret', [ORIGIN]: '00DORG1!secret' },
      { [MY]: { status: 200, body: '{"records":[]}' } },
      cache,
    );
    const resp = await sfApiFetch(REQ, deps);
    expect(resp.ok).toBe(true);
    expect(cache.store.get('acme.lightning.force.com')).toEqual({ baseUrl: MY, orgId: '00DORG1' });
  });

  it('drops a stale cross-org candidate during full resolution', async () => {
    // my.salesforce.com carries a DIFFERENT org's cookie; only the page origin
    // matches the reference org, so the request must go there.
    const deps = makeDeps(
      { [MY]: '00DOTHER!secret', [ORIGIN]: '00DORG1!secret' },
      { [ORIGIN]: { status: 200, body: '{"records":[]}' } },
      memoryCache(),
    );
    const resp = await sfApiFetch(REQ, deps);
    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.baseUrl).toBe(ORIGIN);
  });

  // FINDING 1: a non-401 error on the cached host must still fall through to the
  // other derived candidates (caching must never reduce resiliency).
  it('cached host returns 500 → falls through to a healthy alternate and succeeds', async () => {
    const cache = memoryCache({ 'acme.lightning.force.com': { baseUrl: MY, orgId: '00DORG1' } });
    const deps = makeDeps(
      { [MY]: '00DORG1!secret', [ORIGIN]: '00DORG1!secret' },
      {
        [MY]: { status: 500, body: 'server error' },
        [ORIGIN]: { status: 200, body: '{"records":[]}' },
      },
      cache,
    );
    const resp = await sfApiFetch(REQ, deps);
    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.baseUrl).toBe(ORIGIN);
  });

  // FINDING 2: after a fast-path failure, full resolution must NOT re-fetch the
  // just-tried cached host.
  it('cached host 401 → invalidates cache, re-resolves WITHOUT re-fetching the cached host', async () => {
    const cache = memoryCache({ 'acme.lightning.force.com': { baseUrl: MY, orgId: '00DORG1' } });
    const deps = makeDeps(
      { [MY]: '00DORG1!secret', [ORIGIN]: '00DORG1!secret' },
      {
        [MY]: { status: 401, body: 'unauthorized' },
        [ORIGIN]: { status: 200, body: '{"records":[]}' },
      },
      cache,
    );
    const resp = await sfApiFetch(REQ, deps);
    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.baseUrl).toBe(ORIGIN);
    // MY was fetched exactly once (the fast path) — never re-fetched.
    const myFetches = deps.fetchSpy.mock.calls.filter(([u]) => String(u).startsWith(MY));
    expect(myFetches).toHaveLength(1);
    // Cache re-resolved onto the working host.
    expect(cache.store.get('acme.lightning.force.com')).toEqual({ baseUrl: ORIGIN, orgId: '00DORG1' });
  });

  // FINDING 2 edge: single-candidate family (.mcas.ms) — excluding the tried
  // host leaves NO alternates, so return the fast-path error with exactly ONE
  // fetch (no redundant re-fetch, no throw).
  it('single-candidate .mcas.ms family: cached host 401 → one fetch, returns the error cleanly', async () => {
    const MCAS = 'https://acme-my-salesforce-com.us.mcas.ms';
    const MCAS_HOST = 'acme-my-salesforce-com.us.mcas.ms';
    const cache = memoryCache({ [MCAS_HOST]: { baseUrl: MCAS, orgId: '00DORG1' } });
    const deps = makeDeps(
      { [MCAS]: '00DORG1!secret' },
      { [MCAS]: { status: 401, body: 'unauthorized' } },
      cache,
    );
    const resp = await sfApiFetch(
      { kind: 'json', method: 'GET', endpoint: '/services/data', targetOrigin: MCAS },
      deps,
    );
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.errors.some((e) => e.status === 401)).toBe(true);
    // Exactly one fetch — the fast path — with no redundant second attempt.
    expect(deps.fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ── AC2: the wiring uses chrome.storage.session, NEVER chrome.storage.local ──
describe('background worker wiring', () => {
  const bg = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'entrypoints', 'background.ts'),
    'utf8',
  );
  it('backs the session cache with chrome.storage.session', () => {
    expect(bg).toContain('createSessionCache(chrome.storage.session)');
  });
  it('never backs the cache with chrome.storage.local', () => {
    expect(bg).not.toContain('createSessionCache(chrome.storage.local)');
  });
});
