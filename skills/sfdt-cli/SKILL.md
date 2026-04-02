---
name: sfdt-cli
description: "Guide for using the @sfdt/cli (Salesforce DevTools) CLI in any Salesforce DX project. Use this skill whenever the user mentions sfdt, Salesforce deployment, Salesforce testing, Apex test coverage, org metadata drift, Salesforce release manifests, or wants to deploy/test/pull/review Salesforce code. Also use when you see a .sfdt/ config directory, sfdx-project.json, or the user asks about Salesforce DX CI/CD workflows, even if they don't mention sfdt by name."
---

# sfdt CLI — Salesforce DevTools

`@sfdt/cli` is a Node.js CLI that wraps Salesforce DX workflows into opinionated, configurable commands. It handles deployment, testing, quality analysis, release management, metadata pulls, rollback, drift detection, and AI-powered code review for any Salesforce DX project.

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

**Prerequisites**: Node.js >= 18, Salesforce CLI (`sf`), and optionally the Claude CLI (for AI features).

## Commands quick reference

| Command | What it does |
|---------|-------------|
| `sfdt init` | Initialize `.sfdt/` config (interactive prompts) |
| `sfdt deploy [--managed]` | Deploy to default org |
| `sfdt test [--legacy] [--analyze]` | Run Apex tests with coverage |
| `sfdt quality [--tests] [--all] [--fix-plan]` | Code/test quality analysis |
| `sfdt release [version]` | Generate release manifest + optional AI release notes |
| `sfdt pull` | Pull metadata from default org |
| `sfdt preflight [--strict]` | Pre-deployment validation |
| `sfdt rollback [--org <alias>]` | Rollback a deployment |
| `sfdt smoke [--org <alias>]` | Post-deploy smoke tests |
| `sfdt review [--base <branch>]` | AI-powered Salesforce code review |
| `sfdt drift [--org <alias>]` | Detect org metadata drift |
| `sfdt notify <event> [--version] [--org] [--message]` | Slack notifications |
| `sfdt changelog generate [--limit <n>]` | AI-generate changelog entries |
| `sfdt changelog release <version>` | Move [Unreleased] to version section |
| `sfdt changelog check` | Verify changelog vs git changes |

For full command details including options, arguments, and behavior, read `references/commands.md`.

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

AI-powered commands (`review`, `quality --fix-plan`, `changelog generate`, `release` notes) only work when:
1. `features.ai` is `true` in `.sfdt/config.json`
2. The Claude CLI is installed and available on PATH

If either condition fails, the command exits with a message — it does not error.

### Targeting different orgs

Most commands use the `defaultOrg` from config. Commands that accept `--org <alias>` (rollback, smoke, drift) override this for one-off operations against other orgs.

### The `--managed` deploy flag

`sfdt deploy` uses `deployment-assistant.sh` by default (interactive). Pass `--managed` to use `deploy-manager.sh` which provides validation gates and structured deployment flow.

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
sfdt changelog generate     # AI-generate changelog from commits
sfdt changelog release 1.2.0  # Move unreleased to version
sfdt release 1.2.0         # Generate manifest + release notes
```

### "Check for org drift"
```bash
sfdt drift                  # Check default org
sfdt drift --org staging    # Check specific org
```

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| "Run `sfdt init` first" | No `.sfdt/` directory found | Run `sfdt init` in project root |
| "AI features are not enabled" | `features.ai` is false | Edit `.sfdt/config.json`, set `features.ai: true` |
| "Claude CLI not found" | Claude not installed | Install Claude CLI separately |
| Command can't find `sf` | Salesforce CLI not on PATH | Install `@salesforce/cli` globally |
| Deploy fails | Org auth expired | Run `sf org login web -a <alias>` |

## Development (contributing to sfdt itself)

```bash
git clone https://github.com/scoobydrew83/sfdt.git
cd sfdt
npm install
npm link          # Makes 'sfdt' available globally
npm test          # Vitest test suite
npm run lint      # ESLint
npm run test:coverage  # Coverage report
```

**Architecture**: Commands in `src/commands/` are thin — they load config and call `runScript()`. Business logic lives in shell scripts under `scripts/`. Shared Node.js utilities are in `src/lib/` (config, output, AI, script-runner, project-detect).

**Testing pattern**: Mock `execa` for shell script calls, mock `fs-extra` for filesystem operations, mock `inquirer` for interactive prompts. Use `vi.mock()` at module level.
