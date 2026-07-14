# CLAUDE.md — sfdt CLI

## Project Overview

This is `@sfdt/cli`, a Node.js ESM CLI package for Salesforce DX deployment, testing, quality analysis, and release management. It is a **generic tool** — it works with any Salesforce DX project and contains no project-specific values.

## Architecture

- **CLI framework**: Commander.js for command routing
- **Shell execution**: execa for running shell scripts and sf CLI commands
- **Module system**: ESM (`"type": "module"` in package.json)
- **Entry point**: `bin/sfdt.js`

### Directory Structure

```
bin/            CLI entry point (loads plugins, then parses args)
src/
  commands/     Command modules (one file per command)
  lib/          Shared libraries (config, output, AI, script-runner, project-detect, metadata-mapper, plugin-loader, gui-server,
                org-query, audit-runner, monitor-runner, doc-generator, data-runner, scratch-pool,
                check-status, notifier, notifier-formatters, smart-deploy, agent-loop)
scripts/        Shell scripts executed by commands (de-parameterized, use SFDT_ env vars)
                Exception: scripts/postinstall.js is a Node.js ESM file run by npm on install
test/           Tests (vitest)
gui/            React + Vite web dashboard (sfdt ui); built output lives in gui/dist/
vscode/         VS Code extension (@sfdt/vscode); thin UI over the CLI, esbuild-bundled to vscode/dist/
packages/       Published npm sub-packages (workspaces)
  flow-core/    Pure-TS Flow-analysis core (@sfdt/flow-core)
  plugin/       Salesforce CLI (sf) plugin (@sfdt/plugin); thin oclif wrapper exposing `sf sfdt <command>`
Dockerfile      Official Docker image definition
.sfdt/          Per-project config directory (created by `sfdt init` in target projects)
  plugins/      Optional local JS plugins loaded automatically at startup
```

### Key Patterns

- **Commands** in `src/commands/` export a function that receives the Commander program and registers a subcommand.
- **Shell scripts** in `scripts/` are de-parameterized — they read configuration from `SFDT_` prefixed environment variables, not from positional arguments. The `script-runner.js` lib handles setting these vars and invoking scripts. `scripts/postinstall.js` is an exception — it is a Node.js ESM script invoked by npm's `postinstall` lifecycle hook, not by `script-runner.js`.
- **Config system** uses a `.sfdt/` directory created per-project. Config is loaded by `src/lib/config.js`. At load time, config is enriched with values from `sfdx-project.json` (e.g. `sourceApiVersion`, `defaultSourcePath` derived from `packageDirectories`).
- **AI features** are optional and gated behind `features.ai` in config. The provider is selected by `ai.provider` (`claude` | `gemini` | `openai` | `http`). Claude requires the Claude Code CLI; Gemini requires the Gemini CLI; OpenAI uses the Codex CLI; `http` is a generic OpenAI-compatible HTTP backend (Ollama, OpenRouter, MiniMax, or any `/chat/completions` gateway) configured via `ai.baseURL`, `ai.model`, and `ai.apiKeyEnv` (the **name** of the env var holding the key — the key itself is never stored in config). Use `isAiAvailable(config)` / `aiUnavailableMessage(config)` from `src/lib/ai.js` instead of the legacy `isClaudeAvailable()`. The three CLI providers run as local agentic subprocesses (read-only sandbox enforced by CLI flags); the `http` provider is plain text-completion via native `fetch` and **cannot run tools** — so agentic commands (`changelog generate`, `release` notes, `test` analysis) pre-gather context via `src/lib/ai-context.js` (`gatherGitLog`, `gatherLatestTestResults`, `frameProvidedContext`) gated on `providerSupportsAgenticTools(config)`, and the command writes any output files itself. Security caveat: with `http`, prompt content (diffs, git logs) is sent to the configured endpoint — `redactSensitiveData` is applied to every payload.
- **Plugin system** (`src/lib/plugin-loader.js`) runs before argument parsing. Plugins are loaded from: (1) `config.plugins[]` package names, (2) `sfdt-plugin-*` packages auto-discovered in the project's `node_modules/`, (3) `.sfdt/plugins/*.js` local files. Each plugin exports `register(program)`.
- **Web UI** (`src/commands/ui.js` + `src/lib/gui-server.js`) starts a local Express server on port 7654 serving a pre-built React/SLDS dashboard from `gui/dist/`. Build with `npm run build:gui`.
- **File matching** uses the `glob` package (v11) for pattern-based file discovery.
- **Metadata mapping** (`src/lib/metadata-mapper.js`) provides a pure-JS mirror of `scripts/lib/metadata-parser.sh` for use in Node commands. Used by `manifest` and `pr-description`.
- **Org health commands** (`audit`, `monitor`) are native clean-room reimplementations of the sfdx-hardis diagnose/monitor feature set (no AGPL dependency). Each thin command delegates to a `*-runner.js` whose checks query the org via `src/lib/org-query.js` (a SOQL helper over `sf data query --json`, with a `--use-tooling-api` toggle) and return a normalised `{ id, title, status, summary, findings }` shape. The runner writes a snapshot (`logs/audit-latest.json`, `logs/monitor-latest.json`) consumed by the GUI (`/api/audit`, `/api/monitor`), MCP (`sfdt_audit`, `sfdt_monitor`), and the VS Code extension. Check-threshold defaults live in `AUDIT_DEFAULTS` / `MONITOR_DEFAULTS` constants and mirror the `audit`/`monitoring` blocks in `src/templates/sfdt.config.json` (the canonical user-editable source). `docs` (doc-generator), `data` (data-runner), and `scratch` (scratch-pool) follow the same thin-command/runner split. The doc-generator parses objects, Apex, Flows, and LWC bundles into MkDocs markdown; `docs generate --roles [list]` additionally emits per-component, AI-authored role guides (Developer/Admin/User/DevOps) under `docs/guides/<type>/<component>/<role>.md`, driven by the editable `doc-role-guide` prompt (with optional per-type overrides `doc-apex`/`doc-flow`/`doc-lwc`/`doc-object`) and gated on `config.features.ai` + `config.docs.roleGuides`/`docs.roles`. The audit/monitor runners cover ~25 checks (incl. `inactive-validations`/`inactive-workflows` via Tooling `ValidationRule.Active`/`WorkflowRule`, and `lint-access-fields` field-level FLS via `FieldPermissions`); both `audit all` and `monitor all` accept `--notify` to push the snapshot through the notifier. Beta/license-gated checks (MetadataComponentDependency, DeployRequest, FlowInterview, ConnectedApplication, ValidationRule/WorkflowRule) degrade to `warn` (never `error`) when the org can't run them, so `audit all`/`monitor all` don't fail CI over a missing API.
- **Run history** (`src/lib/run-history.js` + `src/lib/log-writer.js`): a durable, queryable index of runs so org-health/coverage/deploy outcomes can be trended, not just the latest snapshot. `run-history.js` uses `node:sqlite` (`DatabaseSync`, same as `pull-cache.js`) to keep `logs/history.db` with a compact `runs` row per run (`type`, `timestamp`, `org`, `exit_code`, `duration_ms`, `status`, small `summary` JSON), pruned to 200 rows/type. `recordRun(logDir, {...})` is **best-effort** — it never throws, so a history failure can't fail the command. It's hooked into `writeLog`/`writeRawLog` (covers preflight/test-run/drift/quality/deploy/rollback) and called explicitly by `audit`/`monitor`/`agent-test`. `audit`/`monitor` also archive full timestamped snapshots via `archiveSnapshot()` under `logs/audit-results/` / `logs/monitor-results/` (raw shape, byte-identical to `-latest.json`, retention 50) — the file counterpart to the SQLite index. Surfaced by `sfdt history` (`--type`/`--limit`/`--json`) and the read-only MCP tool `sfdt_history`.
- **Notifications** (`src/lib/notifier.js` + `notifier-formatters.js`) is a provider-agnostic dispatcher: Slack, MS Teams, Google Chat, generic webhook, Grafana Loki (via `fetch`), and email (lazy-imported `nodemailer`, an optionalDependency). Channels are configured under the `notifications` block (`enabled` + `channels[]`); each channel has an `events` filter and a `severityThreshold` used by `dispatchSnapshot` (severity from `src/lib/check-status.js` `maxStatus`). Channel secrets are referenced by env-var NAME (`webhookUrlEnv`, SMTP `*Env`), never inline (the legacy `notifications.slack.webhookUrl` shape is still honoured for back-compat). When `notifications.summary.enabled`, `dispatchSnapshot` first builds an AI executive summary (editable `monitor-summary` prompt, snapshot redacted, works for every provider) and uses it as the message body. `sfdt notify <event>` and `notify snapshot --type audit|monitor` drive it; the GUI exposes redacted `/api/notifications` + `/api/notifications/test`; MCP exposes `sfdt_notify`.
- **PR decoration & retrofit** (`src/lib/github-pr.js`, `src/commands/pr.js`, `src/commands/retrofit.js`): `sfdt pr comment --type audit|monitor` (or `--body`/`--file`) posts the latest snapshot (rendered to markdown via `notifier-formatters` `renderMarkdown`) to the current PR through a thin `gh` wrapper; `deploy --smart --pr-comment` decorates the PR with the delta + outcome. `sfdt retrofit --source <a> --target <b>` retrieves a configurable metadata set from the source org (reusing `org-inventory` + `parallel-retrieve`), commits, then smart-deploys to the target (validate-only unless `--execute`). MCP exposes `sfdt_pr_comment` and `sfdt_retrofit` (the latter confirmExecution-gated for real deploys).
- **Dependencies** (`src/commands/dependencies.js`) queries the Tooling API's MetadataComponentDependency object to show what a component references and what references it; resolution and grouping logic is shared with the GUI through `@sfdt/flow-core` so both behave identically. The shared `METADATA_TYPE_REGISTRY` is the single source of truth for CLI-resolvable types (ApexClass, ApexTrigger, ApexPage, ApexComponent, Flow, LightningComponentBundle, AuraDefinitionBundle, CustomField) and GUI graph source types. The GUI renders Apex/Trigger/VF page+component/Flow/LWC/Aura by default with CustomObject/CustomField opt-in; `/api/dependencies` applies `LIMIT 5000` and returns `truncated` when results exceed the limit. The GUI graph is now **seed + expand-on-click**: users pick a seed by name+type (resolvable types only; `CustomObject` is reachable only as a neighbor) and click nodes to expand, via `/api/dependencies/resolve` (name+type → component Id) and `/api/dependencies/neighbors` (id → both-direction neighbors, capped at 50/direction with `hasMore`). The bulk endpoint is retained but no longer used by the page. Source-parsing (C1) via `@sfdt/flow-core` `dependency-parsers` + `src/lib/source-dependencies.js` finds inferred edges the Tooling API misses (dynamic Apex, LWC `@salesforce/apex`, formula refs, Flow refs); surfaced by `sfdt dependencies <name> --gaps` (offline; `--org` diffs to mark MISSING vs confirmed), `GET /api/dependencies/gaps`, and the GUI "Gaps" panel. The GUI graph optionally overlays these gaps via a client-only "Show inferred" toggle (C2) that renders missing edges as dashed lines, reconciled onto existing nodes or shown as synthetic `inferred:<type>:<name>` nodes, reusing the same endpoint.
- **CI templates** (`src/commands/ci.js` + `src/lib/ci-templates.js` + `scripts/ci/*.yml`): `sfdt ci init --provider github|gitlab|azure|bitbucket --type monitor|deploy|release|scratch` interpolates a ready-to-use pipeline — scheduled `monitor all --notify`, PR `deploy --smart --dry-run` (with an advisory `quality` gate; GitHub uploads SARIF to code scanning via `quality --output-file`), an approval-gated real release deploy (GitHub Environments / GitLab manual+environment / Azure deployment job / Bitbucket deployment; delta base = last git tag with a `{{deltaBase}}` fallback), or scratch-org CI (create→deploy→test→always-delete against the Dev Hub). Auth is pluggable via `--auth sfdx-url|jwt` (config `ci.authMethod`); `--runner npx|docker` (gitlab/bitbucket only, config `ci.runner`) swaps the node image + per-run installs for the official sfdt Docker image. Rendering = block partials from `scripts/ci/partials/` injected indentation-aware via `injectBlock()` (`{{authSteps}}`/`{{authSecretsDoc}}`/`{{qualitySteps}}`/`{{cliSetup}}`/`{{lwcTestSteps}}`), then the scalar `interpolate()` pass — partials may contain scalars. The scratch templates' LWC step is emitted commented-out unless `src/lib/lwc-test.js` `detectLwcTests()` finds a Jest setup (`sfdt test --lwc` runs it locally). `sfdt monitor schedule` is a thin alias. Templates are package assets resolved via `import.meta.url`. The repo root also ships a **composite GitHub Action** (`action.yml`, `uses: scoobydrew83/sfdt@v0`) that installs a pinned CLI (`cli-version: auto` reads the action checkout's `package.json`) and handles sfdx-url/jwt auth; `ci.yml`'s publish job force-moves the floating `v<major>` tag on each stable release, and `.github/workflows/action-selftest.yml` exercises the action on PRs that touch it. `--runner action` (github; monitor/deploy/release only — scratch drives raw `sf` commands) selects the `github-<type>.action.yml` template variant, which collapses setup/auth into one `uses:` step with `with:` inputs from the `action-auth-*` partials.
- **Smart deploy** (`src/lib/smart-deploy.js`): `sfdt deploy --smart` computes a git delta (reusing the `manifest` engine — `git-utils` + `metadata-mapper`), applies `package-no-overwrite.xml` protection, picks the minimal safe test level (`NoTestRun`/`RunSpecifiedTests`/`RunLocalTests`, never downgraded in production; `deployment.smart.useRelevantTests` opts non-prod orgs on API 66+ into Salesforce's beta `RunRelevantTests` instead of the `RunLocalTests` fallback), and runs a self-contained non-interactive `sf project deploy validate|start` (no archive/commit side effects, unlike the interactive `deployment-assistant.sh` path). Config: `deployment.smart`. `--notify` dispatches `deploy-success`/`deploy-failure` through the notifier after the run (smart path; the standard manifest path keeps its `SFDT_NOTIFY_SLACK` wiring). `--ai-fix` runs the editable `deploy-error` prompt; when `ai.agent.enabled` + `ai.agent.allowWrite` (CLI providers only), `src/lib/agent-loop.js` runs a bounded write-capable auto-fix loop that re-validates via dry-run each turn (default off). A non-interactive `--agent` convention exists on `deploy`, `explain`, `review`, and `quality`.
- **VS Code extension** (`vscode/`, package name `sfdt-devtools`) is a thin UI over the CLI — it spawns the `sfdt` binary and reads the same JSON snapshots; it reimplements no logic. Published to the VS Code Marketplace as **`sfdt.sfdt-devtools`** (publisher `sfdt`, display name "SFDT for Salesforce"). The manifest `name` is unscoped (`sfdt-devtools`, not `@sfdt/...`) because the Marketplace rejects scoped names — so the root `*:vscode` scripts select the workspace by path (`-w vscode`), not by package name. Testable logic lives in `vscode`-free modules under `vscode/src/lib/`; `vscode`-importing modules (extension/tree/dashboard/statusBar) are esbuild-bundled and not unit-tested. Build with `npm run build:vscode`, package with `npm run package:vscode` (produces `vscode/sfdt-devtools-<version>.vsix`).
- **Salesforce CLI plugin** (`packages/plugin/`, package name `@sfdt/plugin`) is a thin oclif wrapper that exposes the CLI as `sf sfdt <command>` (install: `sf plugins install @sfdt/plugin`). It reimplements no logic — each command forwards its raw argv to the bundled `sfdt` binary via `execa` (same invocation pattern as `mcp-server.js`) and streams output, including `--json`, verbatim. The oclif command files under `src/commands/sfdt/**` are **code-generated** from `createCli()` (`scripts/generate-commands.mjs`, run by `npm run gen`/`build`) — the Commander definitions are the single source of truth, so never hand-edit them (they're gitignored). Generated commands are `strict = false`, so unknown flags/positional/variadic args pass through and oclif does not intercept `--json`. The codegen and tests import the CLI from local source via a relative path (the monorepo root `@sfdt/cli` package is not symlinked into `node_modules`); the shipped `forward.ts` resolves `@sfdt/cli` at runtime (`require.resolve`, overridable via `SFDT_CLI_ENTRYPOINT`). `@sfdt/cli` is declared as a `>=` dependency (not an exact pin) so the version-bump commit's `npm ci` never 404s on the not-yet-published version; because the plugin and CLI publish together (coupled release), an install resolves to the matching version. Build with `npm run build:plugin`; released by the same `ci.yml` jobs as the CLI (published **after** it).
- **JSON output convention**: commands that support `--json` emit a Salesforce sf-native envelope on **stdout** via `emitJson(result)` / `emitJsonError(err)` in `src/lib/output.js` — `{ status, result, warnings }` on success (`status` is the numeric exit code, `0` for success) and `{ status, name, message, exitCode, warnings, data? }` on error. This is so `sfdt`/`sf sfdt` output composes in sf-native pipelines. **Boundary:** the envelope is a stdout-only contract; the on-disk snapshot files (`logs/*-latest.json`) stay **raw** (GUI and VS Code read those shapes directly). The MCP server (`mcp-server.js`) is the only stdout consumer — its `#parseCliJson` unwraps `.result`.

### SFDT_ Environment Variables

`script-runner.js` flattens config into `SFDT_`-prefixed env vars before invoking shell scripts. The current mapping:

| Variable | Source |
|----------|--------|
| `SFDT_PROJECT_ROOT` | `config._projectRoot` |
| `SFDT_CONFIG_DIR` | `config._configDir` |
| `SFDT_PROJECT_NAME` | `config.projectName` (default: `"Salesforce Project"`) |
| `SFDT_DEFAULT_ORG` | `config.defaultOrg` |
| `SFDT_SOURCE_PATH` | `config.defaultSourcePath` (default: `"force-app/main/default"`) |
| `SFDT_MANIFEST_DIR` | `config.manifestDir` (default: `"manifest/release"`) |
| `SFDT_RELEASE_NOTES_DIR` | `config.releaseNotesDir` (default: `"release-notes"`) |
| `SFDT_API_VERSION` | `config.sourceApiVersion` |
| `SFDT_COVERAGE_THRESHOLD` | `config.deployment.coverageThreshold` (default: `75`) |
| `SFDT_LOG_DIR` | `config.logDir` (optional; scripts fall back to `${SFDT_PROJECT_ROOT}/logs`) |
| `SFDT_TARGET_ORG` | Set by `gui-server.js` when running drift/preflight from the GUI; overrides `SFDT_DEFAULT_ORG` for that run |
| `SFDT_BACKUP_BEFORE_ROLLBACK` | `config.deployment.backupBeforeRollback` (default: `true`) |
| `SFDT_PREFLIGHT_ENFORCE_TESTS` | `"true"` when `config.deployment.preflight.enforceTests` is set; gates Apex test check in preflight |
| `SFDT_PREFLIGHT_ENFORCE_BRANCH` | `"true"` when `config.deployment.preflight.enforceBranchNaming` is set; promotes branch WARN to FAIL |
| `SFDT_PREFLIGHT_ENFORCE_CHANGELOG` | `"true"` when `config.deployment.preflight.enforceChangelog` is set; promotes CHANGELOG WARN to FAIL |
| `SFDT_PREFLIGHT_ENFORCE_GIT_CLEAN` | `"true"` (default) unless `config.deployment.preflight.enforceGitClean` is `false`; gates git-clean check |
| `SFDT_PREFLIGHT_ENFORCE_SFDX_PROJECT` | `"true"` (default) unless `config.deployment.preflight.enforceSfdxProject` is `false`; gates sfdx-project.json check |
| `SFDT_PREFLIGHT_ENFORCE_UNTRACKED` | `"true"` when `config.deployment.preflight.enforceUntrackedFiles` is set; gates untracked-files check in force-app/ |
| `SFDT_PREFLIGHT_STRICT` | `"true"` when `config.deployment.preflight.strict` is set; promotes all WARNs to FAILs (**overrides the per-check flags** — a check left as a WARN by `enforceX: false` is still promoted to a failure under strict) |

> Note: for the opt-in enforce flags (`enforceTests`, `enforceBranchNaming`, `enforceChangelog`, `enforceUntrackedFiles`), "is set" means **truthy** — `false` is indistinguishable from omitting the key, and both leave the check as a non-fatal WARN (they never actively suppress it). Only `enforceGitClean`/`enforceSfdxProject` are default-on (`!== false`). All preflight flags are editable from the GUI Settings page (an inline caution is shown; they are no longer API-locked).
| `SFDT_FEATURE_*` | Flattened from `config.features` |
| `SFDT_DEFAULT_ENV` | `config.environments.default` |
| `SFDT_ENV_ORGS` | Comma-joined org aliases from `config.environments.orgs` |
| `SFDT_TEST_*` | Flattened from `config.testConfig` |
| `SFDT_TEST_CLASSES` | Comma-joined test class names from `config.testConfig.testClasses` |
| `SFDT_APEX_CLASSES` | Comma-joined Apex class names from `config.testConfig.apexClasses` |
| `SFDT_NON_INTERACTIVE` | `"true"` when stdin is not a TTY or `options.interactive === false` |
| `SFDT_PARALLEL_DELAY` | Seconds between parallel batch launches, from `config.testConfig.parallelDelay` when set (a user-exported env value wins); shell-script default `1` otherwise |
| `SFDT_DEFAULT_BRANCH` | `config.defaultBranch` (default: `"main"`); a user-exported env value wins. Used by `deployment-assistant.sh` for PR base branch |
| `SFDT_SMOKE_TESTS` | Per-invocation: comma-joined `config.smokeTests.testClasses`, set by `smoke.js` (a user-exported env value wins) |
| `SFDT_ANALYZER_INCLUDE_FIXES` | Per-invocation: `"true"` from `quality --include-fixes`; `scripts/quality/code-analyzer.sh` adds `--include-fixes --include-suggestions` to the Code Analyzer v5 run |
| `SFDT_ANALYZER_OUTPUT_FILE` | Per-invocation: from `quality --output-file <path>`; `scripts/quality/code-analyzer.sh` adds a second `--output-file` to the Code Analyzer v5 run (format inferred from the extension, e.g. `.sarif`); v4 logs a warning and skips |
| `SFDT_ANALYZER_ALLOW_LEGACY` | Per-invocation: `"true"` from `quality --allow-legacy-analyzer` or config `quality.analyzer.allowLegacyV4`; permits the legacy Code Analyzer v4 (`sf scanner run`) when v5 is unavailable. Without it, a v4-only environment emits the `skipped` marker (v5 required — J-1 policy; skip is never rendered as a pass). v4 support is removed at 1.0 |
| `SFDT_TAG_RELEASE` / `SFDT_CREATE_PR` / `SFDT_NOTIFY_SLACK` | Per-invocation: `"true"` from `deploy --tag/--create-pr/--notify` (or the GUI Release Hub toggles); drive post-deploy tagging, PR creation, and notifications in `deployment-assistant.sh` |
| `SFDT_PACKAGE_DIRS` | JSON array of all package paths from `config.packageDirectories`, e.g. `["force-app/main/default","force-app/feature-a"]` |
| `SFDT_MANIFEST_LAYOUT` | `config.manifestLayout` (`"flat"` or `"subpath"`); default `"flat"` |
| `SFDT_CHANGELOG_DIR` | `config.changelogDir` (default: `"changelogs"`); directory for per-package changelog files |
| `SFDT_PACKAGE_TARGET` | Per-invocation: `"all"` or a specific package name; passed via `env:` option in `runScript()` calls |
| `SFDT_RELEASE_NAME` | Per-invocation: full release label (semver, free-form, or date); passed via `env:` option |
| `SFDT_CHANGELOG_FILE` | Per-invocation: resolved changelog file path (e.g., `changelogs/marketing.md` or `CHANGELOG.md`); set by `release.js` and `changelog.js` |
| `SFDT_DEPLOY_SOURCE_DIR` | Per-invocation: source directory path for folder-mode deploys; empty string for manifest-mode; passed via `env:` option |
| `SFDT_DESTRUCTIVE_TIMING` | Per-invocation: one of `"pre"`, `"post"`, `"none"`, `"only"`; controls when destructive changes are applied during deploy (default: `"post"`). `none` skips destructiveChanges, `only` runs ONLY destructive operations |
| `SFDT_VALIDATION_JOB_ID` | Per-invocation: a Salesforce deploy validation Id (`0Af…`) for Quick Deploy; when set, `core/deployment-assistant.sh` calls `sf project deploy quick` to promote the prior validation instead of running a full deploy |
| (removed) | `pullConfig` is consumed directly by `pull.js`; no longer flattened to env vars |

When adding a new env var, update both `buildScriptEnv()` in `script-runner.js` and this table.

### Surface Catalogs — CRITICAL RULE

`generated/` holds machine-generated catalogs of every public surface (commands, chrome features, GUI pages, VS Code commands, MCP tools, bridge kinds, CI capabilities, packages, parity matrix, summary). **Code is authoritative; the catalogs are derived and checked in.** CI fails on drift (`npm run check:all-contracts`). Never edit `generated/*` by hand. When you change a public surface, run `npm run generate:catalogs` and commit the diff. Specifically:

- **New/changed CLI command or flag** → add/update its `src/lib/command-policy.js` entry (mutating/requiresOrg/surfaces/mcpTools — enforced by `test/command-policy.test.js`), then regenerate.
- **New MCP tool** → map it in a command's `mcpTools` (or `MCP_INTERNAL_TOOLS`); a mutating tool MUST declare `confirmExecution`. The `sfdt_audit`/`sfdt_monitor` check enums derive from the runners' `CHECK_IDS` — never hardcode them.
- **New Chrome feature** → it must appear in `extension/lib/feature-manifests.json`; regenerate with `SFDT_WRITE_MANIFESTS=1 npm run test:extension -- feature-manifests` (parity-tested against the real registrations), then regenerate catalogs.
- **New GUI page** → add one entry to `gui/src/routes.js` (the single registry; App.jsx derives nav/labels/rendering from it) plus its ICONS/PAGES map entries, then regenerate.
- **CI provider/type/auth/runner change** → `src/lib/ci-capabilities.js` is the only place lists live.
- **License or Node-floor change** → update `tools/license-policy.json` / `package.json` engines; `check:licenses`/`check:node` enforce every other statement of them.

### Config Template

`src/templates/sfdt.config.json` is the canonical source of truth for the shape and defaults of `.sfdt/config.json`. `sfdt init` reads this template via `fs.readJson` and deep-merges user-provided answers on top. When adding new config keys, add them to the template first — `init.js` will pick them up automatically.

**Also update `src/lib/config-schema.json`** — config is validated by AJV against this schema with `additionalProperties: false` on every object. A key that ships in the template (or is read by code) but is missing from the schema fails `validateConfig()` at runtime with `Invalid configuration: "<path>" contains unknown key "<key>"`. Adding a config key means touching three places in lockstep: the template, the schema, and the consuming code.

### Known Gaps

- **GUI not pre-built in dev**: `gui/dist/` must be compiled with `npm run build:gui` before `sfdt ui` shows the full dashboard. The server falls back to a build-instructions page when `dist/` is absent.

### Error Handling

- Commands should throw descriptive `Error` objects; the CLI entry point catches and formats them.
- `runScript()` throws on non-zero exit codes with stdout/stderr attached to the error.
- Config loading throws early with actionable messages (e.g. "Run `sfdt init` first").

## Documentation Site (sfdt.dev)

The public docs/support site lives in a **separate repo**: `https://github.com/scoobydrew83/sfdt-site`, deployed to Cloudflare Pages and served at **https://sfdt.dev/**. It's a Nextra 4 (Next.js App Router) static export; content is MDX under `content/`, with `_meta.js` files controlling nav order. It documents the whole SFDT suite — the `@sfdt/cli`, the Chrome extension, and the VS Code extension.

**Keep the site current.** Whenever a change here adds, removes, or alters user-facing behaviour — a new command/subcommand, a new flag, a config key, a changed default, a new feature gate — update the matching MDX in `sfdt-site/content/` in the same effort (or open a follow-up). The CLI repo and the site are released together; stale docs on a public site are a bug. After merging a feature or cutting a release, do a docs-staleness pass over `sfdt-site` (command list, flags, config reference, version/changelog highlights) before considering the work done.

## Development

```bash
npm test              # Run tests (vitest)
npm run lint          # ESLint
npm run test:coverage # Coverage report
npm link              # Link for local development
```

### GUI Development & Testing

The GUI (`gui/src/`) must be compiled before the server serves it. `gui/dist/` is NOT auto-rebuilt on source changes.

#### Step 1 — Build and link (run from sfdt package root)

```bash
npm run dev:ui
# Equivalent to: npm run build:gui && npm link
```

This ensures the `sfdt` binary on PATH resolves to THIS package, not a globally published version.

#### Step 2 — Verify the link

```bash
ls -la $(which sfdt)
# Must show a symlink into <sfdt-package-root>/bin/sfdt.js
# If it points elsewhere, re-run: npm link
```

#### Step 3 — Start against the Salesforce project

```bash
cd /path/to/your-sf-project   # or any project with .sfdt/config.json
sfdt ui                                   # starts server at http://localhost:7654
```

#### After any GUI source change

```bash
# From sfdt package root:
npm run build:gui
# Kill and restart `sfdt ui` in the SF project directory
pkill -f "sfdt ui"
cd /path/to/your-sf-project && sfdt ui
```

#### CRITICAL: Always verify before testing

Before testing or reporting on GUI behaviour in any session:
1. `ls -la $(which sfdt)` — confirm it links into the sfdt dev directory
2. `npm run build:gui` — confirm `gui/dist/` reflects the latest source changes
3. Start `sfdt ui` from the SF project, not from the sfdt package root

### Package-Internal Path Resolution — CRITICAL RULE

**Any path that references a file INSIDE the sfdt package** (scripts/, templates/, gui/dist/, bin/) MUST be resolved using `import.meta.url`, never from `process.cwd()`, `config._projectRoot`, or any CWD-based reference.

When globally installed, `config._projectRoot` points to the *user's Salesforce project*, not the sfdt package. Using it to find package files causes "No such file or directory" errors on any machine other than the developer's.

**WRONG — breaks on other machines:**
```js
path.join(config._projectRoot, 'scripts/ops/preflight.sh')
path.join(projectRoot, 'scripts/lib/changelog-utils.sh')
path.resolve(process.cwd(), 'scripts/...')
```

**CORRECT — always resolves from the npm package location:**
```js
// At the top of every file that needs package assets:
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS_DIR = path.resolve(__dirname, '..', '..', 'scripts');  // from src/commands/ or src/lib/

// Then use it:
path.join(SCRIPTS_DIR, 'ops/preflight.sh')
path.join(SCRIPTS_DIR, 'lib/changelog-utils.sh')
```

The depth of `../..` depends on the file's location:
- From `src/commands/` or `src/lib/` → `'..', '..', 'scripts'` reaches package root
- From `bin/` → `'..', 'scripts'`

**Run `/validate-npm-paths` before every release** to catch violations.

## Guidelines

- Do not hardcode org aliases, branch names, or project-specific values
- All external tool dependencies (sf, gh, claude, bash) must be checked at runtime before use
- Shell scripts must be POSIX-compatible where possible; bash 4.0+ features are acceptable
- Use chalk for colored output, ora for spinners, inquirer for prompts
- Test with vitest; mock execa calls for shell script tests
- Keep commands thin — delegate logic to `src/lib/` or `scripts/`
- User-facing changes must be mirrored to the docs site (`sfdt-site`, https://sfdt.dev/) — see [Documentation Site](#documentation-site-sfdtdev)
