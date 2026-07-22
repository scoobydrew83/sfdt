# Changelog

All notable changes to the **SFDT for Salesforce** VS Code extension (`sfdt.sfdt-devtools`) are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Release status:** published to the VS Code Marketplace as [`sfdt.sfdt-devtools`](https://marketplace.visualstudio.com/items?itemName=sfdt.sfdt-devtools). The npm workspace package is `sfdt-devtools` (the Marketplace requires an unscoped name; the original scoped `@sfdt/vscode` could not be published).

## [Unreleased]

## [0.5.1] - 2026-07-22

### Changed

- **Per-org window theming (`sfdt.orgColor`) is now opt-in** — the default flipped
  from `true` to `false`. Previously the extension silently wrote
  `workbench.colorCustomizations` into the workspace's `.vscode/settings.json`
  (a commonly version-controlled file) on activation. Enabling the setting still
  tints the window; disabling it now **removes** the color keys it wrote instead
  of leaving a stale block behind ([#263](https://github.com/scoobydrew83/sfdt/issues/263)).

## [0.5.0] - 2026-07-14

### Added

- **API Versions Report** — a new Commands-tree entry (and palette command) that runs `sfdt versions`, auditing the API versions of local source (Apex, Flow, LWC, Aura) and the org side against the org's max API version. Requires `@sfdt/cli` 0.18.0.
- **Run History** — a new Commands-tree entry that runs `sfdt history`, showing recent audit / monitor / quality / test / deploy runs from the local index.

### Fixed

- **Surface parity** — twelve CLI commands (`retrofit`, `notify`, `ai`, `data`, `scratch`, `config`, `feature-flags`, `mcp`, `extension`, `skills`, `plugin`, `update`) that were already invocable are now correctly reflected as VS Code-exposed in the command catalog, and the extended `audit api-versions` entry describes its Flow coverage and org-ceiling context.
- **Run History no longer passes `--org`** — the new entry is marked `noOrg`, so it doesn't append `--org <defaultOrg>` (which `sfdt history` rejects); it would otherwise exit 1 for any user with a default org configured.
- **Relicensed MIT → Apache-2.0** — `vscode/LICENSE` (which ships in the `.vsix`) now carries the Apache-2.0 text, matching the repository and the manifest's declared license.

## [0.4.1] - 2026-07-12

### Added

- **Commands-tree catalog entries for the new CLI surfaces** — the `sfdt test --lwc` runner, `deploy --smart --notify`, and `quality --output-file` (SARIF) now appear in the Commands tree, keeping the extension's catalog in step with CLI 0.17.0.

## [0.4.0] - 2026-07-09

### Added

- **Run this test class** — a **▶ Run test class** CodeLens at the top of every Apex test class (`.cls` with `@isTest`/`testMethod`) runs `sfdt test --class-names <name>`, plus a **SFDT: Run This Test Class** palette command. The extension now also activates in any Salesforce DX project (`sfdx-project.json`).
- **Agentforce agent tests** — a **▶ Run agent test** CodeLens on every `*.aiEvaluationDefinition-meta.xml` spec file runs `sfdt agent-test --spec <name>` (the spec is the file's API name), plus an **Agent Test (Agentforce)** entry in the Commands tree and a **SFDT: Run Agent Test** palette command (derives the spec from the active editor, else prompts). The extension now also activates when a workspace contains an agent-test spec.
- **Keybindings** for the marquee actions: **Run Command…** (`ctrl/cmd+alt+s`), **Smart Deploy — Validate** (`ctrl/cmd+alt+d`), **Quality Analysis** (`ctrl/cmd+alt+q`), and **Refresh** (`ctrl/cmd+alt+r`).
- **Commands-tree completeness** — added the previously-missing CLI commands: `monitor schedule`, `extension install-host`/`uninstall-host`, `skills export` (Claude/Cursor/Codex/Windsurf/`npx-skills` pack targets), and `plugin create`.
- **Source Control integration** — the git-diff commands (**Review Diff (AI)**, **Generate PR Description**, **Manifest from Diff**, **Generate Changelog**) now appear in the Source Control view's title menu, their natural home, in addition to the Commands tree.
- **Test Runs in the Status view** — recent CLI test runs (outcome, counts, org, coverage, timestamp) parsed from `logs/test-results/`, refreshing automatically; click a run to open its raw JSON.
- **SFDT: Toggle Coverage Highlights** — runs `sfdt coverage --json` and bands open Apex files (gutter border, subtle background, overview-ruler stripe, inline label) by class coverage; toggle again to clear.
- A custom `logDir` in `.sfdt/config.json` is now honoured when locating snapshots and test results.
- **Native result rendering.** Audit, monitor, coverage, quality, and preflight now run with captured `--json` output under a progress notification — from every entry point (palette shortcuts, the Commands tree, and command search) — refreshing the SFDT trees and rendering a readable summary to the new **SFDT Results** output channel, with a "Run in Terminal" fallback on any failure. Interactive commands (deploy picker, init) keep the terminal.
- **Problems-pane diagnostics.** Quality violations from the CLI's snapshot map to native VS Code diagnostics (severity 1 → Error, 2 → Warning, 3+ → Info) that open the offending file; a skipped scan (scanner not installed) produces no false-clean diagnostics. **SFDT: Clear Diagnostics** empties the collection.
- **Smart Deploy — Validate & Review** (`sfdt.smartDeployPreview`): captures `deploy --smart --dry-run`, shows the parsed delta (components, test level, overwrite protections), then offers Deploy now / Re-validate / Cancel behind a modal, org-named confirmation that warns extra-loudly for production orgs.
- **Quick Deploy** (`sfdt.quickDeploy`): promote a validated deployment by `0Af…` job ID via `sf project deploy quick` in the integrated terminal, with org picker and modal confirmation.
- **"Get started with SFDT" walkthrough** (check CLI → init → first audit → smart-deploy validate → open dashboard) and new catalog entries for `ci init`, `feature-flags`, `config get/set`, `notify <event>`, `pr-description`, and `ai prompt`.
- **Org-health tree**: per-check tooltips with summaries and a "Send snapshot to channels" action (`notify snapshot --type audit|monitor`).

### Changed

- Internal: the two parallel CLI spawn implementations were consolidated into `run-json.ts` (timeout, cancellation, Windows shell, process-group kill); `cli.ts` was removed.

### Fixed

- Commands that accept no `--org` flag (`config`, `feature-flags`, `ai prompt`, `init`, …) no longer get a default org injected into their terminal command line.
- CLI spawning works on Windows (`sfdt.cmd` shim requires a shell since Node's 2024 security patch).

## [0.3.1] - 2026-07-02

### Fixed
- **Embedded dashboard no longer renders a blank panel.** The GUI server sent `X-Frame-Options: SAMEORIGIN`, which blocked the cross-origin `vscode-webview://` frame. The fix is server-side (the CLI now sends `Content-Security-Policy: frame-ancestors 'self' vscode-webview:`), so the dashboard webview requires **`@sfdt/cli` 0.15.2 or later**.

### Changed
- Refreshed the extension icon and README wording.

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
