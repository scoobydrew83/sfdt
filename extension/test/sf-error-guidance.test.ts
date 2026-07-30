import { describe, it, expect, vi } from 'vitest';
import {
  buildUserFacingMessage,
  guidanceForErrorCode,
  guidanceForStatus,
} from '../lib/sf-error-guidance.js';
import {
  SalesforceApiClient,
  SalesforceRestError,
  type SalesforceRestErrorDetail,
} from '../lib/salesforce-api.js';
import {
  sfApiFetch,
  type SessionCache,
  type SessionCacheEntry,
  type SfApiProxyDeps,
} from '../lib/sf-api-proxy.js';

function detail(over: Partial<SalesforceRestErrorDetail> = {}): SalesforceRestErrorDetail {
  return { message: 'm', errorCode: '', fields: [], ...over };
}

describe('guidanceForErrorCode', () => {
  it('covers the codes a user actually hits', () => {
    for (const code of [
      'MALFORMED_QUERY',
      'INVALID_FIELD',
      'INVALID_TYPE',
      'INVALID_SESSION_ID',
      'REQUEST_LIMIT_EXCEEDED',
      'INSUFFICIENT_ACCESS',
      'INSUFFICIENT_ACCESS_OR_READONLY',
      'FIELD_CUSTOM_VALIDATION_EXCEPTION',
      'REQUIRED_FIELD_MISSING',
    ]) {
      expect(guidanceForErrorCode(code), code).not.toBe('');
    }
  });

  it('returns nothing for an unknown code rather than inventing advice', () => {
    expect(guidanceForErrorCode('SOME_FUTURE_CODE')).toBe('');
    expect(guidanceForErrorCode('')).toBe('');
    expect(guidanceForErrorCode(undefined as unknown as string)).toBe('');
    expect(guidanceForErrorCode(null as unknown as string)).toBe('');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(guidanceForErrorCode('  malformed_query ')).toBe(guidanceForErrorCode('MALFORMED_QUERY'));
  });

  it('never advises re-authenticating for a code that is not a session problem', () => {
    // The whole point of the bug: a session claim must be established, not guessed.
    for (const code of ['MALFORMED_QUERY', 'INVALID_FIELD', 'INVALID_TYPE']) {
      expect(guidanceForErrorCode(code).toLowerCase()).not.toContain('log in again');
      expect(guidanceForErrorCode(code).toLowerCase()).not.toContain('session');
    }
    expect(guidanceForErrorCode('INVALID_SESSION_ID').toLowerCase()).toContain('session');
  });
});

describe('buildUserFacingMessage', () => {
  const HEAD = 'Salesforce GET request failed (HTTP 400): boom';

  it('leaves the headline as the first line, always', () => {
    expect(buildUserFacingMessage(HEAD, [], 400).split('\n')[0]).toBe(HEAD);
    expect(
      buildUserFacingMessage(HEAD, [detail({ errorCode: 'MALFORMED_QUERY' })], 400).split('\n')[0],
    ).toBe(HEAD);
  });

  it('names the offending field', () => {
    const msg = buildUserFacingMessage(HEAD, [detail({ fields: ['Invoice_Status_Type__c'] })], 400);
    expect(msg).toContain('field: Invoice_Status_Type__c');
  });

  it('names every field when the org blamed more than one', () => {
    const msg = buildUserFacingMessage(HEAD, [detail({ fields: ['A__c', 'B__c'] })], 400);
    expect(msg).toContain('fields: A__c, B__c');
  });

  it('renders an unrecognised code in full instead of falling back to something generic', () => {
    const msg = buildUserFacingMessage(
      'Salesforce GET request failed (HTTP 400): a brand new failure',
      [detail({ message: 'a brand new failure', errorCode: 'FUTURE_CODE_2031' })],
      400,
    );
    expect(msg).toContain('a brand new failure');
    expect(msg).toContain('FUTURE_CODE_2031');
  });

  it('keeps the records the headline could not show', () => {
    const msg = buildUserFacingMessage(
      HEAD,
      [detail({ message: 'first' }), detail({ message: 'second', errorCode: 'INVALID_FIELD' })],
      400,
    );
    expect(msg).toContain('Also: second');
    expect(msg).toContain('INVALID_FIELD');
  });

  it('falls back to status-only guidance when the org sent no structured record', () => {
    const msg = buildUserFacingMessage('Salesforce GET request failed (HTTP 503)', [], 503);
    expect(msg).toContain('Salesforce GET request failed (HTTP 503)');
    expect(msg.toLowerCase()).toContain('retry');
  });

  it('adds nothing it cannot establish for an unmapped status with no body', () => {
    expect(buildUserFacingMessage('headline', [], 418)).toBe('headline');
  });

  it('is total over hostile and malformed detail lists', () => {
    const hostile = [
      null,
      undefined,
      'nope',
      42,
      {},
      { message: 'm' },
      { message: 'm', errorCode: 7, fields: 'X' },
      { message: 'm', fields: [null, 1, '', 'Ok__c'] },
    ] as unknown as SalesforceRestErrorDetail[];
    expect(() => buildUserFacingMessage('h', hostile, 400)).not.toThrow();
    expect(buildUserFacingMessage('h', hostile, 400)).toContain('Ok__c');
    expect(() => buildUserFacingMessage('h', null, 400)).not.toThrow();
    expect(() => buildUserFacingMessage('h', 'boom' as never, 400)).not.toThrow();
  });

  it('guidanceForStatus stays silent on statuses it has nothing to say about', () => {
    expect(guidanceForStatus(418)).toBe('');
    expect(guidanceForStatus(401)).not.toBe('');
  });
});

// ── The reported bug, end to end ───────────────────────────────────────────
//
// Drives the real path — page-side client → worker proxy → stubbed org — with
// the exact query from the report and the body Salesforce actually returns for
// a bad-type WHERE clause. Fails on develop, where the user was shown
// "Salesforce GET request failed (HTTP 401): Session expired or invalid".
describe("SELECT Id FROM Invoice__c WHERE Invoice_Status_Type__c = 'Chargeback'", () => {
  const ORG_ID = '00DORG1';
  const SID = `${ORG_ID}!secret`;
  const ORIGIN = 'https://acme.lightning.force.com';
  const MY = 'https://acme.my.salesforce.com';
  const QUERY = "SELECT Id FROM Invoice__c WHERE Invoice_Status_Type__c = 'Chargeback'";

  const MALFORMED_QUERY_BODY = JSON.stringify([
    {
      message:
        "value of filter criterion for field 'Invoice_Status_Type__c' must be of type double and should not be enclosed in quotes",
      errorCode: 'MALFORMED_QUERY',
    },
  ]);
  const SESSION_BODY = JSON.stringify([
    { message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' },
  ]);

  function memoryCache(seed: Record<string, SessionCacheEntry>): SessionCache {
    const store = new Map(Object.entries(seed));
    return {
      async get(host) {
        return store.get(host) ?? null;
      },
      async set(host, entry) {
        store.set(host, entry);
      },
      async delete(host) {
        store.delete(host);
      },
    };
  }

  function clientAgainstOrg(routes: Record<string, { status: number; body: string }>) {
    const deps: SfApiProxyDeps = {
      fetchImpl: (async (url: string | URL) => {
        const key = String(url);
        for (const [prefix, r] of Object.entries(routes)) {
          if (key.startsWith(prefix)) {
            return {
              ok: r.status >= 200 && r.status < 300,
              status: r.status,
              headers: { get: () => 'application/json' },
              async text() {
                return r.body;
              },
            } as unknown as Response;
          }
        }
        throw new Error(`no route for ${key}`);
      }) as typeof fetch,
      cookieGet: async () => SID,
      // Warm cache — the steady state after any prior successful call, and the
      // condition under which the bug appeared.
      cache: memoryCache({ 'acme.lightning.force.com': { baseUrl: MY, orgId: ORG_ID } }),
    };
    return new SalesforceApiClient({
      targetOrigin: ORIGIN,
      messageBus: {
        async sendMessage(message: unknown) {
          return (await sfApiFetch(message as never, deps)) as never;
        },
      },
    });
  }

  async function runQuery(routes: Record<string, { status: number; body: string }>) {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = await clientAgainstOrg(routes)
      .query(QUERY)
      .then(
        () => null,
        (e: Error) => e,
      );
    spy.mockRestore();
    return err;
  }

  it("surfaces the org's MALFORMED_QUERY and never a session error", async () => {
    const err = await runQuery({
      [MY]: { status: 400, body: MALFORMED_QUERY_BODY },
      [ORIGIN]: { status: 401, body: SESSION_BODY },
    });

    expect(err).toBeInstanceOf(SalesforceRestError);
    // The org's own wording, in full.
    expect(err!.message).toContain(
      "value of filter criterion for field 'Invoice_Status_Type__c' must be of type double and should not be enclosed in quotes",
    );
    expect(err!.message).toContain('MALFORMED_QUERY');
    expect((err as SalesforceRestError).status).toBe(400);

    // The session was fine. Nothing may suggest otherwise.
    expect(err!.message).not.toContain('Session expired');
    expect(err!.message).not.toContain('INVALID_SESSION_ID');
    expect(err!.message).not.toContain('401');
    expect(err!.message.toLowerCase()).not.toContain('log in again');
  });

  it('tells the user what to do about it', async () => {
    const err = await runQuery({
      [MY]: { status: 400, body: MALFORMED_QUERY_BODY },
      [ORIGIN]: { status: 401, body: SESSION_BODY },
    });
    expect(err!.message).toContain('must not be');
  });

  it('keeps the structured records on the error for per-field rendering', async () => {
    const err = (await runQuery({
      [MY]: { status: 400, body: MALFORMED_QUERY_BODY },
      [ORIGIN]: { status: 401, body: SESSION_BODY },
    })) as SalesforceRestError;
    expect(err.details).toHaveLength(1);
    expect(err.details[0]!.errorCode).toBe('MALFORMED_QUERY');
  });

  it('still reports a genuine expired session as one', async () => {
    // The fix must not make real session failures unreportable.
    const err = await runQuery({
      [MY]: { status: 401, body: SESSION_BODY },
      [ORIGIN]: { status: 401, body: SESSION_BODY },
    });
    expect(err!.message).toContain('Session expired or invalid');
    expect(err!.message.toLowerCase()).toContain('log in again');
  });

  it('names the field when the org attributes the failure to one', async () => {
    const err = await runQuery({
      [MY]: {
        status: 400,
        body: JSON.stringify([
          {
            message: "No such column 'Invoice_Statuss__c' on entity 'Invoice__c'.",
            errorCode: 'INVALID_FIELD',
            fields: ['Invoice_Statuss__c'],
          },
        ]),
      },
      [ORIGIN]: { status: 401, body: SESSION_BODY },
    });
    expect(err!.message).toContain("No such column 'Invoice_Statuss__c'");
    expect(err!.message).toContain('field: Invoice_Statuss__c');
    expect(err!.message).not.toContain('Session expired');
  });
});
