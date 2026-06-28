import { describe, it, expect, vi, afterEach } from 'vitest';
import { createBridgeClient, getBridgeData, type BridgeFailureEvent } from '../lib/sfdt-bridge.js';

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
          protocolVersion: '1.2',
          transport: 'localhost',
          disabledFeatures: ['canvas-search'],
        },
      }),
    });
    const info = await client.getServerInfo();
    expect(info).toEqual({
      serverVersion: '0.9.0',
      protocolVersion: '1.2',
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
        data: { pong: true, serverVersion: '0.8.1', protocolVersion: '1.2', transport: 'localhost' },
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
          protocolVersion: '1.2',
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
      protocolVersion: '1.2',
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

describe('createBridgeClient — bridge failure telemetry hook', () => {
  it('emits ONE offline event per logical call even when the idempotent retry also fails', async () => {
    const onBridgeFailure = vi.fn((_f: BridgeFailureEvent) => {});
    const fetchSpy = vi.fn(async () => {
      throw new Error('network down');
    });
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      fetchImpl: fetchSpy as unknown as typeof fetch,
      onBridgeFailure,
    });
    const res = await client.send({ requestId: 'r1', kind: 'version' });
    expect(res.ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // two attempts…
    expect(onBridgeFailure).toHaveBeenCalledOnce(); // …one event
    expect(onBridgeFailure).toHaveBeenCalledWith({ kind: 'version', category: 'offline' });
  });

  it('emits unauthorized when the bearer token is missing', async () => {
    const onBridgeFailure = vi.fn((_f: BridgeFailureEvent) => {});
    const client = createBridgeClient({
      token: '',
      preferredTransport: 'localhost',
      fetchImpl: vi.fn() as unknown as typeof fetch,
      onBridgeFailure,
    });
    const res = await client.send({ requestId: 'r2', kind: 'ping' });
    expect(res.ok).toBe(false);
    expect(onBridgeFailure).toHaveBeenCalledOnce();
    expect(onBridgeFailure).toHaveBeenCalledWith({ kind: 'ping', category: 'unauthorized' });
  });

  it('emits protocol when a major version mismatch blocks the call locally', async () => {
    const onBridgeFailure = vi.fn((_f: BridgeFailureEvent) => {});
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      sendMessageImpl: async () => ({
        ok: true,
        body: {
          ok: true,
          data: {
            pong: true,
            serverVersion: '2.0.0',
            protocolVersion: '2.0',
            transport: 'localhost',
            disabledFeatures: [],
          },
        },
      }),
      onBridgeFailure,
    });
    await client.getServerInfo();
    onBridgeFailure.mockClear(); // only interested in the send() below
    const res = await client.send({ requestId: 'r3', kind: 'quality', flowXml: '{}' });
    expect(res.ok).toBe(false);
    expect(onBridgeFailure).toHaveBeenCalledOnce();
    expect(onBridgeFailure).toHaveBeenCalledWith({ kind: 'quality', category: 'protocol' });
  });

  it('never emits for telemetry.* kinds (no recursion when telemetry ships over the bridge)', async () => {
    const onBridgeFailure = vi.fn((_f: BridgeFailureEvent) => {});
    const fetchSpy = vi.fn(async () => {
      throw new Error('network down');
    });
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      fetchImpl: fetchSpy as unknown as typeof fetch,
      onBridgeFailure,
    });
    const res = await client.send({
      requestId: 'r4',
      kind: 'telemetry.snapshot',
      monthKey: '2026-06',
      counters: {},
    });
    expect(res.ok).toBe(false);
    expect(onBridgeFailure).not.toHaveBeenCalled();
  });

  it('does not emit on a successful call', async () => {
    const onBridgeFailure = vi.fn((_f: BridgeFailureEvent) => {});
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, requestId: 'r5', data: { version: '0.9.0' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      fetchImpl: fetchSpy as unknown as typeof fetch,
      onBridgeFailure,
    });
    const res = await client.send({ requestId: 'r5', kind: 'version' });
    expect(res.ok).toBe(true);
    expect(onBridgeFailure).not.toHaveBeenCalled();
  });

  it('a throwing hook never affects the bridge call result', async () => {
    const onBridgeFailure = vi.fn(() => {
      throw new Error('hook exploded');
    });
    const fetchSpy = vi.fn(async () => {
      throw new Error('network down');
    });
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      fetchImpl: fetchSpy as unknown as typeof fetch,
      onBridgeFailure,
    });
    const res = await client.send({ requestId: 'r6', kind: 'ping' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('BRIDGE_OFFLINE');
  });
});

/**
 * Fake chrome.runtime.connectNative port. `handler` maps the posted request to
 * the response delivered on onMessage. Override `onConnect` to simulate connect
 * errors, postMessage throws, or onDisconnect firing.
 */
function makeNativeConnect(
  handler: (req: { requestId: string; kind: string }) => unknown,
  opts: {
    throwOnConnect?: boolean;
    throwOnPost?: boolean;
    disconnect?: boolean;
    silent?: boolean;
  } = {},
): typeof chrome.runtime.connectNative {
  return ((_name: string) => {
    if (opts.throwOnConnect) throw new Error('host not found');
    let msgListener: ((msg: unknown) => void) | undefined;
    let discListener: (() => void) | undefined;
    return {
      onMessage: { addListener: (l: (msg: unknown) => void) => { msgListener = l; } },
      onDisconnect: { addListener: (l: () => void) => { discListener = l; } },
      postMessage: (req: { requestId: string; kind: string }) => {
        if (opts.throwOnPost) throw new Error('pipe broken');
        if (opts.disconnect) {
          queueMicrotask(() => discListener?.());
          return;
        }
        if (opts.silent) return; // never answers → exercises the timeout path
        queueMicrotask(() => msgListener?.(handler(req)));
      },
      disconnect: () => {},
    } as unknown as chrome.runtime.Port;
  }) as unknown as typeof chrome.runtime.connectNative;
}

function nativePong(req: { requestId: string }) {
  return {
    ok: true,
    requestId: req.requestId,
    data: {
      pong: true,
      serverVersion: '0.9.0',
      protocolVersion: '1.2',
      transport: 'native',
      disabledFeatures: [],
    },
  };
}

describe('createBridgeClient — native transport', () => {
  it('sends over the native host and resolves the port response', async () => {
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'native',
      connectNativeImpl: makeNativeConnect((req) => ({ ok: true, requestId: req.requestId, data: { version: '0.9.0' } })),
    });
    const res = await client.send({ requestId: 'n1', kind: 'version' });
    expect(res.ok).toBe(true);
  });

  it('returns BRIDGE_OFFLINE when connectNative throws', async () => {
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'native',
      connectNativeImpl: makeNativeConnect(() => ({}), { throwOnConnect: true }),
    });
    const res = await client.send({ requestId: 'n2', kind: 'version' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('BRIDGE_OFFLINE');
      expect(res.error).toContain('Could not connect to native host');
    }
  });

  it('returns BRIDGE_OFFLINE when postMessage throws', async () => {
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'native',
      connectNativeImpl: makeNativeConnect(() => ({}), { throwOnPost: true }),
    });
    const res = await client.send({ requestId: 'n3', kind: 'version' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('postMessage failed');
  });

  it('returns BRIDGE_OFFLINE when the port disconnects', async () => {
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'native',
      connectNativeImpl: makeNativeConnect(() => ({}), { disconnect: true }),
    });
    const res = await client.send({ requestId: 'n4', kind: 'version' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('BRIDGE_OFFLINE');
  });

  it('times out a silent native host within the per-call timeout', async () => {
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'native',
      connectNativeImpl: makeNativeConnect(() => ({}), { silent: true }),
    });
    const res = await client.send({ requestId: 'n5', kind: 'deploy', flowApiName: 'F' }, { timeoutMs: 30 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('timed out');
  });

  it('reports native host unavailable when no connectNative is provided', async () => {
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'native',
      // no connectNativeImpl
    });
    const res = await client.send({ requestId: 'n6', kind: 'version' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('Native messaging host is not available');
  });
});

describe('createBridgeClient — auto transport fallback (sendOnce)', () => {
  it('falls back to native when localhost is BRIDGE_OFFLINE', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('connection refused');
    });
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'auto',
      fetchImpl: fetchSpy as unknown as typeof fetch,
      connectNativeImpl: makeNativeConnect((req) => ({ ok: true, requestId: req.requestId, data: { version: '0.9.0' } })),
    });
    const res = await client.send({ requestId: 'a1', kind: 'version' });
    expect(res.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('surfaces a non-offline localhost error instead of shadowing it with native', async () => {
    // localhost answers with a structured non-offline error → that wins.
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, requestId: 'a2', error: 'boom', code: 'BRIDGE_INTERNAL' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const nativeSpy = vi.fn(makeNativeConnect((req) => ({ ok: true, requestId: req.requestId, data: {} })));
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'auto',
      fetchImpl: fetchSpy as unknown as typeof fetch,
      connectNativeImpl: nativeSpy as unknown as typeof chrome.runtime.connectNative,
    });
    const res = await client.send({ requestId: 'a2', kind: 'version' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('BRIDGE_INTERNAL');
    expect(nativeSpy).not.toHaveBeenCalled();
  });

  it('returns the localhost offline result when no native transport exists', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('connection refused');
    });
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'auto',
      fetchImpl: fetchSpy as unknown as typeof fetch,
      // no connectNativeImpl
    });
    const res = await client.send({ requestId: 'a3', kind: 'deploy', flowApiName: 'F' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('BRIDGE_OFFLINE');
  });

  it('categorizes an unknown error code as "other" in the failure hook', async () => {
    const onBridgeFailure = vi.fn();
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, requestId: 'a4', error: 'weird', code: 'BRIDGE_INTERNAL' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      fetchImpl: fetchSpy as unknown as typeof fetch,
      onBridgeFailure,
    });
    await client.send({ requestId: 'a4', kind: 'deploy', flowApiName: 'F' });
    expect(onBridgeFailure).toHaveBeenCalledWith({ kind: 'deploy', category: 'other' });
  });
});

describe('createBridgeClient — localhost unrecognisable response', () => {
  it('returns BRIDGE_OFFLINE when the body is JSON but has no `ok` field', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ unexpected: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const res = await client.send({ requestId: 'u1', kind: 'version' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('BRIDGE_OFFLINE');
      expect(res.error).toContain('unrecognisable response');
    }
  });
});

describe('createBridgeClient — discover', () => {
  it('localhost: returns "localhost" when the probe succeeds', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, requestId: 'discover', data: { version: '0.9.0' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(await client.discover()).toBe('localhost');
  });

  it('localhost: returns "unknown" when the probe fails', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('refused');
    });
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(await client.discover()).toBe('unknown');
  });

  it('native: returns "native" when the probe succeeds', async () => {
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'native',
      connectNativeImpl: makeNativeConnect(nativePong),
    });
    expect(await client.discover()).toBe('native');
  });

  it('native: returns "unknown" when the probe disconnects', async () => {
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'native',
      connectNativeImpl: makeNativeConnect(() => ({}), { disconnect: true }),
    });
    expect(await client.discover()).toBe('unknown');
  });

  it('auto: the first SUCCESSFUL transport wins (localhost up, no native)', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, requestId: 'discover-local', data: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'auto',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(await client.discover()).toBe('localhost');
  });

  it('auto: native wins when localhost is down but the native host answers', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('refused');
    });
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'auto',
      fetchImpl: fetchSpy as unknown as typeof fetch,
      connectNativeImpl: makeNativeConnect(nativePong),
    });
    expect(await client.discover()).toBe('native');
  });

  it('auto: returns "unknown" when every probe rejects', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('refused');
    });
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'auto',
      fetchImpl: fetchSpy as unknown as typeof fetch,
      // no native
    });
    expect(await client.discover()).toBe('unknown');
  });
});

describe('createBridgeClient — default chrome.runtime transport (no sendMessageImpl)', () => {
  const realSendMessage = chrome.runtime.sendMessage;
  afterEach(() => {
    (chrome.runtime as { sendMessage: unknown }).sendMessage = realSendMessage;
    (chrome.runtime as { lastError?: unknown }).lastError = undefined;
  });

  it('routes getServerInfo through chrome.runtime.sendMessage and parses the ping', async () => {
    (chrome.runtime as { sendMessage: unknown }).sendMessage = (
      _msg: unknown,
      cb: (resp: unknown) => void,
    ) => {
      cb({
        ok: true,
        body: {
          ok: true,
          data: {
            pong: true,
            serverVersion: '0.9.0',
            protocolVersion: '1.2',
            transport: 'localhost',
            disabledFeatures: [],
          },
        },
      });
    };
    const client = createBridgeClient({ token: 'token-x', preferredTransport: 'localhost' });
    const info = await client.getServerInfo();
    expect(info?.serverVersion).toBe('0.9.0');
    expect(info?.transport).toBe('localhost');
  });

  it('returns null when chrome.runtime.lastError is set', async () => {
    (chrome.runtime as { sendMessage: unknown }).sendMessage = (
      _msg: unknown,
      cb: (resp: unknown) => void,
    ) => {
      (chrome.runtime as { lastError?: unknown }).lastError = { message: 'no receiver' };
      cb(undefined);
    };
    const client = createBridgeClient({ token: 'token-x', preferredTransport: 'localhost' });
    expect(await client.getServerInfo()).toBeNull();
  });

  it('returns null when chrome.runtime.sendMessage throws synchronously', async () => {
    (chrome.runtime as { sendMessage: unknown }).sendMessage = () => {
      throw new Error('context invalidated');
    };
    const client = createBridgeClient({ token: 'token-x', preferredTransport: 'localhost' });
    expect(await client.getServerInfo()).toBeNull();
  });
});

describe('createBridgeClient — call() and getServerInfo native fallback', () => {
  it('call() stamps a requestId before sending', async () => {
    const fetchSpy = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, requestId: 'x', data: { version: '0.9.0' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const res = await client.call({ kind: 'version' });
    expect(res.ok).toBe(true);
    const sent = JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body)) as { requestId: string };
    expect(sent.requestId).toBeTruthy();
  });

  it('getServerInfo falls back to the native host when the worker fetch fails', async () => {
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'auto',
      sendMessageImpl: async () => ({ ok: false, error: 'Failed to fetch' }),
      connectNativeImpl: makeNativeConnect(nativePong),
    });
    const info = await client.getServerInfo();
    expect(info).toEqual({
      serverVersion: '0.9.0',
      protocolVersion: '1.2',
      negotiation: { ok: true, severity: 'ok' },
      transport: 'native',
      disabledFeatures: [],
    });
  });

  it('getServerInfo returns null when neither worker nor native answers', async () => {
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'auto',
      sendMessageImpl: async () => ({ ok: false }),
      connectNativeImpl: makeNativeConnect(() => ({}), { disconnect: true }),
    });
    expect(await client.getServerInfo()).toBeNull();
  });
});

describe('getBridgeData', () => {
  it('returns the payload when ok and data is an object', () => {
    const data = getBridgeData<{ serverVersion: string }>({
      ok: true,
      requestId: 'r1',
      data: { serverVersion: '0.9.0' },
    });
    expect(data.serverVersion).toBe('0.9.0');
  });

  it('returns {} when the response is ok but data is missing (contract violation)', () => {
    const response = { ok: true, requestId: 'r2' } as never;
    expect(getBridgeData<{ serverVersion: string }>(response)).toEqual({});
  });

  it('returns {} when data is not an object', () => {
    const response = { ok: true, requestId: 'r3', data: 'oops' } as never;
    expect(getBridgeData<{ serverVersion: string }>(response)).toEqual({});
  });

  it('returns {} for error responses', () => {
    expect(
      getBridgeData<{ serverVersion: string }>({
        ok: false,
        requestId: 'r4',
        error: 'down',
        code: 'BRIDGE_OFFLINE',
      }),
    ).toEqual({});
  });
});
