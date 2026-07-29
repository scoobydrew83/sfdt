# Review: `salesforce/sf-pi` — what (if anything) belongs in the sfdt CLI

**Date:** 2026-07-29
**Scope:** Evaluate https://github.com/salesforce/sf-pi for capabilities worth incorporating into `@sfdt/cli`, and record the "next phase" answer from the internal docs hub.

## What sf-pi actually is

`salesforce/sf-pi` is **not** a Salesforce CLI (`sf`) plugin and not a deployment tool. It is an
Apache-2.0-licensed bundle of ~24 TypeScript extensions for the **pi coding agent** (pi.dev),
requiring Node ≥ 22.19 and the pi runtime (≥ 0.82.0), maintained by a Salesforce Forward
Deployed Engineer. Every extension is coupled to pi's extension API (slash commands, status
bar, hooks, TUI), so **nothing can be vendored or depended on directly**.

"Incorporation" therefore means **re-implementing selected capabilities natively** in sfdt's
own architecture (thin command + runner, MCP auto-surfacing, JSON envelope). The Apache-2.0
license permits studying and porting the approach with attribution; no code is copied.

## Per-extension verdicts

| sf-pi extension | Capability | Verdict for sfdt |
|---|---|---|
| **SF SOQL** | Schema search/describe, relationship discovery, query drafting/validation, query plans, bounded SOQL/SOSL execution, exports | **Incorporate — top pick.** Biggest genuine gap: sfdt has `scan`, `dependencies`, and `data` but no query/schema lifecycle at all. |
| **SF Apex** | Trace flags, debug log retrieve/watch, Anonymous Apex, targeted tests | **Incorporate.** Complements the existing `test` runner; sfdt has no log/trace/anonymous-Apex surface. |
| **SF Code Analyzer** (ApexGuru pass) | ApexGuru org-side analysis on top of Code Analyzer | **Incorporate (small).** Additive check inside `sfdt quality`; ApexGuru is license/edition-gated so it must degrade to `warn`/`skipped`, never `error` (existing policy for gated org checks). |
| SF LWC | Project scan, component inspection, targeted Jest tests | Partial, later. Overlaps `versions`/`quality`/`test --lwc`; incremental value is low. |
| SF Docs | Cited Salesforce documentation lookup | Skip for now. AI-adjacent nicety; could become a prompt-catalog helper later. |
| SF Data Explorer | Interactive query TUI | Skip. The bounded-execution piece lands inside the SOQL toolkit instead; sfdt is non-interactive-first (CI). |
| SF LSP, DevBar, Splash, tldraw, Herdr, Brain | Agent-runtime UX (status bar, splash, diagramming, workspace lanes, session kernel) | Skip. Pi-runtime concerns with no CLI analogue. |
| SF Guardrail | File protection, dangerous-command gating | Skip. sfdt's equivalent already exists: MCP `confirmExecution` on mutating tools, read-only verifier, no-write agent-loop default. |
| SF Skills | Skill-source management across Claude Code/Codex/Cursor | Skip. `sfdt skills` already covers export/install/audit. |
| SF Slack, SF Browser, SF Data 360, SF Agent Script | Slack search, browser automation, Data Cloud tooling, `.agent` authoring | Skip. Out of scope for a generic SFDX deploy/quality CLI. Data 360 or Agent Script support would suit an out-of-tree `sfdt-plugin-*` package if ever needed. |

## How the "incorporate" items would land

All three follow seams the codebase already has:

1. **Thin command + runner** — e.g. `src/commands/soql.js` delegating to `src/lib/soql-runner.js`
   (golden principle #1), same for Apex observability.
2. **Check-registry propagation** — an ApexGuru check added alongside Code Analyzer v5 in the
   quality path surfaces automatically to CLI, MCP, GUI, and VS Code, the same way
   `monitor-runner.js`'s `CHECKS` map works.
3. **Graceful degradation** — the established "shell out to `sf` / org API, emit
   `skipped`/`warn` when the plugin or license is absent, never fabricate a pass" pattern
   (as with Code Analyzer v5 JIT install).

Constraints to respect when these are built: config keys move template + schema + consumer in
lockstep; JSON envelope on stdout only; no hand-edits to `generated/*`; one feature per session.

These three items are now recorded in [ROADMAP.md](../../ROADMAP.md) under **Planned**.
Per the FEATURES.json contract, FEATURES entries are seeded only when a phase for them opens —
the active phase is still **1.0 stabilization**, whose single open item is **F-001** (remove
legacy Code Analyzer v4 support). That lands first.

## Next phase (from the internal docs hub)

- **Repo level (`@sfdt/cli`):** finish **1.0 stabilization** — F-001, removing `sf scanner run`
  v4 fallback and the `--allow-legacy-analyzer` opt-in. The forward queue in ROADMAP.md was
  empty before this review seeded the Planned section.
- **Product level:** **Studio by SFDT Phase 0 (validation) is complete** — 8/9 board items
  Done, decision memo: *"GO for constrained MVP; include BYOM model option and
  open-source/self-hosted sandbox runner."* The next phase to build is **Phase 1 — internal
  alpha** (project model, structured spec, generation pipeline, 10–15 base components, Apex
  mock registry, basic LDS adapters, scenario switcher, code editor, diagnostics, ZIP export,
  internal telemetry). Studio Phase 1 is a separate application, not CLI work; CLI involvement
  begins around Phase 2 (SFDT bridge prototype) and Phase 4 (CLI commands).
- **Flag:** the Phase 0 board still shows the **competitive audit as Blocked** even though the
  decision memo is Done/GO. Worth resolving on the board so the GO decision's evidence trail
  is consistent.
