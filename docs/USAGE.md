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
   - [sfdt quality](#sfdt-quality)
7. [Commands: Metadata and Source Control](#commands-metadata-and-source-control)
   - [sfdt manifest](#sfdt-manifest)
   - [sfdt pull](#sfdt-pull)
   - [sfdt drift](#sfdt-drift)
   - [sfdt compare](#sfdt-compare)
8. [Commands: Release Management](#commands-release-management)
   - [sfdt release](#sfdt-release)
   - [sfdt changelog](#sfdt-changelog)
9. [Commands: AI Intelligence](#commands-ai-intelligence)
   - [sfdt explain](#sfdt-explain)
   - [sfdt review](#sfdt-review)
   - [sfdt pr-description](#sfdt-pr-description)
10. [Commands: Operations](#commands-operations)
    - [sfdt notify](#sfdt-notify)
    - [sfdt ui](#sfdt-ui)
11. [Web Dashboard](#web-dashboard)
12. [Drift vs Compare: choosing the right tool](#drift-vs-compare-choosing-the-right-tool)
13. [Common workflows](#common-workflows)
14. [CI/CD integration](#cicd-integration)

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
| API key | Stored securely in `~/.sfdt/credentials.json` (Gemini/OpenAI only) |
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

**After init:** Add `.sfdt/*.local.json` to your `.gitignore` to avoid committing environment-specific overrides.

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

Requires a Google AI API key:

```bash
export GEMINI_API_KEY=your-key
# or store it permanently via:
sfdt init  # and choose Gemini
```

Configure:

```json
{
  "ai": { "provider": "gemini", "model": "gemini-2.0-flash" }
}
```

Default model: `gemini-2.0-flash`. Override with `ai.model`. Gemini runs a multi-turn tool loop with local tool implementations (file read, grep, git log) — it cannot access the filesystem directly the way Claude Code can, but it uses the same prompts and produces equivalent output.

### Provider: OpenAI

Requires an OpenAI API key:

```bash
export OPENAI_API_KEY=sk-...
```

```json
{
  "ai": { "provider": "openai", "model": "gpt-4o-mini" }
}
```

Default model: `gpt-4o-mini`. Override with `ai.model`. Same local tool loop as Gemini.

### API key storage

API keys for Gemini and OpenAI are stored in `~/.sfdt/credentials.json` (mode `0600`) — never in the project config file. The lookup order is:

1. `~/.sfdt/credentials.json`
2. Environment variables (`GEMINI_API_KEY`, `GOOGLE_AI_API_KEY`, `OPENAI_API_KEY`)
3. Legacy `config.ai.apiKey` (backwards compatibility only — do not use for new projects)

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
```

**Options:**

| Option | Description |
|---|---|
| `--managed` | Use `deploy-manager.sh` instead of `deployment-assistant.sh` for managed package deployments |
| `--skip-preflight` | Skip the preflight validation step and go straight to deployment |

**What happens:**

1. Preflight runs (`new/preflight.sh`) unless `--skip-preflight` is set. If preflight fails, the deploy is aborted.
2. The deployment script runs (`core/deployment-assistant.sh` or `core/deploy-manager.sh`).
3. Output is streamed directly to your terminal with full TTY passthrough (spinner, colors, interactive prompts from the script).

Use `--managed` when deploying a second-generation managed package where the deploy-manager script handles namespace and version locking.

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
```

**Options:**

| Option | Description |
|---|---|
| `--legacy` | Use `run-tests.sh` instead of the enhanced runner |
| `--analyze` | Run the test analyzer (`quality/test-analyzer.sh`) after tests complete, regardless of pass/fail |

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
sfdt quality                    # code analyzer only (default)
sfdt quality --tests            # test analyzer only
sfdt quality --all              # both analyzers
sfdt quality --fix-plan         # run analyzer + AI fix plan
sfdt quality --generate-stubs   # generate @IsTest stub classes for untested Apex
sfdt quality --generate-stubs --dry-run  # preview stubs without writing files
```

**Options:**

| Option | Description |
|---|---|
| `--tests` | Run `quality/test-analyzer.sh` only |
| `--all` | Run both `quality/code-analyzer.sh` and `quality/test-analyzer.sh` |
| `--fix-plan` | After analysis, send the output to AI for a prioritized, file-specific fix plan |
| `--generate-stubs` | Generate `@IsTest` stub classes for Apex classes that have no test class |
| `--dry-run` | Preview `--generate-stubs` output without writing any files |

**AI fix plan:** The fix plan groups issues by severity (critical, high, medium, low) and provides file locations, descriptions, and concrete code suggestions. It focuses on Salesforce-specific concerns: governor limits, CRUD/FLS enforcement, bulk-safe patterns, and test coverage gaps.

---

## Commands: Metadata and Source Control

### sfdt manifest

Generates a `package.xml` from a git diff. Understands Salesforce metadata file naming conventions to map changed files to their metadata types and member names. Optionally invokes AI to check the manifest for likely missing dependencies before you deploy.

```bash
sfdt manifest                             # diff main...HEAD, write to manifest/release/preview-package.xml
sfdt manifest --base develop              # diff from develop
sfdt manifest --base abc1234              # diff from a specific commit SHA
sfdt manifest --output deploy/pkg.xml    # custom output path
sfdt manifest --destructive dist/del.xml # also write destructiveChanges.xml
sfdt manifest --print                    # print to stdout instead of writing a file
sfdt manifest --ai-cleanup               # run AI dependency check on the manifest
sfdt manifest --no-ai-cleanup            # skip AI check even when AI is enabled
```

**Options:**

| Option | Description |
|---|---|
| `--base <ref>` | Base git ref to diff from (default: `main`). Accepts branch names or commit SHAs. |
| `--head <ref>` | Head git ref to diff to (default: `HEAD`) |
| `--output <path>` | Output path for `package.xml`. Defaults to `<manifestDir>/preview-package.xml` |
| `--destructive <path>` | Also write a `destructiveChanges.xml` for deleted components to this path |
| `--ai-cleanup` | Run AI dependency analysis on the generated manifest |
| `--no-ai-cleanup` | Skip AI dependency analysis even when `features.ai` is enabled |
| `--print` | Print `package.xml` to stdout instead of writing a file |

**Merge-base resolution:** When `--base` is a branch name, sfdt automatically computes the merge-base between the base branch and HEAD. This prevents including commits already on the base branch in your manifest. To bypass this and diff from the branch tip directly, pass an explicit commit SHA.

**AI dependency cleanup:** The AI reviews the manifest against the actual source files and flags likely missing dependencies (e.g. a new `CustomField` that's missing its parent `CustomObject`, or an `ApexClass` referenced in a `Flow` that's not included). It groups findings into MISSING, RISKY, and OK and concludes with a one-line verdict.

**Destructive changes:** If deleted files are detected in the diff, sfdt warns you. Rerun with `--destructive <path>` to emit the `destructiveChanges.xml` alongside the additive manifest.

---

### sfdt pull

Pulls metadata from the configured default org into your local source directory. Metadata types and target directory are controlled by `.sfdt/pull-config.json`.

```bash
sfdt pull
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

Add or remove metadata types to control what gets pulled. Run `sfdt pull` after changes are made directly in the org (e.g. by an admin) to bring your source directory in sync.

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

Manages `CHANGELOG.md`. Three subcommands: `generate`, `release`, and `check`.

#### sfdt changelog generate

Uses AI to analyze recent git commits and generate `[Unreleased]` entries in `CHANGELOG.md`. Creates the file from a standard template if it does not exist.

```bash
sfdt changelog generate
sfdt changelog generate --limit 30
```

**Options:**

| Option | Description |
|---|---|
| `--limit <n>` | Number of commits to analyze (default: 20) |

The AI categorizes changes into Added, Changed, Fixed, Deprecated, Removed, and Security sections. After the AI produces the entries, sfdt asks whether to append them to the `[Unreleased]` section of `CHANGELOG.md`.

Requires `features.ai: true` and a configured provider.

---

#### sfdt changelog release

Moves the `[Unreleased]` section of `CHANGELOG.md` to a new versioned section with the current date.

```bash
sfdt changelog release 1.5.0
```

**Arguments:**

| Argument | Description |
|---|---|
| `<version>` | Semver version string. Must match `X.Y.Z` format. |

This command edits `CHANGELOG.md` in place. Run it just before tagging a release. It does not commit — stage and commit the file yourself (or run `sfdt release` which does this as part of its git workflow).

---

#### sfdt changelog check

Validates that `CHANGELOG.md` is in sync with the current git state. Warns if you have uncommitted code changes but the `[Unreleased]` section is empty.

```bash
sfdt changelog check
```

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

## Commands: Operations

### sfdt notify

Sends a structured notification to Slack for a deployment lifecycle event. Uses the Slack Incoming Webhooks API.

```bash
sfdt notify deploy-success
sfdt notify deploy-failure --org production --version 1.5.0
sfdt notify test-failure --message "Coverage dropped below threshold"
sfdt notify release-created --version 1.5.0
```

**Arguments:**

| Argument | Description |
|---|---|
| `<event>` | One of: `deploy-success`, `deploy-failure`, `test-failure`, `release-created` |

**Options:**

| Option | Description |
|---|---|
| `--version <ver>` | Version label to include in the notification |
| `--org <alias>` | Org alias to display (defaults to `config.defaultOrg`) |
| `--message <msg>` | Custom message body |

**Setup:** Configure a Slack Incoming Webhook and add it to `.sfdt/config.json`:

```json
{
  "features": { "notifications": true },
  "notifications": {
    "slack": {
      "webhookUrl": "https://hooks.slack.com/services/T.../B.../..."
    }
  }
}
```

If `features.notifications` is `false` or no webhook URL is configured, the command exits with an error and prints setup instructions.

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

## Web Dashboard

The dashboard has five pages:

| Page | What it shows | Data source |
|---|---|---|
| **Dashboard** | Summary stat cards: last test run (pass/fail/coverage), preflight status, drift status | `logs/preflight-latest.json`, `logs/drift-latest.json`, `logs/test-results/` |
| **Test Runs** | Apex test history with coverage colouring; run tests from the UI | `logs/test-results/*.json` |
| **Preflight** | Per-check pass/warn/fail list; run preflight from the UI | `logs/preflight-latest.json` |
| **Drift Detection** | Filterable component table (All / Clean / Drift); run drift check from the UI | `logs/drift-latest.json` |
| **Compare** | Org comparison results: source-only, target-only, and shared components; XML diff of individual components; export source-only items as `package.xml` | `logs/compare-latest.json` |

**Live command runner:** The Test Runs, Preflight, and Drift pages each have a "Run" button that triggers the corresponding shell script via a Server-Sent Events stream. Output appears line-by-line in the UI in real time, the same as running the CLI command directly.

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

For Gemini or OpenAI in CI, set the API key as a secret environment variable:

```yaml
- name: Explain failure
  if: failure()
  run: sfdt explain --latest
  env:
    GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

Claude is not suitable for CI use (it requires an interactive session). Use Gemini or OpenAI for CI-based AI commands.

### Exit codes

All sfdt commands exit `0` on success and `1` on failure. Use standard shell `set -e` or check `$?` to gate subsequent steps.
