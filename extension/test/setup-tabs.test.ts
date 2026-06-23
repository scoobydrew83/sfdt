// Setup Tabs feature tests.
//
// We exercise the feature against a happy-dom document seeded with a Setup
// tab bar (`ul.tabBarItems`). The feature should:
//
//   - Inject three tabs when `features.setupTabs` is enabled.
//   - Add the Automation Home tab when `setupTabs.automationHomeEnabled` is on.
//   - Collapse into a single dropdown when `setupTabs.groupingEnabled` is on.
//   - Remove all injected tabs when the toggle flips off, without reload.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSetupTabsFeature } from '../features/setup-tabs.js';
import {
  _clearSettingsCacheForTests,
  patchSettings,
  saveSettings,
  SettingsSchema,
} from '../lib/settings.js';

function resetDom(): void {
  document.body.replaceChildren();
  const tabBar = document.createElement('ul');
  tabBar.className = 'tabBarItems';
  document.body.appendChild(tabBar);
}

async function flushSettings(): Promise<void> {
  // The chrome.storage shim resolves via queueMicrotask; await a couple of
  // ticks so the in-memory cache catches up.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  _clearSettingsCacheForTests();
  resetDom();
});

describe('extension/features/setup-tabs', () => {
  it('does nothing when the feature is disabled', async () => {
    await saveSettings(SettingsSchema.parse({ features: { setupTabs: false } }));
    const feature = createSetupTabsFeature({ waitTimeoutMs: 0 });
    await feature.init?.();
    expect(document.querySelectorAll('.sfdt-custom-tab')).toHaveLength(0);
  });

  it('injects the three base tabs when enabled', async () => {
    await saveSettings(SettingsSchema.parse({ features: { setupTabs: true } }));
    const feature = createSetupTabsFeature({ waitTimeoutMs: 0 });
    await feature.init?.();
    const tabs = document.querySelectorAll('.sfdt-custom-tab');
    expect(tabs).toHaveLength(3);
    const ids = Array.from(tabs).map((t) => (t as HTMLElement).dataset.tabId);
    expect(ids).toEqual([
      'sfdt_tab_flows',
      'sfdt_tab_flow_trigger_explorer',
      'sfdt_tab_process_automation_settings',
    ]);
  });

  it('adds the Automation Home tab when its opt-in is enabled', async () => {
    await saveSettings(
      SettingsSchema.parse({
        features: { setupTabs: true },
        setupTabs: { automationHomeEnabled: true },
      }),
    );
    const feature = createSetupTabsFeature({ waitTimeoutMs: 0 });
    await feature.init?.();
    expect(document.querySelector('[data-tab-id="sfdt_tab_automation_home"]')).not.toBeNull();
  });

  it('collapses into a single dropdown when grouping is enabled', async () => {
    await saveSettings(
      SettingsSchema.parse({
        features: { setupTabs: true },
        setupTabs: { groupingEnabled: true },
      }),
    );
    const feature = createSetupTabsFeature({ waitTimeoutMs: 0 });
    await feature.init?.();
    expect(document.querySelectorAll('.sfdt-custom-tab')).toHaveLength(1);
    expect(document.querySelector('.sfdt-group-tab')).not.toBeNull();
    expect(document.querySelectorAll('.sfdt-group-dropdown li')).toHaveLength(3);
  });

  it('uses the org identifier from the URL hostname (v1.2.2 fix)', async () => {
    // happy-dom is configured with x.lightning.force.com as the page origin,
    // so the Flows tab href should land on x.my.salesforce-setup.com — NOT
    // on x.my.salesforce-setup.com via a two-segment construction that
    // would yield a non-existent host.
    await saveSettings(SettingsSchema.parse({ features: { setupTabs: true } }));
    const feature = createSetupTabsFeature({ waitTimeoutMs: 0 });
    await feature.init?.();
    const flowsTab = document.querySelector<HTMLAnchorElement>(
      '[data-tab-id="sfdt_tab_flows"] a',
    );
    expect(flowsTab?.href).toBe('https://x.my.salesforce-setup.com/lightning/setup/Flows/home');
  });

  it('toggles enable state via onActivate, with a toast notification', async () => {
    await saveSettings(SettingsSchema.parse({ features: { setupTabs: false } }));
    const feature = createSetupTabsFeature({ waitTimeoutMs: 0 });
    await feature.init?.();
    expect(document.querySelectorAll('.sfdt-custom-tab')).toHaveLength(0);

    await feature.onActivate?.();
    await flushSettings();

    // The toast shim writes a `.sfdt-toast` div into a container.
    expect(document.querySelector('#sfdt-toast-container')).not.toBeNull();
    expect(document.querySelector('.sfdt-toast')?.textContent).toBe('Setup Tabs enabled');
  });

  it('removes injected tabs when the setting flips off after init', async () => {
    await saveSettings(SettingsSchema.parse({ features: { setupTabs: true } }));
    const feature = createSetupTabsFeature({ waitTimeoutMs: 0 });
    await feature.init?.();
    expect(document.querySelectorAll('.sfdt-custom-tab').length).toBeGreaterThan(0);

    await patchSettings({ features: { setupTabs: false } } as never);
    await flushSettings();

    expect(document.querySelectorAll('.sfdt-custom-tab')).toHaveLength(0);
  });

  it('refresh() re-injects from current settings', async () => {
    await saveSettings(SettingsSchema.parse({ features: { setupTabs: true } }));
    const feature = createSetupTabsFeature({ waitTimeoutMs: 0 });
    await feature.init?.();
    expect(document.querySelectorAll('.sfdt-custom-tab')).toHaveLength(3);

    // Force-remove and call refresh — should restore the 3 tabs.
    document.querySelectorAll('.sfdt-custom-tab').forEach((t) => t.remove());
    await feature.refresh?.();
    expect(document.querySelectorAll('.sfdt-custom-tab')).toHaveLength(3);
  });

  it('does nothing if the tab bar never appears (timeout, falsy bar)', async () => {
    // Drop the tab bar entirely so the wait-for-tab-bar timeout fires.
    document.body.replaceChildren();
    await saveSettings(SettingsSchema.parse({ features: { setupTabs: true } }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const feature = createSetupTabsFeature({ waitTimeoutMs: 5 });
    await feature.init?.();
    expect(document.querySelectorAll('.sfdt-custom-tab')).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('setup-tabs teardown', () => {
  beforeEach(() => {
    _clearSettingsCacheForTests();
    document.body.replaceChildren();
    const tabBar = document.createElement('ul');
    tabBar.className = 'tabBarItems';
    document.body.appendChild(tabBar);
    chrome.storage.local.clear();
  });

  it('removes injected tabs and stops the settings subscription on teardown', async () => {
    await saveSettings(SettingsSchema.parse({ features: { setupTabs: true } }));
    const feature = createSetupTabsFeature({ waitTimeoutMs: 0 });
    await feature.init?.();
    expect(document.querySelectorAll('.sfdt-custom-tab').length).toBeGreaterThan(0);
    await feature.teardown?.();
    expect(document.querySelectorAll('.sfdt-custom-tab')).toHaveLength(0);
  });

  it('does not throw when called twice', async () => {
    await saveSettings(SettingsSchema.parse({ features: { setupTabs: true } }));
    const feature = createSetupTabsFeature({ waitTimeoutMs: 0 });
    await feature.init?.();
    await feature.teardown?.();
    await expect(feature.teardown?.()).resolves.not.toThrow();
  });
});
