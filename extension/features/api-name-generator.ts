import {
  ApiNameLibrary,
  DEFAULT_PREFIXES,
  type NamingPattern,
  type PrefixEntry,
} from '@sfdt/flow-core';
import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { loadSettings, patchSettings, registerSettingsShape } from '../lib/settings.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { z } from 'zod';

const API_NAME_GENERATOR_SETTINGS_SCHEMA = z.object({
  namingPattern: z.enum(['Snake_Case', 'PascalCase', 'camelCase']).default('Snake_Case'),
});

registerSettingsShape('api-name-generator', API_NAME_GENERATOR_SETTINGS_SCHEMA);

const STORAGE_KEY = 'apiNameGenerator.customPrefixes';

function chromeStorageAdapter() {
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      return new Promise((resolve) => {
        chrome.storage.local.get(key, (result) => resolve((result?.[key] as T) ?? null));
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

export interface ApiNameGeneratorOptions {
  doc?: Document;
  win?: Window;
  library?: ApiNameLibrary;
}

export function createApiNameGeneratorFeature(
  options: ApiNameGeneratorOptions = {},
): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const library =
    options.library ?? new ApiNameLibrary({ storage: chromeStorageAdapter() });
  let view: ViewHandle | null = null;

  function close(): void {
    view?.close();
    view = null;
  }

  async function openModal(): Promise<void> {
    close();
    await library.load();
    const settings = await loadSettings();
    type ApiNameConfig = z.infer<typeof API_NAME_GENERATOR_SETTINGS_SCHEMA>;
    const apiNameConfig = (settings.featureSettings?.['api-name-generator'] ?? settings.apiNameGenerator) as ApiNameConfig;
    const pattern: NamingPattern = apiNameConfig.namingPattern;
    const prefixes: readonly PrefixEntry[] = library.isCustom() ? library.getAll() : DEFAULT_PREFIXES;

    const body = doc.createElement('div');
    body.style.cssText = 'padding: 16px; display: flex; flex-direction: column;';

    const labelInput = doc.createElement('input');
    labelInput.type = 'text';
    labelInput.placeholder = 'Element or resource label';
    labelInput.style.cssText = 'width: 100%; padding: 6px; margin-bottom: 8px;';
    body.appendChild(labelInput);

    const typeSelect = doc.createElement('select');
    typeSelect.style.cssText = 'width: 100%; padding: 6px; margin-bottom: 8px;';
    for (const entry of prefixes) {
      const opt = doc.createElement('option');
      opt.value = entry.type;
      opt.textContent = entry.type;
      typeSelect.appendChild(opt);
    }
    body.appendChild(typeSelect);

    const patternSelect = doc.createElement('select');
    patternSelect.style.cssText = 'width: 100%; padding: 6px; margin-bottom: 8px;';
    for (const p of ['Snake_Case', 'PascalCase', 'camelCase'] as const) {
      const opt = doc.createElement('option');
      opt.value = p;
      opt.textContent = p;
      if (p === pattern) opt.selected = true;
      patternSelect.appendChild(opt);
    }
    body.appendChild(patternSelect);

    const preview = doc.createElement('div');
    preview.style.cssText =
      'font-family: monospace; padding: 8px; background: var(--sfdt-color-surface-alt); border: 1px solid var(--sfdt-color-border); border-radius: 4px; margin-bottom: 12px; min-height: 20px;';
    body.appendChild(preview);

    const update = () => {
      const expanded = library.expand(
        labelInput.value,
        typeSelect.value,
        patternSelect.value as NamingPattern,
      );
      preview.textContent = expanded ?? '';
    };
    labelInput.addEventListener('input', update);
    typeSelect.addEventListener('change', update);
    patternSelect.addEventListener('change', async () => {
      await patchSettings({
        apiNameGenerator: { namingPattern: patternSelect.value as NamingPattern },
      } as never);
      update();
    });

    const footer = doc.createElement('div');
    footer.style.cssText = 'display: flex; justify-content: flex-end; gap: 8px;';
    const cancel = doc.createElement('button');
    cancel.textContent = 'Close';
    cancel.style.cssText = 'padding: 6px 12px;';
    cancel.addEventListener('click', close);
    const copy = doc.createElement('button');
    copy.textContent = 'Copy';
    copy.style.cssText =
      'padding: 6px 12px; background: var(--sfdt-color-brand); color: var(--sfdt-color-surface); border: 0; border-radius: 4px; cursor: pointer;';
    copy.addEventListener('click', async () => {
      if (!preview.textContent) return;
      await navigator.clipboard.writeText(preview.textContent);
      showToast(`API Name copied: ${preview.textContent}`, { doc, kind: 'success' });
    });
    footer.appendChild(cancel);
    footer.appendChild(copy);

    view = presentView({
      title: 'API Name Generator',
      body,
      footer,
      doc,
      width: '440px',
      onClose: () => { view = null; },
    });
    labelInput.focus();
  }

  return {
    manifest: {
      id: 'api-name-generator',
      name: 'API Name Generator',
      contexts: [CONTEXTS.FLOW_BUILDER],
      settingsSchema: API_NAME_GENERATOR_SETTINGS_SCHEMA,
    },

    async init() {
      if (detectContext({ location: { href: win.location.href } }, doc) !== CONTEXTS.FLOW_BUILDER) {
        return;
      }
    },

    async onActivate() {
      await openModal();
    },
  };
}

export function _apiNameGeneratorTestApi() {
  return { STORAGE_KEY };
}
