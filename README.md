# @sfdt/cli

Production-grade CLI for Salesforce DX deployment, testing, quality analysis, and release management.

[![npm version](https://img.shields.io/npm/v/@sfdt/cli.svg)](https://www.npmjs.com/package/@sfdt/cli)
[![npm downloads](https://img.shields.io/npm/dm/@sfdt/cli.svg)](https://www.npmjs.com/package/@sfdt/cli)
[![CI](https://github.com/scoobydrew83/sfdt/actions/workflows/ci.yml/badge.svg)](https://github.com/scoobydrew83/sfdt/actions/workflows/ci.yml)
[![CodeQL](https://github.com/scoobydrew83/sfdt/actions/workflows/codeql.yml/badge.svg)](https://github.com/scoobydrew83/sfdt/actions/workflows/codeql.yml)
[![license](https://img.shields.io/npm/l/@sfdt/cli.svg)](https://github.com/scoobydrew83/sfdt/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@sfdt/cli.svg)](https://nodejs.org)

## Features

- Interactive deployment workflows with validation, tagging, and PR creation
- Automated release manifest generation from git diffs
- Parallel test execution with coverage enforcement
- Code and test quality analysis
- Pre-release validation checklist
- Deployment rollback support
- Post-deploy smoke testing
- Org metadata drift detection
- AI-powered changelog generation and management
- AI-powered code review, test failure analysis, and release notes (optional, uses Claude)
- Smart package.xml generator from git diffs with AI dependency cleanup
- AI deployment error log interpreter with heuristic fallback
- AI-generated PR descriptions and Slack deployment messages
- Slack notifications for deployment events
- Works with **any** Salesforce DX project

## Quick Start

```bash
npm install -g @sfdt/cli
cd your-salesforce-project
sfdt init
sfdt deploy
```

## Commands Reference

| Command          | Description                                        | Key Options                                            |
| ---------------- | -------------------------------------------------- | ------------------------------------------------------ |
| `sfdt init`      | Initialize `.sfdt/` config in current project      | `--force` to overwrite existing config                 |
| `sfdt deploy`    | Interactive deployment with validation and tagging | `--target-org`, `--dry-run`, `--skip-tests`            |
| `sfdt release`   | Generate release manifest from git diffs           | `--from <ref>`, `--to <ref>`, `--output <dir>`         |
| `sfdt test`      | Run Apex tests with coverage enforcement           | `--parallel`, `--min-coverage <pct>`, `--suite <name>` |
| `sfdt quality`   | Analyze code and test quality                      | `--type <code\|tests\|all>`, `--fail-on <level>`       |
| `sfdt preflight` | Pre-release validation checklist                   | `--strict`, `--skip <checks>`                          |
| `sfdt rollback`  | Roll back a deployment                             | `--target-org`, `--manifest <path>`                    |
| `sfdt smoke`     | Post-deploy smoke testing                          | `--target-org`, `--suite <name>`                       |
| `sfdt drift`     | Detect org metadata drift from source              | `--target-org`, `--types <list>`                       |
| `sfdt changelog` | Manage project CHANGELOG.md                        | `generate`, `release`, `check`                         |
| `sfdt review`    | AI-powered code review                             | `--from <ref>`, `--to <ref>`                           |
| `sfdt manifest`  | Smart package.xml from git diffs with AI cleanup   | `--base <ref>`, `--print`, `--ai-cleanup`              |
| `sfdt explain`   | AI analysis of deployment error logs               | `<file>`, `--from-stdin`, `--latest`                   |
| `sfdt pr-description` | Generate PR description or Slack message      | `--format github\|slack`, `--output <file>`            |
| `sfdt pull`      | Pull metadata from org using configured groups     | `--group <name>`, `--target-org`                       |
| `sfdt notify`    | Send Slack deployment notifications                | `--channel`, `--status <success\|failure>`             |

## Configuration

Running `sfdt init` creates a `.sfdt/` directory in your project root with the following configuration files:

```
.sfdt/
  config.json          # Core settings: target orgs, default branch, feature flags
  release-config.json  # Release manifest rules: included types, naming conventions
  test-config.json     # Test execution: suites, coverage thresholds, parallelism
  pull-config.json     # Metadata pull groups: named sets of metadata types to retrieve
```

### config.json

Controls global behavior including target org aliases, the base branch for diff comparisons, and feature toggles (AI, Slack, etc.).

### release-config.json

Defines which metadata types to include in release manifests, archive directory structure, and version tagging format.

### test-config.json

Configures test suites, minimum coverage thresholds, parallel execution settings, and test result output formats.

### pull-config.json

Defines named groups of metadata types for targeted org pulls. See [Pull Groups](#pull-groups) below.

## AI Features

AI features (code review, test failure analysis, release notes generation) are **optional** and require the Claude CLI:

```bash
npm install -g @anthropic-ai/claude-code
```

AI features can be disabled entirely by setting `features.ai` to `false` in `.sfdt/config.json`:

```json
{
  "features": {
    "ai": false
  }
}
```

When enabled, the `sfdt review` command uses Claude to analyze code changes and provide actionable feedback. Test failure analysis automatically runs when tests fail during `sfdt test` or `sfdt deploy`.

## Pull Groups

Pull groups let you define named sets of metadata types in `.sfdt/pull-config.json` for project-specific metadata retrieval:

```json
{
  "groups": {
    "core": {
      "description": "Core application metadata",
      "types": ["ApexClass", "ApexTrigger", "LightningComponentBundle"]
    },
    "config": {
      "description": "Configuration and settings",
      "types": ["CustomMetadata", "CustomPermission", "PermissionSet"]
    },
    "ui": {
      "description": "UI components and layouts",
      "types": ["LightningComponentBundle", "FlexiPage", "Layout"]
    }
  }
}
```

Use groups with `sfdt pull --group core` to pull only the metadata types defined in that group.

## Requirements

- **Node.js** >= 20.0.0
- **Salesforce CLI** (`sf`) installed and authenticated to target orgs
- **bash** 4.0+ (macOS users: `brew install bash`)
- **jq** 1.6+ (essential for test results and metadata processing)
- **Optional:** [Claude CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code) for AI features
- **Optional:** [GitHub CLI](https://cli.github.com/) (`gh`) for PR creation during deployments

## Development

```bash
git clone https://github.com/scoobydrew83/sfdt.git
cd sfdt
npm install
npm link
```

After `npm link`, the `sfdt` command is available globally and points to your local checkout. Run `npm test` and `npm run lint` before submitting changes.

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Make your changes with tests
4. Run the test suite (`npm test`)
5. Run the linter (`npm run lint`)
6. Commit your changes with a descriptive message
7. Push to your fork and open a Pull Request

Please ensure all tests pass and linting is clean before submitting.

## Security

To report a vulnerability, please use [GitHub's private security advisory feature](https://github.com/scoobydrew83/sfdt/security/advisories/new) rather than opening a public issue. See [SECURITY.md](SECURITY.md) for the full policy and scope.

## License

[MIT](LICENSE)
