# CONTEXT — sfdt

Mission, current phase, and acceptance criteria. Read by every agent that needs
to know **"what does done look like here?"** — in particular `conductor-verifier`,
which returns `BLOCKED` rather than guessing when criteria are missing.

Companion files: [`FEATURES.json`](FEATURES.json) (machine-checkable phase
criteria, ground truth), [`MEMORY_BANK.md`](MEMORY_BANK.md) (settled decisions),
[`CLAUDE.md`](CLAUDE.md) (architecture and conventions), [`ROADMAP.md`](ROADMAP.md)
(forward work).

## Mission

`@sfdt/cli` is the command-line core of the SFDT suite — a production-grade CLI
for Salesforce DX deployment, testing, quality analysis, and release management.
It is a **generic tool**: it works with any Salesforce DX project and contains no
project-specific values. It ships alongside a Chrome extension, a VS Code
extension (`sfdt.sfdt-devtools`), an `sf` plugin (`@sfdt/plugin`), a web
dashboard, and an MCP server — all of which are surfaces over the same CLI logic
rather than reimplementations of it.

## Current phase

**1.0 stabilization.**

The feature surface is broad and largely shipped (see `ROADMAP.md` → "Recently
shipped"). This phase is about removing the last pre-1.0 compromises and holding
the surface still, not adding capability. `ROADMAP.md`'s *In develop* / *Planned*
/ *Research* / *Blocked* sections are currently empty; forward items enter through
`FEATURES.json` as they gain sourced acceptance criteria.

## Acceptance criteria

### 1. Phase criteria — `FEATURES.json` is ground truth

Phase-level acceptance criteria live in `FEATURES.json` as machine-checkable
entries, **not** in this file. Grade against that file, not against prose here —
duplicating criteria in two places guarantees they drift.

Its contract: a verifier may flip `passes` / `evidence` only. Entries are added
or removed only by a planner or human commit. **A `passes: true` the verifier can
no longer reproduce is DRIFT and fails the run.** `tools/check-features-edits.mjs`
enforces the edit rules in `check:all-contracts`.

### 2. Standing gates — every change, every phase

These apply to all work regardless of phase. A change that breaks one is not done:

| Gate | Command | Notes |
|---|---|---|
| Tests | `npm test` | vitest. Mock execa for shell-script tests. |
| Lint | `npm run lint` | eslint over `src/ bin/ tools/`. |
| Contracts | `npm run check:all-contracts` | catalogs, licenses, node floor, auth docs, FEATURES.json edits, package-internal paths. |
| Catalogs | `npm run generate:catalogs` | Required whenever a public surface changes. **Never hand-edit `generated/*`.** |
| Docs | — | User-facing changes mirror to the `sfdt-site` repo (https://sfdt.dev). |

Known pre-existing exception, so nobody mistakes it for a regression they caused:
as of 2026-07-27 `npm test` has **6 failing tests in `extension/`**
(`palette-sources.test.ts`, `setup-tabs.test.ts`). They fail identically on
`develop` and are unrelated to CLI work. Grade a change against whether it changes
that count, not against a green suite.

### 3. Work with no `FEATURES.json` entry

Most PRs — a bug fix, a lint, a doc edit — will not have one, and that is normal.
Grade those against **the criteria the task or PR body states**. If the work
states none and none can be sourced from `FEATURES.json`, `ROADMAP.md`, or the
issue, that is exactly the `BLOCKED` case: stop and ask, do not invent criteria.

## Non-negotiables

Violating one of these is a hard failure regardless of what else passes. Each is
expanded in `CLAUDE.md`; they are restated here because they are the ones agents
actually break:

1. **No project-specific values.** No hardcoded org aliases, branch names, or
   customer data. sfdt is generic.
2. **Package-internal paths resolve from `import.meta.url`** — never
   `config._projectRoot` or `process.cwd()`. Those point at the *user's*
   Salesforce project when globally installed. Enforced by
   `tools/check-package-internal-paths.mjs`.
3. **`generated/*` is derived.** Code is authoritative; regenerate, never edit.
4. **Config keys move in lockstep across three files** — the template
   (`src/templates/sfdt.config.json`), the schema (`src/lib/config-schema.json`,
   `additionalProperties: false`), and the consuming code. Miss one and
   `validateConfig()` throws at runtime.
5. **Secrets are referenced by env-var NAME**, never stored inline in config.
6. **Runtime dependencies are checked before use** — `sf`, `gh`, `claude`, `bash`.

## Harness track

sfdt is also the testbed for the Conductor Method harness (the `H-###` task
series). That work is tracked outside this repo, in the harness project's
`TASKS.md`, and lands here as ordinary PRs graded by the standard gates above.
Harness telemetry is written to `.harness/telemetry.jsonl` (tracked; mined by
`.github/workflows/harness-improver.yml`) and `logs/history.db` (gitignored,
machine-local, read via `sfdt history`).

**Telemetry is evidence.** Agents read it and never rewrite it.

---

*Set up 2026-07-27. Update when scope, phase, or acceptance criteria change —
not per-PR.*
