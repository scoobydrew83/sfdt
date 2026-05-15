// Typed extension settings backed by chrome.storage.local.
//
// The v2.0.2 extension at /Users/dkennedy/dev/2.0.2_0 copy/utils/
// settings-manager.js split state across chrome.storage.sync (per-feature
// flags) and chrome.storage.local (AI prompt library) with a one-time
// migration shim. This module consolidates everything to chrome.storage.local
// — local has a 10 MB quota vs. sync's 100 KB, doesn't sync prompts to the
// user's other browsers (a feature, not a bug — prompts are local creative
// work, not preferences), and lets the migration shim live in one place.
//
// Schema is validated with zod so a corrupt write or a future schema bump
// surfaces as a typed error rather than silently breaking a feature.

import { z } from 'zod';

export const SettingsSchema = z.object({
  // Feature enable flags. Open-ended record so any feature id can have a
  // toggle. Undefined entries mean "enabled by default" — features declare
  // their own enabledByDefault on the manifest. Three legacy camelCase keys
  // are tolerated via LEGACY_FEATURE_ID_MAP.
  features: z.record(z.string(), z.boolean()).default({}),

  setupTabs: z
    .object({
      automationHomeEnabled: z.boolean().default(false),
      groupingEnabled: z.boolean().default(false),
    })
    .default({}),

  canvasSearch: z
    .object({
      shortcut: z.string().default('Ctrl+Shift+F'),
      highlightColour: z.string().default('#FFD700'),
    })
    .default({}),

  apiNameGenerator: z
    .object({
      namingPattern: z.enum(['Snake_Case', 'PascalCase', 'camelCase']).default('Snake_Case'),
    })
    .default({}),

  scheduledFlowExplorer: z
    .object({
      defaultView: z.enum(['list', 'calendar']).default('list'),
    })
    .default({}),

  // Bridge configuration. The bearer token is pasted in by the user from the
  // sfdt ui "Connect extension" flow.
  bridge: z
    .object({
      token: z.string().default(''),
      preferredTransport: z.enum(['auto', 'localhost', 'native']).default('auto'),
      localhostPort: z.number().int().positive().default(7654),
    })
    .default({}),
});

export type Settings = z.infer<typeof SettingsSchema>;

/**
 * Three legacy keys from before the manifest migration. The settings UI
 * previously stored these in camelCase; the rest of the system now keys on
 * kebab-case feature ids. We keep the legacy keys readable by mapping them
 * to their canonical form on access. New writes go to kebab-case only.
 */
const LEGACY_FEATURE_ID_MAP: Record<string, string> = {
  setupTabs: 'setup-tabs',
  missingDescriptions: 'missing-descriptions',
  scheduledFlowExplorer: 'scheduled-flow-explorer',
};

/**
 * Return true when the user has not explicitly disabled featureId. Honours
 * the legacy camelCase keys stored before the migration.
 */
export function isFeatureEnabled(settings: Settings, featureId: string): boolean {
  if (Object.prototype.hasOwnProperty.call(settings.features, featureId)) {
    return settings.features[featureId] !== false;
  }
  for (const [legacy, canonical] of Object.entries(LEGACY_FEATURE_ID_MAP)) {
    if (canonical === featureId && Object.prototype.hasOwnProperty.call(settings.features, legacy)) {
      return settings.features[legacy] !== false;
    }
  }
  return true;
}

const STORAGE_KEY = 'sfut.settings';

// In-memory cache so callers don't pay the chrome.storage round-trip on every
// read. Invalidated by the storage onChanged listener at the bottom.
let _cache: Settings | null = null;

function defaultSettings(): Settings {
  return SettingsSchema.parse({});
}

async function readRaw(): Promise<unknown> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => resolve(result?.[STORAGE_KEY]));
  });
}

async function writeRaw(value: Settings): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: value }, () => resolve());
  });
}

/**
 * Load settings, applying defaults for missing fields. Safe to call from any
 * extension surface (content script, background, popup, options page).
 */
export async function loadSettings(): Promise<Settings> {
  if (_cache) return _cache;
  const raw = await readRaw();
  const parsed = SettingsSchema.safeParse(raw ?? {});
  _cache = parsed.success ? parsed.data : defaultSettings();
  return _cache;
}

/**
 * Replace the entire settings blob. Validates against the schema first;
 * throws if the proposed value is invalid.
 */
export async function saveSettings(next: Settings): Promise<void> {
  const validated = SettingsSchema.parse(next);
  await writeRaw(validated);
  _cache = validated;
}

/**
 * Patch a subset of settings. Reads current state, merges deeply at the top
 * level (one level deep — enough for the schema's shape), re-validates,
 * persists.
 */
export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = {
    ...current,
    ...patch,
  } as Settings;
  // Deep-merge each top-level section the patch touches.
  for (const key of Object.keys(patch) as Array<keyof Settings>) {
    const a = current[key];
    const b = patch[key];
    if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
      (next as Record<string, unknown>)[key] = { ...a, ...b };
    }
  }
  await saveSettings(next);
  return next;
}

/**
 * Subscribe to settings changes. The callback fires every time another
 * extension surface writes a new settings blob.
 *
 * @returns a function that unsubscribes the listener.
 */
export function onSettingsChange(callback: (settings: Settings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    namespace: string,
  ): void => {
    if (namespace !== 'local') return;
    if (!changes[STORAGE_KEY]) return;
    const next = SettingsSchema.safeParse(changes[STORAGE_KEY].newValue ?? {});
    if (next.success) {
      _cache = next.data;
      callback(next.data);
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/**
 * Test helper: clear the in-memory cache so the next read pulls from storage.
 * Production code never needs this.
 */
export function _clearSettingsCacheForTests(): void {
  _cache = null;
}
