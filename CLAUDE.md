# CLAUDE.md — sfdt CLI

`@sfdt/cli`: a Node.js ESM CLI for Salesforce DX deployment, testing, quality analysis, and release management. **Generic tool** — works with any Salesforce DX project, contains no project-specific values. Commander.js routing · execa shell execution · entry point `bin/sfdt.js`.

This file is a map, not a manual (harness H-008). Read the doc that matches your task; don't guess from memory.

## Get bearings (start every session here)

1. `pwd` — confirm you're in the sfdt package, not a target SF project.
2. `git log --oneline -20` and, if present, MEMORY_BANK.md tail — what happened recently.
3. FEATURES.json — the active phase's ground truth; pick ONE `passes:false` item.
4. `npm test` and `npm run check:all-contracts` — confirm the tree is green before changing it.

## Directory map

```
bin/            CLI entry point (loads plugins, then parses args)
src/commands/   One thin file per command — logic lives elsewhere
src/lib/        Shared libraries (config, output, AI, runners, notifier, run-history, agent-loop, …)
scripts/        De-parameterized shell scripts driven by SFDT_ env vars (see docs/ENV-VARS.md)
test/           Vitest tests
gui/            React + Vite dashboard (`sfdt ui`); built output in gui/dist/
vscode/         VS Code extension (CLI-backed, no reimplemented logic)
packages/       Published sub-packages: flow-core (@sfdt/flow-core), plugin (@sfdt/plugin)
generated/      Machine-generated surface catalogs — NEVER hand-edit (docs/DEVELOPMENT.md)
tools/          check-*.mjs contract lints (run via npm run check:all-contracts)
docs/           The system of record — see pointer table below
.sfdt/          Per-project config dir created by `sfdt init` in target projects
```

## Where to look

| Task | Read |
|------|------|
| The rules with teeth (11 mechanical principles) | `docs/golden-principles.md` |
| How a subsystem works (patterns: AI, notifier, run-history, smart deploy, CI templates, plugin, JSON envelope) | `docs/PATTERNS.md` |
| System design, package topology, lifecycles, threat boundaries, "adding a …" recipes | `docs/ARCHITECTURE.md` |
| SFDT_ env var ↔ config mapping | `docs/ENV-VARS.md` |
| Dev workflow: build/link, GUI testing, changing a public surface, path resolution, docs-site duty | `docs/DEVELOPMENT.md` |
| Command usage and flags | `docs/USAGE.md` |
| MCP server and tools | `docs/MCP.md` |
| Plugin system | `docs/PLUGINS.md` |

## Invariants you will hit today (full text in golden-principles.md)

- Commands stay thin; runners own logic. (#1)
- Never hand-edit `generated/*`; regenerate and commit the diff — CI fails on drift. (#2)
- Config keys touch three places in lockstep: template, schema, consumer. (#3)
- Secrets by env-var NAME only — config never holds a value. (#4)
- Telemetry never throws; measurement can't break the measured. (#5)
- JSON envelope on stdout only; on-disk snapshots stay raw. (#6)
- Mutating MCP tools declare `confirmExecution`. (#7)
- Package-internal paths resolve via `import.meta.url`, never CWD. (#8)
- The verifier never writes. (#9)
- One feature per session; clean tree at handoff. (#10)
- FEATURES.json is ground truth — only `passes`/`evidence` flip, only with re-checkable evidence. (#11)

## Cross-repo duties

- **Docs site (sfdt.dev):** user-facing changes must be mirrored to `sfdt-site` (separate repo, released together). Staleness pass before a release is done. Details: `docs/DEVELOPMENT.md`.
- **Skills mirror:** `sfdt-skills` is a pure downstream mirror synced by `sfdt skills export --target pack` during release (RELEASING.md §7) — never edited by hand.
- **Harness:** this repo is graded by `check-harness.mjs` in the `skills` repo. Adoption claims live in HARNESS-FEATURES.json there, not in prose.

## Development quick reference

```bash
npm test / npm run lint / npm run test:coverage
npm run dev:ui        # build GUI + npm link (then verify: ls -la $(which sfdt))
npm run generate:catalogs && npm run check:all-contracts
```

When adding an env var: update `buildScriptEnv()` in `script-runner.js` AND the table in `docs/ENV-VARS.md`.
