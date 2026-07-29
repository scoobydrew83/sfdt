# sfdt Roadmap

Forward-looking work only. Shipped work lives in [CHANGELOG.md](CHANGELOG.md) — this file does not duplicate it.

Every item carries exactly one status:

| Status | Meaning |
|---|---|
| **Shipped (stable)** | Released (≤ v0.17.0), generally available |
| **Shipped (beta)** | Released, but behind an opt-in or depends on a Salesforce beta API |
| **In develop** | Merged to `develop`, not yet in a release |
| **Planned** | Approved and sequenced, not started |
| **Research** | Exploratory; no commitment |
| **Blocked** | Waiting on an external dependency |

## Recently shipped

Full detail in [CHANGELOG.md](CHANGELOG.md). Highlights only:

- **v0.17.0** — `sfdt doctor`, `test --lwc`, `quality --output-file` (SARIF), Claude Code skill installs, skills audit + drift guard — **Shipped (stable)**
- **v0.16.x** — dependency graph seed+expand, `dependencies --gaps`, run history (`sfdt history`), MCP mutating/test tools, native-host read-only kinds, skills pack export, Apache-2.0 relicense — **Shipped (stable)**
- **`RunRelevantTests` smart-deploy opt-in** (`deployment.smart.useRelevantTests`) — depends on the Salesforce Spring '26 beta API — **Shipped (beta)**
- **Legacy Code Analyzer v4 removed (F-001)** — v5 is the only supported engine; the `quality --allow-legacy-analyzer` opt-in and the v4 (`sf scanner run`) fallback are gone — **In develop (removal landed)**

Items this revision reclassified from "planned" to shipped (they were stale here): unified logic tests (`sfdt test --logic`), Agentforce support (`sfdt agent-test` + GenAi metadata in smart-deploy deltas), Code Analyzer v5 in `sfdt quality`, the agent-skills pack (`skills export --target pack`), MCP mutating-tool expansion, the Chrome Web Store publish job, the org release badge, the Flow Scanner surface, and native-host read-only kinds. See the changelog for each.

## In develop (merged, unreleased)

- **ApexGuru check in `sfdt quality`** — additive org-side analysis alongside Code Analyzer v5; license/edition-gated, so it degrades to `warn`/`skipped`, never `error`, and never changes the quality exit code. `quality --apexguru` / `--skip-apexguru` / `--org`. Inspired by sf-pi's SF Code Analyzer extension (native re-implementation) — **In develop**
- **`sfdt apex` — Apex observability** — trace flags (`apex trace start|list|stop`, Tooling API), debug log retrieve/watch (`apex logs list|get|watch`, bounded/CI-safe tail), Anonymous Apex execution (`apex run` from file or stdin); complements `sfdt test`. MCP: `sfdt_apex_logs` (read-only), `sfdt_apex_trace`/`sfdt_apex_run` (confirmExecution-gated). Inspired by sf-pi's SF Apex extension, natively re-implemented — **In develop**
- **`sfdt soql` command family** — schema search/describe, relationship discovery, query validation, query plans, bounded SOQL/SOSL execution with exports. Thin command + `soql-runner.js`; read-only MCP tools (`sfdt_soql_*`) and a VS Code "SOQL Toolkit" tree group. Native re-implementation inspired by sf-pi's SF SOQL extension (no dependency, no code copied) — **In develop**

## Planned

Cross-workstream dispatch and status (including Chrome-extension items tracked outside this repo) lives on the internal Notion board "SFDT Master Backlog — Agent Dispatch Board"; this file remains the source of truth for the CLI items below.

Sequenced from the [sf-pi integration review](docs/reviews/sf-pi-integration-review.md) (2026-07-29). All three re-implement capabilities natively — no dependency on sf-pi, which is pi-runtime-coupled. FEATURES.json entries are seeded when a phase for them opens; the active phase remains 1.0 stabilization (F-001 first).

- **GUI SOQL query console** — dashboard page surfacing the `sfdt soql` family (schema browse/describe, query validation, bounded execution with export) over the existing `soql-runner.js` + gui-server pattern — no logic reimplementation, the runner stays the single engine. Split out of the initial `sfdt soql` delivery by decision 2026-07-29 (backlog item D-4; the CLI/MCP/VS Code surfaces shipped first) — **Planned**
- **Visual manifest builder (GUI · VS Code · Chrome)** — changeset-style checkbox builder: browse org inventory or local source by type, tick components, live package.xml / destructiveChanges.xml preview, save/deploy. One engine (`renderPackageXml` + `org-inventory.js`), GUI page inherited by VS Code via the dashboard iframe, Chrome via new read-only bridge kinds. Absorbs extension-plan items P5-4/P5-5 (pulled forward 2026-07-29). Mini-plan: [docs/design/visual-manifest-builder.md](docs/design/visual-manifest-builder.md) — **Planned**

## Research

## Blocked

## Feedback

Feature ideas welcome — please open an issue in the repository.
