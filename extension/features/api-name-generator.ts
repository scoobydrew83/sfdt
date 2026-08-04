import {
  ApiNameLibrary,
  DEFAULT_PREFIXES,
  type NamingPattern,
  type PrefixEntry,
} from '@sfdt/flow-core';
import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { loadSettings, patchSettings, registerSettingsShape } from '../lib/settings.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { z } from 'zod';
import { button } from '../lib/ui-controls.js';
import { storageGet, storageSet, storageRemove } from '../lib/storage.js';
import { copyToClipboard } from '../ui/clipboard.js';

const API_NAME_GENERATOR_SETTINGS_SCHEMA = z.object({
  namingPattern: z.enum(['Snake_Case', 'PascalCase', 'camelCase']).default('camelCase'),
});

registerSettingsShape('api-name-generator', API_NAME_GENERATOR_SETTINGS_SCHEMA);

const STORAGE_KEY = 'apiNameGenerator.customPrefixes';

// A thin shim over lib/storage.ts, which is what absorbs the invalidated
// context. The hand-rolled promise wrappers this replaces called chrome.* on
// the raw handle, so an orphaned tab threw synchronously on the first read.
function chromeStorageAdapter() {
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      return (await storageGet<T>(key)) ?? null;
    },
    async set<T = unknown>(key: string, value: T): Promise<void> {
      await storageSet(key, value);
    },
    async remove(key: string): Promise<void> {
      await storageRemove(key);
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

    // '.sfdt-stack' supplies the column and the gap, so the controls below stop
    // carrying their own margin-bottom.
    const body = doc.createElement('div');
    body.className = 'sfdt-view-main sfdt-stack';

    const labelInput = doc.createElement('input');
    labelInput.type = 'text';
    labelInput.placeholder = 'Element or resource label';
    // Was a bare UA-styled input: no border, no background, no colour. On an
    // injected modal — which declares no color-scheme — Chrome renders that as a
    // white box with black text, i.e. a glaring rectangle on the dark palette.
    labelInput.className = 'sfdt-field';
    labelInput.setAttribute('aria-label', 'Element or resource label');
    body.appendChild(labelInput);

    const typeSelect = doc.createElement('select');
    typeSelect.className = 'sfdt-field';
    typeSelect.setAttribute('aria-label', 'Element type');
    for (const entry of prefixes) {
      const opt = doc.createElement('option');
      opt.value = entry.type;
      opt.textContent = entry.type;
      typeSelect.appendChild(opt);
    }
    body.appendChild(typeSelect);

    const patternSelect = doc.createElement('select');
    patternSelect.className = 'sfdt-field';
    patternSelect.setAttribute('aria-label', 'Naming pattern');
    for (const p of ['Snake_Case', 'PascalCase', 'camelCase'] as const) {
      const opt = doc.createElement('option');
      opt.value = p;
      opt.textContent = p;
      if (p === pattern) opt.selected = true;
      patternSelect.appendChild(opt);
    }
    body.appendChild(patternSelect);

    const preview = doc.createElement('div');
    preview.className = 'sfdt-console';
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
    footer.classList.add('sfdt-row');
    const cancel = doc.createElement('button');
    cancel.textContent = 'Close';
    cancel.classList.add('sfdt-prose', 'sfdt-flush-x');
    cancel.addEventListener('click', close);
    const copy = button({ label: 'Copy', iconName: 'clipboard', variant: 'primary', doc });
    copy.addEventListener('click', async () => {
      if (!preview.textContent) return;
      await copyToClipboard(preview.textContent, { doc, label: `API Name copied: ${preview.textContent}` });
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
