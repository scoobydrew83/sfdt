import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createEventMonitorFeature } from '../features/event-monitor.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

function fakeApi(overrides: Partial<SalesforceApiClient> = {}): SalesforceApiClient {
  return {
    apiVersion: 'v62.0',
    orgOrigin: null,
    apiGet: vi.fn(async () => ({ records: [] })),
    toolingQuery: vi.fn(async () => ({ records: [] })),
    limits: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as SalesforceApiClient;
}

// Structural client-Port shape. The postMessage/disconnect values are vi.fn
// spies at runtime (so toHaveBeenCalledWith works) but typed as plain functions
// so the object is assignable to the feature's StreamClientPort option.
interface MockPort {
  postMessage: (message: unknown) => void;
  onMessage: { addListener: (cb: (m: unknown) => void) => void };
  onDisconnect: { addListener: (cb: () => void) => void };
  disconnect: () => void;
}

// Mock of the client (page) side of a chrome.runtime.Port.
function makeMockPort(): {
  port: MockPort;
  posted: unknown[];
  emit: (m: unknown) => void;
  fireDisconnect: () => void;
} {
  const posted: unknown[] = [];
  let msgCb: ((m: unknown) => void) | null = null;
  let discCb: (() => void) | null = null;
  const port: MockPort = {
    postMessage: vi.fn((m: unknown) => { posted.push(m); }),
    onMessage: { addListener: (cb: (m: unknown) => void) => { msgCb = cb; } },
    onDisconnect: { addListener: (cb: () => void) => { discCb = cb; } },
    disconnect: vi.fn(),
  };
  return {
    port,
    posted,
    emit: (m) => msgCb?.(m),
    fireDisconnect: () => discCb?.(),
  };
}

// A connect factory that records the ports it hands out.
function makeConnect(): {
  connect: (name: string) => MockPort;
  ports: ReturnType<typeof makeMockPort>[];
  last: () => ReturnType<typeof makeMockPort> | undefined;
} {
  const ports: ReturnType<typeof makeMockPort>[] = [];
  const connect = vi.fn((_name: string): MockPort => {
    const mp = makeMockPort();
    ports.push(mp);
    return mp.port;
  });
  return { connect, ports, last: () => ports[ports.length - 1] };
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

describe('Event Streaming Monitor UI Feature', () => {
  it('mounts the overlay and closes it', async () => {
    const api = fakeApi();
    const feature = createEventMonitorFeature({ api, connect: makeConnect().connect });
    await feature.onActivate?.();

    expect(document.querySelector('.sfdt-view-overlay')).not.toBeNull();

    const closeBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '×');
    expect(closeBtn).not.toBeUndefined();
    closeBtn?.click();

    expect(document.querySelector('.sfdt-view-overlay')).toBeNull();
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

    const feature = createEventMonitorFeature({ api, connect: makeConnect().connect });
    await feature.onActivate?.();
    await new Promise((r) => setTimeout(r, 0));

    const typeSelect = document.querySelector('select') as HTMLSelectElement;
    expect(typeSelect).not.toBeNull();

    const nameSelect = document.querySelectorAll('select')[1] as HTMLSelectElement;
    expect(nameSelect).not.toBeNull();

    // Default is platformEvent
    expect(nameSelect.textContent).toContain('Custom Event (Custom_Event__e)');

    typeSelect.value = 'standardPlatformEvent';
    typeSelect.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 0));
    expect(nameSelect.textContent).toContain('Standard Event (Standard_Event)');

    typeSelect.value = 'customChannel';
    typeSelect.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 0));
    expect(nameSelect.textContent).toContain('My Channel (MyChannel)');

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

    const feature = createEventMonitorFeature({ api, connect: makeConnect().connect });
    await feature.onActivate?.();

    const limitsBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Limits Metrics');
    expect(limitsBtn).not.toBeUndefined();

    limitsBtn?.click();
    await new Promise((r) => setTimeout(r, 0));

    const bodyText = document.body.textContent ?? '';
    expect(bodyText).toContain('HourlyPublishedPlatformEvents: Remaining 42000 out of 50000');
    expect(bodyText).not.toContain('DailyApiRequests');
  });

  it('does not open a Port when no channel is selected and no custom path is provided', async () => {
    const { connect } = makeConnect();
    // fakeApi returns empty records, so the channel dropdown falls back to the
    // placeholder option whose name is '' (empty), and no custom path is typed.
    const api = fakeApi();

    const feature = createEventMonitorFeature({ api, connect });
    await feature.onActivate?.();
    await new Promise((r) => setTimeout(r, 0));

    const subscribeBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Subscribe');
    expect(subscribeBtn).not.toBeUndefined();
    subscribeBtn?.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(connect).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Please specify or select a streaming channel first.');
  });

  it('subscribes over the Port, renders status + events, filters, copies, clears, and unsubscribes', async () => {
    const conn = makeConnect();
    const api = fakeApi({
      apiGet: vi.fn(async () => ({
        records: [{ QualifiedApiName: 'My_Event__e', Label: 'My Event' }],
      })) as unknown as SalesforceApiClient['apiGet'],
      orgOrigin: 'https://acme.lightning.force.com',
    });

    const feature = createEventMonitorFeature({ api, connect: conn.connect });
    await feature.onActivate?.();
    await new Promise((r) => setTimeout(r, 0));

    const subscribeBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Subscribe');
    expect(subscribeBtn).not.toBeUndefined();
    subscribeBtn?.click();
    await new Promise((r) => setTimeout(r, 0));

    // Port opened with the subscribe command, including the org origin.
    expect(conn.connect).toHaveBeenCalledWith('sfApiStream');
    const mp = conn.last()!;
    expect(mp.port.postMessage).toHaveBeenCalledWith({
      cmd: 'subscribe',
      channelPath: '/event/My_Event__e',
      replayId: -1,
      targetOrigin: 'https://acme.lightning.force.com',
    });

    // Worker pushes a status message.
    const statusLabel = Array.from(document.querySelectorAll('span')).find(
      (s) => s.textContent === 'Ready to stream',
    );
    mp.emit({ type: 'status', status: 'Listening on /event/My_Event__e...', isError: false });
    expect(statusLabel?.textContent).toBe('Listening on /event/My_Event__e...');

    // Worker pushes an event.
    mp.emit({
      type: 'event',
      data: { schema: 'eventSchema', payload: { Message__c: 'Event payload message text' } },
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

    // Copy JSON
    const writeTextSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextSpy },
      configurable: true,
      writable: true,
    });
    const copyBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Copy JSON');
    copyBtn?.click();
    expect(writeTextSpy).toHaveBeenCalled();

    // Filtering
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

    // Clear
    const clearBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Clear');
    clearBtn?.click();
    expect(listContainer?.textContent).not.toContain('Event payload message text');
    expect(detailsPre?.textContent).toContain('Select an event to inspect details');

    // Unsubscribe → sends the command and disconnects the Port.
    const unsubscribeBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Unsubscribe');
    unsubscribeBtn?.click();
    expect(mp.port.postMessage).toHaveBeenCalledWith({ cmd: 'unsubscribe' });
    expect(mp.port.disconnect).toHaveBeenCalled();
  });

  it('surfaces a Port disconnect as "Disconnected" and re-enables Subscribe', async () => {
    const conn = makeConnect();
    const api = fakeApi({
      apiGet: vi.fn(async () => ({
        records: [{ QualifiedApiName: 'My_Event__e', Label: 'My Event' }],
      })) as unknown as SalesforceApiClient['apiGet'],
    });

    const feature = createEventMonitorFeature({ api, connect: conn.connect });
    await feature.onActivate?.();
    await new Promise((r) => setTimeout(r, 0));

    const subscribeBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Subscribe',
    ) as HTMLButtonElement;
    const unsubscribeBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Unsubscribe',
    ) as HTMLButtonElement;

    subscribeBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(subscribeBtn.disabled).toBe(true);
    expect(unsubscribeBtn.disabled).toBe(false);

    // Worker evicted / session lost → Port disconnects.
    conn.last()!.fireDisconnect();

    const statusLabel = Array.from(document.querySelectorAll('span')).find((s) => s.textContent === 'Disconnected');
    expect(statusLabel).not.toBeUndefined();
    expect(subscribeBtn.disabled).toBe(false);
    expect(unsubscribeBtn.disabled).toBe(true);
  });
});
