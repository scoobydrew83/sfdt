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
import { getShadowHost } from '../ui/shadow-host.js';
import { setContentRoot } from '../ui/content-root.js';
import { ensureTokens } from '../lib/tokens.js';
import { watchTheme } from '../lib/theme.js';
import { FEATURE_ICONS } from '../lib/feature-icons.js';
import { createAiAssistantFeature } from '../features/ai-assistant.js';
import { createApiNameGeneratorFeature } from '../features/api-name-generator.js';
import { createCanvasSearchFeature } from '../features/canvas-search.js';
import { createComparisonExporterFeature } from '../features/comparison-exporter.js';
import { createFlowDeployFeature } from '../features/flow-deploy.js';
import { createFlowHealthCheckFeature } from '../features/flow-health-check.js';
import { createFlowQualityFeature } from '../features/flow-quality.js';
import { createDependencyExplorerFeature } from '../features/dependency-explorer.js';
import { createFlowListSearchFeature } from '../features/flow-list-search.js';
import { createFlowTriggerExplorerEnhancerFeature } from '../features/flow-trigger-explorer-enhancer.js';
import { createFlowVersionManagerFeature } from '../features/flow-version-manager.js';
import { createMissingDescriptionFlagsFeature } from '../features/missing-description-flags.js';
import { createOrgLimitsFeature } from '../features/org-limits.js';
import { createOrgHealthLiveFeature } from '../features/org-health-live.js';
import { createOrgHealthFeature } from '../features/org-health.js';
import { createCodeCoverageFeature } from '../features/code-coverage.js';
import { createRestExploreFeature } from '../features/rest-explore.js';
import { createScheduledFlowExplorerFeature } from '../features/scheduled-flow-explorer.js';
import { createSetupTabsFeature } from '../features/setup-tabs.js';
import { createSoqlRunnerFeature } from '../features/soql-runner.js';
import { createSubflowGraphFeature } from '../features/subflow-graph.js';
import { createTriggerConflictsFeature } from '../features/trigger-conflicts.js';
import { createInspectRecordFeature } from '../features/inspect-record.js';
import { createShowApiNamesFeature } from '../features/show-api-names.js';
import { createDataImportFeature } from '../features/data-import.js';
import { createFieldCreatorFeature } from '../features/field-creator.js';
import { createMetadataRetrieveFeature } from '../features/metadata-retrieve.js';
import { createSoapExploreFeature } from '../features/soap-explore.js';
import { createEventMonitorFeature } from '../features/event-monitor.js';
import { createExportForPromptFeature } from '../features/export-for-prompt.js';
import { createApexAnonymousFeature } from '../features/apex-anonymous.js';
import { createDebugLogViewerFeature } from '../features/debug-log-viewer.js';
import { createSavedSoqlFeature } from '../features/saved-soql.js';
import { createOrgSwitcherFeature } from '../features/org-switcher.js';
import { createOrgReleaseBadgeFeature } from '../features/org-release-badge.js';
import { createApiVersionAuditFeature } from '../features/api-version-audit.js';

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

    // Inject the --sfdt-* design tokens into the host page so every feature's
    // inline `var(--sfdt-*)` colours resolve. Idempotent + namespaced, so it
    // can't collide with Salesforce's own styles.
    ensureTokens(document);
    // Resolve + apply the user's theme (light/dark/auto) to our injected UI and
    // keep it live (OS scheme change + settings change). Our tokens are
    // `--sfdt-*` scoped, so this themes only the extension's overlays, never
    // the host Salesforce page.
    watchTheme(document);

    // Mount ALL injected UI (side button + menu, present-view modals, toasts)
    // inside one closed shadow root so the host page's CSS can't restyle us and
    // our styles can't leak out (P0-3, CONVENTIONS.md item 13). Tokens stay on
    // the host `:root` (above) and inherit across the boundary, so dark mode
    // keeps working. From here, the UI helpers read this root via getContentRoot().
    setContentRoot(getShadowHost(document).mount);

    const settings = await loadSettings();
    let currentSettings = settings;
    const telemetry = createTelemetry({
      isEnabled: () => currentSettings.telemetry?.enabled ?? false,
    });
    const registry = createFeatureRegistry({ track: telemetry.track });
    const router = createSpaRouter();

    registry.register(createSetupTabsFeature());
    // Non-interactive pill in the Setup tab strip: org release + preview flag
    // (derived via flow-core, same as CLI `monitor org-info`).
    registry.register(createOrgReleaseBadgeFeature());
    // Click-to-open pill next to the badge: org max API version + per-type
    // ApiVersion histograms, banded via flow-core's minApiVersionFloor.
    registry.register(createApiVersionAuditFeature());
    registry.register(createCanvasSearchFeature());
    registry.register(createFlowListSearchFeature());
    registry.register(createFlowHealthCheckFeature());
    // Dependency Explorer + Flow Scanner. The Scanner's dependency rows cross-link
    // into the Explorer (openFor pre-fills + searches), so both are registered
    // here — on real Setup/Flow pages — not just in the Workspace app.
    const depExplorer = createDependencyExplorerFeature();
    registry.register(depExplorer);
    // Flow Scanner: name/list-driven full quality report (issue families +
    // dependencies) across Setup/Flow contexts, not just the builder canvas.
    registry.register(
      createFlowQualityFeature({
        onExploreDependency: (dep) => void depExplorer.openFor(dep.type, dep.name),
      }),
    );
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
    // Org Health & Apex Coverage query the org's Tooling/REST API directly (via
    // getSalesforceApi(), same as SOQL Runner) rather than reading static CLI
    // snapshots — so they show live, org-specific data on the current page.
    registry.register(createOrgHealthLiveFeature());
    // Org Health (bridge): the CLI's audit/monitor snapshots via the local
    // bridge or native host (the `org-health` request kind). Distinct from the
    // live-query tool above; surfaces the governance snapshots the CLI produces.
    registry.register(createOrgHealthFeature());
    registry.register(createCodeCoverageFeature());
    registry.register(createRestExploreFeature());
    registry.register(createInspectRecordFeature());
    registry.register(createShowApiNamesFeature());
    registry.register(createDataImportFeature());
    registry.register(createFieldCreatorFeature());
    registry.register(createMetadataRetrieveFeature());
    registry.register(createSoapExploreFeature());
    registry.register(createEventMonitorFeature());
    registry.register(createExportForPromptFeature());
    registry.register(createApexAnonymousFeature());
    registry.register(createDebugLogViewerFeature());
    registry.register(createSavedSoqlFeature());
    registry.register(createOrgSwitcherFeature());

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
        console.warn('[SFDT] kill-switch refresh failed:', err);
      }
    }

    function makeGate() {
      return {
        disabledRemote,
        isUserEnabled: (id: string) => isFeatureEnabled(currentSettings, id),
      };
    }

    await refreshKillSwitch();

    const ICONS = FEATURE_ICONS;

    // Synthetic menu id — not a registered feature. Selecting it opens the
    // standalone Workspace tab rather than dispatching to the registry.
    const OPEN_WORKSPACE_ID = '__open-workspace__';

    const menuItemsProvider = (): MenuItem[] => {
      const available = getAvailableFeatures();
      // Always offer the Workspace first — it works on any Salesforce page.
      const items: MenuItem[] = [
        { featureId: OPEN_WORKSPACE_ID, icon: '↗', label: 'Open Workspace ↗' },
      ];
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
        onActivate: (item) => {
          if (item.featureId === OPEN_WORKSPACE_ID) {
            chrome.runtime.sendMessage(
              { action: 'openApp', org: window.location.hostname },
              () => void chrome.runtime.lastError,
            );
            return;
          }
          return registry.dispatch(item.featureId, item.action ?? 'activate');
        },
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

    console.log('[SFDT] Shell mounted with kill-switch enabled.');
  },
});
