import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  _clearSettingsCacheForTests,
  _resetSettingsShapesForTests,
  isFeatureEnabled,
  loadSettings,
  onSettingsChange,
  patchSettings,
  registerSettingsShape,
  saveSettings,
  SettingsSchema,
} from '../lib/settings.js';
describe('extension/lib/settings', () => {
  beforeEach(() => {
    _clearSettingsCacheForTests();
  });
  it('returns defaults on first load when nothing is stored', async () => {
    const s = await loadSettings();
    expect(isFeatureEnabled(s, 'scheduled-flow-explorer')).toBe(true);
    expect(isFeatureEnabled(s, 'setup-tabs')).toBe(true);
    expect(s.canvasSearch.shortcut).toBe('Ctrl+Shift+F');
    expect(s.apiNameGenerator.namingPattern).toBe('Snake_Case');
    expect(s.bridge.preferredTransport).toBe('auto');
    expect(s.bridge.localhostPort).toBe(7654);
  });
  it('SettingsSchema fills in defaults for partial input', () => {
    const parsed = SettingsSchema.parse({ features: { setupTabs: true } });
    expect(isFeatureEnabled(parsed, 'setup-tabs')).toBe(true);
    expect(isFeatureEnabled(parsed, 'missing-descriptions')).toBe(true);
    expect(parsed.bridge.localhostPort).toBe(7654);
  });
  it('saveSettings persists and re-loads', async () => {
    const next = SettingsSchema.parse({ features: { missingDescriptions: true } });
    await saveSettings(next);
    _clearSettingsCacheForTests();
    const reloaded = await loadSettings();
    expect(isFeatureEnabled(reloaded, 'missing-descriptions')).toBe(true);
  });
  it('patchSettings deep-merges section objects', async () => {
    await loadSettings();
    const merged = await patchSettings({ bridge: { token: 'abc' } } as never);
    expect(merged.bridge.token).toBe('abc');
    expect(merged.bridge.localhostPort).toBe(7654);
  });
  it('onSettingsChange fires when another surface writes', async () => {
    let received: unknown = null;
    const unsubscribe = onSettingsChange((s) => {
      received = isFeatureEnabled(s, 'setup-tabs');
    });
    await saveSettings(SettingsSchema.parse({ features: { setupTabs: true } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toBe(true);
    unsubscribe();
  });
  it('rejects writes that violate the schema', async () => {
    await expect(
      saveSettings({ bridge: { localhostPort: -1 } } as never),
    ).rejects.toThrow();
  });
});
describe('settings.features legacy id adapter', () => {
  beforeEach(() => {
    _clearSettingsCacheForTests();
    chrome.storage.local.clear();
  });
  it('reads kebab-case ids when written kebab-case', async () => {
    chrome.storage.local.set({
      'sfut.settings': {
        features: { 'canvas-search': true, 'flow-deploy': false },
      },
    } as any);
    const s = await loadSettings();
    expect(isFeatureEnabled(s, 'canvas-search')).toBe(true);
    expect(isFeatureEnabled(s, 'flow-deploy')).toBe(false);
  });
  it('treats legacy camelCase keys as the canonical kebab-case ids', async () => {
    chrome.storage.local.set({
      'sfut.settings': {
        features: { setupTabs: true, missingDescriptions: false },
      },
    } as any);
    const s = await loadSettings();
    expect(isFeatureEnabled(s, 'setup-tabs')).toBe(true);
    expect(isFeatureEnabled(s, 'missing-descriptions')).toBe(false);
  });
  it('defaults unknown ids to enabled (enabledByDefault semantics)', async () => {
    chrome.storage.local.set({ 'sfut.settings': { features: {} } } as any);
    const s = await loadSettings();
    expect(isFeatureEnabled(s, 'never-toggled')).toBe(true);
  });
});
describe('registerSettingsShape', () => {
  beforeEach(() => {
    _clearSettingsCacheForTests();
    _resetSettingsShapesForTests();
    chrome.storage.local.clear();
  });
  it('exposes contributed feature settings under featureSettings.<id>', async () => {
    registerSettingsShape('canvas-search', z.object({
      shortcut: z.string().default('Ctrl+Shift+F'),
    }));
    const sEmpty = await loadSettings();
    expect(sEmpty.featureSettings?.['canvas-search']).toBeUndefined();
    chrome.storage.local.set({
      'sfut.settings': { featureSettings: { 'canvas-search': { shortcut: 'Ctrl+Shift+F' } } },
    } as any);
    _clearSettingsCacheForTests();
    const s = await loadSettings();
    expect(s.featureSettings?.['canvas-search']).toEqual({
      shortcut: 'Ctrl+Shift+F',
    });
  });
  it('honours stored values for contributed shapes', async () => {
    registerSettingsShape('api-name-generator', z.object({
      pattern: z.enum(['a', 'b']).default('a'),
    }));
    chrome.storage.local.set({
      'sfut.settings': {
        featureSettings: { 'api-name-generator': { pattern: 'b' } },
      },
    } as any);
    const s = await loadSettings();
    expect(s.featureSettings?.['api-name-generator']).toEqual({ pattern: 'b' });
  });
  it('contributing a new shape after loadSettings() invalidates the cache', async () => {
    const s1 = await loadSettings();
    expect(s1.featureSettings?.alpha).toBeUndefined();
    registerSettingsShape('alpha', z.object({ x: z.boolean().default(true) }));
    const s2 = await loadSettings();
    expect(s2.featureSettings?.alpha).toBeUndefined();
    chrome.storage.local.set({
      'sfut.settings': { featureSettings: { alpha: { x: false } } },
    } as any);
    _clearSettingsCacheForTests();
    const s3 = await loadSettings();
    expect(s3.featureSettings?.alpha).toEqual({ x: false });
  });
});
