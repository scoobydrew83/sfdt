import { describe, it, expect, vi } from 'vitest';
import {
  SalesforceApiClient,
  configureSalesforceApi,
  getSalesforceApi,
  _resetSalesforceApiSingletonForTests,
  type MessageBus,
} from '../lib/salesforce-api.js';

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
      // Use anchored hostname checks rather than .includes() so the assertion
      // matches the production hostname guard in extension/lib/hostname.ts —
      // and so CodeQL's incomplete-url-substring-sanitization rule stays
      // happy (a bare .includes('my.salesforce.com') would also match a
      // hostile URL like https://evil.my.salesforce.com.attacker.com/...).
      const hostnames = calls.map((c) => new URL(c).hostname);
      expect(hostnames.some((h) => h.endsWith('.my.salesforce.com'))).toBe(true);
      expect(hostnames.some((h) => h.endsWith('.lightning.force.com'))).toBe(true);
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
      // 15-char shape — the function dispatches by length.
      const FLOW_ID = '300AB000000xyz1';
      const win = fakeWin(`https://x.lightning.force.com/builder_platform_interaction/flowBuilder.app?flowId=${FLOW_ID}`);
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
      const meta = await client.getFlowMetadata(FLOW_ID);
      expect(meta).toMatchObject({ Id: '301', MasterLabel: 'Active Flow' });
    });

    it('falls back to Id lookup when DefinitionId returns nothing', async () => {
      // 15-char Salesforce Id shape — the Id-vs-DeveloperName branch is
      // selected on length, so test fixtures need to match.
      const FLOW_ID = '301AB000000xyz1';
      const win = fakeWin(`https://x.lightning.force.com/anything?flowId=${FLOW_ID}`);
      const bus = makeBus({ 'https://x.my.salesforce.com': 'sid' });
      let call = 0;
      const fetchSpy = vi.fn(async () => {
        call += 1;
        const body =
          call === 1
            ? { size: 0, done: true, records: [] }
            : { size: 1, done: true, records: [{ Id: FLOW_ID, MasterLabel: 'Direct' }] };
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
      const meta = await client.getFlowMetadata(FLOW_ID);
      expect(meta).toMatchObject({ Id: FLOW_ID, MasterLabel: 'Direct' });
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

  describe('query (REST SOQL)', () => {
    it('hits /services/data/vXX/query with q= and returns the REST envelope', async () => {
      const win = fakeWin('https://x.lightning.force.com/anything');
      const bus = makeBus({ 'https://x.my.salesforce.com': 'sid' });
      const fetchSpy = vi.fn(
        fetchResponder({
          'https://x.my.salesforce.com/services/data/v62.0/query': {
            status: 200,
            body: {
              totalSize: 2,
              done: true,
              records: [{ Id: '001', Name: 'Acme' }, { Id: '002', Name: 'Universal' }],
            },
          },
        }),
      );
      const client = new SalesforceApiClient({ win, messageBus: bus, fetchImpl: fetchSpy });
      const result = await client.query('SELECT Id, Name FROM Account LIMIT 2');
      expect(result.totalSize).toBe(2);
      expect(result.done).toBe(true);
      expect(result.records).toHaveLength(2);
      const calls = fetchSpy.mock.calls.map(([url]) => String(url));
      expect(calls[0]).toContain('/services/data/v62.0/query');
      expect(calls[0]).toContain('q=SELECT');
    });

    it('passes nextRecordsUrl through to queryMore unchanged', async () => {
      const win = fakeWin('https://x.lightning.force.com/anything');
      const bus = makeBus({ 'https://x.my.salesforce.com': 'sid' });
      const fetchSpy = vi.fn(
        fetchResponder({
          'https://x.my.salesforce.com/services/data/v62.0/query/01gxx-2000': {
            status: 200,
            body: { totalSize: 4000, done: true, records: [{ Id: '003' }] },
          },
        }),
      );
      const client = new SalesforceApiClient({ win, messageBus: bus, fetchImpl: fetchSpy });
      const result = await client.queryMore('/services/data/v62.0/query/01gxx-2000');
      expect(result.records).toEqual([{ Id: '003' }]);
    });
  });

  describe('limits', () => {
    it('returns the limit map from /services/data/vXX/limits/', async () => {
      const win = fakeWin('https://x.lightning.force.com/anything');
      const bus = makeBus({ 'https://x.my.salesforce.com': 'sid' });
      const fetchSpy = vi.fn(
        fetchResponder({
          'https://x.my.salesforce.com/services/data/v62.0/limits/': {
            status: 200,
            body: {
              DailyApiRequests: { Max: 15000, Remaining: 12345 },
              DataStorageMB: { Max: 1024, Remaining: 900 },
            },
          },
        }),
      );
      const client = new SalesforceApiClient({ win, messageBus: bus, fetchImpl: fetchSpy });
      const result = await client.limits();
      expect(result.DailyApiRequests).toEqual({ Max: 15000, Remaining: 12345 });
      expect(result.DataStorageMB).toEqual({ Max: 1024, Remaining: 900 });
    });
  });

  describe('rawRequest', () => {
    it('routes GET through apiGet', async () => {
      const win = fakeWin('https://x.lightning.force.com/anything');
      const bus = makeBus({ 'https://x.my.salesforce.com': 'sid' });
      const fetchSpy = vi.fn(
        fetchResponder({
          'https://x.my.salesforce.com/services/data/v62.0/sobjects/Account/describe': {
            status: 200,
            body: { name: 'Account', fields: [] },
          },
        }),
      );
      const client = new SalesforceApiClient({ win, messageBus: bus, fetchImpl: fetchSpy });
      const result = await client.rawRequest('GET', '/services/data/v62.0/sobjects/Account/describe');
      expect(result).toMatchObject({ name: 'Account' });
    });

    it('routes POST through apiRequest with the body', async () => {
      const win = fakeWin('https://x.lightning.force.com/anything');
      const bus = makeBus({ 'https://x.my.salesforce.com': 'sid' });
      const fetchSpy = vi.fn(
        fetchResponder({
          'https://x.my.salesforce.com/services/data/v62.0/sobjects/Account': {
            status: 201,
            body: { id: '001new', success: true },
          },
        }),
      );
      const client = new SalesforceApiClient({ win, messageBus: bus, fetchImpl: fetchSpy });
      const result = await client.rawRequest('POST', '/services/data/v62.0/sobjects/Account', {
        Name: 'New Account',
      });
      expect(result).toMatchObject({ id: '001new', success: true });
      // Confirm the body was serialised onto the request.
      const init = fetchSpy.mock.calls[0]?.[1];
      expect(init?.method).toBe('POST');
      expect(init?.body).toContain('New Account');
    });

    it('routes DELETE through apiRequest with no body (204 → null)', async () => {
      const win = fakeWin('https://x.lightning.force.com/anything');
      const bus = makeBus({ 'https://x.my.salesforce.com': 'sid' });
      const fetchSpy = vi.fn(async () => {
        return {
          ok: true,
          status: 204,
          async json() {
            return null;
          },
          async text() {
            return '';
          },
        } as Response;
      });
      const client = new SalesforceApiClient({ win, messageBus: bus, fetchImpl: fetchSpy as typeof fetch });
      const result = await client.rawRequest('DELETE', '/services/data/v62.0/sobjects/Account/001abc');
      expect(result).toBeNull();
    });
  });

  describe('multi-host failure error messages', () => {
    it('throws a short user-facing message with no candidate URL list', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const win = fakeWin('https://x.lightning.force.com/anything');
      const bus = makeBus({
        'https://x.my.salesforce.com': 'sid-mysf',
        'https://x.lightning.force.com': 'sid-light',
      });
      const fetchSpy = vi.fn(
        fetchResponder({
          'https://x.my.salesforce.com/services/data': {
            status: 400,
            body: '[{"message":"unexpected token: FRM","errorCode":"MALFORMED_QUERY"}]',
          },
          'https://x.lightning.force.com/services/data': {
            status: 400,
            body: '[{"message":"unexpected token: FRM","errorCode":"MALFORMED_QUERY"}]',
          },
        }),
      );
      const client = new SalesforceApiClient({ win, messageBus: bus, fetchImpl: fetchSpy });
      const err: Error = await client.query('SELECT Id FRM Account').then(
        () => {
          throw new Error('expected query to reject');
        },
        (e: Error) => e,
      );

      // Short, user-appropriate: operation + status + Salesforce message.
      expect(err.message).toContain('GET request failed');
      expect(err.message).toContain('HTTP 400');
      expect(err.message).toContain('unexpected token: FRM');
      // No host/URL dump in the toast-facing message.
      expect(err.message).not.toContain('https://');
      expect(err.message).not.toContain('All results');

      // Full multi-host diagnostics still reach the console.
      expect(consoleSpy).toHaveBeenCalled();
      const logged = consoleSpy.mock.calls[0]!.map(String).join(' ');
      expect(logged).toContain('https://x.my.salesforce.com');
      expect(logged).toContain('https://x.lightning.force.com');
      consoleSpy.mockRestore();
    });

    it('reports a network error without a fake HTTP status', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const win = fakeWin('https://x.lightning.force.com/anything');
      const bus = makeBus({ 'https://x.my.salesforce.com': 'sid' });
      const fetchSpy = vi.fn(async () => {
        throw new Error('Failed to fetch');
      });
      const client = new SalesforceApiClient({ win, messageBus: bus, fetchImpl: fetchSpy as unknown as typeof fetch });
      await expect(client.apiRequest('POST', '/services/data/v62.0/sobjects/Account', {})).rejects.toThrow(
        /POST request failed \(network error\)/,
      );
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('targetOrigin (Workspace tab)', () => {
    it('derives session candidates from targetOrigin, not win.location', async () => {
      // The Workspace tab's own location is a chrome-extension:// URL with no
      // Salesforce host; targetOrigin must take over.
      const win = fakeWin('chrome-extension://abcdef/app.html');
      const bus = makeBus({
        'https://acme.my.salesforce.com': 'sid-mysf',
        'https://acme.lightning.force.com': 'sid-light',
      });
      const fetchSpy = vi.fn(
        fetchResponder({
          'https://acme.my.salesforce.com/services/data/v62.0/query': {
            status: 200,
            body: { totalSize: 0, done: true, records: [] },
          },
        }),
      );
      const client = new SalesforceApiClient({
        win,
        messageBus: bus,
        fetchImpl: fetchSpy,
        targetOrigin: 'https://acme.lightning.force.com',
      });
      await client.query('SELECT Id FROM Account');
      const calls = fetchSpy.mock.calls.map(([url]) => String(url));
      expect(new URL(calls[0]!).hostname).toBe('acme.my.salesforce.com');
    });
  });

  describe('configureSalesforceApi singleton', () => {
    it('binds the shared singleton and returns a stable instance', () => {
      _resetSalesforceApiSingletonForTests();
      configureSalesforceApi({ targetOrigin: 'https://acme.lightning.force.com' });
      const a = getSalesforceApi();
      const b = getSalesforceApi();
      expect(a).toBe(b);
      expect(a).toBeInstanceOf(SalesforceApiClient);
      _resetSalesforceApiSingletonForTests();
    });
  });

  describe('apiGetText', () => {
    it('returns the raw response body as text (not JSON-parsed)', async () => {
      const win = fakeWin('https://x.lightning.force.com/anything');
      const bus = makeBus({ 'https://x.my.salesforce.com': 'sid' });
      const fetchSpy = vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            async text() {
              return '08:00:00.0 (1)|USER_DEBUG|[1]|DEBUG|Hello';
            },
            async json() {
              throw new Error('should not be called');
            },
          }) as unknown as Response,
      );
      const client = new SalesforceApiClient({
        win,
        messageBus: bus,
        fetchImpl: fetchSpy as typeof fetch,
      });
      const text = await client.apiGetText(
        '/services/data/v62.0/tooling/sobjects/ApexLog/07L000000000001/Body',
      );
      expect(text).toContain('USER_DEBUG');
    });

    it('rejects endpoints that do not start with /', async () => {
      const win = fakeWin('https://x.lightning.force.com/anything');
      const bus = makeBus({ 'https://x.my.salesforce.com': 'sid' });
      const client = new SalesforceApiClient({ win, messageBus: bus });
      await expect(client.apiGetText('services/data')).rejects.toThrow(/must start with/);
    });
  });

  describe('apiSoap SOAP parsing', () => {
    function xmlFetch(status: number, xml: string): typeof fetch {
      return (async () => ({
        ok: status >= 200 && status < 300,
        status,
        async text() {
          return xml;
        },
        async json() {
          return null;
        },
      })) as unknown as typeof fetch;
    }

    it('parses a namespace-prefixed SOAP response body', async () => {
      const win = fakeWin('https://x.lightning.force.com/anything');
      const bus = makeBus({ 'https://x.my.salesforce.com': 'sid' });
      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">',
        '<soapenv:Body>',
        '<ns:getUserInfoResponse xmlns:ns="urn:partner.soap.sforce.com">',
        '<ns:result><ns:userName>admin@example.com</ns:userName></ns:result>',
        '</ns:getUserInfoResponse>',
        '</soapenv:Body>',
        '</soapenv:Envelope>',
      ].join('');
      const client = new SalesforceApiClient({ win, messageBus: bus, fetchImpl: xmlFetch(200, xml) });
      const result = await client.apiSoap<{ userName: string }>('Partner', 'getUserInfo', {});
      expect(result).toMatchObject({ userName: 'admin@example.com' });
    });

    it('parses an unprefixed (default-namespace) SOAP response body', async () => {
      const win = fakeWin('https://x.lightning.force.com/anything');
      const bus = makeBus({ 'https://x.my.salesforce.com': 'sid' });
      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">',
        '<soapenv:Body>',
        '<getUserInfoResponse xmlns="urn:partner.soap.sforce.com">',
        '<result><userName>admin@example.com</userName></result>',
        '</getUserInfoResponse>',
        '</soapenv:Body>',
        '</soapenv:Envelope>',
      ].join('');
      const client = new SalesforceApiClient({ win, messageBus: bus, fetchImpl: xmlFetch(200, xml) });
      const result = await client.apiSoap<{ userName: string }>('Partner', 'getUserInfo', {});
      expect(result).toMatchObject({ userName: 'admin@example.com' });
    });

    it('extracts the faultstring from a namespace-prefixed SOAP fault', async () => {
      const win = fakeWin('https://x.lightning.force.com/anything');
      const bus = makeBus({ 'https://x.my.salesforce.com': 'sid' });
      const faultXml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">',
        '<soapenv:Body>',
        '<soapenv:Fault>',
        '<soapenv:faultcode>sf:INVALID_TYPE</soapenv:faultcode>',
        '<soapenv:faultstring>INVALID_TYPE: sObject type Bogus is not supported</soapenv:faultstring>',
        '</soapenv:Fault>',
        '</soapenv:Body>',
        '</soapenv:Envelope>',
      ].join('');
      const client = new SalesforceApiClient({ win, messageBus: bus, fetchImpl: xmlFetch(500, faultXml) });
      await expect(client.apiSoap('Partner', 'describeSObject', { sObjectType: 'Bogus' })).rejects.toThrow(
        'INVALID_TYPE: sObject type Bogus is not supported',
      );
    });
  });
});
