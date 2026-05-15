// Setup Tabs feature — port of
// /Users/dkennedy/dev/2.0.2_0 copy/features/setup-tabs.js.
//
// Injects quick-access tabs into Salesforce's Setup tab bar: Flows, Flow
// Trigger Explorer, Process Automation Settings, and (opt-in) Automation
// Home. Honours the master `setupTabs.enabled` toggle, the
// `automationHomeEnabled` opt-in, and the `groupingEnabled` switch that
// collapses everything under a single "Automation" dropdown.
//
// The hostname construction uses the v1.2.2-restored helpers in
// extension/lib/hostname.ts. The v1.2.3 toast z-index fix is inherited
// automatically by routing through extension/ui/toast.ts.

import {
  lightningHostname as toLightningHost,
  setupHostname as toSetupHost,
} from '../lib/hostname.js';
import { isFeatureEnabled, loadSettings, onSettingsChange, patchSettings, registerSettingsShape } from '../lib/settings.js';
import type { Feature } from '../lib/feature-registry.js';
import { CONTEXTS } from '../lib/context-detector.js';
import { showToast } from '../ui/toast.js';
import { z } from 'zod';

const SETUP_TABS_SETTINGS_SCHEMA = z.object({
  automationHomeEnabled: z.boolean().default(false),
  groupingEnabled: z.boolean().default(false),
});

registerSettingsShape('setup-tabs', SETUP_TABS_SETTINGS_SCHEMA);

const TAB_CLASS = 'sfut-custom-tab';
const GROUP_LABEL = 'Automation';

interface TabDefinition {
  id: string;
  label: string;
  buildUrl: (hostname: string) => string;
  openInNewTab: boolean;
}

const BASE_TABS: readonly TabDefinition[] = [
  {
    id: 'sfut_tab_flows',
    label: 'Flows',
    buildUrl: (hostname) => `https://${toSetupHost(hostname)}/lightning/setup/Flows/home`,
    openInNewTab: false,
  },
  {
    id: 'sfut_tab_flow_trigger_explorer',
    label: 'Flow Trigger Explorer',
    buildUrl: (hostname) =>
      `https://${toLightningHost(hostname)}/interaction_explorer/flowExplorer.app`,
    openInNewTab: true,
  },
  {
    id: 'sfut_tab_process_automation_settings',
    label: 'Process Automation Settings',
    buildUrl: (hostname) =>
      `https://${toSetupHost(hostname)}/lightning/setup/WorkflowSettings/home`,
    openInNewTab: false,
  },
];

const AUTOMATION_HOME_TAB: TabDefinition = {
  id: 'sfut_tab_automation_home',
  label: 'Automation Home',
  buildUrl: (hostname) => `https://${toLightningHost(hostname)}/lightning/app/standard__FlowsApp`,
  openInNewTab: true,
};

function isActiveTab(tabId: string, url: string): boolean {
  switch (tabId) {
    case 'sfut_tab_flows':
      return url.includes('/lightning/setup/Flows/');
    case 'sfut_tab_flow_trigger_explorer':
      return url.includes('/interaction_explorer/flowExplorer');
    case 'sfut_tab_process_automation_settings':
      return url.includes('/lightning/setup/WorkflowSettings/');
    case 'sfut_tab_automation_home':
      return url.includes('/lightning/app/');
    default:
      return false;
  }
}

function findTabBar(doc: Document): Element | null {
  return doc.querySelector('ul.tabBarItems');
}

function waitForTabBar(doc: Document, timeoutMs = 10_000): Promise<Element | null> {
  const existing = findTabBar(doc);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const found = findTabBar(doc);
      if (found) {
        observer.disconnect();
        resolve(found);
      }
    });
    observer.observe(doc.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      resolve(findTabBar(doc));
    }, timeoutMs);
  });
}

function removeInjectedTabs(doc: Document): void {
  const tabs = doc.querySelectorAll(`.${TAB_CLASS}`);
  for (const tab of tabs) tab.remove();
}

function navigateInPage(url: string, win: Window): void {
  // Best-effort: use Lightning's force:navigateToURL when available so
  // navigation stays inside the SPA. Fall back to a hard location assignment.
  const winWithAura = win as unknown as {
    $A?: { get?: (event: string) => { setParams: (p: { url: string }) => void; fire: () => void } | null };
  };
  try {
    const event = winWithAura.$A?.get?.('e.force:navigateToURL');
    if (event) {
      event.setParams({ url });
      event.fire();
      return;
    }
  } catch {
    // Fall through to hard navigation.
  }
  win.location.href = url;
}

function buildFlatTab(
  doc: Document,
  win: Window,
  tab: TabDefinition,
  hostname: string,
  url: string,
): HTMLLIElement {
  const targetUrl = tab.buildUrl(hostname);
  const li = doc.createElement('li');
  li.setAttribute('role', 'presentation');
  li.className = `oneConsoleTabItem tabItem slds-context-bar__item borderRight navexConsoleTabItem ${TAB_CLASS}`;
  li.dataset.tabId = tab.id;
  li.dataset.url = targetUrl;

  const anchor = doc.createElement('a');
  anchor.setAttribute('role', 'tab');
  anchor.setAttribute('tabindex', '-1');
  anchor.setAttribute('title', tab.label);
  anchor.setAttribute('aria-selected', isActiveTab(tab.id, url) ? 'true' : 'false');
  anchor.href = targetUrl;
  anchor.target = tab.openInNewTab ? '_blank' : '_self';
  anchor.className = 'tabHeader slds-context-bar__label-action';

  const label = doc.createElement('span');
  label.className = 'title slds-truncate';
  label.textContent = tab.label;
  anchor.appendChild(label);

  anchor.addEventListener('click', (e) => {
    if (tab.openInNewTab) return;
    e.preventDefault();
    navigateInPage(tab.buildUrl(hostname), win);
  });

  li.appendChild(anchor);
  return li;
}

function injectFlatTabs(
  doc: Document,
  win: Window,
  tabBar: Element,
  tabsToInject: readonly TabDefinition[],
  hostname: string,
): void {
  const url = win.location.href;
  for (const tab of tabsToInject) {
    try {
      tabBar.appendChild(buildFlatTab(doc, win, tab, hostname, url));
    } catch (err) {
      console.warn('[SFUT setup-tabs] Failed to inject tab', tab.id, err);
    }
  }
}

function buildGroupedTab(
  doc: Document,
  win: Window,
  tabsToInject: readonly TabDefinition[],
  hostname: string,
  url: string,
): HTMLLIElement | null {
  const tabItems: Array<{ tab: TabDefinition; url: string }> = [];
  for (const tab of tabsToInject) {
    try {
      tabItems.push({ tab, url: tab.buildUrl(hostname) });
    } catch (err) {
      console.warn('[SFUT setup-tabs] Failed to build grouped tab URL', tab.id, err);
    }
  }
  if (tabItems.length === 0) return null;

  const anyChildActive = tabItems.some(({ tab }) => isActiveTab(tab.id, url));

  const li = doc.createElement('li');
  li.setAttribute('role', 'presentation');
  li.className = `oneConsoleTabItem tabItem slds-context-bar__item borderRight navexConsoleTabItem ${TAB_CLASS} sfut-group-tab`;
  if (anyChildActive) li.classList.add('slds-is-active');

  const anchor = doc.createElement('a');
  anchor.setAttribute('role', 'tab');
  anchor.setAttribute('tabindex', '-1');
  anchor.setAttribute('title', GROUP_LABEL);
  anchor.setAttribute('aria-selected', anyChildActive ? 'true' : 'false');
  anchor.href = 'javascript:void(0)';
  anchor.className = 'tabHeader slds-context-bar__label-action';

  const labelSpan = doc.createElement('span');
  labelSpan.className = 'title slds-truncate';
  labelSpan.textContent = GROUP_LABEL;
  anchor.appendChild(labelSpan);

  const chevronWrapper = doc.createElement('div');
  chevronWrapper.className = 'slds-context-bar__label-action slds-p-left--none';

  const chevronBtn = doc.createElement('a');
  chevronBtn.className = 'slds-button slds-button--icon sfut-group-chevron';
  chevronBtn.setAttribute('href', 'javascript:void(0)');
  chevronBtn.setAttribute('role', 'button');
  chevronBtn.setAttribute('aria-expanded', 'false');
  chevronBtn.setAttribute('aria-haspopup', 'true');
  chevronBtn.setAttribute('title', `${GROUP_LABEL} options`);
  // Build the chevron SVG via DOM nodes so this file has no innerHTML usage.
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(svgNs, 'svg');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('viewBox', '0 0 520 520');
  svg.setAttribute(
    'class',
    'slds-icon slds-icon_xx-small slds-button__icon slds-button__icon--hint',
  );
  const svgPath = doc.createElementNS(svgNs, 'path');
  svgPath.setAttribute(
    'd',
    'M476 178L271 385c-6 6-16 6-22 0L44 178c-6-6-6-16 0-22l22-22c6-6 16-6 22 0l161 163c6 6 16 6 22 0l161-162c6-6 16-6 22 0l22 22c5 6 5 15 0 21z',
  );
  svg.appendChild(svgPath);
  chevronBtn.appendChild(svg);
  chevronWrapper.appendChild(chevronBtn);

  const dropdown = doc.createElement('div');
  dropdown.className = 'sfut-group-dropdown';
  dropdown.setAttribute('role', 'menu');
  const ul = doc.createElement('ul');
  ul.setAttribute('role', 'presentation');

  for (const { tab, url: tabUrl } of tabItems) {
    const itemLi = doc.createElement('li');
    itemLi.setAttribute('role', 'presentation');
    itemLi.className = 'uiMenuItem';

    const link = doc.createElement('a');
    link.setAttribute('role', 'menuitem');
    link.setAttribute('href', tabUrl);
    link.setAttribute('title', tab.label);
    link.target = tab.openInNewTab ? '_blank' : '_self';
    link.textContent = tab.label;

    link.addEventListener('click', (e) => {
      closeDropdown(dropdown, chevronBtn);
      if (tab.openInNewTab) return;
      e.preventDefault();
      navigateInPage(tab.buildUrl(hostname), win);
    });

    itemLi.appendChild(link);
    ul.appendChild(itemLi);
  }
  dropdown.appendChild(ul);

  const toggle = (e: Event): void => {
    e.preventDefault();
    e.stopPropagation();
    const isOpen = dropdown.classList.contains('sfut-group-dropdown--open');

    for (const other of doc.querySelectorAll('.sfut-group-dropdown--open')) {
      const otherLi = other.closest('.sfut-group-tab');
      const otherChevron = otherLi?.querySelector('.sfut-group-chevron') ?? null;
      other.classList.remove('sfut-group-dropdown--open');
      otherChevron?.setAttribute('aria-expanded', 'false');
    }

    if (!isOpen) {
      dropdown.classList.add('sfut-group-dropdown--open');
      chevronBtn.setAttribute('aria-expanded', 'true');
    }
  };

  anchor.addEventListener('click', toggle);
  chevronBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle(e);
  });

  doc.addEventListener(
    'click',
    (e) => {
      if (!li.contains(e.target as Node | null)) closeDropdown(dropdown, chevronBtn);
    },
    { capture: true },
  );

  li.appendChild(anchor);
  li.appendChild(chevronWrapper);
  li.appendChild(dropdown);
  return li;
}

function closeDropdown(dropdown: Element, chevron: Element | null): void {
  dropdown.classList.remove('sfut-group-dropdown--open');
  chevron?.setAttribute('aria-expanded', 'false');
}

export interface SetupTabsOptions {
  doc?: Document;
  win?: Window;
  waitTimeoutMs?: number;
}

export function createSetupTabsFeature(options: SetupTabsOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const timeoutMs = options.waitTimeoutMs ?? 10_000;
  let injecting = false;
  // Captured so teardown can unsubscribe the storage-change listener.
  let _unsubscribeSettings: (() => void) | null = null;

  async function injectIfEnabled(): Promise<void> {
    const settings = await loadSettings();
    if (!isFeatureEnabled(settings, 'setup-tabs')) {
      removeInjectedTabs(doc);
      return;
    }
    if (injecting) return;
    if (doc.querySelector(`.${TAB_CLASS}`)) return; // Already mounted.

    injecting = true;
    try {
      const tabBar = await waitForTabBar(doc, timeoutMs);
      if (!tabBar) {
        console.warn('[SFUT setup-tabs] tab bar not found within timeout');
        return;
      }
      if (doc.querySelector(`.${TAB_CLASS}`)) return; // Lost a race.

      const setupTabsConfig = settings.featureSettings?.['setup-tabs'] ?? settings.setupTabs;
      const tabsToInject: TabDefinition[] = [...BASE_TABS];
      if (setupTabsConfig.automationHomeEnabled) tabsToInject.push(AUTOMATION_HOME_TAB);

      const hostname = win.location.hostname;
      if (setupTabsConfig.groupingEnabled) {
        const grouped = buildGroupedTab(doc, win, tabsToInject, hostname, win.location.href);
        if (grouped) tabBar.appendChild(grouped);
      } else {
        injectFlatTabs(doc, win, tabBar, tabsToInject, hostname);
      }
    } finally {
      injecting = false;
    }
  }

  return {
    manifest: {
      id: 'setup-tabs',
      contexts: [CONTEXTS.SETUP_FLOWS, CONTEXTS.FLOW_TRIGGER_EXPLORER, CONTEXTS.SETUP_OTHER],
      settingsSchema: SETUP_TABS_SETTINGS_SCHEMA,
    },

    async init() {
      await injectIfEnabled();

      // Live re-inject when settings change so the user doesn't have to
      // reload Salesforce to see the result of toggling the feature.
      _unsubscribeSettings = onSettingsChange(async () => {
        removeInjectedTabs(doc);
        await injectIfEnabled();
      });
    },

    async onActivate() {
      const settings = await loadSettings();
      const nextEnabled = !isFeatureEnabled(settings, 'setup-tabs');
      await patchSettings({ features: { ...settings.features, 'setup-tabs': nextEnabled } });
      showToast(nextEnabled ? 'Setup Tabs enabled' : 'Setup Tabs disabled', {
        kind: nextEnabled ? 'success' : 'info',
        doc,
      });
    },

    async refresh() {
      removeInjectedTabs(doc);
      await injectIfEnabled();
    },

    async teardown(): Promise<void> {
      _unsubscribeSettings?.();
      _unsubscribeSettings = null;
      removeInjectedTabs(doc);
    },
  };
}

/**
 * Test seam — exposes the unsubscribe so component tests can clean up.
 */
export function _setupTabsTestApi() {
  return { TAB_CLASS, GROUP_LABEL };
}
