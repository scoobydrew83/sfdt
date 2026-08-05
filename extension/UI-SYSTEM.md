# UI System — status, contracts, and what's left

Working reference for the design-system consolidation started 2026-07-31.
Read this **before** touching anything in `ui/`, `lib/tokens.ts`, `lib/ui-styles.ts`,
`lib/ui-controls.ts`, `lib/icons.ts`, or adding a new surface. It records what is centralised, what
deliberately is not, and the order the remaining work should happen in.

Companion docs: `CONVENTIONS.md` (the a11y/overlay checklist reviewers apply
verbatim) and `DESIGN.md` (the Stitch design-system reference the layouts came
from). This file is the *state*; those two are the *rules*.

---

## 1. The five layers

Everything visual now resolves through one of five layers. A new surface should
consume the highest layer that fits and only drop down when it genuinely needs
to.

| Layer | File | What it owns | Consumed by |
|---|---|---|---|
| 1. Tokens | `lib/tokens.ts` | Colour, spacing, radius, type, shadow — as CSS custom properties | Everything |
| 2. Components | `lib/ui-styles.ts` | 107 reusable classes | every UI file |
| 3. Icons | `lib/icons.ts` | 53 inline SVGs + feature-id → glyph map | 8 files |
| 4. Controls | `lib/ui-controls.ts`, `lib/code-editor.ts`, `ui/panels.ts`, `ui/confirm-dialog.ts`, `ui/meter-card.ts`, `ui/node-graph.ts`, `ui/apex-limit-tiles.ts`, `ui/apex-log-console.ts` | `button()`, `field()`, `glyph()`, `setLabel()`, `setTone()`, `toolbar()`, `createCodeEditor()`, `renderSfError()`, `setSfError()`, `clearSfError()`, `loadingPanel()`, `emptyPanel()`, `busyOverlay()`, `confirmDialog()`, `meterCard()`, `buildNodeGraphSvg()`, `createLimitTiles()`, `renderApexLogBody()` | every UI file |
| 5. Behaviour | `ui/menu.ts`, `ui/shadow-host.ts`, `ui/present-view.ts` | Dismissal, **focus trap**, focus restore, mounting | Menus, injected UI, every feature view |

**Layers 2 and 4 are not the same thing, and layer 2 alone did not work.** The
component sheet had existed for a while and the extension still had **134
hand-built `<button>`s of which only 11 wore `.sfdt-btn`**. A class nobody
reaches for is not centralisation. The other 123 were
`createElement('button')` + a `style.cssText` string retyped from memory at each
site — which is why the same button existed in four sizes with three glyph
conventions (`▶ Run`, `★ Save`, `🔎 Explain`).

The fix is a **shorter path, not a stricter rule**: `button({ label, iconName })`
is less typing than the cssText line it replaces, so the correct thing is also
the lazy thing. `lib/popup.ts` had already discovered this independently and
grown a private `button()`; layer 4 is that helper promoted with the variants
other surfaces needed.

### Layer 1 — tokens (`lib/tokens.ts`, 318 lines)

```
SFDT_TOKENS        light colour palette      (SLDS-derived)
SFDT_TOKENS_DARK   dark colour palette
SFDT_SCALES        space/radius/type/layout  ← added this pass, theme-invariant
SFDT_SHADOWS       elevation, light
SFDT_SHADOWS_DARK  elevation, dark
SFDT_TOKENS_CSS    the emitted :root block
```

**Colours were already centralised before this work. Everything else was not** —
that was the actual gap. `SFDT_SCALES` now carries `--sfdt-space-1..8`,
`--sfdt-radius-*`, `--sfdt-type-*` (composite `font` shorthands), `--sfdt-font-sans`
/`-mono`, `--sfdt-tracking-caps`, and the Workspace layout constants
(`--sfdt-sidebar-w`, `--sfdt-topbar-h`).

Two rules that are easy to get wrong:

- **Scales are theme-invariant and declared exactly once.** Spacing does not
  change between light and dark. Only colours and shadows appear in all three
  blocks (`:root`, `[data-sfdt-theme="dark"]`, and the `prefers-color-scheme`
  fallback).
- **Foreground vs. fill split still applies** (`CLAUDE.md` rule 3). `-text`,
  `-on-accent`, `-strong` for text; base tokens for fills and borders. A fill
  token used as `.style.color` renders low-contrast in dark mode.

Guarded by `test/tokens.test.ts` (26 tests): no raw hex, WCAG contrast
assertions, light/dark key parity, and scale presence.

### Layer 2 — components (`lib/ui-styles.ts`)

```
.sfdt-card  .sfdt-card-head  .sfdt-tile  .sfdt-panel-head (.sfdt-panel-titles
                                          .sfdt-panel-sub .sfdt-panel-actions)
.sfdt-btn (.sfdt-primary .sfdt-ghost)  .sfdt-nav-item  .sfdt-glyph
.sfdt-pill (.sfdt-square)  .sfdt-dot  .sfdt-meter  .sfdt-table  .sfdt-caps  .sfdt-mono
.sfdt-toolbar (.sfdt-toolbar-grow -end -foot)  .sfdt-field  .sfdt-check  .sfdt-segment
```

`.sfdt-field` exists for the same reason `.sfdt-btn` sets `color` explicitly: a
native `<input>` takes colour from UA styles, not inheritance, so an
un-migrated input is light-on-light in dark mode. **Inputs are the second most
common dark-mode defect after buttons** — migrate them in the same pass.

`.sfdt-segment` keys its active state off `[aria-pressed="true"]`, so the DOM is
forced to carry the state rather than colour alone. `.sfdt-table th` is
`position: sticky` unconditionally — with no scrolling ancestor that lays out
identically to `static`, so it costs nothing and any table in a scroll box keeps
its header.

`ensureComponentStyles(doc)` injects it on own pages; `ui/shadow-host.ts` adopts
it into the closed shadow root for injected UI.

**Every selector must start with `.sfdt-`** — enforced by `test/ui-styles.test.ts`
(30 tests). This sheet lands on live Salesforce pages; a bare `button {}` rule
would restyle Salesforce itself.

**Adopted sheets vs. inherited properties — the distinction that bit us:**
CSS custom properties *inherit* across a shadow boundary, so `var(--sfdt-*)`
works inside shadow DOM for free. **Stylesheets do not.** Any rule that
*consumes* a token must be in an adopted sheet; only the block that *defines*
the tokens lives on the host document.

Nested fills use `var(--sfdt-color-bg)`, not a surface shade. That's deliberate:
`color-bg` is the page backdrop, guaranteed a full step from `color-surface` in
both themes. The `surface-shade-2` it replaced was `#f3f6f9` against a `#fff`
card — a smudge, not a plane. **This is what fixed the "white/gray blend" in
light mode, with no token values changed.**

### Layer 3 — icons (`lib/icons.ts`)

53 icons built from SVG primitives via `createElementNS` (never `innerHTML`).
`icon(name, size, doc)`, `featureIcon(id, size, doc)`, `ICON_NAMES`,
`ICON_FOR_FEATURE`. Covers all 43 `FEATURE_ICONS` ids — parity is tested, so a
new feature without a glyph fails CI.

Each `<svg>` carries `data-sfdt-icon`, so a fallback dot is distinguishable from
a real glyph in tests and in the DOM.

Emoji in `lib/feature-icons.ts` are **not** dead — the popup and some feature
interiors still use them. Icons are the upgrade path, not a completed
replacement.

### Layer 4 — controls (`lib/ui-controls.ts`)

```
button({ label?, iconName?, variant?, small?, title?, ariaLabel?, disabled?, onClick? })
field({ ariaLabel, placeholder?, type?, mono? })     glyph(name, size, doc)
setLabel(btn, text)                                  toolbar(doc, foot?)
```

Three things it enforces that a CSS class cannot:

- **`button()` throws when the result would have no accessible name.** An
  icon-only button with no `title`/`ariaLabel` is a screen-reader dead end and
  the easiest a11y defect to ship by accident — the glyph looks self-evident to
  whoever just picked it. Failing at *construction* makes it deterministic: it
  cannot render green in a test and stay silent in Chrome. The SOQL bookmark
  delete was a bare `×` with no name; the factory refused to build it.
- **`setLabel()` instead of `btn.textContent = …`.** The obvious assignment
  wipes every child, glyph included, and the button loses its icon for good.
  Almost every async action does exactly this ("Run" → "Running…" → "Run"), so
  without the setter an icon system erodes on first use.
- **A redundant `aria-label` is omitted** on a labelled button whose visible
  text already is its name — it is noise, and it drifts out of sync with the
  text beside it.

Variants map to `.sfdt-btn` modifiers: `primary`, `ghost`, `danger`, `sfdt-sm`,
`sfdt-icon` (square, icon-only), `sfdt-round` (chip). `danger` is
border-and-text, filling only on hover — a filled red button reads as the
primary action of its row, which is the opposite of what a delete should look
like.

Guarded by `test/ui-controls.test.ts` (12 tests) and a drift guard in
`test/ui-styles.test.ts`: a **migrated** file may not contain a cssText string
with `padding` + `border-radius` + `cursor: pointer` — the hand-rolled-button
signature. Files join `BUTTON_MIGRATED` in the same commit that converts them.

#### Layer 4, continued — the Salesforce error panel (`ui/panels.ts`)

```
renderSfError(error, { doc?, guidance? })   →  a new panel
setSfError(el, error, { doc?, guidance? })  →  fill a panel the caller owns
clearSfError(el)                            →  empty it, and drop role="alert"
```

The same lesson as `button()`, learned the same way. `.sfdt-console.sfdt-error`
had existed since the design-system pass and **fifteen** features still built
the block by hand, because `createElement('div')` + `classList.add(…)` +
`.textContent = err.message` was the shorter path. All fifteen omitted
`role="alert"`, so a failure was a red box to a sighted user and silence to a
screen reader; PR #308 then had to fix sixteen surfaces individually for a
*separate* defect — collapsing our guidance line into the org's own text, and in
several cases discarding the org's error entirely.

**Two further sites had no error styling at all** and neither #308 nor the
class-pair rule below could see them: `apex-anonymous`'s openLogBtn handler and
`ai-assistant`'s metadata catch each wrote a live org error as bare text, so a
failure was indistinguishable from a log body. Rule 2 of the sweep exists
because of them.

Three things these enforce that a class cannot:

- **`role="alert"` is not optional.** It comes with the block, including on
  `setSfError`, which is what a long-lived pane (the debug-log console, the
  Execute Anonymous result pane) uses when it turns into an error surface.
- **…and it comes back OFF when the panel is empty.** `clearSfError` and an
  empty `setSfError` both drop it, because an empty `role="alert"` region is a
  live announcement point for whatever lands in it next — which on a reused
  pane is the success path's own output.
- **The org's text and our guidance are separate NODES**, split by structure
  rather than by re-reading the string. `lib/sf-error-guidance.ts` composes the
  parts (`buildUserFacingParts`) and `SalesforceRestError` carries them on
  `.userFacing`; `sfErrorParts()` reads them back. Splitting the flattened
  `.message` on newlines was the obvious shortcut and it is wrong: the org's own
  message can be multi-line (an Apex compile error is), so line-two-onward is
  not reliably ours, and styling it as ours is the #308 defect inverted. Where
  no structure travelled with the error, the renderer emits ONE node and guesses
  nothing.

**Pass the error, not `err.message`.** Stringifying at the call site throws the
structure away. The three `showError()` funnels take `unknown` for this reason —
and `unknown` accepts a string, so a wrong call site compiles clean and fails
silently. There is no type that separates "our sentence" from "an error someone
already stringified", so rule 3 of the sweep is what catches it. If a surface
wants a line of its own beside the error, that is the `guidance` option, not
string concatenation.

`.sfdt-console.sfdt-error` is for the **org's** text. Our own prose — a
destructive-mode caution, a truncation warning — is `.sfdt-callout`; the comment
at that rule in `lib/ui-styles.ts` draws the line. The destructive-manifest
banner in `metadata-retrieve` was on the wrong side of it and moved.

Guarded by `test/sf-error-panel-contract.test.ts`, in three rules: **no file
outside `ui/panels.ts` may apply the class pair**, **no `.sfdt-console`
element may be handed a caught error's text directly**, and **nothing may pass
an already-stringified error to the renderer**. That is the piece the
two behavioural guards (`error-render-newlines`, `sf-error-guidance`) could not
supply — they pin what a correct panel looks like, and a fresh hand-roll can
satisfy both. Rule 1 accumulates classes **per element**, not per statement: a
first version matched one application at a time and was blind to
`add('sfdt-console')` followed by `add('sfdt-error')`, which is the shape an
author writing a reused pane produces first. Rule 2's identifier alternation is
copied verbatim from `error-render-newlines.test.ts`, `/i` and `message`/`msg`
included — a first version dropped those two spellings while citing that file
as its source, which is exactly the omission that file's own comment records
having already made once, and it left a `.sfdt-console` pane assigned from a
`const message` invisible to all three rules. Rule 3 is a backstop rather than a
proof: it reads the call site and the local bindings feeding it, so a helper in
another module that returns a string still gets through.

### Layer 5 — behaviour (`ui/menu.ts`)

`openMenu()` + `attachDismiss()`. This exists because three menus were
hand-rolled independently and each got dismissal wrong — the SOQL cell menu
leaked a `document` listener *per record Id ever clicked*, and none were
keyboard-reachable.

Contract: rows are real `<button role="menuitem">`; focus moves to the first
item; Esc closes and restores focus to the anchor; outside-click uses
`composedPath()` so it works across the shadow boundary; teardown is idempotent
and always removes **both** listeners; the menu closes *before* running the
action, so a handler that opens another overlay isn't killed by this menu's own
dismissal.

Geometry is read from `doc.defaultView` / `documentElement`, **never** from a
passed-in `win`. See §5.

`ui/present-view.ts` is the second behaviour owner: it is the shell every
feature view is presented in, modal on a Salesforce page and tab pane in the
Workspace. `presentAsModal` now owns the modal's **card, header, Esc and focus
restore**, so features stop hand-rolling them:

- The card is `.sfdt-card` with `role="dialog"`, `aria-modal`, and its
  accessible name from `aria-label` — deliberately **not** an `<h2>`, because
  features put their own `<h2>`s in the body and a heading here would outrank
  them.
- `buildViewHead()` renders glyph + title + `subtitle` + `headerActions`, and is
  shared with the Workspace sink so a view reads the same on both surfaces. In a
  pane the chip already carries the title and ×, so only subtitle and actions
  render; a view supplying neither gets no head at all.
- **Escape closes only the topmost overlay.** Stacked views (soql-runner →
  inspect-record, apex-anonymous → log-analyzer) each register a listener on the
  same document; before the topmost check, one Escape collapsed the whole stack
  and discarded the work underneath. A capture-phase handler in a feature
  defeats this check by closing before the modal below can evaluate it — that is
  why `apex-log-analyzer`'s was removed rather than left as a duplicate.

Three features still hand-roll their own Esc (`ai-assistant`, `canvas-search`,
`inspect-record`). They are redundant now, not harmful — each closes its own
view, idempotently.
Delete one when you're already in the file; a capture-phase one that opens a
nested view is the case that actually breaks.

---

## 2. Surface status

| Surface | Tokens | Components | Icons | Notes |
|---|:--:|:--:|:--:|---|
| Workspace (`ui/workspace-host.ts`) | ✅ | ✅ | ✅ | Overview home, header, activity, tab+panel variants |
| Side panel | ✅ | ✅ | ✅ | `data-sfdt-surface="panel"` — icon rail, same DOM |
| ⚡ side menu (`ui/side-button.ts`) | ✅ | ✅ | ✅ | Real buttons, `aria-haspopup`, Esc + focus |
| Toolbar popup (`lib/popup.ts`) | ✅ | ✅ | ✅ | `watchTheme` fixed; 2×2 tile grid not started |
| Options page | ✅ | ✅ | — | |
| Command palette (`ui/command-palette.ts`) | ✅ | ✅ | ✅ | |
| Feature view shell (`ui/present-view.ts`) | ✅ | ✅ | ✅ | Card, header, Esc, focus restore — shared by all 38 `presentView` sites |
| Inspect Record (`features/inspect-record.ts`) | ✅ | ✅ | ✅ | Migrated 2026-08-01; 31 → 12 `cssText`, all chrome buttons on the factory |
| SOQL runner (`features/soql-runner.ts`) | ✅ | ✅ | ✅ | Buttons + both segmented toggles migrated; on `createCodeEditor()` since 2026-08-03 (§4b) |
| Execute Anonymous (`features/apex-anonymous.ts`) | ✅ | ✅ | ✅ | Migrated 2026-08-01; 13 → 0 `cssText`, first `createCodeEditor()` consumer, inline governor-limit tiles |
| Debug Logs (`features/debug-log-viewer.ts`) | ✅ | ✅ | ✅ | Migrated 2026-08-01; 28 → 1 `cssText`, real `.sfdt-table`, in-memory filter, tinted log pane, limit strip |
| Schema Browser (`features/schema-browser.ts`) | ✅ | ✅ | ✅ | Migrated 2026-08-01; 42 → 1 `cssText`, 3-column split, flag columns, object rail, relationship graph, Generate SOQL |
| Other `features/*` interiors | ✅ | ✅ | ✅ | All 66 UI files migrated as of 2026-08-03: 0 hand-rolled buttons, 0 emoji, 0 inline styling. Confirm with `npm run audit:ui`, never from this table — see §4a |

`data-sfdt-surface="tab" | "panel"` drives the structural difference between the
Workspace tab and the docked panel from **identical DOM**. A panel is not a
narrow desktop layout — that was the wrong first attempt; media queries produced
a squeezed shell. It gets its own rail.

---

## 3. Test coverage of the system

| Suite | Tests | Guards |
|---|--:|---|
| `test/tokens.test.ts` | 26 | no raw hex, WCAG contrast, light/dark parity |
| `test/ui-styles.test.ts` | 30 | every selector `.sfdt-`-prefixed; no hand-rolled button CSS **and no non-dynamic `el.style.<prop>`** in a migrated file |
| `test/icons.test.ts` | 11 | `FEATURE_ICONS` ↔ `ICON_FOR_FEATURE` parity; no emoji in 49 guarded files |
| `test/menu.test.ts` | 13 | listener teardown, focus, Esc, shadow mount |
| `test/theme.test.ts` | 16 | every own-page surface resolves `settings.theme` |
| `test/activity-log.test.ts` | 18 | truncation cap, ring bound, never throws |
| `test/storage.test.ts` | 12 | invalidated-context degradation |
| `test/workspace-host.test.ts` | 52 | kill switches, tool order, brand-checked accessors |
| `test/present-view.test.ts` | 17 | dialog naming, header slots, Esc closes **topmost only**, focus restore |
| `test/ui-controls.test.ts` | 12 | unnamed button **throws**, glyph survives `setLabel`, variant classes |
| `test/workspace-tabs.test.ts` | 9 | subtitle/actions reach the pane; no head when neither is supplied |
| `test/code-editor.test.ts` | 13 | tokenizer is **lossless**; gutter tracks logical lines; shouted keywords |
| `test/apex-log-console.test.ts` | 9 | `pre.textContent === log` (select-all-copy keeps newlines) |
| `test/node-graph.test.ts` | 10 | layout, cycle tinting, caller-supplied `cycles` |
| `test/options-layout.test.ts` | 9 | |
| `test/page-sheet-overlap.test.ts` | 3 | own-page sheets don't restate the component sheet |
| `test/soql-runner.test.ts` | 131 | editor repaints on every programmatic edit |

The eight consolidated modules got their own suites on 2026-08-03. Each exists
*because* the code it replaced carried a bug, so each suite leads with the bug
rather than the API:

| Suite | Tests | The regression it pins |
|---|--:|---|
| `test/download.test.ts` | 8 | `revokeObjectURL` is called; the binary path preserves bytes |
| `test/history.test.ts` | 11 | routed through `lib/storage.ts` (orphaned tab); `cap: Infinity` really is uncapped |
| `test/trace-flag.test.ts` | 8 | the 24h window is measured from the back-dated start; renew moves **both** dates |
| `test/clipboard.test.ts` | 7 | a blocked write reports, and the failure message keeps its label |
| `test/panels.test.ts` | 13 | `role="alert"`/`status`; `busyOverlay` mounts in the content root, not `body` |
| `test/confirm-dialog.test.ts` | 16 | Esc cancels and never confirms; topmost-only; focus starts on the safe control |
| `test/meter-card.test.ts` | 8 | `pct` clamps; tone is a class, never an inline colour |
| `test/apex-limit-tiles.test.ts` | 14 | per-execution snapshot beats the cumulative roll-up |

Each of the five load-bearing assertions was **verified by mutation**: the fix
was reverted in the source, the suite was watched to fail, and the source
restored. A test written after the fix, never seen red, is the same vacuity trap
as a regex guard matching nothing.

**Every file-scan or regex guard must be paired with a non-vacuity test** that
proves it actually fires. This is not optional — during this work, four guards
were silently matching nothing:

- the ui-styles selector parser read the wrong capture group (`""`/`"}"`);
- a comma inside a CSS *comment* split into a fake selector;
- the header-restatement regex couldn't cross a `;` between declarations;
- the emoji and raw-hex guards flagged their own explanatory comments.

Strip comments **before** grep-style scanning (golden principle #12: a check
excludes the artifacts that define it), and verify a new guard by temporarily
reverting the fix and watching it fail.

---

## 4. What's left, in order

As of 2026-08-03 the numbered backlog is **closed**: 4b shipped, 4c was decided
against, 4d is done both halves. What remains is 4a, which is deliberately never
"finished" — it pays down as files are touched — and the sections after it are
the record of what was consolidated and why, not a queue.

The one thing genuinely outstanding is not in this list, because it is not a
code change: **an in-Chrome smoke test against a live org** before release. See
§7.

### 4a. `features/` interiors — the remaining inline `cssText` (199 sites)

Incremental by design. Do **not** attempt a sweep; migrate a file when you're
already in it for another reason. Ranked by size, as of 2026-08-03:

```
 22  soql-runner        11  field-impact        9  metadata-retrieve
 16  data-import        11  field-creator       9  inspect-record
                        11  event-monitor       8  command-palette
                                                8  trace-flags · flow-quality
                                                8  api-version-audit
```

`present-view.ts` is down to 2 (the overlay's fixed positioning and the card's
width/max-height — both single-site layout, not components). Read §4d-ter before
treating any of these as a to-do: the remaining sites are one-off layout, not
drift.

Inspect Record is the worked example of a full migration: buttons → `.sfdt-btn`,
inputs → `.sfdt-field`, table → `.sfdt-table`, filter row → `.sfdt-toolbar`,
type column → `.sfdt-pill.sfdt-square`, view toggle → `.sfdt-segment` in the
shared header. Its per-type emoji map (`getIconForType`) was deleted rather than
converted to glyphs — the type name sits in the chip and the emoji added nothing
the word didn't, at the mercy of the platform font.

**Migration order within a file:** buttons → `button()` from
`lib/ui-controls.ts`, then inputs → `field()`, then tables → `.sfdt-table`, then
containers → `.sfdt-card`. Buttons are the highest-value first move: a native
`<button>` ignores inherited `color` (UA `buttontext`), so un-migrated buttons
are the most common dark-mode defect; inputs are the second, for the same
reason.

**Never work this list from memory or from this file. Run the audit:**

```bash
npm run audit:ui              # full inventory, worst first
npm run audit:ui -- --todo    # only what's left
npm run audit:ui -- features/ # scope to a directory
```

`scripts/ui-audit.mjs` reads the migrated lists **out of the test files**, so
the report can never disagree with the guards, and a stale hand-written
checklist can never quietly claim a file is done. It is a report, not a gate —
`npx vitest run` is what fails CI.

As of 2026-08-03: **all 66 UI files done.** 0 hand-rolled buttons, 0 emoji,
0 inline styling. Batches A–E are complete; the table below is kept as the
record of how they were sequenced, not as work outstanding.

| Batch | Files | State |
|---|---|---|
| ~~**A — emoji only**~~ | `app/main`, `options/main`, `sidepanel/main`, `missing-description-flags`, `canvas-search`, `flow-list-search`, `apex-log-analyzer` | **Done.** The `⚡` in page titles became a real `bolt` glyph — `workspace-host` was already rendering one and stripping the character every caller sent, so the strip regex is gone too. |
| ~~**B — 1–2 buttons**~~ | 20 files, `flow-deploy` … `ai-assistant` | **Done.** Two of them (`show-api-names`, `ai-assistant`) had their own local `makeBtn` factory — replacing the body meant every call site inherited at once. |
| ~~**C — 3–5 buttons**~~ | `event-monitor`, `trace-flags`, `soap-explore`, `rest-explore`, `apex-anonymous`, `schema-browser` | **Done.** `trace-flags` went with Debug Logs — they are siblings and already cross-linked from each other's toolbar. |
| ~~**D — the big two**~~ | `field-creator` (was 9 btn, 10 inputs, 67 cssText, 11 emoji), `metadata-retrieve` (was 8 btn, 8 inputs, 59 cssText) | **Done.** Effectively a rebuild of each interior, which is why they went last; `debug-log-viewer` was the third of that size. |
| ~~**E — page sheets**~~ | `ui/workspace-host.ts` | **Done.** Its 3 button rules lived in its own `<style>` template, not inline — the fix was a class on the element, not a `button()` call. |

Two things worth stealing from batch B:

- **A file with a local button factory is a freebie.** Replace the factory body
  with `button()` and every call site migrates in one edit.
- **Watch for `btn.textContent = …` after construction.** `trigger-conflicts`
  set its label a few lines after building the button, which would have silently
  wiped the new glyph. `setLabel()` exists for exactly this; grep for it when
  migrating a file.

**Finishing a file means adding it to both guard lists** — `BUTTON_MIGRATED` in
`test/ui-styles.test.ts` and the emoji list in `test/icons.test.ts` — in the
same commit. That is what makes it stick, and the audit will keep reporting the
file as unfinished until you do.

A bare `<button>` is still correct inside `.sfdt-segment` (the sheet styles
`> button` directly) and for a link-styled cell action. Those are why
`soql-runner` and `inspect-record` show non-zero `createElement('button')`
counts while being fully migrated — the audit's **HAND** column, not **btn**, is
the one that measures work.

**`cssText` count is not a to-do.** Much of it is genuine one-off layout (flex
sizing, `display` toggles) that no component owns or should. Migrating it for
its own sake is how you turn a design system into a second, worse layout engine.

### 4b. SOQL editor chrome — **done 2026-08-03**

The blocker was syntax highlighting: a hand-written tokenizer or a
CodeMirror-class dependency, with bundle-size and CSP consequences. That
decision was taken on 2026-08-01 — **hand-written tokenizer, no dependency** —
and shipped as `lib/code-editor.ts` for Execute Anonymous. The SOQL runner is
its second consumer.

`editor.input` IS the textarea, so the swap touched no read site and none of the
127 runner tests: `setRangeText` for autocomplete, `selectionStart`, `.value`
and `document.querySelector('textarea')` all still work. Two things it did need:

- **Every programmatic edit needs `refresh()` or `setValue()`.** The highlight
  and gutter repaint on the textarea's `input` event, and nothing that sets
  `.value` from code fires one — a history pick, a saved query, the pending
  hand-off from Saved SOQL or the Schema Browser, and autocomplete's
  `setRangeText` all mutate it silently. Miss one and the caret sits over stale
  glyphs. `test/soql-runner.test.ts` pins the three distinct paths.
- **The keyword match had to learn about shouting.** Matching the lowercase set
  exactly is right for Apex and useless for SOQL, where `SELECT Id FROM Account`
  is the conventional spelling — every keyword uppercase, so *nothing in a query
  highlighted at all*. It now matches case-insensitively but only for a token in
  uniform case, so `FROM`/`from` are keywords while `Order` and `Group` stay
  sObjects. Apex gains the same fix for its inline SOQL and keeps `Set`, `Date`
  and `Delete` as types.

The textarea also had **no accessible name** before the swap — only a
placeholder, which disappears on the first keystroke. It now carries one, and it
follows the language toggle (`SOQL query` / `SOSL search`).

Still open from the original sample, and still worth asking about before
building: the org-context side panel (Total Records / Storage / API Remaining)
and split-pane resize.

**How it works, because the technique is load-bearing.** A real `<textarea>`
with transparent glyphs sits on top of a `<pre>` that renders the same string as
coloured spans, with a gutter beside them sharing the scroll offset. The
alternative — `contenteditable` — means re-implementing caret, selection, undo,
IME and native find. The cost is that three layers must agree on font,
line-height and vertical padding to the pixel; that agreement lives in the
`.sfdt-editor*` rules, declared once on the wrapper and inherited, and **must
not be re-declared per layer**. `wrap="off"` is not cosmetic: soft wrapping puts
one logical line on several visual rows and the gutter, which counts logical
lines, drifts further out of alignment with every wrapped line.

Highlighting is a single-pass regex tokenizer, not a parser. It is deliberately
lossless — concatenating the tokens must rebuild the input exactly, or every
glyph after the defect shifts out from under the caret. `test/code-editor.test.ts`
pins that property first.

Keyword matching is **case-sensitive against a lowercase set**, even though Apex
is case-insensitive. Matching case-insensitively paints `Set<Id>`, `Date` and
`Delete` as keywords, and those appear far more often as types.

### 4c. Popup 2×2 quick-action tile grid — **decided against, 2026-08-03**

From the second Stitch folder. Not built, and not pending: see the entry in §6.

The deciding fact is that **the popup never has four actions.** The list is
computed per render (`lib/popup.ts:254-267`) and comes to between one and three:

| Context | Actions |
|---|--:|
| Salesforce tab, Chrome | 3 — Workspace, side panel, Quick menu |
| Non-Salesforce tab, Chrome | 2 |
| Firefox (no `chrome.sidePanel`) | 1–2 |

A 2×2 whose fourth cell is always empty is a list with extra steps. Settings is
the only candidate to fill it and it is deliberately in the footer
(`popup.ts:270-276`), pinned so the action list can grow without pushing the
version off the bottom edge.

Two further reasons, either of which would stand alone:

- **The labels are verb phrases.** "Open side panel" is one line and a glyph as
  a row; in a ~150px square it wraps to three. Tiles suit short nouns.
- **The Stitch source drops `statusRow()` entirely** (`popup.ts:118`, used at
  228 and 233). It is dot + text + `role="status"`, so colour is never the sole
  signal — dropping it costs the a11y property *and* the popup's actual job:
  is my session alive, is the bridge running.

If this is ever revisited, the thing that would change the answer is a fourth
action that genuinely belongs at the top level — not a re-reading of the mockup.

### 4d. Modal migration — **both done**

`ui/present-view.ts` is folded onto `.sfdt-card` + `.sfdt-panel-head` (see §1,
layer 4). `ui/health-modal.ts` followed on 2026-08-03: 9 → 1 `cssText`, cards
onto `.sfdt-tile` in a `.sfdt-tiles` auto-fit grid, the family disclosures onto
`.sfdt-panel`, the severity badge onto `.sfdt-pill`, and the footer onto
`toolbar(doc, foot)`.

It carried a live dark-mode defect, which is the reason this kind of fold is
worth doing rather than cosmetic: `severityColour()` and `ratingColour()`
returned **fill** tokens (`--sfdt-color-error`) and the results were written to
`.style.color` — the foreground/fill inversion `CLAUDE.md` rule 3 exists to
prevent. They are `setTone()` calls now, resolving to the `-text` variants.

The one `cssText` left is the score's hero size, at `--sfdt-type-metric`. Its
`.sfdt-health-*` classes are all kept: 18 tests query them BY NAME, and they are
added with `classList.add()` for exactly the reason §4d-ter gives.

---

### 4d-ter. Where the cssText sweep stopped, and why

`cssText` went **591 → 199** across the migration. The sweep stopped when the
distribution said there was nothing left to combine:

| | start | end |
|---|---:|---:|
| sites | 591 | 199 |
| distinct shapes | — | 148 |
| shapes appearing exactly once | — | 119 |
| largest cluster | ~30 | **2** |
| carrying a computed `${…}` value | — | 13 |

The early passes converted ~30 sites per shape. What remains is ~1.3 sites per
shape — genuine one-off layout, where deciding whether `padding: 4px 12px 10px`
is drift or deliberate is a judgement a regex cannot make. Two bulk passes in
this codebase have already proved that: one deleted five identity classes by
assigning `.className` over them, and only a test querying a class BY NAME
caught it. Everything since uses `classList.add()`, which cannot clobber.

What the remaining 199 are NOT: they contain **zero** raw colour values, zero
hard-coded hex, zero fill-tokens-as-foregrounds, and zero bare form controls.
They are verbose, tokenised and correct, and they pay down when a file is next
edited. The guards stop new ones appearing.

### 4d-bis. The audit was gameable, and it got gamed

**The `cssText` column was the wrong metric and it hid real work — including
mine.** It counted `style.cssText` only, so "migrating" a file by rewriting the
same declarations as `el.style.padding = …` scored zero and reported DONE.
`schema-browser` shipped as 0 cssText / **54 discrete assignments**;
`inspect-record` and `soql-runner` the same. Three files were reported clean
that were not.

The fix is an `inl` column counting `el.style.<prop> =` for any property NOT on
a short allowlist of per-instance values (`display`, `width`, `transform`, SVG
`fill`/`stroke`, …). Everything else — padding, colour, border, font, gap,
alignment — is styling and belongs in the sheet. Two reviewed exceptions remain,
both named in `scripts/ui-audit.mjs` with their reason, and both the same shape:
read the element's CURRENT value and set it only if absent, on DOM this
extension does not own.

**The audit is still only a report.** `test/ui-styles.test.ts` now enforces the
same rule with a non-vacuity test beside it, so this cannot regress silently
again.

What the new column surfaced once it existed:

- **Five independent `BAND_COLOUR` maps** (`org-limits`, `org-health`,
  `code-coverage`, `apex-test-runner`, `org-health-live`) — invisible before,
  because each lived inside a `cssText` template string. Now one `BAND_CLASS`.
- **44 inline status-colour writes** across 15 features, several using a FILL
  token as a foreground (low-contrast in dark mode). Now `setTone(el, 'ok')`.
- **Two hand-rolled confirm dialogs** with different a11y — one trapped focus
  and wired Esc, the other had a type-to-confirm gate. `ui/confirm-dialog.ts` is
  the union, so both surfaces gained what the other had.
- **Ten hand-rolled error panels, six "Loading…" divs** → `ui/panels.ts`.
- **Two hand-rolled dropdown menus** (`rest-explore`, `soap-explore`) that each
  added a `document` click listener per open and never removed it — a listener
  leak. `ui/menu.ts`'s `attachDismiss()` was written for exactly that bug.

### 4d-quater. Logic consolidation — the part the CSS audit never saw

The `cssText` metric measured PRESENTATION. Underneath it, four pieces of
BEHAVIOUR were copied between features, and three of them carried real bugs:

| Was | Now | The bug it hid |
|---|---|---|
| `traceFlagWindow` + `traceFlagCreatePayload` in `apex-anonymous` AND `trace-flags`, byte-identical, each with its own `TRACE_FLAG_DURATION_MS` | `lib/trace-flag.ts` | A Salesforce PLATFORM constraint duplicated. Change the 24h cap and two files need editing; one gets missed. |
| 4 × capped-history ring (`HISTORY_CAP = 20`, read → dedupe → unshift → slice → write) | `lib/history.ts` | All four called `chrome.storage.local` DIRECTLY, which throws synchronously in a tab whose extension was updated underneath it. |
| 9 features reaching past `lib/storage.ts` | routed through it | Same invalidated-context gap, nine more times. |
| 20 × clipboard write, 12 with hand-written toasts | `ui/clipboard.ts` | Several had NO catch. In a blocked context the click did nothing and said nothing. |

Two things worth keeping in mind from doing it:

- **Snippets are uncapped on purpose.** `createHistory` takes
  `cap: Number.POSITIVE_INFINITY` for Execute Anonymous's saved snippets — they
  are keyed by name, and quietly capping them would delete a user's saved work.
  A shared helper with one default would have done exactly that.
- **Folding into a helper can LOSE information.** The clipboard failure message
  went from "Could not copy response" to a generic "Could not copy to
  clipboard", and a test caught it. The fix belonged in the helper — the label
  now rides on the failure message too, so on a view with several copy buttons
  you can still tell which one did nothing.

### 4d-quinquies. `.sfdt-view-body` is not for every view

19 of the 35 files that call `presentView` use the full shell
(`.sfdt-view-body` + `toolbar()` + `.sfdt-view-main`). The other 16 use
`.sfdt-view-main` alone, and that is CORRECT — not a backlog.

The distinction is whether the view has controls that must stay put while its
content scrolls. `.sfdt-view-body` exists to PIN a toolbar or a status strip; a
view whose body is only a scrolling report has nothing to pin, and wrapping it
adds a flex container that does nothing.

Applied: Org Health, Field Impact and Event Monitor got the shell because their
status/filter/search rows have to remain reachable while long output scrolls
under them. `trigger-conflicts`, `saved-soql`, `scheduled-flow-explorer`,
`org-switcher` and friends did not, because their `.sfdt-row` uses are inline
content — a legend, a heading, a list row — not a control strip.

An earlier pass of this sweep matched on "has a `.sfdt-row` near the top" and
would have wrapped all of them. That is the same mistake as mapping the
Retrieve/Deploy tabs onto `.sfdt-nav-item`: matching the SHAPE and missing what
the shape is for.

### 4f. Blob downloads — five copies, two leaks

`URL.createObjectURL` allocates a blob that is pinned until the document goes
away. Five features had their own download dance and **two never called
`revokeObjectURL`**:

- `features/data-import.ts` — a failed-row error CSV, leaked per export.
- `features/metadata-retrieve.ts` — leaked TWICE, one of them the retrieved
  metadata zip, which is routinely tens of megabytes.

All five now go through `lib/download.ts`. `triggerDownloadBlob` is separate
from `triggerDownload` rather than widening the parameter, and the guarantee is
at the TYPE level: `triggerDownload` declares `text: string`, so a byte payload
cannot reach the path that would have to stringify it on the way in — four bytes
become nine characters and the zip will not open. (`Blob` itself handles a
`BufferSource` correctly; an earlier draft of this section blamed the Blob
constructor, which `test/download.test.ts` disproves in the case beside the
one it pins.)

That is the shape of every consolidation worth doing in this codebase — the
duplicated code was not merely repetitive, it was repetitively WRONG, and the
step people drop is the one with no visible symptom.

### 4e. Shared behaviour that features kept re-implementing

Three things were hand-rolled per feature until the Schema Browser work, and all
three are now owned by the layer below. If you find a fourth copy of any of
them, delete it rather than fixing it.

| Was duplicated in | Now owned by |
|---|---|
| Esc-to-close — `schema-browser`, `field-impact`, `soql-runner`, `apex-log-analyzer` | `presentAsModal`, with a topmost-overlay guard |
| Confirm dialog — `debug-log-viewer`, `flow-version-manager` | `ui/confirm-dialog.ts` |
| Error / loading / empty blocks — 10+ features | `ui/panels.ts` |
| Dropdown menu — `rest-explore`, `soap-explore` | `ui/menu.ts` (`openMenu`) |
| Status colour — 15 features, 44 sites | `setTone()` + `.sfdt-text-*` |
| Band → colour map — 5 features | `BAND_CLASS` / `BAND_TONE` in `features/org-limits.ts` |
| Labelled meter card — 4 features | `ui/meter-card.ts` (`meterCard`, `meterGrid`) |
| Full-screen loading scrim — 3 features | `busyOverlay()` in `ui/panels.ts` |
| Modal scrim — 6 sites, drifted 0.3 vs 0.4 | `--sfdt-color-scrim` token |
| Private CSS constants — 5 in `apex-log-analyzer` | deleted; the sheet owns them |
| Box shadows — 4 raw rgba | `--sfdt-shadow-2` |
| Focus trap — `schema-browser`, `field-impact` | `presentAsModal`, same guard |
| SVG node-graph layout + render — `subflow-graph` | `ui/node-graph.ts` |

**The Esc duplication was a live bug, three times.** Each copy registered a
**capture-phase** listener on `document`, which fires before the shell's
topmost check — so an Escape aimed at a dialog opened *on top of* the view
closed the view underneath it too. `presentAsModal` listens in the bubble phase
and returns early unless its overlay is the last `.sfdt-view-overlay` in the
root. `test/present-view.test.ts` pins both the trap and the stacking rule.

**The graph extraction is the template for "is this reuse or a costume?"**
`SubflowGraphNode` was `{ id, label, outgoing, incoming }` and `SubflowGraph`
was `{ nodes, cycles, maxDepth }` — only the *names* were about Flows. So
`ui/node-graph.ts` declares `GraphNode`/`NodeGraph` with exactly that shape and
a `SubflowGraph` is structurally assignable with **no adapter, no cast, and no
change to flow-core**. Had it needed a `toGenericGraph()` shim, that would have
been the signal to write a second renderer instead. `features/subflow-graph.ts`
went 412 → 255 lines and its tests were untouched.

One thing the move *did* need: `cycles` is now caller-supplied rather than
derived, because the renderer paints cycles in the error colour and a cycle is
not always a defect. A Flow calling itself is a bug; an Account looking up to a
parent Account is Tuesday. The Schema Browser passes `[]`.

---

## 5. Traps — read before debugging any injected UI

**Never read a WebIDL accessor through a proxy.** The Workspace hands features a
synthetic `window` whose only job is to lie about `location`. `scrollY`,
`innerWidth`, and friends are accessors on `Window.prototype`; Chrome's brand
check throws `TypeError: Illegal invocation` when `this` is a Proxy. Use
`Reflect.get(target, prop, target)` — the real window as receiver, never the
proxy.

**happy-dom will not catch this.** It exposes those as plain data properties, so
all 1600+ tests passed while the Workspace was broken in Chrome. Any test
covering proxy/accessor interaction must define a *brand-checked* accessor to
simulate the browser.

**Anything reachable from a Salesforce page must survive an invalidated
context.** Chrome updates the extension under open tabs; the orphaned content
script's `chrome.*` handles are dead and throw synchronously. Route storage
through `lib/storage.ts`. Fail **open** where a closed failure would disable
functionality (the kill-switch cache is the live example).

`chrome.runtime.sendMessage` is the sharp edge: on a dead context it throws
**synchronously**, so a callback that reads `lastError` never runs and the throw
escapes onto the Salesforce page as an uncaught error. Every send needs a
try/catch — `lib/salesforce-api.ts`, `features/org-switcher.ts` and the
`tellWorker()` helper in `entrypoints/content.ts` all wrap theirs.

And say which it is. A null reply from the worker means either "no Salesforce
session" or "this tab is running an orphaned build", and reporting the first for
both sends people hunting for a login problem when the fix is to reload the tab.
`lib/salesforce-api.ts` reads `chrome.runtime.id` (undefined only on
invalidation) to tell them apart. **Test mocks must set `runtime.id`** — real
Chrome always does, and a mock without it makes every test look invalidated.

**`grep -rl` treats large bundles as binary and suppresses matches.** Use
`grep -ra` when searching `.output/`. This cost two wrong conclusions about a
chunk "missing" code that was present.

**`SFDT_COMPONENT_CSS` is a template literal — a backtick in a CSS comment
terminates it.** Quoting a class name as `` `.sfdt-btn` `` inside a `/* … */`
block does not fail as CSS; it fails as *TypeScript*, tens of lines later, with
`TS1005: ',' expected`. Use `'single quotes'` in comments in that string, as the
surrounding ones do.

**A guard that reads inline styles goes blind the moment a file migrates.**
`test/error-render-newlines.test.ts` enforces that any element rendering a
Salesforce error declares a `white-space` rule. It understood `style.cssText`
and `style.whiteSpace` — so moving `apex-anonymous`'s panes onto `.sfdt-console`
made it report two false offenders on a file that had just become *more*
correct. The fix belongs in the guard, not the feature: it now also derives the
qualifying class names **from `SFDT_COMPONENT_CSS` itself**, so it can never
vouch for a class after someone deletes the declaration from the rule.

It went blind a **second** time, more subtly, when `health-modal` migrated: the
class recognizer read only the FIRST argument of `classList.add()`. A migrated
element carries its identity class first and its component class second — the
normal shape — so the guard saw `sfdt-health-error-message` and never the
`sfdt-msg` beside it, and fired on a file that had just become more correct.
The case pinning the health modal specifically had the same rot: it asserted
`cssText` even though the three `showError` funnels two cases above it had
already been converted to assert the union. Same lesson twice — when a check
reads HOW a rule is declared, every new way of declaring it is a fresh blind
spot. Assert the union, and expect this from any style-reading check.

**A WebIDL method held as a property and called as `this.x()` throws.**
`fetch`, like `scrollY` and friends, brand-checks its receiver. Stored on an
object and invoked as `this.fetchImpl(url)`, the receiver is that object, and
Chrome refuses:

    Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation

This shipped in `lib/sf-stream-worker.ts` and broke the Event Streaming Monitor
outright. `lib/sf-api-proxy.ts` holds the SAME value from the SAME caller and
was fine, because it calls it BARE — `fetchImpl(url)` — where there is no
receiver to check. Same value, same worker, two call shapes, one broken.

Bind at the boundary (`fetchImpl.bind(globalThis)` in the constructor), not at
the call sites: then a future `this.fetchImpl` is safe by construction and a
caller passing an unbound global cannot reintroduce it.

**A `vi.fn()` will not catch this.** Every existing test in that file passed
with the bug present, because an ordinary function brand-checks nothing. A test
has to assert the RECEIVER — pass a non-arrow function and record its `this`.

**A stack trace in `chrome://extensions` is recorded against the *old* build**
but rendered beside the *new* file. Line numbers do not map. Don't chase them.

---

## 6. Decisions already made — do not relitigate

| Decision | Rationale |
|---|---|
| **Keep SLDS colours, reject the Stitch Material-3 palette** | Injected UI lives inside Salesforce pages; continuity wins. Contrast tests are tuned to current values. |
| Take Stitch **layouts**, not its colours or code | The `code.html` files load Tailwind + Google Fonts from CDNs — blocked by MV3 CSP — and are raw HTML, against the zero-`innerHTML` rule. |
| No webfonts | System stack + `ui-monospace`. Inter would need a bundled woff2 in `public/`. |
| Inline SVG, not an icon font | Material Symbols would need bundling. |
| Build a real activity log | `lib/palette-recents.ts` stores ids only — no timestamp, outcome, or resource, so it cannot back an activity view. |
| Activity log defaults **on** | It backs a visible panel; off, the Overview ships permanently empty and nobody finds it. Privacy controls: `resource` truncated at write, bounded ring, clearable, documented in `PRIVACY.md`. |
| `mockups/` stays outside `entrypoints/` | WXT never bundles it; the store build is untouched. Run with `npx vite mockups` from `extension/`. |
| The modal title is a `<span>`, not an `<h2>` | Features put their own `<h2>`s in the body; a heading in the shell outranks them and broke two schema-browser assertions that read `querySelector('h2')`. The dialog's accessible name comes from `aria-label`. |
| A field-type chip reuses `.sfdt-pill.sfdt-square`, no new `.sfdt-badge` | The only difference from a pill is radius and fill. Two declarations beat a fourth chip class. |
| A builder (`button()`), not just a class (`.sfdt-btn`) | The class existed and 92% of buttons ignored it. Centralisation only holds when the shared path is *shorter* than the hand-rolled one. |
| `button()` throws on a missing accessible name | Runtime-deterministic beats a lint rule someone disables. It cannot pass in happy-dom and fail in Chrome. |
| Autocomplete chips keep a per-type glyph; the Inspect Record type column does not | The chip has no type text — the glyph is the only thing separating an object from a field. The table column has the type name right there, so the emoji added nothing. Same map, opposite verdicts. |
| A hand-written tokenizer, not CodeMirror | ~90 lines with no dependency, no CSP question, and nothing to keep up to date. It is a heuristic and will mis-colour pathological input; the text is never *interpreted* from the highlight, only read. |
| Syntax colours are six new tokens, not reused semantic ones | Six roles have to stay mutually distinguishable, and painting a string literal with `--sfdt-color-success` makes it read as a success message. Values are the GitHub light/dark schemes, already contrast-tested against near-white and near-black surfaces. |
| Governor limits render inline after any capturing run | The parser has always extracted them; they were one click away in the analyzer. Log capture is on by default, so the number a developer ran the snippet to check is now on screen without a second action. The log body is fetched **once** and shared by the tiles, the log pane and the analyzer. |
| An auto-fit tile grid, not the mockup's fixed right rail | `presentView` renders the same DOM at 860px (modal) and full width (Workspace tab). A 288px rail is right in one and cramped in the other; `repeat(auto-fit, minmax(150px, 1fr))` is 4-across in one and 2-across in the other. |
| Log lines are tinted by event type, not tokenized | A log declares what each line is in its second pipe-delimited field, so classification is a `split('|')[1]` lookup — ~40 lines, versus a parser. Different problem from the code editor, hence a different module. |
| The tinted pane uses newline text nodes, not `display: block` rows | Block spans lay out the same under `pre-wrap` **and** silently break select-all-copy: `textContent` loses every newline and the user gets one endless line. `test/apex-log-console.test.ts` asserts `pre.textContent === log`. |
| Dropped the always-dark log pane (`.sfdt-console.sfdt-inverse`) | It was added hours earlier for glare, then collided with tinting: an always-dark surface needs its own foreground palette, and every semantic token drawn inside renders wrong (light-theme `-text-strong` is dark navy on `#1e1e1e`). Following the theme costs one less palette. |
| The Debug Logs filter runs in memory | The page is at most 200 rows and already loaded. Re-querying would put a Tooling round-trip behind every keystroke to produce the same answer. |
| Debug Logs does **not** re-render trace-flag state | The mockup's right rail duplicates the `trace-flags` feature (754 lines) that the toolbar already links to. A second implementation of the same data is the thing this system exists to prevent. |
| Selection is `aria-current`, not `aria-selected` | The fill alone is a colour-only signal. `aria-current` is valid on any element; `aria-selected` needs a `grid`/`treegrid` role this table does not have. |
| The relationship graph reuses `subflow-graph`'s renderer | The graph structure was never Flow-specific — see §4e. Two consumers of one layout engine, versus two hand-rolled SVG layouts drifting apart. |
| Graph columns follow the direction of reference | Children (which hold the lookup) left, the object centre, its lookup targets right. Every arrow then runs left-to-right with no special-casing, which is the whole reason the layered layout works unmodified. |
| Self-references are dropped from the graph | `Account.ParentId → Account` would need a backwards curve from a node to itself. The field row's Details cell already shows the target; a loop adds an artefact, not information. |
| "Density Score" became "Custom field budget" | The mockup's 88th percentile has no data behind it anywhere in the describe, Tooling or `/limits`. The replacement answers the same question ("how full is this object?") from a real count — and states on screen that the 500 ceiling is an Enterprise/Unlimited edition constant, not something the API reports. |
| The audit section hides for standard objects | `CustomObject` is a Tooling entity that only exists for custom objects and `EntityDefinition` carries no audit fields, so on Account the data does not exist. Four dashes would read as a permission problem. |
| Record count is fetched per object and cached | `/limits/recordCount` is a separate call. It gets its own loading and failure line so the rest of the rail — which is free, straight out of the describe — renders instantly and survives an `INSUFFICIENT_ACCESS`. |
| "Generate SOQL" reuses the pending-query hand-off | `writePendingQuery()` + activate is exactly how Saved SOQL already stages a query. Adding a second setter to the runner would have been a new coupling for an existing capability. |
| Flag columns show a glyph only when TRUE | Three columns of negative marks is noise, and empty already reads as false. The glyph is `aria-hidden`, so the meaning rides on `.sfdt-sr` text — without it the column is decorative and a screen reader gets an empty cell either way. |
| The object list gets two glyphs, not a per-sObject icon map | No API says what an sObject *means*. A map would be the dozen standard ones and a shrug for the rest. Custom vs standard is knowable and is the distinction that helps when scanning. |
| One view = one implementation, two presentations | There is exactly ONE Inspect Record (`features/inspect-record.ts`), reached from the SOQL-runner Id menu, the command palette, the page context menu and the Workspace. "Make the popup match" is never a second implementation — `presentView` already owns the surface split. |
| **No 2×2 quick-action tile grid in the popup** | The action count is 1–3, never 4 (`lib/popup.ts:254-267`), so the grid's fourth cell is always empty and it degrades to a list with extra steps. The labels are verb phrases that wrap in a square. And the Stitch source drops `statusRow()`, which is both an a11y regression (colour would become the sole signal) and a utility one — session and bridge state is what the popup is FOR. Revisit only if a fourth top-level action appears, not on a re-reading of the mockup. See §4c. |

---

## 7. Working agreement

- Extension releases need their **own** in-Chrome smoke test against a live org.
  The GUI `/pre-release-ui-test` does not cover this extension; `wxt build` +
  happy-dom vitest is not a browser.
- A new Chrome feature must also be added to `lib/feature-manifests.json` and
  the repo-root `npm run generate:catalogs` must be re-run and committed, or CI
  fails on catalog drift.
- Gates from `extension/`: `npx vitest run`, `npx tsc --noEmit`, `npx eslint .`,
  `npx wxt build`, plus repo-root `npm run check:all-contracts`.
- Verify a mechanical sweep by grepping for the **complement** — what must *not*
  remain — never by spot-checking a few migrated sites.
