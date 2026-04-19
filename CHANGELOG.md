# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
