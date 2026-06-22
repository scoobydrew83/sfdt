# SFDT — Salesforce DevTools for VS Code

Drive the [`sfdt`](https://www.npmjs.com/package/@sfdt/cli) CLI from inside VS
Code. This extension is a thin, fast UI over the CLI — it does not reimplement
any logic, so it stays in lockstep with whatever version of `sfdt` you have on
your PATH.

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
npm run build -w @sfdt/vscode    # bundle to dist/extension.js
npm run test -w @sfdt/vscode     # unit tests (vitest)
```

Press **F5** in VS Code to launch an Extension Development Host. Package a
`.vsix` with `npm run package -w @sfdt/vscode`.
