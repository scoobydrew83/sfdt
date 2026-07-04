# sfdt Project Roadmap

## Shipped

### Core & Configuration
- Standardized `.sfdt/` configuration loader with `sfdt init` and `sfdt config set/get`
- Non-interactive mode for CI/CD compatibility
- ESLint + Prettier standardization

### Deployment & Quality
- Configurable coverage threshold enforced in preflight and deploy
- Automatic preflight checks before every `sfdt deploy`
- Rollback with pre-rollback org state capture
- `sfdt quality --generate-stubs` — identify untested Apex classes and scaffold `@IsTest` stubs
- `sfdt compare` — metadata comparison between two orgs or an org vs local source; `--output` generates a package.xml of source-only items

### AI & Intelligence
- `sfdt manifest` — package.xml from git diffs with AI dependency cleanup
- `sfdt explain` — AI-powered deployment error log analysis with heuristic fallback
- `sfdt pr-description` — AI-generated GitHub PR descriptions and Slack summaries
- `sfdt review`, `sfdt explain`, `sfdt quality --fix-plan` — structured project context injected into every AI prompt (org, API version, test history, coverage trend, preflight results, deploy history)
- Multi-provider AI: `claude` (Claude Code CLI), `gemini` (REST), `openai` (REST)

### Web UI
- `sfdt ui` — local SLDS dashboard (React + Vite) with test history, preflight, drift, and quality views
- AI Chat Drawer — token-by-token streaming, page-aware context injection, `Ctrl+Shift+A` toggle
- "Ask AI" buttons on Review, Explain, Drift, and Preflight pages
- Log History Viewer — browse all structured logs by type, filter, and expand detail rows
- Structured log format — JSON envelopes (`schemaVersion`, `type`, `timestamp`, `exitCode`, `org`, `data`) across all log types with timestamped archives and `*-latest.json` pointers
- Compare page — run org-vs-org or org-vs-local comparisons and browse diff results in the dashboard
- Settings page — view and edit `.sfdt/config.json` values directly from the browser dashboard

### Platform & Ecosystem
- Plugin architecture — load from `config.plugins[]`, auto-discover `sfdt-plugin-*` packages, or drop `.sfdt/plugins/*.js` local files
- Docker support — mounts a Salesforce DX project at `/project`; ships Node 20, Salesforce CLI, git, jq, and sfdt
- DevOps Center MCP integration — pipeline status and work items injected into chat context when `config.mcp.enabled` is true; targeted Headless360 tool calling via `SalesforceMcpClient` for live pipeline and work-item data in the AI chat drawer
- sfdt skills library — 10 Salesforce domain skills for use with AI agents (apex-review, data, deploy, flow-review, lwc, org-audit, pmd-scan, scratch-org, test, sfdt-cli)
- Pre-built GUI included in the published npm package

### Chrome extension (`@sfdt/extension`)
- 14 productivity features for Salesforce Flow Builder and Setup — full list in [extension/README.md](extension/README.md)
- Three-layer feature gating — remote kill-switch (`.sfdt/feature-flags.json`) → per-user toggle → context filter
- Opt-in local telemetry (no network egress); snapshot pushed to `.sfdt/telemetry-snapshot.json` for `sfdt extension stats`
- Registry-driven options page — adding a feature with a Zod settings schema auto-generates its controls
- Privacy policy declared in [extension/PRIVACY.md](extension/PRIVACY.md)

### Native messaging host (`@sfdt/host`)
- Stdio loop with installers for Chrome / Edge / Brave / Chromium / Vivaldi on macOS, Linux, and Windows
- One-command install via `sfdt extension install-host --extension-id <id>`
- Fallback transport when the HTTP bridge (`sfdt ui`) isn't running

### Shared library (`@sfdt/flow-core`)
- Flow normalization, rules engine, scoring — same code path on the CLI and in the extension so verdicts match byte-for-byte
- Versioned bridge contract (`PROTOCOL_VERSION`, `negotiateProtocolVersion`) — extension and CLI warn on minor mismatch, refuse on major mismatch

### Bridge + diagnostics
- `GET /api/bridge/ping` and `POST /api/bridge/exchange` mounted by `sfdt ui`; surfaces `disabledFeatures` from `.sfdt/feature-flags.json` and `protocolVersion` for negotiation
- `sfdt feature-flags` CLI for operator-friendly kill-switch management
- `sfdt extension stats` CLI for telemetry visibility
- `sfdt doctor --extension` end-to-end health check (bridge / native host / kill-switch / telemetry)

### Since v0.14.0 (previously unlisted here)
- **`sfdt plugin create`** — scaffolds a new `sfdt-plugin-*` package with example `register(program)` wiring, test, and README
- **MCP server shipped** — `sfdt mcp start` exposes 17 tools (`sfdt_deploy`, `sfdt_audit`, `sfdt_monitor`, `sfdt_retrofit`, …) with `confirmExecution` gating on mutating operations
- **Generic `http` AI provider** — any OpenAI-compatible `/chat/completions` gateway (Ollama, OpenRouter, MiniMax); secrets referenced by env-var name only
- **New install methods** — `install.sh`, Homebrew tap (auto-bumped by the publish job once `HOMEBREW_TAP_TOKEN` is set), public GHCR Docker image (built from the published npm package on Node 22)
- **VS Code extension live** — `sfdt.sfdt-devtools` on the Marketplace + Open VSX (v0.3.x): command catalog, org-health/status trees, embedded GUI dashboard webview
- **`RunRelevantTests` (Spring '26 beta)** selectable in Release Hub, interactive deploy, and MCP; smart-deploy opt-in via `deployment.smart.useRelevantTests`
- **Smart deploy, retrofit, PR decoration, CI templates, notifications** — see CHANGELOG for the full v0.14–v0.15 cycle

---

## Next Session

Live status + full queue: [docs/plans/2026-07-03-gap-remediation-and-release-research.md](docs/plans/2026-07-03-gap-remediation-and-release-research.md) (see its **Status** section). Snapshot as of 2026-07-04:

- ✅ **Sprint 1 shipped** (PR #171 → develop): smoke config wiring, deploy `--tag/--create-pr/--notify`, live `docs.*` config keys, skipped-scan labelling, Google Chat channel, credential-redaction sweep, formatter/middleware tests.
- ✅ **Sprint 2 complete on the working branch** (PR pending): VS Code native results, Problems-pane diagnostics, Smart Deploy preview/execute + Quick Deploy, onboarding walkthrough, catalog completeness.
- **Up next:** PR sprint 2 → develop; VS Code test/coverage integration (plan 3.4); then Sprint 3 (API v67 readiness check, MFA/deprecation/limits/release-channel checks, RunRelevantTests follow-through, GUI run-from-dashboard).
- **Fix the always-failing `integration` CI job** — it red-X's every release PR (DevHub org-auth; no org secrets in PR context). Wire the auth, restrict to non-PR runs, or mark non-required.
- **sfdt-site docs pass** covering both sprints (needs the `scoobydrew83/sfdt-site` repo added to the session).

---

## Planned

Grouped queue from the 2026-07-03 audit + Summer '26 / Spring '26 release research (details + sequencing in [the plan](docs/plans/2026-07-03-gap-remediation-and-release-research.md)):

### CLI
- **API v67 readiness check** — flag `WITH SECURITY_ENFORCED` (no longer compiles at v67), sharing-less classes, and system-mode assumptions before a `sourceApiVersion` bump (Summer '26 user-mode-by-default Apex)
- **New audit/monitor checks** — MFA readiness (July 2026 enforcement), SOAP `login()` retirement (Summer '27), Connected-Apps-default-off migration, elastic async limits (`DailyAsyncApexElasticExecutions`), Release Manager channel awareness
- **RunRelevantTests follow-through** — GA detection, `@IsTest(testFor=…)` / `@IsTest(critical=true)` awareness, quality check for missing `testFor` hints
- **Unified logic tests** — wrap `sf logic run test` so `sfdt test` runs Apex + Flow tests in one pass
- **Agentforce support** — Agent metadata (`GenAiFunction`, `GenAiPlannerBundle`, scorers, Agent Script) in smart-deploy deltas; `sfdt agent-test` quality gate over `sf agent test run-eval` / the Testing API
- **Code Analyzer v5 integration** in `sfdt quality` (PMD 7, `--include-fixes` feeding the AI fix loop)
- **Google Chat notifier channel**; **agent-skills pack** compatible with `npx skills add`
- **MCP coverage expansion** — read-only tools for test/coverage/scan/dependencies/flow first; gated mutating tools after

### VS Code extension (priority surface)
- **Native result rendering** — capture `--json` output instead of terminal-only, render audit/monitor/quality/coverage natively
- **Problems-pane diagnostics** from snapshot findings with file/line (quality, lint-access, future v67 checks)
- **Smart-deploy delta preview, execute, and quick-deploy** (currently validate-only)
- **Test tree + editor gutter coverage** from CLI snapshots
- **Onboarding walkthrough** and catalog completeness (`ci init`, `feature-flags`, `config set/get`, `notify <event>`, `pr-description`, `ai prompt`)

### Chrome extension
- **Summer '26 setup deep links** — Field Access Summary, enhanced profile UI, Security Center Essentials, Release Manager
- **Org release/channel badge** — release version, preview vs non-preview, Release Manager channel
- **Flow Scanner surface** powered by `@sfdt/flow-core` (Inspector Reloaded 2.0 parity)

### GUI / host / pipeline
- **Run-from-dashboard** for Audit, Monitor, Scratch, Data, Docs (POST/SSE endpoints + buttons; pages are currently snapshot-only)
- **Native messaging host: implement read-only kinds** (drift/scan/compare/quality/org-health) by spawning the CLI; keep mutating kinds bridge-only
- **Chrome Web Store publish job** — un-comment behind a secrets-present guard (same pattern as the Homebrew tap job)

---

## Feedback & Suggestions

We value community feedback! If you have ideas for features, please open an issue in the repository.
