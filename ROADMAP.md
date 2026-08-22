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

- **v0.22.x** — `sfdt soql` (schema/validate/plan/bounded execution), `sfdt apex` (trace flags, debug logs, Anonymous Apex), the GUI SOQL Console, ApexGuru in `sfdt quality`, bridge `manifest.discover`/`manifest.render` (protocol 1.3), CI template hardening — **Shipped (stable)**
- **v0.18–v0.21** — visual manifest builder across GUI/VS Code/Chrome, `sfdt quality --api67` readiness scan, config treated as untrusted input — **Shipped (stable)**
- **v0.17.0** — `sfdt doctor`, `test --lwc`, `quality --output-file` (SARIF), Claude Code skill installs, skills audit + drift guard — **Shipped (stable)**
- **v0.16.x** — dependency graph seed+expand, `dependencies --gaps`, run history (`sfdt history`), MCP mutating/test tools, native-host read-only kinds, skills pack export, Apache-2.0 relicense — **Shipped (stable)**
- **`RunRelevantTests` smart-deploy opt-in** (`deployment.smart.useRelevantTests`) — depends on the Salesforce Spring '26 beta API — **Shipped (beta)**
- **Legacy Code Analyzer v4 removed (F-001)** — v5 is the only supported engine; the `quality --allow-legacy-analyzer` opt-in and the v4 (`sf scanner run`) fallback are gone — **In develop (removal landed)**

Items this revision reclassified from "planned" to shipped (they were stale here): unified logic tests (`sfdt test --logic`), Agentforce support (`sfdt agent-test` + GenAi metadata in smart-deploy deltas), Code Analyzer v5 in `sfdt quality`, the agent-skills pack (`skills export --target pack`), MCP mutating-tool expansion, the Chrome Web Store publish job, the org release badge, the Flow Scanner surface, and native-host read-only kinds. See the changelog for each.

## In develop (merged, unreleased)

_Empty._ The four items previously listed here — ApexGuru in `sfdt quality`, `sfdt apex`,
the `sfdt soql` family, and the GUI SOQL Console — all shipped in **v0.22.0** (2026-08-03) and
have moved to "Recently shipped" above. See [CHANGELOG.md](CHANGELOG.md) for each.

## Planned

Cross-workstream dispatch and status (including Chrome-extension items tracked outside this repo) lives on the internal Notion board "SFDT Master Backlog — Agent Dispatch Board"; this file remains the source of truth for the CLI items below.

Two competitor reviews feed this section. The sf-pi integration review (2026-07-29) is cited as `docs/reviews/sf-pi-integration-review.md` but that file is **not present in this repo** — its three sequenced items (`sfdt apex`, `sfdt soql`, ApexGuru) all shipped in v0.22.0 regardless. The [SFDevTools competitive analysis](docs/reviews/sfdevtools-competitive-analysis.md) (2026-08-22) sources the tier-1 items below it.

Everything here re-implements capabilities natively — no dependency on the reviewed product, no code copied. FEATURES.json entries are seeded when a phase for them opens; the active phase remains 1.0 stabilization (F-001 first), whose stated intent is holding the surface still, so **nothing below is scheduled inside it**.

- **Visual manifest builder (GUI · VS Code · Chrome)** — changeset-style checkbox builder: browse org inventory or local source by type, tick components, live package.xml / destructiveChanges.xml preview, save/deploy. One engine (`renderPackageXml` + `org-inventory.js`), GUI page inherited by VS Code via the dashboard iframe, Chrome via new read-only bridge kinds. Absorbs extension-plan items P5-4/P5-5 (pulled forward 2026-07-29). Mini-plan: [docs/design/visual-manifest-builder.md](docs/design/visual-manifest-builder.md) — **Planned**

Sourced from the [SFDevTools competitive analysis](docs/reviews/sfdevtools-competitive-analysis.md) (2026-08-22), tier 1 — each extends an engine we already own rather than adding a surface:

- **Effective FLS/OLS permission matrix** — resolve object and field access per profile *and* per user (profile + permission sets + permission set groups + muting), rendered as a read/write/none grid. `audit lint-access` / `lint-access-fields` already query `ObjectPermissions`/`FieldPermissions` in `src/lib/audit-runner.js`; the gap is *effective* resolution plus a matrix view, not new org access. Adds a GUI page and `sfdt_audit` inputs — **Planned**
- **Cross-org permissions diff** — diff two orgs' effective matrices via the existing two-org comparison in `src/lib/org-diff.js`. Read-only; a writable bulk-fix path stays out until the approval ledger below exists. Depends on the matrix item — **Planned**
- **Bulk API v2 data loading** — `sfdt data` is `sf data tree` only: no bulk path, no CSV field mapping, no upsert-by-external-ID. Extends `src/commands/data.js` over `sf data import bulk` / `sf data upsert bulk` (no new dependencies). The largest single capability gap a working Salesforce team would notice — **Planned**
- **Setup Audit Trail anomaly layer** — velocity detection (N× baseline per user/section in a window) and a security-sensitive action list (password policy, session settings, permission changes, connected apps, certificates) over the `SetupAuditTrail` data `audit audittrail` already retrieves. Post-processing only, and it feeds `sfdt notify` — **Planned**
- **Record edit/clone/delete in Chrome `inspect-record`** — design complete and awaiting approval since 2026-07-30 ([docs/design/record-edit-clone.md](docs/design/record-edit-clone.md)). Blocked on a decision, not on work — **Planned**

## Research

Directional, not sequenced. From the [SFDevTools competitive analysis](docs/reviews/sfdevtools-competitive-analysis.md) (2026-08-22), tiers 2–3:

- **Approval ledger for org-mutating agent actions** — a staged before/after diff plus an append-only ledger distinct from `src/lib/run-history.js`, layered on the existing `confirmExecution` gating (golden principle #7). Valuable standalone, and the precondition for any org-*data* mutating MCP tool — **Research**
- **Committed dashboard specs** — AI-authored dashboard definitions that live in the repo, are code-reviewed, and render in the GUI over `src/lib/soql-runner.js`. Deliberately not a hosted dashboard product; the spec shape is close to Studio's `ComponentSpec`, so one substrate could serve both — **Research**
- **Package inventory + Platform Events/CDC promoted to CLI/MCP** — both exist Chrome-only today (`event-monitor`); `InstalledSubscriberPackage` via Tooling is new. Small, closes visible gaps — **Research**
- **Field-usage deep scan** — parallel scoped queries to get past the 2,000-result ceiling, as a query-planning addition to `src/lib/soql-runner.js` — **Research**
- **AI cost transparency and model tiering** — surface real token counts per turn (and zero for a local model), plus per-command model hints over `ai.provider`/`ai.model`. Our BYOK position makes this a strength, not a meter — **Research**
- **Named agent presets as shareable objects** — packaging over the existing prompt library (`src/lib/prompts.js`) and skills pack (`sfdt skills export`) — **Research**
- **Automatic production-org detection with propagated colour** — extend `sfdt.orgColor` from VS Code to the GUI and Chrome, with irreversible-action warnings — **Research**
- **Studio handoff: `sfdt deploy --validate` on a Studio export** — Studio never touches an org (no OAuth, no `sf` shell-out); sfdt already has org auth. The handoff turns a ZIP into a component validated against a real org. Tracked here because the CLI side is the small half — **Research**

## Blocked

## Feedback

Feature ideas welcome — please open an issue in the repository.
