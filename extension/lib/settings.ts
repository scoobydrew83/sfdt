// Everything lives in chrome.storage.local: 10 MB quota (vs. sync's 100 KB),
// and prompts shouldn't sync between browsers — they're local creative work,
// not preferences. zod validation surfaces corrupt writes as typed errors.

import { z } from 'zod';

export const SettingsSchema = z.object({
  // Undefined entries = "enabled by default" (each feature's manifest carries
  // its own enabledByDefault). Legacy camelCase keys are honoured via
  // LEGACY_FEATURE_ID_MAP.
  features: z.record(z.string(), z.boolean()).default({}),

  // The four blocks below predate the registry-driven options page and
  // stay only for back-compat with already-stored data. New per-feature
  // settings go through registerSettingsShape() into featureSettings.<id>;
  // do NOT add new top-level keys here.

  // @deprecated — superseded by registerSettingsShape('setup-tabs', …).
  setupTabs: z
    .object({
      automationHomeEnabled: z.boolean().default(false),
      groupingEnabled: z.boolean().default(false),
    })
    .default({}),

  // @deprecated — superseded by registerSettingsShape('canvas-search', …).
  canvasSearch: z
    .object({
      shortcut: z.string().default('Ctrl+Shift+F'),
      highlightColour: z.string().default('#FFD700'),
    })
    .default({}),

  // @deprecated — superseded by registerSettingsShape('api-name-generator', …).
  apiNameGenerator: z
    .object({
      namingPattern: z.enum(['Snake_Case', 'PascalCase', 'camelCase']).default('Snake_Case'),
    })
    .default({}),

  // @deprecated — superseded by registerSettingsShape('scheduled-flow-explorer', …).
  scheduledFlowExplorer: z
    .object({
      defaultView: z.enum(['list', 'calendar']).default('list'),
    })
    .default({}),

  telemetry: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default({}),

  // Bridge config. `token` is the bearer credential the extension presents
  // to the sfdt CLI's localhost server (/api/bridge/*) and to the native
  // messaging host. Threat model: chrome.storage.local is origin-isolated
  // and not exposed to web pages. The token is, however, readable by any
  // script the extension itself runs — so a compromise of any extension
  // bundle (XSS via an upstream dep, malicious content script, etc.)
  // could exfiltrate the token. Rotate via `sfdt extension token rotate`
  // if you suspect leakage. This is the standard chrome.storage.local
  // pattern for extension credentials; we accept it because the bridge
  // server only binds to localhost and the user can rotate at any time.
  bridge: z
    .object({
      token: z.string().default(''),
      preferredTransport: z.enum(['auto', 'localhost', 'native']).default('auto'),
      localhostPort: z.number().int().positive().default(7654),
    })
    .default({}),
});

export type Settings = z.infer<typeof SettingsSchema> & {
  featureSettings?: Record<string, Record<string, unknown>>;
};

// Legacy keys are honoured on read; new writes always go to kebab-case ids.
const LEGACY_FEATURE_ID_MAP: Record<string, string> = {
  setupTabs: 'setup-tabs',
  missingDescriptions: 'missing-descriptions',
  scheduledFlowExplorer: 'scheduled-flow-explorer',
};

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

const STORAGE_KEY = 'sfdt.settings';

// Invalidated by the storage onChanged listener at the bottom.
let _cache: Settings | null = null;

// Features register at module top — by the time the first loadSettings()
// runs, the composed schema already knows every feature.
const featureShapes = new Map<string, z.ZodTypeAny>();
let _composedSchema: z.ZodTypeAny | null = null;

export function registerSettingsShape(featureId: string, schema: z.ZodTypeAny): void {
  featureShapes.set(featureId, schema);
  _cache = null;
  _composedSchema = null;
}

function getComposedSchema(): z.ZodTypeAny {
  if (_composedSchema) return _composedSchema;
  const shapeFields: Record<string, z.ZodTypeAny> = {};
  for (const [id, schema] of featureShapes.entries()) {
    // .optional() unconditionally — non-ZodObject schemas (ZodEffects from
    // .refine(), ZodIntersection) need the same undefined-when-missing
    // semantics that the legacy-fallback pattern in feature factories relies on.
    shapeFields[id] = schema.optional();
  }
  _composedSchema = SettingsSchema.extend({
    featureSettings: z.object(shapeFields).default({}),
  });
  return _composedSchema;
}

export function _resetSettingsShapesForTests(): void {
  featureShapes.clear();
  _composedSchema = null;
  _cache = null;
}

function defaultSettings(): Settings {
  return getComposedSchema().parse({}) as Settings;
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

export async function loadSettings(): Promise<Settings> {
  if (_cache) return _cache;
  const raw = await readRaw();
  const schema = getComposedSchema();
  const parsed = schema.safeParse(raw ?? {});
  _cache = parsed.success ? (parsed.data as Settings) : defaultSettings();
  return _cache;
}

export async function saveSettings(next: Settings): Promise<void> {
  const validated = getComposedSchema().parse(next) as Settings;
  await writeRaw(validated);
  _cache = validated;
}

// Merges one level deep — enough for the schema's shape.
export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = {
    ...current,
    ...patch,
  } as Settings;
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

// Returns an unsubscribe function.
export function onSettingsChange(callback: (settings: Settings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    namespace: string,
  ): void => {
    if (namespace !== 'local') return;
    if (!changes[STORAGE_KEY]) return;
    // Use the composed schema (same as loadSettings/saveSettings) so dynamically
    // registered featureSettings.<id> entries survive a storage round-trip. The
    // base SettingsSchema would strip them, silently clearing per-feature
    // preferences on every other tab's onChanged fire.
    const next = getComposedSchema().safeParse(changes[STORAGE_KEY].newValue ?? {});
    if (next.success) {
      _cache = next.data as Settings;
      callback(next.data as Settings);
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export function _clearSettingsCacheForTests(): void {
  _cache = null;
}
