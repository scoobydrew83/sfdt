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
  'rest-explore': { icon: '🛠', label: 'REST API Explorer' },
  'inspect-record': { icon: '🔍', label: 'Inspect Record (Show All Data)' },
  'data-import': { icon: '📥', label: 'Data Import Wizard' },
  'field-creator': { icon: '🛠', label: 'Bulk Field Creator' },
  'metadata-retrieve': { icon: '📦', label: 'Metadata Retrieve & Deploy' },
  'soap-explore': { icon: '💬', label: 'SOAP API Explorer' },
  'event-monitor': { icon: '📡', label: 'Event Streaming Monitor' },
  'export-for-prompt': { icon: '📋', label: 'Copy Schema for Prompt' },
  // Workspace-first tools (also surfaced on Salesforce pages where useful).
  'apex-anonymous': { icon: '⚡', label: 'Execute Anonymous Apex' },
  'debug-log-viewer': { icon: '🪵', label: 'Debug Logs' },
  'saved-soql': { icon: '⭐', label: 'Saved SOQL' },
  'org-switcher': { icon: '🏢', label: 'Switch Org' },
};

// Curated order of tools shown in the Workspace sidebar. The Workspace gives
// features a synthetic win that reports SETUP_OTHER, so getAvailableFeatures()
// would surface every Setup tool indiscriminately — this allowlist keeps the
// sidebar intentional. SOQL-first, then the new Workspace tools, then the rest.
export const WORKSPACE_TOOLS: readonly string[] = [
  'soql-runner',
  'saved-soql',
  'apex-anonymous',
  'debug-log-viewer',
  'rest-explore',
  'soap-explore',
  'inspect-record',
  'org-limits',
  'event-monitor',
  'data-import',
  'field-creator',
  'metadata-retrieve',
  'export-for-prompt',
];
