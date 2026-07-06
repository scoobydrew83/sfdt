# Gap Remediation & Release-Research Plan — 2026-07-03

Source: full-repo audit (stubs / dead config / parity gaps across CLI, GUI, VS Code, Chrome, host, MCP) plus research into Salesforce Summer '26 (API v67), Spring '26 (API v66), sf CLI 2026 changelogs, and the DevOps ecosystem (sfdx-hardis, Gearset, Copado, sfp, Salesforce Inspector Reloaded 2.0).

Each item lists: what's wrong / what's new, the fix approach, files to touch, and effort (S/M/L). Priorities: **P0** = broken promise / bug, **P1** = high-value gap or time-sensitive release feature, **P2** = parity/uplift, **P3** = opportunistic.

---

## Status — updated 2026-07-05 (read this first, next session)

**Sprint 1 — SHIPPED.** Merged to `develop` via [PR #171](https://github.com/scoobydrew83/sfdt/pull/171): items 1.1–1.7, 2.5, 4.2, 4.8, plus the `docs.*` config keys and all adversarial-review follow-ups (deploy-flag semantics in both interactive/CI modes, env-over-config precedence for the new tunables, SKIPPED quality snapshots, CI-template auth-URL guidance).

**Sprint 2 — SHIPPED.** Merged to `develop` via [PR #172](https://github.com/scoobydrew83/sfdt/pull/172): items 3.1, 3.2, 3.3, 3.5, plus all claude-review findings (noOrg for preflight/quality, Windows capture(), debounced refreshViews, parseEnvelope skip, stripAnsi reuse) and the claude-review workflow posting fix (least-privilege allowlist). The VS Code extension gained native `--json` result capture + rendering, Problems-pane diagnostics, Smart Deploy validate-and-review + Quick Deploy, a Get Started walkthrough, catalog completeness, no-`--org` handling, Windows `.cmd` spawn support, process-group kill on timeout, and focus-triggered prereq refresh.

**Sprint 3 — SHIPPED.** Merged to `develop` via [PR #174](https://github.com/scoobydrew83/sfdt/pull/174): items 3.4 (VS Code Test Runs view + coverage highlights + `cli.ts`/`run-json.ts` consolidation), 4.1 (`quality --api67`), 4.3 (annotation-aware smart-deploy test selection + `quality --test-hints`), 2.1 (GUI run-from-dashboard for Audit/Monitor/Scratch/Data/Docs), and 4.7 checks (mfa-readiness, soap-logins, connected-apps note, elastic async limits, release version/preview in `monitor org-info`) — plus all claude-review findings from that PR.

**4.7 tail — SHIPPED.** Merged to `develop` via [PR #175](https://github.com/scoobydrew83/sfdt/pull/175): cross-org release-version warning for `compare`/`retrofit` via the shared `src/lib/org-release.js`. The Release Manager **channel** sub-piece is intentionally not built (no stable queryable Beta API — see 4.7 below). A follow-up doc PR ([#176](https://github.com/scoobydrew83/sfdt/pull/176)) carries this Status/ROADMAP reconciliation plus a verified note that RunRelevantTests is still Beta in Summer '26 (so the smart-deploy prod gate `RELEVANT_TESTS_GA_API` stays at 68).

**Next session queue, in order:**
1. **Housekeeping carried across sprints:** remove the temporary `show_full_output: true` debug flag on `.github/workflows/claude-code-review.yml` (added to diagnose 6 residual allowlist denials on #172 — read a review log first, tune the allowlist, then remove); fix the always-failing `integration` CI job (DevHub org-auth; red-Xes every release PR).
2. **Sprint 4/5 (per the appendix):** 4.4 unified logic tests, 4.6 Code Analyzer v5, 2.4 MCP coverage expansion, 4.5 Agentforce, 2.2 native-host decision, 2.3 Chrome Web Store publish job, Chrome items 4.10/4.11/4.12, 4.9 agent-skills pack.

**Outstanding cross-repo work:** the sfdt-site (sfdt.dev) docs pass covering ALL THREE sprints — manifest any-`.xml` detection, deploy `--tag/--create-pr/--notify`, Google Chat channel, `docs.*` config semantics + `--no-ai`/`--no-diagrams`, `smokeTests.testClasses`, `quality --api67`/`--test-hints`, the new audit/monitor checks, GUI run-from-dashboard, the cross-org release warning, and the entire VS Code extension page (native results, diagnostics, smart-deploy/quick-deploy, Test Runs, coverage highlights, walkthrough). Requires adding the `scoobydrew83/sfdt-site` repo to the session.

**Working conventions that produced good results (keep):** parallel agents only on disjoint file sets (pre-commit shared template/schema keys first); sequential stages for the VS Code extension (`extension.ts`/`package.json` are hubs); every stage implement → compile/test/lint/build loop → adversarial reviewer → bounded fix round; orchestrator owns CHANGELOG/CLAUDE.md/ROADMAP and the final full-suite run; one commit per work item.

---

## Part 1 — Bugs & broken promises (P0)

### 1.1 `sfdt smoke` can never load configured smoke tests — **S** — **DONE (PR #171)**
`scripts/ops/smoke.sh:61,64,139,141` reads `${CONFIG_DIR}/sfdt.config.json`, but the per-project config file is `.sfdt/config.json` (`src/lib/config.js:15`). The keys it queries (`smokeTests.testClasses`, `deployment.keyClasses`) are also missing from the config template and schema, and `src/commands/smoke.js` never sets `SFDT_SMOKE_TESTS` from config. In CI the script silently exits 0 ("skipping smoke tests").

**Fix:**
- Prefer wiring through the existing env-var pattern: `smoke.js` reads `config.smokeTests.testClasses` and sets `SFDT_SMOKE_TESTS` (comma-joined); keep the script's env-var path as the single source.
- Fix the script's fallback to read `config.json` (not `sfdt.config.json`) for standalone use.
- Add `smokeTests.testClasses` and `deployment.keyClasses` to `src/templates/sfdt.config.json` **and** `src/lib/config-schema.json` (three-places-in-lockstep rule).
- Update the `SFDT_` env-var table in `CLAUDE.md`; add tests in `test/commands/smoke.test.js`.

### 1.2 Deploy manifest detection limited to `rl-*-package.xml` — **DONE (this branch)**
`deployment-assistant.sh` now detects any `.xml` manifest (excluding `*-destructiveChanges.xml`, `*no-overwrite*.xml`, `deploy/`, `deployed/`); `rl-*` manifests keep first position and auto-select preference. Follow-up: mirror in the sfdt-site docs.

### 1.3 CLI deploy can't tag / create PR / notify — **S** — **DONE (PR #171)**
`deployment-assistant.sh` honours `SFDT_TAG_RELEASE`, `SFDT_CREATE_PR`, `SFDT_NOTIFY_SLACK`, but only the GUI sets them (`src/lib/gui-server/index.js:1845-1847`).

**Fix:** add `--tag`, `--create-pr`, `--notify` flags to `src/commands/deploy.js` (interactive path) that set those env vars; document in USAGE.md; tests.

### 1.4 `docs.*` config keys dead or misleading — **S** — **DONE (PR #171)**
- `docs.roleGuides` (template + schema) is read by nothing — `resolveRoleOption` in `src/commands/docs.js` only honours the `--roles` flag.
- `docs.ai` defaults to `true` in the template but can only *disable* AI (the `--ai` flag is still required to enable).
- `docs.diagrams` unread by `docs generate`.

**Fix:** make `docs generate` fall back to config: role guides on when `docs.roleGuides` is truthy (using `docs.roles` list), AI overview on when `features.ai && docs.ai` (add `--no-ai` to override), and honour `docs.diagrams` by running the ER-diagram step during `generate`. Tests for each gate.

### 1.5 `code-analyzer.sh` fabricates a stub result when no scanner installed — **S** — **DONE (PR #171)**
`scripts/quality/code-analyzer.sh:150` emits a stub that can read as a passing scan.

**Fix:** label the stub result unmistakably (`status: "skipped", reason: "sf code-analyzer not installed"`) in output and snapshot; make `sfdt quality` print an actionable warning. (Supersedes itself if item 4.6 Code Analyzer v5 integration lands.)

### 1.6 Dead script tunables — **S** — **DONE (PR #171)**
`SFDT_PARALLEL_DELAY` (`enhanced-test-runner.sh:31`) and `SFDT_DEFAULT_BRANCH` (`deployment-assistant.sh:1463`) are read by scripts but never set by any CLI code.

**Fix:** add `testConfig.parallelDelay` and `defaultBranch` config keys (template + schema) flattened by `buildScriptEnv()`, or remove the script hooks. Update the CLAUDE.md env table either way.

### 1.7 ROADMAP staleness — **DONE (this branch)**
`plugin create` shipped but listed "in progress"; "Expose sfdt as MCP Server" listed as Planned though `mcp-server.js` ships 17 tools; referenced `docs/superpowers/specs/` files do not exist in the repo. ROADMAP rewritten alongside this plan.

---

## Part 2 — Surface parity: GUI, host, MCP, tests (P1–P2)

### 2.1 GUI: run-from-dashboard for Audit / Monitor / Scratch / Data / Docs — **M** — **DONE (sprint-3 branch)**
`/api/audit`, `/api/monitor`, `/api/scratch`, `/api/data`, `/api/docs` are GET-only snapshots; sibling pages (Compare/Scan/Flow) have POST run variants.

**Fix:** add POST run endpoints (SSE where long-running, reusing the `/api/command/run` streaming pattern) + "Run now" buttons on `Audit.jsx`, `Monitor.jsx`; scratch create/delete/pool-fill, data export/import, docs generate actions behind confirm dialogs. Keep snapshots raw on disk (JSON-envelope boundary rule).

### 2.2 Native messaging host does no real work — **M** (decide first)
`host/src/index.js:201-215` returns `NOT_IMPLEMENTED` for every substantive kind (quality/deploy/rollback/ai/drift/scan/compare/org-health); only ping/version are handled, while ROADMAP sells it as a "fallback transport."

**Decision then fix:** either (a) implement the kinds by spawning the CLI with `--json` (same pattern as `mcp-server.js`), gated to read-only kinds by default, or (b) reposition it honestly as a liveness/version channel in ROADMAP + extension UI copy. Recommend (a) for read-only kinds (drift/scan/compare/quality/org-health) and (b) for mutating kinds (deploy/rollback), which should stay bridge-only with its token auth.

### 2.3 Chrome Web Store publishing stub — **S** (blocked on secrets)
`.github/workflows/extension.yml:118-145` is commented out pending `CWS_*` secrets. Un-comment behind a `secrets`-present guard (same pattern as the Homebrew tap job) so it activates when the secrets are added and skips cleanly until then.

### 2.4 MCP coverage — **M**
Missing tools for: `test`, `coverage`, `scan`, `dependencies`, `flow`, `explain`, `review`, `release`/`changelog`, `pull`, `scratch`, `data`. Add read-only ones first (`sfdt_test_results`, `sfdt_coverage`, `sfdt_scan`, `sfdt_dependencies`, `sfdt_flow_scan`); gate mutating ones (`sfdt_release`, `sfdt_scratch_create`) behind `confirmExecution` like `sfdt_deploy`/`sfdt_retrofit`.

### 2.5 Test gaps — **S** — **DONE (PR #171)**
Direct unit tests for `src/lib/notifier-formatters.js` (Slack/Teams/Loki/markdown payload shapes) and `src/lib/bridge/middleware.js`.

---

## Part 3 — VS Code uplift (weakest surface; P1)

Today the extension is a terminal launcher + 3 read-only trees + the GUI in an iframe. Sequenced plan:

### 3.1 Native result capture & rendering — **M** (foundation) — **DONE (sprint-2 branch)**
Run commands with `--json` via `child_process` (instead of `term.sendText`) for snapshot-producing commands; parse the sf-envelope (`status`/`result`); render audit/monitor/quality/coverage results in native views. Keep the terminal path for interactive commands (deploy picker, init).

### 3.2 Problems-pane diagnostics — **M** — **DONE (sprint-2 branch)**
Map snapshot findings that carry file/line (quality, lint-access, future v67 checks) to `vscode.Diagnostic` collections so findings appear inline in editors. Builds directly on 3.1.

### 3.3 Smart-deploy delta preview + execute + quick-deploy — **M** — **DONE (sprint-2 branch)**
A webview (or tree + confirm) showing the computed delta, chosen test level, and no-overwrite protections before deploy; add the missing `--smart` execute path (currently validate-only) and a quick-deploy action for a validated job ID (parity with GUI + MCP `sfdt_quick_deploy`).

### 3.4 Test & coverage integration — **M** — **DONE (sprint-3 branch, incl. run-json/cli.ts consolidation)**
Test-run tree from `logs/test-*-latest.json`; editor gutter coverage decoration from the coverage snapshot. Also fold in the deferred PR #172 review finding: consolidate `vscode/src/lib/run-json.ts`'s spawn/envelope path with `cli.ts`'s `runSfdt`/`runSfdtJson` so the extension has one "run sfdt and read JSON" implementation (move the timeout/AbortSignal/Windows-shell/process-group-kill improvements into the shared module).

### 3.5 Onboarding & catalog completeness — **S** — **DONE (sprint-2 branch)**
A `walkthroughs` contribution (init → first audit → first smart deploy); add missing command families to the catalog (`ci init`, `feature-flags`, `config set/get`, `notify <event>`, `pr-description`, `ai prompt`); severity trends + "open in org" links in the org-health tree; one-click `--notify` dispatch.

### 3.6 Agent-test runner (later, pairs with 4.5) — **L**
CodeLens on agent test-spec files backed by `sf agent test run-eval` / `sf logic run test` with CI-style thresholds.

---

## Part 4 — New features from Summer '26 / Spring '26 / ecosystem research

### CLI

#### 4.1 API v67 readiness check — **M** (P1, time-sensitive) — **DONE (sprint-3 branch: `quality --api67`)**
Summer '26 makes Apex user-mode-by-default at API 67 and `WITH SECURITY_ENFORCED` no longer compiles. New audit/quality check (`sfdt audit api67` or `sfdt quality --api67`) scanning local Apex for `WITH SECURITY_ENFORCED`, sharing-less classes, and system-mode assumptions before a `sourceApiVersion` bump. Feeds VS Code diagnostics (3.2).

#### 4.2 sf CLI credential-redaction adaptation — **S** (P0-adjacent) — **DONE (PR #171)**
Since sf CLI 2.136.8 (May 2026), tokens are redacted from `sf org display --json` / `org list --json`. Audit our scripts/libs for token scraping and switch to `sf org auth show-access-token` where needed (sfdx-hardis already shipped this).

#### 4.3 RunRelevantTests follow-through — **M** — **DONE (sprint-3 branch: testFor/critical selection + `quality --test-hints`; GA detection intentionally deferred — no reliable GA signal yet; annotation widening fires only on RunSpecifiedTests by design)**
Detect GA (drop the non-prod gate when appropriate); recognise Spring '26 `@IsTest(testFor='...')` / `@IsTest(critical=true)` annotations; add a quality check flagging test classes without `testFor` hints; keep surfacing the known CLI bug (forcedotcom/cli#3565) in docs.

#### 4.4 Unified logic tests — **M**
Wrap `sf logic run test` so `sfdt test` can run Apex + Flow tests in one pass (Flow tests as `FlowTesting.<name>`); include Flow-test outcomes in AI test analysis.

#### 4.5 Agentforce support — **L**
(a) Metadata-mapper coverage for `GenAiFunction`, `GenAiPlannerBundle`, `aiAgentScorerDefinitions`, Agent Script/authoring bundles so smart-deploy deltas include agents. (b) `sfdt agent-test`: wrap `sf agent test run-eval` / the Agentforce Testing REST API with pass/fail thresholds, notifier dispatch, and PR decoration (Gearset sells exactly this).

#### 4.6 Code Analyzer v5 integration — **M**
Run `sf code-analyzer` (PMD 7, `--include-fixes`) inside `sfdt quality`; merge findings into the snapshot/PR comment; optionally feed fixes to the AI fix loop. Replaces the 1.5 stub path.

#### 4.7 New audit/monitor checks — **S each** — **DONE (PR #174 + PR #175)**

> **Status:** mfa-readiness, soap-logins, connected-apps migration note, elastic async limits, and release-version/preview in `monitor org-info` shipped in PR #174. The **cross-org release-version warning** for `compare`/`retrofit` shipped in PR #175 (shared `src/lib/org-release.js`). The **Release Manager *channel*** sub-piece (Standard/Accelerated/Dev) is **intentionally not implemented**: the Summer '26 Release Manager is Beta and exposes no stable, queryable public field for the channel — inventing a SOQL field would fail in every org (the exact anti-pattern earlier adversarial reviews caught). Revisit once Salesforce ships a documented API for it.
- **MFA readiness** (July 1, 2026 phishing-resistant MFA enforcement; hardis parity).
- **SOAP `login()` retirement** (Summer '27; flags API versions 31–64 auth flows).
- **Connected Apps default-off migration** (recommend External Client Apps — extends the existing `connected-apps` check).
- **Elastic async limits**: read `DailyAsyncApexElasticExecutions` / `DailyAsyncApexProcessed` from OrgLimits and warn on overflow capacity.
- **Release channel awareness**: report the org's Release Manager channel + preview/non-preview instance in `monitor org-info`; `retrofit`/`compare` warn when source and target run different release versions.

#### 4.8 Google Chat notifier channel — **S** — **DONE (PR #171)**
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

---

## Appendix — Sprint execution schedule (agent-driven)

Execution model: each sprint runs as a wave of parallel agents on **disjoint file sets** (shared files — config template, schema, CHANGELOG, CLAUDE.md — are edited once, up front or at consolidation, never concurrently). Every agent runs its own verification loop (implement → targeted vitest → eslint → fix until green); every wave ends with a full-suite run plus one **adversarial reviewer per item** whose job is to refute the change; confirmed findings loop back into a fix round before commit. One commit per work item.

### Sprint 1 — bugs & quick wins — ✅ SHIPPED (PR #171)
| Order | Item | Files (ownership) | Depends on |
|---|---|---|---|
| 0 | Pre-work: config keys (`defaultBranch`, `smokeTests`, `deployment.keyClasses`, `googlechat` enum) | template + schema | — |
| 1a | 1.1 + 1.6 smoke config wiring + dead tunables | `smoke.sh`, `smoke.js`, `script-runner.js` | 0 |
| 1b | 1.3 deploy `--tag/--create-pr/--notify` | `deploy.js`, USAGE.md | 0 |
| 1c | 1.4 `docs.*` config keys made real | `docs.js`, `doc-generator.js` | — |
| 1d | 1.5 analyzer stub → labelled "skipped" | `code-analyzer.sh`, `quality.js` | — |
| 1e | 4.8 + 2.5 Google Chat channel + formatter/middleware tests | `notifier*.js`, new tests | 0 |
| 1f | 4.2 credential-redaction sweep | scripts/src minus 1a–1e files | — |
| 2 | Consolidation: CHANGELOG, CLAUDE.md env table, docs-site staleness list | shared docs | 1a–1f |

### Sprint 2 — VS Code uplift — ✅ COMPLETE except 3.4 (on sprint-2 branch, PR pending)
1. **3.1 native `--json` capture** (foundation; `vscode/src/lib/` runner module + result types)
2. **3.2 Problems-pane diagnostics** (consumes 3.1's parsed results)
3. **3.3 smart-deploy preview / execute / quick-deploy** (uses 3.1 runner; new webview)
4. **3.5 walkthrough + catalog completeness** (independent — can run parallel to 2–3)
Parallelizable: 3.5 with any; 3.2 and 3.3 only after 3.1 lands.

### Sprint 3 — release-driven checks (all parallel; independent checks)
- **4.1 API v67 readiness check** (new lib + audit/quality wiring; feeds VS Code diagnostics later)
- **4.7a MFA readiness** · **4.7b SOAP login retirement** · **4.7c Connected-Apps migration** · **4.7d elastic async limits** · **4.7e release-channel awareness** (each a self-contained audit/monitor check + template/schema defaults pre-added in one commit)
- **4.3 RunRelevantTests follow-through** (smart-deploy + quality check)
- **2.1 GUI run-from-dashboard** (gui-server routes + pages; disjoint from checks)

### Sprint 4 — depth (parallel except where noted)
- **4.4 unified logic tests** (`test` command + runner script)
- **4.6 Code Analyzer v5 integration** (replaces 1.5's stub path — sequence after 1d)
- **2.4 MCP coverage expansion** (read-only tools first)
- **3.4 VS Code test/coverage integration** (after Sprint 2's 3.1)
- **4.10 Chrome setup deep links** · **4.11 org release/channel badge**

### Sprint 5 — big bets (each is its own multi-agent effort)
- **4.5 Agentforce** (metadata-mapper coverage, then `agent-test` gate)
- **3.6 VS Code agent-test runner** (after 4.5)
- **4.12 Chrome Flow Scanner surface** (flow-core powered)
- **2.2 native-host read-only kinds** (decision recorded in plan §2.2)

Cross-cutting rule: every wave's consolidation step updates CHANGELOG.md, the CLAUDE.md env-var table when `SFDT_*` vars change, and queues the matching sfdt-site (sfdt.dev) content updates.
