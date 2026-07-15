import { describe, it, expect, vi } from 'vitest';
import { sfApiFetch, SOAP_SID_SENTINEL, type SfApiProxyDeps } from '../lib/sf-api-proxy.js';

function fetchResponder(
  routes: Record<string, { status: number; body: string; contentType?: string }>,
): typeof fetch {
  return (async (url: string | URL | Request) => {
    const key = typeof url === 'string' ? url : url.toString();
    for (const [pattern, response] of Object.entries(routes)) {
      if (key.startsWith(pattern)) {
        const ok = response.status >= 200 && response.status < 300;
        return {
          ok,
          status: response.status,
          headers: { get: () => response.contentType ?? 'application/json' },
          async text() {
            return response.body;
          },
        } as unknown as Response;
      }
    }
    throw new Error(`No fetch stub for URL: ${key}`);
  }) as typeof fetch;
}

// Every allowed org host maps to the same sid here. cookieGet is a spy so tests
// can assert the refetch-on-401 behaviour.
function makeCookieGet(sid: string | null = 'sid-1'): SfApiProxyDeps['cookieGet'] {
  return vi.fn(async () => sid);
}

const ORIGIN = 'https://x.lightning.force.com';

describe('sfApiFetch (worker proxy)', () => {
  it('prefers my.salesforce.com over the page origin', async () => {
    const fetchImpl = vi.fn(
      fetchResponder({
        'https://x.my.salesforce.com/services/data': { status: 200, body: '{"records":[]}' },
      }),
    );
    const resp = await sfApiFetch(
      { kind: 'json', method: 'GET', endpoint: '/services/data', targetOrigin: ORIGIN },
      { fetchImpl, cookieGet: makeCookieGet() },
    );
    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.baseUrl).toBe('https://x.my.salesforce.com');
    const calls = fetchImpl.mock.calls.map(([u]) => String(u));
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!).hostname).toBe('x.my.salesforce.com');
  });

  it('falls through to the page origin on 401', async () => {
    const fetchImpl = vi.fn(
      fetchResponder({
        'https://x.my.salesforce.com/services/data': { status: 401, body: 'unauthorized' },
        'https://x.lightning.force.com/services/data': { status: 200, body: '{"records":[]}' },
      }),
    );
    const resp = await sfApiFetch(
      { kind: 'json', method: 'GET', endpoint: '/services/data', targetOrigin: ORIGIN },
      { fetchImpl, cookieGet: makeCookieGet() },
    );
    expect(resp.ok).toBe(true);
    if (resp.ok) expect(new URL(resp.baseUrl).hostname).toBe('x.lightning.force.com');
  });

  it('clears its sids, refetches the cookie, and retries once when every candidate 401s', async () => {
    let pass = 0;
    const fetchImpl = vi.fn(async () => {
      pass += 1;
      const status = pass <= 2 ? 401 : 200; // 2 candidates 401 on the first attempt
      return {
        ok: status === 200,
        status,
        headers: { get: () => 'application/json' },
        async text() {
          return status === 200 ? '{"records":[]}' : 'unauthorized';
        },
      } as unknown as Response;
    });
    const cookieGet = makeCookieGet();
    const resp = await sfApiFetch(
      { kind: 'json', method: 'GET', endpoint: '/services/data', targetOrigin: ORIGIN },
      { fetchImpl, cookieGet },
    );
    expect(resp.ok).toBe(true);
    // Two candidates × two passes = cookie read four times (refetched on retry).
    expect((cookieGet as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
  });

  it('does NOT retry on a non-401 error and returns errors', async () => {
    const fetchImpl = vi.fn(
      fetchResponder({
        'https://x.my.salesforce.com/services/data': {
          status: 400,
          body: '[{"message":"bad","errorCode":"X"}]',
        },
        'https://x.lightning.force.com/services/data': {
          status: 400,
          body: '[{"message":"bad","errorCode":"X"}]',
        },
      }),
    );
    const cookieGet = makeCookieGet();
    const resp = await sfApiFetch(
      { kind: 'json', method: 'GET', endpoint: '/services/data', targetOrigin: ORIGIN },
      { fetchImpl, cookieGet },
    );
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.errors.some((e) => e.status === 400)).toBe(true);
    // No refetch: cookieGet read once per candidate only.
    expect((cookieGet as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('records a network throw as status 0', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('Failed to fetch');
    });
    const resp = await sfApiFetch(
      { kind: 'json', method: 'GET', endpoint: '/services/data', targetOrigin: ORIGIN },
      { fetchImpl, cookieGet: makeCookieGet() },
    );
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.errors.every((e) => e.status === 0)).toBe(true);
  });

  it('returns an empty-errors failure (no session) when no sid is available', async () => {
    const fetchImpl = vi.fn();
    const resp = await sfApiFetch(
      { kind: 'json', method: 'GET', endpoint: '/services/data', targetOrigin: ORIGIN },
      { fetchImpl, cookieGet: makeCookieGet(null) },
    );
    expect(resp).toEqual({ ok: false, errors: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a non-session-derivable origin and a bad endpoint without fetching', async () => {
    const fetchImpl = vi.fn();
    const badEndpoint = await sfApiFetch(
      { method: 'GET', endpoint: 'services/data', targetOrigin: ORIGIN },
      { fetchImpl, cookieGet: makeCookieGet() },
    );
    expect(badEndpoint).toEqual({ ok: false, errors: [] });
    const noOrigin = await sfApiFetch(
      { method: 'GET', endpoint: '/services/data' },
      { fetchImpl, cookieGet: makeCookieGet(), senderOrigin: null },
    );
    expect(noOrigin).toEqual({ ok: false, errors: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses the sender origin when targetOrigin is omitted', async () => {
    const fetchImpl = vi.fn(
      fetchResponder({
        'https://acme.my.salesforce.com/services/data': { status: 200, body: '{"records":[]}' },
      }),
    );
    const resp = await sfApiFetch(
      { kind: 'json', method: 'GET', endpoint: '/services/data' },
      { fetchImpl, cookieGet: makeCookieGet(), senderOrigin: 'https://acme.lightning.force.com' },
    );
    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.baseUrl).toBe('https://acme.my.salesforce.com');
  });

  it('returns bodyText verbatim (never parsed) and carries no sid field', async () => {
    const fetchImpl = vi.fn(
      fetchResponder({
        'https://x.my.salesforce.com/services/data': {
          status: 200,
          body: '{"totalSize":1,"records":[{"Id":"001"}]}',
        },
      }),
    );
    const resp = await sfApiFetch(
      { kind: 'json', method: 'GET', endpoint: '/services/data', targetOrigin: ORIGIN },
      { fetchImpl, cookieGet: makeCookieGet('SECRET') },
    );
    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect(resp.bodyText).toBe('{"totalSize":1,"records":[{"Id":"001"}]}');
      expect(Object.keys(resp)).not.toContain('sid');
    }
    expect(JSON.stringify(resp)).not.toContain('SECRET');
  });

  it('injects the Authorization header itself and strips any client-supplied one', async () => {
    let sentHeaders: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      sentHeaders = init.headers as Record<string, string>;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        async text() {
          return '{}';
        },
      } as unknown as Response;
    });
    await sfApiFetch(
      {
        kind: 'json',
        method: 'GET',
        endpoint: '/services/data',
        targetOrigin: ORIGIN,
        headers: { Accept: 'application/json', Authorization: 'Bearer ATTACKER', 'X-Evil': 'yes' },
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch, cookieGet: makeCookieGet('real-sid') },
    );
    expect(sentHeaders.Authorization).toBe('Bearer real-sid');
    expect(sentHeaders.Accept).toBe('application/json');
    // Non-allowlisted headers are dropped.
    expect(sentHeaders['X-Evil']).toBeUndefined();
  });

  it('swaps the SOAP sentinel for the sid inside the SessionHeader only', async () => {
    let sentBody = '';
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = String(init.body);
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/xml' },
        async text() {
          return '<ok/>';
        },
      } as unknown as Response;
    });
    const envelope =
      `<soapenv:Envelope><soapenv:Header><SessionHeader>` +
      `<sessionId>${SOAP_SID_SENTINEL}</sessionId></SessionHeader></soapenv:Header>` +
      `<soapenv:Body><query><queryString>${SOAP_SID_SENTINEL} is not a session</queryString></query></soapenv:Body>` +
      `</soapenv:Envelope>`;
    await sfApiFetch(
      {
        kind: 'soap',
        method: 'POST',
        endpoint: '/services/Soap/u/v62.0?cache=0.5',
        targetOrigin: ORIGIN,
        headers: { 'Content-Type': 'text/xml' },
        body: envelope,
        soap: { sentinel: SOAP_SID_SENTINEL },
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch, cookieGet: makeCookieGet('SOAP-SID') },
    );
    expect(sentBody).toContain('<sessionId>SOAP-SID</sessionId>');
    // The sentinel inside the body args is NOT replaced — only the SessionHeader.
    expect(sentBody).toContain(`${SOAP_SID_SENTINEL} is not a session`);
    // And the header no longer holds the sentinel.
    expect(sentBody).not.toContain(`<sessionId>${SOAP_SID_SENTINEL}</sessionId>`);
  });
});
