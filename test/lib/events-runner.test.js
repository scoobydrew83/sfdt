import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/org-query.js', () => ({ query: vi.fn() }));
vi.mock('../../src/lib/org-rest.js', () => ({
  orgRest: vi.fn(),
  restErrorMessage: vi.fn((e) => e?.message ?? 'unknown error'),
}));
vi.mock('../../src/lib/org-session.js', () => ({ getOrgSession: vi.fn() }));

// The Bayeux client is flow-core's and is driven here through a fake so the
// runner's bounding logic can be tested without a socket. The protocol itself
// is exercised by extension/test/sf-stream-worker.test.ts against a mocked
// fetch — the same implementation, from its new home.
const clients = [];
vi.mock('@sfdt/flow-core', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    SalesforceBayeuxClient: class {
      constructor(baseUrl, sessionId, apiVersion) {
        this.baseUrl = baseUrl;
        this.sessionId = sessionId;
        this.apiVersion = apiVersion;
        this.stopped = false;
        clients.push(this);
      }
      onMessage(cb) { this.emit = cb; }
      onStatus(cb) { this.status = cb; }
      async start(path, replayId) { this.path = path; this.replayId = replayId; }
      async stop() { this.stopped = true; }
    },
  };
});

import { query } from '../../src/lib/org-query.js';
import { orgRest } from '../../src/lib/org-rest.js';
import { getOrgSession } from '../../src/lib/org-session.js';
import {
  listEventChannels,
  publishEvent,
  matchesExpectation,
  tailEvents,
  REPLAY_NEW_ONLY,
  REPLAY_ALL_RETAINED,
} from '../../src/lib/events-runner.js';

const config = { _projectRoot: '/p', sourceApiVersion: 62 };

beforeEach(() => {
  clients.length = 0;
  vi.mocked(query).mockReset().mockResolvedValue([]);
  vi.mocked(orgRest).mockReset();
  vi.mocked(getOrgSession).mockReset().mockResolvedValue({
    accessToken: 'SECRET_TOKEN',
    instanceUrl: 'https://acme.my.salesforce.com',
    apiVersion: '62.0',
  });
});

describe('listEventChannels', () => {
  it('builds the right Bayeux path for each kind', async () => {
    vi.mocked(query).mockImplementation(async (_org, soql) => {
      if (/KeyPrefix LIKE 'e%'/.test(soql)) {
        return [{ QualifiedApiName: 'Order_Placed__e', Label: 'Order Placed' }];
      }
      if (/PlatformEventChannelMember/.test(soql)) {
        return [{ SelectedEntity: 'Account', MasterLabel: 'Account' }];
      }
      return [];
    });

    const { channels } = await listEventChannels('dev');
    const byName = Object.fromEntries(channels.map((c) => [c.name, c.path]));

    // Getting these backwards does not error — the handshake succeeds and the
    // subscription silently receives nothing, the worst failure for a tail.
    expect(byName.Order_Placed__e).toBe('/event/Order_Placed__e');
    expect(byName.AccountChangeEvent).toBe('/data/AccountChangeEvent');
    expect(byName.ChangeEvents).toBe('/data/ChangeEvents');
  });

  it('always offers the catch-all ChangeEvents channel', async () => {
    // It is not a row in PlatformEventChannelMember, so querying for it would
    // never find it.
    const { channels } = await listEventChannels('dev');
    expect(channels.some((c) => c.name === 'ChangeEvents')).toBe(true);
  });

  it('reports a refused kind as unchecked and still returns the others', async () => {
    vi.mocked(query).mockImplementation(async (_org, soql) => {
      if (/KeyPrefix LIKE 'e%'/.test(soql)) throw new Error('INSUFFICIENT_ACCESS');
      return [];
    });

    const { channels, notes } = await listEventChannels('dev');
    expect(notes.some((n) => n.includes('INSUFFICIENT_ACCESS'))).toBe(true);
    expect(notes.some((n) => n.includes('not a finding that your org has none'))).toBe(true);
    // The other kinds still produced their answers.
    expect(channels.some((c) => c.name === 'ChangeEvents')).toBe(true);
  });
});

describe('publishEvent', () => {
  it('refuses a name that is not a platform event, before any call', async () => {
    // The org's own error for this is unhelpful, and CDC events cannot be
    // published at all.
    await expect(publishEvent(config, 'dev', 'AccountChangeEvent', { A: '1' }))
      .rejects.toThrow(/end in `__e`/);
    expect(orgRest).not.toHaveBeenCalled();
  });

  it('refuses an empty body', async () => {
    await expect(publishEvent(config, 'dev', 'X__e', {})).rejects.toThrow(/at least one/);
  });

  it('posts to the configured API version, not a hardcoded one', async () => {
    vi.mocked(orgRest).mockResolvedValue({ success: true, id: 'e00x' });
    await publishEvent(config, 'dev', 'Order_Placed__e', { Order_Id__c: 'A-1' });

    expect(orgRest).toHaveBeenCalledWith(
      'dev',
      '/services/data/v62.0/sobjects/Order_Placed__e/',
      { method: 'POST', body: { Order_Id__c: 'A-1' } },
    );
  });

  it('sends nothing on --dry-run', async () => {
    const result = await publishEvent(config, 'dev', 'X__e', { A: '1' }, { dryRun: true });
    expect(result.outcome).toBe('dry-run');
    expect(orgRest).not.toHaveBeenCalled();
  });

  it('reports a rejection rather than throwing', async () => {
    vi.mocked(orgRest).mockRejectedValue(new Error('REQUIRED_FIELD_MISSING'));
    const result = await publishEvent(config, 'dev', 'X__e', { A: '1' });

    expect(result.outcome).toBe('rejected');
    expect(result.error).toBe('REQUIRED_FIELD_MISSING');
  });

  it('treats a response without success as rejected', async () => {
    vi.mocked(orgRest).mockResolvedValue({ id: 'e00x' });
    expect((await publishEvent(config, 'dev', 'X__e', { A: '1' })).outcome).toBe('rejected');
  });
});

describe('matchesExpectation', () => {
  it('compares as strings so 1 and "1" agree', () => {
    expect(matchesExpectation({ N: 1 }, { N: '1' })).toBe(true);
  });

  it('walks a dotted path into a nested payload', () => {
    // CDC puts everything useful in ChangeEventHeader.
    const payload = { payload: { ChangeEventHeader: { changeType: 'CREATE' } } };
    expect(matchesExpectation(payload, { 'payload.ChangeEventHeader.changeType': 'CREATE' })).toBe(true);
    expect(matchesExpectation(payload, { 'payload.ChangeEventHeader.changeType': 'UPDATE' })).toBe(false);
  });

  it('requires EVERY pair, not any', () => {
    expect(matchesExpectation({ A: '1', B: '2' }, { A: '1', B: '9' })).toBe(false);
  });

  it('does not throw on a missing path', () => {
    expect(matchesExpectation({}, { 'a.b.c': 'x' })).toBe(false);
  });

  it('matches a value inside an array', () => {
    expect(matchesExpectation({ Tags: ['a', 'b'] }, { Tags: 'b' })).toBe(true);
  });

  it('is vacuously true with no expectations', () => {
    expect(matchesExpectation({}, {})).toBe(true);
  });
});

describe('tailEvents', () => {
  /** Run a tail and feed it events once the client exists. */
  async function tailWith(opts, feed) {
    const promise = tailEvents('dev', 'Order_Placed__e', { timeoutMs: 5000, ...opts });
    await new Promise((r) => setImmediate(r));
    const client = clients[0];
    feed(client);
    return { result: await promise, client };
  }

  it('passes the resolved session to the client and subscribes to the right path', async () => {
    const { result, client } = await tailWith({ max: 1 }, (c) => c.emit({ A: 1 }));

    expect(client.baseUrl).toBe('https://acme.my.salesforce.com');
    expect(client.sessionId).toBe('SECRET_TOKEN');
    expect(client.path).toBe('/event/Order_Placed__e');
    expect(result.path).toBe('/event/Order_Placed__e');
  });

  it('defaults to new events only, and accepts the retention window', async () => {
    const a = await tailWith({ max: 1 }, (c) => c.emit({}));
    expect(a.client.replayId).toBe(REPLAY_NEW_ONLY);

    clients.length = 0;
    const b = await tailWith({ max: 1, replayId: REPLAY_ALL_RETAINED }, (c) => c.emit({}));
    expect(b.client.replayId).toBe(REPLAY_ALL_RETAINED);
  });

  it('stops at --max and unsubscribes', async () => {
    const { result, client } = await tailWith({ max: 2 }, (c) => {
      c.emit({ n: 1 });
      c.emit({ n: 2 });
      c.emit({ n: 3 });
    });

    expect(result.events).toHaveLength(2);
    expect(result.outcome).toBe('max');
    // Never leave the org holding a subscription for a finished command.
    expect(client.stopped).toBe(true);
  });

  it('stops on the first event matching an expectation', async () => {
    const { result } = await tailWith({ expect: { Status__c: 'OK' } }, (c) => {
      c.emit({ Status__c: 'PENDING' });
      c.emit({ Status__c: 'OK' });
    });

    expect(result.matched).toBe(true);
    expect(result.outcome).toBe('matched');
    expect(result.events).toHaveLength(2);
  });

  it('reports matched:false when the expectation never arrives', async () => {
    // This is the CI assertion's whole purpose — not seeing the event IS the
    // failure it exists to detect.
    const { result } = await tailWith({ timeoutMs: 40, expect: { Status__c: 'OK' } }, (c) => {
      c.emit({ Status__c: 'PENDING' });
    });

    expect(result.matched).toBe(false);
    expect(result.outcome).toBe('timeout');
  });

  it('ends early on a connection error rather than waiting out the timeout', async () => {
    // A failed handshake never delivers an event, so waiting is just a slower
    // way to report the same thing.
    const { result, client } = await tailWith({ timeoutMs: 30_000 }, (c) =>
      c.status('Connection failed: 401', true));

    expect(result.outcome).toBe('error');
    expect(result.error).toContain('401');
    expect(client.stopped).toBe(true);
  });

  it('ends cleanly when aborted', async () => {
    const controller = new AbortController();
    const promise = tailEvents('dev', 'X__e', { timeoutMs: 30_000, signal: controller.signal });
    await new Promise((r) => setImmediate(r));
    controller.abort();
    const result = await promise;

    expect(result.outcome).toBe('interrupted');
    expect(clients[0].stopped).toBe(true);
  });

  it('times out with whatever it collected, rather than losing it', async () => {
    const { result } = await tailWith({ timeoutMs: 40 }, (c) => c.emit({ n: 1 }));

    expect(result.outcome).toBe('timeout');
    expect(result.events).toEqual([{ n: 1 }]);
  });
});
