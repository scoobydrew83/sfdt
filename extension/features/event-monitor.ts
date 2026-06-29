import { z } from 'zod';
import { CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import {
  getSalesforceApi,
  type QueryEnvelope,
  type SalesforceApiClient,
} from '../lib/salesforce-api.js';
import { registerSettingsShape } from '../lib/settings.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';

const EVENT_MONITOR_SETTINGS_SCHEMA = z.object({
  historyEnabled: z.boolean().default(true),
});

registerSettingsShape('event-monitor', EVENT_MONITOR_SETTINGS_SCHEMA);

// Bayeux/CometD `ext` field — this client only uses the Salesforce replay
// extension (replayId per channel), but servers may echo arbitrary keys.
interface BayeuxExt {
  replay?: Record<string, number>;
  [key: string]: unknown;
}

export interface BayeuxMessage {
  channel: string;
  clientId?: string;
  version?: string;
  minimumVersion?: string;
  supportedConnectionTypes?: string[];
  connectionType?: string;
  subscription?: string;
  ext?: BayeuxExt;
  id?: string;
  // Event payload shape depends entirely on the subscribed channel; consumers
  // must narrow before use.
  data?: unknown;
  successful?: boolean;
  error?: string;
}

export class SalesforceBayeuxClient {
  private clientId = '';
  private isConnected = false;
  private abortController: AbortController | null = null;
  private messageListener: ((message: unknown) => void) | null = null;
  private statusListener: ((status: string, isError: boolean) => void) | null = null;
  private connectAttempts = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly sessionId: string,
    private readonly apiVersion: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  onMessage(callback: (message: unknown) => void): void {
    this.messageListener = callback;
  }

  onStatus(callback: (status: string, isError: boolean) => void): void {
    this.statusListener = callback;
  }

  private logStatus(status: string, isError = false): void {
    if (this.statusListener) {
      this.statusListener(status, isError);
    }
  }

  async start(channelPath: string, replayId: number): Promise<void> {
    if (this.isConnected) return;
    this.isConnected = true;
    this.connectAttempts = 0;
    this.abortController = new AbortController();

    try {
      this.logStatus('Initiating handshake...');
      const endpoint = `${this.baseUrl}/cometd/${this.apiVersion.replace(/^v/, '')}`;

      // 1. Handshake
      const handshakePayload: BayeuxMessage[] = [
        {
          version: '1.0',
          minimumVersion: '0.9',
          channel: '/meta/handshake',
          supportedConnectionTypes: ['long-polling'],
        },
      ];

      const handshakeRes = await this.post<BayeuxMessage[]>(endpoint, handshakePayload);
      const handshakeData = handshakeRes[0];
      if (!handshakeData || !handshakeData.successful || !handshakeData.clientId) {
        throw new Error(handshakeData?.error || 'Handshake failed');
      }

      this.clientId = handshakeData.clientId;
      this.logStatus('Handshake successful. Subscribing...');

      // 2. Subscribe
      const subscribePayload: BayeuxMessage[] = [
        {
          channel: '/meta/subscribe',
          clientId: this.clientId,
          subscription: channelPath,
          ext: {
            replay: {
              [channelPath]: replayId,
            },
          },
        },
      ];

      const subscribeRes = await this.post<BayeuxMessage[]>(endpoint, subscribePayload);
      const subscribeData = subscribeRes[0];
      if (!subscribeData || !subscribeData.successful) {
        throw new Error(subscribeData?.error || 'Subscription failed');
      }

      this.logStatus(`Listening on ${channelPath}...`);
      
      // 3. Connect Loop
      void this.connectLoop(endpoint, channelPath);

    } catch (err) {
      this.isConnected = false;
      const message = err instanceof Error ? err.message : String(err);
      this.logStatus(`Connection failed: ${message}`, true);
    }
  }

  private async connectLoop(endpoint: string, channelPath: string): Promise<void> {
    while (this.isConnected) {
      try {
        const connectPayload: BayeuxMessage[] = [
          {
            channel: '/meta/connect',
            clientId: this.clientId,
            connectionType: 'long-polling',
          },
        ];

        const messages = await this.post<BayeuxMessage[]>(endpoint, connectPayload);
        this.connectAttempts = 0;

        for (const msg of messages) {
          if (msg.channel === channelPath && msg.data) {
            if (this.messageListener) {
              this.messageListener(msg.data);
            }
          }
          if (msg.channel === '/meta/connect' && msg.successful === false) {
            this.logStatus(`Connection lost: ${msg.error || 'Unknown error'}`, true);
            void this.stop();
            return;
          }
        }
      } catch (err) {
        if ((err instanceof Error && err.name === 'AbortError') || !this.isConnected) {
          break;
        }
        this.connectAttempts++;
        const message = err instanceof Error ? err.message : String(err);
        this.logStatus(`Connection error (attempt ${this.connectAttempts}): ${message}`, true);
        
        // Exponential backoff up to 30 seconds
        const delay = Math.min(30000, 1000 * Math.pow(2, this.connectAttempts));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.isConnected) return;
    this.isConnected = false;
    this.abortController?.abort();

    try {
      const endpoint = `${this.baseUrl}/cometd/${this.apiVersion.replace(/^v/, '')}`;
      const disconnectPayload: BayeuxMessage[] = [
        {
          channel: '/meta/disconnect',
          clientId: this.clientId,
        },
      ];
      await this.post<BayeuxMessage[]>(endpoint, disconnectPayload).catch(() => {});
    } finally {
      this.logStatus('Disconnected');
    }
  }

  private async post<T>(url: string, body: BayeuxMessage[]): Promise<T> {
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.sessionId}`,
      },
      body: JSON.stringify(body),
      signal: this.abortController?.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
    }

    return (await response.json()) as T;
  }
}

interface ChannelOption {
  name: string;
  label: string;
}

export function createEventMonitorFeature(options: {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
} = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();

  let view: ViewHandle | null = null;
  let client: SalesforceBayeuxClient | null = null;

  // Live-stream teardown — must run whenever the view closes (tab close fires
  // onClose; modal dismiss / re-open call close()). Stops the Bayeux long-poll.
  function stopStream(): void {
    if (client) {
      void client.stop();
      client = null;
    }
  }

  // UI state
  let selectedChannelType = 'platformEvent';
  let selectedChannelName = '';
  let customChannelPath = '';
  let replayId = -1;
  let eventFilter = '';
  let showMetrics = false;
  const events: unknown[] = [];
  let selectedEvent: unknown = null;

  // Cached lists
  const channelsCache: Record<string, ChannelOption[]> = {
    standardPlatformEvent: [],
    platformEvent: [],
    customChannel: [],
    changeEvent: [],
  };

  function close(): void {
    stopStream();
    view?.close();
    view = null;
  }

  async function fetchChannels(type: string): Promise<ChannelOption[]> {
    if (channelsCache[type]?.length) {
      return channelsCache[type];
    }

    const apiVersion = api.apiVersion;
    let query = '';
    const list: ChannelOption[] = [];

    try {
      if (type === 'standardPlatformEvent') {
        query = "SELECT Label, QualifiedApiName FROM EntityDefinition WHERE IsCustomizable = FALSE AND IsEverCreatable = TRUE AND QualifiedApiName LIKE '%Event' AND (NOT QualifiedApiName LIKE '%ChangeEvent') ORDER BY Label ASC LIMIT 200";
        const res = await api.apiGet<QueryEnvelope<{ Label: string; QualifiedApiName: string }>>(
          `/services/data/${apiVersion}/query`,
          { q: query },
        );
        if (res && res.records) {
          res.records.forEach((r) => {
            list.push({ name: r.QualifiedApiName, label: `${r.Label} (${r.QualifiedApiName})` });
          });
        }
      } else if (type === 'platformEvent') {
        query = "SELECT QualifiedApiName, Label FROM EntityDefinition WHERE isCustomizable = TRUE AND KeyPrefix LIKE 'e%' ORDER BY Label ASC";
        const res = await api.apiGet<QueryEnvelope<{ Label: string; QualifiedApiName: string }>>(
          `/services/data/${apiVersion}/query`,
          { q: query },
        );
        if (res && res.records) {
          res.records.forEach((r) => {
            list.push({ name: r.QualifiedApiName, label: `${r.Label} (${r.QualifiedApiName})` });
          });
        }
      } else if (type === 'customChannel') {
        query = 'SELECT FullName, MasterLabel FROM PlatformEventChannel ORDER BY DeveloperName';
        const res = await api.toolingQuery<{ FullName: string; MasterLabel: string }>(query);
        if (res && res.records) {
          res.records.forEach((r) => {
            list.push({ name: r.FullName, label: `${r.MasterLabel} (${r.FullName})` });
          });
        }
      } else if (type === 'changeEvent') {
        list.push({ name: 'ChangeEvents', label: 'All Change Events (ChangeEvents)' });
        query = "SELECT MasterLabel, SelectedEntity FROM PlatformEventChannelMember WHERE EventChannel = 'ChangeEvents' ORDER BY MasterLabel";
        const res = await api.toolingQuery<{ MasterLabel: string; SelectedEntity?: string }>(query);
        if (res && res.records) {
          res.records.forEach((r) => {
            const label = r.SelectedEntity ? r.SelectedEntity.replace(/([A-Z])/g, ' $1').trim() : r.MasterLabel;
            list.push({ name: `${r.SelectedEntity}ChangeEvent`, label: `${label} Change Event` });
          });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[SFDT] Failed to fetch channels for ${type}: ${message}`);
    }

    if (list.length === 0) {
      list.push({ name: '', label: `No ${type} channels active` });
    }

    channelsCache[type] = list;
    return list;
  }

  let channelSelect: HTMLSelectElement | null = null;
  async function updateChannelDropdown(): Promise<void> {
    if (!channelSelect) return;
    channelSelect.replaceChildren();
    const list = await fetchChannels(selectedChannelType);
    list.forEach(c => {
      const opt = doc.createElement('option');
      opt.value = c.name;
      opt.textContent = c.label;
      channelSelect!.appendChild(opt);
    });
    if (list.length > 0) {
      selectedChannelName = list[0]!.name;
    }
  }

  let eventListContainer: HTMLDivElement | null = null;
  function renderEvents(): void {
    if (!eventListContainer) return;
    eventListContainer.replaceChildren();

    const filtered = events.filter(e => {
      if (!eventFilter) return true;
      return JSON.stringify(e).toLowerCase().includes(eventFilter);
    });

    if (filtered.length === 0) {
      const empty = doc.createElement('div');
      empty.textContent = 'No events received yet';
      empty.style.cssText = 'padding: 12px; color: #80868d; font-size: 13px; text-align: center;';
      eventListContainer.appendChild(empty);
      return;
    }

    filtered.forEach((e) => {
      const item = doc.createElement('div');
      item.style.cssText = 'padding: 8px; border-bottom: 1px solid #d8dde6; cursor: pointer; font-family: monospace; font-size: 11px; white-space: pre-wrap;';
      
      if (selectedEvent === e) {
        item.style.background = '#f3f3f3';
        item.style.borderLeft = '3px solid #0070d2';
      }

      item.textContent = JSON.stringify(e, null, 2);
      item.addEventListener('click', () => {
        selectedEvent = e;
        renderEvents();
        renderEventDetails();
      });

      eventListContainer!.appendChild(item);
    });
  }

  let detailsPane: HTMLPreElement | null = null;
  function renderEventDetails(): void {
    if (!detailsPane) return;
    if (selectedEvent) {
      detailsPane.textContent = JSON.stringify(selectedEvent, null, 2);
    } else {
      detailsPane.textContent = 'Select an event to inspect details';
    }
  }

  let limitsContainer: HTMLDivElement | null = null;
  async function toggleMetrics(): Promise<void> {
    showMetrics = !showMetrics;
    if (limitsContainer) {
      limitsContainer.style.display = showMetrics ? 'block' : 'none';
    }
    if (showMetrics && limitsContainer) {
      limitsContainer.textContent = 'Loading limits...';
      try {
        const res = await api.limits();
        limitsContainer.replaceChildren();
        const keys = Object.keys(res).filter(k => k.includes('PlatformEvent') || k.includes('Streaming'));
        if (keys.length === 0) {
          limitsContainer.textContent = 'No Platform Event limits returned by org.';
          return;
        }
        keys.forEach(k => {
          const limit = res[k]!;
          const percentage = ((limit.Max - limit.Remaining) / limit.Max * 100).toFixed(1);
          const p = doc.createElement('p');
          p.style.cssText = 'margin: 4px 0; font-size: 12px; color: #3e3e3c;';
          p.textContent = `${k}: Remaining ${limit.Remaining} out of ${limit.Max} (${percentage}% consumed)`;
          limitsContainer!.appendChild(p);
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        limitsContainer.textContent = `Failed to load limits: ${message}`;
      }
    }
  }

  let statusLabel: HTMLSpanElement | null = null;
  function updateStatus(status: string, isError: boolean): void {
    if (statusLabel) {
      statusLabel.textContent = status;
      statusLabel.style.color = isError ? '#c23934' : '#54698d';
    }
  }

  async function open(): Promise<void> {
    close();

    // Body
    const body = doc.createElement('div');
    body.style.cssText = 'padding: 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 16px;';

    // Filter Config Row
    const configRow = doc.createElement('div');
    configRow.style.cssText = 'display: grid; grid-template-columns: 1.5fr 1fr 1.5fr 100px; gap: 8px; border-bottom: 1px solid #e0e0e0; padding-bottom: 16px;';
    body.appendChild(configRow);

    const typeDiv = doc.createElement('div');
    typeDiv.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';
    const typeLabel = doc.createElement('label');
    typeLabel.textContent = 'Channel Type';
    typeLabel.style.cssText = 'font-size: 11px; font-weight: 600; color: #54698d;';
    const typeSelect = doc.createElement('select');
    typeSelect.style.cssText = 'padding: 6px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 13px; outline: none;';
    [
      { v: 'platformEvent', l: 'Custom Platform Event' },
      { v: 'standardPlatformEvent', l: 'Standard Platform Event' },
      { v: 'changeEvent', l: 'Change Event (CDC)' },
      { v: 'customChannel', l: 'Custom Event Channel' },
    ].forEach(t => {
      const opt = doc.createElement('option');
      opt.value = t.v;
      opt.textContent = t.l;
      typeSelect.appendChild(opt);
    });
    typeDiv.appendChild(typeLabel);
    typeDiv.appendChild(typeSelect);
    configRow.appendChild(typeDiv);

    const nameDiv = doc.createElement('div');
    nameDiv.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';
    const nameLabel = doc.createElement('label');
    nameLabel.textContent = 'Channel Name';
    nameLabel.style.cssText = 'font-size: 11px; font-weight: 600; color: #54698d;';
    channelSelect = doc.createElement('select');
    channelSelect.style.cssText = 'padding: 6px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 13px; outline: none;';
    nameDiv.appendChild(nameLabel);
    nameDiv.appendChild(channelSelect);
    configRow.appendChild(nameDiv);

    const customDiv = doc.createElement('div');
    customDiv.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';
    const customLabel = doc.createElement('label');
    customLabel.textContent = 'Or Custom Channel Path';
    customLabel.style.cssText = 'font-size: 11px; font-weight: 600; color: #54698d;';
    const customInput = doc.createElement('input');
    customInput.type = 'text';
    customInput.placeholder = '/event/MyCustomEvent__e';
    customInput.style.cssText = 'padding: 6px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 13px; outline: none;';
    customInput.addEventListener('input', () => {
      customChannelPath = customInput.value.trim();
    });
    customDiv.appendChild(customLabel);
    customDiv.appendChild(customInput);
    configRow.appendChild(customDiv);

    const replayDiv = doc.createElement('div');
    replayDiv.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';
    const replayLabel = doc.createElement('label');
    replayLabel.textContent = 'Replay From';
    replayLabel.style.cssText = 'font-size: 11px; font-weight: 600; color: #54698d;';
    const replayInput = doc.createElement('input');
    replayInput.type = 'number';
    replayInput.value = '-1';
    replayInput.style.cssText = 'padding: 6px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 13px; outline: none;';
    replayInput.addEventListener('change', () => {
      replayId = parseInt(replayInput.value, 10) || -1;
    });
    replayDiv.appendChild(replayLabel);
    replayDiv.appendChild(replayInput);
    configRow.appendChild(replayDiv);

    typeSelect.addEventListener('change', async () => {
      selectedChannelType = typeSelect.value;
      await updateChannelDropdown();
    });

    channelSelect.addEventListener('change', () => {
      selectedChannelName = channelSelect!.value;
    });

    await updateChannelDropdown();

    // Streaming Control Actions Row
    const actionRow = doc.createElement('div');
    actionRow.style.cssText = 'display: flex; gap: 8px; align-items: center;';
    body.appendChild(actionRow);

    const subscribeBtn = doc.createElement('button');
    subscribeBtn.textContent = 'Subscribe';
    subscribeBtn.style.cssText = 'padding: 6px 16px; background: #0070d2; color: #fff; border: 0; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 600;';
    
    const unsubscribeBtn = doc.createElement('button');
    unsubscribeBtn.textContent = 'Unsubscribe';
    unsubscribeBtn.disabled = true;
    unsubscribeBtn.style.cssText = 'padding: 6px 16px; border: 1px solid #d8dde6; border-radius: 4px; background: #fff; cursor: pointer; font-size: 13px; color: #3e3e3c;';

    statusLabel = doc.createElement('span');
    statusLabel.style.cssText = 'font-size: 12px; color: #54698d; margin-left: 8px;';
    statusLabel.textContent = 'Ready to stream';

    const limitsBtn = doc.createElement('button');
    limitsBtn.textContent = 'Limits Metrics';
    limitsBtn.style.cssText = 'padding: 6px 12px; border: 1px solid #d8dde6; border-radius: 4px; background: #fff; cursor: pointer; font-size: 12px; color: #54698d; margin-left: auto;';
    limitsBtn.addEventListener('click', () => {
      void toggleMetrics();
    });

    actionRow.appendChild(subscribeBtn);
    actionRow.appendChild(unsubscribeBtn);
    actionRow.appendChild(statusLabel);
    actionRow.appendChild(limitsBtn);

    // Limits pane
    limitsContainer = doc.createElement('div');
    limitsContainer.style.cssText = 'display: none; padding: 10px; background: #fef8f3; border: 1px solid #fe9339; border-radius: 4px; margin-bottom: 8px;';
    body.appendChild(limitsContainer);

    subscribeBtn.addEventListener('click', async () => {
      let path = '';
      if (customChannelPath) {
        path = customChannelPath;
      } else if (selectedChannelName) {
        const prefix = selectedChannelType === 'changeEvent' ? '/data/' : '/event/';
        path = `${prefix}${selectedChannelName}`;
      }

      if (!path) {
        showToast('Please specify or select a streaming channel first.', { doc, kind: 'warning' });
        return;
      }

      subscribeBtn.disabled = true;
      typeSelect.disabled = true;
      channelSelect!.disabled = true;
      customInput.disabled = true;
      replayInput.disabled = true;

      const details = await api.getSessionDetails();
      if (!details) {
        showToast('No active Salesforce session found.', { doc, kind: 'error' });
        subscribeBtn.disabled = false;
        return;
      }

      client = new SalesforceBayeuxClient(details.baseUrl, details.sid, api.apiVersion);
      
      client.onStatus((status, isErr) => {
        updateStatus(status, isErr);
      });

      client.onMessage((msg) => {
        events.unshift(msg);
        renderEvents();
      });

      unsubscribeBtn.disabled = false;

      void client.start(path, replayId);
    });

    unsubscribeBtn.addEventListener('click', async () => {
      if (client) {
        await client.stop();
        client = null;
      }
      subscribeBtn.disabled = false;
      unsubscribeBtn.disabled = true;
      typeSelect.disabled = false;
      channelSelect!.disabled = false;
      customInput.disabled = false;
      replayInput.disabled = false;
    });

    // Content Display Area
    const contentRow = doc.createElement('div');
    contentRow.style.cssText = 'flex: 1; display: flex; gap: 16px; overflow: hidden; height: 350px;';
    body.appendChild(contentRow);

    // Left List Pane
    const listWrap = doc.createElement('div');
    listWrap.style.cssText = 'flex: 1; display: flex; flex-direction: column; border: 1px solid #d8dde6; border-radius: 4px; overflow: hidden;';
    contentRow.appendChild(listWrap);

    const listBar = doc.createElement('div');
    listBar.style.cssText = 'background: #fafaf9; border-bottom: 1px solid #d8dde6; padding: 6px 12px; display: flex; align-items: center; justify-content: space-between;';
    const filterInput = doc.createElement('input');
    filterInput.type = 'text';
    filterInput.placeholder = 'Filter events...';
    filterInput.style.cssText = 'padding: 4px 6px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 12px; width: 150px;';
    filterInput.addEventListener('input', () => {
      eventFilter = filterInput.value.toLowerCase();
      renderEvents();
    });
    const clearEventsBtn = doc.createElement('button');
    clearEventsBtn.textContent = 'Clear';
    clearEventsBtn.style.cssText = 'padding: 4px 10px; border: 1px solid #d8dde6; border-radius: 4px; background: #fff; font-size: 11px; cursor: pointer; color: #54698d;';
    clearEventsBtn.addEventListener('click', () => {
      events.length = 0;
      selectedEvent = null;
      renderEvents();
      renderEventDetails();
    });

    listBar.appendChild(filterInput);
    listBar.appendChild(clearEventsBtn);
    listWrap.appendChild(listBar);

    eventListContainer = doc.createElement('div');
    eventListContainer.style.cssText = 'flex: 1; overflow-y: auto; background: #fff;';
    listWrap.appendChild(eventListContainer);

    // Right Details Inspector Pane
    const detailsWrap = doc.createElement('div');
    detailsWrap.style.cssText = 'width: 400px; display: flex; flex-direction: column; border: 1px solid #d8dde6; border-radius: 4px; overflow: hidden;';
    contentRow.appendChild(detailsWrap);

    const detailsBar = doc.createElement('div');
    detailsBar.style.cssText = 'background: #fafaf9; border-bottom: 1px solid #d8dde6; padding: 6px 12px; display: flex; align-items: center; justify-content: space-between;';
    const detailsTitle = doc.createElement('span');
    detailsTitle.textContent = 'Event Details';
    detailsTitle.style.cssText = 'font-size: 12px; font-weight: 600; color: #3e3e3c;';
    const copyJsonBtn = doc.createElement('button');
    copyJsonBtn.textContent = 'Copy JSON';
    copyJsonBtn.style.cssText = 'padding: 4px 10px; border: 1px solid #d8dde6; border-radius: 4px; background: #fff; font-size: 11px; cursor: pointer; color: #54698d;';
    copyJsonBtn.addEventListener('click', () => {
      if (selectedEvent) {
        void win.navigator.clipboard.writeText(JSON.stringify(selectedEvent, null, 2));
        showToast('Event payload copied', { doc, kind: 'success' });
      }
    });

    detailsBar.appendChild(detailsTitle);
    detailsBar.appendChild(copyJsonBtn);
    detailsWrap.appendChild(detailsBar);

    detailsPane = doc.createElement('pre');
    detailsPane.style.cssText = 'flex: 1; overflow-y: auto; margin: 0; padding: 10px; background: #fafaf9; font-family: monospace; font-size: 11px; color: #16325c; white-space: pre-wrap; word-break: break-all;';
    detailsWrap.appendChild(detailsPane);

    renderEvents();
    renderEventDetails();

    view = presentView({
      title: '📡 Event Streaming Monitor',
      body,
      doc,
      width: '960px',
      onClose: () => {
        stopStream();
        view = null;
      },
    });
  }

  return {
    manifest: {
      id: 'event-monitor',
      name: 'Event Streaming Monitor',
      contexts: [
        CONTEXTS.SETUP_FLOWS,
        CONTEXTS.SETUP_OTHER,
        CONTEXTS.FLOW_BUILDER,
        CONTEXTS.FLOW_TRIGGER_EXPLORER,
        CONTEXTS.RECORD_PAGE,
      ],
    },
    async onActivate() {
      await open();
    },
  };
}
