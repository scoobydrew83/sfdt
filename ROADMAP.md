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

## Phase 3: AI & Intelligence 🧠 ✅

- [x] **Smart package.xml Generator**: `sfdt manifest` — builds package.xml from git diffs with AI dependency cleanup (`--ai-cleanup`). Supports `--print`, `--destructive`, and custom `--base`/`--head` refs.
- [x] **Error Log Interpreter**: `sfdt explain` — AI-powered analysis of deployment error logs with heuristic fallback for offline use. Reads from file, stdin, or auto-discovers the latest log.
- [x] **PR Description Automator**: `sfdt pr-description` — generates GitHub PR descriptions or Slack messages from deployment changes using AI. Supports `--format github|slack|markdown` and `--output`.

## Phase 4: Platform & Ecosystem 🌐 ✅

- [x] **Other AI Platforms**: Multi-provider AI support — `ai.provider` in `.sfdt/config.json` selects `claude` (Claude Code CLI, default), `gemini` (Google Gemini REST, uses `GEMINI_API_KEY`), or `openai` (OpenAI REST, uses `OPENAI_API_KEY`). `sfdt init` now prompts for provider and optional API key. All AI commands route through the selected provider transparently.
- [x] **Plugin Architecture**: `src/lib/plugin-loader.js` discovers and loads plugins before CLI parsing. Sources (in order): (1) packages listed in `config.plugins[]`, (2) any `sfdt-plugin-*` or `@scope/sfdt-plugin-*` package in the project's `node_modules/`, (3) `.sfdt/plugins/*.js` local scripts. Each plugin exports `register(program)`.
- [x] **Web UI**: `sfdt ui` — launches a local Salesforce Lightning Design System dashboard (built with `@salesforce/design-system-react` + React + Vite) showing test run history, preflight check results, and drift detection status. Build the GUI with `npm run build:gui` from the package root.
- [x] **Docker Support**: `Dockerfile` + `.dockerignore` — mounts a Salesforce DX project at `/project`; ships Node 20, Salesforce CLI, git, jq, and sfdt. Use with `docker run --rm -v "$(pwd):/project" sfdt deploy`.

---

## Feedback & Suggestions

We value community feedback! If you have ideas for features, please open an issue in the repository.
