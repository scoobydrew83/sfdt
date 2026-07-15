import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SalesforceApiClient,
  configureSalesforceApi,
  getSalesforceApi,
  _resetSalesforceApiSingletonForTests,
  type MessageBus,
} from '../lib/salesforce-api.js';
import type { SfApiFetchResponse } from '../lib/sf-api-proxy.js';

function fakeWin(href: string): Window {
  const u = new URL(href);
  return {
    location: { href, hostname: u.hostname, origin: u.origin, search: u.search },
  } as unknown as Window;
}

// A message bus that answers the two worker routes the client uses:
//  - sfApiFetch  → a proxied REST/Tooling/SOAP response (bodyText, never a sid)
//  - getSidForUrls → the Event-Monitor session bridge (temporary PR2 exception)
// `proxy` may be a single response or a queue consumed in call order.
function makeBus(opts: {
  proxy?: SfApiFetchResponse | SfApiFetchResponse[];
  sids?: Record<string, string | null>;
}): MessageBus {
  const queue = Array.isArray(opts.proxy) ? [...opts.proxy] : null;
  return {
    sendMessage: vi.fn(async (msg: { action?: string }) => {
      if (msg.action === 'getSidForUrls') return { ok: true, sids: opts.sids ?? {} };
      if (msg.action === 'sfApiFetch') {
        if (queue) return queue.shift() ?? { ok: false, errors: [] };
        return opts.proxy ?? { ok: false, errors: [] };
      }
      return null;
    }) as unknown as MessageBus['sendMessage'],
  };
}

function jsonOk(body: unknown, status = 200): SfApiFetchResponse {
  return {
    ok: true,
    status,
    bodyText: typeof body === 'string' ? body : JSON.stringify(body),
    contentType: 'application/json',
    baseUrl: 'https://x.my.salesforce.com',
  };
}

const WIN = 'https://x.lightning.force.com/anything';

describe('extension/lib/salesforce-api (thin client over sfApiFetch)', () => {
  describe('getFlowIdFromUrl', () => {
    it('returns the flowId param when present', () => {
      const client = new SalesforceApiClient({
        win: fakeWin(
          'https://x.lightning.force.com/builder_platform_interaction/flowBuilder.app?flowId=300abc',
        ),
      });
      expect(client.getFlowIdFromUrl()).toBe('300abc');
    });

    it('returns null when flowId is absent', () => {
      const client = new SalesforceApiClient({ win: fakeWin(WIN) });
      expect(client.getFlowIdFromUrl()).toBeNull();
    });
  });

  describe('message forwarding', () => {
    it('forwards a correctly-shaped sfApiFetch message and parses bodyText', async () => {
      const bus = makeBus({ proxy: jsonOk({ totalSize: 1, done: true, records: [{ Id: '001' }] }) });
      const client = new SalesforceApiClient({
        win: fakeWin(WIN),
        messageBus: bus,
        targetOrigin: 'https://x.lightning.force.com',
      });
      const result = await client.query('SELECT Id FROM Account');
      expect(result.records).toEqual([{ Id: '001' }]);

      const sent = (bus.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(sent.action).toBe('sfApiFetch');
      expect(sent.kind).toBe('json');
      expect(sent.method).toBe('GET');
      expect(sent.endpoint).toBe('/services/data/v62.0/query');
      expect(sent.query).toEqual({ q: 'SELECT Id FROM Account' });
      expect(sent.targetOrigin).toBe('https://x.lightning.force.com');
      // The client must never send a sid or an Authorization header.
      expect(JSON.stringify(sent)).not.toContain('Authorization');
      expect(JSON.stringify(sent).toLowerCase()).not.toContain('bearer');
    });

    it('serialises the request body for apiRequest', async () => {
      const bus = makeBus({ proxy: jsonOk({ id: '001new', success: true }, 201) });
      const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
      const result = await client.apiRequest('POST', '/services/data/v62.0/sobjects/Account', {
        Name: 'New Account',
      });
      expect(result).toMatchObject({ id: '001new', success: true });
      const sent = (bus.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(sent.method).toBe('POST');
      expect(String(sent.body)).toContain('New Account');
    });

    it('returns null for a 204 response', async () => {
      const bus = makeBus({
        proxy: {
          ok: true,
          status: 204,
          bodyText: '',
          contentType: 'application/json',
          baseUrl: 'https://x.my.salesforce.com',
        },
      });
      const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
      expect(
        await client.apiRequest('DELETE', '/services/data/v62.0/sobjects/Account/001'),
      ).toBeNull();
    });
  });

  describe('error handling', () => {
    it('shapes an ok:false response into a short buildRequestError', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const bus = makeBus({
        proxy: {
          ok: false,
          errors: [
            {
              baseUrl: 'https://x.my.salesforce.com',
              status: 400,
              errorText: '[{"message":"unexpected token: FRM","errorCode":"MALFORMED_QUERY"}]',
            },
          ],
        },
      });
      const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
      const err: Error = await client.query('SELECT Id FRM Account').then(
        () => {
          throw new Error('expected reject');
        },
        (e: Error) => e,
      );
      expect(err.message).toContain('GET request failed');
      expect(err.message).toContain('HTTP 400');
      expect(err.message).toContain('unexpected token: FRM');
      expect(err.message).not.toContain('https://');
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('throws "No Salesforce session" when the proxy returns no errors', async () => {
      const bus = makeBus({ proxy: { ok: false, errors: [] } });
      const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
      await expect(client.toolingQuery('SELECT Id FROM Flow')).rejects.toThrow(
        /No Salesforce session/,
      );
    });

    it('throws "No Salesforce session" when the bus times out (null)', async () => {
      const bus: MessageBus = {
        sendMessage: (async () => null) as unknown as MessageBus['sendMessage'],
      };
      const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
      await expect(client.toolingQuery('SELECT Id FROM Flow')).rejects.toThrow(
        /No Salesforce session/,
      );
    });

    it('rejects endpoints that do not start with /', async () => {
      const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: makeBus({}) });
      await expect(client.apiGet('services/data')).rejects.toThrow(/must start with/);
      await expect(client.apiRequest('POST', 'services/data', {})).rejects.toThrow(/must start with/);
      await expect(client.apiGetText('services/data')).rejects.toThrow(/must start with/);
    });
  });

  describe('apiGetText', () => {
    it('returns the raw response body as text (not JSON-parsed)', async () => {
      const bus = makeBus({ proxy: jsonOk('08:00:00.0 (1)|USER_DEBUG|[1]|DEBUG|Hello') });
      const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
      const text = await client.apiGetText(
        '/services/data/v62.0/tooling/sobjects/ApexLog/07L000000000001/Body',
      );
      expect(text).toContain('USER_DEBUG');
      const sent = (bus.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        kind: string;
      };
      expect(sent.kind).toBe('text');
    });
  });

  describe('query helpers', () => {
    it('limits() returns the parsed map', async () => {
      const bus = makeBus({
        proxy: jsonOk({ DailyApiRequests: { Max: 15000, Remaining: 12345 } }),
      });
      const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
      const result = await client.limits();
      expect(result.DailyApiRequests).toEqual({ Max: 15000, Remaining: 12345 });
    });

    it('rawRequest routes GET and POST correctly', async () => {
      const getBus = makeBus({ proxy: jsonOk({ name: 'Account' }) });
      const getClient = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: getBus });
      expect(
        await getClient.rawRequest('GET', '/services/data/v62.0/sobjects/Account/describe'),
      ).toMatchObject({ name: 'Account' });
      expect(
        (getBus.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { method: string },
      ).toMatchObject({ method: 'GET' });

      const postBus = makeBus({ proxy: jsonOk({ id: '001', success: true }, 201) });
      const postClient = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: postBus });
      expect(
        await postClient.rawRequest('POST', '/services/data/v62.0/sobjects/Account', { Name: 'x' }),
      ).toMatchObject({ id: '001' });
    });
  });

  describe('getFlowMetadata', () => {
    it('returns the active version when DefinitionId matches', async () => {
      const bus = makeBus({
        proxy: jsonOk({
          size: 1,
          done: true,
          records: [{ Id: '301', MasterLabel: 'Active Flow' }],
        }),
      });
      const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
      const meta = await client.getFlowMetadata('300AB000000xyz1');
      expect(meta).toMatchObject({ Id: '301', MasterLabel: 'Active Flow' });
    });

    it('falls back to Id lookup when DefinitionId returns nothing', async () => {
      const FLOW_ID = '301AB000000xyz1';
      const bus = makeBus({
        proxy: [
          jsonOk({ size: 0, done: true, records: [] }),
          jsonOk({ size: 1, done: true, records: [{ Id: FLOW_ID, MasterLabel: 'Direct' }] }),
        ],
      });
      const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
      const meta = await client.getFlowMetadata(FLOW_ID);
      expect(meta).toMatchObject({ Id: FLOW_ID, MasterLabel: 'Direct' });
    });

    it('throws when neither lookup yields a record', async () => {
      const bus = makeBus({ proxy: jsonOk({ size: 0, done: true, records: [] }) });
      const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
      await expect(client.getFlowMetadata('missing')).rejects.toThrow(/No flow found/);
    });
  });

  describe('apiSoap', () => {
    function soapOk(xml: string): SfApiFetchResponse {
      return { ok: true, status: 200, bodyText: xml, contentType: 'text/xml', baseUrl: 'https://x.my.salesforce.com' };
    }

    it('builds an envelope with the sid sentinel and parses the response', async () => {
      const xml = [
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">',
        '<soapenv:Body>',
        '<getUserInfoResponse xmlns="urn:partner.soap.sforce.com">',
        '<result><userName>admin@example.com</userName></result>',
        '</getUserInfoResponse>',
        '</soapenv:Body></soapenv:Envelope>',
      ].join('');
      const bus = makeBus({ proxy: soapOk(xml) });
      const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
      const result = await client.apiSoap<{ userName: string }>('Partner', 'getUserInfo', {});
      expect(result).toMatchObject({ userName: 'admin@example.com' });

      const sent = (bus.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        kind: string;
        body: string;
        soap: { sentinel: string };
      };
      expect(sent.kind).toBe('soap');
      // The page never puts a real sid in the envelope — only the sentinel.
      expect(sent.body).toContain(sent.soap.sentinel);
      expect(sent.body.toLowerCase()).toContain('sessionid');
    });

    it('surfaces a SOAP fault as a SalesforceSoapError with the faultstring', async () => {
      const faultXml = [
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">',
        '<soapenv:Body><soapenv:Fault>',
        '<soapenv:faultstring>INVALID_TYPE: sObject type Bogus is not supported</soapenv:faultstring>',
        '</soapenv:Fault></soapenv:Body></soapenv:Envelope>',
      ].join('');
      const bus = makeBus({
        proxy: {
          ok: false,
          errors: [{ baseUrl: 'https://x.my.salesforce.com', status: 500, errorText: faultXml }],
        },
      });
      const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
      await expect(client.apiSoap('Partner', 'describeSObject', { sObjectType: 'Bogus' })).rejects.toThrow(
        'INVALID_TYPE: sObject type Bogus is not supported',
      );
    });

    it('builds the Metadata-namespaced envelope', async () => {
      const xml = [
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">',
        '<soapenv:Body>',
        '<readMetadataResponse xmlns="http://soap.sforce.com/2006/04/metadata">',
        '<result><records><fullName>My_Flow</fullName></records></result>',
        '</readMetadataResponse>',
        '</soapenv:Body></soapenv:Envelope>',
      ].join('');
      const bus = makeBus({ proxy: soapOk(xml) });
      const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
      const result = await client.apiSoap<{ records: unknown }>('Metadata', 'readMetadata', { type: 'Flow' });
      expect(result).toMatchObject({ records: { fullName: 'My_Flow' } });
      const sent = (bus.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { body: string };
      expect(sent.body).toContain('xmlns:met="http://soap.sforce.com/2006/04/metadata"');
      expect(sent.body.toLowerCase()).toContain('met:sessionheader');
    });
  });

  describe('getSessionDetails (Event-Monitor bridge; PR2 exception)', () => {
    it('returns the preferred session candidate via getSidForUrls', async () => {
      const bus = makeBus({
        sids: {
          'https://x.my.salesforce.com': 'sid-mysf',
          'https://x.lightning.force.com': 'sid-light',
        },
      });
      const client = new SalesforceApiClient({
        win: fakeWin(WIN),
        messageBus: bus,
        targetOrigin: 'https://x.lightning.force.com',
      });
      const details = await client.getSessionDetails();
      expect(details).toEqual({ baseUrl: 'https://x.my.salesforce.com', sid: 'sid-mysf' });
    });

    it('returns null when no sid is available', async () => {
      const bus = makeBus({ sids: {} });
      const client = new SalesforceApiClient({
        win: fakeWin(WIN),
        messageBus: bus,
        targetOrigin: 'https://x.lightning.force.com',
      });
      expect(await client.getSessionDetails()).toBeNull();
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

  describe('defaultMessageBus (real chrome.runtime path)', () => {
    const realSendMessage = chrome.runtime.sendMessage;
    afterEach(() => {
      (chrome.runtime as { sendMessage: unknown }).sendMessage = realSendMessage;
      (chrome.runtime as { lastError?: unknown }).lastError = undefined;
    });

    it('resolves a proxied response via chrome.runtime.sendMessage', async () => {
      (chrome.runtime as { sendMessage: unknown }).sendMessage = (
        _msg: unknown,
        cb: (resp: unknown) => void,
      ) => cb(jsonOk({ size: 0, done: true, records: [] }));
      const client = new SalesforceApiClient({ win: fakeWin(WIN) });
      const result = await client.toolingQuery('SELECT Id FROM Flow');
      expect(result.records).toEqual([]);
    });

    it('throws No Salesforce session when chrome.runtime.lastError is set', async () => {
      (chrome.runtime as { sendMessage: unknown }).sendMessage = (
        _msg: unknown,
        cb: (resp: unknown) => void,
      ) => {
        (chrome.runtime as { lastError?: unknown }).lastError = { message: 'port closed' };
        cb(undefined);
      };
      const client = new SalesforceApiClient({ win: fakeWin(WIN) });
      await expect(client.toolingQuery('SELECT Id FROM Flow')).rejects.toThrow(/No Salesforce session/);
    });

    it('throws No Salesforce session when sendMessage throws synchronously', async () => {
      (chrome.runtime as { sendMessage: unknown }).sendMessage = () => {
        throw new Error('extension context invalidated');
      };
      const client = new SalesforceApiClient({ win: fakeWin(WIN) });
      await expect(client.toolingQuery('SELECT Id FROM Flow')).rejects.toThrow(/No Salesforce session/);
    });
  });
});
