# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.3] - 2026-04-29

### Added
- **GUI: ErrorBoundary** — all pages are now wrapped in a React error boundary; a render crash on one page no longer takes down the entire dashboard.
- **GUI: Dashboard retry** — when dashboard data fails to load, an inline error message with a Retry button appears instead of a silent blank state.
- **GUI: Compare cancel** — a Cancel button appears during long-running inventory streams so users can abort without navigating away.
- **GUI test suite** — Vitest + Testing Library added to the GUI package; tests run in CI on every push (`cd gui && npm test`).
- **JSDoc type annotations** added to all `api.js` functions for improved IDE autocompletion.

### Changed
- **ANSI escape codes stripped** from all SSE log output and terminal streams in the GUI — no more garbled color codes appearing in command output panels.
- **Node.js 22+ required** — engine floor raised from 20 to 22; CI now tests on Node 22 only.
- **`better-sqlite3` replaced with Node built-in `node:sqlite`** (`DatabaseSync`) — removes the native compiled dependency; pull cache now uses the standard library SQLite module.
- **Pull page** replaced with a "Coming Soon" placeholder pointing users to the Compare page and the CLI; the interactive pull UI is not yet complete.
- **`/api/preflight`, `/api/drift`, `/api/compare`** now return structured empty shapes (`{ date: null, status: null, checks: [] }` etc.) instead of `{}` when no data exists, preventing client-side null-check errors.
- **Org config format** (`environments.orgs`) is now correctly read as an array of `{ alias, username }` objects, matching what `sfdt init` writes.

### Fixed
- Dashboard drift activity card no longer crashes — uses `drift.status` / `drift.components` instead of the removed `drift.result` / `drift.count` fields.
- `initInProgress` flag is now correctly reset to `false` after a successful `/api/init` call (was only reset on error, causing false "Already initialized" rejections after first use).
- Release Hub: streaming sessions for changelog and release-note generation are now closed on component unmount, preventing memory leaks after navigating away.
- Release Hub: deployment now validates that a target org is selected before starting, showing an inline error instead of silently proceeding with no org.
- Release Hub: test detection effect no longer re-runs on `testClasses` change (was causing duplicate API calls).
- Logs page: unknown log types now render their raw JSON payload in a scrollable `<pre>` block instead of returning `null`.
- Manifests viewer: defensive null checks on `data.components` prevent crashes when a manifest has no components; download filename falls back to `manifest.xml`.
- Review, Explain, Quality pages: when AI output exceeds 2000 characters, the content is truncated and a notice shows the full character count.
- Settings: `coverageThreshold` field now validates that the entered value is a number between 0 and 100 before saving.
- React key props in Logs, ReleaseHub, and Dashboard tables now use stable identifiers instead of array indices, preventing incorrect reconciliation on re-render.
- CodeQL suppression comments added to intentional file-to-HTTP patterns in `ai.js` to silence false-positive alerts.

## [0.6.2] - 2026-04-29

### Added
- **GUI: Initialize Project from Settings**: The Settings page now shows a guided "Initialize Project" card when no `.sfdt/` config directory exists, backed by a new `/api/init` endpoint — users can set up a project without touching the command line.

### Fixed
- `ReferenceError` crash on the Release Hub page caused by a missing `IconSearch` import; the page now loads correctly.
- Settings page no longer returns a raw 503 error on uninitialized projects; users are guided to initialize from within the GUI instead.
- After a GUI-triggered update (`sfdt update`), the server now self-restarts automatically and the browser polls `/api/ping` to reload once the server is ready — no manual restart required.

### Changed
- `express-rate-limit` updated from v7 to v8 (major); no behavior change for end users.
- `ora` updated to 9.4.0; `vitest` and `@vitest/coverage-v8` updated to 4.1.5.

## [0.6.1] - 2026-04-28

### Security
- Config key segments are now validated with a strict regex before get/set operations, blocking remote property injection via crafted key names (CodeQL #35, #36).
- Prototype-pollution vulnerabilities fully resolved using `Object.defineProperty` with inline guards throughout config resolution (CodeQL alerts cleared).

### Fixed
- Deployed manifests are now read-only in the GUI — the Manifests page and server-side route both enforce this guard, preventing accidental overwrites of released artifacts.
- `skipPreflight` is now correctly honored in the GUI deploy path; the flag was previously ignored when deploying from the Release Hub.
- Versioned manifest and release-note saves now return `409 Conflict` if the file already exists, preventing silent overwrites on duplicate runs.
- `run_full_deployment` no longer hangs waiting for an interactive confirmation prompt when run in non-interactive (CI/GUI) environments.

## [0.6.0] - 2026-04-26

### Added
- **AI Chat drawer** (GUI): New sliding ChatDrawer panel with streaming token-by-token responses, accessible from the dashboard toolbar. Contextual "Ask AI" buttons on Review, Explain, Drift, and Preflight pages pre-fill the chat with the relevant output as context.
- **Streaming AI chat API** (`POST /api/ai/chat`): Server-Sent Events endpoint backing the ChatDrawer, using `streamAiResponse()` for real-time token streaming across all configured AI providers (Claude, Gemini, OpenAI).
- **Structured logging system** (`src/lib/log-writer.js`): New log-writer module with a typed schema for structured SFDT logs. `drift.sh` emits `SFDT_LOG:component:` markers and `preflight.sh` emits `SFDT_LOG:check:` markers; the GUI server COMMANDS runner writes these as structured log files alongside plain-text logs.
- **`logRetention` config key**: Controls how many log files to retain per log type (default: 50). Older files are pruned automatically on each write.
- **`sfdt config get/set`**: Read and write individual `.sfdt/config.json` values using dot notation from the command line (e.g. `sfdt config set deployment.coverageThreshold 80`).
- **Salesforce MCP client** (`src/lib/mcp-client.js`): Connects to `sf mcp start` via the Model Context Protocol SDK to fetch DevOps Center pipeline status and work items; surfaced in the GUI dashboard when `mcp.enabled` is set in config.

### Fixed
- AI context readers now normalize the response envelope, ensuring consistent data shape across providers.
- `SFDT_TARGET_ORG` is now correctly passed to `drift.sh` when run from the GUI.
- `readLatestLog` is now used in the quality fix-plan flow, replacing a stale direct-path read.
- `latest.json` is excluded from the test-run file list to prevent it appearing as a selectable run.
- `writeLog` and the GUI COMMANDS runner now guard against `undefined` data to prevent silent failures on empty payloads.
- Unknown log types are handled gracefully; archive filename collisions on concurrent writes are prevented.
- Sensitive file reads (credentials, private keys) are blocked when AI executes file-read tools.

## [0.5.1] - 2026-04-24

### Fixed
- Parallel retrieve timeout increased to 6 minutes (was 2 minutes) to prevent timeouts on large orgs; now configurable via `pullCache.retrieveTimeoutSeconds` in `sfdt.config.json`.
- Org alias is now sanitized before use as a SQLite filename, preventing path traversal in the pull cache.
- `toMs()` in delta detection now guards against `null`/`undefined` dates to prevent `NaN` comparisons.
- Components deleted from the org are now pruned from the pull cache on each successful update.
- Partial retrieve successes are now cached correctly; cache update is only skipped when zero components were retrieved.
- `smartPull` is now gated behind the `pullCache.enabled` flag.
- Moved retrieved-component counter accumulation outside the concurrent `Promise.all` window to prevent race conditions.
- GitHub Actions docs-update workflow now triggers correctly when commits are made by the `github-actions` bot.

## [0.5.0] - 2026-04-23

### Added
- **`sfdt pull` rewritten as Node.js orchestrator**: The pull command is now fully implemented in Node.js with a SQLite-backed cache. Tracks retrieved components, modification dates, and delta detection — replaces the previous shell script approach for improved reliability and extensibility.
- **Parallel retrieve engine**: Components are fetched in parallel batches during pull, significantly reducing retrieval time for large orgs.
- **SQLite pull cache** (`src/lib/pull-cache.js`): Persistent local cache of retrieved metadata with `withDates` mode for delta-based incremental retrieves — only changed components are re-fetched on subsequent pulls.
- **`pullCache` config key**: New `pullCache` section in `sfdt.config.json` template controls cache path and enabled state; `sfdt init` picks it up automatically.
- **GUI: Release Hub, Review, and Explain pages**: Three new dashboard pages — Release Hub for managing release artifacts, Review for AI-powered code review results, and Explain for deployment log analysis. Navigation is now grouped by workflow area for easier discovery.
- **GUI: Compare batching, Manifests page, Quality/Pull parity**: Compare page now streams diffs in batches to handle large orgs; new Manifests page surfaces generated `package.xml` artifacts; Quality and Pull pages reach feature parity with their CLI counterparts.

### Fixed
- Pull cache now handles partial retrieve errors gracefully without corrupting cached state.
- ISO date normalization in delta detection prevents false positives when comparing org metadata timestamps in mixed formats.
- Removed stale `SFDT_PULL_*` environment variables from the script runner — pull config is now consumed directly in Node.js.
- Removed unused `pullProfiles` config parameter; database connection is now closed in a `finally` block to prevent leaks.
- Express API rate limiter and request path handling corrected in the GUI server.

## [0.4.2] - 2026-04-20

### Added
- **`sfdt update` command**: checks npm for the latest published version and self-updates via `npm install -g @sfdt/cli@latest`. Prompts for confirmation before installing; use `--force` to skip the prompt.
- **GUI update check and streaming install**: the dashboard exposes `/api/check-updates` (compares current vs latest npm version) and `/api/update/stream` (SSE endpoint that streams live `npm install` output so updates can be triggered and monitored from the web UI).

## [0.4.1] - 2026-04-20

### Added
- **Shell completions** (`sfdt completion <bash|zsh|fish>`): generates ready-to-source completion scripts covering all commands and their flags — pipe to a file or `source` directly in your shell profile.
- **Version subcommand** (`sfdt version`): prints `sfdt vX.Y.Z`; complements the existing `-v` / `--version` flag and works as a proper subcommand in shell scripts.
- **`--dry-run` flag** on `deploy`, `rollback`, `preflight`, `smoke`, `pull`, and `test`: prints the script path, working directory, and all `SFDT_` env vars that would be set — no changes are made to the org.
- **Structured exit codes** (`src/lib/exit-codes.js`): `EXIT_SUCCESS` (0), `ERROR` (1), `CONFIG_ERROR` (2), `CONNECT_ERROR` (3). All 18 commands now map to the correct code instead of hardcoded `1`, making it easier to handle errors in CI scripts.

### Changed
- Config validation is now stricter with richer error messages: `defaultOrg` must be a non-empty string, `coverageThreshold` must be 0–100, `environments.orgs` must be an array, and `logDir` must be a string. Validation errors exit with code `2` (`CONFIG_ERROR`).
- Updated `express` from 4.x to 5.x.
- Updated `open` from 10.x to 11.x.

## [0.4.0] - 2026-04-19

### Added
- **Org Compare command** (`sfdt compare`): Side-by-side metadata inventory comparison between two Salesforce orgs. Streams live progress via SSE, showing added, removed, and changed components across all metadata types. Supports `--source` and `--target` org aliases with `--format json|table` output.
- **Compare page** (GUI): New Compare dashboard page with live streaming progress, filterable DataTable of component diffs (`CompareTable`), and collapsible side-by-side diff viewer (`DiffPanel`). Status badges and empty states follow SLDS conventions.
- **CommandRunner component**: Reusable GUI component for live CLI command execution with SSE streaming, used on Preflight, Drift, Test Runs, and Compare pages.
- `src/lib/org-inventory.js` / `src/lib/org-diff.js`: Org inventory retrieval and pure diff engine backing `sfdt compare`.

### Fixed
- Compare diff panel now works for all Salesforce metadata types (`CustomMetadata` records, foldered metadata) — validation now targets path traversal patterns instead of banning `.` and `/` in member names.
- Beta releases can no longer accidentally publish as `latest` — CI `publish` job on `main` now fails immediately if the version contains a pre-release suffix.

### Security
- Docs automation no longer executes repo-controlled instructions under write credentials — workflow instructions are now fully inline in the protected workflow YAML; unnecessary `id-token: write` permission removed.

## [0.3.2] - 2026-04-19

### Changed
- **GUI build toolchain updated to Vite 8**: `@vitejs/plugin-react` upgraded to v5, `esbuildOptions` removed (no longer supported), dedicated `gui-build` CI job added for Node 20 and 22
- Bumped `esbuild` and `vite` in GUI dependencies
- Bumped `inquirer` production dependency
- Bumped `prettier` development dependency
- CI: upgraded `actions/stale` from v9 to v10
- CI: upgraded `github/codeql-action` from v3 to v4

## [0.4.0-beta.5] - 2026-04-19

### Changed
- Synced dependency bumps from `main` (inquirer, prettier, esbuild, vite, plugin-react v5) into `develop`
- CI: dedicated `gui-build` job now runs on Node 20 and 22

### Fixed
- Token handling fix

## [0.4.0-beta.1] - 2026-04-17

### Added
- **Org Compare command** (`sfdt compare`): Side-by-side metadata inventory comparison between two Salesforce orgs. Streams live progress via SSE, showing added, removed, and changed components across all metadata types. Supports `--source` and `--target` org aliases with `--format json|table` output.
- **Compare page** (GUI): New Compare dashboard page with live streaming progress, filterable DataTable of component diffs (`CompareTable`), and collapsible side-by-side diff viewer (`DiffPanel`) for inspecting metadata differences. Status badges and empty states follow SLDS conventions.
- **CommandRunner component**: Reusable GUI component for live CLI command execution with SSE streaming, used on Preflight, Drift, Test Runs, and Compare pages.
- `src/lib/org-inventory.js`: Retrieves full metadata inventory from a Salesforce org using `sf org list metadata` — used by `sfdt compare` as the data source for both orgs.
- `src/lib/org-diff.js`: Pure diff engine that compares two org inventories and returns `added`, `removed`, and `changed` component lists.

### Fixed
- **Compare diff panel now works for all Salesforce metadata types**: The `/api/compare/diff` endpoint previously rejected member names containing `.` or `/`, blocking `CustomMetadata` records (e.g. `MyType.MyRecord`) and foldered metadata (e.g. `reports/Folder/Report`). Validation now correctly targets path traversal patterns (`..`, absolute paths, null bytes) instead of banning valid Salesforce naming characters.
- **Beta releases can no longer accidentally publish as `latest`**: The CI `publish` job on `main` now fails immediately if the package version contains a pre-release suffix (e.g. `-beta.1`), preventing a forgotten version bump from silently pushing a beta to all users.

### Security
- **Docs automation no longer executes repo-controlled instructions under write credentials**: The `docs-update` GitHub Actions workflow previously instructed Claude to read and follow `.claude/skills/document/SKILL.md` from the just-merged branch while holding `contents: write` and `id-token: write` permissions — a path for a malicious PR to run arbitrary commands with elevated access. Workflow instructions are now fully inline in the protected workflow YAML, and the unnecessary `id-token: write` permission has been removed.

## [0.3.1] - 2026-04-14

### Changed
- **GUI rebuilt with SLDS React components**: Web dashboard (`sfdt ui`) now uses Salesforce Lightning Design System (SLDS) React components throughout, replacing the prior implementation for improved consistency and maintainability

## [0.3.0] - 2026-04-13

### Added
- **Multi-provider AI support**: `ai.provider` in `.sfdt/config.json` selects `claude` (Claude Code CLI, default), `gemini` (Google Gemini REST), or `openai` (OpenAI REST). Both API providers use native `fetch` with SSE streaming — no new npm dependencies. API keys stored in `ai.apiKey` or the corresponding env var (`GEMINI_API_KEY` / `OPENAI_API_KEY`).
- **AI credential auto-discovery**: `sfdt init` now prompts for AI provider and optional API key; stored credentials are resolved at runtime with environment variable fallback.
- **Plugin architecture** (`src/lib/plugin-loader.js`): plugins are discovered and loaded before CLI argument parsing from three sources — (1) `config.plugins[]` package names, (2) `sfdt-plugin-*` / `@scope/sfdt-plugin-*` packages auto-discovered in the project's `node_modules/`, (3) `.sfdt/plugins/*.js` local scripts. Each plugin exports `register(program)`; load errors are warnings, not crashes.
- **Web dashboard** (`sfdt ui`): `src/commands/ui.js` + `src/lib/gui-server.js` — launches a local Express server on port 7654 serving a React 18 + Salesforce Lightning Design System dashboard. Pages: Dashboard (stat cards, recent runs), Test Runs (coverage-coloured DataTable), Preflight (per-check pass/fail), Drift Detection (filterable component table). Built with `npm run build:gui`; `gui/dist/` ships in the published package.
- **Docker support**: `Dockerfile` ships Node 20 slim + Salesforce CLI + git/jq/bash, mounting a Salesforce DX project at `/project`. `.dockerignore` excludes `node_modules`, coverage output, and CI artifacts.
- `src/lib/ai.js` additions: `isAiAvailable(config)`, `aiUnavailableMessage(config)`, `getConfiguredProvider(config)` — replace legacy `isClaudeAvailable()` across all AI-calling commands.
- `sfdt.config.json` template updated with `ai` and `plugins` sections; `sfdt init` picks them up automatically.
- New tests: `test/lib/plugin-loader.test.js` (3 tests); expanded `ai.test.js` covering all three providers. Total: 218 tests across 27 test files.

### Changed
- All 8 AI-calling commands (`review`, `explain`, `manifest`, `pr-description`, `changelog`, `release`, `quality`, `test`) updated to use `isAiAvailable(config)` / `aiUnavailableMessage(config)` and pass `config` to `runAiPrompt` for transparent provider routing.

## [0.2.2] - 2026-04-12

### Security
- Fixed shell command injection risk (CodeQL CWE-78) in `changelog release` and `changelog check` commands — script path is now passed as a bash positional argument (`$1`) instead of being interpolated into the `-c` script string, preventing exploitation via specially crafted project root paths (closes CodeQL alerts #1 and #2: `js/shell-command-injection-from-environment`)

### Added
- `sfdt manifest`: Smart `package.xml` generator from git diffs with optional AI dependency cleanup (`--ai-cleanup`). Supports `--print`, `--destructive`, and custom `--base`/`--head` refs
- `sfdt explain`: AI-powered deployment error log interpreter with heuristic pattern-matching fallback for offline use. Reads from a file, stdin (`--from-stdin`), or auto-discovers the latest log in the log directory
- `sfdt pr-description`: Generates GitHub PR descriptions or Slack messages from deployment changes. Supports `--format github|slack|markdown` and `--output`
- `src/lib/metadata-mapper.js`: Pure-JS metadata type/member parser that mirrors `scripts/lib/metadata-parser.sh` — used by `manifest` and `pr-description` commands, fully unit-tested
- `src/lib/child-process-exit.js`: Signal forwarding and child process exit-code mirroring — ensures sfdt properly propagates `SIGINT`/`SIGTERM` and exits with the child's exit code

## [0.2.1] - 2026-04-07

### Fixed
- `preflight.sh` called `changelog_has_unreleased` which does not exist; corrected to `has_unreleased_content` from `changelog-utils.sh`
- Apex tests and coverage check now skipped by default in preflight — tests are handled interactively in the deployment assistant; running them unconditionally in preflight blocked users who had a default org configured but were not doing a full release

### Added
- `deployment.preflight.enforceTests` config flag: when `true`, preflight runs `RunLocalTests` as a hard gate before deploy (off by default)
- `deployment.preflight.enforceBranchNaming` config flag: when `true`, branch naming check becomes a FAIL instead of a WARN (off by default)
- `deployment.preflight.enforceChangelog` config flag: when `true`, missing or empty CHANGELOG becomes a FAIL instead of a WARN (off by default)
- `sfdt init` now writes `deployment.preflight` block with all enforce flags defaulting to `false`
- `src/templates/sfdt.config.json` is now the source of truth for config shape; `init.js` reads and merges from it so new config keys only need to be added in one place

## [0.2.0] - 2026-04-06

### Added
- `sfdt quality --generate-stubs` generates `@IsTest` stub `.cls` + `-meta.xml` pairs for Apex classes that lack a corresponding test class; respects `SFDT_API_VERSION` for metadata API version
- `sfdt quality --dry-run` previews stub generation without writing files
- `sfdt deploy` now runs preflight checks before every deployment; use `--skip-preflight` to bypass
- Pre-rollback backup: `rollback.sh` retrieves current org state before applying a rollback manifest; configurable via `config.deployment.backupBeforeRollback` (default `true`) and `SFDT_BACKUP_BEFORE_ROLLBACK`
- Integration tests for `loadConfig()` and `buildScriptEnv()` using real filesystem (no mocks)
- Test fixtures in `test/fixtures/` for Salesforce DX project structures

### Changed
- Coverage threshold in `deployment-assistant.sh` and `deploy-manager.sh` is now driven by `SFDT_COVERAGE_THRESHOLD` instead of being hardcoded at 75%
- `deploy-manager.sh` enforces a coverage gate before production deploys using the configured threshold
- Quality scripts (`test-analyzer.sh`, `code-analyzer.sh`) updated to use `SFDT_` env var model — removed legacy `init_script_env` calls and aligned jq keys with current config schema (`.testClasses[]`, `.apexClasses[]`)
- `scripts/utils/shared.sh` now exports `print_header`, `print_step`, `print_success`, `print_warning`, `print_error`, `print_info` helpers used by rollback, preflight, smoke, and drift scripts
- `buildScriptEnv()` now maps `SFDT_LOG_DIR` from `config.logDir`

### Fixed
- `((VAR++))` arithmetic in `code-analyzer.sh` replaced with `VAR=$((VAR + 1))` — the post-increment form exits 1 under `set -e` when incrementing from 0, killing the script silently
- Division-by-zero in `test-analyzer.sh` coverage table when no Apex classes are configured

## [0.1.5] - 2026-04-06

### Fixed
- Fix CHANGELOG.md not staged for commit during release — `git diff --cached` was checking for already-staged changes instead of unstaged working tree modifications (#11)
- Fix AI-generated release notes only printing to terminal — now written to a configurable directory as `rl-{version}-RELEASE-NOTES.md` (#11)
- Fix release flow ending abruptly with no transition to deployment — now prompts to proceed to deploy (#11)

### Changed
- Move git workflow (commit, tag, push) from shell script into release command for proper sequencing — release notes are now staged alongside manifests and CHANGELOG before commit (#11)
- Add `releaseNotesDir` config option (default: `release-notes`) configurable via `sfdt init` and `.sfdt/config.json`
- Add `SFDT_RELEASE_NOTES_DIR` environment variable for shell scripts
- Add `captureStdout` option to script runner for capturing script output while keeping interactive stdin/stderr
- CI publish now triggers on version bump detection when PRs merge to main, instead of on tag push from any branch

## [0.1.4] - 2026-04-03

### Fixed
- Fix unbound `CHANGES_FILE` variable in release cleanup when script exits early (#7)
- Fix `git add` failure for manifest files ignored by target project's `.gitignore` (#8)
- Prevent quick deploy from being offered when validation ran without tests (e.g., Flow-only deployments)

### Changed
- Automate CHANGELOG updates during release by invoking Claude CLI directly instead of requiring manual copy-paste into another terminal

## [0.1.1] - 2026-04-01

### Added
- `sfdt changelog` command for AI-powered CHANGELOG.md management (`generate`, `release`, `check`)
- GitHub Actions CI/CD with automated npm publishing via Trusted Publishers (OIDC)
- Automated GitHub Release creation with generated release notes
- `npm audit` and publish dry-run steps to CI for increased security
- Formal `ARCHITECTURE.md` developer guide

### Changed
- Updated `package.json` with correct repository and bug report metadata
- Pivoted `IMPLEMENTATION_PLAN.md` to `ARCHITECTURE.md` to reflect production-ready status

## [0.1.0] - 2025-03-29

### Added
- `sfdt init` command to scaffold `.sfdt/` configuration directory in any Salesforce DX project
- `sfdt deploy` interactive deployment workflow with validation, git tagging, and PR creation
- `sfdt release` automated release manifest generation from git diffs
- `sfdt test` parallel Apex test execution with configurable coverage enforcement
- `sfdt quality` code and test quality analysis
- `sfdt preflight` pre-release validation checklist
- `sfdt rollback` deployment rollback support
- `sfdt smoke` post-deploy smoke testing
- `sfdt drift` org metadata drift detection against source
- `sfdt review` AI-powered code review using Claude (optional)
- `sfdt pull` metadata retrieval with configurable pull groups
- `sfdt notify` Slack notifications for deployment events
- Configuration system with `.sfdt/` per-project directory
- Shell script runner with `SFDT_` environment variable injection
- Project auto-detection for Salesforce DX projects
- Structured output formatting with chalk and ora
