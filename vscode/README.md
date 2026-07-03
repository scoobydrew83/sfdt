# SFDT for Salesforce (VS Code)

[![Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=sfdt.sfdt-devtools)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/sfdt.sfdt-devtools)](https://marketplace.visualstudio.com/items?itemName=sfdt.sfdt-devtools)

Drive the [`sfdt`](https://www.npmjs.com/package/@sfdt/cli) CLI from inside VS
Code. This extension is a thin, fast UI over the CLI — it does not reimplement
any logic, so it stays in lockstep with whatever version of `sfdt` you have on
your PATH.

> Published to the VS Code Marketplace as **`sfdt.sfdt-devtools`** (publisher
> `sfdt`, display name "SFDT for Salesforce"). Install from the Extensions view,
> or: `code --install-extension sfdt.sfdt-devtools`. The npm workspace package is
> named `sfdt-devtools` — the Marketplace requires an unscoped name, so it is not
> the scoped `@sfdt/...` form used by the other workspaces.

## Features

The SFDT activity-bar container holds three views plus a status bar:

- **Commands** — a grouped tree of the *entire* sfdt command surface (30+
  commands / 50+ subcommands) across six categories: **Deploy & Release**,
  **Org Health**, **Quality & Analysis**, **Documentation**, **Data & Scratch
  Orgs**, and **Project & Tools**. Click a command to run it in a dedicated
  **SFDT** integrated terminal — live, colored, streaming output, with
  interactive prompts supported. Destructive commands confirm first. Right-click
  any command to **Run**, **Copy** the exact `sfdt …` invocation, or **Open
  docs** on [sfdt.dev](https://sfdt.dev/). `SFDT: Run Command…` is a searchable
  quick-pick over everything.
- **Status** — the active target org (alias, instance URL, connection), the git
  branch, an Org Health rollup, and the installed `sfdt`/`sf` versions with an
  "update available" hint. Use the title-bar **Select Org** button to switch the
  target org from `sf org list`.
- **Org Health** — reads the latest `audit`, `monitor`, `scan`, and `drift`
  snapshots and shows each check's status, summary, and findings; click a check
  to re-run it. All views auto-refresh when a `logs/*-latest.json` snapshot
  changes.
- **Embedded dashboard** — `SFDT: Open Dashboard` runs `sfdt ui` and shows the
  full web dashboard in an editor tab (authenticated via the CLI's launch token).
  Follows the editor's light/dark theme and recovers automatically from dashboard
  port conflicts.
- **Per-org window theming** — tints the window by org type (production = red,
  sandbox = orange, scratch/developer = green) to prevent wrong-org mistakes
  (toggle with `sfdt.orgColor`).
- **Status bar** — shows the active org and the worst monitor/audit status.

New here? When the `sfdt` CLI isn't found or the project isn't initialized, the
views offer a one-click **Run sfdt init** and links to the install docs.

## Requirements

- The `sfdt` CLI installed and on your PATH (`npm i -g @sfdt/cli`), or set
  `sfdt.cliPath` to its location.
- A Salesforce DX project initialized with `sfdt init`.

## Settings

| Setting | Default | Description |
| ------- | ------- | ----------- |
| `sfdt.cliPath` | `sfdt` | Path to the sfdt binary. |
| `sfdt.defaultOrg` | `""` | Org alias passed as `--org`; empty uses the project default. |
| `sfdt.dashboardPort` | `7654` | Port the `sfdt ui` server listens on. |
| `sfdt.orgColor` | `true` | Tint the window by org type (prod/sandbox/scratch) to prevent wrong-org mistakes. |

## Development

```bash
npm install            # from the repo root (workspaces)
npm run build:vscode   # build flow-core + bundle to dist/extension.cjs
npm run test:vscode    # unit tests (vitest)
```

The workspace is selected by path (`-w vscode`) rather than by package name, so
these keep working regardless of the manifest `name`.

Press **F5** in VS Code to launch an Extension Development Host. Package a
`.vsix` with `npm run package:vscode`.
