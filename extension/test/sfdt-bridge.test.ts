import { describe, it, expect, vi } from 'vitest';
import { createBridgeClient } from '../lib/sfdt-bridge.js';

function fakeFetch(response: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(response), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
}

describe('createBridgeClient.getServerInfo', () => {
  it('returns the full ping payload including disabledFeatures when the bridge is reachable', async () => {
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      fetchImpl: fakeFetch({
        ok: true,
        requestId: 'discover',
        data: {
          pong: true,
          serverVersion: '0.9.0',
          transport: 'localhost',
          disabledFeatures: ['canvas-search'],
        },
      }),
    });
    const info = await client.getServerInfo();
    expect(info).toEqual({
      serverVersion: '0.9.0',
      transport: 'localhost',
      disabledFeatures: ['canvas-search'],
    });
  });

  it('returns null when the bridge errors out', async () => {
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      fetchImpl: fakeFetch({ ok: false, requestId: 'discover', error: 'offline' }, 500),
    });
    expect(await client.getServerInfo()).toBeNull();
  });

  it('returns an empty disabledFeatures when the field is missing (older server)', async () => {
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      fetchImpl: fakeFetch({
        ok: true,
        requestId: 'discover',
        data: { pong: true, serverVersion: '0.8.1', transport: 'localhost' },
      }),
    });
    const info = await client.getServerInfo();
    expect(info?.disabledFeatures).toEqual([]);
  });

  it('returns null when the bridge returns ok: true but data is missing (defensive)', async () => {
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      fetchImpl: fakeFetch({
        ok: true,
        requestId: 'discover',
        // data field intentionally missing
      }),
    });
    expect(await client.getServerInfo()).toBeNull();
  });

  it('works with no token (uses the unauthenticated GET ping endpoint)', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            pong: true,
            serverVersion: '0.9.0',
            transport: 'localhost',
            disabledFeatures: ['canvas-search'],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;
    const client = createBridgeClient({
      token: '', // explicitly empty — pre-pairing scenario
      preferredTransport: 'localhost',
      fetchImpl: fetchSpy,
    });
    const info = await client.getServerInfo();
    expect(info).toEqual({
      serverVersion: '0.9.0',
      transport: 'localhost',
      disabledFeatures: ['canvas-search'],
    });
    // Confirm the request hit /api/bridge/ping (not /exchange) and used GET
    const callArgs = (fetchSpy as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(callArgs.length).toBeGreaterThan(0);
    const [url, init] = callArgs[0] as [string, RequestInit | undefined];
    expect(url).toContain('/api/bridge/ping');
    expect(url).not.toContain('/exchange');
    expect(init?.method).toBe('GET');
  });
});
