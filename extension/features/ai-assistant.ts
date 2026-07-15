import { cleanFlowMetadata, estimateTokens, PromptLibrary, summariseFlowMetadata, type ResolvedPrompt } from '@sfdt/flow-core';
import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { loadSettings } from '../lib/settings.js';
import { createBridgeClient, LONG_RUNNING_TIMEOUT_MS } from '../lib/sfdt-bridge.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import type { SfdtRequest, SfdtResponse } from '@sfdt/flow-core/bridge-contract';

const STORAGE_KEY_DISABLED = 'aiPromptLibrary.disabledStandardIds';
const STORAGE_KEY_CUSTOMS = 'aiPromptLibrary.customPrompts';
const STORAGE_KEY_DEFAULT = 'aiPromptLibrary.defaultPromptId';

// Storage keys above are pinned to legacy names so existing users' custom
// prompts survive the upgrade — do not rename without a migration.
function chromeStorageAdapter() {
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      return new Promise((resolve) => {
        chrome.storage.local.get(key, (result) => {
          resolve((result?.[key] as T) ?? null);
        });
      });
    },
    async set<T = unknown>(key: string, value: T): Promise<void> {
      return new Promise((resolve) => {
        chrome.storage.local.set({ [key]: value }, () => resolve());
      });
    },
    async remove(key: string): Promise<void> {
      return new Promise((resolve) => {
        chrome.storage.local.remove(key, () => resolve());
      });
    },
  };
}

type BridgeReq = Omit<SfdtRequest, 'requestId'>;

interface BridgeLike {
  call<R extends BridgeReq>(request: R, options?: { timeoutMs?: number }): Promise<SfdtResponse>;
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

export interface AiAssistantOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
  library?: PromptLibrary;
  bridgeFactory?: () => Promise<BridgeLike>;
}

export function createAiAssistantFeature(options: AiAssistantOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();
  const library =
    options.library ?? new PromptLibrary({ storage: chromeStorageAdapter() });
  const bridgeFactory = options.bridgeFactory ?? defaultBridgeFactory();

  let view: ViewHandle | null = null;

  function closePanel(): void {
    view?.close();
    view = null;
  }

  async function openPanel(): Promise<void> {
    closePanel();

    const body = doc.createElement('div');
    body.className = 'sfdt-ai-panel-body';
    body.style.cssText = 'padding: 16px; overflow-y: auto; flex: 1;';
    const loading = doc.createElement('div');
    loading.textContent = 'Fetching Flow metadata…';
    body.appendChild(loading);

    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel();
    };
    doc.addEventListener('keydown', escHandler, true);

    view = presentView({
      title: '⚡ Flow Metadata & AI Assistant',
      body,
      doc,
      width: '640px',
      onClose: () => {
        doc.removeEventListener('keydown', escHandler, true);
        view = null;
      },
    });

    try {
      const flowId = new URL(win.location.href).searchParams.get('flowId');
      if (!flowId) {
        loading.textContent = 'Could not determine Flow ID from the URL.';
        return;
      }
      const record = (await api.getFlowMetadata(flowId)) as {
        Metadata?: Record<string, unknown>;
        FullName?: string;
      };
      const metadata = record?.Metadata;
      if (!metadata) {
        loading.textContent = 'No metadata returned for this Flow.';
        return;
      }

      await library.load();
      const cleaned = cleanFlowMetadata(metadata) ?? metadata;
      const rawJson = JSON.stringify(metadata, null, 2);
      const cleanJson = JSON.stringify(cleaned, null, 2);
      const summary = summariseFlowMetadata(metadata);
      const rawTokens = estimateTokens(rawJson);
      const cleanTokens = estimateTokens(cleanJson);

      while (body.firstChild) body.removeChild(body.firstChild);
      const heading = doc.createElement('div');
      heading.style.cssText = 'font-weight: 600; margin-bottom: 4px;';
      heading.textContent = summary?.label ?? 'Flow';
      body.appendChild(heading);
      const subline = doc.createElement('div');
      subline.style.cssText = 'color: var(--sfdt-color-text-icon); font-size: 12px; margin-bottom: 12px;';
      subline.textContent = `${summary?.totalElements ?? 0} elements, ${summary?.totalResources ?? 0} resources · raw ~${rawTokens} tokens · cleaned ~${cleanTokens} tokens`;
      body.appendChild(subline);

      const promptRow = doc.createElement('div');
      promptRow.style.cssText = 'display: flex; gap: 8px; align-items: center; margin: 8px 0;';
      const promptLabel = doc.createElement('label');
      promptLabel.textContent = 'Prompt template:';
      promptLabel.style.fontSize = '13px';
      const select = doc.createElement('select');
      select.style.flex = '1';
      const enabled: ResolvedPrompt[] = library.getEnabled();
      const defaultId = library.getDefaultPromptId();
      for (const t of enabled) {
        const opt = doc.createElement('option');
        opt.value = t.id;
        opt.textContent = t.title;
        if (t.id === defaultId) opt.selected = true;
        select.appendChild(opt);
      }
      promptRow.appendChild(promptLabel);
      promptRow.appendChild(select);
      body.appendChild(promptRow);

      const description = doc.createElement('div');
      description.style.cssText = 'color: var(--sfdt-color-text-weak); font-size: 12px; margin-bottom: 12px;';
      const updateDescription = () => {
        const sel = library.getById(select.value);
        description.textContent = sel?.description ?? '';
      };
      updateDescription();
      select.addEventListener('change', updateDescription);
      body.appendChild(description);

      const buttons = doc.createElement('div');
      buttons.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap;';
      const makeBtn = (label: string, handler: () => Promise<void> | void): HTMLButtonElement => {
        const btn = doc.createElement('button');
        btn.textContent = label;
        btn.style.cssText =
          'padding: 6px 10px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); border-radius: 4px; cursor: pointer;';
        btn.addEventListener('click', () => void handler());
        return btn;
      };
      buttons.appendChild(
        makeBtn('📋 Copy Raw', async () => {
          await navigator.clipboard.writeText(rawJson);
          showToast('Raw metadata copied', { doc });
        }),
      );
      buttons.appendChild(
        makeBtn('📋 Copy Clean', async () => {
          await navigator.clipboard.writeText(cleanJson);
          showToast('Cleaned metadata copied', { doc });
        }),
      );
      buttons.appendChild(
        makeBtn('📋 Copy Prompt', async () => {
          const assembled = library.assemble(select.value, cleanJson);
          if (assembled) {
            await navigator.clipboard.writeText(assembled);
            showToast('Prompt copied to clipboard', { doc });
          }
        }),
      );
      // Result area for the bridge AI run — the response renders here, it is
      // not just acknowledged with a toast.
      const resultArea = doc.createElement('div');
      resultArea.className = 'sfdt-ai-result';
      resultArea.style.cssText = 'margin-top: 12px;';

      const renderResultError = (message: string): void => {
        while (resultArea.firstChild) resultArea.removeChild(resultArea.firstChild);
        const panel = doc.createElement('div');
        panel.style.cssText =
          'border: 1px solid var(--sfdt-color-error); background: var(--sfdt-color-error-bg); color: var(--sfdt-color-error); padding: 8px 12px; border-radius: 4px; font-size: 13px; white-space: pre-wrap;';
        panel.textContent = message;
        resultArea.appendChild(panel);
      };

      const renderResult = (responseText: string, provider: string): void => {
        while (resultArea.firstChild) resultArea.removeChild(resultArea.firstChild);
        const header = doc.createElement('div');
        header.style.cssText =
          'display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px;';
        const label = doc.createElement('span');
        label.style.cssText = 'font-size: 12px; color: var(--sfdt-color-text-weak); font-weight: 600;';
        label.textContent = provider ? `AI response (${provider})` : 'AI response';
        const copyBtn = makeBtn('📋 Copy response', async () => {
          await navigator.clipboard.writeText(responseText);
          showToast('AI response copied', { doc });
        });
        header.append(label, copyBtn);
        const pre = doc.createElement('pre');
        pre.style.cssText =
          'margin: 0; padding: 12px; background: var(--sfdt-color-bg); border: 1px solid var(--sfdt-color-border); border-radius: 4px; font-size: 12px; white-space: pre-wrap; word-break: break-word; max-height: 45vh; overflow: auto;';
        pre.textContent = responseText;
        resultArea.append(header, pre);
      };

      const runViaSfdt = makeBtn('🚀 Run via sfdt', async () => {
        const assembled = library.assemble(select.value, cleanJson);
        if (!assembled) return;
        runViaSfdt.disabled = true;
        const originalLabel = runViaSfdt.textContent;
        runViaSfdt.textContent = '⏳ Running…';
        try {
          const bridge = await bridgeFactory();
          const response = await bridge.call(
            { kind: 'ai', prompt: assembled },
            { timeoutMs: LONG_RUNNING_TIMEOUT_MS },
          );
          if (response.ok) {
            const data = (response.data ?? {}) as { response?: string; provider?: string };
            renderResult(data.response ?? '(empty response)', data.provider ?? '');
          } else {
            renderResultError(`Bridge: ${response.error}`);
          }
        } catch (err) {
          renderResultError(err instanceof Error ? err.message : String(err));
        } finally {
          runViaSfdt.disabled = false;
          runViaSfdt.textContent = originalLabel;
        }
      });
      buttons.appendChild(runViaSfdt);
      body.appendChild(buttons);
      body.appendChild(resultArea);
    } catch (err) {
      loading.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return {
    manifest: {
      id: 'ai-assistant',
      name: 'Flow Metadata & AI Assistant',
      contexts: [CONTEXTS.FLOW_BUILDER],
    },

    async init() {
      if (detectContext({ location: { href: win.location.href } }, doc) !== CONTEXTS.FLOW_BUILDER) {
        return;
      }
    },

    onActivate() {
      if (view) closePanel();
      else void openPanel();
    },
  };
}

// Test seam — exposes the pinned storage keys for migration assertions.
export function _aiAssistantTestApi() {
  return { STORAGE_KEY_DISABLED, STORAGE_KEY_CUSTOMS, STORAGE_KEY_DEFAULT };
}
