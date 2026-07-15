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

function deriveBaseUrls(originStr: string): string[] {
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

// Executes a Salesforce REST/Tooling/SOAP call from the worker. Never returns
// the sid. On all-candidate 401 (and no other error) it clears its per-request
// sids, refetches the cookie, and retries exactly once — mirroring the old
// client's 401 policy.
export async function sfApiFetch(
  req: SfApiFetchRequest,
  deps: SfApiProxyDeps,
): Promise<SfApiFetchResponse> {
  if (typeof req.endpoint !== 'string' || !req.endpoint.startsWith('/')) {
    return { ok: false, errors: [] };
  }

  const originStr = req.targetOrigin ?? deps.senderOrigin ?? '';
  let baseUrls: string[];
  try {
    baseUrls = deriveBaseUrls(originStr);
  } catch {
    return { ok: false, errors: [] };
  }
  if (baseUrls.length === 0) return { ok: false, errors: [] };

  let sids = await fetchSids(baseUrls, deps.cookieGet);
  if (sids.size === 0) return { ok: false, errors: [] };

  let result = await runOnce(baseUrls, sids, req, deps.fetchImpl);
  if (!result.ok) {
    const has401 = result.errors.some((e) => e.status === 401);
    const hasNon401 = result.errors.some((e) => e.status >= 400 && e.status !== 401);
    if (has401 && !hasNon401) {
      sids = await fetchSids(baseUrls, deps.cookieGet);
      if (sids.size === 0) return result;
      result = await runOnce(baseUrls, sids, req, deps.fetchImpl);
    }
  }
  return result;
}
