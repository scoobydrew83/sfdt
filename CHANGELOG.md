# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
