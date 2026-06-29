# @sfdt/plugin

A [Salesforce CLI (`sf`)](https://developer.salesforce.com/docs/platform/salesforce-cli-plugin/guide/conceptual-overview.html)
plugin that exposes the [`@sfdt/cli`](https://www.npmjs.com/package/@sfdt/cli)
command set as `sf sfdt <command>`.

It is a **thin wrapper**: it reimplements no logic. Each command forwards to the
bundled `sfdt` binary and streams its output (including `--json`) verbatim,
propagating the CLI's exit code. `@sfdt/cli` is a pinned runtime dependency, so
the plugin is self-contained and version-locked.

## Install

```bash
sf plugins install @sfdt/plugin
```

> Third-party `sf` plugins are unsigned, so `sf` shows a one-time security prompt
> on install unless Salesforce has allowlisted the package.

## Usage

```bash
sf sfdt --help                 # list all commands
sf sfdt deploy --dry-run --org myorg
sf sfdt audit --json | jq .    # sf-native { status, result, warnings } envelope
sf sfdt scratch create --alias dev
```

Every command, flag, and behaviour matches the standalone `sfdt` CLI — see the
[sfdt docs](https://sfdt.dev/).

## Development

Command files under `src/commands/sfdt/**` are **code-generated** from the CLI's
`createCli()` program (single source of truth) — never hand-edit them.

```bash
npm run gen      # regenerate command files from @sfdt/cli
npm run build    # gen + tsc
npm test         # vitest
```

## Requirements

The wrapped commands still need their usual runtime prerequisites on `PATH`
(`sf`, `git`, `bash`), same as running `sfdt` directly.
