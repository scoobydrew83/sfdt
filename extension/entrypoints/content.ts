// Content script entrypoint.
//
// Phase 3 boots the shell:
//   - Detect that we're on a Salesforce page (the manifest already filtered
//     hosts, but the SPA router re-checks on every navigation so we stop
//     rendering when the user leaves Lightning).
//   - Mount the side button.
//   - Hook up the SPA router so the button menu refreshes on route change.
//   - Initialise the feature registry (empty in Phase 3; populated in
//     Phase 4 as each feature is ported).
//
// No actual features run yet. The exit criterion is "side button visible
// with an empty menu, no console errors".

import { defineContentScript } from 'wxt/utils/define-content-script';
import { getAvailableFeatures } from '../lib/context-detector.js';
import { createFeatureRegistry } from '../lib/feature-registry.js';
import { createSpaRouter } from '../lib/spa-router.js';
import { loadSettings } from '../lib/settings.js';
import { mountSideButton, type MenuItem } from '../ui/side-button.js';
import { createAiAssistantFeature } from '../features/ai-assistant.js';
import { createApiNameGeneratorFeature } from '../features/api-name-generator.js';
import { createCanvasSearchFeature } from '../features/canvas-search.js';
import { createComparisonExporterFeature } from '../features/comparison-exporter.js';
import { createFlowDeployFeature } from '../features/flow-deploy.js';
import { createFlowHealthCheckFeature } from '../features/flow-health-check.js';
import { createFlowListSearchFeature } from '../features/flow-list-search.js';
import { createFlowTriggerExplorerEnhancerFeature } from '../features/flow-trigger-explorer-enhancer.js';
import { createFlowVersionManagerFeature } from '../features/flow-version-manager.js';
import { createMissingDescriptionFlagsFeature } from '../features/missing-description-flags.js';
import { createScheduledFlowExplorerFeature } from '../features/scheduled-flow-explorer.js';
import { createSetupTabsFeature } from '../features/setup-tabs.js';
import { createSubflowGraphFeature } from '../features/subflow-graph.js';
import { createTriggerConflictsFeature } from '../features/trigger-conflicts.js';

const SALESFORCE_HOST_PATTERN =
  /^https:\/\/[^/]+\.(salesforce\.com|salesforce-setup\.com|my\.salesforce\.com|lightning\.force\.com)\//i;

export default defineContentScript({
  matches: [
    'https://*.salesforce.com/*',
    'https://*.salesforce-setup.com/*',
    'https://*.my.salesforce.com/*',
    'https://*.lightning.force.com/*',
  ],
  runAt: 'document_idle',
  allFrames: true,
  async main() {
    // Only mount the UI in the top frame. The all_frames match still runs
    // this entrypoint in iframes (so they can participate in future
    // feature wiring), but the side button itself stays top-only — same
    // behaviour as v2.0.2's side-button.js:32.
    if (window.top !== window.self) return;

    if (!SALESFORCE_HOST_PATTERN.test(window.location.href)) return;

    const settings = await loadSettings();
    const registry = createFeatureRegistry();
    const router = createSpaRouter();

    // Register Phase 4 features. Each module decides whether to do anything
    // on init() based on its own settings flag, so registration is cheap and
    // always safe — even if the user has disabled the feature.
    registry.register(createSetupTabsFeature());
    registry.register(createCanvasSearchFeature());
    registry.register(createFlowListSearchFeature());
    registry.register(createFlowHealthCheckFeature());
    registry.register(createMissingDescriptionFlagsFeature());
    registry.register(createFlowVersionManagerFeature());
    registry.register(createAiAssistantFeature());
    registry.register(createScheduledFlowExplorerFeature());
    registry.register(createApiNameGeneratorFeature());
    registry.register(createComparisonExporterFeature());
    registry.register(createFlowTriggerExplorerEnhancerFeature());
    registry.register(createTriggerConflictsFeature());
    registry.register(createSubflowGraphFeature());
    registry.register(createFlowDeployFeature());

    // The menu item icons mirror v2.0.2's side-button.js featureMap. A
    // feature only appears here when (a) it's registered, (b) the current
    // context advertises it, and (c) settings.features.<id> is true. (c)
    // closes the CHANGELOG-v2.0.0.md:148 gap.
    const ICONS: Record<string, { icon: string; label: string }> = {
      'setup-tabs': { icon: '📑', label: 'Setup Tabs' },
      'flow-list-search': { icon: '🔍', label: 'Flow List Search' },
      'canvas-search': { icon: '🔎', label: 'Search & Highlight' },
      'missing-descriptions': { icon: '⚠️', label: 'Show Missing Description Flags' },
      'ai-assistant': { icon: '🤖', label: 'Flow Metadata & AI Assistant' },
      'api-name-generator': { icon: '🔤', label: 'API Name Generator' },
      'comparison-exporter': { icon: '📊', label: 'Comparison Exporter' },
      'flow-version-manager': { icon: '🧾', label: 'Flow Version Manager' },
      'flow-trigger-explorer-enhancer': { icon: '🧭', label: 'Flow Trigger Explorer Enhancer' },
      'flow-health-check': { icon: '🩺', label: 'Run Health Check' },
      'scheduled-flow-explorer': { icon: '⏰', label: 'Scheduled Flow Explorer' },
      'trigger-conflicts': { icon: '⚡', label: 'Trigger Conflicts' },
      'subflow-graph': { icon: '🕸', label: 'Subflow Caller Graph' },
      'flow-deploy': { icon: '🚀', label: 'Deploy or Rollback…' },
    };

    // Menu visibility is by context only — every feature exposed by the
    // current context shows up, regardless of its enable flag. Each
    // feature's onActivate decides what to do (some toggle a setting,
    // some open a modal); the settings.features.X flag governs whether
    // the feature auto-runs at init() time, not whether the menu shows
    // it. Smoke test surfaced this: with the old filter, features that
    // toggle their own state (setup-tabs, missing-descriptions) could
    // never be enabled because the toggle was hidden until they were
    // enabled. Mirror of v2.0.2's original side-button.js behaviour.
    void settings; // referenced only for the load-on-start side effect.

    const menuItemsProvider = (): MenuItem[] => {
      const available = getAvailableFeatures();
      const items: MenuItem[] = [];
      for (const featureId of available) {
        if (!registry.has(featureId)) continue;
        const entry = ICONS[featureId];
        if (!entry) continue;
        items.push({ featureId, icon: entry.icon, label: entry.label });
      }
      return items;
    };

    const sideButton = mountSideButton({
      menuItemsProvider,
      handlers: {
        onActivate: (item) => registry.dispatch(item.featureId, item.action ?? 'activate'),
        onOpenSettings: () => {
          chrome.runtime.sendMessage({ action: 'openSettings' }, () => {
            // Swallow lastError. v2.0.2's side-button.js:314 did the same.
            void chrome.runtime.lastError;
          });
        },
      },
    });

    router.onChange(({ url }) => {
      registry.resetForRouteChange(url);
      sideButton.refresh();
      // Only init features the current context supports; the menu provider
      // already filters by both context and settings, but init must run for
      // anything the user has enabled regardless of menu visibility (so e.g.
      // setup-tabs can inject its DOM into the tab bar without being clicked).
      void registry.initForCurrentRoute(getAvailableFeatures());
    });
    router.start();

    await registry.initForCurrentRoute(getAvailableFeatures());

    console.log('[SFUT] Shell mounted.');
  },
});
