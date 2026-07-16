// Worker-side Salesforce API proxy. This is the ONLY place the `sid` is joined
// to an outbound request — it runs exclusively in the background service worker
// (driven by the `sfApiFetch` route in background.ts). The page-side client
// (lib/salesforce-api.ts) sends a description of the call here and receives back
// only the response *text* — never the sid.
//
// Logic (host derivation, dual-host fallback, 401 clear-and-retry) mirrors the
// old client-side `SalesforceApiClient` so its tests port over almost verbatim.
// Everything platform-specific (real fetch, chrome.cookies) is injected, so the
// core stays unit-testable without a browser.

import { mySalesforceHostname } from './hostname.js';

// Placeholder the client stamps in place of the SOAP <sessionId>. The worker
// swaps it for the real sid inside the SessionHeader before sending, so the
// page never holds a session id even for SOAP calls.
export const SOAP_SID_SENTINEL = '__SFDT_SID_SENTINEL__';

// Only these request headers survive to the outbound fetch. Authorization is
// deliberately absent: the worker injects it from the cookie, and any
// client-supplied Authorization is stripped so the page can't smuggle a sid in.
const ALLOWED_HEADERS = new Set(['accept', 'content-type', 'soapaction', 'calloptions']);

export interface SfApiFetchRequest {
  kind?: 'json' | 'text' | 'soap';
  method: string;
  endpoint: string; // must start with '/'
  query?: Record<string, string>;
  body?: string | null;
  headers?: Record<string, string>;
  soap?: { sentinel: string };
  // App-tab callers (chrome-extension:// page) pass their org origin explicitly;
  // content scripts omit it and the worker uses the sender origin instead.
  targetOrigin?: string;
}

export interface SfApiFetchSuccess {
  ok: true;
  status: number;
  bodyText: string;
  contentType: string;
  baseUrl: string;
}

export interface SfApiFetchFailure {
  ok: false;
  errors: { baseUrl: string; status: number; errorText: string }[];
}

export type SfApiFetchResponse = SfApiFetchSuccess | SfApiFetchFailure;

// Cached resolution result for one page host. Holds NO sid — only the resolved
// API base URL and the (non-secret) org id used to detect an org switch.
export interface SessionCacheEntry {
  baseUrl: string;
  orgId: string;
}

// Worker-only per-host cache (chrome.storage.session, injected). See
// lib/sf-session-cache.ts.
export interface SessionCache {
  get(host: string): Promise<SessionCacheEntry | null>;
  set(host: string, entry: SessionCacheEntry): Promise<void>;
  delete(host: string): Promise<void>;
}

export interface SfApiProxyDeps {
  fetchImpl: typeof fetch;
  // Returns the raw `sid` cookie value for a base URL, or null. The caller is
  // responsible for enforcing the Salesforce host allowlist before reading a
  // cookie (background.ts wires isAllowedCookieUrl into this closure).
  cookieGet: (url: string) => Promise<string | null>;
  // Origin the message came from (sender.origin / sender.tab.url), already
  // validated against the allowlist. Used only when the request omits
  // targetOrigin.
  senderOrigin?: string | null;
  // Optional per-host session-resolution cache (chrome.storage.session). When
  // present, a resolved base URL is remembered per page host so repeat calls
  // read a single cookie instead of scanning every candidate domain.
  cache?: SessionCache;
}

// Salesforce sid cookies are `<OrgId(15)>!<sessionKey>`. The prefix before the
// first `!` is the org id — non-secret (it appears in URLs) and stable per org.
// Used to cross-match a sid against a candidate base domain: a candidate whose
// cookie carries a DIFFERENT org id belongs to another org the user is also
// logged into, and must not be used to authenticate this org's request.
export function orgIdFromSid(sid: string): string | null {
  const bang = sid.indexOf('!');
  return bang > 0 ? sid.slice(0, bang) : null;
}

// SID-prefix (Org ID) cross-matching across candidate base domains. Keeps only
// the candidates whose sid shares the page origin's org id — this is what
// resolves the true instance on exotic domains (mcas / gov / cn) where the
// naive host guess could point at a stale cross-org cookie. A candidate whose
// sid has no parseable org id is kept (best-effort); if the reference origin
// itself has no usable org id, no filtering is applied.
export function crossMatchByOrgId(
  baseUrls: string[],
  sids: Map<string, string>,
  referenceBaseUrl: string,
): string[] {
  const withSid = baseUrls.filter((u) => sids.has(u));
  const refSid = sids.get(referenceBaseUrl);
  const refOrg = refSid ? orgIdFromSid(refSid) : null;
  if (!refOrg) return withSid;
  return withSid.filter((u) => {
    const org = orgIdFromSid(sids.get(u)!);
    return org === null || org === refOrg;
  });
}

function maybeDecodeSid(sid: string): string {
  try {
    return sid.includes('%') ? decodeURIComponent(sid) : sid;
  } catch {
    return sid;
  }
}

function sanitizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) {
    if (ALLOWED_HEADERS.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replace the sentinel ONLY where it sits as a <sessionId> element value — never
// a blanket string swap — so a sentinel that happens to appear inside the SOAP
// body args can't be turned into the sid. Handles the `met:` namespace prefix
// used by the Metadata API.
function injectSoapSid(body: string, sentinel: string, sid: string): string {
  const esc = escapeForRegex(sentinel);
  const pattern = new RegExp(`(<(?:\\w+:)?sessionId>)${esc}(</(?:\\w+:)?sessionId>)`, 'g');
  return body.replace(pattern, `$1${sid}$2`);
}

export function deriveBaseUrls(originStr: string): string[] {
  const url = new URL(originStr);
  const mySf = mySalesforceHostname(url.hostname);
  const mySfOrigin = mySf ? `https://${mySf}` : null;
  // `.my.salesforce.com` first — REST/Tooling reliable; lightning.force.com often 401s.
  return Array.from(new Set([mySfOrigin, url.origin].filter((v): v is string => !!v)));
}

async function fetchSids(
  baseUrls: string[],
  cookieGet: SfApiProxyDeps['cookieGet'],
): Promise<Map<string, string>> {
  const sids = new Map<string, string>();
  for (const baseUrl of baseUrls) {
    const raw = await cookieGet(baseUrl);
    if (raw) sids.set(baseUrl, maybeDecodeSid(raw));
  }
  return sids;
}

async function runOnce(
  baseUrls: string[],
  sids: Map<string, string>,
  req: SfApiFetchRequest,
  fetchImpl: typeof fetch,
): Promise<SfApiFetchResponse> {
  const errors: SfApiFetchFailure['errors'] = [];
  const query =
    req.query && Object.keys(req.query).length > 0
      ? `?${new URLSearchParams(req.query).toString()}`
      : '';

  for (const baseUrl of baseUrls) {
    const sid = sids.get(baseUrl);
    if (!sid) continue;
    const headers = sanitizeHeaders(req.headers);
    headers.Authorization = `Bearer ${sid}`;
    let body = req.body ?? undefined;
    if (req.soap && typeof body === 'string') {
      body = injectSoapSid(body, req.soap.sentinel, sid);
    }
    try {
      const res = await fetchImpl(`${baseUrl}${req.endpoint}${query}`, {
        method: req.method,
        headers,
        body: body ?? undefined,
      });
      if (res.ok) {
        return {
          ok: true,
          status: res.status,
          bodyText: await res.text(),
          contentType: res.headers?.get?.('content-type') ?? '',
          baseUrl,
        };
      }
      errors.push({ baseUrl, status: res.status, errorText: await res.text().catch(() => '') });
    } catch (err) {
      errors.push({
        baseUrl,
        status: 0,
        errorText: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { ok: false, errors };
}

function isPure401(errors: SfApiFetchFailure['errors']): boolean {
  return errors.length > 0 && errors.every((e) => e.status === 401);
}

// Executes a Salesforce REST/Tooling/SOAP call from the worker. Never returns
// the sid. Resolution order:
//   1. Fast path — a cached, org-id-verified base URL for this page host reads a
//      single cookie and runs directly.
//   2. Full resolution — expand candidate base domains, read each candidate's
//      sid, cross-match by org id, then run against the surviving candidates.
// On all-candidate 401 (and no other error) it clears its per-request sids,
// refetches the cookie, and retries exactly once — mirroring the old client's
// 401 policy. A pure-401 outcome also invalidates the session cache so the next
// call re-resolves; the page-side client surfaces the 401 as a toast.
export async function sfApiFetch(
  req: SfApiFetchRequest,
  deps: SfApiProxyDeps,
): Promise<SfApiFetchResponse> {
  if (typeof req.endpoint !== 'string' || !req.endpoint.startsWith('/')) {
    return { ok: false, errors: [] };
  }

  const originStr = req.targetOrigin ?? deps.senderOrigin ?? '';
  let pageOrigin: string;
  let pageHost: string;
  try {
    const url = new URL(originStr);
    pageOrigin = url.origin;
    pageHost = url.hostname;
  } catch {
    return { ok: false, errors: [] };
  }

  // 1. Fast path: a previously resolved base URL for this page host. On ANY
  // failure we fall through to full resolution so the OTHER derived candidates
  // are tried (the cached host being down must never be less resilient than an
  // uncached call). We remember the host we just tried (to exclude it from the
  // re-resolution) and the failure itself (to return verbatim if no alternates
  // exist — avoids a redundant re-fetch of the same failing host). A 401 also
  // means the cached session is stale, so we drop the entry; other errors leave
  // it intact (the host may recover) but still fall through for THIS request.
  let excludeBaseUrl: string | null = null;
  let fastPathFailure: SfApiFetchFailure | null = null;
  if (deps.cache) {
    const cached = await deps.cache.get(pageHost);
    if (cached) {
      const sids = await fetchSids([cached.baseUrl], deps.cookieGet);
      const sid = sids.get(cached.baseUrl);
      if (sid && orgIdFromSid(sid) === cached.orgId) {
        const result = await runOnce([cached.baseUrl], sids, req, deps.fetchImpl);
        if (result.ok) return result;
        excludeBaseUrl = cached.baseUrl;
        fastPathFailure = result;
        if (isPure401(result.errors)) await deps.cache.delete(pageHost);
      } else {
        // Cookie gone or the user switched orgs on this host — stale entry.
        await deps.cache.delete(pageHost);
      }
    }
  }

  // 2. Full resolution — over the candidates NOT already tried by the fast path.
  let baseUrls: string[];
  try {
    baseUrls = deriveBaseUrls(originStr);
  } catch {
    return fastPathFailure ?? { ok: false, errors: [] };
  }
  if (excludeBaseUrl) baseUrls = baseUrls.filter((u) => u !== excludeBaseUrl);
  // No other candidate to try (e.g. a single-host family like .mcas.ms): return
  // the fast-path failure rather than re-fetching the same host.
  if (baseUrls.length === 0) return fastPathFailure ?? { ok: false, errors: [] };

  let sids = await fetchSids(baseUrls, deps.cookieGet);
  if (sids.size === 0) return fastPathFailure ?? { ok: false, errors: [] };

  const candidates = crossMatchByOrgId(baseUrls, sids, pageOrigin);
  if (candidates.length === 0) return fastPathFailure ?? { ok: false, errors: [] };

  let result = await runOnce(candidates, sids, req, deps.fetchImpl);
  if (!result.ok) {
    const has401 = result.errors.some((e) => e.status === 401);
    const hasNon401 = result.errors.some((e) => e.status >= 400 && e.status !== 401);
    if (has401 && !hasNon401) {
      sids = await fetchSids(candidates, deps.cookieGet);
      if (sids.size === 0) {
        if (deps.cache) await deps.cache.delete(pageHost);
        return result;
      }
      result = await runOnce(candidates, sids, req, deps.fetchImpl);
    }
  }

  if (deps.cache && result.ok) {
    const sid = sids.get(result.baseUrl);
    const orgId = sid ? orgIdFromSid(sid) : null;
    if (orgId) await deps.cache.set(pageHost, { baseUrl: result.baseUrl, orgId });
  }
  // Non-401 failures leave any existing cache entry intact (handled above); a
  // stale/401 entry was already deleted, so there is nothing more to clear here.
  return result;
}
