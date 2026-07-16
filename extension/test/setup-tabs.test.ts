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

  it('injects the base tabs when enabled', async () => {
    await saveSettings(SettingsSchema.parse({ features: { setupTabs: true } }));
    const feature = createSetupTabsFeature({ waitTimeoutMs: 0 });
    await feature.init?.();
    const tabs = document.querySelectorAll('.sfdt-custom-tab');
    expect(tabs).toHaveLength(4);
    const ids = Array.from(tabs).map((t) => (t as HTMLElement).dataset.tabId);
    expect(ids).toEqual([
      'sfdt_tab_flows',
      'sfdt_tab_flow_trigger_explorer',
      'sfdt_tab_process_automation_settings',
      'sfdt_tab_login_as',
    ]);
  });

  it('exposes a "Login as user…" entry deep-linking to the Setup user-search page', async () => {
    await saveSettings(SettingsSchema.parse({ features: { setupTabs: true } }));
    const feature = createSetupTabsFeature({ waitTimeoutMs: 0 });
    await feature.init?.();
    const anchor = document.querySelector<HTMLAnchorElement>(
      '[data-tab-id="sfdt_tab_login_as"] a',
    );
    expect(anchor?.textContent).toBe('Login as user…');
    // Deep link only — the standard Setup ManageUsers (user list) page, where
    // Salesforce renders the per-user Login action and enforces Login-As perms.
    expect(anchor?.href).toBe(
      'https://x.my.salesforce-setup.com/lightning/setup/ManageUsers/home',
    );
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
    expect(document.querySelectorAll('.sfdt-group-dropdown li')).toHaveLength(4);
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
    expect(document.querySelectorAll('.sfdt-custom-tab')).toHaveLength(4);

    // Force-remove and call refresh — should restore the base tabs.
    document.querySelectorAll('.sfdt-custom-tab').forEach((t) => t.remove());
    await feature.refresh?.();
    expect(document.querySelectorAll('.sfdt-custom-tab')).toHaveLength(4);
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

// A minimal stand-in for `window` so navigation tests can observe
// `location.href` mutations and provide a Lightning `$A` without touching the
// real happy-dom window (which would change the page origin for later tests).
function fakeWin(
  href = 'https://x.lightning.force.com/lightning/setup/Other/home',
): { location: { href: string; hostname: string; host: string } } {
  return {
    location: { href, hostname: 'x.lightning.force.com', host: 'x.lightning.force.com' },
  };
}

describe('setup-tabs — flat tab navigation', () => {
  it('navigates in-page via Lightning $A when the SPA event is available', async () => {
    await saveSettings(SettingsSchema.parse({ features: { setupTabs: true } }));
    const setParams = vi.fn();
    const fire = vi.fn();
    const win = { ...fakeWin(), $A: { get: vi.fn(() => ({ setParams, fire })) } };
    const feature = createSetupTabsFeature({ waitTimeoutMs: 0, win: win as never });
    await feature.init?.();
    const anchor = document.querySelector<HTMLAnchorElement>('[data-tab-id="sfdt_tab_flows"] a');
    anchor?.click();
    expect(setParams).toHaveBeenCalledWith({
      url: expect.stringContaining('/lightning/setup/Flows/home'),
    });
    expect(fire).toHaveBeenCalled();
  });

  it('falls back to a hard location assignment when $A is absent', async () => {
    await saveSettings(SettingsSchema.parse({ features: { setupTabs: true } }));
    const win = fakeWin();
    const feature = createSetupTabsFeature({ waitTimeoutMs: 0, win: win as never });
    await feature.init?.();
    const anchor = document.querySelector<HTMLAnchorElement>('[data-tab-id="sfdt_tab_flows"] a');
    anchor?.click();
    expect(win.location.href).toContain('/lightning/setup/Flows/home');
  });

  it('falls back to location.href when the $A lookup throws', async () => {
    await saveSettings(SettingsSchema.parse({ features: { setupTabs: true } }));
    const win = {
      ...fakeWin(),
      $A: {
        get: () => {
          throw new Error('aura boom');
        },
      },
    };
    const feature = createSetupTabsFeature({ waitTimeoutMs: 0, win: win as never });
    await feature.init?.();
    const anchor = document.querySelector<HTMLAnchorElement>('[data-tab-id="sfdt_tab_flows"] a');
    anchor?.click();
    expect(win.location.href).toContain('/lightning/setup/Flows/home');
  });

  it('does not navigate for tabs that open in a new browser tab', async () => {
    await saveSettings(SettingsSchema.parse({ features: { setupTabs: true } }));
    const win = fakeWin();
    const original = win.location.href;
    const feature = createSetupTabsFeature({ waitTimeoutMs: 0, win: win as never });
    await feature.init?.();
    const anchor = document.querySelector<HTMLAnchorElement>(
      '[data-tab-id="sfdt_tab_flow_trigger_explorer"] a',
    );
    anchor?.click();
    expect(win.location.href).toBe(original);
  });
});

describe('setup-tabs — grouped dropdown interaction', () => {
  it('toggles the dropdown open/closed and navigates menu items in-page', async () => {
    await saveSettings(
      SettingsSchema.parse({
        features: { setupTabs: true },
        setupTabs: { groupingEnabled: true },
      }),
    );
    const win = fakeWin();
    const feature = createSetupTabsFeature({ waitTimeoutMs: 0, win: win as never });
    await feature.init?.();

    const groupTab = document.querySelector('.sfdt-group-tab') as HTMLElement;
    const anchor = groupTab.querySelector('a[role="tab"]') as HTMLElement;
    const chevron = groupTab.querySelector('.sfdt-group-chevron') as HTMLElement;
    const dropdown = document.querySelector('.sfdt-group-dropdown') as HTMLElement;

    anchor.click();
    expect(dropdown.classList.contains('sfdt-group-dropdown--open')).toBe(true);
    expect(chevron.getAttribute('aria-expanded')).toBe('true');

    // The chevron has its own click handler that re-runs the toggle.
    chevron.click();
    expect(dropdown.classList.contains('sfdt-group-dropdown--open')).toBe(false);
    expect(chevron.getAttribute('aria-expanded')).toBe('false');

    // Re-open and click an in-page menu item (Flows).
    anchor.click();
    const flowsItem = Array.from(
      dropdown.querySelectorAll<HTMLAnchorElement>('a[role="menuitem"]'),
    ).find((a) => a.textContent === 'Flows');
    flowsItem?.click();
    expect(win.location.href).toContain('/lightning/setup/Flows/home');
    expect(dropdown.classList.contains('sfdt-group-dropdown--open')).toBe(false);
  });

  it('closes the dropdown on an outside click', async () => {
    await saveSettings(
      SettingsSchema.parse({
        features: { setupTabs: true },
        setupTabs: { groupingEnabled: true },
      }),
    );
    const win = fakeWin();
    const feature = createSetupTabsFeature({ waitTimeoutMs: 0, win: win as never });
    await feature.init?.();

    const anchor = document.querySelector('.sfdt-group-tab a[role="tab"]') as HTMLElement;
    const dropdown = document.querySelector('.sfdt-group-dropdown') as HTMLElement;
    anchor.click();
    expect(dropdown.classList.contains('sfdt-group-dropdown--open')).toBe(true);

    document.body.click();
    expect(dropdown.classList.contains('sfdt-group-dropdown--open')).toBe(false);
  });

  it('marks the group tab active when the current URL matches a child tab', async () => {
    await saveSettings(
      SettingsSchema.parse({
        features: { setupTabs: true },
        setupTabs: { groupingEnabled: true },
      }),
    );
    const win = fakeWin('https://x.lightning.force.com/lightning/setup/Flows/home');
    const feature = createSetupTabsFeature({ waitTimeoutMs: 0, win: win as never });
    await feature.init?.();
    const groupTab = document.querySelector('.sfdt-group-tab') as HTMLElement;
    expect(groupTab.classList.contains('slds-is-active')).toBe(true);
    expect(groupTab.querySelector('a[role="tab"]')?.getAttribute('aria-selected')).toBe('true');
  });
});

describe('setup-tabs — Field Access (object-contextual)', () => {
  const omWin = (object: string) =>
    ({
      location: {
        href: `https://x.lightning.force.com/lightning/setup/ObjectManager/${object}/FieldsAndRelationships/view`,
        hostname: 'x.lightning.force.com',
        host: 'x.lightning.force.com',
      },
    }) as never;

  it('adds a Field Access tab pointed at the current object on Object Manager pages', async () => {
    await saveSettings(SettingsSchema.parse({ features: { setupTabs: true } }));
    const feature = createSetupTabsFeature({ waitTimeoutMs: 0, win: omWin('Account') });
    await feature.init?.();
    const anchor = document.querySelector<HTMLAnchorElement>(
      '[data-tab-id="sfdt_tab_field_access"] a',
    );
    expect(anchor?.href).toBe(
      'https://x.my.salesforce-setup.com/lightning/setup/ObjectManager/Account/FieldAccess/view',
    );
  });

  it('targets a custom object by whatever identifier is in the URL', async () => {
    await saveSettings(SettingsSchema.parse({ features: { setupTabs: true } }));
    const feature = createSetupTabsFeature({ waitTimeoutMs: 0, win: omWin('My_Object__c') });
    await feature.init?.();
    const anchor = document.querySelector<HTMLAnchorElement>(
      '[data-tab-id="sfdt_tab_field_access"] a',
    );
    expect(anchor?.href).toContain('/ObjectManager/My_Object__c/FieldAccess/view');
  });

  it('is absent on Setup pages that are not an Object Manager object', async () => {
    await saveSettings(SettingsSchema.parse({ features: { setupTabs: true } }));
    const win = {
      location: {
        href: 'https://x.lightning.force.com/lightning/setup/Flows/home',
        hostname: 'x.lightning.force.com',
        host: 'x.lightning.force.com',
      },
    } as never;
    const feature = createSetupTabsFeature({ waitTimeoutMs: 0, win });
    await feature.init?.();
    expect(document.querySelector('[data-tab-id="sfdt_tab_field_access"]')).toBeNull();
  });
});

describe('setup-tabs — deferred tab bar', () => {
  it('injects once the tab bar appears after init (MutationObserver path)', async () => {
    document.body.replaceChildren(); // no tab bar yet
    await saveSettings(SettingsSchema.parse({ features: { setupTabs: true } }));
    const feature = createSetupTabsFeature({ waitTimeoutMs: 1000 });
    const pending = feature.init?.();

    // Let the observer attach, then add the tab bar so it fires.
    await new Promise((r) => setTimeout(r, 0));
    const bar = document.createElement('ul');
    bar.className = 'tabBarItems';
    document.body.appendChild(bar);

    await pending;
    expect(document.querySelectorAll('.sfdt-custom-tab')).toHaveLength(4);
  });
});
