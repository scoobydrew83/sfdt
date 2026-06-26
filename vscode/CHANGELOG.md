# Changelog

All notable changes to the **SFDT for Salesforce** VS Code extension (`sfdt.sfdt-devtools`) are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Release status:** published to the VS Code Marketplace as [`sfdt.sfdt-devtools`](https://marketplace.visualstudio.com/items?itemName=sfdt.sfdt-devtools). The npm workspace package is `sfdt-devtools` (the Marketplace requires an unscoped name; the original scoped `@sfdt/vscode` could not be published).

## [Unreleased]

## [0.1.0] - 2026-06-24

Initial version of the SFDT VS Code extension — a thin UI over the `sfdt` CLI. It spawns the `sfdt` binary and reads the same JSON snapshots the CLI writes; it reimplements no logic of its own.

### Added
- **Org Health tree view** — reads the `audit-latest.json` / `monitor-latest.json` snapshots and renders each check; click a check to re-run it.
- **Command palette integration** — a general "SFDT: Run Command…" picker plus dedicated commands for `deploy`, `preflight`, `audit`, `monitor`, `backup`, and `docs`, with a confirmation prompt before destructive operations.
- **Embedded dashboard webview** — spawns `sfdt ui` and loads the dashboard in an editor tab.
- **Status-bar item** — shows the active org and the worst current audit/monitor status.
- **`vscode`-free library modules** (`cli`, `snapshots`, `commands`, `io`) with vitest specs, so the testable logic stays decoupled from the VS Code API; the `vscode`-importing modules are esbuild-bundled.
