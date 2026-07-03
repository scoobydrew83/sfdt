# Gap Remediation & Release-Research Plan — 2026-07-03

Source: full-repo audit (stubs / dead config / parity gaps across CLI, GUI, VS Code, Chrome, host, MCP) plus research into Salesforce Summer '26 (API v67), Spring '26 (API v66), sf CLI 2026 changelogs, and the DevOps ecosystem (sfdx-hardis, Gearset, Copado, sfp, Salesforce Inspector Reloaded 2.0).

Each item lists: what's wrong / what's new, the fix approach, files to touch, and effort (S/M/L). Priorities: **P0** = broken promise / bug, **P1** = high-value gap or time-sensitive release feature, **P2** = parity/uplift, **P3** = opportunistic.

---

## Part 1 — Bugs & broken promises (P0)

### 1.1 `sfdt smoke` can never load configured smoke tests — **S**
`scripts/ops/smoke.sh:61,64,139,141` reads `${CONFIG_DIR}/sfdt.config.json`, but the per-project config file is `.sfdt/config.json` (`src/lib/config.js:15`). The keys it queries (`smokeTests.testClasses`, `deployment.keyClasses`) are also missing from the config template and schema, and `src/commands/smoke.js` never sets `SFDT_SMOKE_TESTS` from config. In CI the script silently exits 0 ("skipping smoke tests").

**Fix:**
- Prefer wiring through the existing env-var pattern: `smoke.js` reads `config.smokeTests.testClasses` and sets `SFDT_SMOKE_TESTS` (comma-joined); keep the script's env-var path as the single source.
- Fix the script's fallback to read `config.json` (not `sfdt.config.json`) for standalone use.
- Add `smokeTests.testClasses` and `deployment.keyClasses` to `src/templates/sfdt.config.json` **and** `src/lib/config-schema.json` (three-places-in-lockstep rule).
- Update the `SFDT_` env-var table in `CLAUDE.md`; add tests in `test/commands/smoke.test.js`.

### 1.2 Deploy manifest detection limited to `rl-*-package.xml` — **DONE (this branch)**
`deployment-assistant.sh` now detects any `.xml` manifest (excluding `*-destructiveChanges.xml`, `*no-overwrite*.xml`, `deploy/`, `deployed/`); `rl-*` manifests keep first position and auto-select preference. Follow-up: mirror in the sfdt-site docs.

### 1.3 CLI deploy can't tag / create PR / notify — **S**
`deployment-assistant.sh` honours `SFDT_TAG_RELEASE`, `SFDT_CREATE_PR`, `SFDT_NOTIFY_SLACK`, but only the GUI sets them (`src/lib/gui-server/index.js:1845-1847`).

**Fix:** add `--tag`, `--create-pr`, `--notify` flags to `src/commands/deploy.js` (interactive path) that set those env vars; document in USAGE.md; tests.

### 1.4 `docs.*` config keys dead or misleading — **S**
- `docs.roleGuides` (template + schema) is read by nothing — `resolveRoleOption` in `src/commands/docs.js` only honours the `--roles` flag.
- `docs.ai` defaults to `true` in the template but can only *disable* AI (the `--ai` flag is still required to enable).
- `docs.diagrams` unread by `docs generate`.

**Fix:** make `docs generate` fall back to config: role guides on when `docs.roleGuides` is truthy (using `docs.roles` list), AI overview on when `features.ai && docs.ai` (add `--no-ai` to override), and honour `docs.diagrams` by running the ER-diagram step during `generate`. Tests for each gate.

### 1.5 `code-analyzer.sh` fabricates a stub result when no scanner installed — **S**
`scripts/quality/code-analyzer.sh:150` emits a stub that can read as a passing scan.

**Fix:** label the stub result unmistakably (`status: "skipped", reason: "sf code-analyzer not installed"`) in output and snapshot; make `sfdt quality` print an actionable warning. (Supersedes itself if item 4.6 Code Analyzer v5 integration lands.)

### 1.6 Dead script tunables — **S**
`SFDT_PARALLEL_DELAY` (`enhanced-test-runner.sh:31`) and `SFDT_DEFAULT_BRANCH` (`deployment-assistant.sh:1463`) are read by scripts but never set by any CLI code.

**Fix:** add `testConfig.parallelDelay` and `defaultBranch` config keys (template + schema) flattened by `buildScriptEnv()`, or remove the script hooks. Update the CLAUDE.md env table either way.

### 1.7 ROADMAP staleness — **DONE (this branch)**
`plugin create` shipped but listed "in progress"; "Expose sfdt as MCP Server" listed as Planned though `mcp-server.js` ships 17 tools; referenced `docs/superpowers/specs/` files do not exist in the repo. ROADMAP rewritten alongside this plan.

---

## Part 2 — Surface parity: GUI, host, MCP, tests (P1–P2)

### 2.1 GUI: run-from-dashboard for Audit / Monitor / Scratch / Data / Docs — **M**
`/api/audit`, `/api/monitor`, `/api/scratch`, `/api/data`, `/api/docs` are GET-only snapshots; sibling pages (Compare/Scan/Flow) have POST run variants.

**Fix:** add POST run endpoints (SSE where long-running, reusing the `/api/command/run` streaming pattern) + "Run now" buttons on `Audit.jsx`, `Monitor.jsx`; scratch create/delete/pool-fill, data export/import, docs generate actions behind confirm dialogs. Keep snapshots raw on disk (JSON-envelope boundary rule).

### 2.2 Native messaging host does no real work — **M** (decide first)
`host/src/index.js:201-215` returns `NOT_IMPLEMENTED` for every substantive kind (quality/deploy/rollback/ai/drift/scan/compare/org-health); only ping/version are handled, while ROADMAP sells it as a "fallback transport."

**Decision then fix:** either (a) implement the kinds by spawning the CLI with `--json` (same pattern as `mcp-server.js`), gated to read-only kinds by default, or (b) reposition it honestly as a liveness/version channel in ROADMAP + extension UI copy. Recommend (a) for read-only kinds (drift/scan/compare/quality/org-health) and (b) for mutating kinds (deploy/rollback), which should stay bridge-only with its token auth.

### 2.3 Chrome Web Store publishing stub — **S** (blocked on secrets)
`.github/workflows/extension.yml:118-145` is commented out pending `CWS_*` secrets. Un-comment behind a `secrets`-present guard (same pattern as the Homebrew tap job) so it activates when the secrets are added and skips cleanly until then.

### 2.4 MCP coverage — **M**
Missing tools for: `test`, `coverage`, `scan`, `dependencies`, `flow`, `explain`, `review`, `release`/`changelog`, `pull`, `scratch`, `data`. Add read-only ones first (`sfdt_test_results`, `sfdt_coverage`, `sfdt_scan`, `sfdt_dependencies`, `sfdt_flow_scan`); gate mutating ones (`sfdt_release`, `sfdt_scratch_create`) behind `confirmExecution` like `sfdt_deploy`/`sfdt_retrofit`.

### 2.5 Test gaps — **S**
Direct unit tests for `src/lib/notifier-formatters.js` (Slack/Teams/Loki/markdown payload shapes) and `src/lib/bridge/middleware.js`.

---

## Part 3 — VS Code uplift (weakest surface; P1)

Today the extension is a terminal launcher + 3 read-only trees + the GUI in an iframe. Sequenced plan:

### 3.1 Native result capture & rendering — **M** (foundation)
Run commands with `--json` via `child_process` (instead of `term.sendText`) for snapshot-producing commands; parse the sf-envelope (`status`/`result`); render audit/monitor/quality/coverage results in native views. Keep the terminal path for interactive commands (deploy picker, init).

### 3.2 Problems-pane diagnostics — **M**
Map snapshot findings that carry file/line (quality, lint-access, future v67 checks) to `vscode.Diagnostic` collections so findings appear inline in editors. Builds directly on 3.1.

### 3.3 Smart-deploy delta preview + execute + quick-deploy — **M**
A webview (or tree + confirm) showing the computed delta, chosen test level, and no-overwrite protections before deploy; add the missing `--smart` execute path (currently validate-only) and a quick-deploy action for a validated job ID (parity with GUI + MCP `sfdt_quick_deploy`).

### 3.4 Test & coverage integration — **M**
Test-run tree from `logs/test-*-latest.json`; editor gutter coverage decoration from the coverage snapshot.

### 3.5 Onboarding & catalog completeness — **S**
A `walkthroughs` contribution (init → first audit → first smart deploy); add missing command families to the catalog (`ci init`, `feature-flags`, `config set/get`, `notify <event>`, `pr-description`, `ai prompt`); severity trends + "open in org" links in the org-health tree; one-click `--notify` dispatch.

### 3.6 Agent-test runner (later, pairs with 4.5) — **L**
CodeLens on agent test-spec files backed by `sf agent test run-eval` / `sf logic run test` with CI-style thresholds.

---

## Part 4 — New features from Summer '26 / Spring '26 / ecosystem research

### CLI

#### 4.1 API v67 readiness check — **M** (P1, time-sensitive)
Summer '26 makes Apex user-mode-by-default at API 67 and `WITH SECURITY_ENFORCED` no longer compiles. New audit/quality check (`sfdt audit api67` or `sfdt quality --api67`) scanning local Apex for `WITH SECURITY_ENFORCED`, sharing-less classes, and system-mode assumptions before a `sourceApiVersion` bump. Feeds VS Code diagnostics (3.2).

#### 4.2 sf CLI credential-redaction adaptation — **S** (P0-adjacent)
Since sf CLI 2.136.8 (May 2026), tokens are redacted from `sf org display --json` / `org list --json`. Audit our scripts/libs for token scraping and switch to `sf org auth show-access-token` where needed (sfdx-hardis already shipped this).

#### 4.3 RunRelevantTests follow-through — **M**
Detect GA (drop the non-prod gate when appropriate); recognise Spring '26 `@IsTest(testFor='...')` / `@IsTest(critical=true)` annotations; add a quality check flagging test classes without `testFor` hints; keep surfacing the known CLI bug (forcedotcom/cli#3565) in docs.

#### 4.4 Unified logic tests — **M**
Wrap `sf logic run test` so `sfdt test` can run Apex + Flow tests in one pass (Flow tests as `FlowTesting.<name>`); include Flow-test outcomes in AI test analysis.

#### 4.5 Agentforce support — **L**
(a) Metadata-mapper coverage for `GenAiFunction`, `GenAiPlannerBundle`, `aiAgentScorerDefinitions`, Agent Script/authoring bundles so smart-deploy deltas include agents. (b) `sfdt agent-test`: wrap `sf agent test run-eval` / the Agentforce Testing REST API with pass/fail thresholds, notifier dispatch, and PR decoration (Gearset sells exactly this).

#### 4.6 Code Analyzer v5 integration — **M**
Run `sf code-analyzer` (PMD 7, `--include-fixes`) inside `sfdt quality`; merge findings into the snapshot/PR comment; optionally feed fixes to the AI fix loop. Replaces the 1.5 stub path.

#### 4.7 New audit/monitor checks — **S each**
- **MFA readiness** (July 1, 2026 phishing-resistant MFA enforcement; hardis parity).
- **SOAP `login()` retirement** (Summer '27; flags API versions 31–64 auth flows).
- **Connected Apps default-off migration** (recommend External Client Apps — extends the existing `connected-apps` check).
- **Elastic async limits**: read `DailyAsyncApexElasticExecutions` / `DailyAsyncApexProcessed` from OrgLimits and warn on overflow capacity.
- **Release channel awareness**: report the org's Release Manager channel + preview/non-preview instance in `monitor org-info`; `retrofit`/`compare` warn when source and target run different release versions.

#### 4.8 Google Chat notifier channel — **S**
Cheap parity with sfdx-hardis: add a `googlechat` provider to `notifier.js`/`notifier-formatters.js` (webhook-based, `webhookUrlEnv` pattern).

#### 4.9 Agent-skills publishing — **M**
Make `sfdt skills export` emit an `npx skills add`-compatible pack (mirroring `forcedotcom/sf-skills`), so coding agents get SFDT-aware workflows.

### Chrome extension

#### 4.10 Summer '26 setup deep links — **S**
Add Field Access Summary, enhanced profile UI, Security Center Essentials, and Release Manager pages to the setup-tabs/nav features.

#### 4.11 Org release/channel badge — **S**
Show release version, preview vs non-preview instance, and Release Manager channel in the extension header (pairs with 4.7's release-channel check).

#### 4.12 Flow Scanner surface — **L**
Inspector Reloaded 2.0 shipped a Flow Scanner + Dependencies Explorer; `@sfdt/flow-core` already has the rules engine — expose an in-browser flow-health panel driven by it.

### Strategic note
sfp community edition was archived (April 2026); commercial players (Copado Agentia, Gearset Org Intelligence, Salesforce DX MCP server) are converging on agentic DevOps + MCP — which plays to SFDT's existing MCP server and AI-provider architecture. Prioritise 2.4 (MCP coverage) and 4.5 (Agentforce) accordingly.

---

## Suggested sequencing

| Sprint | Items |
|---|---|
| 1 (bugs + quick wins) | 1.1, 1.3, 1.4, 1.5, 1.6, 4.2, 4.8, 2.5 |
| 2 (VS Code uplift) | 3.1, 3.2, 3.3, 3.5 |
| 3 (release-driven) | 4.1, 4.7 (MFA + deprecations first), 4.3, 2.1 |
| 4 (depth) | 4.4, 4.6, 2.4, 3.4, 4.10, 4.11 |
| 5 (big bets) | 4.5, 3.6, 4.12, 2.2 |

Every user-facing change must be mirrored to the docs site (`sfdt-site`) in the same effort — including the manifest-detection change already on this branch.
