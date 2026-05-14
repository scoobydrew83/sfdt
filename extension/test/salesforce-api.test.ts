import { describe, it, expect, vi } from 'vitest';
import { SalesforceApiClient, type MessageBus } from '../lib/salesforce-api.js';

function fakeWin(href: string): Window {
  const u = new URL(href);
  return {
    location: {
      href,
      hostname: u.hostname,
      origin: u.origin,
      search: u.search,
    },
  } as unknown as Window;
}

function makeBus(sids: Record<string, string | null>): MessageBus {
  return {
    // The MessageBus signature is generic; tests return a concrete shape and
    // rely on the caller asserting it. Cast keeps the test wiring honest
    // without forcing a generic spy.
    sendMessage: vi.fn(async () => ({ ok: true, sids })) as unknown as MessageBus['sendMessage'],
  };
}

function fetchResponder(
  routes: Record<string, { status: number; body: unknown }>,
): typeof fetch {
  return (async (url: string | URL | Request) => {
    const key = typeof url === 'string' ? url : url.toString();
    for (const [pattern, response] of Object.entries(routes)) {
      if (key.startsWith(pattern)) {
        const ok = response.status >= 200 && response.status < 300;
        return {
          ok,
          status: response.status,
          async json() {
            return response.body;
          },
          async text() {
            return ok ? JSON.stringify(response.body) : String(response.body ?? '');
          },
        } as Response;
      }
    }
    throw new Error(`No fetch stub for URL: ${key}`);
  }) as typeof fetch;
}

describe('extension/lib/salesforce-api', () => {
  describe('getFlowIdFromUrl', () => {
    it('returns the flowId param when present', () => {
      const client = new SalesforceApiClient({
        win: fakeWin('https://x.lightning.force.com/builder_platform_interaction/flowBuilder.app?flowId=300abc'),
      });
      expect(client.getFlowIdFromUrl()).toBe('300abc');
    });

    it('returns null when flowId is absent', () => {
      const client = new SalesforceApiClient({
        win: fakeWin('https://x.lightning.force.com/lightning/setup/Flows/home'),
      });
      expect(client.getFlowIdFromUrl()).toBeNull();
    });
  });

  describe('session candidate ordering', () => {
    it('prefers my.salesforce.com over the current origin', async () => {
      const win = fakeWin('https://x.lightning.force.com/anything');
      const bus = makeBus({
        'https://x.my.salesforce.com': 'sid-mysf',
        'https://x.lightning.force.com': 'sid-light',
      });
      const fetchSpy = vi.fn(
        fetchResponder({
          'https://x.my.salesforce.com/services/data/v62.0/tooling/query': {
            status: 200,
            body: { size: 1, done: true, records: [{ Id: '301' }] },
          },
        }),
      );
      const client = new SalesforceApiClient({ win, messageBus: bus, fetchImpl: fetchSpy });
      const result = await client.toolingQuery('SELECT Id FROM Flow');
      expect(result.records).toEqual([{ Id: '301' }]);
      // We should have hit my.salesforce.com first — and that succeeded — so
      // lightning.force.com should never be called.
      const calls = fetchSpy.mock.calls.map(([url]) => String(url));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('my.salesforce.com');
    });

    it('falls through to the second candidate on 401', async () => {
      const win = fakeWin('https://x.lightning.force.com/anything');
      const bus = makeBus({
        'https://x.my.salesforce.com': 'sid-mysf',
        'https://x.lightning.force.com': 'sid-light',
      });
      const fetchSpy = vi.fn(
        fetchResponder({
          'https://x.my.salesforce.com/services/data': {
            status: 401,
            body: 'unauthorized',
          },
          'https://x.lightning.force.com/services/data': {
            status: 200,
            body: { size: 0, done: true, records: [] },
          },
        }),
      );
      const client = new SalesforceApiClient({ win, messageBus: bus, fetchImpl: fetchSpy });
      const result = await client.toolingQuery('SELECT Id FROM Flow');
      expect(result.records).toEqual([]);
      const calls = fetchSpy.mock.calls.map(([url]) => String(url));
      expect(calls.some((c) => c.includes('my.salesforce.com'))).toBe(true);
      expect(calls.some((c) => c.includes('lightning.force.com'))).toBe(true);
    });

    it('throws when the message bus cannot return any sid', async () => {
      const win = fakeWin('https://x.lightning.force.com/anything');
      const bus: MessageBus = {
        sendMessage: (async () => ({ ok: true, sids: {} })) as unknown as MessageBus['sendMessage'],
      };
      const client = new SalesforceApiClient({ win, messageBus: bus });
      await expect(client.toolingQuery('SELECT Id FROM Flow')).rejects.toThrow(/No Salesforce session/);
    });

    it('throws on a non-401 error', async () => {
      const win = fakeWin('https://x.lightning.force.com/anything');
      const bus = makeBus({ 'https://x.my.salesforce.com': 'sid' });
      const fetchSpy = vi.fn(
        fetchResponder({
          'https://x.my.salesforce.com/services/data': {
            status: 500,
            body: 'internal error',
          },
        }),
      );
      const client = new SalesforceApiClient({ win, messageBus: bus, fetchImpl: fetchSpy });
      await expect(client.toolingQuery('SELECT Id FROM Flow')).rejects.toThrow(/500/);
    });
  });

  describe('apiGet/apiRequest endpoint validation', () => {
    it('rejects endpoints that do not start with /', async () => {
      const win = fakeWin('https://x.lightning.force.com/anything');
      const bus = makeBus({ 'https://x.my.salesforce.com': 'sid' });
      const client = new SalesforceApiClient({ win, messageBus: bus });
      await expect(client.apiGet('services/data')).rejects.toThrow(/must start with/);
      await expect(client.apiRequest('POST', 'services/data', {})).rejects.toThrow(/must start with/);
    });
  });

  describe('getFlowMetadata', () => {
    it('returns the active version when DefinitionId matches', async () => {
      const win = fakeWin('https://x.lightning.force.com/builder_platform_interaction/flowBuilder.app?flowId=300abc');
      const bus = makeBus({ 'https://x.my.salesforce.com': 'sid' });
      const fetchSpy = vi.fn(
        fetchResponder({
          'https://x.my.salesforce.com/services/data/v62.0/tooling/query': {
            status: 200,
            body: {
              size: 1,
              done: true,
              records: [{ Id: '301', MasterLabel: 'Active Flow', Metadata: {} }],
            },
          },
        }),
      );
      const client = new SalesforceApiClient({ win, messageBus: bus, fetchImpl: fetchSpy });
      const meta = await client.getFlowMetadata('300abc');
      expect(meta).toMatchObject({ Id: '301', MasterLabel: 'Active Flow' });
    });

    it('falls back to Id lookup when DefinitionId returns nothing', async () => {
      const win = fakeWin('https://x.lightning.force.com/anything?flowId=301abc');
      const bus = makeBus({ 'https://x.my.salesforce.com': 'sid' });
      let call = 0;
      const fetchSpy = vi.fn(async () => {
        call += 1;
        const body =
          call === 1
            ? { size: 0, done: true, records: [] }
            : { size: 1, done: true, records: [{ Id: '301abc', MasterLabel: 'Direct' }] };
        return {
          ok: true,
          status: 200,
          async json() {
            return body;
          },
          async text() {
            return JSON.stringify(body);
          },
        } as Response;
      });
      const client = new SalesforceApiClient({ win, messageBus: bus, fetchImpl: fetchSpy as typeof fetch });
      const meta = await client.getFlowMetadata('301abc');
      expect(meta).toMatchObject({ Id: '301abc', MasterLabel: 'Direct' });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('throws when neither lookup yields a record', async () => {
      const win = fakeWin('https://x.lightning.force.com/anything?flowId=missing');
      const bus = makeBus({ 'https://x.my.salesforce.com': 'sid' });
      const fetchSpy = vi.fn(
        fetchResponder({
          'https://x.my.salesforce.com/services/data': {
            status: 200,
            body: { size: 0, done: true, records: [] },
          },
        }),
      );
      const client = new SalesforceApiClient({ win, messageBus: bus, fetchImpl: fetchSpy });
      await expect(client.getFlowMetadata('missing')).rejects.toThrow(/No flow found/);
    });
  });
});
