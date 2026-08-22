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
import { setTone, button, toolbar } from '../lib/ui-controls.js';
import { clearSfError, setSfError } from '../ui/panels.js';
import { copyToClipboard } from '../ui/clipboard.js';
import { eventChannelQuery, type EventChannelKind } from '@sfdt/flow-core';

const EVENT_MONITOR_SETTINGS_SCHEMA = z.object({
  historyEnabled: z.boolean().default(true),
});

registerSettingsShape('event-monitor', EVENT_MONITOR_SETTINGS_SCHEMA);

// Client (page) side of the `sfApiStream` Port. The CometD/Bayeux long-poll and
// the sid live entirely in the service worker (lib/sf-stream-worker.ts); this
// feature only sends subscribe/unsubscribe and renders the status/event
// messages the worker pushes back.
interface StreamClientPort {
  postMessage(message: unknown): void;
  onMessage: { addListener(cb: (message: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
  disconnect(): void;
}

// Messages the worker pushes back over the Port.
type StreamInbound =
  | { type: 'status'; status: string; isError?: boolean }
  | { type: 'event'; data: unknown };

interface ChannelOption {
  name: string;
  label: string;
}

export function createEventMonitorFeature(options: {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
  // Injectable so tests can supply a mock Port without chrome.runtime.
  connect?: (name: string) => StreamClientPort;
} = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();
  const connect =
    options.connect ?? ((name: string) => chrome.runtime.connect({ name }) as StreamClientPort);

  let view: ViewHandle | null = null;
  let port: StreamClientPort | null = null;

  // Live-stream teardown — must run whenever the view closes (tab close fires
  // onClose; modal dismiss / re-open call close()). Disconnecting the Port stops
  // the worker-side long-poll.
  function stopStream(): void {
    if (port) {
      try {
        port.postMessage({ cmd: 'unsubscribe' });
      } catch {
        // Port already gone — disconnect below is a no-op.
      }
      port.disconnect();
      port = null;
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
    const list: ChannelOption[] = [];

    // The SOQL lives in flow-core so `sfdt events list` enumerates exactly the
    // same channels — one surface offering a channel the other does not is a
    // support question nobody can answer.
    const { soql, tooling } = eventChannelQuery(type as EventChannelKind);

    try {
      if (type === 'standardPlatformEvent' || type === 'platformEvent') {
        const res = await api.apiGet<QueryEnvelope<{ Label: string; QualifiedApiName: string }>>(
          `/services/data/${apiVersion}/query`,
          { q: soql },
        );
        if (res && res.records) {
          res.records.forEach((r) => {
            list.push({ name: r.QualifiedApiName, label: `${r.Label} (${r.QualifiedApiName})` });
          });
        }
      } else if (tooling && type === 'customChannel') {
        const res = await api.toolingQuery<{ FullName: string; MasterLabel: string }>(soql);
        if (res && res.records) {
          res.records.forEach((r) => {
            list.push({ name: r.FullName, label: `${r.MasterLabel} (${r.FullName})` });
          });
        }
      } else if (tooling && type === 'changeEvent') {
        list.push({ name: 'ChangeEvents', label: 'All Change Events (ChangeEvents)' });
        const res = await api.toolingQuery<{ MasterLabel: string; SelectedEntity?: string }>(soql);
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
      empty.style.cssText = 'padding: 12px; color: var(--sfdt-color-text-icon); font-size: 13px; text-align: center;';
      eventListContainer.appendChild(empty);
      return;
    }

    filtered.forEach((e) => {
      const item = doc.createElement('div');
      item.style.cssText = 'padding: 8px; border-bottom: 1px solid var(--sfdt-color-border); cursor: pointer; font-family: monospace; font-size: 11px; white-space: pre-wrap;';
      
      if (selectedEvent === e) {
        item.classList.add('sfdt-row-active');
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
      clearSfError(limitsContainer);
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
          p.classList.add('sfdt-muted');
          p.textContent = `${k}: Remaining ${limit.Remaining} out of ${limit.Max} (${percentage}% consumed)`;
          limitsContainer!.appendChild(p);
        });
      } catch (err) {
        // The error object, not `err.message`: a failure from
        // lib/salesforce-api.ts carries the org's text and our guidance as
        // separate parts on `.userFacing`, and flattening it here is the #308
        // defect. Until C-FIX-4 round 4 this rendered as bare text in a
        // hand-styled div — no class, no role, no white-space rule.
        setSfError(limitsContainer, err, { doc });
      }
    }
  }

  let statusLabel: HTMLSpanElement | null = null;
  function updateStatus(status: string, isError: boolean): void {
    if (statusLabel) {
      statusLabel.textContent = status;
      setTone(statusLabel, isError ? 'bad' : 'muted');
    }
  }

  async function open(): Promise<void> {
    close();

    // Body
    const body = doc.createElement('div');
    body.className = 'sfdt-view-body';
    // The channel/filter row is this view's toolbar — it stays put while the
    // event stream scrolls under it, which is the whole point of a live monitor.
    const configRow = toolbar(doc);
    configRow.classList.add('sfdt-wrap');
    body.appendChild(configRow);

    const main = doc.createElement('div');
    main.className = 'sfdt-view-main';
    body.appendChild(main);

    const typeDiv = doc.createElement('div');
    typeDiv.classList.add('sfdt-stack', 'sfdt-tight');
    const typeLabel = doc.createElement('label');
    typeLabel.textContent = 'Channel Type';
    typeLabel.className = 'sfdt-label';
    const typeSelect = doc.createElement('select');
    typeSelect.className = 'sfdt-field sfdt-auto';
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
    nameDiv.classList.add('sfdt-stack', 'sfdt-tight');
    const nameLabel = doc.createElement('label');
    nameLabel.textContent = 'Channel Name';
    nameLabel.className = 'sfdt-label';
    channelSelect = doc.createElement('select');
    channelSelect.style.cssText = 'padding: 6px; border: 1px solid var(--sfdt-color-border); border-radius: 4px; font-size: 13px; outline: none;';
    nameDiv.appendChild(nameLabel);
    nameDiv.appendChild(channelSelect);
    configRow.appendChild(nameDiv);

    const customDiv = doc.createElement('div');
    customDiv.classList.add('sfdt-stack', 'sfdt-tight');
    const customLabel = doc.createElement('label');
    customLabel.textContent = 'Or Custom Channel Path';
    customLabel.className = 'sfdt-label';
    const customInput = doc.createElement('input');
    customInput.type = 'text';
    customInput.placeholder = '/event/MyCustomEvent__e';
    customInput.className = 'sfdt-field sfdt-auto';
    customInput.addEventListener('input', () => {
      customChannelPath = customInput.value.trim();
    });
    customDiv.appendChild(customLabel);
    customDiv.appendChild(customInput);
    configRow.appendChild(customDiv);

    const replayDiv = doc.createElement('div');
    replayDiv.classList.add('sfdt-stack', 'sfdt-tight');
    const replayLabel = doc.createElement('label');
    replayLabel.textContent = 'Replay From';
    replayLabel.className = 'sfdt-label';
    const replayInput = doc.createElement('input');
    replayInput.type = 'number';
    replayInput.value = '-1';
    replayInput.className = 'sfdt-field sfdt-auto';
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
    actionRow.classList.add('sfdt-row');
    main.appendChild(actionRow);

    const subscribeBtn = button({ label: 'Subscribe', iconName: 'wave', variant: 'primary', doc });
    const unsubscribeBtn = button({ label: 'Unsubscribe', iconName: 'close', doc });
    unsubscribeBtn.disabled = true;

    statusLabel = doc.createElement('span');
    statusLabel.className = 'sfdt-muted';
    statusLabel.textContent = 'Ready to stream';

    const limitsBtn = button({ label: 'Limits Metrics', iconName: 'gauge', small: true, doc });
    limitsBtn.classList.add('sfdt-toolbar-end');
    limitsBtn.addEventListener('click', () => {
      void toggleMetrics();
    });

    actionRow.appendChild(subscribeBtn);
    actionRow.appendChild(unsubscribeBtn);
    actionRow.appendChild(statusLabel);
    actionRow.appendChild(limitsBtn);

    // Limits pane
    limitsContainer = doc.createElement('div');
    limitsContainer.style.cssText = 'display: none; padding: 10px; background: var(--sfdt-color-warning-bg-4); border: 1px solid var(--sfdt-color-warning); border-radius: 4px; margin-bottom: 8px;';
    main.appendChild(limitsContainer);

    function setControlsDisabled(disabled: boolean): void {
      typeSelect.disabled = disabled;
      channelSelect!.disabled = disabled;
      customInput.disabled = disabled;
      replayInput.disabled = disabled;
    }

    // Return the UI to the idle (not-streaming) state so Subscribe works again.
    // Shared by explicit unsubscribe and by Port disconnect.
    function resetToIdle(): void {
      subscribeBtn.disabled = false;
      unsubscribeBtn.disabled = true;
      setControlsDisabled(false);
    }

    subscribeBtn.addEventListener('click', () => {
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
      setControlsDisabled(true);
      unsubscribeBtn.disabled = false;

      // Open the long-lived Port to the worker. The worker reads the sid,
      // opens the CometD long-poll, and streams status/event messages back —
      // the sid never reaches this page.
      port = connect('sfApiStream');

      port.onMessage.addListener((raw) => {
        const msg = raw as StreamInbound;
        if (msg?.type === 'status') {
          updateStatus(msg.status, !!msg.isError);
        } else if (msg?.type === 'event') {
          events.unshift(msg.data);
          renderEvents();
        }
      });

      port.onDisconnect.addListener(() => {
        // Worker evicted (MV3), session lost, or worker closed the Port. Surface
        // it and re-enable Subscribe so the user can reconnect/re-subscribe.
        port = null;
        updateStatus('Disconnected', false);
        resetToIdle();
      });

      port.postMessage({
        cmd: 'subscribe',
        channelPath: path,
        replayId,
        // App-tab callers pass their org origin; content scripts omit it and the
        // worker falls back to the validated sender origin.
        targetOrigin: api.orgOrigin ?? undefined,
      });
    });

    unsubscribeBtn.addEventListener('click', () => {
      if (port) {
        port.postMessage({ cmd: 'unsubscribe' });
        port.disconnect();
        port = null;
      }
      resetToIdle();
    });

    // Content Display Area
    const contentRow = doc.createElement('div');
    contentRow.style.cssText = 'flex: 1; display: flex; gap: 16px; overflow: hidden; height: 350px;';
    main.appendChild(contentRow);

    // Left List Pane
    const listWrap = doc.createElement('div');
    listWrap.style.cssText = 'flex: 1; display: flex; flex-direction: column; border: 1px solid var(--sfdt-color-border); border-radius: 4px; overflow: hidden;';
    contentRow.appendChild(listWrap);

    const listBar = doc.createElement('div');
    listBar.style.cssText = 'background: var(--sfdt-color-surface-alt); border-bottom: 1px solid var(--sfdt-color-border); padding: 6px 12px; display: flex; align-items: center; justify-content: space-between;';
    const filterInput = doc.createElement('input');
    filterInput.type = 'text';
    filterInput.placeholder = 'Filter events...';
    filterInput.className = 'sfdt-field sfdt-auto';
    filterInput.addEventListener('input', () => {
      eventFilter = filterInput.value.toLowerCase();
      renderEvents();
    });
    const clearEventsBtn = button({ label: 'Clear', iconName: 'trash', small: true, doc });
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
    eventListContainer.style.cssText = 'flex: 1; overflow-y: auto; background: var(--sfdt-color-surface);';
    listWrap.appendChild(eventListContainer);

    // Right Details Inspector Pane
    const detailsWrap = doc.createElement('div');
    detailsWrap.style.cssText = 'width: 400px; display: flex; flex-direction: column; border: 1px solid var(--sfdt-color-border); border-radius: 4px; overflow: hidden;';
    contentRow.appendChild(detailsWrap);

    const detailsBar = doc.createElement('div');
    detailsBar.style.cssText = 'background: var(--sfdt-color-surface-alt); border-bottom: 1px solid var(--sfdt-color-border); padding: 6px 12px; display: flex; align-items: center; justify-content: space-between;';
    const detailsTitle = doc.createElement('span');
    detailsTitle.textContent = 'Event Details';
    detailsTitle.classList.add('sfdt-subhead');
    const copyJsonBtn = button({ label: 'Copy JSON', iconName: 'clipboard', small: true, doc });
    copyJsonBtn.addEventListener('click', () => {
      if (selectedEvent) {
        void copyToClipboard(JSON.stringify(selectedEvent, null, 2), {
          doc,
          win,
          label: 'event payload',
        });
      }
    });

    detailsBar.appendChild(detailsTitle);
    detailsBar.appendChild(copyJsonBtn);
    detailsWrap.appendChild(detailsBar);

    detailsPane = doc.createElement('pre');
    detailsPane.style.cssText = 'flex: 1; overflow-y: auto; margin: 0; padding: 10px; background: var(--sfdt-color-surface-alt); font-family: monospace; font-size: 11px; color: var(--sfdt-color-text-strong); white-space: pre-wrap; word-break: break-all;';
    detailsWrap.appendChild(detailsPane);

    renderEvents();
    renderEventDetails();

    view = presentView({
      title: 'Event Streaming Monitor',
      iconName: 'event-monitor',
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


