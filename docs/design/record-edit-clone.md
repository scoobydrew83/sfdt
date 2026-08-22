# Mini-plan: Record Edit / Clone / Delete in inspect-record (Chrome)

**Date:** 2026-07-30 · **Status:** **APPROVED 2026-08-22** — scheduled into the "Trustworthy
writes" phase. Build the PR chain as written below. PR-1 still cannot start until both
[External prerequisites](#external-prerequisites) merge; those two are workstream A of the
same phase, so the dependency is scheduled rather than open-ended.
**Satisfies:** Chrome Extension Execution Plan item **P4-1** (Record edit / clone in
inspect-record), an "**L** — mini-plan first" item and one of the plan's six named human
checkpoints. Depends on P0-4 (worker-proxied API), which is merged.
**Precedent:** structure and altitude follow `docs/design/visual-manifest-builder.md`
(the approved P5-4 mini-plan).

## Problem

`extension/features/inspect-record.ts` already ships a *rudimentary* edit path — and that is
the real starting position, not a blank page. Today it has:

- one editor for every non-boolean field: a plain `<input type="text">`
  (`inspect-record.ts:319`), so dates, picklists, numbers and lookups are all free text;
- **two independent dirty-diff implementations** that can disagree — the save-bar visibility
  loop (`:399`) and the PATCH-body loop (`:520`), both comparing with raw `!==`;
- an optimistic post-save assumption, `originalRecordData = { ...editedRecordData }`
  (`:540`), which never re-reads the record, so formula fields, roll-ups, audit fields and
  trigger-mutated values silently go stale in the UI;
- error handling that shows one toast (`:544`) — the server tells us *which field* failed,
  and we throw that away;
- no clone, no delete.

One infrastructure defect sits inside this item's scope, because it exists only to serve
AC-1 and has no value independent of it:

- **Field-level errors are destroyed before a feature can see them.**
  `salesforce-api.ts:72` `buildRequestError()` collapses the Salesforce error body
  (`[{message, errorCode, fields:[…]}]`) into a single human string via
  `extractErrorDetail()` (`:50`). `fields` and `errorCode` are dropped. AC-1 ("server field
  errors render on the exact field") is *not implementable* without changing this. Nothing
  else in the tree reads those attributes or wants to, so fixing it is P4-1's job rather
  than a standalone concern — see [External prerequisites](#external-prerequisites) for the
  two defects that went the other way.

## External prerequisites

Two further defects surfaced while writing this plan. Both were ruled out of P4-1's own PR
chain on 2026-07-30 and dispatched as standalone work, because both are live risk on already
shipped features and neither depends on whether P4-1 is ever approved. **P4-1 consumes them;
it does not contain them.**

| Branch | Defect | Guarantee P4-1 relies on |
|---|---|---|
| `ext/fix-write-timeout` | `salesforce-api.ts:16` sets `SEND_MESSAGE_TIMEOUT_MS = 5000` and `apiRequest()` (`:221`) calls `sendMessage()` with **no timeout argument**, so it inherits the default. A PATCH still in flight at 5 s resolves `null` and throws `No Salesforce session available` — wrong, and for a write dangerous: the save may well have committed. Already live on `data-import`, `field-creator`, `apex-anonymous`. | Writes are not capped at 5 s, **and** a transport failure (timeout, status 0) is distinguishable at the call site from a server rejection. |
| `ext/enabled-by-default-authoritative` | `feature-registry.ts:15` declares `enabledByDefault` and it is emitted into `lib/feature-manifests.json`, but `isFeatureEnabled()` (`settings.ts:107`) returns `true` for any id with no stored entry — the flag is never consulted, so a new feature id is **on** by default. | The runtime reads `manifest.enabledByDefault ?? true`, so a manifest declaring `false` is genuinely off until the user opts in. |

**Sequencing consequence: P4-1's PR-1 must rebase onto both once they merge, and cannot start
until they do.** The rebase is not cosmetic in either case — see PR-1 and PR-4 below for what
each changes about the work.

## Decisions (2026-07-30, recorded — these are settled, not open questions)

1. **Delete gets its own feature id, `record-delete`, not a sub-flag.** AC-4 requires it be
   "kill-switchable independently". The remote kill switch is a list of *feature ids*
   (`content.ts:233` → `gate.disabledRemote`, fed by `bridge.getServerInfo().disabledFeatures`)
   and nothing else; a boolean inside `featureSettings['inspect-record']` is local-only and
   **cannot be remotely killed**. A sub-flag therefore fails the AC outright. `record-delete`
   is a *capability* feature — a metadata-only manifest with no injected UI of its own,
   exactly the shape `context-menu-inspect.ts` already proves (`:85`
   `isInspectMenuEnabled(settings, disabledRemote)` is the pure-gate template). It stays out
   of the ⚡ menu and the command palette for free, because both filter feature candidates
   through `FEATURE_ICONS` and we add no icon entry.
2. **`record-delete` is default-off by simply declaring it.** Once
   `ext/enabled-by-default-authoritative` lands, the manifest flag is authoritative: the
   feature declares `enabledByDefault: false` and is genuinely off until the user opts in.
   P4-1 adds **no** settings-layer machinery of its own for this. *Considered and rejected:*
   a `DEFAULT_OFF_FEATURE_IDS` set in `settings.ts` keeping `isFeatureEnabled`'s signature
   intact, on the theory that threading a manifest through ~14 call sites was too much blast
   radius for one feature. Measurement killed it — all 44 entries in
   `generated/chrome-features.json` are `enabledByDefault: true` and nothing in `extension/`
   declares `false`, so honoring the flag is behavior-preserving for every existing feature.
   With the blast radius at zero, a second parallel source of truth for the same question was
   never worth having.
3. **A single PATCH is atomic, and the UI says so in exactly three states.** See
   [Partial-success semantics](#partial-success-semantics). The short version: success →
   "Saved N fields", and we **re-GET the record** rather than trusting our own echo; a server
   *response* that is an error → "**No changes were saved**" with the dirty state preserved;
   a *transport* failure with no response (timeout, status 0) → "**Save outcome unknown**"
   with a forced re-read. The third state is the honest answer to the AC's
   "no partial-success ambiguity", and it is the one the current code gets wrong.
4. **Editable types are chosen by a rule, not a taste list.** A field is editable in v1 iff
   the DOM offers a **native, lossless control** for it and the wire format is unambiguous.
   See [Per-type editor scope](#per-type-editor-scope). Everything else renders read-only
   **with a stated reason**, never dropped.
5. **Dependent picklists are not filtered client-side in v1.** `validFor` is a base64
   bitmap; decoding it is its own correctness surface. We render the full value set, mark
   dependent fields with a hint, and let the server reject invalid combinations — which
   lands as a field-level error on the exact field, because decision 3 makes that work.
6. **Clone stages a create form; it does not insert on click.** AC-3 says "Clone creates a
   record with createable fields prefilled". A one-click insert on a record with unique
   constraints or required lookups mostly fails, and a click that silently mints a duplicate
   record is the class of unguarded write this project does not ship. Clone prefills an
   editable form from `createable` fields; the user presses **Create**.
7. **No new permission is required, and none is added.** Edit, clone and delete are REST
   calls to the org the user is already on, through the existing `sfApiFetch` worker proxy.
   No new host pattern, no new API surface, no clipboard permission (the existing
   `navigator.clipboard` use needs none inside a user gesture). **The Permission Changes
   ledger is untouched.** If any PR in this plan finds itself reaching for a permission, that
   is a stop-and-escalate event under the ledger's hard rule — not a quiet addition.
8. **The typed confirm phrase is the object's API name** (e.g. `Account`, `Invoice__c`),
   matching the Notion scope text "typed-object-name confirm". P4-2's bulk delete uses a
   different phrase (`DELETE <n> <Object>`) because it is a different blast radius; the two
   are deliberately not unified.
9. **Esc and backdrop no longer discard unsaved edits.** `CONVENTIONS.md` checklist item 2
   says a surface holding unsaved user input must not click-outside-dismiss. Once the
   inspector holds real per-type edits, closing it with a dirty diff must prompt.

## Architecture

One pure model, one feature file, one capability id. No new subsystem.

```
   ┌──────────────────────────────────────────────────────────┐
   │  lib/record-edit.ts  (new, pure, zero DOM)               │
   │    classifyFieldEditability()  EDITABLE_TYPES            │
   │    buildDirtyDiff()   formatForInput() / coerceForWire() │
   │    mapSaveErrors()                                       │
   └───────────────┬──────────────────────────┬───────────────┘
                   │                          │
   ┌───────────────┴──────────────┐   ┌───────┴───────────────┐
   │ features/inspect-record.ts   │   │ lib/salesforce-api.ts │
   │   edit mode · clone form     │   │  SalesforceRestError  │
   │   delete (gated)             │   │  (carries fields[] +  │
   └───────────────┬──────────────┘   │   errorCode)          │
                   │                  │  write-safe timeouts  │
   ┌───────────────┴──────────────┐   └───────────────────────┘
   │ features/record-delete.ts    │
   │  capability manifest only —  │      describe data comes from the
   │  options toggle + kill-switch│      existing shared cache; no
   │  id, no injected UI          │      second describe layer is added
   └──────────────────────────────┘
```

<a id="partial-success-semantics"></a>
### Partial-success semantics

A single `PATCH /sobjects/{Type}/{Id}` is **one DML transaction**. Salesforce either commits
every field in the body or rolls the whole thing back, including any trigger DML in the same
transaction. There is no per-field partial apply to report. The UI therefore claims exactly
one of three things, and never anything in between:

| Outcome | What we observed | What the UI says | State afterwards |
|---|---|---|---|
| **Saved** | HTTP 204 | "Saved N field(s)" toast | **Re-GET the record**, rebuild original + edited from the response |
| **Rejected** | HTTP 4xx with a parsed error body | "**No changes were saved.**" + per-field errors + form banner | Dirty edits preserved verbatim so the user can fix and retry |
| **Unknown** | no HTTP response — bus timeout, status 0, network error | "**Save outcome unknown — the record has been reloaded.**" | Forced re-GET; save bar recomputed against whatever the server now holds |

The "Rejected" claim is only truthful because the response *arrived*. That is why the third
row exists — and why this contract is unimplementable until `ext/fix-write-timeout` merges.
Against today's `develop` a slow-but-successful PATCH lands in the "Rejected" wording via a
bogus `No Salesforce session available`, telling the user nothing was saved when it was. The
prerequisite supplies both halves P4-1 needs: writes that are not capped at 5 s, and a
transport failure that is distinguishable from a server rejection at the call site. **If that
PR delivers only the timeout bump and not the distinguishability, PR-2 must add the narrow
distinguishing piece itself** — the three-state contract is not negotiable, only where the
plumbing for it lives.

Documented caveat (AC-1 asks us to document the behaviour): a rollback does **not** unpublish
platform events published with *Publish Immediately*, and does not un-enqueue jobs from a
transaction that succeeded. Neither is a partial *record* save; both are noted in the docs-site
page so the claim "no changes were saved" is precise rather than merely reassuring.

<a id="per-type-editor-scope"></a>
### Per-type editor scope

The rule from decision 4, applied:

**Editable in v1** — native control, unambiguous wire format:

| describe `type` | Control | Notes |
|---|---|---|
| `boolean` | `<input type=checkbox>` | already present; moves to the shared model |
| `string`, `textarea` | text input / textarea | plain text only; `htmlFormatted` excluded below |
| `email`, `phone`, `url` | text input with `type` hint | **no** client-side format validation — the server is authoritative |
| `int`, `double`, `long`, `currency`, `percent` | `<input type=number>` | `step` from describe `scale`; empty → `null` |
| `date` | `<input type=date>` | **date-only, never timezone-converted** (the off-by-one-day bug class) |
| `datetime` | `<input type=datetime-local>` | read: UTC → browser local; write: local → ISO-8601 UTC. Labelled "(local time)" |
| `time` | `<input type=time>` | |
| `picklist` | `<select>` from describe `picklistValues` | unrestricted picklists get an "Other…" free-text escape |
| `multipicklist` | `<select multiple>` | `;`-joined on the wire |
| `reference` | text input accepting a pasted 15/18-char Id | shape-validated with the existing `isRecordId()`; `referenceTo` shown as a hint; current value stays click-to-inspect |

`multipicklist` and `time` are a superset of the types the AC enumerates. They are in scope
because the rule puts them there — a principle that never changes an answer is not a
principle. This is called out so the reviewer knows it is deliberate, not drift.

**Read-only in v1, each with a visible reason:**

| Excluded | Reason shown to the user |
|---|---|
| `richtext` / `htmlFormatted` textareas | needs sanitised HTML editing; the Global DoD's zero-`innerHTML` rule makes a rich-text editor a design problem of its own, not a field editor |
| compound `address` / `location` (geolocation) | the compound parent is not writable the way its components are — **the components stay individually editable through their own rows** when `updateable`, which is the correct Salesforce semantic |
| compound name (`Name` on Person-like objects) | same: components (`FirstName`, `LastName`) edit normally |
| `encryptedstring` | the value we read is masked; writing masked text back would corrupt data |
| `base64` / blob | no meaningful inline control |
| `combobox`, `anytype`, `json` | ambiguous wire format |
| `calculated` (formula) and roll-up summaries | derived server-side; describe already reports `updateable: false` |
| `autoNumber`, `id`, audit/system fields | not writable at all |

### Field filtering (AC-2)

`classifyFieldEditability(field)` is a pure function returning a discriminated result, and it
is the *only* place the question is answered. Every field the describe returns is still
rendered in the table — **nothing is filtered out of the view, only out of the payload**:

- `calculated: true` → `formula`
- `autoNumber: true` → `auto-number`
- name in the system/audit set (`Id`, `CreatedById`, `CreatedDate`, `LastModifiedById`,
  `LastModifiedDate`, `SystemModstamp`, `IsDeleted`, `LastViewedDate`, `LastReferencedDate`)
  **and** `!createable && !updateable` → `system`
- type not in the editable set → `unsupported-type` (wording names the type)
- `updateable: false` with none of the above → `no-permission`, worded as
  "not editable for you (field-level security or object permissions)"

That last wording is deliberately non-committal: describe is evaluated per user, so a field
the running user simply cannot edit is indistinguishable from one nobody can edit. We do not
assert a cause we cannot verify. Read-only rows carry the reason as a chip plus
`aria-describedby`, satisfying "visibly read-only, never silently dropped".

For **clone**, the same function is asked the createable question instead: fields with
`createable: true` are prefilled and editable; the rest render greyed with their reason and
are excluded from the POST body.

### Error mapping (AC-1)

1. `salesforce-api.ts` gains `SalesforceRestError extends Error` carrying
   `details: { message, errorCode, fields: string[] }[]` parsed from the response body, plus
   `status`. `buildRequestError()` keeps producing the same short `.message` (every existing
   caller reads only that), so this is additive and no call site changes.
2. `mapSaveErrors(details, renderedFieldNames)` splits them:
   - non-empty `fields` **and** the field is rendered → inline error under that field's value
     cell, red row treatment, `aria-describedby` wired to the message;
   - non-empty `fields` but the field is **not** rendered (filtered out, hidden by the
     show-nulls toggle, or absent from the editable set entirely) → form-level banner that
     **names the field explicitly**, e.g. "Foo__c: Value too long";
   - empty `fields` (object-level validation rules, `UNABLE_TO_LOCK_ROW`,
     `ENTITY_IS_DELETED`, `INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY`, trigger
     `addError()` on the record) → form-level banner with the `errorCode`.
3. On any save failure the UI **clears the field filter and forces show-nulls on**, then
   scrolls to the first errored row. Otherwise an error can land on a field the user's
   current filter is hiding — which is precisely the silent-failure this AC exists to prevent.

## Work plan (one PR per item, per repo convention)

Dependency order is strict: `ext/fix-write-timeout` + `ext/enabled-by-default-authoritative`
(external, both must merge first) → PR-1 → PR-2 → {PR-3, PR-4}. PR-3 and PR-4 are independent
of each other. Four PRs, unchanged in count: removing the two prerequisites thinned PR-1 and
PR-4 but emptied neither. Branch names follow the plan: `ext/p4-1-<slug>`.

### PR-1 — Editability model + typed API errors (no user-visible change)

- **New** `extension/lib/record-edit.ts`, pure and DOM-free: `EDITABLE_TYPES`,
  `classifyFieldEditability()`, `formatForInput()` / `coerceForWire()` per type,
  `buildDirtyDiff(describe, original, edited)` and `mapSaveErrors()`.
  `buildDirtyDiff` returns `{ patchBody, changedFieldNames }` and becomes the **single**
  source of truth for both the save bar and the PATCH body, replacing the two loops at
  `inspect-record.ts:399` and `:520`. It normalises before comparing (number vs numeric
  string, `''` → `null`, boolean coercion, datetime to ISO UTC), only considers fields
  classified editable, and **omits fields absent from the original GET payload** — an
  FLS-hidden field arrives as `undefined` and must never enter a PATCH body.
- `extension/lib/salesforce-api.ts`: add `SalesforceRestError` (above) — and **only** that.
  The write-timeout work that an earlier draft of this plan put here now arrives from
  `ext/fix-write-timeout`; PR-1 rebases onto it and asserts the guarantee rather than
  implementing it. The error-body fix stays because it is the one piece of API-layer work
  that serves nothing but AC-1's per-field rendering.
- `extension/lib/describe-cache.ts`: declare the additive describe attributes the model reads
  (`updateable`, `createable`, `nillable`, `autoNumber`, `htmlFormatted`, `encrypted`,
  `restrictedPicklist`, `dependentPicklist`, `controllerName`) on `FieldDescribe`. The cache
  already passes the payload through wholesale (`describe-cache.ts:12`) — this is types only,
  and it is how inspect-record stops keeping its own private `FieldDescribe` interface.
- Vitest: diff builder, per-type coercion round-trips, classification table, and error mapping
  (including the not-rendered-field and no-field cases).
- **Scope boundary:** touches no feature file. Ships as an unused-but-tested model, the same
  contract-first shape as the manifest-builder plan's PR-3. Does **not** touch the write
  timeout or the settings layer — both belong to the external prerequisites.

### PR-2 — Edit mode in inspect-record (AC-1, AC-2, part of AC-5)

- Replace the single text editor with per-type editors driven by PR-1's model; read-only rows
  gain the reason chip.
- Save = one PATCH built by `buildDirtyDiff`, with the three-state outcome contract, the
  post-success re-GET (retiring the optimistic `:540` line), inline field errors and the form
  banner.
- Unsaved-changes guard on Esc and backdrop close (decision 9). While here, move the Esc
  handler to capture phase — `CONVENTIONS.md` item 1 names `inspect-record.ts` as a known
  bubble-phase offender, and this PR rewrites that handler anyway.
- Vitest: per-type editor render + change, save-success re-GET, save-rejected preservation,
  save-unknown reload, error rendering on the exact field, dirty guard.
- **Scope boundary:** no clone, no delete, no new feature id. The `inspect-record` toggle and
  kill switch already gate everything in this PR.

### PR-3 — Clone (AC-3)

- "Clone" action in the inspector header → staged create form (decision 6) prefilled from
  `createable` fields, reusing PR-2's editor widgets and PR-1's classification.
- POST to `/sobjects/{Type}`; on success a result row shows the new Id with **Open in
  Salesforce** (`/lightning/r/{Type}/{Id}/view`) and **Inspect** (loads it into the current
  inspector). Failures use the same error mapping as PR-2.
- Vitest: createable filtering (system/auto-number/non-createable excluded from the body but
  still rendered), prefill fidelity, result rendering, error mapping on create.
- **Scope boundary:** clone of a single record only. No deep/related-record clone, no
  cross-object clone.

### PR-4 — Delete behind opt-in + independent kill switch (AC-4)

- **New** `extension/features/record-delete.ts`: capability manifest only
  (`id: 'record-delete'`, `enabledByDefault: false`, contexts matching inspect-record) plus a
  pure `isRecordDeleteEnabled(settings, disabledRemote)` gate, modeled line-for-line on
  `context-menu-inspect.ts:85`. No injected UI, no icon entry — so it never appears in the ⚡
  menu or the palette. **`enabledByDefault: false` is the entire opt-in mechanism** — no
  settings-layer change, because `ext/enabled-by-default-authoritative` has already made the
  flag authoritative. Rebase consequence: that PR threads the enabled-check call sites, so
  `context-menu-inspect.ts`'s gate — the template being copied here — will itself have moved.
  Copy the post-rebase shape, not the one this document quotes.
- **New** `extension/ui/confirm-dialog.ts`: `confirmTyped({ phrase, … })`, extracted from the
  best existing implementation (`flow-version-manager.ts:104`/`:136`) and made a11y-complete
  per the P0-8 checklist. **It migrates exactly one caller — flow-version-manager — to prove
  reuse.** `debug-log-viewer.ts:88`'s count-confirm and `rest-explore.ts:275`'s click-twice
  are deliberately left alone; consolidating all three is P6-3/tech-debt work, not this item's.
- inspect-record shows the Delete action only when the gate passes; typed confirm with the
  object API name; DELETE call; success and failure toasts; on success the inspector clears to
  the empty state (the record no longer exists).
- Registry/catalog lockstep: register the feature, regenerate `lib/feature-manifests.json`
  (`SFDT_WRITE_MANIFESTS=1`) and `npm run generate:catalogs`, update options-page copy,
  `extension/CHANGELOG.md`, `PRIVACY.md` (no permission change — an explicit "delete is
  opt-in, default off" line), and the docs-site MDX.
- Vitest: the gate truth table (user toggle × kill switch × both), **default-off with no
  stored setting at all** (the assertion that proves the manifest flag is being honored),
  typed-confirm gating (wrong phrase never enables the button), and the DELETE call shape.
- **Scope boundary:** single-record delete from the inspector only. Bulk delete is P4-2 and
  gets its own opt-in and its own backup-CSV guard rail; nothing here is shared with it yet.

## Invariants this touches

- **No new permissions** (decision 7). The ledger's hard rule applies to every PR here: if
  one appears to need a permission, stop and escalate rather than add.
- **Secrets:** every call stays on the `sfApiFetch` worker proxy; no code path here sees a
  SID. PR-1's changes are inside the thin client, above the proxy boundary.
- **DOM discipline:** `createElement` + `textContent` only. This is a live constraint, not a
  formality — it is the stated reason rich text is out of scope.
- **Describe reuse:** consumes the existing shared `DescribeCache`; no second describe layer
  (the same rule P2-1 was held to). PR-1 deletes inspect-record's private `FieldDescribe`.
- **Generated artefacts:** `lib/feature-manifests.json` and `generated/*` are regenerated,
  never hand-edited; CI fails on drift.
- **Telemetry never throws**; the feature-registry gate already swallows teardown errors.
- **One feature per session:** PR-1 … PR-4 are four sessions, four PRs against `develop`.
  The two external prerequisites are their own sessions on their own branches and are not
  folded back into this chain under any schedule pressure.
- **Global DoD** applies per PR: a11y checklist item-by-item, both themes, Vitest, CHANGELOG
  under `[Unreleased]`, docs-site MDX for the user-facing PRs (2, 3, 4).

## Verification

Gates, from `extension/`, on every PR:

```
npx vitest run
npx tsc --noEmit
npx eslint .
npx wxt build
```

Manual smoke (unpacked `extension/.output/chrome-mv3` against a real org), per PR:

1. **PR-2:** edit and save on a standard object (Account) *and* a custom object. Then, in one
   sitting: (a) trip a validation rule with no field binding → form banner, dirty state
   preserved, wording is "No changes were saved"; (b) trip a field-level error on a field the
   current filter hides → filter auto-clears, error lands on that field; (c) edit a `date`
   near midnight and confirm no day shift; (d) edit a `datetime` and confirm the round trip;
   (e) confirm a formula field, an audit field and an FLS-restricted field each render
   read-only with the right reason; (f) close with unsaved edits → prompted.
2. **PR-2 (outcome-unknown path):** throttle the network so the PATCH exceeds the old 5 s
   window; the UI must show "Save outcome unknown" and reload — never "no session". This
   doubles as P4-1's acceptance check on `ext/fix-write-timeout`: if it fails here, the
   prerequisite did not deliver what the table above says it guarantees, and PR-2 stops
   rather than papering over it.
3. **PR-3:** clone a record with a required lookup and a unique field; confirm the staged form
   prefills only createable fields, that a rejected create maps errors per field, and that a
   successful create shows the new Id with working Open/Inspect links.
4. **PR-4:** on a **fresh browser profile with no stored settings at all**, Delete is absent —
   that specific starting state, not a profile where the toggle was set off by hand, is what
   proves the manifest flag is authoritative. Enable the toggle in options → Delete appears;
   the wrong phrase never enables the button; the right phrase
   deletes and toasts. Then add `record-delete` to the bridge's `disabledFeatures` and
   confirm Delete disappears **while `inspect-record` keeps working** — that single
   observation is the proof of decision 1.
