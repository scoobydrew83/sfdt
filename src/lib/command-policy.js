/**
 * COMMAND_POLICY — security and cross-surface intent for every top-level CLI
 * command. Commander (createCli) is the source of truth for what exists and
 * its flags; this map records what Commander cannot express:
 *
 * - mutating:        changes org/repo/machine state in a way that is not a
 *                    regenerable artifact (deploys, data loads, source pulls,
 *                    installs). Read-only analysis that writes regenerable
 *                    output files (manifest, docs, quality reports) is NOT
 *                    mutating. Additive external posts (notifications, PR
 *                    comments) are recorded in `sideEffects` instead.
 * - requiresProject: needs an initialized .sfdt project to run.
 * - requiresOrg:     needs a resolvable org (--org or defaultOrg) for its
 *                    primary path.
 * - supportsJson:    the command (or a subcommand) emits the sf-native
 *                    envelope via --json.
 * - docsCategory:    the sfdt.dev command-reference group.
 * - surfaces:        declared intent for non-CLI exposure. `cli` and
 *                    `sfPlugin` are implicit (every command; the plugin is
 *                    code-generated from this same Commander tree). `mcpTools`
 *                    maps the MCP tools that shell to this command; each is
 *                    classified mutating or not — a mutating MCP tool MUST
 *                    declare confirmExecution in its input schema (enforced by
 *                    test/command-policy.test.js).
 *
 * Enforced invariants (test/command-policy.test.js):
 * - every createCli() top-level command has exactly one entry here (and no
 *   entry is orphaned);
 * - every mcpTools name exists in mcp-server.js TOOLS, every TOOLS entry is
 *   claimed by exactly one command or listed in MCP_INTERNAL_TOOLS;
 * - every mcpTools entry with mutating:true has confirmExecution in its
 *   schema, and no non-mutating tool does;
 * - supportsJson matches the actual --json option on the command tree.
 *
 * tools/generate-catalogs.mjs merges this map into generated/commands.json
 * and generated/surface-parity.json.
 */

/** MCP tools that exist for the MCP transport itself, not a CLI command. */
export const MCP_INTERNAL_TOOLS = [
  'sfdt_logs', // reads log files directly
  'sfdt_get_parked_result', // retrieves a parked long-running result
];

export const COMMAND_POLICY = {
  init: {
    mutating: true, // writes .sfdt/ into the target project
    requiresProject: false,
    requiresOrg: false,
    supportsJson: false,
    docsCategory: 'core',
    surfaces: { gui: false, vscode: true, chrome: false },
    mcpTools: {},
  },
  deploy: {
    mutating: true,
    requiresProject: true,
    requiresOrg: true,
    supportsJson: false,
    docsCategory: 'core',
    surfaces: { gui: true, vscode: true, chrome: false },
    mcpTools: {
      sfdt_deploy: { mutating: true },
      sfdt_quick_deploy: { mutating: true },
      sfdt_validate: { mutating: false }, // validate-only dry run
    },
  },
  release: {
    mutating: true,
    requiresProject: true,
    requiresOrg: true,
    supportsJson: false,
    docsCategory: 'core',
    surfaces: { gui: true, vscode: true, chrome: false },
    mcpTools: { sfdt_release: { mutating: true } },
  },
  test: {
    mutating: false, // runs tests; no metadata/data change
    requiresProject: true,
    requiresOrg: true,
    supportsJson: false,
    docsCategory: 'testing-quality',
    surfaces: { gui: true, vscode: true, chrome: false },
    mcpTools: { sfdt_test: { mutating: false } },
  },
  'agent-test': {
    mutating: false,
    requiresProject: true,
    requiresOrg: true,
    supportsJson: false,
    docsCategory: 'testing-quality',
    surfaces: { gui: true, vscode: true, chrome: false },
    mcpTools: {},
  },
  pull: {
    mutating: true, // overwrites local source from the org
    requiresProject: true,
    requiresOrg: true,
    supportsJson: false,
    docsCategory: 'metadata',
    surfaces: { gui: false, vscode: true, chrome: false },
    mcpTools: {},
  },
  quality: {
    mutating: false,
    requiresProject: true,
    requiresOrg: false,
    supportsJson: true,
    docsCategory: 'testing-quality',
    surfaces: { gui: true, vscode: true, chrome: false },
    mcpTools: { sfdt_quality: { mutating: false } },
  },
  preflight: {
    mutating: false,
    requiresProject: true,
    requiresOrg: false,
    supportsJson: false,
    docsCategory: 'core',
    surfaces: { gui: true, vscode: true, chrome: false },
    mcpTools: { sfdt_preflight: { mutating: false } },
  },
  rollback: {
    mutating: true,
    requiresProject: true,
    requiresOrg: true,
    supportsJson: true,
    docsCategory: 'core',
    surfaces: { gui: true, vscode: true, chrome: false },
    mcpTools: { sfdt_rollback: { mutating: true } },
  },
  smoke: {
    mutating: false,
    requiresProject: true,
    requiresOrg: true,
    supportsJson: false,
    docsCategory: 'core',
    surfaces: { gui: false, vscode: true, chrome: false },
    mcpTools: {},
  },
  review: {
    mutating: false,
    requiresProject: true,
    requiresOrg: false,
    supportsJson: false,
    docsCategory: 'ai',
    surfaces: { gui: false, vscode: true, chrome: false },
    mcpTools: {},
  },
  notify: {
    mutating: false,
    sideEffects: 'sends notifications to configured channels',
    requiresProject: true,
    requiresOrg: false,
    supportsJson: false,
    docsCategory: 'org-health',
    surfaces: { gui: true, vscode: false, chrome: false },
    mcpTools: { sfdt_notify: { mutating: false } },
  },
  drift: {
    mutating: false,
    requiresProject: true,
    requiresOrg: true,
    supportsJson: true,
    docsCategory: 'metadata',
    surfaces: { gui: true, vscode: true, chrome: true },
    mcpTools: { sfdt_drift: { mutating: false } },
  },
  changelog: {
    mutating: true, // writes/releases changelog files
    requiresProject: true,
    requiresOrg: false,
    supportsJson: false,
    docsCategory: 'testing-quality',
    surfaces: { gui: false, vscode: true, chrome: false },
    mcpTools: {},
  },
  manifest: {
    mutating: false, // regenerable package.xml artifact
    requiresProject: true,
    requiresOrg: false,
    supportsJson: false,
    docsCategory: 'metadata',
    surfaces: { gui: false, vscode: true, chrome: false },
    mcpTools: { sfdt_manifest_from_git: { mutating: false } },
  },
  explain: {
    mutating: false,
    requiresProject: true,
    requiresOrg: false,
    supportsJson: false,
    docsCategory: 'ai',
    surfaces: { gui: false, vscode: true, chrome: false },
    mcpTools: {},
  },
  'pr-description': {
    mutating: false,
    requiresProject: true,
    requiresOrg: false,
    supportsJson: false,
    docsCategory: 'ai',
    surfaces: { gui: false, vscode: true, chrome: false },
    mcpTools: {},
  },
  ui: {
    mutating: false, // launches the local dashboard server
    requiresProject: true,
    requiresOrg: false,
    supportsJson: false,
    docsCategory: 'platform-bridge',
    surfaces: { gui: false, vscode: true, chrome: false },
    mcpTools: {},
  },
  compare: {
    mutating: false,
    requiresProject: true,
    requiresOrg: true,
    supportsJson: false,
    docsCategory: 'metadata',
    surfaces: { gui: true, vscode: true, chrome: true },
    mcpTools: { sfdt_compare: { mutating: false } },
  },
  completion: {
    mutating: false,
    requiresProject: false,
    requiresOrg: false,
    supportsJson: false,
    docsCategory: 'config-utils',
    surfaces: { gui: false, vscode: false, chrome: false },
    mcpTools: {},
  },
  update: {
    mutating: true, // updates the installed CLI
    requiresProject: false,
    requiresOrg: false,
    supportsJson: false,
    docsCategory: 'config-utils',
    surfaces: { gui: false, vscode: false, chrome: false },
    mcpTools: {},
  },
  config: {
    mutating: true, // `config set` writes .sfdt/config.json
    requiresProject: true,
    requiresOrg: false,
    supportsJson: false,
    docsCategory: 'config-utils',
    surfaces: { gui: true, vscode: false, chrome: false },
    mcpTools: {},
  },
  ai: {
    mutating: false,
    requiresProject: true,
    requiresOrg: false,
    supportsJson: false,
    docsCategory: 'ai',
    surfaces: { gui: true, vscode: false, chrome: false },
    mcpTools: {},
  },
  scan: {
    mutating: false,
    requiresProject: true,
    requiresOrg: true,
    supportsJson: true,
    docsCategory: 'metadata',
    surfaces: { gui: true, vscode: true, chrome: true },
    mcpTools: { sfdt_scan: { mutating: false } },
  },
  dependencies: {
    mutating: false,
    requiresProject: true,
    requiresOrg: true,
    supportsJson: true,
    docsCategory: 'metadata',
    surfaces: { gui: true, vscode: true, chrome: false },
    mcpTools: { sfdt_dependencies: { mutating: false } },
  },
  coverage: {
    mutating: false,
    requiresProject: true,
    requiresOrg: true,
    supportsJson: true,
    docsCategory: 'testing-quality',
    surfaces: { gui: true, vscode: true, chrome: false },
    mcpTools: { sfdt_coverage: { mutating: false } },
  },
  audit: {
    mutating: false,
    requiresProject: true,
    requiresOrg: true,
    supportsJson: true,
    docsCategory: 'org-health',
    surfaces: { gui: true, vscode: true, chrome: true },
    mcpTools: { sfdt_audit: { mutating: false } },
  },
  monitor: {
    mutating: false, // backup writes a regenerable local snapshot
    requiresProject: true,
    requiresOrg: true,
    supportsJson: true,
    docsCategory: 'org-health',
    surfaces: { gui: true, vscode: true, chrome: true },
    mcpTools: { sfdt_monitor: { mutating: false } },
  },
  docs: {
    mutating: false, // regenerable documentation output
    requiresProject: true,
    requiresOrg: false,
    supportsJson: true,
    docsCategory: 'org-health',
    surfaces: { gui: true, vscode: true, chrome: false },
    mcpTools: { sfdt_docs: { mutating: false } },
  },
  data: {
    mutating: true, // import/delete change org data
    requiresProject: true,
    requiresOrg: true,
    supportsJson: true,
    docsCategory: 'org-health',
    surfaces: { gui: true, vscode: false, chrome: false },
    mcpTools: {
      sfdt_data_export: { mutating: false },
      sfdt_data_import: { mutating: true },
      sfdt_data_delete: { mutating: true },
    },
  },
  scratch: {
    mutating: true, // creates/deletes orgs
    requiresProject: true,
    requiresOrg: false, // uses the Dev Hub, not a target org
    supportsJson: true,
    docsCategory: 'org-health',
    surfaces: { gui: true, vscode: false, chrome: false },
    mcpTools: {
      sfdt_scratch_create: { mutating: true },
      sfdt_scratch_delete: { mutating: true },
      sfdt_scratch_pool: { mutating: true },
    },
  },
  flow: {
    mutating: false,
    requiresProject: true,
    requiresOrg: true,
    supportsJson: true,
    docsCategory: 'metadata',
    surfaces: { gui: true, vscode: true, chrome: true },
    mcpTools: { sfdt_flow_scan: { mutating: false } },
  },
  extension: {
    mutating: true, // installs native-host manifests on the machine
    requiresProject: false,
    requiresOrg: false,
    supportsJson: true,
    docsCategory: 'platform-bridge',
    surfaces: { gui: false, vscode: false, chrome: true },
    mcpTools: {},
  },
  'feature-flags': {
    mutating: true, // writes the extension kill-switch state
    requiresProject: true,
    requiresOrg: false,
    supportsJson: true,
    docsCategory: 'platform-bridge',
    surfaces: { gui: false, vscode: false, chrome: true },
    mcpTools: {},
  },
  doctor: {
    mutating: false,
    requiresProject: false,
    requiresOrg: false,
    supportsJson: true,
    docsCategory: 'platform-bridge',
    surfaces: { gui: false, vscode: true, chrome: false },
    mcpTools: {},
  },
  mcp: {
    mutating: false, // starts/cleans the MCP server process
    requiresProject: true,
    requiresOrg: false,
    supportsJson: false,
    docsCategory: 'platform-bridge',
    surfaces: { gui: false, vscode: false, chrome: false },
    mcpTools: {},
  },
  plugin: {
    mutating: true, // scaffolds plugin files
    requiresProject: true,
    requiresOrg: false,
    supportsJson: false,
    docsCategory: 'platform-bridge',
    surfaces: { gui: false, vscode: false, chrome: false },
    mcpTools: {},
  },
  skills: {
    mutating: true, // writes exported skill files
    requiresProject: false,
    requiresOrg: false,
    supportsJson: true,
    docsCategory: 'platform-bridge',
    surfaces: { gui: false, vscode: false, chrome: false },
    mcpTools: {},
  },
  ci: {
    mutating: true, // writes a workflow file into the project
    requiresProject: true,
    requiresOrg: false,
    supportsJson: true,
    docsCategory: 'core',
    surfaces: { gui: false, vscode: true, chrome: false },
    mcpTools: {},
  },
  pr: {
    mutating: false,
    sideEffects: 'posts a comment on the current pull request',
    requiresProject: true,
    requiresOrg: false,
    supportsJson: true,
    docsCategory: 'core',
    surfaces: { gui: false, vscode: true, chrome: false },
    mcpTools: { sfdt_pr_comment: { mutating: false } },
  },
  retrofit: {
    mutating: true, // deploys to the target org when --execute
    requiresProject: true,
    requiresOrg: true,
    supportsJson: true,
    docsCategory: 'metadata',
    surfaces: { gui: true, vscode: false, chrome: false },
    mcpTools: { sfdt_retrofit: { mutating: true } },
  },
  history: {
    mutating: false,
    requiresProject: true,
    requiresOrg: false,
    supportsJson: true,
    docsCategory: 'org-health',
    surfaces: { gui: false, vscode: true, chrome: false },
    mcpTools: { sfdt_history: { mutating: false } },
  },
  version: {
    mutating: false,
    requiresProject: false,
    requiresOrg: false,
    supportsJson: false,
    docsCategory: 'config-utils',
    surfaces: { gui: false, vscode: false, chrome: false },
    mcpTools: {},
  },
  versions: {
    mutating: false,
    requiresProject: true,
    requiresOrg: false, // org side is optional; local scan always works
    supportsJson: true,
    docsCategory: 'org-health',
    surfaces: { gui: false, vscode: true, chrome: true }, // chrome = the org-side api-version-audit feature
    mcpTools: { sfdt_api_versions: { mutating: false } },
  },
};
