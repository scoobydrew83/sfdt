import { z } from 'zod';
export const SettingsSchema = z.object({
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
  telemetry: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default({}),
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
const STORAGE_KEY = 'sfut.settings';
let _cache: Settings | null = null;
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
export function _clearSettingsCacheForTests(): void {
  _cache = null;
}
