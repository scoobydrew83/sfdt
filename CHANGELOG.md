# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`sfdt test --class-names <list>`** — run only a specific comma-separated set of Apex test classes, overriding the configured `testConfig.testClasses` for that run (the runner already batches whatever list it's given). Powers the VS Code "▶ Run test class" CodeLens and targeted CI runs.

- **Native messaging host now serves the read-only kinds.** The Chrome extension's fallback transport (`@sfdt/host`, used when the `sfdt ui` HTTP bridge isn't running) previously answered only `ping`/`version` and returned `NOT_IMPLEMENTED` for everything else. It now handles the read-only kinds — `quality` (in-process via `@sfdt/flow-core`, no org/project needed), plus `scan`/`compare`/`drift`/`org-health` (which spawn the `sfdt` CLI or read `logs/*-latest.json`, reshaped to match the HTTP bridge's response contract). Mutating kinds (`deploy`/`rollback`/`ai`) stay bridge-only. Because Chrome launches the host outside any project, `sfdt extension install-host` now records the project root in a host config file (`~/.config/sfdt-host.json`); a new `--project-root <path>` flag overrides the auto-detected project, and the host also honours `SFDT_PROJECT_ROOT`.

- **`sfdt skills export --target pack`** — emit an [`npx skills add`](https://github.com/vercel-labs/skills)-compatible skills pack (a root `manifest.json` plus a copy of every skill folder) so coding agents can install SFDT's Salesforce workflows the same way as `forcedotcom/sf-skills`. The manifest mirrors the vercel-labs/skills schema (`version`, `skills[]` with `name`/`path`/`folderPath`/`category`/`files`/`description`); output directory is `--out` (default `./sfdt-skills-pack`). The existing IDE-rules targets (`claude`/`cursor`/`codex`/`windsurf`) are unchanged. The package now ships `skills/`, so the export works from a global install.

- **`sfdt agent-test`** — run an Agentforce agent test (`sf agent test run`, an `AiEvaluationDefinition`) as a CI gate. Pass/fail comes from the CLI exit code; `--notify` dispatches an `agent-test-success`/`agent-test-failure` notification and `--pr-comment` decorates the current PR. Flags: `--spec` (required), `--org`, `--wait`. (A numeric pass-rate threshold is a planned follow-up pending confirmation of the agent-test JSON schema.)

- **Agentforce metadata in smart-deploy deltas and manifests.** The metadata mapper (and its shell mirror) now recognise Agentforce / Einstein agent types — `Bot`, `BotVersion` (member `Bot.Version`), `GenAiPlanner`, `GenAiPlannerBundle`, `GenAiPlugin`, `GenAiFunction`, `GenAiPromptTemplate`, `AiEvaluationDefinition`, and `AiAuthoringBundle` (the Agent Script authoring bundle, folder-detected since its `.bundle-meta.xml`/`.agent` files have no distinctive suffix). Previously these changes mapped to UNKNOWN and were silently dropped from `deploy --smart` deltas and `sfdt manifest` output. Suffixes/directories verified against the Salesforce metadata registry.

### Added

- **Four new read-only MCP tools** — `sfdt_coverage` (Apex coverage), `sfdt_scan` (org metadata inventory), `sfdt_dependencies` (component references), and `sfdt_flow_scan` (Flow quality analysis), each wrapping the existing `--json` CLI command. Brings the MCP surface to 21 tools.

- **Salesforce Code Analyzer v5 in `sfdt quality`.** The static scan now runs `sf code-analyzer run` (the v5 just-in-time plugin — PMD 7, ESLint, RetireJS) instead of the retired v4 `sf scanner run`, falling back to v4 only if that's the only plugin present and otherwise reporting the scan as SKIPPED (never a fabricated clean result). New `--include-fixes` requests actionable fixes/suggestions (`--include-fixes --include-suggestions`), enriching the output that `--fix-plan` feeds to the AI. The result parser handles the v5 flat `violations[]`/`locations[]` shape in addition to v4 and the skip marker.

- **`sfdt test --logic`** — run Apex and Flow tests together in one pass via Salesforce's Spring '26 `sf logic run test` (Flow tests named `FlowTesting.<name>`; requires the org "View All Data" permission). Flags: `--org`, `--test-level`, `--tests`, `--category Apex|Flow`, `--code-coverage`, `--wait` (default 30 min; the underlying command is async and sfdt waits for results). Arg building lives in the pure, unit-tested `src/lib/logic-test.js`. On failure (with `features.ai`) sfdt offers AI failure analysis for logic runs too — the shared analyzer feeds it the captured run output (logic results aren't written to the standard result dir), and every provider gets the context injected.

### Added

- **Cross-org release-version warning.** `sfdt compare` and `sfdt retrofit` now detect when the two orgs run different Salesforce releases (best-effort via each org's REST version list) and print a heads-up before comparing/deploying — metadata valid on one release may not deploy cleanly to another. Non-fatal and skipped for org↔local comparisons or when a release can't be determined; `retrofit --json` reports it as `releaseMismatch`. The release-detection helper (`expectedGaApiVersion`/`detectOrgRelease`, previously private to the monitor runner) moved to a shared `src/lib/org-release.js`.

### Added

- **`sfdt quality --api67`** — API v67 (Summer '26 user-mode-by-default) readiness scan of local Apex: flags `WITH SECURITY_ENFORCED` (no longer compiles at v67), classes with no sharing declaration, and `without sharing` classes doing DML/SOQL; `--json` emits the sf envelope; exit code 1 only when blocking errors exist and `sourceApiVersion` ≥ 67. Comment/string-sanitized scanning avoids false positives.
- **`sfdt quality --test-hints`** — advisory check flagging `@IsTest` classes that carry no `@IsTest(testFor=...)` annotation (invisible to Spring '26 RunRelevantTests selection and to smart deploy's annotation-aware widening).
- **Annotation-aware smart-deploy test selection.** When smart deploy picks `RunSpecifiedTests`, it now also includes test classes whose `@IsTest(testFor='Type:Name')` targets a changed component and every `@IsTest(critical=true)` class, merged with the existing name-heuristic selection.
- **New org-health checks.** `audit mfa-readiness` (users without phishing-resistant MFA — security key, WebAuthn, or built-in authenticator — ahead of the July 2026 enforcement), `audit soap-logins` (SOAP `login()` traffic on API versions 31–64, retiring Summer '27, configurable `audit.soapLoginLookbackDays`); the connected-apps check now notes the External Client Apps migration; `monitor limits` reports the Summer '26 elastic async Apex entries when present and warns in the overflow band; `monitor org-info` reports the org's release version and preview status. All degrade to warn when the org can't run them.
- **GUI: run from the dashboard.** Audit and Monitor pages gained "Run now" (SSE-streamed); Scratch, Data, and Docs pages gained real create/delete/pool-fill, export/import/delete, and generate actions — mutating actions behind in-app confirmation dialogs that also work inside the VS Code-embedded dashboard (no `window.confirm`).

### Added

- **`sfdt deploy --tag / --create-pr / --notify`.** The post-deploy automations the deployment script always supported (git tag, PR creation via `gh`, success/failure notifications) were only reachable from the GUI Release Hub; they are now first-class CLI flags. `--tag` pre-selects "tag after deployment" in interactive runs and tags automatically in CI; `--create-pr` and `--notify` work in both modes (the non-interactive path now also sends the deploy-success event, which it previously never did). Flags apply to the standard manifest deploy only — combining them with `--smart`, `--managed`, or `--source-dir` warns instead of silently doing nothing.
- **Google Chat notification channel.** `notifications.channels[]` accepts `type: "googlechat"` (incoming-webhook based, secret referenced by env-var name via `webhookUrlEnv`), with the same `events` filter and `severityThreshold` semantics as Slack/Teams.
- **`docs.*` config keys now drive `sfdt docs generate`.** `docs.roleGuides` (with `docs.roles`) enables AI role guides without the `--roles` flag (gated on `features.ai`); AI overviews default on when `features.ai && docs.ai !== false` with new `--no-ai` to force off (`--ai` still forces on); `docs.diagrams` emits the ER-diagram page (`diagrams/erd.md`, linked in the MkDocs nav) during `generate`, with `--no-diagrams` to opt out.
- **Config-driven smoke tests and script tunables.** `smokeTests.testClasses` now reaches `sfdt smoke` (via `SFDT_SMOKE_TESTS`), and `defaultBranch` / `testConfig.parallelDelay` are flattened to `SFDT_DEFAULT_BRANCH` / `SFDT_PARALLEL_DELAY`. For all three, a user-exported env var wins over config.

### Fixed

- **`sfdt smoke` could never load configured smoke tests** — the script read a config filename that doesn't exist (`.sfdt/sfdt.config.json` instead of `.sfdt/config.json`), so configured test classes were silently ignored and CI runs skipped smoke tests entirely.
- **A missing code scanner no longer reads as a passing quality scan.** `code-analyzer.sh` labels its fallback result `status: "skipped"` with a reason, `sfdt quality` prints an explicit warning with install instructions, and the GUI/snapshot parser reports `SKIPPED` (with the real reason — a crashed scanner is no longer mislabelled "not installed") instead of a clean `PASS`.
- **CI monitor template no longer suggests scraping the auth URL from `sf org display`** — since sf CLI 2.136.8 that output is redacted; the template now points at `sf org auth show-sfdx-auth-url`. (A repo-wide sweep confirmed no sfdt code parses redacted fields.)

### Changed

- **`sfdt deploy` now detects any `.xml` manifest in the manifest directory, not just the generated `rl-*-package.xml` convention.** The interactive picker and the non-interactive auto-select both offer plain `package.xml` files, `sf project generate manifest` output, and un-named `sfdt manifest` previews (`preview-package.xml`). Versioned `rl-*` manifests are still listed first (and still preferred by auto-select); companion `*-destructiveChanges.xml` and `*no-overwrite*.xml` files are excluded, as are the `deploy/` and `deployed/` subfolders. The "no manifests found" error now says what was searched and how to generate one.



## [0.15.2] - 2026-07-02

### Added

- **`RunRelevantTests` support (Salesforce Spring '26 beta, API 66+).** The new Salesforce test level — the org analyzes the deployment payload and runs only the tests relevant to it — is now selectable everywhere a test level can be chosen manually: the GUI Release Hub deploy step, the interactive deployment assistant menu, and the MCP `sfdt_validate`/`sfdt_deploy` tools. Smart deploy can opt in via `deployment.smart.useRelevantTests` (default `false`): on a non-production org with `sourceApiVersion` ≥ 66 it replaces the `RunLocalTests` fallback; production deploys are never auto-downgraded and stay pinned to `RunLocalTests`. Caveat: the feature is beta and a known sf CLI issue ([forcedotcom/cli#3565](https://github.com/forcedotcom/cli/issues/3565)) can cause `deploy validate` to run zero tests with this level — verify with `--json` output.

### Changed

- **Bumped `@sfdt/flow-core` to 0.9.4** — record-triggered flow **event** detection now reads `recordTriggerType` (the `triggerType` field holds the *timing* — before/after save — not the event). Previously every save-triggered flow's event normalised to "Unknown", collapsing distinct Create-only and Update-only flows into a single conflict bucket, so `audit`/Flow Intelligence reported trigger conflicts that don't exist. Affects every flow-core consumer (CLI, GUI, Chrome extension, VS Code extension).

### Fixed

- **The VS Code dashboard webview can embed the GUI again.** The GUI server now sends `Content-Security-Policy: frame-ancestors 'self' vscode-webview:` instead of `X-Frame-Options: SAMEORIGIN`, which blocked the cross-origin `vscode-webview://` frame and left the dashboard panel blank. Framing by arbitrary web origins remains blocked, and the server still binds to localhost only.

## [0.15.1] - 2026-07-01

### Changed

- **Preflight safety flags are now editable from the GUI Settings page.** `deployment.preflight.*` was previously API-locked (read-only in the dashboard, 403 on write); it's now writable via `PATCH /api/config` with an inline safety caution instead of a hard lock. `defaultOrg`, `plugins`, and `mcp.salesforce.*` remain locked.

### Fixed

- **Deploy picker & Release Hub no longer list `manifest/release/deploy/` and `deployed/` artifacts.** Under `manifestLayout: "subpath"`, the manifest scan swept every `rl-*-package.xml` one level deep into the picker, ballooning it past the expected choices; because the CLI captured results in an unquoted array, a project path containing a space also word-split the list and broke `select`. Both the CLI (`deployment-assistant.sh`) and the GUI (`/api/manifests`) now exclude the `deploy/` and `deployed/` subfolders, and the CLI reads results newline-delimited. Rollbacks are unaffected (the post-deploy flow and Rollback step read `deployed/` on their own).

## [0.15.0] - 2026-06-29

A large feature release completing the sfdx-hardis parity effort: a multi-channel notifier, smart delta deployments with an optional coding-agent auto-fix loop, CI/CD pipeline templates, PR decoration and cross-org retrofit, two new analysis commands, and a brand-new Salesforce CLI plugin — all sharing one org-health rulebook in `@sfdt/flow-core`.

### Added

- **`sfdt notify` — multi-channel notifications.** A provider-agnostic dispatcher for Slack, MS Teams, generic webhook, Grafana Loki, and email (lazy-loaded nodemailer). Channels are configured under a new `notifications` block with per-channel event filters and a severity threshold; channel secrets are referenced by env-var **name**, never inline. `sfdt notify <event>` and `notify snapshot --type audit|monitor` drive it, and `audit all` / `monitor all` accept `--notify` to push a snapshot after a run. When `notifications.summary.enabled`, an AI **executive-summary** digest (editable `monitor-summary` prompt, snapshot redacted, works for every provider) becomes the message body.
- **`sfdt deploy --smart` — smart delta deploy.** Computes a git delta (reusing the `manifest` engine), applies `package-no-overwrite.xml` protection, picks the minimal safe test level (`NoTestRun` / `RunSpecifiedTests` / `RunLocalTests`, never downgraded in production), and runs a self-contained non-interactive `sf project deploy validate|start` with no archive/commit side effects. `--ai-fix` analyses failures via the editable `deploy-error` prompt; with `ai.agent.enabled` + `ai.agent.allowWrite` (CLI providers only) a **bounded, default-off coding-agent auto-fix loop** edits the repo and re-validates via dry-run each turn (never deploys).
- **`sfdt ci init` — CI/CD pipeline templates.** Generates a ready-to-use scheduled-monitor or PR-deploy pipeline for GitHub, GitLab, Azure, or Bitbucket (`--provider`/`--type`). `sfdt monitor schedule` is a thin alias.
- **`sfdt dependencies <name> --type` and `sfdt coverage`.** `dependencies` answers "what references this / what does this reference" via `MetadataComponentDependency`; `coverage` reports org-wide + per-class Apex coverage with a non-zero-exit CI gate (`--threshold`). Both emit the sf-native JSON envelope.
- **`sfdt pr comment` and `sfdt retrofit`.** `pr comment --type audit|monitor` (or `--body`/`--file`) posts the latest snapshot to the current PR via a thin `gh` wrapper, and `deploy --smart --pr-comment` decorates the PR with the delta + outcome. `retrofit --source <a> --target <b>` retrieves a configurable metadata set from a source org, commits, then smart-deploys to the target (validate-only unless `--execute`).
- **`@sfdt/plugin` — Salesforce CLI plugin.** A new thin oclif wrapper that exposes the whole CLI as `sf sfdt <command>` (`sf plugins install @sfdt/plugin`). It reimplements no logic — commands forward argv to the bundled `sfdt` binary and stream output (including `--json`) verbatim. Published coupled to the CLI.
- **Expanded org-health checks.** `audit` grows to ~15 checks (inactive flows/validation rules/workflow rules, unused permission sets, connected apps, missing field descriptions, unreferenced Apex, object- and field-level access lint) and `monitor` to ~7 (org info, deploy history, deprecated API, flow errors). Beta/license-gated checks degrade to `warn` (never `error`) when the org can't run them, so `audit all` / `monitor all` don't fail CI over a missing API.
- **New config blocks** — `notifications`, `ai.agent`, and `deployment.smart` (template + schema + validation).
- **New MCP tools** — `sfdt_notify`, `sfdt_pr_comment`, and `sfdt_retrofit`; `sfdt_deploy` extended with `smart`/`deltaBase`/`deltaHead`/`dryRun`.
- **GUI** — a Notifications page (redacted channel descriptors + test action) plus Scratch, Data, and Docs pages and an org-wide coverage section, backed by new read-only `/api/{notifications,scratch,data,docs,coverage}` routes.
- **`--agent` non-interactive mode** on `explain`, `review`, and `quality`, so coding agents can drive these without blocking, plus per-metadata-type doc prompts (`doc-apex`/`doc-flow`/`doc-lwc`/`doc-object`).

### Changed

- **Org-health is now computed from one source of truth.** The CLI audit/monitor runners and the GUI import thresholds, severity bands, and summarisers from the shared `@sfdt/flow-core` rulebook instead of diverging copies; the CLI's license/limit warn thresholds unify to 0.75 (amber ≥75%, red ≥90%). **Bumped `@sfdt/flow-core` to 0.9.3** — adds the browser-safe `org-health-checks`, `coverage`, and `dependencies` modules that the new commands rely on, and lifts the flow-quality rulebook into flow-core (the CLI re-exports it, unchanged).
- **HTTP bridge implements every request kind.** The previously-stubbed `ai`, `drift`, `scan`, and `compare` kinds now run against the CLI's org logic (scan/compare at full parity with the commands; drift returns the latest snapshot, with an opt-in live-refresh); `ai` runs the prompt through the configured provider in the read-only sandbox.
- **Dependencies** — Docker CI actions bumped to v7/v4 and several dev/prod dependencies updated (prettier, typescript-eslint, vite, wxt, oclif, @vitejs/plugin-react, ora).

### Fixed

- **Notifier** redacts the Grafana Loki webhook payload (the generic-webhook path already did).
- **Smart deploy** removes the temp manifest directory it created if a manifest write throws.
- **GUI** scrubs the launch token from the address bar/history after reading it (persisted to `sessionStorage`), always closes the `/api/pull` SSE stream, and recovers from auth-handshake failures (plus a Settings UX fix).

### Security

- Defense-in-depth from the security review: the localhost-only GUI launch token is scrubbed from the browser URL and history after the handshake. Notifier secrets are referenced by env-var name only, and AI / webhook / Loki payloads are run through `redactSensitiveData` before egress.

## [0.14.1] - 2026-06-26

### Fixed

- **`sfdt audit` (and any command that validates config) no longer rejects a valid `mcp.parking` block.** The config template (`src/templates/sfdt.config.json`) ships an `mcp.parking` block and `src/lib/mcp-parking.js` reads it, but the validation schema (`src/lib/config-schema.json`) never listed `parking` under the `mcp` object — which is strict (`additionalProperties: false`). Any config generated by `sfdt init` therefore failed with `Invalid configuration: "mcp" contains unknown key "parking"`. The schema now allows the `parking` sub-keys (`enabled`, `thresholdBytes`, `ttlSeconds`, `cacheScope`); unknown keys under it are still rejected.

## [0.14.0] - 2026-06-25

### Added

- **Generic `http` AI provider** — a fourth `ai.provider` value, `http`, talks to any OpenAI-compatible `/chat/completions` endpoint (Ollama, OpenRouter, MiniMax, or any gateway) using Node's built-in `fetch` — no extra CLI to install. Configured via `ai.baseURL`, `ai.model`, `ai.apiKeyEnv` (the **name** of the env var holding the key; the key is never stored in config), plus optional `ai.headers` and `ai.timeoutMs`. Both single-shot (`runAiPrompt`) and streaming (the GUI chat) paths are supported. `sfdt init` now offers HTTP as a provider with follow-up prompts for the endpoint, model, and key env var.
- **HTTP-provider context shims** — because an HTTP model can't run tools, agentic commands (`changelog generate`, `release` notes, `test` failure analysis) and the GUI's changelog/release-notes endpoints now pre-gather the context they need (git history, test results) via new `src/lib/ai-context.js` helpers (`gatherGitLog`, `gatherLatestTestResults`, `frameProvidedContext`), gated on `providerSupportsAgenticTools(config)`. For release notes, the CLI writes the output file itself when the model can't.
- **Install methods** — an `install.sh` bootstrap (prerequisite checks + `npm install -g`), a Homebrew formula (`brew install scoobydrew83/sfdt/sfdt`), and CI publishing of the official multi-arch Docker image to GHCR (`ghcr.io/scoobydrew83/sfdt`) on each released version bump.

### Security

- With the `http` provider, prompt content (diffs, git logs) is transmitted to the configured endpoint; `redactSensitiveData` is applied to every outbound payload. CLI providers are unaffected — their read-only tool sandbox is unchanged.

## [0.13.1] - 2026-06-25

A small follow-up to 0.13.0 hardening the new org-health/data commands' error reporting, from the post-release code review.

### Fixed

- **`sfdt data delete` no longer reports incomplete deletes as clean.** A query whose `FROM` clause can't be parsed is recorded as `skipped` (rather than silently discarded), and a per-sObject delete that fails is surfaced too: `--json` now reports `status: "partial"` with top-level `skippedCount` and `errorCount`, and non-JSON mode warns for both. Automation checking `status === "success"` is no longer misled into treating a partial or failed delete as a clean one.
- **`sfdt audit`, `sfdt monitor`, `sfdt data` (export/import/delete), and the org-query helpers surface Salesforce CLI's real error message.** When an org is unreachable or a permission is missing, these now extract `sf`'s structured error text (from `stdout` or `stderr`) instead of the opaque `Command failed with exit code 1…` execa string, so failures read clearly.

### Changed

- **Internal:** deduplicated `query()` / `rawQuery()` into a shared `_execQuery` core and reused the shared `safeParse`, so error-handling fixes reach both paths automatically (no behavior change).
- **Docs:** corrected the `@sfdt/extension` privacy policy and README to match the shipped manifest (notably disclosing the `cookies` permission) and synced the store listing to v0.3.2 / 29 features. (Documentation only — the extension itself is unchanged at 0.3.2.)

## [0.13.0] - 2026-06-23

Adds a native **org health & operations** suite — clean-room reimplementations of org diagnose/audit, monitoring/backup, documentation generation, data-set management, and scratch-org pooling — surfaced across four consumers: the CLI, the web dashboard, the built-in MCP server, and a brand-new VS Code extension. No AGPL dependency.

### Added

- **`sfdt audit` command** — native org diagnostics inspired by sfdx-hardis with no AGPL dependency. Checks an audit trail, license usage, MFA coverage, unused Apex, inactive users, and deprecated API versions, returning normalised `{ id, title, status, summary, findings }` results and writing a `logs/audit-latest.json` snapshot. Supports `sfdt audit [check|all] --org --json`.
- **`sfdt monitor` command** — org monitoring and backup: org limits, Apex job failures, the Security Health Check score, and a full metadata backup (`sfdt monitor [check|all|backup] --org --json --backup`). Writes a `logs/monitor-latest.json` snapshot. Check-threshold defaults are centralised in `AUDIT_DEFAULTS`/`MONITOR_DEFAULTS` so they can't drift from the config template.
- **`sfdt docs` command** — native documentation generation: `sfdt docs generate` collects local metadata (custom objects + fields, Apex classes, Flows) into MkDocs-compatible markdown, and `sfdt docs diagram` builds a Mermaid ER diagram. An optional AI project overview is generated when an AI provider is configured (heuristic fallback otherwise).
- **`sfdt data` command** — data-set management over native `sf data export/import tree` plus bulk delete: `sfdt data list|export|import|delete <set>`.
- **`sfdt scratch` command** — scratch-org lifecycle and pooling: `sfdt scratch create|delete|list|pool [status|fill]`, with a pool tracked in `.sfdt/scratch-pool.json`.
- **VS Code extension (`@sfdt/vscode`)** — a thin UI over the CLI: an Org Health tree view that reads the audit/monitor snapshots (click to re-run a check), a command palette (“SFDT: Run Command…”) with dedicated deploy/preflight/audit/monitor/backup/docs commands, an embedded dashboard webview that spawns `sfdt ui`, and a status-bar item showing the active org and worst audit/monitor status.
- **GUI Org Audit & Org Monitor pages** — read-only `/api/audit` and `/api/monitor` routes serve the snapshots, rendered by a shared `HealthChecks` component (also embedded by the VS Code dashboard webview).
- **New MCP tools** — `sfdt_audit`, `sfdt_monitor`, and `sfdt_docs` expose the org diagnose/audit, monitoring/backup, and documentation commands to AI agents over the stdio MCP server.
- **Bridge `org-health` request kind** — the Chrome extension gains an Org Health panel backed by a typed `org-health` bridge RPC; the bridge protocol version moves `1.1 → 1.2` (additive).
- **Config blocks** — `audit`, `monitoring`, `docs`, `data`, and `scratch` blocks (plus matching feature flags) added to the config template and schema as the canonical user-editable source for the new commands.

### Changed

- **Centralised `describeFinding` in `@sfdt/flow-core`** — the org-health finding renderer had drifted into four near-identical copies (CLI audit, CLI monitor, GUI, extension) that disagreed on field handling. A single `health-findings.ts` (the union of all shapes — apiVersion / user / audit-trail / apex-job / license / limit / health-score / backup-error) now lives in flow-core and is imported by every surface, ending the per-surface drift that caused a license-rendering bug. This is why **`@sfdt/flow-core` is bumped to 0.9.2** (new additive exports) and republished alongside the CLI.
- **Renamed the legacy `sfut` namespace to `sfdt`** in the extension (#136).
- **CI builds `@sfdt/flow-core` before the GUI** — the GUI imports flow-core whose package `exports` resolve to compiled `dist/`, so `vite build` could not resolve it without a prior build.
- **`actions/checkout` bumped from v4 to v7** across the workflows.

### Fixed

- **`sfdt data delete` runs a delete for every query** instead of deduping by sObject, so a data set with multiple WHERE filters on the same object no longer leaves all-but-the-first query's records behind.
- **`sfdt audit`/`sfdt monitor` exit non-zero when any check has `error` status** (not only `fail`), so an unreachable org or a missing permission can't read as healthy in CI. Snapshots are now always persisted (even in `--json` mode) so the GUI and bridge never read stale data, and a snapshot-write failure warns on stderr instead of emitting a second JSON envelope to stdout.
- **`sfdt docs generate` AI overview now renders** — `runAiPrompt` resolves to `{ stdout, … }`, not a string, so the overview was always null.
- **SOQL datetime literals are valid** — milliseconds are stripped from `ISODate()` values (Salesforce rejects the `.000Z` that `toISOString()` emits), repairing the audit-trail, inactive-user, and Apex-job-failure WHERE clauses; `count()` now returns `totalSize` rather than `records.length` (always 0 for aggregate queries).
- **`org-query.rawQuery()` surfaces structured `sf` errors** (bad SOQL, missing sObject) instead of an opaque execa error, mirroring `query()`.
- **`checkUnusedApex` skips detection with a `warn` when no Apex coverage exists yet**, instead of flagging every class as unused.

### Security

- **`audit.minApiVersion` is coerced to a validated integer before interpolation into SOQL**, preventing SOQL injection from a crafted config value.
- **`sfdt data delete` and `sfdt scratch delete` now confirm before destructive actions** — interactive runs preview the org/queries/objects and prompt (defaulting to no); a `-y/--yes` flag skips it; non-interactive runs (`--json`, no TTY, or `SFDT_NON_INTERACTIVE`) refuse to delete unless `--yes` is passed. (`data delete` is not exposed over MCP, so no agent path is affected.)
- **Path-traversal hardening in test-log deletion** — `src/lib/gui-server/index.js` now requires `path.basename(filename) === filename` and that the resolved path stays within the `test-results` boundary, with tests covering backslash and URL-encoded bypasses.
- **Dependency bumps** — `semver` and `undici` (7.27.2 → 7.28.0) updated, plus routine development-dependency group updates (typescript-eslint, `@types/chrome`, happy-dom).

## [0.12.0] - 2026-06-15

Aligns the built-in MCP server with the 2026-07-28 RC of the Model Context Protocol, hardens the GUI's AI streaming path against prompt injection, and folds in a batch of CLI robustness work (shared git-ref/source-dir validation, earlier config diagnostics) plus dependency security overrides.

### Added

- **MCP 2026-07-28 RC alignment** — the parking envelope now uses SEP-2549 `ttlMs` + `cacheScope` (replacing the previous `expiresAt`), and a new optional config key `mcp.parking.cacheScope` (default `"session"`) controls cache scope. `tools/list` advertises `ttlMs`/`cacheScope` for the static catalog (24h, global), and `tools/call` reads and validates a W3C Trace Context from `params._meta`, includes `traceparent` in the stderr audit log, and echoes `_meta` on results.

### Changed

- **Tightened the `@modelcontextprotocol/sdk` pin** from `^1.29.0` to `~1.29.0` so an RC-aware SDK cannot land silently via `npm install`. The server relies on verified-but-undocumented SDK behaviors, so SDK bumps now require a deliberate, smoke-tested upgrade (a release-checklist gate was added for this).
- **MCP tool-call argument logging is now redacted to keys + byte size** (no values) in the stderr audit log.
- **Shared git-ref and source-dir handling** — new `git-utils` (`isSafeGitRef`, `resolveBaseRef`, `diffNameStatus`) and `source-dirs` (`buildSourceDirArgs`) libraries replace duplicated inline logic across `manifest`, `pr-description`, and the GUI server. As a result, `sfdt manifest` and `sfdt pr-description` now validate `--base`/`--head` refs before use.
- **`sfdt manifest --name` must start with an alphanumeric character**, matching the rule the GUI already enforced.
- **Config load now warns when `sfdx-project.json` `packageDirectories` paths don't exist on disk**, instead of failing later at deploy/manifest time.
- **`sfdt update` now prints an actionable error message** with a manual retry command when a self-update fails.
- **`org-inventory` distinguishes list failures from genuinely empty metadata types**, warning once with the aggregate instead of silently returning a partial inventory.

### Fixed

- **GUI log redaction now happens at ingest** — secret redaction was moved into the SSE `streamLines` path, so secrets no longer reach the in-memory log buffer or the browser's live log stream (previously only the persisted log was redacted, after the fact).
- **`sfdt pr-description` now scopes its diff to the merge-base.** It passed the raw `--base` ref to `git log`/`git diff`, so on a feature branch that had diverged from the base the description listed metadata changes that predated the branch. It now resolves the merge-base via `resolveBaseRef` first, matching `sfdt manifest`.

### Security

- **The GUI AI chat's Claude streaming path is now sandboxed to read-only tools.** `streamClaudeResponse` (backing `/api/ai/chat`) invoked the Claude CLI with no tool restriction, while the sibling Codex (`-s read-only`) and Gemini (`--approval-mode plan`) paths deliberately sandbox against attacker-influenced page context. The Claude path now passes `--allowedTools Read,Grep,Glob`, denying Bash/Write/Edit so a prompt injection in page context cannot drive tool execution. Caught by the pre-release security review and covered by a regression test.
- **All non-streaming AI invocations default to a read-only tool sandbox.** `runAiPrompt` (used by `sfdt ai`, `pr-description`, AI-assisted `test`, and the GUI `/api/ai/*` endpoints) now defaults `allowedTools` to `Read,Grep,Glob` across the Claude/Gemini/Codex providers when a caller doesn't specify them. This closes the same prompt-injection surface as the streaming fix on the request/response path — AI-influenced content (diffs, org output, browser context) can no longer drive Bash/Write/Edit. Callers may still pass an explicit `allowedTools` to override.
- **`SAFE_GIT_REF_PATTERN` now rejects `..` sequences.** Git ref names never legitimately contain `..`; barring it keeps a validated ref safe to reuse in a file-path context downstream (defense-in-depth for the shared `git-utils` security boundary).
- **MCP audit log sanitizes attacker-controlled argument key names** — key names are normalized (`[^\w.-]` → `_`) before being joined into the log line, so a crafted key cannot forge the bracketed list or inject extra log lines.
- **`org-inventory` strips newlines from externally-derived values before logging** — metadata type names and the org alias are sanitized of CR/LF so a crafted name cannot forge additional log lines (clears CodeQL `js/log-injection`).
- **Dependency security overrides** — `esbuild` pinned to `^0.28.1` (closes [GHSA-gv7w-rqvm-qjhr](https://github.com/advisories/GHSA-gv7w-rqvm-qjhr) binary-integrity / RCE and [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) dev-server file read, both build-tooling only) and `shell-quote` to `^1.8.4` (closes [GHSA-w7jw-789q-3m8p](https://github.com/advisories/GHSA-w7jw-789q-3m8p)), both forced via npm `overrides` rather than the major-version toolchain downgrades npm audit suggested. `npm audit --audit-level=high` reports 0 vulnerabilities.
- **Production/dev dependency bumps** — `semver` 7.8.0 → 7.8.2, plus routine development-dependency group updates (prettier, typescript-eslint, `@types/chrome`, happy-dom, vite/vitest).

## [0.11.0] - 2026-06-08

Promotes a backlog of work that had accumulated on `main` since 0.10.1 but was never published — three new commands, Flow analysis, and an audit trail — and repairs two regressions that shipped alongside the inquirer 14 upgrade and the gui-server refactor in 0.10.0.

### Added

- **`sfdt mcp` command** — manage the built-in Model Context Protocol server so agents can drive sfdt as a tool:
  - `sfdt mcp start` — start the MCP server in stdio mode.
  - `sfdt mcp cleanup` — purge expired "parked" results from the cache directory.
- **`sfdt plugin` command** — manage CLI plugins:
  - `sfdt plugin create [name]` — scaffold a new sfdt CLI plugin project (`--description`, `--author`). Complements the existing auto-discovery of `sfdt-plugin-*` packages and `.sfdt/plugins/*.js`.
- **`sfdt skills` command** — manage agent skills:
  - `sfdt skills export [--json]` — export local agent skills to IDE/agent-specific configurations.
- **Flow analysis** — a new Flow analyzer library powers Flow health/quality analysis, surfaced in the GUI as a **Flow Intelligence** page.
- **Local audit trail** — privileged/local actions are now recorded to `logs/audit.json`, with OAuth session tokens and passwords automatically redacted.

### Fixed

- **`sfdt init` and `sfdt pull` no longer crash at their interactive prompts.** inquirer 14 (shipped in 0.10.0) removed the legacy `list` prompt type, so `sfdt init` aborted at the "AI provider" step and `sfdt pull` aborted at its action picker with `Prompt type "list" is not registered`. Both prompts now use inquirer 14's `select` type. This also unblocks first-time project setup — a fresh `.sfdt/config.json` could not be created while `init` was crashing.
- **The `sfdt ui` dashboard loads again.** After the gui-server was split into `gui-server/index.js`, `startGuiServer()` returned the HTTP server without its launch token, so the browser opened with `?token=undefined`, every `/api/*` request returned `401 Unauthorized`, and every page showed *"Failed to load dashboard data: 401 Unauthorized"*. The per-launch token is now propagated onto the running server, restoring authenticated access to the dashboard.

### Security

- **The `plugins` config key can no longer be written through the GUI server's config API** — closes a path where a writable config value could be used to load arbitrary local JavaScript at startup.
- **CodeQL hardening in the audit logger** — cleared a remote-property-injection finding by constructing redacted objects from a fixed key set rather than copying arbitrary input keys.
- **Additional CodeQL findings resolved** carried over from the release-branch review, including incomplete URL sanitization in test fixtures and several critical/high/medium items flagged in PR review.

## [0.10.0] - 2026-06-02

Adds a Flow Core panel to the `sfdt ui` dashboard, surfaces `@sfdt/flow-core` package details in the GUI, and rolls in a batch of dependency hygiene — including removing the extension's unused React dependencies and forcing patched transitive packages through the extension toolchain.

### Added

- **GUI: Flow Core tab in Settings** — a new tab under **Settings** that surfaces the shared `@sfdt/flow-core` library: installed version, latest published version (with an up-to-date / update-available indicator), the extension bridge protocol version, the package description, a capabilities list, and a map of where it is integrated (CLI commands, the `/api/flow/quality` endpoint, and the Chrome extension bridge). When a newer version is available, the update action reuses the existing CLI self-update — because `@sfdt/flow-core` ships pinned with the CLI, updating the CLI updates it.
- **`GET /api/flow-core/info`** — read-only GUI-server endpoint backing the Flow Core tab. Resolves the installed `@sfdt/flow-core` from the CLI's own module graph (works for global installs), reports its version/description and bridge protocol version, and fetches the latest published version from npm. Degrades gracefully (still returns installed info when offline).

### Changed

- **`@sfdt/flow-core` 0.9.0 → 0.9.1** — its `exports` map now exposes `./package.json`, so the installed version and description can be resolved at runtime by the new info endpoint. No analysis-logic changes.
- **Internal `fetchLatestVersion()` helper generalized** to accept a package name, so the same npm-registry lookup now serves both the CLI self-update check and the Flow Core panel. Existing `@sfdt/cli` behavior is unchanged (the package name defaults to `@sfdt/cli`).
- **Update detection now uses semantic-version comparison** — the `sfdt update` command, the dashboard's CLI self-update indicator, and the Flow Core panel all flag an update only when the published version is strictly newer (`semver.gt`) rather than merely different, via a shared `isUpdateAvailable` helper in `update-checker.js`. A local or pre-release build that is *ahead* of the published version is no longer incorrectly prompted to "update" (which would have been a downgrade).
- **Dashboard streamed actions now surface the server's real error message** — when a streamed request (update, deploy, pull, etc.) fails, the UI shows the server's actual reason (e.g. "An update is already in progress" on a 409) instead of a generic failure. Previously the response body was discarded and only a bare HTTP status was shown.
- **Production dependency bump:** `inquirer` 13.4.3 → 14.0.2 (major).
- **Development dependency bumps:** `vite` 8.0.14 → 8.0.16, `vitest` 4.1.7 → 4.1.8, `@vitest/coverage-v8` 4.1.7 → 4.1.8, `typescript-eslint` 8.59.4 → 8.60.1.

### Removed

- **Unused React dependencies dropped from `@sfdt/extension`** — `react`, `react-dom`, `@types/react`, and `@types/react-dom` were declared but never imported; the extension UI is vanilla-TypeScript DOM. Removing them shrinks the install footprint and stops recurring Dependabot churn (the React 18 → 19 bumps that prompted this were no-ops for the extension). The extension also drops the unused `scripting` permission and moves to 0.0.2.

### Security

- **Patched transitive dependencies forced via npm `overrides`** through the extension's WXT toolchain (`wxt → web-ext-run → tmp/node-notifier → uuid`): `tmp` → 0.2.7 (closes [CVE-2026-44705](https://github.com/advisories/GHSA-ph9p-34f9-6g65) path traversal, high) and `uuid` → 11.1.1 (closes [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) buffer bounds check, moderate), including the nested `node-notifier > uuid` pin. Clears the `npm audit --audit-level=high` CI gate (0 vulnerabilities at all severities) and Dependabot alert #14.

## [0.9.1] - 2026-05-23

### Security

- **`qs` dependency upgraded to 6.15.2** — closes [CVE-2026-8723](https://github.com/advisories/GHSA-q8mj-m7cp-5q26) (Dependabot alert #13). `qs.stringify` previously crashed with `TypeError` on `null`/`undefined` entries in comma-format arrays when `encodeValuesOnly` was set; 6.15.2 skips those entries instead of throwing.

### Changed

- **Dependency bumps (production):** `express-rate-limit` 8.5.1 → 8.5.2 (patch).
- **Dependency bumps (development-only):** `vite` 8.0.8 → 8.0.14, `vitest` 4.1.6 → 4.1.7, `@vitest/coverage-v8` 4.1.6 → 4.1.7, `typescript-eslint` 8.59.3 → 8.59.4, `@types/chrome` 0.0.280 → 0.1.42.
- **Dependabot now targets `develop`** instead of `main`. Auto-update PRs land on the next-release branch and roll into the release PR, eliminating the previous merge-conflict noise from main-targeted upgrades.
- **Chrome Web Store listing groundwork** — initial store assets and auto-publish setup docs added under `extension/store/`. No `@sfdt/cli` behavior change.

## [0.9.0] - 2026-05-21

The monorepo release. Adds a Chrome extension surface, a local HTTP bridge that lets the extension drive sfdt commands from inside Salesforce, three new CLI commands, three new GUI tools (SOQL Runner, Org Limits, REST Explorer), and a hardened CSRF + origin guard around the local GUI server.

### Added

- **`sfdt extension` command** with four subcommands for managing the Chrome native messaging host:
  - `install-host --extension-id <id> [--browser chrome|edge|brave|chromium|vivaldi|all]` — registers the native host manifest for the SFDT SF Helper extension. Strict `^[a-p]{32}$` validation on the extension ID.
  - `uninstall-host [--browser <name>]` — removes the manifest from one or all browsers.
  - `status` — reports which browsers have the manifest installed and where each one points.
  - `stats [--limit N] [--json]` — pretty-prints the telemetry snapshot the extension pushes to `.sfdt/telemetry-snapshot.json`.
- **`sfdt doctor --extension` command** — end-to-end diagnostic for the extension stack: bridge ping, native host registration, feature flags, telemetry snapshot. Exits non-zero on any failure for CI use.
- **`sfdt feature-flags` command** — manage `.sfdt/feature-flags.json` to remotely disable individual extension features (kill switch).
- **`sfdt flow` command** — Flow-focused subcommands shared with the extension via the new flow-core library.
- **Native messaging host** (`host/` workspace, published separately from the CLI) — backs the extension's `chrome.runtime.connectNative` transport when the local `sfdt ui` HTTP server isn't running.
- **HTTP bridge** at `/api/bridge/*` — lets the Chrome extension drive `sfdt deploy`, `sfdt rollback`, and `sfdt quality` from inside any Salesforce org. Authenticated with a per-user bearer token at `~/.sfdt/bridge-token` (32 bytes CSPRNG, file mode 0600, constant-time compare).
- **Shared `@sfdt/flow-core` TypeScript library** (`packages/flow-core/`) — bridge contract, Flow XML normaliser, API-name defaults, scheduled-Flow calculator, scorer rules, subflow graph builder, and trigger-conflict analyser. Consumed by both the CLI and the extension.
- **GUI: SOQL Runner page** — arbitrary SOQL execution with REST/Tooling API toggle, query history, and CSV export.
- **GUI: Org Limits page** — `sf org limits` results rendered as cards with utilisation bands and warning thresholds.
- **GUI: REST API Explorer** — arbitrary `GET`/`POST`/`PATCH`/`PUT`/`DELETE` calls against the connected org, with header editor, JSON body editor, and request history.
- **GUI: Release Hub Quick Deploy** — promote a successful validation by validation job ID (true Salesforce Quick Deploy, no re-validation roundtrip).
- **GUI: Release Hub destructive modes** — opt-in `destructive` and `destructive-only` deploy modes surface in the Deploy step with explicit confirmations.
- **GUI: structured failure rendering + Ask-AI** — `CommandRunner` and `StreamRunner` now render structured failures (parsed test failures, code-coverage gaps) and offer an Ask-AI button that pipes the failure into the explain pipeline.
- **GUI: manifest picklist search** — the Release Hub manifest picker becomes type-ahead searchable when more than a handful of manifests exist.
- **CLI splash banner** — `sfdt ui` and other entry points print a colourised ASCII splash with the current version on TTY stdout (falls back to a one-line label in CI).
- **Bridge ping surfaces feature flags** — `/api/bridge/ping` and the native messaging `ping` handler now include `disabledFeatures` derived from `.sfdt/feature-flags.json`, so the extension can react to remote kill switches without a separate fetch.

### Changed

- **`SalesforceApiClient` additions** in the shared library: `query`, `queryMore`, `limits`, `rawRequest` + `QueryEnvelope<T>` / `HttpMethod` types. Used by all extension features and by the new GUI SOQL/Limits/REST pages.
- **AI command handling enforces read-only modes** for Gemini and Codex providers — prevents accidental mutations when the explain/review pipelines invoke a non-Claude provider.
- **Release Hub white-on-white dark-mode bug fixed** on the Deploy step.
- **Deploy checkbox defaults flipped to `false`** — opt-in for `runAllTests`, `rollbackOnError`, and the new destructive modes.
- **TypeScript workspaces linted** — `extension/`, `packages/flow-core/`, and `host/` are now covered by the root `npm run lint`.
- **Extension renamed to "SFDT SF Helper"** with strict comment-strip across `extension/` and `packages/flow-core/src/` for a smaller bundle.

### Fixed

- **GUI Release Hub failure UX**: deploy/quality/rollback failures now render with structured rows and a one-click Ask-AI affordance, replacing the previous opaque "non-zero exit" terminal dump.
- **Bridge `readDisabledFeatures` resilience**: defensive try/catch in the ping handlers so a malformed `.sfdt/feature-flags.json` does not 500 the ping endpoint.
- **Native host discovery uses `Promise.any`** so a fast-failing localhost probe no longer shadows a healthy native host that needs a few more milliseconds.
- **Per-feature extension settings preserved across storage events** — `onSettingsChange` now uses the composed schema, so dynamically-registered `featureSettings.<id>` entries survive a storage round-trip.
- **Splash banner suppressed in piped/CI `--help` output** — gated on `process.stdout.isTTY`.

### Security

- **Path-traversal hardening** in `/api/changelog/save` and `/api/release-notes/save`. `pkgName`/`pkgTarget` are now validated against `/^[A-Za-z0-9_-]+$/`; `version` is validated against `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` and rejects any `..` substring. Prevents overwrite of arbitrary `.md` files inside `_projectRoot` via a CSRF-authenticated POST. (Closed two medium findings raised by the pre-release adversarial security review.)
- **SOQL escape correctness in extension features** — six SOQL string-literal escape sites now escape backslashes before quotes (previously only quotes were escaped). A new shared `escapeSoql()` helper in `extension/lib/escape.ts` enforces the order. Affects `flow-trigger-explorer-enhancer`, `scheduled-flow-explorer`, `subflow-graph`, `trigger-conflicts`, and the `SalesforceApiClient.getFlowMetadata` namespace/developer-name path.
- **URL suffix anchoring** in `extension/lib/hostname.ts` — every Salesforce hostname check switched from `String.prototype.includes` to suffix-anchored `endsWith`. The previous form would have accepted hostile hostnames like `evil.lightning.force.com.attacker.com` if the function were ever invoked outside the extension's host-permission-restricted content scripts.
- **flowApiName contract validation** — the bridge contract validator (`validateSfdtRequest`) now applies the same `/^[A-Za-z][A-Za-z0-9_]*$/` developer-name regex the deploy/rollback runners already enforce, so malformed names are rejected at the contract layer rather than only at the runner.
- **Insecure-randomness fallback removed** — `defaultIdGenerator` in `packages/flow-core/src/prompts.ts` previously fell back to `Math.random()` when `crypto.randomUUID` wasn't available. The fallback chain now uses `crypto.getRandomValues` before any non-cryptographic path.
- **Bridge and GUI server body-limit hardening:** raised `/api/bridge` body limit to 6 MB so the 5 MB `flowXml` route guard is reachable, with a 2 MB ceiling on other `/api/*` routes; `flowXml` size check now byte-accurate via `Buffer.byteLength`; `X-Content-Type-Options: nosniff` and `X-Frame-Options: SAMEORIGIN` sent on every response.
- **CSRF token comparison is constant-time** in both `requireCsrfToken` and `requireCsrfTokenFromQueryOrHeader`. `GET /api/compare/stream` accepts the CSRF token via `?csrf=` for EventSource callers.
- **Bridge runners independently re-validate `targetOrg`** against `ORG_ALIAS_RE` (80-char cap) so CLI/plugin/test paths cannot bypass the bridge contract's pre-check.
- **Native messaging host stdin is bounded** — declared frame length capped at 4 MB and the accumulating buffer trips a projected-size check before `Buffer.concat`, preventing a partial-frame memory hold.
- **Extension background hardened** — `onMessage` rejects messages whose `sender.id !== chrome.runtime.id`; `getSidForUrls` filters through a Salesforce-suffix allowlist (`.salesforce.com`, `.salesforce-setup.com`, `.lightning.force.com`, `.force.com`, `.visualforce.com`); bridge-ping port clamped to `[1, 65535]`.
- **Bridge no longer reads or writes through `process.cwd()`.** `mountBridgeRoutes` now accepts `projectRoot`/`configDir` from the GUI server, so the extension's kill-switch and `extension stats` snapshot are honoured even when `sfdt ui` is launched from a non-project directory.
- **`PATCH /api/config` blocklist widened** to cover `defaultOrg` (use `POST /api/session/org` instead) and `deployment.preflight.*` enforcement flags.
- **Compare endpoints use `fs.mkdtemp`** (atomic, mode-0700) instead of predictable `${Date.now()}` temp paths, with `finally`-block cleanup.
- **CodeQL fixes:** anchored-prefix Bearer-token parser with 4 KB Authorization header cap; `flow-rollback-runner` SOQL literal routed through an `escapeSoql` helper; test fixtures use `mkdtemp` instead of `${Date.now()}-${Math.random()}`.
- **Input validation tightened on:** `--extension-id` (`^[a-p]{32}$`), `feature-flags` ID (`^[A-Za-z0-9_-]{1,128}$`), `doctor --port` (`[1, 65535]`).

### Fixed (release blockers)

- **`host/` workspace included in the npm tarball**. Adding `host/installers/`, `host/manifests/`, `host/src/`, and `host/package.json` to `files` in the root `package.json`. Without this, every `sfdt extension {install-host,uninstall-host,status,stats}` subcommand would throw `ERR_MODULE_NOT_FOUND` on a real npm install (workspaces masked the bug locally and the existing unit tests mock the import).
- **`@sfdt/flow-core` is now a published npm package** (`0.9.0`). Previously it was marked `"private": true` while `@sfdt/cli` listed it as a runtime dependency, which meant a real `npm install -g @sfdt/cli` would 404 on `@sfdt/flow-core`. The package is now public, `cli` and `host` pin `^0.9.0`, and the CI release workflow publishes `@sfdt/flow-core` before `@sfdt/cli`. The flow-core workspace also gained a `prepack` hook that builds `dist/` from source so the published tarball always contains the compiled output.
- **Windows path bug in native-host manifest installer** (`host/installers/install-host.js`). `buildManifest` substituted the bare host path into the JSON template, which produced invalid JSON when the path contained backslashes (every Windows install path). The substitution now uses `JSON.stringify(hostPath)` against the quoted placeholder, escaping backslashes and embedded quotes correctly.
- **`pretest` hook builds `@sfdt/flow-core` before the test suite runs**, so CI doesn't try to resolve the workspace package against an empty `dist/`. Without this, tests that import `@sfdt/flow-core` (bridge routes, host smoke, the new `flow` command) fail with `Failed to resolve entry for package "@sfdt/flow-core"` on a fresh checkout.

### Changed (cleanup from code review)

- **`sfdt flow scan` now delegates to `runFlowQuality`** instead of reimplementing the normalize → evaluate → score pipeline inline. CLI, GUI, and bridge `quality` handler now share a single chokepoint for byte-identical scoring.
- **`currentApiVersion` no longer hardcoded in two places** — `flow-quality.js` accepts a `currentApiVersion` override that the CLI sources from `sfdx-project.json`'s `sourceApiVersion`. The hardcoded fallback constant is documented as the floor when no config is available.
- **Bridge `isAllowedOrigin` no-Origin behavior documented** — the bearer token is the authoritative access control on `/api/bridge/*`; the origin allowlist is permissive for non-browser callers by design. Code comment now explains the asymmetry vs the gui-server's CSRF model.
- **CSRF protection** on all mutating GUI API routes via a per-session token returned from `GET /api/csrf-token` and required on the `X-SFDT-CSRF` header. The token is bound to the server process and never sent cross-origin.
- **Tightened origin guard** — the localhost-only middleware now rejects mutating requests (POST/PATCH/DELETE) that arrive without an `Origin` header, in addition to the existing allowlist check.
- **Strict `targetOrg` validation** before any `sf` CLI shell-out: `/^[A-Za-z0-9_.\-@]+$/`. Same regex applied to `flowApiName` (`/^[A-Za-z][A-Za-z0-9_]*$/`) in the flow deploy and rollback runners.
- **Bridge bearer token** at `~/.sfdt/bridge-token` — 32 bytes from `crypto.randomBytes`, base64url-encoded, file mode 0600 on POSIX, validated with `crypto.timingSafeEqual` on every `/api/bridge/*` request.
- **Extension ID JSON-injection foreclosed** — the native host installer validates `extensionId` against `/^[a-p]{32}$/` before substituting it into the manifest template.

## [0.8.1] - 2026-05-13

### Fixed
- **GUI: result pages didn't refresh after a non-zero exit run**. When `sf apex run test` exited 100 (tests ran but some failed), the server still wrote the full artifact — including `classCoverage` — to disk, but the `CommandRunner` callback only fired on `exitCode === 0`. The Coverage page was the most visible casualty: the per-class table stayed empty and the trend chart never updated, even though all 88% / 106-class data was present. The same bug affected Quality, Preflight, Drift, and Test Runs. `onComplete` now always fires and receives the exit code; Release Hub's preflight gate still correctly requires `exitCode === 0` before enabling "Continue to Deploy".

### Security
- **CodeQL: type confusion via parameter tampering** — addressed CodeQL alert on GUI API parameter handling.

### Changed
- Standardized `--json` output shapes across CLI commands and added test coverage for the JSON output mode.
- Dependency updates.

## [0.8.0] - 2026-05-12

### Added
- **`sfdt scan` command**: Fetches a full metadata inventory from a Salesforce org and writes the results as a structured JSON log file. Supports `--org <alias>`, `--output <file>`, and `--format json|table`.
- **GUI: Scan page**: New dashboard page for browsing a live metadata inventory — lists all component types and member counts from a connected org, backed by new `GET` and `POST /api/scan` routes.
- **`--json` CI output mode for `sfdt drift` and `sfdt rollback`**: Both commands now accept `--json` to emit machine-readable structured output for CI pipelines and downstream tooling.
- **Deploy and rollback log archiving**: Logs from `sfdt deploy` and `sfdt rollback` runs are now automatically archived to `logDir`, making historical deployment activity available in the GUI log viewer.
- **`GET /api/logs/list` endpoint**: Returns project-relative paths for all available log files; enables the Explain page log picker so any archived deploy or rollback log can be analyzed without knowing the filesystem layout.
- **Expanded GUI server test suite**: Unit tests added for GUI server route handlers, parsers, and shared utilities.

### Changed
- **GUI Explain page redesigned**: Rebuilt with a three-zone layout — input zone (manual text or log picker), analysis zone (AI/heuristic result card with source badge), and a scrollable output terminal. The log picker draws from `GET /api/logs/list` so any archived log can be analyzed directly from the UI.
- **Config validation rewritten with AJV**: `.sfdt/config.json` is now validated against a JSON Schema using `ajv`, replacing hand-written checks. Validation errors include the field path and a human-readable description.
- **Heuristic analysis extracted to shared module**: The explain heuristics logic now lives in `src/lib/explain-heuristics.js` and is shared between the CLI command and the GUI server endpoint.

### Fixed
- **`sfdt drift` non-interactive mode**: The org drift script now correctly auto-selects the target org and skips interactive prompts when running in CI or GUI-triggered flows.
- **Explain page log resolution**: `GET /api/logs/list` returns project-relative paths, fixing an issue where the Explain page could not locate log files when the GUI server was launched from a different working directory.
- **Explain page error display**: Non-zero exit codes from the explain backend now surface an inline error message instead of silently showing no output; the terminal panel stays open after the run completes.
- **GUI CSS tokens**: Replaced incorrect `badge-ai` and `--border-default` token references with the correct design system tokens.
- **Import paths**: Corrected module import paths after the GUI server directory layout consolidation.

## [0.7.2] - 2026-05-08

### Added
- **Package-scoped changelog support**: `sfdt changelog generate`, `sfdt changelog release`, and `sfdt changelog check` now accept `--package <name>` to scope operations to a specific package directory. Per-package changelogs are stored in `changelogs/<name>.md` (directory configurable via `changelogDir` in `.sfdt/config.json`, default: `changelogs`).
- **`changelogDir` config field**: New config key controlling the directory used for per-package changelog files. Added to the `sfdt.config.json` template so `sfdt init` sets it automatically.
- **GUI Release Hub: package-scoped changelog and release notes**: The Changelog and Release Notes steps in Release Hub now show a package pill selector when multiple package directories are configured. Selecting a package scopes the AI generation, preview, and save operations to that package's changelog file.

### Fixed
- **Security: path traversal in GUI changelog endpoints** — The `/api/changelog/content`, `/api/changelog/save`, and `/api/release-notes/save` endpoints now validate that the resolved file path stays within the project root, preventing a path traversal attack via the `package` parameter.
- **Security: git ref validation in `/api/review`** — The `base` parameter is now validated against an allowlist pattern (`/^[A-Za-z0-9._/~^@:{}-]+$/`) before being passed to `git diff`, preventing git flag injection.
- **Manifest README generation**: Fixed output path for the README artifact in subpath manifest layout — it now correctly writes to `MANIFEST_OUTPUT_DIR` instead of `MANIFEST_DIR`.
- **`sfdt deploy` in CI/non-interactive mode**: `deployment-assistant.sh` now auto-selects the newest `rl-*-package.xml` from `MANIFEST_BASE_DIR` when no `SFDT_MANIFEST_PATH` is provided in non-TTY environments (e.g. CI). Previously it hard-failed with "MANIFEST_PATH not set" whenever `sfdt deploy` ran without a terminal.

### Security
- **`hono` 4.12.15 → 4.12.18** (transitive, via `@hono/node-server` / `@modelcontextprotocol/sdk`): fixes JWT NumericDate validation bypass (GHSA-hm8q-7f3q-5f36), cross-user cache leakage via `Vary: Authorization/Cookie` (GHSA-p77w-8qqv-26rm), CSS injection in JSX SSR (GHSA-qp7p-654g-cw7p), unvalidated JSX tag names (GHSA-69xw-7hcm-h432), and body-limit bypass for chunked requests (GHSA-9vqf-7f2p-gf9v). Incorporates Dependabot PR #72.
- **`fast-uri`** (transitive): fixes path traversal via percent-encoded dot segments (GHSA-q3j6-qgpj-74h6) and host confusion via percent-encoded authority delimiters (GHSA-v39h-62p7-jpjc).

### Changed
- **CI**: Reverted `actions/checkout` and `actions/setup-node` to v4 (v6 was incompatible with the current runner environment). The integration test job is no longer a required gate for beta and stable publish jobs.

## [0.7.1] - 2026-05-07

### Changed
- CI: bumped `actions/checkout` to v6, `actions/setup-node` to v6, and `actions/github-script` to v9 to stay current with GitHub Actions runner requirements.

## [0.7.0] - 2026-05-07

### Added
- **Multi-package deploy support**: `sfdt manifest`, `sfdt deploy`, and `sfdt release` now accept `--package <name>` to target a specific package directory and `--name <label>` to set a custom release label. The shell scripts read the package list from `SFDT_PACKAGE_DIRS` and the layout from `SFDT_MANIFEST_LAYOUT`.
- **`manifestLayout` config field**: Controls whether generated manifests are placed in a flat layout (`flat`, default) or per-package subdirectories (`subpath`). `sfdt init` now prompts for this setting when multiple `packageDirectories` are detected in `sfdx-project.json`.
- **GUI: functional Pull page**: Replaces the Coming Soon stub with a fully interactive Pull page — mode selector (Smart Delta, Preview, Full Retrieve), run/cancel controls, and live streaming output backed by new `/api/pull/groups` and `/api/pull` SSE endpoints.
- **GUI: Dependency Graph page**: New D3 force-directed visualization showing component relationships across the Salesforce org. Nodes are filterable by type; edges highlight dependency chains on hover. Backed by new `/api/dependencies` endpoint.
- **GUI: Dependency Check section on Preflight**: The Preflight page now includes a component dependency check panel sourced from `/api/dependencies/preflight`, surfacing missing or broken references as warnings alongside the existing checklist.
- **`/api/packages` endpoint**: Returns the list of configured package directories for the current project; used by the GUI Manifests and Release Hub pages to populate package selectors.
- **CI: integration test job and nightly schedule**: New `integration-test` workflow job installs sfdt from a tarball and runs key commands (`preflight`, `test`, `quality`) against a scratch org. Runs on every PR and nightly via cron.
- **`sfdt deploy --source-dir`**: New flag for folder-mode deploys — deploys directly from a source directory path instead of generating a manifest.

### Breaking Changes
- **Preflight: `enforceGitClean` and `enforceSfdxProject` now default to `true`**: Projects upgrading from v0.6.x that do not have a `deployment.preflight` section in `.sfdt/config.json` will now have git-clean and sfdx-project checks enabled automatically. To preserve the previous opt-in behaviour, explicitly set `"enforceGitClean": false` and `"enforceSfdxProject": false` in your config, or run `sfdt init` to regenerate the config with current defaults.

### Changed
- **GUI: dark mode is now the default**: The dashboard root defaults to dark mode; light mode is opt-in via the `.content-light` class. No user preference is required.
- **GUI design system (Relay)**: Dashboard, ReleaseHub, Drift, and Compare pages updated to use the Relay design components (custom CSS design system). Hardcoded brand colors replaced with CSS custom properties throughout.
- **GUI: new shared components**: `FilterTabs` and `OrgBar` added to the component library; `StatCard` extended with sparkline, trend indicator, and `valueColor` prop.
- **GUI Settings**: `manifestLayout` setting and `packageDirectories` package list now displayed and editable in the Settings page.
- **Preflight**: Enhanced check coverage and updated default config values in `sfdt.config.json` template.
- **`packageDirectories`**: The array of package entries (with `name` field) is now preserved from `sfdx-project.json` and exposed to the GUI and shell scripts via `SFDT_PACKAGE_DIRS`.

### Fixed
- Pull: delta retrieve now aborts cleanly on client disconnect; org alias is validated before starting; UX corrected for non-delta modes.
- GUI Pull page: fixed import path, API response shape, stale ref guard, accessibility attributes, and CSS variable references.
- GUI Compare: stat counts (Modified, Added, Removed, Conflicts) now reflect actual diff results accurately.
- GUI Quality page: UI layout and data consistency issues resolved.
- `/api/dependencies`: SOQL input is escaped, duplicate edges are deduplicated, and a response-length guard prevents oversized payloads.
- Rollback made fully non-interactive so it runs cleanly in CI and GUI-triggered flows.
- GUI: Tests, Quality analysis, and AI feature panels now surface real backend results instead of placeholder data.
- Compare SSE: phase 2 progress counters are reset correctly when a stream error occurs, preventing stale progress display on retry.

## [0.6.3] - 2026-04-29

### Added
- **GUI: ErrorBoundary** — all pages are now wrapped in a React error boundary; a render crash on one page no longer takes down the entire dashboard.
- **GUI: Dashboard retry** — when dashboard data fails to load, an inline error message with a Retry button appears instead of a silent blank state.
- **GUI: Compare cancel** — a Cancel button appears during long-running inventory streams so users can abort without navigating away.
- **GUI test suite** — Vitest + Testing Library added to the GUI package; tests run in CI on every push (`cd gui && npm test`).
- **JSDoc type annotations** added to all `api.js` functions for improved IDE autocompletion.

### Changed
- **ANSI escape codes stripped** from all SSE log output and terminal streams in the GUI — no more garbled color codes appearing in command output panels.
- **Node.js 22+ required** — engine floor raised from 20 to 22; CI now tests on Node 22 only.
- **`better-sqlite3` replaced with Node built-in `node:sqlite`** (`DatabaseSync`) — removes the native compiled dependency; pull cache now uses the standard library SQLite module.
- **Pull page** replaced with a "Coming Soon" placeholder pointing users to the Compare page and the CLI; the interactive pull UI is not yet complete.
- **`/api/preflight`, `/api/drift`, `/api/compare`** now return structured empty shapes (`{ date: null, status: null, checks: [] }` etc.) instead of `{}` when no data exists, preventing client-side null-check errors.
- **Org config format** (`environments.orgs`) is now correctly read as an array of `{ alias, username }` objects, matching what `sfdt init` writes.

### Fixed
- Dashboard drift activity card no longer crashes — uses `drift.status` / `drift.components` instead of the removed `drift.result` / `drift.count` fields.
- `initInProgress` flag is now correctly reset to `false` after a successful `/api/init` call (was only reset on error, causing false "Already initialized" rejections after first use).
- Release Hub: streaming sessions for changelog and release-note generation are now closed on component unmount, preventing memory leaks after navigating away.
- Release Hub: deployment now validates that a target org is selected before starting, showing an inline error instead of silently proceeding with no org.
- Release Hub: test detection effect no longer re-runs on `testClasses` change (was causing duplicate API calls).
- Logs page: unknown log types now render their raw JSON payload in a scrollable `<pre>` block instead of returning `null`.
- Manifests viewer: defensive null checks on `data.components` prevent crashes when a manifest has no components; download filename falls back to `manifest.xml`.
- Review, Explain, Quality pages: when AI output exceeds 2000 characters, the content is truncated and a notice shows the full character count.
- Settings: `coverageThreshold` field now validates that the entered value is a number between 0 and 100 before saving.
- React key props in Logs, ReleaseHub, and Dashboard tables now use stable identifiers instead of array indices, preventing incorrect reconciliation on re-render.
- CodeQL suppression comments added to intentional file-to-HTTP patterns in `ai.js` to silence false-positive alerts.

## [0.6.2] - 2026-04-29

### Added
- **GUI: Initialize Project from Settings**: The Settings page now shows a guided "Initialize Project" card when no `.sfdt/` config directory exists, backed by a new `/api/init` endpoint — users can set up a project without touching the command line.

### Fixed
- `ReferenceError` crash on the Release Hub page caused by a missing `IconSearch` import; the page now loads correctly.
- Settings page no longer returns a raw 503 error on uninitialized projects; users are guided to initialize from within the GUI instead.
- After a GUI-triggered update (`sfdt update`), the server now self-restarts automatically and the browser polls `/api/ping` to reload once the server is ready — no manual restart required.

### Changed
- `express-rate-limit` updated from v7 to v8 (major); no behavior change for end users.
- `ora` updated to 9.4.0; `vitest` and `@vitest/coverage-v8` updated to 4.1.5.

## [0.6.1] - 2026-04-28

### Security
- Config key segments are now validated with a strict regex before get/set operations, blocking remote property injection via crafted key names (CodeQL #35, #36).
- Prototype-pollution vulnerabilities fully resolved using `Object.defineProperty` with inline guards throughout config resolution (CodeQL alerts cleared).

### Fixed
- Deployed manifests are now read-only in the GUI — the Manifests page and server-side route both enforce this guard, preventing accidental overwrites of released artifacts.
- `skipPreflight` is now correctly honored in the GUI deploy path; the flag was previously ignored when deploying from the Release Hub.
- Versioned manifest and release-note saves now return `409 Conflict` if the file already exists, preventing silent overwrites on duplicate runs.
- `run_full_deployment` no longer hangs waiting for an interactive confirmation prompt when run in non-interactive (CI/GUI) environments.

## [0.6.0] - 2026-04-26

### Added
- **AI Chat drawer** (GUI): New sliding ChatDrawer panel with streaming token-by-token responses, accessible from the dashboard toolbar. Contextual "Ask AI" buttons on Review, Explain, Drift, and Preflight pages pre-fill the chat with the relevant output as context.
- **Streaming AI chat API** (`POST /api/ai/chat`): Server-Sent Events endpoint backing the ChatDrawer, using `streamAiResponse()` for real-time token streaming across all configured AI providers (Claude, Gemini, OpenAI).
- **Structured logging system** (`src/lib/log-writer.js`): New log-writer module with a typed schema for structured SFDT logs. `drift.sh` emits `SFDT_LOG:component:` markers and `preflight.sh` emits `SFDT_LOG:check:` markers; the GUI server COMMANDS runner writes these as structured log files alongside plain-text logs.
- **`logRetention` config key**: Controls how many log files to retain per log type (default: 50). Older files are pruned automatically on each write.
- **`sfdt config get/set`**: Read and write individual `.sfdt/config.json` values using dot notation from the command line (e.g. `sfdt config set deployment.coverageThreshold 80`).
- **Salesforce MCP client** (`src/lib/mcp-client.js`): Connects to `sf mcp start` via the Model Context Protocol SDK to fetch DevOps Center pipeline status and work items; surfaced in the GUI dashboard when `mcp.enabled` is set in config.

### Fixed
- AI context readers now normalize the response envelope, ensuring consistent data shape across providers.
- `SFDT_TARGET_ORG` is now correctly passed to `drift.sh` when run from the GUI.
- `readLatestLog` is now used in the quality fix-plan flow, replacing a stale direct-path read.
- `latest.json` is excluded from the test-run file list to prevent it appearing as a selectable run.
- `writeLog` and the GUI COMMANDS runner now guard against `undefined` data to prevent silent failures on empty payloads.
- Unknown log types are handled gracefully; archive filename collisions on concurrent writes are prevented.
- Sensitive file reads (credentials, private keys) are blocked when AI executes file-read tools.

## [0.5.1] - 2026-04-24

### Fixed
- Parallel retrieve timeout increased to 6 minutes (was 2 minutes) to prevent timeouts on large orgs; now configurable via `pullCache.retrieveTimeoutSeconds` in `sfdt.config.json`.
- Org alias is now sanitized before use as a SQLite filename, preventing path traversal in the pull cache.
- `toMs()` in delta detection now guards against `null`/`undefined` dates to prevent `NaN` comparisons.
- Components deleted from the org are now pruned from the pull cache on each successful update.
- Partial retrieve successes are now cached correctly; cache update is only skipped when zero components were retrieved.
- `smartPull` is now gated behind the `pullCache.enabled` flag.
- Moved retrieved-component counter accumulation outside the concurrent `Promise.all` window to prevent race conditions.
- GitHub Actions docs-update workflow now triggers correctly when commits are made by the `github-actions` bot.

## [0.5.0] - 2026-04-23

### Added
- **`sfdt pull` rewritten as Node.js orchestrator**: The pull command is now fully implemented in Node.js with a SQLite-backed cache. Tracks retrieved components, modification dates, and delta detection — replaces the previous shell script approach for improved reliability and extensibility.
- **Parallel retrieve engine**: Components are fetched in parallel batches during pull, significantly reducing retrieval time for large orgs.
- **SQLite pull cache** (`src/lib/pull-cache.js`): Persistent local cache of retrieved metadata with `withDates` mode for delta-based incremental retrieves — only changed components are re-fetched on subsequent pulls.
- **`pullCache` config key**: New `pullCache` section in `sfdt.config.json` template controls cache path and enabled state; `sfdt init` picks it up automatically.
- **GUI: Release Hub, Review, and Explain pages**: Three new dashboard pages — Release Hub for managing release artifacts, Review for AI-powered code review results, and Explain for deployment log analysis. Navigation is now grouped by workflow area for easier discovery.
- **GUI: Compare batching, Manifests page, Quality/Pull parity**: Compare page now streams diffs in batches to handle large orgs; new Manifests page surfaces generated `package.xml` artifacts; Quality and Pull pages reach feature parity with their CLI counterparts.

### Fixed
- Pull cache now handles partial retrieve errors gracefully without corrupting cached state.
- ISO date normalization in delta detection prevents false positives when comparing org metadata timestamps in mixed formats.
- Removed stale `SFDT_PULL_*` environment variables from the script runner — pull config is now consumed directly in Node.js.
- Removed unused `pullProfiles` config parameter; database connection is now closed in a `finally` block to prevent leaks.
- Express API rate limiter and request path handling corrected in the GUI server.

## [0.4.2] - 2026-04-20

### Added
- **`sfdt update` command**: checks npm for the latest published version and self-updates via `npm install -g @sfdt/cli@latest`. Prompts for confirmation before installing; use `--force` to skip the prompt.
- **GUI update check and streaming install**: the dashboard exposes `/api/check-updates` (compares current vs latest npm version) and `/api/update/stream` (SSE endpoint that streams live `npm install` output so updates can be triggered and monitored from the web UI).

## [0.4.1] - 2026-04-20

### Added
- **Shell completions** (`sfdt completion <bash|zsh|fish>`): generates ready-to-source completion scripts covering all commands and their flags — pipe to a file or `source` directly in your shell profile.
- **Version subcommand** (`sfdt version`): prints `sfdt vX.Y.Z`; complements the existing `-v` / `--version` flag and works as a proper subcommand in shell scripts.
- **`--dry-run` flag** on `deploy`, `rollback`, `preflight`, `smoke`, `pull`, and `test`: prints the script path, working directory, and all `SFDT_` env vars that would be set — no changes are made to the org.
- **Structured exit codes** (`src/lib/exit-codes.js`): `EXIT_SUCCESS` (0), `ERROR` (1), `CONFIG_ERROR` (2), `CONNECT_ERROR` (3). All 18 commands now map to the correct code instead of hardcoded `1`, making it easier to handle errors in CI scripts.

### Changed
- Config validation is now stricter with richer error messages: `defaultOrg` must be a non-empty string, `coverageThreshold` must be 0–100, `environments.orgs` must be an array, and `logDir` must be a string. Validation errors exit with code `2` (`CONFIG_ERROR`).
- Updated `express` from 4.x to 5.x.
- Updated `open` from 10.x to 11.x.

## [0.4.0] - 2026-04-19

### Added
- **Org Compare command** (`sfdt compare`): Side-by-side metadata inventory comparison between two Salesforce orgs. Streams live progress via SSE, showing added, removed, and changed components across all metadata types. Supports `--source` and `--target` org aliases with `--format json|table` output.
- **Compare page** (GUI): New Compare dashboard page with live streaming progress, filterable DataTable of component diffs (`CompareTable`), and collapsible side-by-side diff viewer (`DiffPanel`). Status badges and empty states follow SLDS conventions.
- **CommandRunner component**: Reusable GUI component for live CLI command execution with SSE streaming, used on Preflight, Drift, Test Runs, and Compare pages.
- `src/lib/org-inventory.js` / `src/lib/org-diff.js`: Org inventory retrieval and pure diff engine backing `sfdt compare`.

### Fixed
- Compare diff panel now works for all Salesforce metadata types (`CustomMetadata` records, foldered metadata) — validation now targets path traversal patterns instead of banning `.` and `/` in member names.
- Beta releases can no longer accidentally publish as `latest` — CI `publish` job on `main` now fails immediately if the version contains a pre-release suffix.

### Security
- Docs automation no longer executes repo-controlled instructions under write credentials — workflow instructions are now fully inline in the protected workflow YAML; unnecessary `id-token: write` permission removed.

## [0.3.2] - 2026-04-19

### Changed
- **GUI build toolchain updated to Vite 8**: `@vitejs/plugin-react` upgraded to v5, `esbuildOptions` removed (no longer supported), dedicated `gui-build` CI job added for Node 20 and 22
- Bumped `esbuild` and `vite` in GUI dependencies
- Bumped `inquirer` production dependency
- Bumped `prettier` development dependency
- CI: upgraded `actions/stale` from v9 to v10
- CI: upgraded `github/codeql-action` from v3 to v4

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
