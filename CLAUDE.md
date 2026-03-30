# CLAUDE.md — sfdt CLI

## Project Overview

This is `@sfdt/cli`, a Node.js ESM CLI package for Salesforce DX deployment, testing, quality analysis, and release management. It is a **generic tool** — it works with any Salesforce DX project and contains no project-specific values.

## Architecture

- **CLI framework**: Commander.js for command routing
- **Shell execution**: execa for running shell scripts and sf CLI commands
- **Module system**: ESM (`"type": "module"` in package.json)
- **Entry point**: `bin/sfdt.js`

### Directory Structure

```
bin/            CLI entry point
src/
  commands/     Command modules (one file per command)
  lib/          Shared libraries (config, output, AI, script-runner, project-detect)
scripts/        Shell scripts executed by commands (de-parameterized, use SFDT_ env vars)
test/           Tests (vitest)
.sfdt/          Per-project config directory (created by `sfdt init` in target projects)
```

### Key Patterns

- **Commands** in `src/commands/` export a function that receives the Commander program and registers a subcommand.
- **Shell scripts** in `scripts/` are de-parameterized — they read configuration from `SFDT_` prefixed environment variables, not from positional arguments. The `script-runner.js` lib handles setting these vars and invoking scripts.
- **Config system** uses a `.sfdt/` directory created per-project. Config is loaded by `src/lib/config.js`.
- **AI features** are optional and gated behind `features.ai` in config. They require the Claude CLI to be installed externally.

## Development

```bash
npm test              # Run tests (vitest)
npm run lint          # ESLint
npm run test:coverage # Coverage report
npm link              # Link for local development
```

## Guidelines

- Do not hardcode org aliases, branch names, or project-specific values
- All external tool dependencies (sf, gh, claude, bash) must be checked at runtime before use
- Shell scripts must be POSIX-compatible where possible; bash 4.0+ features are acceptable
- Use chalk for colored output, ora for spinners, inquirer for prompts
- Test with vitest; mock execa calls for shell script tests
- Keep commands thin — delegate logic to `src/lib/` or `scripts/`
