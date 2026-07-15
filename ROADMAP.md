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
- **`quality --allow-legacy-analyzer`** — Code Analyzer v4 is opt-in legacy, non-authoritative; removed at 1.0 — **In develop** (see below)

Items this revision reclassified from "planned" to shipped (they were stale here): unified logic tests (`sfdt test --logic`), Agentforce support (`sfdt agent-test` + GenAi metadata in smart-deploy deltas), Code Analyzer v5 in `sfdt quality`, the agent-skills pack (`skills export --target pack`), MCP mutating-tool expansion, the Chrome Web Store publish job, the org release badge, the Flow Scanner surface, and native-host read-only kinds. See the changelog for each.

## In develop (merged, unreleased)

## Planned

## Research

## Blocked

## Feedback

Feature ideas welcome — please open an issue in the repository.
