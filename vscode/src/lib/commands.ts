/**
 * Catalog of sfdt commands surfaced in the extension. Pure data so it can be
 * asserted in tests, rendered by the Commands tree, and searched by the palette
 * quick-pick. The extension layer maps each entry to a terminal invocation.
 *
 * Deliberately free of any `vscode` import — unit-testable in isolation.
 */

/** A doc category on https://sfdt.dev that a command group links to. */
const DOCS = {
  core: 'https://sfdt.dev/cli/commands/core',
  orgHealth: 'https://sfdt.dev/cli/commands/org-health',
  testing: 'https://sfdt.dev/cli/commands/testing-quality',
  ai: 'https://sfdt.dev/cli/commands/ai',
  metadata: 'https://sfdt.dev/cli/commands/metadata',
  configUtils: 'https://sfdt.dev/cli/commands/config-utils',
} as const;

export interface CommandEntry {
  id: string;
  label: string;
  detail: string;
  /** argv passed to the sfdt CLI. Omitted for non-CLI actions (see `action`). */
  args?: string[];
  /** When true, the command mutates the org/repo and should confirm first. */
  destructive?: boolean;
  /** When set, refresh the matching snapshot view after the command completes. */
  refreshes?: 'audit' | 'monitor' | 'scan' | 'drift';
  /** Non-terminal action handled by the extension (e.g. open the dashboard). */
  action?: 'dashboard';
  /** Docs page opened by "Open docs". Inherited from the group when unset. */
  docsUrl?: string;
  /** VS Code ThemeIcon id for the tree leaf. */
  icon?: string;
  /** Nested subcommands (each itself runnable). */
  children?: CommandEntry[];
}

export interface CommandGroup {
  id: string;
  label: string;
  icon: string;
  docsUrl: string;
  entries: CommandEntry[];
}

export const COMMAND_GROUPS: CommandGroup[] = [
  {
    id: 'deploy-release',
    label: 'Deploy & Release',
    icon: 'rocket',
    docsUrl: DOCS.core,
    entries: [
      { id: 'deploy', label: 'Deploy', detail: 'Deploy metadata to the org', args: ['deploy'], destructive: true, icon: 'cloud-upload' },
      { id: 'preflight', label: 'Preflight', detail: 'Run pre-deployment validation checks', args: ['preflight'], icon: 'checklist' },
      { id: 'rollback', label: 'Rollback', detail: 'Roll back the last deployment', args: ['rollback'], destructive: true, icon: 'discard' },
      { id: 'release', label: 'Release', detail: 'Build a release (manifest + notes)', args: ['release'], icon: 'tag' },
      { id: 'manifest', label: 'Manifest', detail: 'Generate package.xml from a git diff', args: ['manifest'], icon: 'list-tree' },
      { id: 'pr-description', label: 'PR Description', detail: 'Generate a pull-request description', args: ['pr-description'], icon: 'git-pull-request' },
      {
        id: 'changelog', label: 'Changelog', detail: 'Manage the CHANGELOG', icon: 'history',
        children: [
          { id: 'changelog-generate', label: 'Generate', detail: 'Generate changelog entries from git', args: ['changelog', 'generate'] },
          { id: 'changelog-release', label: 'Release', detail: 'Cut a changelog release section', args: ['changelog', 'release'] },
          { id: 'changelog-check', label: 'Check', detail: 'Verify the changelog is current', args: ['changelog', 'check'] },
        ],
      },
      { id: 'smoke', label: 'Smoke Test', detail: 'Run post-deploy smoke checks', args: ['smoke'], icon: 'flame' },
    ],
  },
  {
    id: 'org-health',
    label: 'Org Health',
    icon: 'pulse',
    docsUrl: DOCS.orgHealth,
    entries: [
      {
        id: 'audit', label: 'Org Audit', detail: 'Diagnose org health (read-only)', args: ['audit', 'all'], refreshes: 'audit', icon: 'shield',
        children: [
          { id: 'audit-all', label: 'All Checks', detail: 'Run every audit check', args: ['audit', 'all'], refreshes: 'audit' },
          { id: 'audit-audittrail', label: 'Setup Audit Trail', detail: 'Suspicious setup activity', args: ['audit', 'audittrail'], refreshes: 'audit' },
          { id: 'audit-licenses', label: 'License Usage', detail: 'Licenses near their limit', args: ['audit', 'licenses'], refreshes: 'audit' },
          { id: 'audit-mfa', label: 'MFA Coverage', detail: 'Users without MFA', args: ['audit', 'mfa'], refreshes: 'audit' },
          { id: 'audit-unused-apex', label: 'Unused Apex', detail: 'Apex classes with no coverage', args: ['audit', 'unused-apex'], refreshes: 'audit' },
          { id: 'audit-inactive-users', label: 'Inactive Users', detail: 'Users with no recent login', args: ['audit', 'inactive-users'], refreshes: 'audit' },
          { id: 'audit-api-versions', label: 'API Versions', detail: 'Deprecated metadata API versions', args: ['audit', 'api-versions'], refreshes: 'audit' },
        ],
      },
      {
        id: 'monitor', label: 'Org Monitor', detail: 'Limits, Apex failures, security score', args: ['monitor', 'all'], refreshes: 'monitor', icon: 'graph',
        children: [
          { id: 'monitor-all', label: 'All Checks', detail: 'Run every monitoring check', args: ['monitor', 'all'], refreshes: 'monitor' },
          { id: 'monitor-limits', label: 'Org Limits', detail: 'Org limits near threshold', args: ['monitor', 'limits'], refreshes: 'monitor' },
          { id: 'monitor-errors', label: 'Apex Job Failures', detail: 'Recent failed async Apex jobs', args: ['monitor', 'errors'], refreshes: 'monitor' },
          { id: 'monitor-health', label: 'Security Health Score', detail: 'Security Health Check score', args: ['monitor', 'health'], refreshes: 'monitor' },
        ],
      },
      { id: 'backup', label: 'Backup Metadata', detail: 'Retrieve a full metadata backup', args: ['monitor', 'backup'], destructive: true, icon: 'archive' },
      { id: 'scan', label: 'Scan Inventory', detail: 'Fetch the org metadata inventory', args: ['scan'], refreshes: 'scan', icon: 'search' },
      { id: 'drift', label: 'Detect Drift', detail: 'Compare local source against the org', args: ['drift'], refreshes: 'drift', icon: 'git-compare' },
      { id: 'doctor', label: 'Doctor', detail: 'Diagnose the sfdt/sf setup', args: ['doctor'], icon: 'verified' },
    ],
  },
  {
    id: 'quality',
    label: 'Quality & Analysis',
    icon: 'beaker',
    docsUrl: DOCS.testing,
    entries: [
      { id: 'quality', label: 'Quality Analysis', detail: 'Analyze Apex test quality', args: ['quality'], icon: 'beaker' },
      { id: 'test', label: 'Run Tests', detail: 'Run Apex tests', args: ['test'], icon: 'beaker' },
      { id: 'coverage', label: 'Code Coverage', detail: 'Report Apex code coverage (org-wide + per-class)', args: ['coverage'], icon: 'shield' },
      { id: 'dependencies', label: 'Dependencies', detail: 'Show metadata dependencies for a component', args: ['dependencies'], icon: 'references' },
      { id: 'review', label: 'Code Review', detail: 'AI review of the current diff', args: ['review'], icon: 'comment-discussion' },
      {
        id: 'flow', label: 'Flow Analysis', detail: 'Analyze Flows', icon: 'type-hierarchy',
        children: [
          { id: 'flow-scan', label: 'Scan', detail: 'Score Flow health', args: ['flow', 'scan'] },
          { id: 'flow-conflicts', label: 'Conflicts', detail: 'Find conflicting Flows per object', args: ['flow', 'conflicts'] },
        ],
      },
    ],
  },
  {
    id: 'documentation',
    label: 'Documentation',
    icon: 'book',
    docsUrl: DOCS.ai,
    entries: [
      {
        id: 'docs', label: 'Generate Docs', detail: 'Generate project documentation', icon: 'book',
        children: [
          { id: 'docs-generate', label: 'Generate', detail: 'Build the MkDocs documentation site', args: ['docs', 'generate'] },
          { id: 'docs-diagram', label: 'ER Diagram', detail: 'Build a Mermaid ER diagram', args: ['docs', 'diagram'] },
        ],
      },
      { id: 'explain', label: 'Explain', detail: 'Explain a class or flow (AI)', args: ['explain'], icon: 'lightbulb' },
      { id: 'compare', label: 'Compare', detail: 'Diff two orgs or org vs local', args: ['compare'], icon: 'diff' },
    ],
  },
  {
    id: 'data-scratch',
    label: 'Data & Scratch Orgs',
    icon: 'database',
    docsUrl: DOCS.configUtils,
    entries: [
      {
        id: 'data', label: 'Data Sets', detail: 'Manage data sets', icon: 'database',
        children: [
          { id: 'data-list', label: 'List', detail: 'List configured data sets', args: ['data', 'list'] },
          { id: 'data-export', label: 'Export', detail: 'Export a data set from the org', args: ['data', 'export'] },
          { id: 'data-import', label: 'Import', detail: 'Import a data set into the org', args: ['data', 'import'] },
          { id: 'data-delete', label: 'Delete', detail: 'Bulk-delete a data set in the org', args: ['data', 'delete'], destructive: true },
        ],
      },
      {
        id: 'scratch', label: 'Scratch Orgs', detail: 'Scratch-org lifecycle & pool', icon: 'server-environment',
        children: [
          { id: 'scratch-create', label: 'Create', detail: 'Create a scratch org', args: ['scratch', 'create'] },
          { id: 'scratch-list', label: 'List', detail: 'List scratch orgs', args: ['scratch', 'list'] },
          { id: 'scratch-delete', label: 'Delete', detail: 'Delete a scratch org', args: ['scratch', 'delete'], destructive: true },
          { id: 'scratch-pool-status', label: 'Pool: Status', detail: 'Show the scratch-org pool', args: ['scratch', 'pool', 'status'] },
          { id: 'scratch-pool-fill', label: 'Pool: Fill', detail: 'Top up the scratch-org pool', args: ['scratch', 'pool', 'fill'] },
        ],
      },
    ],
  },
  {
    id: 'project-tools',
    label: 'Project & Tools',
    icon: 'tools',
    docsUrl: DOCS.configUtils,
    entries: [
      { id: 'init', label: 'Initialize Project', detail: 'Create .sfdt config (sfdt init)', args: ['init'], icon: 'rocket' },
      { id: 'config', label: 'Show Config', detail: 'Print the resolved configuration', args: ['config'], icon: 'settings-gear' },
      { id: 'pull', label: 'Pull Metadata', detail: 'Retrieve metadata into the project', args: ['pull'], icon: 'cloud-download' },
      { id: 'dashboard', label: 'Open Dashboard', detail: 'Open the embedded sfdt dashboard', action: 'dashboard', icon: 'dashboard', docsUrl: 'https://sfdt.dev/cli/dashboard' },
      { id: 'mcp', label: 'Start MCP Server', detail: 'Start the stdio MCP server', args: ['mcp', 'start'], icon: 'server-process', docsUrl: 'https://sfdt.dev/cli/mcp' },
      {
        id: 'extension', label: 'Browser Extension', detail: 'Native messaging host & telemetry', icon: 'extensions',
        children: [
          { id: 'extension-status', label: 'Status', detail: 'Show native-host status', args: ['extension', 'status'] },
          { id: 'extension-stats', label: 'Stats', detail: 'Show extension telemetry', args: ['extension', 'stats'] },
        ],
      },
      { id: 'update', label: 'Check for Updates', detail: 'Check for a newer sfdt CLI', args: ['update'], icon: 'sync' },
    ],
  },
];

/** All runnable leaf entries (entries without children, plus all children). */
export function flattenCommands(groups: CommandGroup[] = COMMAND_GROUPS): CommandEntry[] {
  const out: CommandEntry[] = [];
  const walk = (entry: CommandEntry) => {
    if (entry.children && entry.children.length > 0) {
      entry.children.forEach(walk);
    } else {
      out.push(entry);
    }
  };
  groups.forEach((g) => g.entries.forEach(walk));
  return out;
}

/** Find any entry (group entry or nested child) by id. */
export function findCommand(id: string, groups: CommandGroup[] = COMMAND_GROUPS): CommandEntry | undefined {
  const search = (entry: CommandEntry): CommandEntry | undefined => {
    if (entry.id === id) return entry;
    for (const child of entry.children ?? []) {
      const hit = search(child);
      if (hit) return hit;
    }
    return undefined;
  };
  for (const group of groups) {
    for (const entry of group.entries) {
      const hit = search(entry);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Resolve the docs URL for an entry, inheriting from its group when unset. */
export function docsUrlFor(id: string, groups: CommandGroup[] = COMMAND_GROUPS): string | undefined {
  for (const group of groups) {
    const inGroup = (entry: CommandEntry): boolean =>
      entry.id === id || (entry.children ?? []).some(inGroup);
    if (group.entries.some(inGroup)) {
      return findCommand(id, groups)?.docsUrl ?? group.docsUrl;
    }
  }
  return undefined;
}

/** Backward-compatible flat list (used by the palette quick-pick). */
export const COMMAND_CATALOG: CommandEntry[] = flattenCommands();
