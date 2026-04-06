# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
