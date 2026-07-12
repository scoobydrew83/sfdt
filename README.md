<div align="center">

<img src=".github/assets/logo.png" alt="SFDT logo" width="96" height="96" />

# SFDT — Salesforce DevTools

**Deploy, test, and ship Salesforce changes with confidence.**

`@sfdt/cli` is the command-line core of the SFDT suite — a production-grade CLI for Salesforce DX
deployment, testing, quality analysis, and release management. Pairs with the SFDT Chrome
extension and the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=sfdt.sfdt-devtools).

📖 **[Read the docs at sfdt.dev →](https://sfdt.dev/)**  ·  [npm](https://www.npmjs.com/package/@sfdt/cli)  ·  [Usage guide](docs/USAGE.md)

[![npm version](https://img.shields.io/npm/v/@sfdt/cli.svg)](https://www.npmjs.com/package/@sfdt/cli)
[![npm downloads](https://img.shields.io/npm/dm/@sfdt/cli.svg)](https://www.npmjs.com/package/@sfdt/cli)
[![VS Code](https://img.shields.io/badge/VS%20Code-Marketplace-blue?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=sfdt.sfdt-devtools)
![Open VSX Version](https://img.shields.io/open-vsx/v/sfdt/sfdt-devtools)
[![CI](https://github.com/scoobydrew83/sfdt/actions/workflows/ci.yml/badge.svg)](https://github.com/scoobydrew83/sfdt/actions/workflows/ci.yml)
[![CodeQL](https://github.com/scoobydrew83/sfdt/actions/workflows/codeql.yml/badge.svg)](https://github.com/scoobydrew83/sfdt/actions/workflows/codeql.yml)
[![license](https://img.shields.io/npm/l/@sfdt/cli.svg)](https://github.com/scoobydrew83/sfdt/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@sfdt/cli.svg)](https://nodejs.org)

</div>

## Features

- Interactive deployment workflows with preflight validation, tagging, and PR creation
- Automated release manifest generation from git diffs
- Parallel Apex test execution with configurable coverage enforcement
- Code and test quality analysis with AI-powered fix plans
- Pre-release validation checklist (`sfdt preflight`)
- Deployment rollback with pre-rollback org state backup
- Post-deploy smoke testing
- Org metadata drift detection
- **Multi-package project support** — scope manifests and deploys to individual `packageDirectories` with `--package` and `--name`; deploy source folders directly with `--source-dir`
- **Smart package.xml generator** from git diffs with AI dependency cleanup (`sfdt manifest`)
- **AI deployment error log interpreter** with heuristic fallback for offline use (`sfdt explain`)
- **AI-generated PR descriptions and Slack messages** from deployment changes (`sfdt pr-description`)
- **AI-powered code review, test failure analysis, changelog generation, and release notes** — optional, works with Claude, Gemini, or OpenAI
- **Org metadata comparison** — diff two orgs or local source vs org with optional package.xml export (`sfdt compare`)
- **Local web dashboard** for test results, preflight, drift monitoring, and org comparison (`sfdt ui`)
- **Smart delta deployments** — minimal git-delta package with overwrite protection, automatic test-level selection, optional AI / coding-agent auto-fix (`sfdt deploy --smart`)
- **Native org health & operations suite** — diagnose (`sfdt audit`), monitor/backup (`sfdt monitor`), dependency analysis (`sfdt dependencies`), and Apex coverage gating (`sfdt coverage`)
- **CI/CD pipeline templates** for GitHub, GitLab, Azure, and Bitbucket (`sfdt ci init` — monitor, PR validation, approval-gated release, scratch-org CI), plus a published **GitHub Action** (`uses: scoobydrew83/sfdt@v0`); PR decoration (`sfdt pr comment`) and cross-org retrofit (`sfdt retrofit`)
- **Multi-channel notifications** — Slack, MS Teams, Google Chat, email, webhook, and Grafana Loki, with optional AI executive-summary digests (`sfdt notify`)
- **Plugin architecture** — extend sfdt with `sfdt-plugin-*` npm packages or local `.sfdt/plugins/` scripts, plus a **Salesforce CLI plugin** exposing every command as `sf sfdt <command>` (`sf plugins install @sfdt/plugin`)
- Works with **any** Salesforce DX project — no project-specific values hardcoded

For in-depth command walkthroughs and workflow examples, see [docs/USAGE.md](docs/USAGE.md).

## Repository layout

`@sfdt/cli` is one of five workspaces in this monorepo:

| Workspace | What it is | Status |
|---|---|---|
| **`@sfdt/cli`** (`/src`, `/bin`, `/scripts`) | The npm CLI documented below. | Published to npm |
| **`@sfdt/extension`** (`/extension`) | Chrome extension for Salesforce Flow Builder + Setup productivity. Talks to the CLI via the local bridge for deploy / rollback / quality / AI features. See [extension/README.md](extension/README.md) and [extension/PRIVACY.md](extension/PRIVACY.md). | Pre-Web-Store |
| **`sfdt-devtools`** (`/vscode`) | VS Code extension — a thin UI over the CLI (Org Health sidebar, command palette, embedded dashboard). See [vscode/README.md](vscode/README.md). | [Published to the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=sfdt.sfdt-devtools) |
| **`@sfdt/host`** (`/host`) | Native messaging host used as the extension's fallback transport when `sfdt ui` isn't running. Installed with `sfdt extension install-host`. | Bundled with CLI |
| **`@sfdt/flow-core`** (`/packages/flow-core`) | Shared TypeScript library — Flow normalization, rules engine, scoring, and the versioned bridge contract. Consumed by both CLI and extension. | Published to npm (publishes alongside the CLI) |

The CLI's `sfdt ui` command starts a local web dashboard (`/gui`) that exposes the same bridge endpoints the extension uses.

## Quick Start

```bash
npm install -g @sfdt/cli
cd your-salesforce-project
sfdt init
sfdt deploy
```

### Other install methods

```bash
# Bootstrap script (checks prerequisites, then installs via npm)
curl -fsSL https://raw.githubusercontent.com/scoobydrew83/sfdt/main/install.sh | bash

# Homebrew (macOS/Linux) — tap once, then install by name
brew tap scoobydrew83/sfdt
brew install sfdt
# (Third-party tap: it won't show in brew's website search, which only lists homebrew-core.)

# Docker (official multi-arch image)
docker run --rm -v "$PWD:/project" ghcr.io/scoobydrew83/sfdt:latest --help

# Salesforce CLI plugin — run every command as `sf sfdt <command>`
sf plugins install @sfdt/plugin
sf sfdt deploy --dry-run
```

> The `@sfdt/plugin` package is a thin wrapper over `@sfdt/cli` (it shells out to
> the same binary), so every command, flag, and `--json` output is identical to
> running `sfdt` directly. `--json` commands emit a Salesforce-native
> `{ status, result, warnings }` envelope. As an unsigned third-party plugin, `sf`
> shows a one-time security prompt on install.

**npm alternatives:** `pnpm add -g @sfdt/cli` · `yarn global add @sfdt/cli` · one-off `npx @sfdt/cli --help`.

**From source (contributors):**

```bash
git clone https://github.com/scoobydrew83/sfdt.git && cd sfdt
npm install
npm link            # makes `sfdt` available globally from your checkout
npm run build:gui   # build the local web dashboard
```

Full install reference — every method plus CI usage — at **[sfdt.dev/cli/installation](https://sfdt.dev/cli/installation)**.

## Commands Reference

### Core

| Command | Description | Key Options |
|---|---|---|
| `sfdt init` | Initialize `.sfdt/` config (interactive) | — |
| `sfdt deploy` | Deploy to a Salesforce org | `--managed`, `--skip-preflight`, `--dry-run`, `--source-dir <path>` |
| `sfdt deploy --smart` | Smart git-delta deploy: minimal package, overwrite protection, auto test-level | `--delta-base <ref>`, `--delta-head <ref>`, `--prod`, `--pr-comment`, `--ai-fix`, `--agent` |
| `sfdt release` | Generate release manifest + optional AI release notes | `--package <name\|all>`, `--name <label>` |
| `sfdt test` | Run Apex tests with the enhanced test runner; `--logic` runs unified Apex + Flow tests via `sf logic run test`; `--lwc` runs the project's local LWC (Jest) unit tests | `--legacy`, `--analyze`, `--logic`, `--lwc`, `--class-names <list>`, `--dry-run` |
| `sfdt pull` | Pull metadata from the configured org | `--dry-run` |
| `sfdt preflight` | Run pre-deployment validation checks | `--strict`, `--dry-run` |
| `sfdt rollback` | Roll back a deployment to a target org | `--org <alias>`, `--dry-run`, `--json` |
| `sfdt smoke` | Post-deploy smoke tests | `--org <alias>`, `--dry-run` |
| `sfdt drift` | Detect metadata drift between local source and an org | `--org <alias>`, `--json` |
| `sfdt compare` | Compare metadata between two orgs or local source vs an org | `--source <alias\|local>`, `--target <alias>`, `--output <file>` |
| `sfdt scan` | Fetch complete metadata inventory from an org | `--org <alias>`, `--output <file>`, `--format json\|table` |
| `sfdt notify` | Multi-channel notifications (Slack, Teams, Google Chat, email, webhook, Loki); `notify snapshot --type audit\|monitor` pushes the latest org-health snapshot | `--org <alias>`, `--version <ver>`, `--message <msg>`, `--type <audit\|monitor>` |
| `sfdt pr comment` | Post the latest audit/monitor snapshot (or `--body`/`--file`) to the current PR via `gh` | `--type <audit\|monitor>`, `--body <md>`, `--file <path>`, `--pr <n>` |
| `sfdt retrofit` | Retrieve a metadata set from a source org, commit, then smart-deploy to a target (validate-only unless `--execute`) | `--source <alias>`, `--target <alias>`, `--execute` |
| `sfdt agent-test` | Run an Agentforce agent test (`sf agent test run`) as a CI gate; pass/fail comes from the exit code | `--spec <name>`, `--org <alias>`, `--wait <min>`, `--pass-rate <pct>`, `--notify`, `--pr-comment` |
| `sfdt ci init` | Generate a CI/CD pipeline (scheduled monitor, PR smart-deploy, approval-gated release, or scratch-org CI) for a provider | `--provider <github\|gitlab\|azure\|bitbucket>`, `--type <monitor\|deploy\|release\|scratch>`, `--auth <sfdx-url\|jwt>`, `--runner <npx\|docker\|action>` |

### Org Health & Operations

| Command | Description | Key Options |
|---|---|---|
| `sfdt audit [check\|all]` | Diagnose org health (~15 checks): audit trail, licenses, MFA, unused Apex/perm-sets, inactive users/flows, inactive validation & workflow rules, connected apps, field descriptions, object- & field-level access lint, API versions | `--org <alias>`, `--json`, `--notify` |
| `sfdt monitor [check\|all]` | Monitor org (~7 checks): limits, Apex job errors, health score, org info, deploy history, deprecated API, flow errors; `all --backup` to include a metadata backup | `--org <alias>`, `--backup`, `--json`, `--notify` |
| `sfdt monitor schedule` | Alias for `ci init --type monitor` — scaffold a scheduled monitoring pipeline | `--provider <github\|gitlab\|azure\|bitbucket>` |
| `sfdt dependencies <name>` | "What references this / what does this reference" via MetadataComponentDependency; `--gaps` adds a source-parsed report of inferred edges the Tooling API misses (offline; `--org` diffs to mark MISSING vs confirmed) | `--type <apex\|flow\|field\|page\|lwc>`, `--gaps`, `--org <alias>`, `--json` |
| `sfdt history` | Durable, queryable index of past runs (audit/monitor/coverage/deploy/test/rollback) for trending outcomes over time | `--type <type>`, `--limit <n>`, `--json` |
| `sfdt coverage` | Org-wide + per-class Apex coverage with a CI gate | `--threshold <pct>`, `--org <alias>`, `--json` |
| `sfdt monitor backup` | Retrieve a full metadata backup into the configured backup directory | `--org <alias>`, `--json` |
| `sfdt docs generate` | Generate MkDocs-compatible docs (objects, Apex, flows, LWC) with optional AI overview and per-component Developer/Admin/User/DevOps guides | `--ai`, `--roles [list]`, `--json` |
| `sfdt docs diagram` | Print/write a Mermaid ER diagram of the data model | `--output <file>`, `--json` |
| `sfdt data <list\|export\|import\|delete> [set]` | Manage data sets via native `sf data tree` for sandbox/scratch seeding | `--org <alias>`, `--json`, `--yes` (delete: skip confirmation; required non-interactively) |
| `sfdt scratch <create\|delete\|list\|pool>` | Create/delete/list scratch orgs and manage a pre-created pool | `--alias`, `--days <n>`, `--size <n>`, `--json`, `--yes` (delete: skip confirmation; required non-interactively) |
| `sfdt config get <key>` | Print a config value using dot notation (e.g. `defaultOrg`) | — |
| `sfdt config set <key> <value>` | Set a config value using dot notation (e.g. `deployment.coverageThreshold`) | — |
| `sfdt completion <shell>` | Print shell completion script (`bash`, `zsh`, `fish`) | — |
| `sfdt version` | Print the current sfdt version | — |
| `sfdt update` | Update sfdt to the latest version from npm | `--force` |

### AI & Intelligence (Phase 3)

| Command | Description | Key Options |
|---|---|---|
| `sfdt manifest` | Build `package.xml` from git diffs | `--base <ref>`, `--head <ref>`, `--package <name\|all>`, `--name <label>`, `--output <path>`, `--destructive <path>`, `--ai-cleanup`, `--print` |
| `sfdt explain [file]` | Analyze a deployment error log with AI + heuristics | `--from-stdin`, `--latest` |
| `sfdt pr-description` | Generate a PR description or Slack message | `--base <ref>`, `--head <ref>`, `--format github\|slack\|markdown`, `--output <path>`, `--commit-limit <n>` |
| `sfdt review` | AI code review of current branch changes | `--base <branch>` |
| `sfdt changelog` | Manage changelog files (global or per-package) | subcommands: `generate`, `release <version>`, `check`; `--package <name>` scopes to a specific package |
| `sfdt quality` | Code & test quality analysis; `--output-file <path>` also writes results to a file (format by extension, e.g. `.sarif` for code-scanning upload) | `--tests`, `--all`, `--fix-plan`, `--generate-stubs`, `--include-fixes`, `--output-file <path>`, `--dry-run` |
| `sfdt ai prompt <text>` | Run a prompt through the configured AI provider and print the result | — |

### Platform (Phase 4)

| Command | Description | Key Options |
|---|---|---|
| `sfdt ui` | Launch local Salesforce Lightning Design System dashboard | `--port <n>` (default 7654), `--no-open` |

### Extension & bridge

| Command | Description | Key Options |
|---|---|---|
| `sfdt extension install-host` | Register the Chrome native messaging host so the extension can fall back to native transport when `sfdt ui` isn't running | `--extension-id <id>`, `--browser <chrome\|edge\|brave\|chromium\|vivaldi\|all>` |
| `sfdt extension uninstall-host` | Remove the native host manifest | `--browser <browser>` |
| `sfdt extension status` | Report which browsers have the native host installed | `--json` |
| `sfdt extension stats` | Show the latest telemetry snapshot the extension pushed to `.sfdt/telemetry-snapshot.json` | `--json`, `--limit <n>` |
| `sfdt feature-flags list` | List remotely-disabled features from `.sfdt/feature-flags.json` | `--json` |
| `sfdt feature-flags disable <id>` | Add a feature id to the kill-switch | `--json` |
| `sfdt feature-flags enable <id>` | Remove a feature id from the kill-switch | `--json` |
| `sfdt feature-flags clear` | Re-enable everything | `--remove`, `--json` |
| `sfdt doctor` | Diagnose the local environment (sf, node, git, config, AI, org) and the extension stack | `--core`, `--extension`, `--org <alias>`, `--port <n>`, `--json` |

### Agent & extensibility

| Command | Description | Key Options |
|---|---|---|
| `sfdt mcp start` | Start the built-in Model Context Protocol server (stdio) so agents can drive sfdt as a tool | — |
| `sfdt mcp cleanup` | Purge expired parked results from the MCP cache directory | — |
| `sfdt plugin create [name]` | Scaffold a new sfdt CLI plugin project | `--description <desc>`, `--author <author>` |
| `sfdt skills export` | Export local agent skills to IDE rules files (`--target claude\|cursor\|codex\|windsurf`) or an `npx skills add`-compatible pack (`--target pack`) | `--target`, `--out`, `--json` |

## Configuration

Running `sfdt init` creates a `.sfdt/` directory in your project root:

```
.sfdt/
  config.json          # Core settings: org aliases, feature flags, AI provider, coverage threshold
  environments.json    # Named environments and org aliases
  test-config.json     # Test classes, coverage threshold, test level
  pull-config.json     # Metadata types to pull from org
```

### config.json

```json
{
  "projectName": "My Salesforce Project",
  "defaultOrg": "my-dev-org",
  "deployment": {
    "coverageThreshold": 75,
    "preflight": {
      "enforceTests": false,
      "enforceBranchNaming": false,
      "enforceChangelog": false
    }
  },
  "features": {
    "ai": true,
    "notifications": false,
    "releaseManagement": true
  },
  "ai": {
    "provider": "claude",
    "model": "",
    "baseURL": "",
    "apiKeyEnv": "",
    "headers": {},
    "timeoutMs": 300000
  },
  "plugins": []
}
```

> `baseURL` / `apiKeyEnv` / `headers` / `timeoutMs` apply only to the `http` provider; CLI providers (`claude`/`gemini`/`openai`) ignore them. See [AI Features](#ai-features).

## AI Features

AI-powered commands (`review`, `explain`, `manifest --ai-cleanup`, `quality --fix-plan`, `pr-description`, `changelog generate`, `release`) work with **Claude, Gemini, OpenAI/Codex CLI providers, or any OpenAI-compatible HTTP endpoint** (Ollama, OpenRouter, MiniMax, …). The provider is configured during `sfdt init` or by editing `.sfdt/config.json`.

### Claude (default)

Requires the [Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code):

```bash
npm install -g @anthropic-ai/claude-code
```

```json
{ "ai": { "provider": "claude" } }
```

Claude's interactive mode lets AI commands read your repository files directly with tool use.

### Gemini

Requires the Gemini CLI:

```bash
npm install -g @google/gemini-cli
```

```json
{ "ai": { "provider": "gemini", "model": "" } }
```

Authentication and model selection are handled by the Gemini CLI.

### OpenAI

Requires the Codex CLI:

```bash
npm install -g @openai/codex
```

```json
{ "ai": { "provider": "openai", "model": "" } }
```

Authentication and model selection are handled by the Codex CLI.

### HTTP (OpenAI-compatible)

A single `http` provider talks to any endpoint exposing `POST /chat/completions` — local (Ollama) or cloud (OpenRouter, MiniMax, or any gateway). No extra CLI is needed; it uses Node's built-in `fetch`.

```jsonc
// Ollama (local, no API key)
{ "ai": { "provider": "http", "baseURL": "http://localhost:11434/v1", "model": "llama3.1" } }

// OpenRouter / MiniMax (cloud — key comes from an env var, never stored in config)
{ "ai": {
  "provider": "http",
  "baseURL": "https://openrouter.ai/api/v1",
  "model": "openrouter/auto",
  "apiKeyEnv": "OPENROUTER_API_KEY"
} }
```

`apiKeyEnv` names the environment variable holding your key (`export OPENROUTER_API_KEY=…`); the key itself is never written to `.sfdt/config.json`. Optional `headers` (object) and `timeoutMs` (default `300000`) are also supported.

Because an HTTP model can't read files or run `git`/`sf` itself, sfdt pre-gathers the needed context (git history, test results) and injects it into the prompt for agentic commands. Note: with a cloud endpoint, prompt content (diffs, git logs) is transmitted to that service — sensitive values are redacted before sending.

### Disabling AI

Set `features.ai` to `false` to disable all AI prompts. Heuristic fallbacks still run in `sfdt explain`.

```json
{ "features": { "ai": false } }
```

## Web Dashboard (`sfdt ui`)

`sfdt ui` starts a local Express server and opens a **Salesforce Lightning Design System** dashboard in your browser:

```bash
sfdt ui                   # opens http://localhost:7654
sfdt ui --port 8080       # custom port
sfdt ui --no-open         # start server without opening browser
```

Dashboard pages:
- **Dashboard** — summary stat cards, recent test runs, preflight and drift status
- **Test Runs** — Apex test history with coverage colouring; run tests directly from the UI
- **Preflight** — per-check pass/fail list; run preflight directly from the UI
- **Drift Detection** — filterable component table (All / Clean / Drift); run drift check from the UI
- **Compare** — diff two orgs or local source vs an org, export source-only items as `package.xml`
- **Scan** — fetch and browse full metadata inventory from any org; writes `logs/scan-latest.json`
- **Logs** — searchable log viewer for deploy and rollback history with pagination and raw output

The dashboard reads log files from the project's configured `logDir` (defaults to `<project>/logs`). Data appears automatically after running `sfdt test`, `sfdt preflight`, or `sfdt drift` when those commands write JSON result files.

**Build the GUI** (required after cloning from source):

```bash
npm run build:gui
```

The pre-built `gui/dist/` is included in the published npm package so end users don't need to build it.

## Plugin Architecture

Extend sfdt with custom subcommands by creating a plugin.

### npm package plugin

Create a package named `sfdt-plugin-<name>` and publish it to npm:

```javascript
// sfdt-plugin-my-thing/index.js
export function register(program) {
  program
    .command('my-thing')
    .description('My custom command')
    .action(async () => {
      console.log('Hello from my-thing!');
    });
}
```

Install it in your Salesforce project:

```bash
npm install --save-dev sfdt-plugin-my-thing
```

sfdt auto-discovers all `sfdt-plugin-*` packages in your project's `node_modules/` on startup — no config required.

### Local plugin

Drop a `.js` file in `.sfdt/plugins/`:

```javascript
// .sfdt/plugins/custom-deploy.js
export function register(program) {
  program.command('custom-deploy').action(async () => { ... });
}
```

### Explicit plugin list

List plugin package names in `config.plugins` to load them in a specific order:

```json
{ "plugins": ["sfdt-plugin-my-thing", "@myorg/sfdt-plugin-audit"] }
```

## GitHub Action

The repository doubles as a composite GitHub Action: run any sfdt command as a
single `uses:` step, with org authentication handled for you. Pinning the
action tag pins the CLI version (`cli-version: auto` installs the version
shipped at that ref — no unpinned `@latest`).

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- name: Smart delta validation
  uses: scoobydrew83/sfdt@v0
  with:
    command: deploy --smart --org ci --delta-base "origin/${{ github.event.pull_request.base.ref }}" --dry-run
    auth-method: sfdx-url
    sfdx-auth-url: ${{ secrets.SFDX_AUTH_URL }}
    org-alias: ci
```

JWT bearer flow instead of an auth URL:

```yaml
    auth-method: jwt
    consumer-key: ${{ secrets.SFDX_CONSUMER_KEY }}
    jwt-secret-key: ${{ secrets.SFDX_JWT_SECRET_KEY }}
    username: ${{ secrets.SFDX_USERNAME }}
```

`sfdt ci init --provider github --runner action` generates complete workflows
built on the action (monitor, deploy, release). The floating `v0` tag tracks
the newest stable release; pin an exact tag (e.g. `@v0.16.2`) or a commit SHA
if you prefer immutable references. Always pass secrets as `${{ secrets.X }}`
expressions, and never feed untrusted input to `command` — it runs as a shell
command line.

## Docker

An official Docker image is available for CI/CD pipelines. It ships Node 22, Salesforce CLI, git, bash, and jq.

**Build from source:**

```bash
docker build -t sfdt .
```

**Run against a mounted project:**

```bash
docker run --rm \
  -v "$(pwd):/project" \
  -e SFDX_AUTH_URL="$SFDX_AUTH_URL" \
  sfdt deploy
```

**GitHub Actions example:**

```yaml
- name: Deploy
  run: |
    docker run --rm \
      -v "${{ github.workspace }}:/project" \
      -e SF_ORG_INSTANCE_URL="${{ secrets.SF_ORG_INSTANCE_URL }}" \
      sfdt deploy --skip-preflight
```

Install the selected AI provider CLI in the container when using AI features:

```bash
docker run --rm -v "$(pwd):/project" \
  sfdt explain --latest
```

## Pull Groups

Pull groups let you define named sets of metadata types in `.sfdt/pull-config.json`:

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

Use `sfdt pull` to retrieve all configured metadata types from the default org.

### Pull Cache

`sfdt pull` uses a SQLite cache (stored in `.sfdt/cache/`) to track retrieved components and their modification dates. On subsequent runs, only components that have changed in the org are re-fetched, significantly reducing retrieval time for large orgs.

Cache behavior is controlled via `pullCache` in `.sfdt/config.json`:

```json
{
  "pullCache": {
    "enabled": true,
    "parallelism": 5,
    "batchSize": 100
  }
}
```

| Flag | Description |
|------|-------------|
| `sfdt pull` | Incremental pull — only retrieves changed components |
| `sfdt pull --full` | Force full retrieve and rebuild the cache |
| `sfdt pull --status` | Show cache status (last pull time, component counts) |

## Requirements

- **Node.js** >= 22.15.0 (uses the built-in `node:sqlite` module, unflagged in Node 22.15)
- **Salesforce CLI** (`sf`) installed and authenticated to target orgs
- **bash** 4.0+ (macOS users: `brew install bash`)
- **jq** 1.6+ (required by several shell scripts)
- **Optional:** [Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code) for AI features with the `claude` provider
- **Optional:** Gemini CLI or Codex CLI for AI features with the `gemini` or `openai` provider
- **Optional:** an OpenAI-compatible HTTP endpoint (Ollama, OpenRouter, MiniMax, …) for AI features with the `http` provider — no extra CLI required
- **Optional:** [GitHub CLI](https://cli.github.com/) (`gh`) for PR creation during deployments

## Development

```bash
git clone https://github.com/scoobydrew83/sfdt.git
cd sfdt
npm install
npm link              # makes `sfdt` available globally from your checkout

# Build the web dashboard
npm run build:gui

# Run tests
npm test

# Lint
npm run lint
```

After `npm link`, the `sfdt` command points to your local checkout.

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Make your changes with tests
4. Run the test suite (`npm test`) and linter (`npm run lint`)
5. Commit with a descriptive message
6. Push to your fork and open a Pull Request

Please ensure all tests pass and linting is clean before submitting.

## Security

To report a vulnerability, use [GitHub's private security advisory feature](https://github.com/scoobydrew83/sfdt/security/advisories/new) rather than opening a public issue. See [SECURITY.md](SECURITY.md) for the full policy.

## License

[Apache-2.0](LICENSE)
