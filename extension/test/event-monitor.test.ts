import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createEventMonitorFeature, SalesforceBayeuxClient } from '../features/event-monitor.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

function fakeApi(overrides: Partial<SalesforceApiClient> = {}): SalesforceApiClient {
  return {
    apiGet: vi.fn(async () => ({ records: [] })),
    toolingQuery: vi.fn(async () => ({ records: [] })),
    limits: vi.fn(async () => ({})),
    getSessionDetails: vi.fn(async () => ({ baseUrl: 'https://test.salesforce.com', sid: 'session-id' })),
    ...overrides,
  } as unknown as SalesforceApiClient;
}

function clearBody(): void {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
}

beforeEach(() => {
  clearBody();
});

afterEach(() => {
  vi.restoreAllMocks();
});

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

    // Give some microtask execution cycles
    await new Promise((r) => setTimeout(r, 10));

    expect(receivedMessages).toEqual([{ payload: { Message__c: 'Hello World' } }]);
    expect(statusChanges).toContain('Initiating handshake...');
    expect(statusChanges).toContain('Handshake successful. Subscribing...');
    expect(statusChanges).toContain('Listening on /event/My_Event__e...');
    expect(statusChanges).toContain('Disconnected');
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
    vi.useRealTimers();
  });
});

describe('Event Streaming Monitor UI Feature', () => {
  it('mounts the overlay and closes it', async () => {
    const api = fakeApi();
    const feature = createEventMonitorFeature({ api });
    await feature.onActivate?.();

    expect(document.querySelector('.sfut-event-monitor-overlay')).not.toBeNull();

    const closeBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '×');
    expect(closeBtn).not.toBeUndefined();
    closeBtn?.click();

    expect(document.querySelector('.sfut-event-monitor-overlay')).toBeNull();
  });

  it('updates channel dropdown when Channel Type changes', async () => {
    const api = fakeApi({
      apiGet: vi.fn(async (url, params: any) => {
        if (params?.q?.includes('IsCustomizable = FALSE')) {
          return {
            records: [{ QualifiedApiName: 'Standard_Event', Label: 'Standard Event' }],
          };
        }
        return {
          records: [{ QualifiedApiName: 'Custom_Event__e', Label: 'Custom Event' }],
        };
      }) as unknown as SalesforceApiClient['apiGet'],
      toolingQuery: vi.fn(async (query: string) => {
        if (query.includes('PlatformEventChannelMember')) {
          return {
            records: [{ SelectedEntity: 'Account', MasterLabel: 'AccountChangeEvent' }],
            size: 1,
            done: true,
          };
        }
        return {
          records: [{ FullName: 'MyChannel', MasterLabel: 'My Channel' }],
          size: 1,
          done: true,
        };
      }) as unknown as SalesforceApiClient['toolingQuery'],
    });

    const feature = createEventMonitorFeature({ api });
    await feature.onActivate?.();
    await new Promise((r) => setTimeout(r, 0));

    const typeSelect = document.querySelector('select') as HTMLSelectElement;
    expect(typeSelect).not.toBeNull();

    const nameSelect = document.querySelectorAll('select')[1] as HTMLSelectElement;
    expect(nameSelect).not.toBeNull();

    // Default is platformEvent
    expect(nameSelect.textContent).toContain('Custom Event (Custom_Event__e)');

    // Switch to standardPlatformEvent
    typeSelect.value = 'standardPlatformEvent';
    typeSelect.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 0));
    expect(nameSelect.textContent).toContain('Standard Event (Standard_Event)');

    // Switch to customChannel
    typeSelect.value = 'customChannel';
    typeSelect.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 0));
    expect(nameSelect.textContent).toContain('My Channel (MyChannel)');

    // Switch to changeEvent
    typeSelect.value = 'changeEvent';
    typeSelect.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 0));
    expect(nameSelect.textContent).toContain('Account Change Event');
  });

  it('fetches limit metrics when limits button is clicked', async () => {
    const api = fakeApi({
      limits: vi.fn(async () => ({
        HourlyPublishedPlatformEvents: { Max: 50000, Remaining: 42000 },
        DailyApiRequests: { Max: 100, Remaining: 50 },
      })),
    });

    const feature = createEventMonitorFeature({ api });
    await feature.onActivate?.();

    const limitsBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Limits Metrics');
    expect(limitsBtn).not.toBeUndefined();

    limitsBtn?.click();
    await new Promise((r) => setTimeout(r, 0));

    const bodyText = document.body.textContent ?? '';
    expect(bodyText).toContain('HourlyPublishedPlatformEvents: Remaining 42000 out of 50000');
    // DailyApiRequests should be filtered out because it's not a PlatformEvent / Streaming limit.
    expect(bodyText).not.toContain('DailyApiRequests');
  });

  it('subscribes to events, updates UI list, allows filter, copy, clear, and unsubscribe', async () => {
    let activeClient: any = null;
    const startSpy = vi.spyOn(SalesforceBayeuxClient.prototype, 'start').mockImplementation(async function (this: any) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      activeClient = this;
      this.statusListener?.('Listening...', false);
    });
    const stopSpy = vi.spyOn(SalesforceBayeuxClient.prototype, 'stop').mockResolvedValue();

    const api = fakeApi({
      apiGet: vi.fn(async () => ({
        records: [{ QualifiedApiName: 'My_Event__e', Label: 'My Event' }],
      })) as unknown as SalesforceApiClient['apiGet'],
    });

    const feature = createEventMonitorFeature({ api });
    await feature.onActivate?.();
    await new Promise((r) => setTimeout(r, 0));

    const subscribeBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Subscribe');
    expect(subscribeBtn).not.toBeUndefined();
    subscribeBtn?.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(startSpy).toHaveBeenCalledWith('/event/My_Event__e', -1);
    expect(activeClient).not.toBeNull();

    // Simulate event delivery
    activeClient.messageListener({
      schema: 'eventSchema',
      payload: { Message__c: 'Event payload message text' },
    });

    expect(document.body.textContent).toContain('Event payload message text');

    // Click on event to view details
    const eventItem = Array.from(document.querySelectorAll('div')).find(
      (d) => d.textContent?.includes('Event payload message text') && d.style.cursor === 'pointer',
    );
    expect(eventItem).not.toBeUndefined();
    eventItem?.click();

    const detailsPre = document.querySelector('pre');
    expect(detailsPre?.textContent).toContain('Event payload message text');

    // Test copy JSON
    const writeTextSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextSpy },
      configurable: true,
      writable: true,
    });
    const copyBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Copy JSON');
    copyBtn?.click();
    expect(writeTextSpy).toHaveBeenCalled();

    // Test filtering
    const filterInput = document.querySelector('input[placeholder="Filter events..."]') as HTMLInputElement;
    expect(filterInput).not.toBeNull();

    const listContainer = filterInput.parentElement?.nextElementSibling;
    expect(listContainer).not.toBeNull();

    filterInput.value = 'nonexistent-string';
    filterInput.dispatchEvent(new Event('input'));
    expect(listContainer?.textContent).not.toContain('Event payload message text');
    expect(listContainer?.textContent).toContain('No events received yet');

    filterInput.value = 'message text';
    filterInput.dispatchEvent(new Event('input'));
    expect(listContainer?.textContent).toContain('Event payload message text');

    // Test clear
    const clearBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Clear');
    clearBtn?.click();
    expect(listContainer?.textContent).not.toContain('Event payload message text');
    expect(detailsPre?.textContent).toContain('Select an event to inspect details');

    // Test unsubscribe
    const unsubscribeBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Unsubscribe');
    unsubscribeBtn?.click();
    expect(stopSpy).toHaveBeenCalled();
  });
});
