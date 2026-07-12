# sfdt CLI — Command Reference

Detailed reference for the core sfdt commands, including options, arguments, and internal behavior. Newer commands are summarized in [Additional commands](#additional-commands) — run `sfdt <command> --help` for their full, always-current option list.

## Table of Contents

- [sfdt init](#sfdt-init)
- [sfdt deploy](#sfdt-deploy)
- [sfdt test](#sfdt-test)
- [sfdt quality](#sfdt-quality)
- [sfdt release](#sfdt-release)
- [sfdt pull](#sfdt-pull)
- [sfdt preflight](#sfdt-preflight)
- [sfdt rollback](#sfdt-rollback)
- [sfdt smoke](#sfdt-smoke)
- [sfdt review](#sfdt-review)
- [sfdt drift](#sfdt-drift)
- [sfdt compare](#sfdt-compare)
- [sfdt scan](#sfdt-scan)
- [sfdt config](#sfdt-config)
- [sfdt notify](#sfdt-notify)
- [sfdt changelog](#sfdt-changelog)
- [Additional commands](#additional-commands)

---

## sfdt init

Initialize sfdt configuration for a Salesforce DX project. Creates the `.sfdt/` directory with four config files.

**Usage**: `sfdt init`

**No options or arguments.**

**Behavior**:
1. Detects project root by finding `sfdx-project.json`
2. If `.sfdt/` already exists, prompts to overwrite
3. Interactive prompts for: projectName, defaultOrg, coverageThreshold (default 75), aiEnabled
4. Auto-scans `force-app/` for `*Test*.cls` and all `.cls` files using glob
5. Creates: `config.json`, `environments.json`, `pull-config.json`, `test-config.json`

**Prerequisite**: Must be in a directory with `sfdx-project.json` (or a subdirectory of one).

---

## sfdt deploy

Deploy to a Salesforce org — interactive manifest flow by default, or a self-contained smart delta deploy.

**Usage**: `sfdt deploy [--managed] [--smart] [options]`

**Options**:
| Flag | Description |
|------|-------------|
| `--managed` | Use `deploy-manager.sh` (structured, validation gates) instead of `deployment-assistant.sh` (interactive) |
| `--smart` | Smart delta deploy: git-diff-derived metadata only, `package-no-overwrite.xml` protection, minimal safe test level. Non-interactive; the CI mode |
| `--dry-run` | Show what would run (smart mode: validate-only via `sf project deploy validate`) |
| `--org <alias>` | Target org (default: config `defaultOrg`) |
| `--source-dir <path>` | Deploy a source directory instead of a manifest |
| `--delta-base <ref>` / `--delta-head <ref>` | Git range for the smart delta (defaults: config or `main` … `HEAD`) |
| `--prod` | Treat target as production — never downgrade the test level |
| `--skip-preflight` | Skip pre-deployment preflight checks |
| `--ai-deps` / `--ai-fix` | AI dependency cleanup on the delta / AI deploy-error analysis on failure |
| `--tag` / `--create-pr` / `--notify` | Post-deploy tagging, PR creation, notifications |
| `--pr-comment` | (smart mode) decorate the current PR with the delta + outcome |

**Scripts invoked** (non-smart): `scripts/core/deployment-assistant.sh`, or `scripts/core/deploy-manager.sh` with `--managed`. Smart mode is pure Node (`src/lib/smart-deploy.js`), no archive/commit side effects.

---

## sfdt test

Run Apex tests with the enhanced test runner.

**Usage**: `sfdt test [--legacy] [--analyze] [--class-names <list>] [--logic]`

**Options**:
| Flag | Description |
|------|-------------|
| `--legacy` | Use `run-tests.sh` instead of `enhanced-test-runner.sh` |
| `--analyze` | Run `test-analyzer.sh` after tests complete |
| `--class-names <list>` | Run only these Apex test classes (comma-separated), overriding configured classes |
| `--logic` | Run Apex + Flow tests together via `sf logic run test` (Spring '26 beta); pairs with `--org`, `--test-level`, `--tests`, `--category`, `--code-coverage`, `--wait` |

**Behavior**:
1. Runs selected test script (catches errors, doesn't immediately exit on failure)
2. If `--analyze`: runs `quality/test-analyzer.sh` post-tests
3. If tests failed AND AI is enabled: offers AI-powered failure analysis with Bash, Read, Grep tools
4. Exits with code 1 if tests failed

**Scripts invoked**:
- Default: `scripts/core/enhanced-test-runner.sh`
- With `--legacy`: `scripts/core/run-tests.sh`
- With `--analyze`: additionally `scripts/quality/test-analyzer.sh`

---

## sfdt quality

Run code quality analysis and optionally generate an AI fix plan.

**Usage**: `sfdt quality [--tests] [--all] [--fix-plan] [options]`

**Options**:
| Flag | Description |
|------|-------------|
| `--tests` | Run test-analyzer only (skip code-analyzer) |
| `--all` | Run both code-analyzer and test-analyzer |
| `--fix-plan` | Generate AI-powered fix plan grouped by severity |
| `--include-fixes` | Ask Code Analyzer v5 for actionable fixes/suggestions (feeds the fix plan) |
| `--generate-stubs` | Generate `@IsTest` stub classes for untested Apex (preview with `--dry-run`) |
| `--api67` / `--test-hints` | Targeted readiness scans (user-mode API v67; `@IsTest(testFor=...)` hints); both support `--json` |
| `--agent` | Non-interactive agent mode (don't block on the AI fix-plan session) |

**Behavior**:
- Default (no flags): runs `quality/code-analyzer.sh` only
- `--tests`: runs `quality/test-analyzer.sh` only
- `--all`: runs both analyzers
- `--fix-plan`: takes accumulated output and generates AI fix plan (requires AI enabled)

---

## sfdt release

Generate a release manifest and optionally AI-powered release notes.

**Usage**: `sfdt release [version] [--package <name|all>] [--name <label>]`

**Arguments / options**:
| Flag/Arg | Required | Description |
|----------|----------|-------------|
| `version` | No | Version label for the release |
| `--package <name\|all>` | No | Package directory to generate the manifest for (default: `all`) |
| `--name <label>` | No | Release label (semver, free-form, or `today`) |

**Behavior**:
1. Runs `scripts/core/generate-release-manifest.sh` (release label passed via `SFDT_RELEASE_NAME`)
2. If AI enabled and the provider available: prompts user to generate release notes
3. Release notes AI prompt analyzes `git log --oneline -30`
4. Output sections: What's New, Bug Fixes, Breaking Changes, Deployment Notes

---

## sfdt pull

Pull metadata changes from the default org.

**Usage**: `sfdt pull`

**No options or arguments.**

**Script invoked**: `scripts/core/pull-org-updates.sh`

Uses `pullConfig.metadataTypes` and `pullConfig.targetDir` from `.sfdt/pull-config.json`.

---

## sfdt preflight

Run pre-deployment validation checks.

**Usage**: `sfdt preflight [--strict]`

**Options**:
| Flag | Description |
|------|-------------|
| `--strict` | Fail on any warning (sets `SFDT_PREFLIGHT_STRICT=true`) |

**Script invoked**: `scripts/ops/preflight.sh`

---

## sfdt rollback

Roll back a deployment to a target org.

**Usage**: `sfdt rollback [--org <alias>] [--json]`

**Options**:
| Flag | Description |
|------|-------------|
| `--org <alias>` | Target org alias (default: config.defaultOrg) |
| `--json` | Emit structured JSON to stdout (CI mode) |

**Environment**: Sets `SFDT_TARGET_ORG` to specified or default org.

**Script invoked**: `scripts/ops/rollback.sh`

---

## sfdt smoke

Run post-deployment smoke tests against a target org.

**Usage**: `sfdt smoke [--org <alias>]`

**Options**:
| Flag | Description |
|------|-------------|
| `--org <alias>` | Target org alias (default: config.defaultOrg) |

**Environment**: Sets `SFDT_TARGET_ORG` to specified or default org.

**Script invoked**: `scripts/ops/smoke.sh`

---

## sfdt review

AI-powered Salesforce code review of current branch changes.

**Usage**: `sfdt review [--base <branch>]`

**Options**:
| Flag | Description |
|------|-------------|
| `--base <branch>` | Base branch to diff against (default: `main`) |

**Requirements**: AI must be enabled AND the configured provider available (see `ai.provider` in `references/config.md`).

**Behavior**:
1. Runs `git diff <base>...HEAD` to get branch diff
2. Fails if no diff found (nothing to review)
3. Sends diff to Claude with Salesforce-specific review rules
4. Review criteria: Governor Limits, Security, Null Safety, Test Coverage, LWC Best Practices, Bulk Patterns

---

## sfdt drift

Detect metadata drift between local source and a target org.

**Usage**: `sfdt drift [--org <alias>] [--json]`

**Options**:
| Flag | Description |
|------|-------------|
| `--org <alias>` | Target org alias (default: config.defaultOrg) |
| `--json` | Emit structured JSON to stdout (CI mode) |

**Environment**: Sets `SFDT_TARGET_ORG` to specified or default org.

**Script invoked**: `scripts/ops/drift.sh`

**Log file**: Writes `logs/drift-latest.json` after each run; the GUI Drift page reads this on load.

---

## sfdt notify

Send a notification through the configured channels (Slack, MS Teams, Google Chat, generic webhook, Grafana Loki, email).

**Usage**: `sfdt notify <event> [--version <ver>] [--org <alias>] [--message <msg>]`

**Arguments**:
| Argument | Required | Description |
|----------|----------|-------------|
| `event` | Yes | One of: `deploy-success`, `deploy-failure`, `test-failure`, `release-created`, `snapshot` |

**Options**:
| Flag | Description |
|------|-------------|
| `--version <ver>` | Version label to include in notification |
| `--org <alias>` | Org alias to include in notification |
| `--message <msg>` | Custom message text |
| `--type audit\|monitor` | With the `snapshot` event: which latest snapshot to dispatch |

**Requirements**: `notifications.enabled` with at least one entry in `notifications.channels[]`. Channel secrets are referenced by env-var **name** (`webhookUrlEnv`, SMTP `*Env`) — never stored inline. The legacy `notifications.slack.webhookUrl` shape is still honoured for back-compat.

**Behavior**: `dispatchSnapshot` filters channels by their `events` list and `severityThreshold`; when `notifications.summary.enabled`, an AI executive summary becomes the message body.

---

## sfdt changelog

Manage project CHANGELOG.md. Has three subcommands.

### sfdt changelog generate

Use AI to generate [Unreleased] entries from git history.

**Usage**: `sfdt changelog generate [--limit <number>]`

**Options**:
| Flag | Description |
|------|-------------|
| `--limit <number>` | Number of commits to analyze (default: 20) |

**Requirements**: AI enabled + the configured provider available (`isAiAvailable`). Creates CHANGELOG.md from template if it doesn't exist.

### sfdt changelog release

Move [Unreleased] changes to a new version section.

**Usage**: `sfdt changelog release <version>`

**Arguments**:
| Argument | Required | Description |
|----------|----------|-------------|
| `version` | Yes | Version number for the release section |

**Environment**: Sets `SFDT_VERSION` for the changelog-utils.sh script.

### sfdt changelog check

Verify [Unreleased] content against git changes.

**Usage**: `sfdt changelog check`

**Behavior**: Checks `git status --porcelain` for uncommitted changes, verifies [Unreleased] has content, and reports sync status. Offers to generate entries if section is empty.

---

## sfdt compare

Compare metadata between two orgs, or between local source and an org.

**Usage**: `sfdt compare [--source <alias|local>] [--target <alias>] [--output <file>]`

**Options**:
| Flag | Description |
|------|-------------|
| `--source <alias\|local>` | Source side of the comparison (default: `local`) |
| `--target <alias>` | Target org alias (default: `config.defaultOrg`) |
| `--output <file>` | Write a `package.xml` of source-only + modified components to this path |

**Behavior**:
1. Fetches metadata member inventory from both sides (Phase 1)
2. Diffs inventories to produce statuses: `source-only`, `target-only`, `both`
3. Writes `logs/compare-latest.json`
4. If `--output` is provided, generates a `package.xml` of source-only + modified items

**Implementation**: Pure Node.js using `org-inventory.js` and `org-diff.js`. No shell script.

**GUI routes**: `POST /api/compare` (Phase 1), `GET /api/compare/stream` (Phase 2 SSE content diffs), `POST /api/compare/manifest`, `GET /api/compare/diff`.

---

## sfdt scan

Fetch a complete metadata member inventory from an org and write it as structured JSON.

**Usage**: `sfdt scan [--org <alias>] [--output <file>] [--format json|table]`

**Options**:
| Flag | Description |
|------|-------------|
| `--org <alias>` | Org alias to scan (default: `config.defaultOrg`) |
| `--output <file>` | Output file path (default: `logs/scan-latest.json`) |
| `--format <fmt>` | `json` (default, machine-readable) or `table` (grouped count summary printed to stdout) |

**Behavior**:
1. Calls `fetchOrgInventory()` from `org-inventory.js`, batching `sf org list metadata` calls in groups of 5
2. Structures result as `{ timestamp, org, inventory: { TypeName: [members] }, summary: { totalTypes, totalMembers } }`
3. Always writes JSON to the output path (regardless of `--format`)
4. If `--format table`: also prints a grouped type/count summary to stdout

**Writes**: `logs/scan-latest.json` (default); the GUI Scan page reads this on load.

---

## sfdt config

Read and write `.sfdt/config.json` values without hand-editing the file.

### sfdt config set

**Usage**: `sfdt config set <key> <value>`

**Arguments**:
| Argument | Required | Description |
|----------|----------|-------------|
| `key` | Yes | Dot-notation path to the config field (e.g. `deployment.coverageThreshold`) |
| `value` | Yes | Value to set |

**Value coercion**:
| Input string | Stored as |
|-------------|-----------|
| `"true"` / `"false"` | boolean |
| Numeric strings (`"75"`) | number |
| Anything else | string |

**Behavior**: Deep-sets the key in the loaded config object, then writes back to `.sfdt/config.json`. Unknown keys are allowed (written with a warning).

### sfdt config get

**Usage**: `sfdt config get <key>`

**Arguments**:
| Argument | Required | Description |
|----------|----------|-------------|
| `key` | Yes | Dot-notation path to the config field (e.g. `defaultOrg`) |

**Behavior**: Loads config (including sfdx-project.json enrichment) and prints the resolved value to stdout. Exits with code 1 if the key is not found.

---

## Additional commands

Compact reference for the rest of the CLI. Run `sfdt <command> --help` for the full option list; most support `--json` (sf-native `{ status, result, warnings }` envelope on stdout) and `--org <alias>`.

### Org health

| Command | Summary |
|---------|---------|
| `sfdt audit [all\|<check>] [--org] [--json] [--notify]` | Native org health audit (clean-room sfdx-hardis-style checks): audit trail, licenses, MFA, unused/unreferenced Apex, inactive users/flows/validations/workflows, API versions, permission sets, connected apps, field descriptions, object & field access. Writes `logs/audit-latest.json` + archives under `logs/audit-results/` |
| `sfdt monitor [all\|<check>] [--org] [--json] [--notify]` | Org monitoring: limits, Apex job failures, security health-check score, org info, deployment history, legacy API usage, paused flows, metadata backup. Writes `logs/monitor-latest.json` |
| `sfdt history [--type <t>] [--limit <n>] [--json]` | Queryable run history (SQLite index in `logs/history.db`) across audit/monitor/test/deploy/quality runs |
| `sfdt coverage [--org] [--threshold <pct>] [--json]` | Org-wide + per-class Apex coverage; exits non-zero below the threshold (default 75) |
| `sfdt flow scan\|conflicts [--org] [--output <file>] [--json]` | Flow health analysis via `@sfdt/flow-core`; `conflicts` lists record-triggered flows colliding on object + timing + event |
| `sfdt dependencies <name> [--type <t>] [--gaps] [--org]` | Tooling-API dependency graph for a component (both directions); `--gaps` adds source-parsed inferred edges the API misses |

### Docs, data, scratch

| Command | Summary |
|---------|---------|
| `sfdt docs generate [--ai] [--no-ai] [--roles [list]] [--no-diagrams] [--json]` | MkDocs markdown for objects/Apex/Flows/LWC + ER diagram; `--roles` adds AI-authored per-component role guides |
| `sfdt docs diagram [--output <file>]` | Standalone ER diagram |
| `sfdt data list\|export\|import\|delete <set> [--org]` | Named data sets over `sf data export/import tree` for sandbox & scratch seeding |
| `sfdt scratch create\|delete\|list` | Scratch org lifecycle using the configured definition file |
| `sfdt scratch pool` | Maintain a pool of pre-created scratch orgs |

### CI, PRs, releases

| Command | Summary |
|---------|---------|
| `sfdt ci init --provider github\|gitlab\|azure\|bitbucket --type monitor\|deploy` | Generate a ready-to-use pipeline (scheduled monitoring or PR smart deploy) |
| `sfdt pr comment [--type audit\|monitor] [--body\|--file]` | Post the latest snapshot (or arbitrary content) as a PR comment via `gh` |
| `sfdt pr-description` (alias `pr-desc`) | Generate a PR description or Slack message from deployment changes |
| `sfdt retrofit --source <a> --target <b> [--execute]` | Retrieve a configured metadata set from source org → commit → smart-deploy to target (validate-only unless `--execute`) |
| `sfdt agent-test [--notify]` | Run an Agentforce agent test (`sf agent test run`) as a CI gate with pass/fail exit code |
| `sfdt explain [file]` | AI analysis of a deployment error log |

### Tooling & meta

| Command | Summary |
|---------|---------|
| `sfdt ui` | Local Express dashboard on port 7654 (requires the pre-built `gui/dist/`) |
| `sfdt mcp` | Manage the MCP server exposing sfdt tools to AI agents/IDEs |
| `sfdt skills export --target claude\|cursor\|codex\|windsurf\|pack [--out <dir>]` | Export the bundled agent skills as IDE rules files or an `npx skills`-compatible pack |
| `sfdt plugin` | Manage sfdt CLI plugins (`sfdt-plugin-*` packages, `.sfdt/plugins/*.js`) |
| `sfdt extension` / `sfdt feature-flags` | Chrome extension native-messaging bridge; extension kill-switches |
| `sfdt doctor [--extension]` | Diagnose the local install (Node, sf CLI, config, bridge stack) |
| `sfdt ai` | AI utilities (provider status, prompt management) |
| `sfdt completion [shell]` | Shell completion script (bash, zsh, fish) |
| `sfdt update` | Self-update from npm |
| `sfdt version` | Print the version |
