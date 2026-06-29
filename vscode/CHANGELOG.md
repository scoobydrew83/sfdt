# Changelog

All notable changes to the **SFDT for Salesforce** VS Code extension (`sfdt.sfdt-devtools`) are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Release status:** published to the VS Code Marketplace as [`sfdt.sfdt-devtools`](https://marketplace.visualstudio.com/items?itemName=sfdt.sfdt-devtools). The npm workspace package is `sfdt-devtools` (the Marketplace requires an unscoped name; the original scoped `@sfdt/vscode` could not be published).

## [Unreleased]

## [0.3.0] - 2026-06-29

Tracks the CLI's v0.15.0 surface and hardens the embedded dashboard.

### Added
- **New command-palette entries** for the CLI's expanded surface: the new org-health sub-checks (inactive validation/workflow rules, field-level access lint, etc.), **Smart Deploy** (`deploy --smart`), **Retrofit**, **PR Comment**, **Send Org Health to Notifications**, and the **Dependencies** and **Coverage** commands under Quality & Analysis.

### Changed
- **Embedded dashboard follows the editor theme.** The dashboard webview opens with VS Code's active light/dark theme (`?theme=dark|light`) and reloads when you switch themes; standalone `sfdt ui` in a browser is unaffected.

### Fixed
- **Dashboard port-conflict recovery.** When the dashboard port can't be bound, the extension no longer hangs polling `/api/health` and silently attaching to a foreign or stale server (which then 401s every call). Success is now tied to *our* child process printing its launch token, so a squatting server can't masquerade as ours; on a real bind failure the extension finds the port owner, stops a recognized stale sfdt/node GUI server and retries once, never kills a foreign process, and otherwise surfaces an actionable error with an "Open Settings" action to change `sfdt.dashboardPort`.

## [0.2.0] - 2026-06-26

A ground-up expansion from a single Org Health viewer into a full command center
for the sfdt CLI. The extension stays a thin UI over the CLI — it spawns `sfdt`
and reads the same JSON snapshots — but it now surfaces the *entire* command
surface and the live state of your org and project.

### Added
- **Commands view** — a grouped tree of the full sfdt command surface (30+
  commands / 50+ subcommands) across six categories: Deploy & Release, Org
  Health, Quality & Analysis, Documentation, Data & Scratch Orgs, and Project &
  Tools. Click any command to run it; subcommands nest under their parent.
- **Integrated-terminal execution** — commands now run in a dedicated **SFDT**
  terminal with live, colored, streaming output and support for interactive
  prompts, instead of a hidden output channel. Destructive commands (deploy,
  rollback, backup, data delete, scratch delete) confirm first.
- **Status view** — the active target org (alias, instance URL, connection),
  the git branch, an Org Health rollup, and the installed `sfdt`/`sf` versions
  with an "update available" hint.
- **Org picker** — select the target org from `sf org list` (or type an alias)
  right from the Status view title bar; it updates `sfdt.defaultOrg`.
- **Welcome / onboarding** — when the `sfdt` CLI isn't found or the project
  isn't initialized, the views offer one-click install docs and `sfdt init`.
- **Command search** — `SFDT: Run Command…` is now a searchable quick-pick over
  every command (matches on label, detail, and argv).
- **Context menus & docs links** — right-click any command to Run, Copy the
  exact `sfdt …` invocation, or Open the matching page on https://sfdt.dev/.
- **Per-org window theming** (`sfdt.orgColor`, on by default) — tints the window
  by org type (production = red, sandbox = orange, scratch/developer = green) to
  prevent wrong-org mistakes.
- **Org Health** now also surfaces `scan` (metadata inventory) and `drift`
  sections alongside audit and monitor, and all views auto-refresh whenever a
  `logs/*-latest.json` snapshot changes.

### Fixed
- **The embedded dashboard no longer 401s.** It now captures the one-time launch
  token printed by `sfdt ui` and passes it to the webview (and can deep-link to
  a specific dashboard page), so the in-editor dashboard authenticates correctly.

## [0.1.2] - 2026-06-26

### Fixed
- **The Org Health sidebar and all `SFDT:` commands now work.** The extension bundle is now emitted as CommonJS (`dist/extension.cjs`) instead of `dist/extension.js`. Because the manifest declares `"type": "module"`, VS Code parsed the old `.js` bundle as an ES module and failed to load it, so `activate()` never ran — the sidebar showed *"There is no data provider registered that can provide view data"* and commands failed with *"command 'sfdt.refresh' not found"*. A `.cjs` bundle is always loaded as CommonJS, so the extension activates correctly. No functional code changed — only the build output format.

## [0.1.1] - 2026-06-26

### Changed
- **Marketplace listing refresh** — the README rendered on the Marketplace now shows the correct title ("SFDT for Salesforce"), version/install badges, and `code --install-extension` instructions. The 0.1.0 listing rendered an earlier draft README that was baked into that build. No functional changes to the extension.
- First automated publish via `.github/workflows/vscode-release.yml` (Marketplace + Open VSX).

## [0.1.0] - 2026-06-24

Initial version of the SFDT VS Code extension — a thin UI over the `sfdt` CLI. It spawns the `sfdt` binary and reads the same JSON snapshots the CLI writes; it reimplements no logic of its own.

### Added
- **Org Health tree view** — reads the `audit-latest.json` / `monitor-latest.json` snapshots and renders each check; click a check to re-run it.
- **Command palette integration** — a general "SFDT: Run Command…" picker plus dedicated commands for `deploy`, `preflight`, `audit`, `monitor`, `backup`, and `docs`, with a confirmation prompt before destructive operations.
- **Embedded dashboard webview** — spawns `sfdt ui` and loads the dashboard in an editor tab.
- **Status-bar item** — shows the active org and the worst current audit/monitor status.
- **`vscode`-free library modules** (`cli`, `snapshots`, `commands`, `io`) with vitest specs, so the testable logic stays decoupled from the VS Code API; the `vscode`-importing modules are esbuild-bundled.
