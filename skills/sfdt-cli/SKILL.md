---
name: sfdt-cli
description: "Guide for using AND contributing to the @sfdt/cli (Salesforce DevTools) CLI. Use when: (1) the user mentions sfdt commands, deployment, testing, Apex coverage, org drift, org health audits/monitoring, docs generation, or release manifests; (2) you see a .sfdt/ directory or sfdx-project.json and the user wants CLI-driven workflows; (3) the user says sfdt should/could support something, wants to add a command, extend config, or suggests sfdt can help with a task — this means implementing the feature in the CLI itself."
triggers:
  - sfdt
  - ".sfdt/"
  - salesforce devtools
  - deploy salesforce
  - org drift
  - org audit
  - release manifest
---

# sfdt CLI — Salesforce DevTools

`@sfdt/cli` is a Node.js CLI that wraps Salesforce DX workflows into opinionated, configurable commands. It handles deployment (including smart delta deploys), testing, quality analysis, release management, metadata pulls, rollback, drift detection, org health audits and monitoring, documentation generation, data seeding, scratch-org pooling, notifications, and AI-powered code review for any Salesforce DX project. It also ships a web dashboard (`sfdt ui`), an MCP server (`sfdt mcp`), a VS Code extension, and an `sf` CLI plugin (`sf sfdt <command>`).

## When to use this skill

- The user mentions `sfdt` or any of its commands
- You see a `.sfdt/` directory in the project
- The user wants to deploy, test, pull, review, or release Salesforce code
- The user asks about Apex test coverage, org drift, or deployment validation
- The project has `sfdx-project.json` and the user wants CLI-driven workflows

## How sfdt works

sfdt is a **generic tool** — it contains no project-specific values. All configuration lives in a `.sfdt/` directory created per-project by `sfdt init`. Commands are thin wrappers that load config, set `SFDT_`-prefixed environment variables, and delegate to shell scripts in `scripts/`.

```
User runs command → Load .sfdt/ config → Set SFDT_* env vars → Execute shell script
```

**Prerequisites**: Node.js >= 18, Salesforce CLI (`sf`), and optionally an AI provider (see "AI features" below).

## Commands quick reference

**Deploy & release**

| Command | What it does |
|---------|-------------|
| `sfdt deploy [--managed] [--smart] [--source-dir <path>]` | Deploy to an org; `--smart` computes a git delta with smart test selection; `--source-dir` deploys a folder without a manifest |
| `sfdt preflight [--strict]` | Pre-deployment validation gates |
| `sfdt rollback [--org <alias>] [--json]` | Roll back a deployment |
| `sfdt smoke [--org <alias>]` | Post-deploy smoke tests |
| `sfdt manifest [--package <name\|all>] [--name <label>] [--destructive <path>]` | Generate scoped `package.xml` (and destructive manifest) from git diff |
| `sfdt release [--package <name\|all>] [--name <label>]` | Release manifest + optional AI release notes |
| `sfdt changelog generate\|release\|check` | AI-generate entries, cut a version section, verify vs git |
| `sfdt retrofit --source <a> --target <b> [--execute]` | Retrieve from source org → commit → smart-deploy to target |
| `sfdt explain [file]` | AI analysis of a deployment error log |

**Test & quality**

| Command | What it does |
|---------|-------------|
| `sfdt test [--analyze] [--logic] [--class-names <list>]` | Run Apex tests (`--logic`: unified Apex + Flow tests) |
| `sfdt coverage [--org <alias>] [--threshold <pct>]` | Org-wide + per-class coverage; non-zero exit below threshold |
| `sfdt quality [--all] [--fix-plan] [--include-fixes]` | Code Analyzer + test quality; optional AI fix plan |
| `sfdt review [--base <branch>]` | AI-powered code review of branch diff |
| `sfdt agent-test` | Run an Agentforce agent test as a CI gate |

**Org health & inspection**

| Command | What it does |
|---------|-------------|
| `sfdt audit [all\|<check>] [--org] [--json] [--notify]` | Org health audit: licenses, MFA, unused Apex, inactive users/flows/validations, API versions, FLS, … |
| `sfdt monitor [all\|<check>] [--org] [--json] [--notify]` | Org monitoring: limits, Apex failures, security score, deploy history, legacy API usage, backup |
| `sfdt drift [--org <alias>] [--json]` | Detect org metadata drift vs local source |
| `sfdt compare [--source <alias\|local>] [--target <alias>]` | Diff two orgs or local vs org; `--output` writes package.xml |
| `sfdt scan [--org <alias>] [--format json\|table]` | Full metadata inventory from an org |
| `sfdt dependencies <name> [--gaps]` | What a component references / is referenced by (Tooling API + source parsing) |
| `sfdt flow scan\|conflicts [--org] [--json]` | Flow health analysis; record-triggered flow collision detection |
| `sfdt history [--type <t>] [--limit <n>] [--json]` | Recent run history from the local index |
| `sfdt pull` | Pull metadata from default org |

**Project & data**

| Command | What it does |
|---------|-------------|
| `sfdt init` | Initialize `.sfdt/` config (interactive prompts) |
| `sfdt config get\|set <key> [value]` | Read/write config with dot notation |
| `sfdt docs generate [--ai] [--roles [list]]` | Generate project docs (objects/Apex/flows/LWC) + ER diagram |
| `sfdt data list\|export\|import\|delete <set>` | Named data sets over `sf data tree` for sandbox/scratch seeding |
| `sfdt scratch create\|delete\|list\|pool` | Scratch org lifecycle and pre-created org pooling |
| `sfdt notify <event> [--message <msg>]` | Notifications (Slack, Teams, Google Chat, webhook, Loki, email) |
| `sfdt pr comment [--type audit\|monitor]` | Post snapshots/results as PR comments (via `gh`) |
| `sfdt pr-description` | Generate a PR description from deployment changes |
| `sfdt ci init --provider <p> --type <t>` | Generate CI pipeline templates (GitHub/GitLab/Azure/Bitbucket) |

**Tooling & integrations**

| Command | What it does |
|---------|-------------|
| `sfdt ui` | Local web dashboard (port 7654) |
| `sfdt mcp` | Manage the MCP server (for AI agents/IDEs) |
| `sfdt skills export --target <t>` | Export these agent skills to Claude/Cursor/Codex/Windsurf or an `npx skills` pack |
| `sfdt plugin` | Manage sfdt CLI plugins |
| `sfdt extension` / `sfdt feature-flags` | Chrome extension bridge + kill-switches |
| `sfdt doctor [--extension]` | Diagnose the local sfdt install |
| `sfdt ai` / `sfdt completion` / `sfdt update` | AI utilities, shell completion, self-update |

Most commands support `--json`, emitting an sf-native `{ status, result, warnings }` envelope on stdout. For full command details including options, arguments, and behavior, read `references/commands.md`.

## Configuration system

`sfdt init` creates a `.sfdt/` directory with four JSON files:

| File | Purpose |
|------|---------|
| `config.json` | Project name, default org, feature flags (ai, notifications, releaseManagement) |
| `environments.json` | Org aliases with types (development, staging, production) |
| `pull-config.json` | Metadata types to pull and target directory |
| `test-config.json` | Coverage threshold, test level, test suites, test classes |

Config is enriched at load time with values from `sfdx-project.json` (sourceApiVersion, defaultSourcePath from packageDirectories).

For the full config schema and SFDT_ environment variable mapping, read `references/config.md`.

## Using sfdt from AI agents

sfdt is designed to be composable and callable by AI agents, not just humans in a terminal. All commands are non-interactive by default when stdin is not a TTY (`SFDT_NON_INTERACTIVE=true`), making them safe to invoke from agent subprocesses.

## Key patterns to follow

### Running sfdt commands

Always ensure the user is in a Salesforce DX project directory (has `sfdx-project.json`) before running sfdt commands. If `.sfdt/` doesn't exist yet, run `sfdt init` first.

```bash
# First-time setup
sfdt init

# Typical workflow
sfdt preflight              # Validate before deploy
sfdt deploy                 # Deploy to default org
sfdt smoke                  # Verify deployment
sfdt test --analyze         # Run tests + analysis
```

### AI features require opt-in

AI-powered commands (`review`, `explain`, `quality --fix-plan`, `changelog generate`, `release` notes, `docs generate --ai`) only work when:
1. `features.ai` is `true` in `.sfdt/config.json`
2. The configured provider is available. `ai.provider` selects it: `claude` (Claude Code CLI), `gemini` (Gemini CLI), `openai` (Codex CLI), or `http` (any OpenAI-compatible endpoint — Ollama, OpenRouter, etc. — via `ai.baseURL`/`ai.model`/`ai.apiKeyEnv`)

If either condition fails, the command exits with a friendly message — it does not error. The three CLI providers run agentic subprocesses (read-only sandbox); the `http` provider is plain text completion, so agentic commands pre-gather context for it instead.

### Targeting different orgs

Most commands use the `defaultOrg` from config. Commands that accept `--org <alias>` (deploy, rollback, smoke, drift, audit, monitor, coverage, flow, data, …) override this for one-off operations against other orgs.

### Deploy modes

`sfdt deploy` uses `deployment-assistant.sh` by default (interactive). Two alternatives:
- `--managed` uses `deploy-manager.sh` — validation gates and structured deployment flow
- `--smart` runs a self-contained non-interactive delta deploy: computes changed metadata from the git diff, respects `package-no-overwrite.xml`, and picks the minimal safe test level (never downgrades tests in production). Combine with `--dry-run` for validate-only, `--pr-comment` to decorate the PR, or `--ai-fix` for AI-assisted error fixing. This is the mode CI pipelines use.

## Common tasks

### "Set up sfdt in my Salesforce project"
```bash
cd /path/to/salesforce-project
npm install -g @sfdt/cli   # or: npx @sfdt/cli init
sfdt init                   # Interactive setup
```

### "Deploy and verify"
```bash
sfdt preflight --strict     # Fail on any warning
sfdt deploy                 # Deploy to default org  
sfdt smoke                  # Post-deploy verification
sfdt test                   # Run Apex tests
```

### "Review my changes before merging"
```bash
sfdt review --base main     # AI review of branch diff
sfdt quality --all --fix-plan  # Full quality scan + AI fix plan
```

### "Cut a release"
```bash
sfdt changelog generate           # AI-generate changelog from commits
sfdt changelog release 1.2.0      # Move unreleased to version
sfdt release 1.2.0                # Generate manifest + release notes
```

### "Multi-package project — scope a manifest to one package"
```bash
# Generates manifest/release/rl-1.2.0-feature-a-package.xml
sfdt manifest --package feature-a --name 1.2.0

# Deploy that folder directly without a manifest
sfdt deploy --source-dir force-app/feature-a

# All packages in one manifest
sfdt manifest --package all --name 1.2.0
```

`--package` matches the last segment of the `packageDirectories` path (e.g. `force-app/feature-a` → `feature-a`). Set `manifestLayout: subpath` in `.sfdt/config.json` to organize outputs into per-package subdirectories (`manifest/release/feature-a/rl-1.2.0-package.xml`).

### "Check for org drift"
```bash
sfdt drift                  # Check default org
sfdt drift --org staging    # Check specific org
```

### "Check org health"
```bash
sfdt audit all --org prod --json      # licenses, MFA, unused Apex, API versions, FLS, …
sfdt monitor all --org prod --notify  # limits, Apex failures, security score → notification channels
sfdt history --type audit --limit 10  # trend recent runs
```

### "Deploy only what changed in this branch (CI)"
```bash
sfdt deploy --smart --dry-run   # validate the delta
sfdt deploy --smart --prod      # real deploy, tests never downgraded
```

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| "Run `sfdt init` first" | No `.sfdt/` directory found | Run `sfdt init` in project root |
| "AI features are not enabled" | `features.ai` is false | Edit `.sfdt/config.json`, set `features.ai: true` |
| AI provider not found | Configured provider CLI not installed | Install the CLI for `ai.provider` (claude/gemini/codex), or switch to the `http` provider |
| Command can't find `sf` | Salesforce CLI not on PATH | Install `@salesforce/cli` globally |
| Deploy fails | Org auth expired | Run `sf org login web -a <alias>` |

## Extending or modifying the sfdt CLI

When the user says sfdt **should** support something, **could** do something, or suggests sfdt **can help** with a task — that means implementing it in the CLI. Use the full implementation guide at [references/development.md](references/development.md).

**Quick orientation**:
- New command → `src/commands/<name>.js` + register in `src/cli.js`
- New shell script → `scripts/<category>/<name>.sh` (de-parameterized, reads `SFDT_` vars)
- New config key → start in `src/templates/sfdt.config.json` (source of truth)
- New `SFDT_` env var → update `buildScriptEnv()` in `src/lib/script-runner.js` AND the CLAUDE.md env var table — both must stay in sync

```bash
npm install && npm link   # dev setup
npm test                   # vitest
npm run lint               # ESLint
npm run test:coverage      # coverage report
```
