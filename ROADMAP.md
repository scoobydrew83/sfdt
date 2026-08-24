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

**Active phase: "Trustworthy writes"** (opened 2026-08-22). The 1.0 stabilization phase passed its verdict on 2026-08-12 (`.harness/telemetry.jsonl`), and what 1.0 itself now requires is written down in [docs/versioning.md](docs/versioning.md) rather than left implicit. This phase's theme: every remaining item on the competitive backlog is a *write* feature. The transport underneath them has already been made trustworthy (workstream A, shipped in extension v0.13.0) — so the phase is about spending that guarantee, not building it.

Two competitor reviews feed this section. The sf-pi integration review (2026-07-29) is cited as `docs/reviews/sf-pi-integration-review.md` but that file is **not present in this repo** — its three sequenced items (`sfdt apex`, `sfdt soql`, ApexGuru) all shipped in v0.22.0 regardless. The [SFDevTools competitive analysis](docs/reviews/sfdevtools-competitive-analysis.md) (2026-08-22) sources the rest.

Everything here re-implements capabilities natively — no dependency on the reviewed product, no code copied.

**FEATURES.json seeding for this phase is a separate, `develop`-direct commit.** `tools/check-features-edits.mjs` diffs the fork point against the working tree, so *any* branch that adds an entry fails `check:features` — and therefore `check:all-contracts` and CI. Only on the integration branch is the fork point HEAD and the diff empty. (The checker's own remediation text says to "land it in its own commit so the diff carries nothing else", which does not actually satisfy the rule from a branch; worth reconciling the text with the behaviour.)

### Workstream A — the write transport (extension) — **already done**

Both defects were fixed on `develop` before this phase was written; the competitive review that named them read `main`, which lags. Verified 2026-08-22 on `develop`:

- **Write timeout** — `SEND_MESSAGE_TIMEOUT_MS` is gone. `extension/lib/salesforce-api.ts` now splits the budget: `READ_MESSAGE_TIMEOUT_MS = 30_000` and `WRITE_MESSAGE_TIMEOUT_MS = 120_000` (the platform's own ceiling for the longest synchronous operation these paths trigger), with SOAP split per call site so a polled `checkDeployStatus` cannot inherit the write framing. A bus timeout now *rejects* with `WORKER_TIMEOUT_ERROR_NAME` rather than resolving `null`, and every error carries an `sfdtKind` discriminant — `'timeout'` (outcome UNKNOWN, may have committed) vs `'no-session'` (definitely did not run) vs `'http-error'`. That is exactly the guarantee the record-edit design doc asked for — **Shipped (stable)**
- **`enabledByDefault` authoritative** — `feature-registry.ts:130` calls `registerFeatureDefault(feature.manifest.id, feature.manifest.enabledByDefault)` and `settings.ts` resolves through it, so a manifest declaring `false` is genuinely off — **Shipped (stable)**

### Workstream B — Bulk API v2 data loading (CLI) — the open feature

- **Bulk API v2 data loading** — **shipped as `sfdt data load`.** Was `sf data tree` only: no bulk path, no CSV field mapping, no upsert-by-external-ID. `sf data delete bulk` is already wired (`src/lib/data-runner.js:127-153`) and the partial-success result shape bulk needs is already designed, so this is additive: widen `makeAction`'s signature to carry options, extend the data-set spec to discriminate tree-style from bulk-style, and add `buildImportBulkArgs`/`buildUpsertBulkArgs` beside the existing pure `buildExportArgs`. No new dependencies. The largest single capability gap a working Salesforce team would notice — **In develop**

### Workstream C — record edit / clone / delete (Chrome) — **complete**

Design approved 2026-08-22; [docs/design/record-edit-clone.md](docs/design/record-edit-clone.md) holds the four-PR chain. Its two external prerequisites are workstream A above, both now merged, so the chain is unblocked.

- **PR-1 — editability model + typed API errors** — `extension/lib/record-edit.ts`, DOM-free and I/O-free: `EDITABLE_TYPES`, `classifyFieldEditability()`, `formatForInput()`/`coerceForWire()`, `buildDirtyDiff()` and `mapSaveErrors()`. `buildDirtyDiff()` replaces the two independent `!==` loops `inspect-record` runs today with one computation. Shipped as a tested contract, deliberately unconsumed — **Shipped (stable)** (PR #307)
- **PR-2 — edit mode in `inspect-record`** — per-type editors from `record-edit.ts`, read-only fields carrying their reason, one dirty diff for both the save bar and the PATCH body, the three-state save outcome (saved / no changes were saved / outcome unknown) branched on `sfApiErrorKind`, a post-success re-GET, server field errors on the exact field, and an unsaved-changes guard on Escape and the backdrop. Also retires this file's private describe types for the shared `DescribeCache` — **In develop**
- **PR-3 — clone** — a staged create form prefilled from `createable` fields, creating nothing until Create is pressed; new `buildCreateBody` in `record-edit.ts` as a sibling of `buildDirtyDiff`; failures reuse PR-2's error mapping — **In develop**
- **PR-4 — delete** behind its own feature id `record-delete`, so it is independently remotely-killable (a sub-flag inside `inspect-record` cannot be, per the design doc's recorded decision). Ships **off** (`enabledByDefault: false`), the Delete control is not built at all when the gate is closed (absent, not hidden), confirmation requires typing the object's API name, and a timed-out delete reports `unknown` — **In develop**

### Also in this phase

- **Setup Audit Trail anomaly layer** — severity classification (critical vs elevated), per-user velocity against each user's own baseline from a split lookback window, a `fail` status so it gates CI and clears the notifier threshold, honest truncation reporting, and a scheduled `audit all` step in all four generated monitor CI templates — **In develop**
- **`sfdt record get|edit|clone`** — single-record read/write on the CLI, MCP and VS Code, with the editability model promoted to `@sfdt/flow-core` so the terminal, an agent and the browser refuse the same field for the same reason. A timed-out write reports `unknown`, never `saved` — **In develop**
- **`sfdt field impact|usage`** — field usage and impact on the CLI, MCP and VS Code, from one model shared with the Chrome panel. `impact` answers "what writes this field?" (flows parsed rather than merely referenced, workflow field updates, an Apex text search) and lists everything that merely *references* it — validation rules, layouts, reports, email templates — in a **separate** section, because "what writes this" and "where does this appear" are different questions. `usage` sweeps a whole object, batching the dependency lookup so N fields cost `ceil(N/200)` queries, and reports three states (referenced / unreferenced / **unknown**) rather than two. `--population` counts data, and only then can a field be called safe to remove. `--offline` runs the same sweep against the repo with no org — where layouts, profiles and permission sets count as *structural* and do not mark a field used — with `--fail-on-unreferenced` as a CI gate — **In develop**
- **`sfdt events list|tail|publish`** — Platform Events and CDC, with the CometD/Bayeux client promoted from the extension's background worker to `@sfdt/flow-core` rather than reimplemented. `--replay all` replays the retention window; `publish` + `tail --expect` is a publish-then-assert integration test that runs in CI. **`tail` is the one command in this CLI that holds a session token in memory** — `sf` cannot proxy a long-poll — read at point of use, never persisted; see [SECURITY.md](SECURITY.md) — **In develop**
- **`sfdt packages list|compare|note`** — installed package inventory via Tooling
  `InstalledSubscriberPackage`, annotations in a committed `.sfdt/packages.json`, and cross-org
  version drift with `--fail-on-drift`. There is no API for the latest available version of a
  managed package, so update status is derived from human-recorded versions and says so; the
  answerable version of the question is the cross-org comparison — **In develop**
- **`sfdt permissions matrix|drift`** — object and field access by profile, permission set and
  user, plus a repo-vs-org drift gate. Reports what is **granted**, never "effective", because
  muting permission sets cannot be queried and would make any stronger claim an upper bound
  presented as a fact — **In develop**
- **`sfdt automation list|enable|disable`, `sfdt permissions grant|revoke|fix`, `sfdt ledger`** —
  the first commands that change org *configuration*, and the append-only, hash-chained record
  that makes them reversible. One grid over five automation types replaces three read-only
  `audit inactive-*` checks that select no `Id` and so can report a problem but never fix one.
  The grid states which types cost a **metadata deploy** rather than a record write — workflow
  rules and Apex triggers — because a production deploy runs tests, and that is the cost a single
  toggle button hides. `permissions fix <Object>` is the bulk fix, applying exactly the
  `missing-in-org` rows `permissions drift` finds, with the repository as the intended state.
  Four brakes: `--dry-run`, a production guard that now blocks and fails safe, a confirmation that
  refuses rather than auto-confirms when non-interactive, and the ledger. **No write here has been
  executed against a live org** — see the changelog entry, which names each unproven claim —
  **In develop**

  *Correction:* this file previously said `sfdt permissions` "is read-only and stays that way
  until the approval ledger below exists". That is no longer true and is recorded here rather
  than quietly deleted. The ledger that was built is a **record**, not a gate: writes apply
  immediately and the before-state makes them reversible afterwards, which is when a wrong
  permission change is actually discovered. A staged approve-then-apply queue remains unbuilt and
  stays in Research.

- **Fix the two known flaky tests** — `test/lib/bridge-routes-extra.test.js` and `test/lib/gui-server-routes3.test.js` fail roughly 1 run in 8 under full-suite load (RELEASING.md §"Known flakes"). They already forced `npm test` out of `prepublishOnly`, and they can red the hard CI gate at random. Fixing them is a 1.0 requirement — **Planned**

### Not in this phase

- **Visual manifest builder** — this was listed here as Planned while [docs/design/visual-manifest-builder.md](docs/design/visual-manifest-builder.md) records it as **SHIPPED — all four PRs landed**. The design doc is correct; the entry was stale and is removed.
- **Effective FLS/OLS permission matrix** and **cross-org permissions diff** — a previous revision of this file described them as extending an engine we already own. That was wrong, and it was corrected here to Research. Both then shipped in this phase instead, as `sfdt permissions` (see "Also in this phase") — with the word "effective" deliberately not used, because muting permission sets remain unqueryable.

## Research

Directional, not sequenced. From the [SFDevTools competitive analysis](docs/reviews/sfdevtools-competitive-analysis.md) (2026-08-22), tiers 2–3.

- **Muting permission sets** — the one blind spot in `sfdt permissions`. They are Metadata-API
  only, with no queryable sObject, so granted access is an upper bound on real access. Closing
  this needs a Metadata API retrieve path the CLI does not have; until then every result says so
  and nothing is described as "effective" — **Research**
- **Approval ledger as a *gate*** — the shipped ledger (see "Also in this phase") is a **record**:
  writes apply immediately and the recorded before-state makes them reversible. A staged
  approve-then-apply workflow — where a change waits in a queue for a second person — is a
  different feature and is not built. Whether it is worth building on top of a ledger that already
  reverses is an open question, not a commitment — **Research**
- **Committed dashboard specs** — AI-authored dashboard definitions that live in the repo, are code-reviewed, and render in the GUI over `src/lib/soql-runner.js`. Deliberately not a hosted dashboard product; the spec shape is close to Studio's `ComponentSpec`, so one substrate could serve both — **Research**


- **AI cost transparency and model tiering** — surface real token counts per turn (and zero for a local model), plus per-command model hints over `ai.provider`/`ai.model`. Our BYOK position makes this a strength, not a meter — **Research**
- **Named agent presets as shareable objects** — packaging over the existing prompt library (`src/lib/prompts.js`) and skills pack (`sfdt skills export`) — **Research**
- **Automatic production-org detection with propagated colour** — extend `sfdt.orgColor` from VS Code to the GUI and Chrome, with irreversible-action warnings — **Research**
- **Studio handoff: `sfdt deploy --validate` on a Studio export** — Studio never touches an org (no OAuth, no `sf` shell-out); sfdt already has org auth. The handoff turns a ZIP into a component validated against a real org. Tracked here because the CLI side is the small half — **Research**

## Blocked

## Feedback

Feature ideas welcome — please open an issue in the repository.
