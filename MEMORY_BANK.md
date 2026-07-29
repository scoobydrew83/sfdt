# Memory Bank — sfdt

<!--
FORMAT (CONVENTIONS.md §4): one decision per line, APPEND-ONLY.

  - YYYY-MM-DD · <who/what> · <decision> · <why>

Never edit or delete a past entry. To change a decision, append a new dated line
that supersedes the old one — the log is the audit trail.

WHAT BELONGS HERE: settled calls and their rationale, so agents stop
relitigating them; verdict summaries from verification agents; lessons from
completed work. Architecture and conventions live in CLAUDE.md, phase criteria
in FEATURES.json, forward work in ROADMAP.md — do not mirror those here.

The 2026-07-27 block below is the seed: decisions already settled in code and
docs, backdated to the day they were captured because the original decision
dates were not recorded. Everything after it is dated when it happened.
-->

## Decisions

### Seed — captured 2026-07-27

#### Licensing & provenance
- 2026-07-27 · license · Apache-2.0 for the suite · permissive, patent grant, acceptable to enterprise Salesforce customers
- 2026-07-27 · license · `audit`/`monitor` are clean-room reimplementations of the sfdx-hardis diagnose/monitor feature set · deliberately no AGPL dependency; the feature set is the reference, the code is not
- 2026-07-27 · license · `tools/license-policy.json` + `check:licenses` are the single statement of policy · every other assertion of it is checked against that file, not maintained by hand

#### Surface & contracts
- 2026-07-27 · contracts · `generated/*` is derived, never hand-edited; code is authoritative and CI fails on drift · a catalog that can be edited independently stops being a description of reality
- 2026-07-27 · contracts · The sf-native JSON envelope is a **stdout-only** contract; on-disk snapshots (`logs/*-latest.json`) stay raw · GUI and VS Code read the snapshot shapes directly, so wrapping them would break both surfaces for no gain
- 2026-07-27 · contracts · Config keys move in lockstep across template + `config-schema.json` + consuming code · the schema is `additionalProperties: false`, so a key missing from it throws at runtime even though it shipped in the template
- 2026-07-27 · contracts · Package-internal paths resolve from `import.meta.url`, never `_projectRoot`/`process.cwd()` · when globally installed those point at the user's Salesforce project, so a CWD-relative package read works only on the author's machine

#### Packaging
- 2026-07-27 · packaging · The VS Code extension's manifest `name` is unscoped (`sfdt-devtools`) · the Marketplace rejects scoped names; consequence is that root `*:vscode` scripts must select the workspace by path (`-w vscode`), not by package name
- 2026-07-27 · packaging · `@sfdt/plugin` declares `@sfdt/cli` as `>=`, not an exact pin · an exact pin makes the version-bump commit's own `npm ci` 404 on the not-yet-published version; the two publish together, so an install still resolves to the matching version
- 2026-07-27 · packaging · The oclif command files under `packages/plugin/src/commands/sfdt/**` are code-generated from `createCli()` and gitignored · the Commander definitions are the single source of truth; hand-editing generated commands forks the surface silently

#### Quality gates
- 2026-07-27 · quality · Code Analyzer v5 is required; a v4-only environment emits `skipped`, never a pass (J-1 policy) · rendering an unrun check as green is worse than reporting it did not run. v4 support is removed at 1.0
- 2026-07-27 · quality · Beta / license-gated org checks degrade to `warn`, never `error` · `audit all` / `monitor all` must not fail CI because an org lacks an API the check depends on
- 2026-07-27 · quality · Preflight `strict` overrides the per-check enforce flags · a check left as a WARN by `enforceX: false` is still promoted under strict; strict means strict

#### Docs
- 2026-07-27 · docs · The public site (https://sfdt.dev) lives in a separate repo, `scoobydrew83/sfdt-site`, and is released together with the CLI · stale docs on a public site are a bug, so user-facing changes mirror in the same effort

#### Harness (Conductor Method)
- 2026-07-27 · harness · GitHub Actions runs the agents; n8n owns only the notify/escalation edge · keeps the loop in-repo and legible, while routing stays where routing is easy to change (locked by Drew 2026-07-18)
- 2026-07-27 · harness · The `skills` repo is the method's system of record; agent definitions are read live from it by CI, not vendored · one distribution point, so a definition fix takes effect on the next scheduled run — and a bad edit ships everywhere at once
- 2026-07-27 · harness · Self-improving is not self-approving — the improver opens PRs and never merges · gates and humans merge; an agent that can approve its own work has no gate
- 2026-07-27 · harness · Telemetry is evidence: agents read `.harness/telemetry.jsonl` and never rewrite it · a log an agent can edit is not a log
- 2026-07-27 · harness · `logs/history.db` is gitignored and machine-local, so `.harness/telemetry.jsonl` is the tracked mirror CI mines · the db never reaches a runner; without the mirror the improver has no signal in Actions

### 2026-07-27 — H-013 proof run (one full self-improvement cycle)

- 2026-07-27 · conductor-verifier · sfdt#277 FAIL then PASS after two fixes · improver's `tools/check-package-internal-paths.mjs` was sound, but shipped based on `main` while cut from `develop` (19 files/24 commits) and its `CWD_LIKE` regex could not match the bare `projectRoot` its own header claimed to cover
- 2026-07-27 · harness · `workflow_dispatch` requires the workflow on the **default** branch, not merely on the ref you dispatch · dispatching from `develop` returns "HTTP 404: not found on the default branch"; every new harness workflow needs that step before it can be triggered
- 2026-07-27 · harness · Improver PRs must pass an explicit `gh pr create --base` · without it `gh` targets the default branch, so a PR cut from an integration branch arrives carrying every commit on it. Fixed at source in `skills@e83b28c`
- 2026-07-27 · lesson · The verifier earned its keep by failing a PR that looked fine at the title · both defects were invisible from the summary and only surfaced by probing the check and reading the base ref
