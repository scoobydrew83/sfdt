import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  SalesforceBayeuxClient,
  resolveStreamSession,
  handleStreamPort,
  type BayeuxMessage,
  type StreamProxyDeps,
  type StreamPort,
} from '../lib/sf-stream-worker.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// A structural mock of chrome.runtime.Port for the worker (server) side.
function makeMockPort(): {
  port: StreamPort;
  posted: unknown[];
  emit: (msg: unknown) => void;
  fireDisconnect: () => void;
} {
  const posted: unknown[] = [];
  let msgCb: ((m: unknown) => void) | null = null;
  let discCb: (() => void) | null = null;
  const port: StreamPort = {
    postMessage: (m: unknown) => posted.push(m),
    onMessage: { addListener: (cb) => { msgCb = cb; } },
    onDisconnect: { addListener: (cb) => { discCb = cb; } },
  };
  return {
    port,
    posted,
    emit: (m) => msgCb?.(m),
    fireDisconnect: () => discCb?.(),
  };
}

describe('SalesforceBayeuxClient', () => {
  it('successfully handshakes, subscribes, and receives messages', async () => {
    const fetchSpy = vi.fn(async (url, options: any) => {
      const body = JSON.parse(options.body);
      const channel = body[0]?.channel;

      if (channel === '/meta/handshake') {
        return {
          ok: true,
          json: async () => [{ channel: '/meta/handshake', clientId: 'client-123', successful: true }],
        } as Response;
      }
      if (channel === '/meta/subscribe') {
        return {
          ok: true,
          json: async () => [
            {
              channel: '/meta/subscribe',
              clientId: 'client-123',
              subscription: '/event/My_Event__e',
              successful: true,
            },
          ],
        } as Response;
      }
      if (channel === '/meta/connect') {
        return {
          ok: true,
          json: async () => [
            {
              channel: '/event/My_Event__e',
              data: { payload: { Message__c: 'Hello World' } },
              successful: true,
            },
          ],
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    const client = new SalesforceBayeuxClient(
      'https://test.salesforce.com',
      'session-id',
      'v62.0',
      fetchSpy as any,
    );

    const receivedMessages: any[] = [];
    const statusChanges: string[] = [];

    client.onMessage((msg) => {
      receivedMessages.push(msg);
      void client.stop();
    });

    client.onStatus((status) => {
      statusChanges.push(status);
    });

    await client.start('/event/My_Event__e', -1);
    await new Promise((r) => setTimeout(r, 10));

    expect(receivedMessages).toEqual([{ payload: { Message__c: 'Hello World' } }]);
    expect(statusChanges).toContain('Initiating handshake...');
    expect(statusChanges).toContain('Handshake successful. Subscribing...');
    expect(statusChanges).toContain('Listening on /event/My_Event__e...');
    expect(statusChanges).toContain('Disconnected');
  });

  it('sends a typed replay extension and delivers typed message data', async () => {
    const connectMessages: BayeuxMessage[] = [
      {
        channel: '/event/My_Event__e',
        data: { payload: { Message__c: 'typed' }, event: { replayId: 7 } },
        ext: { replay: { '/event/My_Event__e': 7 } },
      },
    ];

    const sentBodies: BayeuxMessage[][] = [];
    const fetchSpy = vi.fn(async (url, options: any) => {
      const body = JSON.parse(options.body) as BayeuxMessage[];
      sentBodies.push(body);
      const channel = body[0]?.channel;

      if (channel === '/meta/handshake') {
        return {
          ok: true,
          json: async () => [{ channel: '/meta/handshake', clientId: 'client-123', successful: true }],
        } as Response;
      }
      if (channel === '/meta/subscribe') {
        return {
          ok: true,
          json: async () => [{ channel: '/meta/subscribe', successful: true }],
        } as Response;
      }
      if (channel === '/meta/connect') {
        return { ok: true, json: async () => connectMessages } as Response;
      }
      return { ok: true, json: async () => [{ channel: '/meta/disconnect', successful: true }] } as Response;
    });

    const client = new SalesforceBayeuxClient(
      'https://test.salesforce.com',
      'session-id',
      'v62.0',
      fetchSpy as any,
    );

    const received: unknown[] = [];
    client.onMessage((msg) => {
      received.push(msg);
      void client.stop();
    });

    await client.start('/event/My_Event__e', -5);
    await new Promise((r) => setTimeout(r, 10));

    const subscribeBody = sentBodies.find((b) => b[0]?.channel === '/meta/subscribe');
    expect(subscribeBody?.[0]?.ext?.replay).toEqual({ '/event/My_Event__e': -5 });
    expect(received).toEqual([{ payload: { Message__c: 'typed' }, event: { replayId: 7 } }]);
  });

  it('stops if handshake fails', async () => {
    const fetchSpy = vi.fn(async () => {
      return {
        ok: true,
        json: async () => [{ channel: '/meta/handshake', successful: false, error: 'Bad credentials' }],
      } as Response;
    });

    const client = new SalesforceBayeuxClient(
      'https://test.salesforce.com',
      'session-id',
      'v62.0',
      fetchSpy as any,
    );

    const statusChanges: string[] = [];
    client.onStatus((status) => {
      statusChanges.push(status);
    });

    await client.start('/event/My_Event__e', -1);
    expect(statusChanges).toContain('Connection failed: Bad credentials');
  });

  it('stops if subscription fails', async () => {
    const fetchSpy = vi.fn(async (url, options: any) => {
      const body = JSON.parse(options.body);
      const channel = body[0]?.channel;

      if (channel === '/meta/handshake') {
        return {
          ok: true,
          json: async () => [{ channel: '/meta/handshake', clientId: 'client-123', successful: true }],
        } as Response;
      }
      if (channel === '/meta/subscribe') {
        return {
          ok: true,
          json: async () => [{ channel: '/meta/subscribe', clientId: 'client-123', successful: false, error: 'Forbidden' }],
        } as Response;
      }
      return { ok: false } as Response;
    });

    const client = new SalesforceBayeuxClient(
      'https://test.salesforce.com',
      'session-id',
      'v62.0',
      fetchSpy as any,
    );

    const statusChanges: string[] = [];
    client.onStatus((status) => {
      statusChanges.push(status);
    });

    await client.start('/event/My_Event__e', -1);
    expect(statusChanges).toContain('Connection failed: Forbidden');
  });

  it('reports when connection is lost', async () => {
    const fetchSpy = vi.fn(async (url, options: any) => {
      const body = JSON.parse(options.body);
      const channel = body[0]?.channel;

      if (channel === '/meta/handshake') {
        return {
          ok: true,
          json: async () => [{ channel: '/meta/handshake', clientId: 'client-123', successful: true }],
        } as Response;
      }
      if (channel === '/meta/subscribe') {
        return {
          ok: true,
          json: async () => [
            {
              channel: '/meta/subscribe',
              clientId: 'client-123',
              subscription: '/event/My_Event__e',
              successful: true,
            },
          ],
        } as Response;
      }
      if (channel === '/meta/connect') {
        return {
          ok: true,
          json: async () => [{ channel: '/meta/connect', successful: false, error: 'Connection expired' }],
        } as Response;
      }
      return { ok: false } as Response;
    });

    const client = new SalesforceBayeuxClient(
      'https://test.salesforce.com',
      'session-id',
      'v62.0',
      fetchSpy as any,
    );

    const statusChanges: string[] = [];
    client.onStatus((status) => {
      statusChanges.push(status);
      if (status.includes('Connection lost')) {
        void client.stop();
      }
    });

    await client.start('/event/My_Event__e', -1);
    await new Promise((r) => setTimeout(r, 10));
    expect(statusChanges).toContain('Connection lost: Connection expired');
  });

  it('auto-stops the loop when /meta/connect reports successful === false', async () => {
    let connectCalls = 0;
    const fetchSpy = vi.fn(async (url, options: any) => {
      const body = JSON.parse(options.body);
      const channel = body[0]?.channel;

      if (channel === '/meta/handshake') {
        return {
          ok: true,
          json: async () => [{ channel: '/meta/handshake', clientId: 'client-123', successful: true }],
        } as Response;
      }
      if (channel === '/meta/subscribe') {
        return {
          ok: true,
          json: async () => [
            {
              channel: '/meta/subscribe',
              clientId: 'client-123',
              subscription: '/event/My_Event__e',
              successful: true,
            },
          ],
        } as Response;
      }
      if (channel === '/meta/connect') {
        connectCalls++;
        return {
          ok: true,
          json: async () => [{ channel: '/meta/connect', successful: false, error: 'Invalid client id' }],
        } as Response;
      }
      if (channel === '/meta/disconnect') {
        return { ok: true, json: async () => [{ channel: '/meta/disconnect', successful: true }] } as Response;
      }
      return { ok: false } as Response;
    });

    const client = new SalesforceBayeuxClient(
      'https://test.salesforce.com',
      'session-id',
      'v62.0',
      fetchSpy as any,
    );

    const statusChanges: string[] = [];
    client.onStatus((status) => {
      statusChanges.push(status);
    });

    await client.start('/event/My_Event__e', -1);
    await new Promise((r) => setTimeout(r, 20));

    expect(connectCalls).toBe(1);
    expect(statusChanges).toContain('Connection lost: Invalid client id');
    expect(statusChanges).toContain('Disconnected');
  });

  it('retries connect on HTTP failure and increments attempts with backoff', async () => {
    vi.useFakeTimers();

    let connectCalls = 0;
    const fetchSpy = vi.fn(async (url, options: any) => {
      const body = JSON.parse(options.body);
      const channel = body[0]?.channel;

      if (channel === '/meta/handshake') {
        return {
          ok: true,
          json: async () => [{ channel: '/meta/handshake', clientId: 'client-123', successful: true }],
        } as Response;
      }
      if (channel === '/meta/subscribe') {
        return {
          ok: true,
          json: async () => [
            {
              channel: '/meta/subscribe',
              clientId: 'client-123',
              subscription: '/event/My_Event__e',
              successful: true,
            },
          ],
        } as Response;
      }
      if (channel === '/meta/connect') {
        connectCalls++;
        if (connectCalls === 1) {
          throw new Error('Network error');
        }
        return {
          ok: true,
          json: async () => [{ channel: '/meta/connect', successful: true }],
        } as Response;
      }
      return { ok: false } as Response;
    });

    const client = new SalesforceBayeuxClient(
      'https://test.salesforce.com',
      'session-id',
      'v62.0',
      fetchSpy as any,
    );

    const statusChanges: string[] = [];
    client.onStatus((status) => {
      statusChanges.push(status);
      if (status.includes('attempt 1')) {
        vi.advanceTimersByTime(2000);
      }
      if (connectCalls === 2) {
        void client.stop();
      }
    });

    await client.start('/event/My_Event__e', -1);
    await vi.advanceTimersByTimeAsync(0);

    expect(statusChanges).toContain('Connection error (attempt 1): Network error');
  });
});

describe('resolveStreamSession', () => {
  const deps = (cookieGet: StreamProxyDeps['cookieGet']): StreamProxyDeps => ({
    fetchImpl: fetch,
    cookieGet,
    isAllowedOrigin: () => true,
  });

  it('returns the first candidate host that has a sid (my.salesforce.com first)', async () => {
    const cookieGet = vi.fn(async (url: string) =>
      url.includes('my.salesforce.com') ? 'THE-SID' : null,
    );
    const res = await resolveStreamSession('https://acme.lightning.force.com', deps(cookieGet));
    expect(res).toEqual({ baseUrl: 'https://acme.my.salesforce.com', sid: 'THE-SID' });
  });

  it('returns null when no host yields a sid', async () => {
    const res = await resolveStreamSession('https://acme.lightning.force.com', deps(async () => null));
    expect(res).toBeNull();
  });
});

describe('handleStreamPort', () => {
  it('subscribe over the Port drives the worker Bayeux client and forwards status + events', async () => {
    const fetchSpy = vi.fn(async (url, options: any) => {
      // The sid is injected worker-side here — proof it lives in the worker.
      expect(options.headers.Authorization).toBe('Bearer THE-SID');
      const body = JSON.parse(options.body);
      const channel = body[0]?.channel;
      if (channel === '/meta/handshake') {
        return { ok: true, json: async () => [{ channel: '/meta/handshake', clientId: 'c1', successful: true }] } as Response;
      }
      if (channel === '/meta/subscribe') {
        return { ok: true, json: async () => [{ channel: '/meta/subscribe', successful: true }] } as Response;
      }
      if (channel === '/meta/connect') {
        // Deliver one event, then a connect-lost so the loop stops cleanly.
        return {
          ok: true,
          json: async () => [
            { channel: '/event/My_Event__e', data: { payload: { Message__c: 'hi' } } },
            { channel: '/meta/connect', successful: false, error: 'done' },
          ],
        } as Response;
      }
      return { ok: true, json: async () => [{ channel: '/meta/disconnect', successful: true }] } as Response;
    });

    const { port, posted, emit } = makeMockPort();
    handleStreamPort(port, {
      fetchImpl: fetchSpy as any,
      cookieGet: async () => 'THE-SID',
      senderOrigin: 'https://acme.my.salesforce.com',
      isAllowedOrigin: () => true,
    });

    emit({ cmd: 'subscribe', channelPath: '/event/My_Event__e', replayId: -1 });
    await new Promise((r) => setTimeout(r, 20));

    const statuses = posted.filter((p: any) => p.type === 'status').map((p: any) => p.status);
    expect(statuses).toContain('Initiating handshake...');
    expect(statuses).toContain('Listening on /event/My_Event__e...');

    const events = posted.filter((p: any) => p.type === 'event');
    expect(events).toEqual([{ type: 'event', data: { payload: { Message__c: 'hi' } } }]);

    // The sid must never appear in anything sent back over the Port.
    expect(JSON.stringify(posted)).not.toContain('THE-SID');
  });

  it('reports no session when the worker cannot read a sid', async () => {
    const { port, posted, emit } = makeMockPort();
    handleStreamPort(port, {
      fetchImpl: (async () => ({}) as Response) as typeof fetch,
      cookieGet: async () => null,
      senderOrigin: 'https://acme.my.salesforce.com',
      isAllowedOrigin: () => true,
    });

    emit({ cmd: 'subscribe', channelPath: '/event/My_Event__e', replayId: -1 });
    await new Promise((r) => setTimeout(r, 5));

    expect(posted).toContainEqual({ type: 'status', status: 'No active Salesforce session found.', isError: true });
  });

  it('unsubscribe stops the worker-side client', async () => {
    const stopSpy = vi.spyOn(SalesforceBayeuxClient.prototype, 'stop').mockResolvedValue();
    vi.spyOn(SalesforceBayeuxClient.prototype, 'start').mockResolvedValue();

    const { port, emit } = makeMockPort();
    handleStreamPort(port, {
      fetchImpl: fetch,
      cookieGet: async () => 'THE-SID',
      senderOrigin: 'https://acme.my.salesforce.com',
      isAllowedOrigin: () => true,
    });

    emit({ cmd: 'subscribe', channelPath: '/event/My_Event__e', replayId: -1 });
    await new Promise((r) => setTimeout(r, 5));
    emit({ cmd: 'unsubscribe' });
    expect(stopSpy).toHaveBeenCalled();
  });

  it('Port disconnect stops the worker-side client (MV3 eviction path)', async () => {
    const stopSpy = vi.spyOn(SalesforceBayeuxClient.prototype, 'stop').mockResolvedValue();
    vi.spyOn(SalesforceBayeuxClient.prototype, 'start').mockResolvedValue();

    const { port, emit, fireDisconnect } = makeMockPort();
    handleStreamPort(port, {
      fetchImpl: fetch,
      cookieGet: async () => 'THE-SID',
      senderOrigin: 'https://acme.my.salesforce.com',
      isAllowedOrigin: () => true,
    });

    emit({ cmd: 'subscribe', channelPath: '/event/My_Event__e', replayId: -1 });
    await new Promise((r) => setTimeout(r, 5));
    fireDisconnect();
    expect(stopSpy).toHaveBeenCalled();
  });

  it('rejects a subscribe whose origin cannot be resolved', async () => {
    const { port, posted, emit } = makeMockPort();
    handleStreamPort(port, {
      fetchImpl: fetch,
      cookieGet: async () => 'THE-SID',
      senderOrigin: null,
      isAllowedOrigin: () => false,
    });

    emit({ cmd: 'subscribe', channelPath: '/event/My_Event__e', targetOrigin: 'https://evil.example.com' });
    await new Promise((r) => setTimeout(r, 5));

    expect(posted).toContainEqual({ type: 'status', status: 'No Salesforce session available.', isError: true });
  });

  // Regression (P0-4 PR2): an unsubscribe/disconnect that arrives WHILE the
  // async session lookup is in flight must abort the subscribe — no orphaned,
  // sid-bound long-poll may be started once the lookup resolves.
  it('unsubscribe during the session lookup starts NO client (no orphaned long-poll)', async () => {
    const startSpy = vi.spyOn(SalesforceBayeuxClient.prototype, 'start').mockResolvedValue();
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => [] }) as Response);

    // Deferred cookie read — leaves resolveStreamSession() pending until released.
    let releaseCookie!: () => void;
    const cookieGet = () =>
      new Promise<string>((resolve) => {
        releaseCookie = () => resolve('THE-SID');
      });

    const { port, emit } = makeMockPort();
    handleStreamPort(port, {
      fetchImpl: fetchSpy as any,
      cookieGet,
      senderOrigin: 'https://acme.my.salesforce.com',
      isAllowedOrigin: () => true,
    });

    emit({ cmd: 'subscribe', channelPath: '/event/My_Event__e', replayId: -1 });
    await new Promise((r) => setTimeout(r, 5)); // handler now parked on the cookie read
    emit({ cmd: 'unsubscribe' }); // abort arrives mid-lookup
    releaseCookie(); // lookup resolves AFTER the abort
    await new Promise((r) => setTimeout(r, 5));

    expect(startSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled(); // no Bayeux handshake ever fired
  });

  it('port disconnect during the session lookup starts NO client (no orphaned long-poll)', async () => {
    const startSpy = vi.spyOn(SalesforceBayeuxClient.prototype, 'start').mockResolvedValue();
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => [] }) as Response);

    let releaseCookie!: () => void;
    const cookieGet = () =>
      new Promise<string>((resolve) => {
        releaseCookie = () => resolve('THE-SID');
      });

    const { port, emit, fireDisconnect } = makeMockPort();
    handleStreamPort(port, {
      fetchImpl: fetchSpy as any,
      cookieGet,
      senderOrigin: 'https://acme.my.salesforce.com',
      isAllowedOrigin: () => true,
    });

    emit({ cmd: 'subscribe', channelPath: '/event/My_Event__e', replayId: -1 });
    await new Promise((r) => setTimeout(r, 5));
    fireDisconnect(); // MV3 eviction / tab close mid-lookup
    releaseCookie();
    await new Promise((r) => setTimeout(r, 5));

    expect(startSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
