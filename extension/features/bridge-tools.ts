// Phase 5 — thin Workspace tools over the four bridge kinds the contract defines
// but nothing surfaced: drift / scan / compare / quality. Each builds a minimal
// input UI, calls `bridge.call({ kind, ... })`, and renders the result (modelled
// on org-health.ts, including the BRIDGE_OFFLINE / BRIDGE_UNAUTHORIZED hint).
//
// These are dev-only: they need `sfdt ui` running to answer the bridge, exactly
// like flow-deploy. On the current CLI, `drift`/`scan`/`compare` answer
// NOT_IMPLEMENTED server-side (stubs), so those surface the bridge's own message
// + hint; `quality` is fully wired and renders a score card. When the server
// implements the other three, the generic JSON view shows their payload as-is.

import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import {
  getSalesforceApi,
  type SalesforceApiClient,
} from '../lib/salesforce-api.js';
import { createBridgeClient, LONG_RUNNING_TIMEOUT_MS } from '../lib/sfdt-bridge.js';
import { loadSettings } from '../lib/settings.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import type { SfdtRequest, SfdtResponse, QualityResponseData } from '@sfdt/flow-core/bridge-contract';

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
    'margin: 0; padding: 12px; background: #f3f3f3; border: 1px solid #d8dde6; border-radius: 4px; font-size: 12px; white-space: pre-wrap; word-break: break-word;';
  pre.textContent = JSON.stringify(data ?? null, null, 2);
  results.appendChild(pre);
}

function renderQuality(doc: Document, results: HTMLElement, data: unknown): void {
  const q = (data ?? {}) as Partial<QualityResponseData>;
  const banner = doc.createElement('div');
  const score = typeof q.overallScore === 'number' ? q.overallScore : null;
  const band = score === null ? '#b0adab' : score >= 80 ? '#04844b' : score >= 60 ? '#fe9339' : '#c23934';
  banner.style.cssText = `margin-bottom: 14px; padding: 12px 14px; border-radius: 6px; border: 1px solid #d8dde6; border-left: 4px solid ${band}; display: flex; align-items: baseline; gap: 10px;`;
  const big = doc.createElement('span');
  big.style.cssText = 'font-size: 22px; font-weight: 700;';
  big.textContent = score === null ? '—' : String(score);
  const cap = doc.createElement('span');
  cap.style.cssText = 'font-size: 12px; color: #54698d;';
  cap.textContent = `${q.rating ?? 'quality score'} · ${q.issueFamilyCount ?? 0} issue famil${q.issueFamilyCount === 1 ? 'y' : 'ies'}`;
  banner.append(big, cap);
  results.appendChild(banner);

  const counts = q.severityCounts ?? {};
  const entries = Object.entries(counts);
  if (entries.length > 0) {
    const list = doc.createElement('ul');
    list.style.cssText = 'margin: 0; padding-left: 18px; color: #3e3e3c; font-size: 12px;';
    for (const [sev, n] of entries) {
      const li = doc.createElement('li');
      li.textContent = `${sev}: ${n}`;
      list.appendChild(li);
    }
    results.appendChild(list);
  }
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
    const panel = doc.createElement('div');
    panel.style.cssText =
      'border: 1px solid #c23934; background: #fef2f1; color: #c23934; padding: 8px 12px; border-radius: 4px; font-size: 13px;';
    panel.textContent = message;
    results.appendChild(panel);
    status.textContent = 'Failed';
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
    } catch (err) {
      renderError(results, status, err instanceof Error ? err.message : String(err));
    }
  }

  async function open(): Promise<void> {
    close();

    const body = doc.createElement('div');
    body.style.cssText = 'padding: 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column;';

    const toolbar = doc.createElement('div');
    toolbar.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap;';
    const controls = doc.createElement('div');
    controls.style.cssText = 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex: 1;';
    const runBtn = doc.createElement('button');
    runBtn.textContent = spec.runLabel;
    runBtn.style.cssText =
      'padding: 5px 14px; border: 1px solid #0070d2; background: #0070d2; color: #fff; border-radius: 4px; cursor: pointer; font-size: 13px;';
    const status = doc.createElement('span');
    status.style.cssText = 'color: #54698d; font-size: 12px;';
    toolbar.append(controls, runBtn, status);
    body.appendChild(toolbar);

    const results = doc.createElement('div');
    body.appendChild(results);

    const getRequest = spec.setupInputs(doc, controls, api);

    view = presentView({
      title: spec.title,
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
  input.style.cssText =
    'flex: 1; min-width: 160px; padding: 5px 8px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 13px;';
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
      title: '🌊 Drift Check',
      width: '720px',
      runLabel: 'Check drift',
      setupInputs(doc, controls) {
        const input = textInput(doc, 'Component, e.g. Account.MyField__c');
        controls.appendChild(input);
        return async () => {
          const component = input.value.trim();
          if (!component) throw new Error('Enter a component to check for drift.');
          return { kind: 'drift', component };
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
      title: '🔬 Metadata Scan',
      width: '720px',
      runLabel: 'Scan',
      setupInputs(doc, controls) {
        const select = doc.createElement('select');
        select.style.cssText =
          'padding: 5px 8px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 13px;';
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
      title: '🔀 Org Compare',
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

export function createQualityFeature(options: BridgeToolOptions = {}): Feature {
  return createBridgeToolFeature(
    {
      id: 'flow-quality',
      name: 'Flow Quality Scan',
      title: '✅ Flow Quality Scan',
      width: '720px',
      runLabel: 'Scan',
      setupInputs(doc, controls, api) {
        const input = textInput(doc, 'Flow API name, e.g. My_Flow');
        controls.appendChild(input);
        return async () => {
          const name = input.value.trim();
          if (!name) throw new Error('Enter a Flow API name to scan.');
          // The bridge `quality` kind wants JSON-stringified Flow.Metadata —
          // resolve it via Tooling so the user only types a name.
          const record = (await api.getFlowMetadata(name)) as { Metadata?: unknown };
          const metadata = record.Metadata ?? record;
          return { kind: 'quality', flowXml: JSON.stringify(metadata) };
        };
      },
      render: renderQuality,
    },
    options,
  );
}

export function _bridgeToolsTestApi() {
  return { bridgeErrorHint };
}
