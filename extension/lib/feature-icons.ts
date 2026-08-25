// Single source of truth for feature display metadata (icon + label), shared by
// the content-script side button (entrypoints/content.ts) and the standalone
// Workspace shell (entrypoints/app/main.ts). Keeping it here avoids the two
// surfaces drifting apart as features are added.

export interface FeatureIcon {
  icon: string;
  label: string;
}

export const FEATURE_ICONS: Record<string, FeatureIcon> = {
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
  'org-health': { icon: '🏥', label: 'Org Health' },
  'api-version-audit': { icon: '📶', label: 'API Version Audit' },
  'rest-explore': { icon: '🛠', label: 'REST API Explorer' },
  'inspect-record': { icon: '🔍', label: 'Inspect Record (Show All Data)' },
  'schema-browser': { icon: '🗃', label: 'Schema Browser' },
  'field-impact': { icon: '✍️', label: 'Field Impact Analysis' },
  'show-api-names': { icon: '🏷️', label: 'Show API Names' },
  'data-import': { icon: '📥', label: 'Data Import Wizard' },
  'field-creator': { icon: '🛠', label: 'Bulk Field Creator' },
  'metadata-retrieve': { icon: '📦', label: 'Metadata Retrieve & Deploy' },
  'deploy-status': { icon: '🚀', label: 'Deployment Status' },
  'soap-explore': { icon: '💬', label: 'SOAP API Explorer' },
  'event-monitor': { icon: '📡', label: 'Event Streaming Monitor' },
  'export-for-prompt': { icon: '📋', label: 'Copy Schema for Prompt' },
  // Workspace-first tools (also surfaced on Salesforce pages where useful).
  'apex-anonymous': { icon: '⚡', label: 'Execute Anonymous Apex' },
  'debug-log-viewer': { icon: '🪵', label: 'Debug Logs' },
  'trace-flags': { icon: '⚑', label: 'Trace Flags' },
  'saved-soql': { icon: '⭐', label: 'Saved SOQL' },
  'org-switcher': { icon: '🏢', label: 'Switch Org' },
  'apex-coverage': { icon: '📈', label: 'Apex Coverage' },
  'dependency-explorer': { icon: '🔗', label: 'Dependency Explorer' },
  'apex-test-runner': { icon: '🧪', label: 'Apex Test Runner' },
  // Bridge-backed tools (need `sfdt ui` running, like flow-deploy).
  'flow-quality': { icon: '✅', label: 'Flow Quality Scan' },
  'drift-check': { icon: '🌊', label: 'Drift Check' },
  'metadata-scan': { icon: '🔬', label: 'Metadata Scan' },
  'org-compare': { icon: '🔀', label: 'Org Compare' },
};

// Curated order of tools shown in the Workspace sidebar. The Workspace gives
// features a synthetic win that reports SETUP_OTHER, so getAvailableFeatures()
// would surface every Setup tool indiscriminately — this allowlist keeps the
// sidebar intentional. SOQL-first, then the new Workspace tools, then the rest.
// NOT here: 'inspect-record'. It is reached in the Workspace from a SOQL result
// row's Id menu — you inspect a record you just found, you do not open an empty
// inspector and go looking for one. The popup keeps it, because there the
// starting point IS a record: the tab you are on. Membership in this list is a
// curation call about how a tool is REACHED, not whether it works.
export const WORKSPACE_TOOLS: readonly string[] = [
  'soql-runner',
  'saved-soql',
  'apex-anonymous',
  'debug-log-viewer',
  'trace-flags',
  'rest-explore',
  'soap-explore',
  'schema-browser',
  'field-impact',
  'apex-coverage',
  'apex-test-runner',
  'org-health',
  'dependency-explorer',
  'flow-quality',
  'drift-check',
  'metadata-scan',
  'org-compare',
  'org-limits',
  'event-monitor',
  'data-import',
  'field-creator',
  'metadata-retrieve',
  'deploy-status',
  'export-for-prompt',
];

/**
 * The tools the Workspace sidebar shows without being asked. Everything else in
 * WORKSPACE_TOOLS lives behind the "All tools" disclosure.
 *
 * Twenty-five entries in a flat list is a wall of text, not navigation — you
 * can't scan it, so you fall back to hunting. This is the everyday set; the
 * Recent section above it covers "the thing I was just doing", and the
 * disclosure covers the rest. Order is deliberate (query → run → inspect →
 * ship), not alphabetical.
 *
 * Membership is a curation call, not a capability one: a tool being absent here
 * says nothing about whether it works. Adding one is cheap; the cost of adding
 * every one is the wall of text this exists to prevent.
 */
export const WORKSPACE_PRIMARY: readonly string[] = [
  'soql-runner',
  'apex-anonymous',
  'debug-log-viewer',
  'schema-browser',
  'rest-explore',
  'metadata-retrieve',
];
