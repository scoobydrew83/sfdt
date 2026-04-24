# @sfdt/cli

Production-grade CLI for Salesforce DX deployment, testing, quality analysis, and release management.

[![npm version](https://img.shields.io/npm/v/@sfdt/cli.svg)](https://www.npmjs.com/package/@sfdt/cli)
[![npm downloads](https://img.shields.io/npm/dm/@sfdt/cli.svg)](https://www.npmjs.com/package/@sfdt/cli)
[![CI](https://github.com/scoobydrew83/sfdt/actions/workflows/ci.yml/badge.svg)](https://github.com/scoobydrew83/sfdt/actions/workflows/ci.yml)
[![CodeQL](https://github.com/scoobydrew83/sfdt/actions/workflows/codeql.yml/badge.svg)](https://github.com/scoobydrew83/sfdt/actions/workflows/codeql.yml)
[![license](https://img.shields.io/npm/l/@sfdt/cli.svg)](https://github.com/scoobydrew83/sfdt/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@sfdt/cli.svg)](https://nodejs.org)

## Features

- Interactive deployment workflows with preflight validation, tagging, and PR creation
- Automated release manifest generation from git diffs
- Parallel Apex test execution with configurable coverage enforcement
- Code and test quality analysis with AI-powered fix plans
- Pre-release validation checklist (`sfdt preflight`)
- Deployment rollback with pre-rollback org state backup
- Post-deploy smoke testing
- Org metadata drift detection
- **Smart package.xml generator** from git diffs with AI dependency cleanup (`sfdt manifest`)
- **AI deployment error log interpreter** with heuristic fallback for offline use (`sfdt explain`)
- **AI-generated PR descriptions and Slack messages** from deployment changes (`sfdt pr-description`)
- **AI-powered code review, test failure analysis, changelog generation, and release notes** — optional, works with Claude, Gemini, or OpenAI
- **Org metadata comparison** — diff two orgs or local source vs org with optional package.xml export (`sfdt compare`)
- **Local web dashboard** for test results, preflight, drift monitoring, and org comparison (`sfdt ui`)
- **Plugin architecture** — extend sfdt with `sfdt-plugin-*` npm packages or local `.sfdt/plugins/` scripts
- Slack notifications for deployment events
- Works with **any** Salesforce DX project — no project-specific values hardcoded

For in-depth command walkthroughs and workflow examples, see [docs/USAGE.md](docs/USAGE.md).

## Quick Start

```bash
npm install -g @sfdt/cli
cd your-salesforce-project
sfdt init
sfdt deploy
```

## Commands Reference

### Core

| Command | Description | Key Options |
|---|---|---|
| `sfdt init` | Initialize `.sfdt/` config (interactive) | — |
| `sfdt deploy` | Deploy to a Salesforce org | `--managed`, `--skip-preflight`, `--dry-run` |
| `sfdt release` | Generate release manifest + optional AI release notes | — |
| `sfdt test` | Run Apex tests with the enhanced test runner | `--legacy`, `--analyze`, `--dry-run` |
| `sfdt pull` | Pull metadata from the configured org | `--dry-run` |
| `sfdt preflight` | Run pre-deployment validation checks | `--strict`, `--dry-run` |
| `sfdt rollback` | Roll back a deployment to a target org | `--org <alias>`, `--dry-run` |
| `sfdt smoke` | Post-deploy smoke tests | `--org <alias>`, `--dry-run` |
| `sfdt drift` | Detect metadata drift between local source and an org | `--org <alias>` |
| `sfdt compare` | Compare metadata between two orgs or local source vs an org | `--source <alias\|local>`, `--target <alias>`, `--output <file>` |
| `sfdt notify` | Send Slack deployment notifications | `--org <alias>`, `--version <ver>`, `--message <msg>` |
| `sfdt completion <shell>` | Print shell completion script (`bash`, `zsh`, `fish`) | — |
| `sfdt version` | Print the current sfdt version | — |
| `sfdt update` | Update sfdt to the latest version from npm | `--force` |

### AI & Intelligence (Phase 3)

| Command | Description | Key Options |
|---|---|---|
| `sfdt manifest` | Build `package.xml` from git diffs | `--base <ref>`, `--head <ref>`, `--output <path>`, `--destructive <path>`, `--ai-cleanup`, `--print` |
| `sfdt explain [file]` | Analyze a deployment error log with AI + heuristics | `--from-stdin`, `--latest` |
| `sfdt pr-description` | Generate a PR description or Slack message | `--base <ref>`, `--head <ref>`, `--format github\|slack\|markdown`, `--output <path>`, `--commit-limit <n>` |
| `sfdt review` | AI code review of current branch changes | `--base <branch>` |
| `sfdt changelog` | Manage `CHANGELOG.md` | subcommands: `generate`, `release <version>`, `check` |
| `sfdt quality` | Code & test quality analysis | `--tests`, `--all`, `--fix-plan`, `--generate-stubs`, `--dry-run` |

### Platform (Phase 4)

| Command | Description | Key Options |
|---|---|---|
| `sfdt ui` | Launch local Salesforce Lightning Design System dashboard | `--port <n>` (default 7654), `--no-open` |

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
    "apiKey": ""
  },
  "plugins": []
}
```

## AI Features

AI-powered commands (`review`, `explain`, `manifest --ai-cleanup`, `quality --fix-plan`, `pr-description`, `changelog generate`, `release`) work with **Claude, Gemini, or OpenAI**. The provider is configured during `sfdt init` or by editing `.sfdt/config.json`.

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

Set your API key in the environment or in config:

```bash
export GEMINI_API_KEY=your-key
```

```json
{ "ai": { "provider": "gemini", "model": "gemini-2.0-flash", "apiKey": "" } }
```

Default model: `gemini-2.0-flash`. Override with `ai.model`.

### OpenAI

```bash
export OPENAI_API_KEY=sk-...
```

```json
{ "ai": { "provider": "openai", "model": "gpt-4o-mini", "apiKey": "" } }
```

Default model: `gpt-4o-mini`. Override with `ai.model`.

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

## Docker

An official Docker image is available for CI/CD pipelines. It ships Node 20, Salesforce CLI, git, bash, and jq.

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

Pass AI API keys as environment variables:

```bash
docker run --rm -v "$(pwd):/project" \
  -e GEMINI_API_KEY="$GEMINI_API_KEY" \
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

- **Node.js** >= 20.0.0
- **Salesforce CLI** (`sf`) installed and authenticated to target orgs
- **bash** 4.0+ (macOS users: `brew install bash`)
- **jq** 1.6+ (required by several shell scripts)
- **Optional:** [Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code) for AI features with the `claude` provider
- **Optional:** Gemini or OpenAI API key for `gemini`/`openai` provider
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

[MIT](LICENSE)
