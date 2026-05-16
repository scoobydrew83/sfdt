import { cleanFlowMetadata, estimateTokens, PromptLibrary, summariseFlowMetadata, type ResolvedPrompt } from '@sfdt/flow-core';
import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { loadSettings } from '../lib/settings.js';
import { createBridgeClient } from '../lib/sfdt-bridge.js';
import { showToast } from '../ui/toast.js';
const STORAGE_KEY_DISABLED = 'aiPromptLibrary.disabledStandardIds';
const STORAGE_KEY_CUSTOMS = 'aiPromptLibrary.customPrompts';
const STORAGE_KEY_DEFAULT = 'aiPromptLibrary.defaultPromptId';
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
export interface AiAssistantOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
  library?: PromptLibrary;
}
export function createAiAssistantFeature(options: AiAssistantOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();
  const library =
    options.library ?? new PromptLibrary({ storage: chromeStorageAdapter() });
  let overlay: HTMLDivElement | null = null;
  function closePanel(): void {
    overlay?.remove();
    overlay = null;
  }
  async function openPanel(): Promise<void> {
    closePanel();
    overlay = doc.createElement('div');
    overlay.className = 'sfut-ai-panel-overlay';
    overlay.style.cssText =
      'position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 100020; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif;';
    const panel = doc.createElement('div');
    panel.className = 'sfut-ai-panel';
    panel.style.cssText =
      'background: #fff; border-radius: 4px; width: 640px; max-width: 90vw; max-height: 90vh; display: flex; flex-direction: column;';
    const header = doc.createElement('div');
    header.className = 'sfut-ai-panel-header';
    header.style.cssText =
      'padding: 12px 16px; border-bottom: 1px solid #d8dde6; display: flex; justify-content: space-between; align-items: center; font-weight: 600;';
    const title = doc.createElement('span');
    title.textContent = '⚡ Flow Metadata & AI Assistant';
    header.appendChild(title);
    const closeBtn = doc.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'background: none; border: 0; font-size: 22px; cursor: pointer; color: #80868d;';
    closeBtn.addEventListener('click', closePanel);
    header.appendChild(closeBtn);
    const body = doc.createElement('div');
    body.className = 'sfut-ai-panel-body';
    body.style.cssText = 'padding: 16px; overflow-y: auto; flex: 1;';
    const loading = doc.createElement('div');
    loading.textContent = 'Fetching Flow metadata…';
    body.appendChild(loading);
    panel.appendChild(header);
    panel.appendChild(body);
    overlay.appendChild(panel);
    doc.body.appendChild(overlay);
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel();
    };
    doc.addEventListener('keydown', escHandler, true);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closePanel();
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
      subline.style.cssText = 'color: #80868d; font-size: 12px; margin-bottom: 12px;';
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
      description.style.cssText = 'color: #54698d; font-size: 12px; margin-bottom: 12px;';
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
          'padding: 6px 10px; border: 1px solid #d8dde6; background: #fff; border-radius: 4px; cursor: pointer;';
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
      const runViaSfdt = makeBtn('🚀 Run via sfdt', async () => {
        const assembled = library.assemble(select.value, cleanJson);
        if (!assembled) return;
        const settings = await loadSettings();
        const bridge = createBridgeClient({
          token: settings.bridge.token,
          preferredTransport: settings.bridge.preferredTransport,
          localhostPort: settings.bridge.localhostPort,
          connectNativeImpl: chrome.runtime?.connectNative?.bind(chrome.runtime),
        });
        showToast('Sending to sfdt…', { doc });
        const response = await bridge.call({ kind: 'ai', prompt: assembled });
        if (response.ok) {
          showToast('AI response received', { kind: 'success', doc });
        } else {
          showToast(`Bridge: ${response.error}`, { kind: 'error', doc });
        }
      });
      buttons.appendChild(runViaSfdt);
      body.appendChild(buttons);
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
      if (overlay) closePanel();
      else void openPanel();
    },
  };
}
export function _aiAssistantTestApi() {
  return { STORAGE_KEY_DISABLED, STORAGE_KEY_CUSTOMS, STORAGE_KEY_DEFAULT };
}
