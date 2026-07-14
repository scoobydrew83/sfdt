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

- **GitHub Action `args-json` input** — closes the shell-injection hole in the legacy `command` eval; `command` is deprecated and hardened behind `allow-shell-command`. Surfaces: Action, CI templates. Status: **In develop**. Tracking: PR #200.
- **Host logDir persistence** — `extension install-host` records the full project context (resolved absolute `logDir`, `configDir`, `cliVersion`) so custom log dirs survive browser-launched host sessions. Surfaces: native host, Chrome extension. Status: **In develop**. Tracking: PR #200.
- **Logic-test zero-test guard + `--wait` validation** — a "passing" logic run that executed zero tests now exits non-zero (`--allow-zero-tests` to opt out); `--wait` must be a whole number ≥ 1. Surfaces: CLI. Status: **In develop**. Tracking: PR #200.
- **Analyzer v4 legacy policy (J-1)** — v5 required for authoritative scans; v4 runs only behind `--allow-legacy-analyzer` and is labeled non-authoritative; skip ≠ pass. Surfaces: CLI, CI templates. Status: **In develop**. Tracking: PR #200, blueprint J-1.
- **Surface catalog framework** — machine-generated inventories of every public surface (commands, Chrome features, GUI pages, VS Code, MCP, bridge, CI) with drift/consistency CI, so counts and parity claims can't go stale. Surfaces: repo tooling, docs site. Status: **In develop**. Tracking: PR #202.

## Planned

From the approved remediation program ([pr-analysis/blueprint-audit-2026-07-12.md](pr-analysis/blueprint-audit-2026-07-12.md)):

- **Live Salesforce integration CI** — the CLI is never exercised against a real org in CI; add a Tier 2 smoke job (protected environment), grow to a nightly matrix. Surfaces: CI. Status: **Planned**. Tracking: blueprint item 7.
- **Release evidence bundle** — each release should carry a verifiable artifact of what was tested (gate reports, catalog snapshot) instead of ad-hoc pr-analysis files. Surfaces: release process, CI. Status: **Planned**. Tracking: blueprint program.
- **API-version audit, phase 1** — extend the `api-versions` audit check with org-ceiling + Flow coverage; new `sfdt versions` command scanning local meta files against the org; Chrome pill. Surfaces: CLI, audit, Chrome extension, VS Code catalog. Status: **Planned**. Tracking: blueprint item F.
- **API-version AI upgrade advisor, phase 2** — AI advisor grounded by a curated per-version registry (`api-version-registry.json`); design complete, build after phase 1. Surfaces: CLI, AI. Status: **Planned**. Tracking: blueprint item F.
- **Async logic-test lifecycle** — `test --logic --async` plus status/resume so long Flow-test runs don't hold a CI slot. Surfaces: CLI. Status: **Planned**. Tracking: blueprint I-2 (deferred).
- **Unified test result model** — one result shape across Apex/logic/LWC/agent tests so history, GUI, and MCP render them uniformly. Surfaces: CLI, GUI, MCP. Status: **Planned**. Tracking: blueprint I-4 (deferred).

## Research

- **Summer '26 setup deep links (Chrome extension)** — quick links to Field Access Summary, enhanced profile UI, Security Center Essentials, Release Manager; value unproven until the pages stabilize. Surfaces: Chrome extension. Status: **Research**.

## Blocked

- **Release Manager channel awareness** — surface the org's release *channel* in compare/retrofit/monitor; the Summer '26 Release Manager Beta exposes no stable queryable public field. Surfaces: CLI, Chrome extension. Status: **Blocked** on a documented Salesforce API (release version/preview already reported by `monitor org-info`).

## Feedback

Feature ideas welcome — please open an issue in the repository.
