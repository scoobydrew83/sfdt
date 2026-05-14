import { describe, it, expect, beforeEach } from 'vitest';
import {
  _clearSettingsCacheForTests,
  loadSettings,
  onSettingsChange,
  patchSettings,
  saveSettings,
  SettingsSchema,
} from '../lib/settings.js';

describe('extension/lib/settings', () => {
  beforeEach(() => {
    _clearSettingsCacheForTests();
  });

  it('returns defaults on first load when nothing is stored', async () => {
    const s = await loadSettings();
    expect(s.features.scheduledFlowExplorer).toBe(true);
    expect(s.features.setupTabs).toBe(false);
    expect(s.canvasSearch.shortcut).toBe('Ctrl+Shift+F');
    expect(s.apiNameGenerator.namingPattern).toBe('Snake_Case');
    expect(s.bridge.preferredTransport).toBe('auto');
    expect(s.bridge.localhostPort).toBe(7654);
  });

  it('SettingsSchema fills in defaults for partial input', () => {
    const parsed = SettingsSchema.parse({ features: { setupTabs: true } });
    expect(parsed.features.setupTabs).toBe(true);
    expect(parsed.features.missingDescriptions).toBe(false);
    expect(parsed.bridge.localhostPort).toBe(7654);
  });

  it('saveSettings persists and re-loads', async () => {
    const next = SettingsSchema.parse({ features: { missingDescriptions: true } });
    await saveSettings(next);
    _clearSettingsCacheForTests();
    const reloaded = await loadSettings();
    expect(reloaded.features.missingDescriptions).toBe(true);
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
      received = s.features.setupTabs;
    });
    await saveSettings(SettingsSchema.parse({ features: { setupTabs: true } }));
    // Listeners fire via queueMicrotask in the test shim — wait a tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toBe(true);
    unsubscribe();
  });

  it('rejects writes that violate the schema', async () => {
    // saveSettings is async, so the schema error surfaces as a rejected promise.
    await expect(
      saveSettings({ bridge: { localhostPort: -1 } } as never),
    ).rejects.toThrow();
  });
});
