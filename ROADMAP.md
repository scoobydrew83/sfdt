# sfdt Project Roadmap

This roadmap outlines the planned features and improvements for the @sfdt/cli tool.

## Phase 1: Core Robustness (Current) ✅

- [x] Standardized configuration loader (`.sfdt/`).
- [x] AI integration (Claude CLI).
- [x] Enhanced Test Runner (Parallel tests).
- [x] Non-interactive mode for CI/CD compatibility.
- [x] Prettier and linting standardization.

## Phase 2: Deployment & Quality ✅

- [x] **Deployment Quality Gates**: Configurable coverage threshold (`SFDT_COVERAGE_THRESHOLD`) enforced in `deployment-assistant.sh` and `deploy-manager.sh`; preflight checks run automatically before every `sfdt deploy`.
- [x] **Rollback Improvements**: `rollback.sh` retrieves and saves current org state before rolling back (partial rollbacks descoped).
- [x] **Test Gaps Analysis**: `sfdt quality --generate-stubs` identifies Apex classes without tests and scaffolds `@IsTest` stub classes; `--dry-run` for preview. Quality scripts fixed to use current `SFDT_` env var model.
- [x] **Integration Tests**: Real-filesystem integration tests for `loadConfig()` and `buildScriptEnv()` with test fixtures in `test/fixtures/`.

## Phase 3: AI & Intelligence 🧠

- [ ] **Smart package.xml Generator**: Automatically build manifests from git diffs with AI cleanup of dependencies.
- [ ] **Error Log Interpreter**: AI-powered analysis of cryptic Salesforce deployment errors with suggested fixes.
- [ ] **PR Description Automator**: Automatically generate a Slack/GitHub message based on deployment changes.

## Phase 4: Platform & Ecosystem 🌐

- [ ] **Other AI Platforms**: Add Gemini, others
- [ ] **Plugin Architecture**: Allow external developers to add custom subcommands and scripts.
- [ ] **Web UI**: A lightweight local web dashboard for monitoring test results and drift detection.
- [ ] **Docker Support**: Official Docker image for use in CI/CD pipelines.

---

## Feedback & Suggestions

We value community feedback! If you have ideas for features, please open an issue in the repository.
