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
  /**
   * When true, `args` is a prefix the user must complete (required positional
   * arguments, e.g. `config get <key>`). The extension types the command into
   * the integrated terminal without executing it so the user appends the rest.
   */
  argsIncomplete?: boolean;
  /** When true, the command mutates the org/repo and should confirm first. */
  destructive?: boolean;
  /**
   * When true, the CLI command accepts no `--org` flag, so the extension must
   * NOT append the configured `sfdt.defaultOrg` (Commander rejects unknown
   * options with exit 1). Applies to project-local commands like `doctor`,
   * `init`, and `feature-flags`.
   */
  noOrg?: boolean;
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
      { id: 'deploy-smart', label: 'Smart Deploy (validate)', detail: 'Delta validate-only deploy with smart test selection', args: ['deploy', '--smart', '--dry-run'], icon: 'cloud-upload' },
      { id: 'retrofit', label: 'Retrofit', detail: 'Retrieve from a source org, commit, and smart-deploy to a target', args: ['retrofit'], icon: 'sync' },
      { id: 'pr-comment', label: 'PR Comment (monitor)', detail: 'Post the latest monitor snapshot to the current PR', args: ['pr', 'comment', '--type', 'monitor'], icon: 'comment' },
      { id: 'preflight', label: 'Preflight', detail: 'Run pre-deployment validation checks', args: ['preflight'], noOrg: true, icon: 'checklist' },
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
          { id: 'audit-inactive-flows', label: 'Inactive Flows', detail: 'Flows with no active version', args: ['audit', 'inactive-flows'], refreshes: 'audit' },
          { id: 'audit-unused-permsets', label: 'Unused Permission Sets', detail: 'Permission sets with no assignment', args: ['audit', 'unused-permsets'], refreshes: 'audit' },
          { id: 'audit-connected-apps', label: 'Connected Apps', detail: 'Connected apps permitting all users', args: ['audit', 'connected-apps'], refreshes: 'audit' },
          { id: 'audit-field-descriptions', label: 'Field Descriptions', detail: 'Custom fields missing descriptions', args: ['audit', 'field-descriptions'], refreshes: 'audit' },
          { id: 'audit-apex-unreferenced', label: 'Unreferenced Apex', detail: 'Apex with no inbound dependencies', args: ['audit', 'apex-unreferenced'], refreshes: 'audit' },
          { id: 'audit-lint-access', label: 'Object Access', detail: 'Custom objects with no Read access', args: ['audit', 'lint-access'], refreshes: 'audit' },
          { id: 'audit-lint-access-fields', label: 'Field Access', detail: 'Custom fields with no Read access', args: ['audit', 'lint-access-fields'], refreshes: 'audit' },
          { id: 'audit-inactive-validations', label: 'Inactive Validation Rules', detail: 'Validation rules that are not active', args: ['audit', 'inactive-validations'], refreshes: 'audit' },
          { id: 'audit-inactive-workflows', label: 'Inactive Workflow Rules', detail: 'Workflow rules that are not active', args: ['audit', 'inactive-workflows'], refreshes: 'audit' },
        ],
      },
      {
        id: 'monitor', label: 'Org Monitor', detail: 'Limits, Apex failures, security score', args: ['monitor', 'all'], refreshes: 'monitor', icon: 'graph',
        children: [
          { id: 'monitor-all', label: 'All Checks', detail: 'Run every monitoring check', args: ['monitor', 'all'], refreshes: 'monitor' },
          { id: 'monitor-limits', label: 'Org Limits', detail: 'Org limits near threshold', args: ['monitor', 'limits'], refreshes: 'monitor' },
          { id: 'monitor-errors', label: 'Apex Job Failures', detail: 'Recent failed async Apex jobs', args: ['monitor', 'errors'], refreshes: 'monitor' },
          { id: 'monitor-health', label: 'Security Health Score', detail: 'Security Health Check score', args: ['monitor', 'health'], refreshes: 'monitor' },
          { id: 'monitor-org-info', label: 'Org Info', detail: 'Instance, edition, trial expiry', args: ['monitor', 'org-info'], refreshes: 'monitor' },
          { id: 'monitor-deploy-history', label: 'Deployment History', detail: 'Recent deployment success/failure', args: ['monitor', 'deploy-history'], refreshes: 'monitor' },
          { id: 'monitor-deprecated-api', label: 'Legacy API Usage', detail: 'Traffic on deprecated API versions', args: ['monitor', 'deprecated-api'], refreshes: 'monitor' },
          { id: 'monitor-flow-errors', label: 'Paused Flows', detail: 'Paused (stuck) flow interviews', args: ['monitor', 'flow-errors'], refreshes: 'monitor' },
          { id: 'monitor-schedule', label: 'Schedule (CI workflow)', detail: 'Generate a scheduled org-monitoring CI workflow', args: ['monitor', 'schedule'] },
        ],
      },
      { id: 'notify-monitor', label: 'Send Org Health to Notifications', detail: 'Push the latest monitor snapshot to configured channels', args: ['notify', 'snapshot', '--type', 'monitor'], icon: 'bell' },
      { id: 'notify', label: 'Send Notification (event)', detail: 'Send a lifecycle event to configured channels: deploy-success | deploy-failure | test-failure | release-created | snapshot', args: ['notify'], argsIncomplete: true, icon: 'bell' },
      { id: 'backup', label: 'Backup Metadata', detail: 'Retrieve a full metadata backup', args: ['monitor', 'backup'], destructive: true, icon: 'archive' },
      { id: 'scan', label: 'Scan Inventory', detail: 'Fetch the org metadata inventory', args: ['scan'], refreshes: 'scan', icon: 'search' },
      { id: 'drift', label: 'Detect Drift', detail: 'Compare local source against the org', args: ['drift'], refreshes: 'drift', icon: 'git-compare' },
      { id: 'doctor', label: 'Doctor', detail: 'Diagnose the browser-extension bridge stack (expects `sfdt ui` to be running)', args: ['doctor'], noOrg: true, icon: 'verified' },
    ],
  },
  {
    id: 'quality',
    label: 'Quality & Analysis',
    icon: 'beaker',
    docsUrl: DOCS.testing,
    entries: [
      { id: 'quality', label: 'Quality Analysis', detail: 'Analyze Apex test quality', args: ['quality'], noOrg: true, icon: 'beaker' },
      { id: 'test', label: 'Run Tests', detail: 'Run Apex tests', args: ['test'], icon: 'beaker' },
      { id: 'agent-test', label: 'Agent Test (Agentforce)', detail: 'Run an Agentforce agent test as a CI gate (sf agent test run) — append the AiEvaluationDefinition API name', args: ['agent-test', '--spec'], argsIncomplete: true, icon: 'hubot' },
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
      { id: 'ai-prompt', label: 'AI Prompt', detail: 'Run a free-form prompt through the configured AI provider', args: ['ai', 'prompt'], argsIncomplete: true, icon: 'sparkle' },
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
      { id: 'init', label: 'Initialize Project', detail: 'Create .sfdt config (sfdt init)', args: ['init'], noOrg: true, icon: 'rocket' },
      {
        id: 'config', label: 'Config', detail: 'Read and write .sfdt config values', icon: 'settings-gear',
        children: [
          { id: 'config-get', label: 'Get', detail: 'Print a config value by dot-notation key (e.g. defaultOrg)', args: ['config', 'get'], argsIncomplete: true },
          { id: 'config-set', label: 'Set', detail: 'Set a config value by dot-notation key (e.g. deployment.coverageThreshold 80)', args: ['config', 'set'], argsIncomplete: true },
        ],
      },
      {
        id: 'feature-flags', label: 'Feature Flags', detail: 'Kill-switch for sfdt feature ids (.sfdt/feature-flags.json)', icon: 'symbol-boolean',
        children: [
          { id: 'feature-flags-list', label: 'List', detail: 'List currently disabled feature ids', args: ['feature-flags', 'list'], noOrg: true },
          { id: 'feature-flags-disable', label: 'Disable', detail: 'Add a feature id to the disabled list', args: ['feature-flags', 'disable'], argsIncomplete: true },
          { id: 'feature-flags-enable', label: 'Enable', detail: 'Remove a feature id from the disabled list', args: ['feature-flags', 'enable'], argsIncomplete: true },
          { id: 'feature-flags-clear', label: 'Clear', detail: 'Re-enable everything (empties the disabled list)', args: ['feature-flags', 'clear'], noOrg: true },
        ],
      },
      {
        id: 'ci', label: 'CI Templates', detail: 'Generate ready-to-use CI/CD pipeline workflows', icon: 'circuit-board',
        children: [
          { id: 'ci-init-github-monitor', label: 'GitHub · Monitor', detail: 'Scheduled org-monitoring workflow for GitHub Actions', args: ['ci', 'init', '--provider', 'github', '--type', 'monitor'] },
          { id: 'ci-init-github-deploy', label: 'GitHub · Deploy', detail: 'PR smart-deploy workflow for GitHub Actions', args: ['ci', 'init', '--provider', 'github', '--type', 'deploy'] },
          { id: 'ci-init-gitlab-monitor', label: 'GitLab · Monitor', detail: 'Scheduled org-monitoring pipeline for GitLab CI', args: ['ci', 'init', '--provider', 'gitlab', '--type', 'monitor'] },
          { id: 'ci-init-gitlab-deploy', label: 'GitLab · Deploy', detail: 'MR smart-deploy pipeline for GitLab CI', args: ['ci', 'init', '--provider', 'gitlab', '--type', 'deploy'] },
          { id: 'ci-init-azure-monitor', label: 'Azure · Monitor', detail: 'Scheduled org-monitoring pipeline for Azure DevOps', args: ['ci', 'init', '--provider', 'azure', '--type', 'monitor'] },
          { id: 'ci-init-azure-deploy', label: 'Azure · Deploy', detail: 'PR smart-deploy pipeline for Azure DevOps', args: ['ci', 'init', '--provider', 'azure', '--type', 'deploy'] },
          { id: 'ci-init-bitbucket-monitor', label: 'Bitbucket · Monitor', detail: 'Scheduled org-monitoring pipeline for Bitbucket Pipelines', args: ['ci', 'init', '--provider', 'bitbucket', '--type', 'monitor'] },
          { id: 'ci-init-bitbucket-deploy', label: 'Bitbucket · Deploy', detail: 'PR smart-deploy pipeline for Bitbucket Pipelines', args: ['ci', 'init', '--provider', 'bitbucket', '--type', 'deploy'] },
        ],
      },
      { id: 'pull', label: 'Pull Metadata', detail: 'Retrieve metadata into the project', args: ['pull'], icon: 'cloud-download' },
      { id: 'dashboard', label: 'Open Dashboard', detail: 'Open the embedded sfdt dashboard', action: 'dashboard', icon: 'dashboard', docsUrl: 'https://sfdt.dev/cli/dashboard' },
      { id: 'mcp', label: 'Start MCP Server', detail: 'Start the stdio MCP server', args: ['mcp', 'start'], icon: 'server-process', docsUrl: 'https://sfdt.dev/cli/mcp' },
      {
        id: 'extension', label: 'Browser Extension', detail: 'Native messaging host & telemetry', icon: 'extensions',
        children: [
          { id: 'extension-status', label: 'Status', detail: 'Show native-host status', args: ['extension', 'status'] },
          { id: 'extension-stats', label: 'Stats', detail: 'Show extension telemetry', args: ['extension', 'stats'] },
          { id: 'extension-install-host', label: 'Install Host', detail: 'Register the native messaging host — append --extension-id <id>', args: ['extension', 'install-host', '--extension-id'], argsIncomplete: true, noOrg: true },
          { id: 'extension-uninstall-host', label: 'Uninstall Host', detail: 'Remove the native messaging host manifest', args: ['extension', 'uninstall-host'], noOrg: true },
        ],
      },
      {
        id: 'skills', label: 'Agent Skills', detail: 'Export SFDT agent skills to IDE/agent configs', icon: 'lightbulb-sparkle',
        children: [
          { id: 'skills-claude', label: 'Export → Claude', detail: 'Write Claude rules files', args: ['skills', 'export', '--target', 'claude'], noOrg: true },
          { id: 'skills-cursor', label: 'Export → Cursor', detail: 'Write .cursorrules', args: ['skills', 'export', '--target', 'cursor'], noOrg: true },
          { id: 'skills-codex', label: 'Export → Codex', detail: 'Write .codexrules', args: ['skills', 'export', '--target', 'codex'], noOrg: true },
          { id: 'skills-windsurf', label: 'Export → Windsurf', detail: 'Write .windsurfrules', args: ['skills', 'export', '--target', 'windsurf'], noOrg: true },
          { id: 'skills-pack', label: 'Export → npx-skills pack', detail: 'Emit an `npx skills add`-compatible pack', args: ['skills', 'export', '--target', 'pack'], noOrg: true },
        ],
      },
      { id: 'plugin-create', label: 'Create Plugin', detail: 'Scaffold a new sfdt CLI plugin — append a name', args: ['plugin', 'create'], argsIncomplete: true, noOrg: true, icon: 'plug' },
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
