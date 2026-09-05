import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SalesforceApiClient,
  configureSalesforceApi,
  getSalesforceApi,
  sfApiErrorKind,
  SalesforceRestError,
  parseRestErrorDetails,
  workerTimeoutError,
  WORKER_TIMEOUT_ERROR_NAME,
  _resetSalesforceApiSingletonForTests,
  type MessageBus,
} from '../lib/salesforce-api.js';
import type { SfApiFetchResponse } from '../lib/sf-api-proxy.js';

// Pinned as literals on purpose: importing the constants from the module under
// test would make every budget assertion tautological. If someone changes a
// budget, these must be changed with intent.
const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 120_000;

function fakeWin(href: string): Window {
  const u = new URL(href);
  return {
    location: { href, hostname: u.hostname, origin: u.origin, search: u.search },
  } as unknown as Window;
}

// A message bus that answers the two worker routes the client uses:
//  - sfApiFetch  → a proxied REST/Tooling/SOAP response (bodyText, never a sid)
// `proxy` may be a single response or a queue consumed in call order.
function makeBus(opts: {
  proxy?: SfApiFetchResponse | SfApiFetchResponse[];
}): MessageBus {
  const queue = Array.isArray(opts.proxy) ? [...opts.proxy] : null;
  return {
    sendMessage: vi.fn(async (msg: { action?: string }) => {
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

    // SOAP service paths take a bare version ("62.0"); REST paths take the "v"
    // prefix. Concatenating apiVersion raw shipped /services/Soap/m/v62.0, which
    // SF rejects with "Invalid Api version specified on URL".
    it.each([
      ['Enterprise', 'c'],
      ['Partner', 'u'],
      ['Apex', 's'],
      ['Metadata', 'm'],
      ['Tooling', 'T'],
    ] as const)('builds the %s SOAP path with a bare version, no "v"', async (apiName, slug) => {
      const bus = makeBus({
        proxy: {
          ok: true,
          status: 200,
          bodyText:
            `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">` +
            `<soapenv:Body><describeMetadataResponse><result/></describeMetadataResponse></soapenv:Body>` +
            `</soapenv:Envelope>`,
          contentType: 'text/xml',
          baseUrl: 'https://x.my.salesforce.com',
        },
      });
      const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
      await client.apiSoap(apiName, 'describeMetadata', {}, { mutating: false });

      const sent = (bus.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(sent.endpoint).toMatch(
        new RegExp(`^/services/Soap/${slug}/62\\.0(\\?|$)`),
      );
      expect(sent.endpoint).not.toContain('/v62.0');
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

    it('throws "No Salesforce session" when the bus resolves null (worker answered with nothing)', async () => {
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

  // The org tells us WHICH field it rejected. Before P4-1 that was flattened
  // into one prose string and thrown away, so no caller could render an error
  // against the field it belongs to. The records are now carried alongside the
  // message — additively: `.message`, `sfdtKind` and `.status` are unchanged.
  describe('SalesforceRestError (structured rejection bodies)', () => {
    function restFailure(errorText: string, status = 400): MessageBus {
      return makeBus({
        proxy: { ok: false, errors: [{ baseUrl: 'https://x.my.salesforce.com', status, errorText }] },
      });
    }

    async function failWith(errorText: string, status = 400): Promise<Error> {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const client = new SalesforceApiClient({
        win: fakeWin(WIN),
        messageBus: restFailure(errorText, status),
      });
      const err: Error = await client
        .apiRequest('PATCH', '/services/data/v62.0/sobjects/Account/001', {})
        .then(
          () => {
            throw new Error('expected reject');
          },
          (e: Error) => e,
        );
      consoleSpy.mockRestore();
      return err;
    }

    it('carries the fields[] and errorCode the org attributed the failure to', async () => {
      const err = await failWith(
        '[{"message":"Value too long","errorCode":"STRING_TOO_LONG","fields":["Name"]}]',
      );
      expect(err).toBeInstanceOf(SalesforceRestError);
      expect((err as SalesforceRestError).details).toEqual([
        { message: 'Value too long', errorCode: 'STRING_TOO_LONG', fields: ['Name'] },
      ]);
      expect((err as SalesforceRestError).status).toBe(400);
    });

    it('leads with the org text unchanged, then adds the code, field and advice', async () => {
      // Every caller reads only `.message`, so the guidance has to live there to
      // reach a user. The org's own first line is preserved byte-for-byte and is
      // never replaced — our text is only ever appended below it.
      const err = await failWith(
        '[{"message":"Value too long","errorCode":"STRING_TOO_LONG","fields":["Name"]}]',
      );
      const [headline, ...rest] = err.message.split('\n');
      expect(headline).toBe('Salesforce PATCH request failed (HTTP 400): Value too long');
      expect(rest.join('\n')).toContain('STRING_TOO_LONG');
      expect(rest.join('\n')).toContain('field: Name');
      expect(rest.join('\n')).toContain('Shorten it');
      expect(sfApiErrorKind(err)).toBe('http-error');
      expect(err).toBeInstanceOf(Error);
    });

    it('normalises a record with no fields[] to an empty array, not undefined', async () => {
      // Object-level validation rules and trigger addError() on the record.
      const err = await failWith(
        '[{"message":"Close date must be in the future","errorCode":"FIELD_CUSTOM_VALIDATION_EXCEPTION"}]',
      );
      expect((err as SalesforceRestError).details).toEqual([
        {
          message: 'Close date must be in the future',
          errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
          fields: [],
        },
      ]);
    });

    it('keeps every record when the org returns more than one', async () => {
      const err = await failWith(
        '[{"message":"a","errorCode":"A","fields":["X__c"]},{"message":"b","errorCode":"B","fields":[]}]',
      );
      expect((err as SalesforceRestError).details).toHaveLength(2);
    });

    it('degrades to an empty details list for a non-JSON body', async () => {
      const err = await failWith('<html>503 Service Unavailable</html>', 503);
      expect(err).toBeInstanceOf(SalesforceRestError);
      expect((err as SalesforceRestError).details).toEqual([]);
      expect(err.message).toContain('HTTP 503');
    });

    it('renders a body with no errorCode in full, even though it is not the org', () => {
      // Classification is strict (isSalesforceErrorBody requires an errorCode
      // so a gateway's bare `message` does not dead-end a request); RENDERING
      // stays permissive, so if such a body ever does reach a user its text is
      // still shown rather than dropped.
      expect(parseRestErrorDetails('[{"message":"Forbidden"}]')).toEqual([
        { message: 'Forbidden', errorCode: '', fields: [] },
      ]);
    });

    it('parseRestErrorDetails tolerates every shape the wire can produce', () => {
      expect(parseRestErrorDetails('')).toEqual([]);
      expect(parseRestErrorDetails('not json')).toEqual([]);
      expect(parseRestErrorDetails('[]')).toEqual([]);
      expect(parseRestErrorDetails('null')).toEqual([]);
      // Some endpoints answer with a bare object rather than an array.
      expect(parseRestErrorDetails('{"message":"nope","errorCode":"E"}')).toEqual([
        { message: 'nope', errorCode: 'E', fields: [] },
      ]);
      // Entries without a message are not errors we can render.
      expect(parseRestErrorDetails('[{"errorCode":"E"}]')).toEqual([]);
      // Non-string entries in fields[] are dropped rather than stringified.
      expect(parseRestErrorDetails('[{"message":"m","fields":["A",7,null]}]')).toEqual([
        { message: 'm', errorCode: '', fields: ['A'] },
      ]);
    });
  });

  // A worker that never answers is a different diagnosis from a worker that
  // answers "no session". Before this was fixed, every write inherited a 5s
  // budget and a blown budget surfaced as "No Salesforce session available" —
  // a false diagnosis, and a dangerous one for a write that may have committed.
  describe('worker timeouts', () => {
    // Rejects the way defaultMessageBus does on a blown budget, and records the
    // budget it was handed so the read/write split can be asserted.
    function timingOutBus(): MessageBus & { budgets: number[] } {
      const budgets: number[] = [];
      return {
        budgets,
        sendMessage: (async (_msg: unknown, timeoutMs?: number) => {
          budgets.push(timeoutMs ?? -1);
          throw workerTimeoutError(timeoutMs ?? 0);
        }) as unknown as MessageBus['sendMessage'],
      };
    }

    async function reject(p: Promise<unknown>): Promise<Error> {
      return p.then(
        () => {
          throw new Error('expected reject');
        },
        (e: Error) => e,
      );
    }

    describe('writes', () => {
      it('gets the 120s write budget, not the 5s default that caused the bug', async () => {
        const bus = timingOutBus();
        const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
        await reject(client.apiRequest('POST', '/services/data/v62.0/sobjects/Account', { Name: 'x' }));
        expect(bus.budgets).toEqual([WRITE_TIMEOUT_MS]);
        expect(bus.budgets[0]).toBeGreaterThan(5000);
      });

      it('reports a timeout as a timeout — never as a lost session', async () => {
        const bus = timingOutBus();
        const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
        const err = await reject(
          client.apiRequest('PATCH', '/services/data/v62.0/sobjects/Account/001', { Name: 'x' }),
        );
        expect(err.message).not.toContain('No Salesforce session');
        expect(err.message).toContain('timed out after 120s');
        expect(err.message).toContain('PATCH request');
        expect(err.message).toContain('not a lost session');
      });

      it('does not claim the write failed — it says the outcome is unknown', async () => {
        const bus = timingOutBus();
        const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
        const err = await reject(
          client.apiRequest('POST', '/services/data/v62.0/sobjects/Account', { Name: 'x' }),
        );
        expect(err.message).toContain('the result is unknown');
        expect(err.message).toContain('may already have been saved');
        // The honest framing must not assert the request did not happen.
        expect(err.message).not.toMatch(/\bfailed\b/);
      });

      it('applies the same treatment to a declared-mutating SOAP call (the data-import write)', async () => {
        const bus = timingOutBus();
        const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
        const err = await reject(
          client.apiSoap('Partner', 'create', { sObjects: [] }, { mutating: true }),
        );
        expect(bus.budgets).toEqual([WRITE_TIMEOUT_MS]);
        expect(err.message).not.toContain('No Salesforce session');
        expect(err.message).toContain('Partner create SOAP call');
        expect(err.message).toContain('may already have been saved');
      });
    });

    // SOAP tunnels reads and writes through one POST, so `mutating` is declared
    // per call site. Getting this wrong on a *read* is not merely noisy: it
    // makes `timeout + mutating` mean "or a status poll was slow", which is the
    // whole precision the discriminant exists to provide.
    describe('SOAP reads and polls', () => {
      it('a declared-read SOAP call never claims a possible commit', async () => {
        const bus = timingOutBus();
        const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
        const err = await reject(
          client.apiSoap('Metadata', 'checkDeployStatus', { id: '0Af' }, { mutating: false }),
        );
        expect(bus.budgets).toEqual([READ_TIMEOUT_MS]);
        expect(err.message).toContain('Metadata checkDeployStatus SOAP call');
        expect(err.message).toContain('timed out after 30s');
        expect(err.message).toContain('retry the request');
        // The three phrases that would be lies about a status poll.
        expect(err.message).not.toContain('may already have been saved');
        expect(err.message).not.toContain('the result is unknown');
        expect(err.message).not.toContain('No Salesforce session');
        expect(sfApiErrorKind(err)).toBe('timeout');
        expect((err as { mutating?: boolean }).mutating).toBe(false);
      });

      it('a declared-read SOAP call keeps mutating=false through the discriminant', async () => {
        const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: timingOutBus() });
        for (const method of ['describeMetadata', 'listMetadata', 'retrieve', 'checkRetrieveStatus']) {
          const err = await reject(client.apiSoap('Metadata', method, {}, { mutating: false }));
          expect(sfApiErrorKind(err)).toBe('timeout');
          expect((err as { mutating?: boolean }).mutating).toBe(false);
        }
      });

      it('an undeclared SOAP caller over-warns rather than under-warns', async () => {
        // soap-explore sends a user-typed operation and cannot know. The safe
        // default is mutating: a needless double-check beats a duplicate record.
        const bus = timingOutBus();
        const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
        const err = await reject(client.apiSoap('Partner', 'whateverTheUserTyped', {}));
        expect(bus.budgets).toEqual([WRITE_TIMEOUT_MS]);
        expect((err as { mutating?: boolean }).mutating).toBe(true);
        expect(err.message).toContain('may already have been saved');
      });
    });

    describe('reads', () => {
      it('gets the 30s read budget and a retry-safe message', async () => {
        const bus = timingOutBus();
        const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
        const err = await reject(client.toolingQuery('SELECT Id FROM Flow'));
        expect(bus.budgets).toEqual([READ_TIMEOUT_MS]);
        expect(err.message).not.toContain('No Salesforce session');
        expect(err.message).toContain('GET request timed out after 30s');
        expect(err.message).toContain('retry the request');
        // A read never happened, so it must not hint the org may have changed.
        expect(err.message).not.toContain('may already have been saved');
      });

      it('applies the read budget to apiGetText too', async () => {
        const bus = timingOutBus();
        const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
        await reject(client.apiGetText('/services/data/v62.0/tooling/sobjects/ApexLog/07L/Body'));
        expect(bus.budgets).toEqual([READ_TIMEOUT_MS]);
      });
    });

    describe('machine-readable failure kinds', () => {
      it('lets a caller branch on timed-out-write vs no-session without string matching', async () => {
        const client = (bus: MessageBus): SalesforceApiClient =>
          new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });

        const timedOut = await reject(
          client(timingOutBus()).apiRequest('POST', '/services/data/v62.0/sobjects/Account', {}),
        );
        const noSession = await reject(
          client(makeBus({ proxy: { ok: false, errors: [] } })).apiRequest(
            'POST',
            '/services/data/v62.0/sobjects/Account',
            {},
          ),
        );
        const httpError = await reject(
          client(
            makeBus({
              proxy: {
                ok: false,
                errors: [{ baseUrl: 'https://x.my.salesforce.com', status: 400, errorText: '[]' }],
              },
            }),
          ).apiRequest('POST', '/services/data/v62.0/sobjects/Account', {}),
        );

        expect(sfApiErrorKind(timedOut)).toBe('timeout');
        expect(sfApiErrorKind(noSession)).toBe('no-session');
        expect(sfApiErrorKind(httpError)).toBe('http-error');

        // The pair a caller needs to say "outcome unknown" rather than "failed".
        expect((timedOut as { mutating?: boolean }).mutating).toBe(true);
        expect((timedOut as { timeoutMs?: number }).timeoutMs).toBe(WRITE_TIMEOUT_MS);
        expect((httpError as { status?: number }).status).toBe(400);
      });

      it('marks a timed-out read as non-mutating (definitely nothing changed)', async () => {
        const c = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: timingOutBus() });
        const err = await reject(c.query('SELECT Id FROM Account'));
        expect(sfApiErrorKind(err)).toBe('timeout');
        expect((err as { mutating?: boolean }).mutating).toBe(false);
      });

      it('tags SOAP failures too, and returns null for unrelated errors', async () => {
        const c = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: timingOutBus() });
        expect(
          sfApiErrorKind(await reject(c.apiSoap('Metadata', 'deploy', {}, { mutating: true }))),
        ).toBe('timeout');
        expect(sfApiErrorKind(new Error('something else'))).toBeNull();
        expect(sfApiErrorKind('not an error')).toBeNull();
      });

      it('keeps the existing message surface intact for message-only callers', async () => {
        const bus = makeBus({ proxy: { ok: false, errors: [] } });
        const c = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
        const err = await reject(c.toolingQuery('SELECT Id FROM Flow'));
        expect(err.message).toBe('No Salesforce session available');
      });
    });

    describe('the happy path is untouched', () => {
      it('a normal write still resolves, with no timeout error and one round-trip', async () => {
        const bus = makeBus({ proxy: jsonOk({ id: '001new', success: true }, 201) });
        const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
        await expect(
          client.apiRequest('POST', '/services/data/v62.0/sobjects/Account', { Name: 'New' }),
        ).resolves.toMatchObject({ id: '001new', success: true });
        expect((bus.sendMessage as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
      });

      it('a normal read still resolves', async () => {
        const bus = makeBus({ proxy: jsonOk({ totalSize: 1, done: true, records: [{ Id: '001' }] }) });
        const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
        await expect(client.query('SELECT Id FROM Account')).resolves.toMatchObject({
          records: [{ Id: '001' }],
        });
      });

      it('a non-timeout rejection from the bus propagates unchanged', async () => {
        const bus: MessageBus = {
          sendMessage: (async () => {
            throw new Error('extension context invalidated');
          }) as unknown as MessageBus['sendMessage'],
        };
        const client = new SalesforceApiClient({ win: fakeWin(WIN), messageBus: bus });
        const err = await reject(
          client.apiRequest('POST', '/services/data/v62.0/sobjects/Account', {}),
        );
        expect(err.message).toBe('extension context invalidated');
        expect(sfApiErrorKind(err)).toBeNull();
      });
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

  describe('orgOrigin', () => {
    it('exposes the bound org origin (app-tab) and null for content-script clients', () => {
      const bound = new SalesforceApiClient({ targetOrigin: 'https://x.lightning.force.com' });
      expect(bound.orgOrigin).toBe('https://x.lightning.force.com');
      const unbound = new SalesforceApiClient({ win: fakeWin(WIN) });
      expect(unbound.orgOrigin).toBeNull();
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

    // A null reply has two causes that used to report identically. Telling the
    // user their Salesforce session is gone when the real fix is "reload the
    // tab" sends them hunting in exactly the wrong direction — the session is
    // usually fine, the extension was just swapped out from under the page.
    it('says RELOAD THE TAB, not "no session", when the context is invalidated', async () => {
      const runtime = chrome.runtime as { id?: string; sendMessage: unknown };
      const realId = runtime.id;
      runtime.sendMessage = () => {
        throw new Error('Extension context invalidated.');
      };
      // Chrome drops runtime.id the moment the context dies — the standard tell.
      runtime.id = undefined;
      try {
        const client = new SalesforceApiClient({ win: fakeWin(WIN) });
        const err = await client.toolingQuery('SELECT Id FROM Flow').catch((e: unknown) => e);
        expect((err as Error).message).toMatch(/Reload the tab/i);
        expect((err as Error).message).toMatch(/session is unaffected/i);
        expect((err as { contextInvalidated?: boolean }).contextInvalidated).toBe(true);
        // Still the same discriminant, so existing branching on kind is unchanged.
        expect((err as { sfdtKind?: string }).sfdtKind).toBe('no-session');
      } finally {
        runtime.id = realId;
      }
    });

    it('keeps the plain no-session message while the context is alive', async () => {
      // Non-vacuity for the guard above: with runtime.id present (a live
      // context), a null reply must NOT be blamed on invalidation.
      (chrome.runtime as { sendMessage: unknown }).sendMessage = (
        _msg: unknown,
        cb: (resp: unknown) => void,
      ) => cb(undefined);
      const client = new SalesforceApiClient({ win: fakeWin(WIN) });
      const err = await client.toolingQuery('SELECT Id FROM Flow').catch((e: unknown) => e);
      expect((err as Error).message).toBe('No Salesforce session available');
      expect((err as { contextInvalidated?: boolean }).contextInvalidated).toBeUndefined();
    });

    // The end-to-end proof of the fix: with the real bus wired up and a worker
    // that never calls back, a write survives well past the old 5s ceiling and
    // then fails as a timeout — not as a lost session.
    describe('budget enforcement (fake timers)', () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it('a write is still in flight at 5s and 119s, and times out at 120s', async () => {
        vi.useFakeTimers();
        (chrome.runtime as { sendMessage: unknown }).sendMessage = () => {
          /* worker never answers */
        };
        const client = new SalesforceApiClient({ win: fakeWin(WIN) });
        const pending = client.apiRequest('POST', '/services/data/v62.0/sobjects/Account', {
          Name: 'x',
        });
        let settled = false;
        const captured = pending.then(
          () => {
            settled = true;
            return null as Error | null;
          },
          (e: Error) => {
            settled = true;
            return e;
          },
        );

        await vi.advanceTimersByTimeAsync(5_000);
        expect(settled).toBe(false); // the bug: this used to have failed by now
        await vi.advanceTimersByTimeAsync(114_000);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1_000);

        const err = await captured;
        expect(err).toBeInstanceOf(Error);
        expect(err!.message).not.toContain('No Salesforce session');
        expect(err!.message).toContain('timed out after 120s');
        expect(sfApiErrorKind(err)).toBe('timeout');
      });

      it('a read times out at 30s', async () => {
        vi.useFakeTimers();
        (chrome.runtime as { sendMessage: unknown }).sendMessage = () => {};
        const client = new SalesforceApiClient({ win: fakeWin(WIN) });
        const captured = client
          .toolingQuery('SELECT Id FROM Flow')
          .then(() => null as Error | null, (e: Error) => e);
        await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
        const err = await captured;
        expect(err!.message).toContain('timed out after 30s');
        expect(sfApiErrorKind(err)).toBe('timeout');
      });

      it('the bus itself rejects with the worker-timeout signal, not a null resolution', async () => {
        vi.useFakeTimers();
        (chrome.runtime as { sendMessage: unknown }).sendMessage = () => {};
        // Reach the bus through a client so the module keeps its single export
        // surface; a resolution here would be the old resolve-null behaviour.
        const client = new SalesforceApiClient({ win: fakeWin(WIN) });
        const captured = client
          .apiGetText('/services/data/v62.0/tooling/sobjects/ApexLog/07L/Body')
          .then(() => null as Error | null, (e: Error) => e);
        await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
        expect((await captured)!.name).toBe('SfRequestTimeoutError');
        // …and the raw signal the bus emits is the one the client looks for.
        expect(workerTimeoutError(1).name).toBe(WORKER_TIMEOUT_ERROR_NAME);
      });
    });
  });
});
