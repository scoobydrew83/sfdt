// Phase 5 — thin Workspace tools over three bridge kinds the contract defines
// but nothing surfaced: drift / scan / compare. Each builds a minimal input UI,
// calls `bridge.call({ kind, ... })`, and renders the result (modelled on
// org-health.ts, including the BRIDGE_OFFLINE / BRIDGE_UNAUTHORIZED hint).
// The contract's fourth kind, `quality`, is surfaced by features/flow-quality.ts
// instead (it runs the flow-core rulebook Direct in-browser, no bridge needed).
//
// These are dev-only: they need `sfdt ui` running to answer the bridge, exactly
// like flow-deploy. All the kinds are implemented server-side
// (src/lib/bridge/routes.js): `scan`/`compare` run live inventory diffs and
// `drift` returns (or refreshes) the drift snapshot. The generic JSON view
// shows each payload as-is; a missing kind would surface the bridge's own
// NOT_IMPLEMENTED message + hint.

import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import {
  getSalesforceApi,
  type SalesforceApiClient,
} from '../lib/salesforce-api.js';
import { createBridgeClient, LONG_RUNNING_TIMEOUT_MS } from '../lib/sfdt-bridge.js';
import { loadSettings } from '../lib/settings.js';
import { showToast } from '../ui/toast.js';
import { recordActivity } from '../lib/activity-log.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { renderSfError } from '../ui/panels.js';
import type { SfdtRequest, SfdtResponse } from '@sfdt/flow-core/bridge-contract';
import { button, toolbar } from '../lib/ui-controls.js';

type BridgeReq = Omit<SfdtRequest, 'requestId'>;

interface BridgeLike {
  call(request: BridgeReq, options?: { timeoutMs?: number }): Promise<SfdtResponse>;
}

function defaultBridgeFactory(): () => Promise<BridgeLike> {
  return async () => {
    const settings = await loadSettings();
    return createBridgeClient({
      token: settings.bridge.token,
      preferredTransport: settings.bridge.preferredTransport,
      localhostPort: settings.bridge.localhostPort,
      connectNativeImpl: chrome.runtime?.connectNative?.bind(chrome.runtime),
    });
  };
}

/** Short, actionable hint appended to a failed bridge response (mirrors org-health). */
export function bridgeErrorHint(response: Extract<SfdtResponse, { ok: false }>): string {
  switch (response.code) {
    case 'BRIDGE_OFFLINE':
      return ' — run `sfdt ui` in your Salesforce project to start the bridge.';
    case 'BRIDGE_UNAUTHORIZED':
      return ' — open extension settings and paste the bridge token from `~/.sfdt/bridge-token` (created when you run `sfdt ui`).';
    case 'NOT_IMPLEMENTED':
      return ' — this action is not wired up on the bridge yet (server-side stub).';
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Generic bridge-tool shell
// ---------------------------------------------------------------------------

export interface BridgeToolOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
  bridgeFactory?: () => Promise<BridgeLike>;
}

interface ToolSpec {
  id: string;
  name: string;
  title: string;
  /** Leading glyph for the view header (lib/icons.ts). */
  iconName: string;
  width: string;
  runLabel: string;
  /** Append input controls to `controls`; return a getRequest() that builds the
   *  bridge request (throw an Error with a user-facing message on bad input). */
  setupInputs(doc: Document, controls: HTMLElement, api: SalesforceApiClient): () => Promise<BridgeReq>;
  /** Render a successful response's `data` into `results`. */
  render(doc: Document, results: HTMLElement, data: unknown): void;
}

function renderJson(doc: Document, results: HTMLElement, data: unknown): void {
  const pre = doc.createElement('pre');
  pre.style.cssText =
    'margin: 0; padding: 12px; background: var(--sfdt-color-bg); border: 1px solid var(--sfdt-color-border); border-radius: 4px; font-size: 12px; white-space: pre-wrap; word-break: break-word;';
  pre.textContent = JSON.stringify(data ?? null, null, 2);
  results.appendChild(pre);
}

function createBridgeToolFeature(spec: ToolSpec, options: BridgeToolOptions): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();
  const bridgeFactory = options.bridgeFactory ?? defaultBridgeFactory();

  let view: ViewHandle | null = null;

  function close(): void {
    view?.close();
    view = null;
  }

  function renderError(results: HTMLElement, status: HTMLSpanElement, message: string): void {
    results.appendChild(renderSfError(message, { doc }));
    status.textContent = 'Failed';
    // The single failure sink for runOnce — every early return routes through
    // here, so one call covers a bad request, a !ok bridge reply, and a throw.
    void recordActivity({
      featureId: spec.id,
      action: spec.name,
      resource: message,
      status: 'failed',
    });
  }

  async function runOnce(
    getRequest: () => Promise<BridgeReq>,
    results: HTMLElement,
    status: HTMLSpanElement,
  ): Promise<void> {
    while (results.firstChild) results.removeChild(results.firstChild);
    status.textContent = 'Running…';
    let request: BridgeReq;
    try {
      request = await getRequest();
    } catch (err) {
      renderError(results, status, err instanceof Error ? err.message : String(err));
      return;
    }
    try {
      const bridge = await bridgeFactory();
      const response = await bridge.call(request, { timeoutMs: LONG_RUNNING_TIMEOUT_MS });
      if (!response.ok) {
        renderError(results, status, `${response.error}${bridgeErrorHint(response)}`);
        return;
      }
      spec.render(doc, results, response.data);
      status.textContent = 'Done';
      void recordActivity({ featureId: spec.id, action: spec.name, status: 'success' });
    } catch (err) {
      renderError(results, status, err instanceof Error ? err.message : String(err));
    }
  }

  async function open(): Promise<void> {
    close();

    const body = doc.createElement('div');
    body.className = 'sfdt-view-body';
    const bar = toolbar(doc);
    const controls = doc.createElement('div');
    controls.style.cssText = 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex: 1;';
    const runBtn = button({ label: spec.runLabel, iconName: 'play', variant: 'primary', small: true, doc });
    const status = doc.createElement('span');
    status.className = 'sfdt-muted';
    bar.append(controls, runBtn, status);
    body.appendChild(bar);
    const main = doc.createElement('div');
    main.className = 'sfdt-view-main';
    body.appendChild(main);

    const results = doc.createElement('div');
    main.appendChild(results);

    const getRequest = spec.setupInputs(doc, controls, api);

    view = presentView({
      title: spec.title,
      iconName: spec.iconName,
      body,
      doc,
      width: spec.width,
      onClose: () => { view = null; },
    });

    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      await runOnce(getRequest, results, status);
      runBtn.disabled = false;
    });
  }

  return {
    manifest: {
      id: spec.id,
      name: spec.name,
      contexts: [
        CONTEXTS.SETUP_FLOWS,
        CONTEXTS.SETUP_OTHER,
        CONTEXTS.FLOW_BUILDER,
        CONTEXTS.FLOW_TRIGGER_EXPLORER,
      ],
    },

    async onActivate() {
      const ctx = detectContext({ location: { href: win.location.href } }, doc);
      if (ctx === CONTEXTS.NONE) {
        showToast('Open a Salesforce page to use this sfdt tool.', { doc, kind: 'warning' });
        return;
      }
      await open();
    },
  };
}

// ---------------------------------------------------------------------------
// Small shared input builders
// ---------------------------------------------------------------------------

function textInput(doc: Document, placeholder: string): HTMLInputElement {
  const input = doc.createElement('input');
  input.type = 'text';
  input.placeholder = placeholder;
  input.className = 'sfdt-field';
  input.classList.add('sfdt-search');
  return input;
}

// ---------------------------------------------------------------------------
// The four features
// ---------------------------------------------------------------------------

export function createDriftFeature(options: BridgeToolOptions = {}): Feature {
  return createBridgeToolFeature(
    {
      id: 'drift-check',
      name: 'Drift Check',
      title: 'Drift Check',
    iconName: 'wave',
      width: '720px',
      runLabel: 'Check drift',
      setupInputs(doc, controls) {
        const input = textInput(doc, 'Component, e.g. Account.MyField__c');
        controls.appendChild(input);
        const live = doc.createElement('label');
        live.classList.add('sfdt-row', 'sfdt-tight');
        const cb = doc.createElement('input');
        cb.type = 'checkbox';
        live.append(cb, doc.createTextNode('Run live (slower)'));
        controls.appendChild(live);
        return async () => {
          const component = input.value.trim();
          if (!component) throw new Error('Enter a component to check for drift.');
          // Unchecked → return the latest snapshot; checked → run drift live first.
          return { kind: 'drift', component, refresh: cb.checked };
        };
      },
      render: renderJson,
    },
    options,
  );
}

export function createScanFeature(options: BridgeToolOptions = {}): Feature {
  return createBridgeToolFeature(
    {
      id: 'metadata-scan',
      name: 'Metadata Scan',
      title: 'Metadata Scan',
    iconName: 'layers',
      width: '720px',
      runLabel: 'Scan',
      setupInputs(doc, controls) {
        const select = doc.createElement('select');
        select.className = 'sfdt-field sfdt-auto';
        for (const [value, label] of [
          ['scheduled', 'Scheduled flows only'],
          ['all', 'All flows'],
        ] as const) {
          const opt = doc.createElement('option');
          opt.value = value;
          opt.textContent = label;
          select.appendChild(opt);
        }
        controls.appendChild(select);
        return async () => ({ kind: 'scan', scanType: select.value as 'scheduled' | 'all' });
      },
      render: renderJson,
    },
    options,
  );
}

export function createCompareFeature(options: BridgeToolOptions = {}): Feature {
  return createBridgeToolFeature(
    {
      id: 'org-compare',
      name: 'Org Compare',
      title: 'Org Compare',
    iconName: 'compare',
      width: '720px',
      runLabel: 'Compare',
      setupInputs(doc, controls) {
        const left = textInput(doc, 'Source (e.g. org alias)');
        const right = textInput(doc, 'Target (e.g. org alias)');
        controls.append(left, right);
        return async () => {
          const l = left.value.trim();
          const r = right.value.trim();
          if (!l || !r) throw new Error('Enter both a source and target to compare.');
          return { kind: 'compare', left: l, right: r };
        };
      },
      render: renderJson,
    },
    options,
  );
}

export function _bridgeToolsTestApi() {
  return { bridgeErrorHint };
}
