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
- **MCP server shipped** — `sfdt mcp start` exposes 21 tools (`sfdt_deploy`, `sfdt_audit`, `sfdt_monitor`, `sfdt_retrofit`, `sfdt_coverage`, `sfdt_scan`, `sfdt_dependencies`, `sfdt_flow_scan`, …) with `confirmExecution` gating on mutating operations
- **Generic `http` AI provider** — any OpenAI-compatible `/chat/completions` gateway (Ollama, OpenRouter, MiniMax); secrets referenced by env-var name only
- **New install methods** — `install.sh`, Homebrew tap (auto-bumped by the publish job once `HOMEBREW_TAP_TOKEN` is set), public GHCR Docker image (built from the published npm package on Node 22)
- **VS Code extension live** — `sfdt.sfdt-devtools` on the Marketplace + Open VSX (v0.3.x): command catalog, org-health/status trees, embedded GUI dashboard webview
- **`RunRelevantTests` (Spring '26 beta)** selectable in Release Hub, interactive deploy, and MCP; smart-deploy opt-in via `deployment.smart.useRelevantTests`
- **Smart deploy, retrofit, PR decoration, CI templates, notifications** — see CHANGELOG for the full v0.14–v0.15 cycle

### Gap-remediation & Summer '26 sprints (PRs #171 / #172 / #174 / #175, 2026-07)
- **Bug fixes** — `sfdt smoke` config wiring, deploy manifest detection widened beyond `rl-*`, deploy `--tag/--create-pr/--notify`, live `docs.roleGuides/docs.ai/docs.diagrams` config keys, skipped-scan labelling, dead script tunables wired, credential-redaction sweep
- **Google Chat notifier channel**; direct notifier-formatter and bridge-middleware tests
- **VS Code extension uplift** — native `--json` result rendering, Problems-pane diagnostics, Smart Deploy validate/execute + Quick Deploy, Test Runs view, coverage highlights, Get Started walkthrough, catalog completeness, single consolidated CLI-spawn path
- **API v67 readiness** — `sfdt quality --api67` (Summer '26 user-mode-by-default); `--test-hints` for `@IsTest(testFor=…)` gaps; annotation-aware smart-deploy test selection
- **New org-health checks** — MFA readiness, SOAP `login()` retirement, Connected-Apps migration note, elastic async limits, release version/preview in `monitor org-info` (PR #174)
- **GUI run-from-dashboard** — Audit/Monitor "Run now" + Scratch/Data/Docs actions with in-app confirmations (PR #174)
- **Cross-org release-version warning** (PR #175) — `compare`/`retrofit` warn when the two orgs run different Salesforce releases (shared `src/lib/org-release.js`)

---

## Next Session

Live status + full queue: [docs/plans/2026-07-03-gap-remediation-and-release-research.md](docs/plans/2026-07-03-gap-remediation-and-release-research.md) (see its **Status** section). Snapshot as of 2026-07-05:

- ✅ **Sprint 1 shipped** (PR #171 → develop): smoke config wiring, deploy `--tag/--create-pr/--notify`, live `docs.*` config keys, skipped-scan labelling, Google Chat channel, credential-redaction sweep, formatter/middleware tests.
- ✅ **Sprint 2 shipped** (PR #172 → develop): VS Code native results, Problems-pane diagnostics, Smart Deploy preview/execute + Quick Deploy, onboarding walkthrough, catalog completeness.
- ✅ **Sprint 3 shipped** (PR #174 → develop): `quality --api67`, annotation-aware smart-deploy tests + `quality --test-hints`, GUI run-from-dashboard, new audit/monitor checks (MFA readiness, SOAP login retirement, elastic async limits, release version/preview), VS Code Test Runs view + coverage highlights.
- ✅ **4.7 tail shipped** (PR #175 → develop): cross-org release-version warning for `compare`/`retrofit` (shared `src/lib/org-release.js`).
- **Up next:** remove the temporary `show_full_output` debug flag on the claude-review workflow; fix the always-failing `integration` CI job (DevHub org-auth; no org secrets in PR context); then Sprint 4/5 below. *(A follow-up PR carries doc reconciliation + a verified RunRelevantTests-still-Beta note.)*
- **sfdt-site docs pass** covering all three sprints (needs the `scoobydrew83/sfdt-site` repo added to the session).

---

## Planned

Remaining Sprint 4/5 queue from the 2026-07-03 audit + Summer '26 / Spring '26 release research (details + sequencing in [the plan](docs/plans/2026-07-03-gap-remediation-and-release-research.md)). Items shipped in PRs #171/#172/#174 (API v67 check, RunRelevantTests follow-through, the new audit/monitor checks, Google Chat channel, all VS Code native-surface work, GUI run-from-dashboard) have moved to **Shipped** above.

### CLI
- **Unified logic tests** — wrap `sf logic run test` so `sfdt test` runs Apex + Flow tests in one pass
- **Agentforce support** — Agent metadata (`GenAiFunction`, `GenAiPlannerBundle`, scorers, Agent Script) in smart-deploy deltas; `sfdt agent-test` quality gate over `sf agent test run-eval` / the Testing API
- **Code Analyzer v5 integration** in `sfdt quality` (PMD 7, `--include-fixes` feeding the AI fix loop)
- **Agent-skills pack** compatible with `npx skills add`
- **MCP coverage expansion** — ✅ read-only tools added for coverage/scan/dependencies/flow (test results already via `sfdt_logs`); gated mutating tools (release/scratch/data) still to do
- **Release Manager channel awareness** — *blocked:* the Summer '26 Release Manager Beta exposes no stable queryable public field for the channel; revisit when Salesforce ships a documented API (release version/preview already reported by `monitor org-info`)

### Chrome extension
- **Summer '26 setup deep links** — Field Access Summary, enhanced profile UI, Security Center Essentials, Release Manager
- **Org release/channel badge** — release version, preview vs non-preview, Release Manager channel
- **Flow Scanner surface** powered by `@sfdt/flow-core` (Inspector Reloaded 2.0 parity)

### GUI / host / pipeline
- **Native messaging host: implement read-only kinds** (drift/scan/compare/quality/org-health) by spawning the CLI; keep mutating kinds bridge-only
- **Chrome Web Store publish job** — un-comment behind a secrets-present guard (same pattern as the Homebrew tap job)

---

## Feedback & Suggestions

We value community feedback! If you have ideas for features, please open an issue in the repository.
