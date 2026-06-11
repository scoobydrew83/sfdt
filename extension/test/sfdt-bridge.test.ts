import { describe, it, expect, vi } from 'vitest';
import { createBridgeClient } from '../lib/sfdt-bridge.js';

/**
 * Build a sendMessage stub that returns the given bridgePing response shape.
 * The background service worker wraps the raw bridge response as
 * `{ ok: true|false, body?, error? }`.
 */
function fakeSendMessage(body: unknown, ok = true) {
  return async () => ({ ok, body });
}

describe('createBridgeClient.getServerInfo', () => {
  it('returns the full ping payload including disabledFeatures and negotiation when the bridge is reachable', async () => {
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      sendMessageImpl: fakeSendMessage({
        ok: true,
        data: {
          pong: true,
          serverVersion: '0.9.0',
          protocolVersion: '1.1',
          transport: 'localhost',
          disabledFeatures: ['canvas-search'],
        },
      }),
    });
    const info = await client.getServerInfo();
    expect(info).toEqual({
      serverVersion: '0.9.0',
      protocolVersion: '1.1',
      negotiation: { ok: true, severity: 'ok' },
      transport: 'localhost',
      disabledFeatures: ['canvas-search'],
    });
  });

  it('returns null when the background worker reports a fetch failure', async () => {
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      sendMessageImpl: async () => ({ ok: false, error: 'Failed to fetch' }),
    });
    expect(await client.getServerInfo()).toBeNull();
  });

  it('returns an empty disabledFeatures when the field is missing (older server)', async () => {
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      sendMessageImpl: fakeSendMessage({
        ok: true,
        data: { pong: true, serverVersion: '0.8.1', protocolVersion: '1.1', transport: 'localhost' },
      }),
    });
    const info = await client.getServerInfo();
    expect(info?.disabledFeatures).toEqual([]);
  });

  it('returns null when the bridge envelope is ok: true but data is missing (defensive)', async () => {
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      sendMessageImpl: fakeSendMessage({
        ok: true,
        // data field intentionally missing
      }),
    });
    expect(await client.getServerInfo()).toBeNull();
  });

  it('works with no token (the kill-switch fetch does NOT require pairing)', async () => {
    const sendSpy = vi.fn(
      fakeSendMessage({
        ok: true,
        data: {
          pong: true,
          serverVersion: '0.9.0',
          protocolVersion: '1.1',
          transport: 'localhost',
          disabledFeatures: ['canvas-search'],
        },
      }),
    );
    const client = createBridgeClient({
      token: '', // explicitly empty — pre-pairing scenario
      preferredTransport: 'localhost',
      sendMessageImpl: sendSpy,
    });
    const info = await client.getServerInfo();
    expect(info).toEqual({
      serverVersion: '0.9.0',
      protocolVersion: '1.1',
      negotiation: { ok: true, severity: 'ok' },
      transport: 'localhost',
      disabledFeatures: ['canvas-search'],
    });
    // Confirm the message routed through the bridgePing action (not POST exchange)
    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ action: 'bridgePing' }));
  });
});

describe('createBridgeClient — protocol negotiation', () => {
  it('flags a minor mismatch as a warn-level negotiation without blocking traffic', async () => {
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      sendMessageImpl: fakeSendMessage({
        ok: true,
        data: {
          pong: true,
          serverVersion: '0.9.0',
          protocolVersion: '1.3',
          transport: 'localhost',
          disabledFeatures: [],
        },
      }),
    });
    const info = await client.getServerInfo();
    expect(info?.negotiation.severity).toBe('warn');
    expect(info?.negotiation.ok).toBe(true);
    expect(client.getNegotiation()?.severity).toBe('warn');
  });

  it('flags a major mismatch as an error and blocks subsequent non-ping sends', async () => {
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      sendMessageImpl: fakeSendMessage({
        ok: true,
        data: {
          pong: true,
          serverVersion: '2.0.0',
          protocolVersion: '2.0',
          transport: 'localhost',
          disabledFeatures: [],
        },
      }),
    });
    const info = await client.getServerInfo();
    expect(info?.negotiation.ok).toBe(false);

    // A non-ping/version send is refused locally without hitting the network.
    const res = await client.send({ requestId: 'r1', kind: 'quality', flowXml: '{}' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('BRIDGE_OFFLINE');
      expect(res.error).toContain('protocol negotiation failed');
    }
  });

  it('still allows ping/version through when the major version mismatches (diagnostics path)', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          requestId: 'r2',
          data: { version: '0.9.0' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      sendMessageImpl: fakeSendMessage({
        ok: true,
        data: {
          pong: true,
          serverVersion: '2.0.0',
          protocolVersion: '2.0',
          transport: 'localhost',
          disabledFeatures: [],
        },
      }),
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    await client.getServerInfo();
    expect(client.getNegotiation()?.ok).toBe(false);

    // version still goes out — diagnostics must keep working
    const res = await client.send({ requestId: 'r2', kind: 'version' });
    expect(res.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('treats a server missing protocolVersion entirely as a major mismatch (legacy server)', async () => {
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      sendMessageImpl: fakeSendMessage({
        ok: true,
        data: {
          pong: true,
          serverVersion: '0.7.0',
          transport: 'localhost',
          // protocolVersion intentionally absent
        },
      }),
    });
    const info = await client.getServerInfo();
    expect(info?.protocolVersion).toBeUndefined();
    expect(info?.negotiation.ok).toBe(false);
  });

  it('getNegotiation returns null before any ping has been made', () => {
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      sendMessageImpl: async () => ({ ok: false }),
    });
    expect(client.getNegotiation()).toBeNull();
  });
});

describe('createBridgeClient — retries and per-call timeout', () => {
  function okResponse(requestId: string, data: unknown = { version: '0.9.0' }) {
    return new Response(JSON.stringify({ ok: true, requestId, data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('retries an idempotent kind once after a transport failure', async () => {
    const fetchSpy = vi.fn(async () => {
      if (fetchSpy.mock.calls.length === 1) throw new Error('network down');
      return okResponse('r1');
    });
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const res = await client.send({ requestId: 'r1', kind: 'version' });
    expect(res.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('gives up after the single retry when the transport keeps failing', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('network down');
    });
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const res = await client.send({ requestId: 'r1', kind: 'ping' });
    expect(res.ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a mutating kind on transport failure', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('network down');
    });
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const res = await client.send({
      requestId: 'r2',
      kind: 'deploy',
      flowApiName: 'My_Flow',
    });
    expect(res.ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('does NOT retry non-transport errors (missing token short-circuits once)', async () => {
    const fetchSpy = vi.fn(async () => okResponse('r3'));
    const client = createBridgeClient({
      token: '', // → BRIDGE_UNAUTHORIZED before any fetch
      preferredTransport: 'localhost',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const res = await client.send({ requestId: 'r3', kind: 'ping' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('BRIDGE_UNAUTHORIZED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('honours a per-call timeoutMs override over the 8s default', async () => {
    // Never resolves except via abort — only the per-call 50ms timeout can
    // bring this test home before the suite timeout.
    const fetchSpy = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const started = Date.now();
    const res = await client.send(
      { requestId: 'r4', kind: 'deploy', flowApiName: 'My_Flow' },
      { timeoutMs: 50 },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('BRIDGE_OFFLINE');
    expect(Date.now() - started).toBeLessThan(4000);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
