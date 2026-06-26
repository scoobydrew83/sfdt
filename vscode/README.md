# SFDT for Salesforce (VS Code)

[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/sfdt.sfdt-devtools)](https://marketplace.visualstudio.com/items?itemName=sfdt.sfdt-devtools)
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

- **Org Health sidebar** — a tree view that reads the latest `sfdt audit` and
  `sfdt monitor` snapshots (`logs/audit-latest.json`, `logs/monitor-latest.json`)
  and shows each check's status, summary, and findings. Click any check to
  re-run just that check.
- **Command palette** — `SFDT: Run Command…` lists the common operations
  (preflight, audit, monitor, backup, drift, scan, quality, docs, deploy).
  Dedicated commands exist for the most-used ones.
- **Embedded dashboard** — `SFDT: Open Dashboard` spawns `sfdt ui` and shows the
  full web dashboard in an editor tab.
- **Status bar** — shows the active org and the worst monitor/audit status; click
  to open the dashboard.

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

## Development

```bash
npm install            # from the repo root (workspaces)
npm run build:vscode   # build flow-core + bundle to dist/extension.js
npm run test:vscode    # unit tests (vitest)
```

The workspace is selected by path (`-w vscode`) rather than by package name, so
these keep working regardless of the manifest `name`.

Press **F5** in VS Code to launch an Extension Development Host. Package a
`.vsix` with `npm run package:vscode`.
