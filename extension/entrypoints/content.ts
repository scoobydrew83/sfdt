// Content script entrypoint.
//
// Boot orchestration (Phase B):
//   - Detect that we're on a Salesforce page (the manifest already filtered
//     hosts, but the SPA router re-checks on every navigation so we stop
//     rendering when the user leaves Lightning).
//   - Load settings and the kill-switch list (with a 1.5 s timeout fallback
//     to the last-known cache).
//   - Mount the side button whose menuItemsProvider filters by kill-switch,
//     user toggle, and current page context.
//   - Re-run the gate on settings changes and SPA route changes.

import { defineContentScript } from 'wxt/utils/define-content-script';
import {
  buildContextToFeatures,
  getAvailableFeatures,
  setContextSource,
} from '../lib/context-detector.js';
import { createFeatureRegistry } from '../lib/feature-registry.js';
import { createSpaRouter } from '../lib/spa-router.js';
import { isFeatureEnabled, loadSettings, onSettingsChange } from '../lib/settings.js';
import { createBridgeClient } from '../lib/sfdt-bridge.js';
import { readKillSwitchCache, writeKillSwitchCache } from '../lib/killswitch-cache.js';
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

    // ── Feature registration (unchanged from Phase A) ──
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

    setContextSource(buildContextToFeatures(registry.listManifests()));

    // ── Kill-switch state ──
    // Boot path awaits one ping with a 1.5s timeout; on miss, fall back to
    // the last-known cache. Subsequent route changes refresh in the
    // background; the gate uses whichever list is current.
    let disabledRemote: ReadonlySet<string> = new Set(await readKillSwitchCache());
    let currentSettings = settings;

    let bridge = createBridgeClient({
      token: settings.bridge.token,
      preferredTransport: settings.bridge.preferredTransport,
      localhostPort: settings.bridge.localhostPort,
    });

    async function refreshKillSwitch(): Promise<void> {
      try {
        const info = await Promise.race([
          bridge.getServerInfo(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
        ]);
        if (info) {
          disabledRemote = new Set(info.disabledFeatures);
          await writeKillSwitchCache(info.disabledFeatures);
        }
      } catch (err) {
        console.warn('[SFUT] kill-switch refresh failed:', err);
      }
    }

    function makeGate() {
      return {
        disabledRemote,
        isUserEnabled: (id: string) => isFeatureEnabled(currentSettings, id),
      };
    }

    // Wait once at boot so the very first init pass already respects the
    // remote list. If the bridge times out we proceed with the cached list.
    await refreshKillSwitch();

    // ── Menu items + side button (ICONS map preserved from Phase A) ──
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

    const menuItemsProvider = (): MenuItem[] => {
      const available = getAvailableFeatures();
      const items: MenuItem[] = [];
      for (const featureId of available) {
        if (!registry.has(featureId)) continue;
        if (disabledRemote.has(featureId)) continue;
        if (!isFeatureEnabled(currentSettings, featureId)) continue;
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
            void chrome.runtime.lastError;
          });
        },
      },
    });

    // ── Settings change → re-run the gate ──
    onSettingsChange((next) => {
      const bridgeChanged =
        next.bridge.token !== currentSettings.bridge.token ||
        next.bridge.preferredTransport !== currentSettings.bridge.preferredTransport ||
        next.bridge.localhostPort !== currentSettings.bridge.localhostPort;
      currentSettings = next;
      if (bridgeChanged) {
        bridge = createBridgeClient({
          token: next.bridge.token,
          preferredTransport: next.bridge.preferredTransport,
          localhostPort: next.bridge.localhostPort,
        });
        // New client → refresh kill-switch immediately so subsequent route
        // changes use the new server's view of disabled features.
        void refreshKillSwitch();
      }
      void registry.initForCurrentRoute(getAvailableFeatures(), makeGate());
      sideButton.refresh();
    });

    // ── SPA route change → refresh kill-switch (fire-and-forget), then init ──
    router.onChange(({ url }) => {
      registry.resetForRouteChange(url);
      void refreshKillSwitch();
      sideButton.refresh();
      void registry.initForCurrentRoute(getAvailableFeatures(), makeGate());
    });
    router.start();

    await registry.initForCurrentRoute(getAvailableFeatures(), makeGate());

    console.log('[SFUT] Shell mounted with kill-switch enabled.');
  },
});
