// Parity test for lib/feature-manifests.json — the browser-runtime-free,
// checked-in source of truth for feature metadata. It instantiates every
// feature exactly as the entrypoints do (entrypoints/content.ts registers 38;
// entrypoints/app/main.ts additionally registers the 4 Workspace-only tools:
// apex-test-runner + the three bridge tools; entrypoints/background.ts adds the
// worker-backed context-menu-inspect) and asserts the collected manifests match
// the JSON 1:1.
//
// To regenerate the JSON after adding/changing a feature:
//   SFDT_WRITE_MANIFESTS=1 npx vitest run test/feature-manifests.test.ts

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type { Feature } from '../lib/feature-registry.js';
import { FEATURE_ICONS, WORKSPACE_TOOLS } from '../lib/feature-icons.js';

// --- Factories, imported exactly as entrypoints/content.ts does ---
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
import { createSchemaBrowserFeature } from '../features/schema-browser.js';
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
import { createCommandPaletteFeature } from '../features/command-palette.js';
// --- Background/options-only feature (entrypoints/background.ts + options) ---
import { createContextMenuInspectFeature } from '../features/context-menu-inspect.js';
// --- Workspace-only factories (entrypoints/app/main.ts) ---
import { createApexTestRunnerFeature } from '../features/apex-test-runner.js';
import {
  createDriftFeature,
  createScanFeature,
  createCompareFeature,
} from '../features/bridge-tools.js';

const MANIFESTS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../lib/feature-manifests.json',
);

// Features that cannot function without the CLI bridge (`sfdt ui` running).
// Kept here (not derivable from the manifests) and baked into the JSON:
// - flow-deploy: deploy/rollback runs entirely through the bridge.
// - org-health: reads the CLI's audit/monitor snapshots via the bridge
//   (org-health-live is the no-bridge live-query counterpart).
// - drift-check / metadata-scan / org-compare: bridge-tools.ts — "dev-only:
//   they need `sfdt ui` running to answer the bridge".
// NOT listed: ai-assistant (metadata clean/summarise/copy works in-browser;
// only the optional AI run uses the bridge) and trigger-conflicts (conflict
// detection is a live Tooling query; only the rollback action uses the bridge).
const BRIDGE_REQUIRED = new Set([
  'flow-deploy',
  'org-health',
  'drift-check',
  'metadata-scan',
  'org-compare',
]);

// FEATURE_ICONS ids that are intentionally NOT registered features. Currently
// none — every icon id must correspond to a registered feature.
const ICON_ID_EXCEPTIONS: readonly string[] = [];

// Synthetic side-button menu id (entrypoints/content.ts) — never a feature.
const OPEN_WORKSPACE_ID = '__open-workspace__';

/** Instantiate every feature the extension registers, mirroring the entrypoints. */
function instantiateAllFeatures(): Feature[] {
  // content.ts wires the Flow Scanner's dependency rows into the Explorer.
  const depExplorer = createDependencyExplorerFeature();
  return [
    // entrypoints/content.ts, in registration order:
    createSetupTabsFeature(),
    createOrgReleaseBadgeFeature(),
    createApiVersionAuditFeature(),
    createCanvasSearchFeature(),
    createFlowListSearchFeature(),
    createFlowHealthCheckFeature(),
    depExplorer,
    createFlowQualityFeature({
      onExploreDependency: (dep) => void depExplorer.openFor(dep.type, dep.name),
    }),
    createMissingDescriptionFlagsFeature(),
    createFlowVersionManagerFeature(),
    createAiAssistantFeature(),
    createScheduledFlowExplorerFeature(),
    createApiNameGeneratorFeature(),
    createComparisonExporterFeature(),
    createFlowTriggerExplorerEnhancerFeature(),
    createTriggerConflictsFeature(),
    createSubflowGraphFeature(),
    createFlowDeployFeature(),
    createSoqlRunnerFeature(),
    createOrgLimitsFeature(),
    createOrgHealthLiveFeature(),
    createOrgHealthFeature(),
    createCodeCoverageFeature(),
    createRestExploreFeature(),
    createInspectRecordFeature(),
    createSchemaBrowserFeature(),
    createShowApiNamesFeature(),
    createDataImportFeature(),
    createFieldCreatorFeature(),
    createMetadataRetrieveFeature(),
    createSoapExploreFeature(),
    createEventMonitorFeature(),
    createExportForPromptFeature(),
    createApexAnonymousFeature(),
    createDebugLogViewerFeature(),
    createSavedSoqlFeature(),
    createOrgSwitcherFeature(),
    // command-palette (P2-2): metadata-only overlay feature (no icon / side
    // button); opened imperatively from content.ts, kill-switchable like any other.
    createCommandPaletteFeature(),
    // context-menu-inspect (P1-8): a worker-backed feature — its "Inspect this
    // record" menu lives in entrypoints/background.ts and its toggle in the
    // options page; it injects no content-script UI (no icon, no side button).
    createContextMenuInspectFeature(),
    // entrypoints/app/main.ts additionally registers these Workspace-only
    // tools (all options default; main.ts only injects doc/win/api):
    createApexTestRunnerFeature(),
    createDriftFeature(),
    createScanFeature(),
    createCompareFeature(),
  ];
}

interface ManifestEntry {
  id: string;
  name: string;
  contexts: string[];
  enabledByDefault: boolean;
  workspace: boolean;
  sideButton: boolean;
  bridgeRequired: boolean;
}

function collectEntries(): ManifestEntry[] {
  const features = instantiateAllFeatures();
  return features
    .map(({ manifest }) => ({
      id: manifest.id,
      name: manifest.name,
      contexts: [...manifest.contexts],
      // Registry semantics: an omitted enabledByDefault means enabled —
      // settings.ts isFeatureEnabled() returns true without an explicit entry.
      enabledByDefault: manifest.enabledByDefault ?? true,
      workspace: WORKSPACE_TOOLS.includes(manifest.id),
      sideButton: Object.prototype.hasOwnProperty.call(FEATURE_ICONS, manifest.id),
      bridgeRequired: BRIDGE_REQUIRED.has(manifest.id),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

describe('feature-manifests.json parity', () => {
  const computed = collectEntries();
  const computedIds = new Set(computed.map((e) => e.id));

  it('collects a unique id per registered feature', () => {
    expect(computedIds.size).toBe(computed.length);
  });

  it(`never includes the synthetic ${OPEN_WORKSPACE_ID} menu id`, () => {
    expect(computedIds.has(OPEN_WORKSPACE_ID)).toBe(false);
  });

  it('every FEATURE_ICONS id is a registered feature id', () => {
    const unknown = Object.keys(FEATURE_ICONS).filter(
      (id) => !computedIds.has(id) && !ICON_ID_EXCEPTIONS.includes(id),
    );
    expect(unknown).toEqual([]);
  });

  it('every WORKSPACE_TOOLS id is a registered feature id', () => {
    const unknown = WORKSPACE_TOOLS.filter((id) => !computedIds.has(id));
    expect(unknown).toEqual([]);
  });

  if (process.env.SFDT_WRITE_MANIFESTS === '1') {
    it('regenerates lib/feature-manifests.json (SFDT_WRITE_MANIFESTS=1)', () => {
      writeFileSync(MANIFESTS_PATH, `${JSON.stringify(computed, null, 2)}\n`);
      expect(computed.length).toBeGreaterThan(0);
    });
    return;
  }

  const checkedIn = JSON.parse(readFileSync(MANIFESTS_PATH, 'utf8')) as ManifestEntry[];

  it('the checked-in JSON never includes the synthetic menu id', () => {
    expect(checkedIn.some((e) => e.id === OPEN_WORKSPACE_ID)).toBe(false);
  });

  it('matches the real manifests 1:1 (same id set; per id: name, contexts, enabledByDefault, workspace, sideButton, bridgeRequired; sorted by id)', () => {
    expect(checkedIn).toEqual(computed);
  });
});
