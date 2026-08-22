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

**Active phase: "Trustworthy writes"** (opened 2026-08-22). The 1.0 stabilization phase passed its verdict on 2026-08-12 (`.harness/telemetry.jsonl`), and what 1.0 itself now requires is written down in [docs/versioning.md](docs/versioning.md) rather than left implicit. This phase's theme: every remaining item on the competitive backlog is a *write* feature, and the transport underneath them misreports write outcomes. Fix that, then ship writes.

Two competitor reviews feed this section. The sf-pi integration review (2026-07-29) is cited as `docs/reviews/sf-pi-integration-review.md` but that file is **not present in this repo** — its three sequenced items (`sfdt apex`, `sfdt soql`, ApexGuru) all shipped in v0.22.0 regardless. The [SFDevTools competitive analysis](docs/reviews/sfdevtools-competitive-analysis.md) (2026-08-22) sources the rest.

Everything here re-implements capabilities natively — no dependency on the reviewed product, no code copied.

**FEATURES.json seeding for this phase is a separate, `develop`-direct commit.** `tools/check-features-edits.mjs` diffs the fork point against the working tree, so *any* branch that adds an entry fails `check:features` — and therefore `check:all-contracts` and CI. Only on the integration branch is the fork point HEAD and the diff empty. (The checker's own remediation text says to "land it in its own commit so the diff carries nothing else", which does not actually satisfy the rule from a branch; worth reconciling the text with the behaviour.)

### Workstream A — the write transport (extension)

Both are live defects on already-shipped features, both are scoped as standalone branches in [docs/design/record-edit-clone.md](docs/design/record-edit-clone.md) ("External prerequisites"), and workstream C cannot start until they land.

- **`ext/fix-write-timeout`** — `extension/lib/salesforce-api.ts:16` sets `SEND_MESSAGE_TIMEOUT_MS = 5000` and `apiRequest()` inherits it, so a PATCH still in flight at 5 s throws `No Salesforce session available` — **a write that may have committed, reported as a failure**. Live on `data-import`, `field-creator`, `apex-anonymous`. Writes get an explicit timeout, and a transport failure becomes distinguishable at the call site from a server rejection — **Planned**
- **`ext/enabled-by-default-authoritative`** — `isFeatureEnabled()` (`extension/lib/settings.ts:107`) returns `true` for any id with no stored entry, so the `enabledByDefault` flag in the manifest is never consulted and every new feature ships on. Runtime reads `manifest.enabledByDefault ?? true` — **Planned**

### Workstream B — Bulk API v2 data loading (CLI)

- **Bulk API v2 data loading** — `sfdt data` is `sf data tree` only: no bulk path, no CSV field mapping, no upsert-by-external-ID. `sf data delete bulk` is already wired (`src/lib/data-runner.js:127-153`) and the partial-success result shape bulk needs is already designed, so this is additive: widen `makeAction`'s signature to carry options, extend the data-set spec to discriminate tree-style from bulk-style, and add `buildImportBulkArgs`/`buildUpsertBulkArgs` beside the existing pure `buildExportArgs`. No new dependencies. The largest single capability gap a working Salesforce team would notice — **Planned**

### Workstream C — record edit / clone / delete (Chrome)

- **Record edit/clone/delete in `inspect-record`** — **approved 2026-08-22**; build the four-PR chain in [docs/design/record-edit-clone.md](docs/design/record-edit-clone.md). PR-1 rebases onto workstream A. Delete ships as its own feature id (`record-delete`) so it is independently kill-switchable — **Planned**

### Also in this phase

- **Setup Audit Trail anomaly layer** — velocity detection (N× baseline per user/section in a window) and a security-sensitive action list (password policy, session settings, permission changes, connected apps, certificates) over the `SetupAuditTrail` data `audit audittrail` already retrieves. Post-processing only, and it feeds `sfdt notify` — **Planned**
- **Fix the two known flaky tests** — `test/lib/bridge-routes-extra.test.js` and `test/lib/gui-server-routes3.test.js` fail roughly 1 run in 8 under full-suite load (RELEASING.md §"Known flakes"). They already forced `npm test` out of `prepublishOnly`, and they can red the hard CI gate at random. Fixing them is a 1.0 requirement — **Planned**

### Not in this phase

- **Visual manifest builder** — this was listed here as Planned while [docs/design/visual-manifest-builder.md](docs/design/visual-manifest-builder.md) records it as **SHIPPED — all four PRs landed**. The design doc is correct; the entry was stale and is removed.
- **Effective FLS/OLS permission matrix** and **cross-org permissions diff** — moved to Research. A previous revision of this file described them as extending an engine we already own. That was wrong, and the correction matters for scoping — see Research below.

## Research

Directional, not sequenced. From the [SFDevTools competitive analysis](docs/reviews/sfdevtools-competitive-analysis.md) (2026-08-22), tiers 2–3.

- **Effective FLS/OLS permission matrix** — resolve object and field access per profile *and* per user (profile + permission sets + permission set groups + muting) as a read/write/none grid, plus a cross-org diff. **Needs a design doc before any code.** The existing checks are not a starting point: `checkLintAccess`/`checkLintAccessFields` select `SobjectType`/`Field` and `PermissionsRead` only — no `ParentId`, which is exactly the axis a matrix needs — and fold it away with an existential OR. Four constraints the design must answer: (1) those two are the only unbounded queries in the audit runner, and `org-query.js` buffers `sf` stdout through `JSON.parse` with no `maxBuffer` override, so a real `FieldPermissions` scan (100k–1M+ rows) needs chunking by object; (2) `src/lib/org-diff.js` is a set-membership diff and cannot express `changed`, the only verdict a permissions diff cares about — it needs a sibling, not an extension; (3) **muting permission sets are not a queryable SObject** — Metadata API only, zero groundwork here — so v1 should scope them out explicitly rather than silently; (4) `describeFinding` in flow-core is a shape-sniffing if-chain that would render a matrix finding carrying `username` as an inactive-user line. The differentiated version is permissions as a **CI gate** — diff org permissions against what is in source and fail a deploy on drift, which a hosted product structurally cannot do — **Research**
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
