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
- [x] **Web UI**: `sfdt ui` — launches a local Salesforce Lightning Design System dashboard (built with React + Vite) showing test run history, preflight check results, and drift detection status. Build the GUI with `npm run build:gui` from the package root.
- [x] **Docker Support**: `Dockerfile` + `.dockerignore` — mounts a Salesforce DX project at `/project`; ships Node 20, Salesforce CLI, git, jq, and sfdt. Use with `docker run --rm -v "$(pwd):/project" sfdt deploy`.

## Phase 5: AI Intelligence & Developer Experience 🤖 (In Progress)

### AI Roadmap

- [x] **D — AI Chat Drawer**: Persistent chat drawer in the GUI with real token-by-token streaming (Claude `stream-json`, OpenAI `stream: true`, Gemini `streamGenerateContent?alt=sse`). Page-aware context injection: Review, Explain, Drift, and Preflight pages each inject their current results as system-prompt context. "Ask AI" micro-interaction buttons on each page. `Ctrl+Shift+A` global toggle. Full conversation history preserved per session. Stateless server — client sends full history with each POST to `POST /api/ai/chat`.
- [x] **A — Smarter AI Commands**: `sfdt review`, `sfdt explain`, and `sfdt quality --fix-plan` now inject structured project context into every AI prompt — org alias, API version, coverage thresholds, affected metadata types (from git diff), last 3–5 test run history with coverage trend, latest preflight check results, and recent deploy history. Context is built from local log files and config; degrades gracefully when logs are absent.
- [ ] **C — Salesforce DevOps Center MCP Integration**: Connect to Headless360's published MCP tools (GA'd at TDX April 2026) to pull live org state, pipeline status, and work items into sfdt context. Enables the chat drawer to answer questions about deployment pipelines, scratch org pools, and DevOps Center work items.
- [ ] **B — Expose sfdt as MCP Server**: Surface sfdt commands as MCP tools so AI agents (Claude, Copilot, etc.) can invoke `sfdt deploy`, `sfdt preflight`, `sfdt explain` as part of agentic workflows. Partially addressed by existing CLAUDE.md/AGENTS.md skills.

### Developer Experience

- [x] **`sfdt config` command**: `sfdt config set <key> <value>` and `sfdt config get <key>` to read/write `.sfdt/config.json` without hand-editing — especially useful for CI pipelines toggling `deployment.preflight.enforce*` flags. Dot notation supported; values are type-coerced (booleans, numbers).
- [x] **Pre-built GUI in the published package**: `npm run build:gui` runs automatically in CI (`.github/workflows/ci.yml`); `gui/dist/` is included in the npm package `files` array so end users receive the pre-built dashboard on install.
- [ ] **Plugin registry & scaffolding**: `sfdt plugin create` scaffold to bootstrap a new `sfdt-plugin-*` package with example `register(program)` wiring.
- [x] **Structured log format**: unified JSON envelope (`schemaVersion`, `type`, `timestamp`, `exitCode`, `org`, `data`) for test-run, preflight, drift, and quality logs. Machine-parseable by any tool. Each run writes a timestamped archive plus `{type}-latest.json`. `sfdt ui` reader functions preserve existing API response shapes (GUI parity).

---

## Feedback & Suggestions

We value community feedback! If you have ideas for features, please open an issue in the repository.
