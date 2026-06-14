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
import { createTelemetry, type BridgeFailureCategory } from '../lib/telemetry.js';
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
import { createOrgLimitsFeature } from '../features/org-limits.js';
import { createRestExploreFeature } from '../features/rest-explore.js';
import { createScheduledFlowExplorerFeature } from '../features/scheduled-flow-explorer.js';
import { createSetupTabsFeature } from '../features/setup-tabs.js';
import { createSoqlRunnerFeature } from '../features/soql-runner.js';
import { createSubflowGraphFeature } from '../features/subflow-graph.js';
import { createTriggerConflictsFeature } from '../features/trigger-conflicts.js';
import { createInspectRecordFeature } from '../features/inspect-record.js';
import { createDataImportFeature } from '../features/data-import.js';
import { createFieldCreatorFeature } from '../features/field-creator.js';
import { createMetadataRetrieveFeature } from '../features/metadata-retrieve.js';
import { createSoapExploreFeature } from '../features/soap-explore.js';
import { createEventMonitorFeature } from '../features/event-monitor.js';
import { createExportForPromptFeature } from '../features/export-for-prompt.js';

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
    // The all_frames match runs this entrypoint in iframes too, but the
    // side button must mount only in the top frame to avoid duplicates.
    if (window.top !== window.self) return;

    if (!SALESFORCE_HOST_PATTERN.test(window.location.href)) return;

    const settings = await loadSettings();
    let currentSettings = settings;
    const telemetry = createTelemetry({
      isEnabled: () => currentSettings.telemetry?.enabled ?? false,
    });
    const registry = createFeatureRegistry({ track: telemetry.track });
    const router = createSpaRouter();

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
    registry.register(createSoqlRunnerFeature());
    registry.register(createOrgLimitsFeature());
    registry.register(createRestExploreFeature());
    registry.register(createInspectRecordFeature());
    registry.register(createDataImportFeature());
    registry.register(createFieldCreatorFeature());
    registry.register(createMetadataRetrieveFeature());
    registry.register(createSoapExploreFeature());
    registry.register(createEventMonitorFeature());
    registry.register(createExportForPromptFeature());

    setContextSource(buildContextToFeatures(registry.listManifests()));

    // Boot awaits one ping with a 1.5s timeout; on miss, fall back to the
    // last-known cache so the side button still renders something useful.
    // Cache entries older than 24h are ignored (treated as no cache) so a
    // long-dead bridge can't pin stale kill-switch state forever.
    // Subsequent route changes refresh in the background.
    let disabledRemote: ReadonlySet<string> = new Set(await readKillSwitchCache());

    // Fire-and-forget by design — the bridge never awaits this hook, and the
    // bridge layer already skips telemetry.* kinds to avoid feedback loops.
    const onBridgeFailure = (failure: { category: BridgeFailureCategory }): void => {
      void telemetry.trackBridgeFailure(failure.category);
    };

    let bridge = createBridgeClient({
      token: settings.bridge.token,
      preferredTransport: settings.bridge.preferredTransport,
      localhostPort: settings.bridge.localhostPort,
      onBridgeFailure,
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

    await refreshKillSwitch();

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
      'soql-runner': { icon: '🗂', label: 'SOQL Query Runner' },
      'org-limits': { icon: '🚦', label: 'Org Limits' },
      'rest-explore': { icon: '🛠', label: 'REST API Explorer' },
      'inspect-record': { icon: '🔍', label: 'Inspect Record (Show All Data)' },
      'data-import': { icon: '📥', label: 'Data Import Wizard' },
      'field-creator': { icon: '🛠', label: 'Bulk Field Creator' },
      'metadata-retrieve': { icon: '📦', label: 'Metadata Retrieve & Deploy' },
      'soap-explore': { icon: '💬', label: 'SOAP API Explorer' },
      'event-monitor': { icon: '📡', label: 'Event Streaming Monitor' },
      'export-for-prompt': { icon: '📋', label: 'Copy Schema for Prompt' },
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
          onBridgeFailure,
        });
        void refreshKillSwitch();
      }
      void registry.initForCurrentRoute(getAvailableFeatures(), makeGate());
      sideButton.refresh();
    });

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
