import { describe, it, expect, vi } from 'vitest';
import { createBridgeClient } from '../lib/sfdt-bridge.js';
function fakeSendMessage(body: unknown, ok = true) {
  return async () => ({ ok, body });
}
describe('createBridgeClient.getServerInfo', () => {
  it('returns the full ping payload including disabledFeatures when the bridge is reachable', async () => {
    const client = createBridgeClient({
      token: 'token-x',
      preferredTransport: 'localhost',
      sendMessageImpl: fakeSendMessage({
        ok: true,
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
        data: { pong: true, serverVersion: '0.8.1', transport: 'localhost' },
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
          transport: 'localhost',
          disabledFeatures: ['canvas-search'],
        },
      }),
    );
    const client = createBridgeClient({
      token: '',
      preferredTransport: 'localhost',
      sendMessageImpl: sendSpy,
    });
    const info = await client.getServerInfo();
    expect(info).toEqual({
      serverVersion: '0.9.0',
      transport: 'localhost',
      disabledFeatures: ['canvas-search'],
    });
    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ action: 'bridgePing' }));
  });
});
