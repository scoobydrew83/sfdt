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
import { isFeatureEnabled, SettingsSchema, type Settings } from '../lib/settings.js';
import { _knownFeatureDefaultIdsForTests } from '../lib/feature-defaults.js';

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
import { createFieldImpactFeature } from '../features/field-impact.js';
import { createShowApiNamesFeature } from '../features/show-api-names.js';
import { createDataImportFeature } from '../features/data-import.js';
import { createFieldCreatorFeature } from '../features/field-creator.js';
import { createMetadataRetrieveFeature } from '../features/metadata-retrieve.js';
import { createSoapExploreFeature } from '../features/soap-explore.js';
import { createEventMonitorFeature } from '../features/event-monitor.js';
import { createExportForPromptFeature } from '../features/export-for-prompt.js';
import { createApexAnonymousFeature } from '../features/apex-anonymous.js';
import { createDebugLogViewerFeature } from '../features/debug-log-viewer.js';
import { createTraceFlagsFeature } from '../features/trace-flags.js';
import { createSavedSoqlFeature } from '../features/saved-soql.js';
import { createOrgSwitcherFeature } from '../features/org-switcher.js';
import { createOrgReleaseBadgeFeature } from '../features/org-release-badge.js';
import { createApiVersionAuditFeature } from '../features/api-version-audit.js';
import { createCommandPaletteFeature } from '../features/command-palette.js';
// --- Background/options-only feature (entrypoints/background.ts + options) ---
import { createContextMenuInspectFeature } from '../features/context-menu-inspect.js';
import { createSoqlBulkDeleteFeature } from '../features/soql-bulk-delete.js';
// --- Workspace-only factories (entrypoints/app/main.ts) ---
import { createApexTestRunnerFeature } from '../features/apex-test-runner.js';
import { BRIDGE_REQUIRED } from '../lib/feature-defaults.js';
import {
  createDriftFeature,
  createScanFeature,
  createCompareFeature,
} from '../features/bridge-tools.js';

const MANIFESTS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../lib/feature-manifests.json',
);

// BRIDGE_REQUIRED moved to lib/feature-defaults.ts — the options page needs it
// to badge the feature list, and a test cannot be imported by the product.
// Still asserted against the JSON seed below, so the two cannot drift.

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
    createOrgHealthFeature(),
    createCodeCoverageFeature(),
    createRestExploreFeature(),
    createInspectRecordFeature(),
    createSchemaBrowserFeature(),
    createShowApiNamesFeature(),
    // field-impact (P4-4): one analysis surface driven by the Schema Browser's
    // per-field action and the Show API Names panel; also a Workspace tool.
    createFieldImpactFeature(),
    createDataImportFeature(),
    createFieldCreatorFeature(),
    createMetadataRetrieveFeature(),
    createSoapExploreFeature(),
    createEventMonitorFeature(),
    createExportForPromptFeature(),
    createApexAnonymousFeature(),
    createDebugLogViewerFeature(),
    createTraceFlagsFeature(),
    createSavedSoqlFeature(),
    createOrgSwitcherFeature(),
    // command-palette (P2-2): metadata-only overlay feature (no icon / side
    // button); opened imperatively from content.ts, kill-switchable like any other.
    createCommandPaletteFeature(),
    // soql-bulk-delete (C-P4-2): metadata-only kill switch + options toggle for
    // the SOQL runner's destructive result-toolbar action. Ships OFF — see the
    // SHIPS_OFF_BY_DESIGN allowlist below.
    createSoqlBulkDeleteFeature(),
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
      // Registry semantics: an omitted enabledByDefault means enabled. This is
      // the same `?? true` that lib/feature-defaults.ts applies at runtime, and
      // the "no existing feature ships off" suite below pins the two together.
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

// `enabledByDefault` became authoritative at runtime — before this, an absent
// stored preference meant "enabled" no matter what the manifest said. Honouring
// the flag is only behaviour-preserving for features that ship ON; these tests
// make the ships-OFF set an explicit, reviewed ALLOWLIST rather than an
// assumption, so a future `enabledByDefault: false` cannot silently switch a
// feature off for existing users without someone editing this list on purpose.
//
// Membership is a product decision, not a technical one: a feature belongs here
// only if shipping it on by default would do something the user did not ask
// for. Adding an id is a deliberate act, and reviewers should treat it as one.
const SHIPS_OFF_BY_DESIGN: readonly string[] = [
  // C-P4-2. Destructive and irreversible: it deletes org records in bulk. Every
  // other feature in the extension either reads, or writes something the user
  // typed into it. Opt-in is the whole point — see features/soql-bulk-delete.ts.
  'soql-bulk-delete',
];

describe('enabledByDefault is authoritative, and only the allowlisted features ship off', () => {
  const noStoredPreferences = SettingsSchema.parse({}) as Settings;
  const realManifests = instantiateAllFeatures().map((f) => f.manifest);
  const shipsOn = realManifests.filter((m) => !SHIPS_OFF_BY_DESIGN.includes(m.id));

  it('ships exactly the allowlisted features off by default', () => {
    const shipsOff = realManifests
      .filter((m) => m.enabledByDefault === false)
      .map((m) => m.id)
      .sort();
    expect(shipsOff).toEqual([...SHIPS_OFF_BY_DESIGN].sort());
  });

  it('resolves every allowlisted feature to DISABLED for a user with no stored preferences', () => {
    // The half that actually matters for C-P4-2: `enabledByDefault: false` in a
    // manifest is worthless if isFeatureEnabled() does not honour it. This is
    // the runtime assertion that the destructive feature is genuinely off out
    // of the box, seeded from the checked-in feature-manifests.json.
    for (const id of SHIPS_OFF_BY_DESIGN) {
      expect(isFeatureEnabled(noStoredPreferences, id)).toBe(false);
    }
  });

  it('resolves every other shipped feature to enabled for a user with no stored preferences', () => {
    const resolvedOff = shipsOn
      .map((m) => m.id)
      .filter((id) => !isFeatureEnabled(noStoredPreferences, id));
    expect(resolvedOff).toEqual([]);
  });

  it('covers every feature in the checked-in manifest JSON, not just a subset', () => {
    const jsonIds = (JSON.parse(readFileSync(MANIFESTS_PATH, 'utf8')) as ManifestEntry[]).map(
      (e) => e.id,
    );
    // Guards the test above against silently shrinking to zero features.
    expect(jsonIds.length).toBeGreaterThan(0);
    expect(new Set(realManifests.map((m) => m.id))).toEqual(new Set(jsonIds));
    for (const id of jsonIds) {
      expect(isFeatureEnabled(noStoredPreferences, id)).toBe(
        !SHIPS_OFF_BY_DESIGN.includes(id),
      );
    }
  });

  // Without this, the assertions above would still pass if the JSON seeding
  // broke entirely: an id with no recorded default falls back to enabled, so
  // "everything resolves enabled" is exactly what a dead lookup looks like.
  // Assert the defaults map really knows each shipped id.
  it('seeds a default for every shipped feature from the manifest JSON', () => {
    const known = new Set(_knownFeatureDefaultIdsForTests());
    const missing = realManifests.map((m) => m.id).filter((id) => !known.has(id));
    expect(missing).toEqual([]);
  });

  it('still lets a user disable any shipped feature', () => {
    for (const { id } of realManifests) {
      const off = SettingsSchema.parse({ features: { [id]: false } }) as Settings;
      expect(isFeatureEnabled(off, id)).toBe(false);
    }
  });
});
