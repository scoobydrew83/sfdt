# SFDT Extension — UX & Accessibility Conventions

This is the contributor standard for every piece of UI the extension injects into
a Salesforce page (overlays, panels, menus, tab strips, toolbars). It exists
because our headline product weakness is **inconsistent accessibility** — our
injected overlays and menus have historically each invented their own focus,
keyboard, and dismiss behaviour. This document is the single, enforced bar.

This document is the source of record for the extension's UI conventions. The
wider house rules it builds on — the feature-registry pattern, `createElement` +
`textContent` only, vitest per feature, package-internal paths via
`import.meta.url` — are restated here where they bear on UI.

## How to use this document

The numbered list in **[The a11y / overlay / keyboard / theme checklist](#the-checklist)**
is applied **verbatim** by reviewer agents. Every UI-bearing PR is checked
against it item by item. "Mostly compliant" is a fail — each item is either MET,
or N/A with a one-line reason. New UI should copy the two
[reference implementations](#reference-implementations) rather than reinvent the
pattern.

If an item genuinely does not apply to your change (e.g. your feature adds no
overlay), mark it **N/A** with a reason — do not silently skip it.

---

<a id="the-checklist"></a>
## The a11y / overlay / keyboard / theme checklist

### Overlays & modals

1. **Esc closes.** Any dismissible overlay, panel, dropdown, or popover closes on
   the `Escape` key. Register the handler on `document` in the **capture** phase
   (`doc.addEventListener('keydown', h, true)`) so it fires even when focus sits
   inside a Salesforce-owned widget, and **remove the listener on close** so it
   does not leak across SPA navigations. The capture-phase exemplar is
   `features/canvas-search.ts:458` (`addEventListener('keydown', …, true)`).
   `features/soql-runner.ts`, `features/inspect-record.ts`, and
   `features/api-version-audit.ts` get the remove-on-close half right but
   currently register in the default **bubble** phase (no third arg) — moving them
   to capture phase is a gap the P6-3 retrofit closes.
2. **Click-outside dismiss for transient surfaces.** Menus, dropdowns, and
   non-modal popovers also close on a click outside their own subtree
   (`if (!el.contains(e.target)) close()`). Modal dialogs presented via
   `ui/present-view.ts` close on a backdrop click. A **persistent** surface (a
   Workspace tab pane, anything holding unsaved user input) must **not**
   click-outside-dismiss — a stray click can never discard the user's work.
3. **Focus trap while open.** While a modal overlay is open, Tab / Shift-Tab must
   cycle **within** the overlay and not reach the page behind it. Move focus into
   the overlay on open (focus the first meaningful control — see item 8).
4. **Focus restore on close.** Capture `doc.activeElement` before opening and
   restore focus to it when the overlay closes, so keyboard users are returned to
   where they were. (Gap the P6-3 retrofit closes: most current features focus an
   input on open but do not restore on close.)
5. **Dialog semantics.** A modal overlay must carry `role="dialog"` +
   `aria-modal="true"` and be labelled — `aria-label`, or `aria-labelledby`
   pointing at the header title. Today `ui/present-view.ts` gives its close control
   an accessible name (`aria-label="Close"`, `present-view.ts:83`) but does **not**
   yet set `role="dialog"`/`aria-modal` or label the dialog itself — adding those
   to the shared presenter is the P6-3-retrofit gap.
6. **One close affordance, always reachable.** Every overlay has a visible,
   focusable close control (the `×` button in `ui/present-view.ts`) in addition to
   Esc — never Esc-only.
7. **Pin affordance for persistent surfaces.** A surface that is meant to stay put
   across SPA navigations (docked panel, tab strip) must not silently re-open or
   float over unrelated content after a route change. Either re-anchor it on
   navigation or dismiss it. (Regression precedent: the `api-version-audit` panel
   once floated over later content after an SPA nav until click-outside dismiss
   was added.)

### Keyboard

8. **Full keyboard path.** Every action reachable by mouse is reachable by
   keyboard alone. Interactive elements are natively focusable (`<button>`,
   `<a href>`, `<input>`, `<select>`) or given `tabindex`. On open, move focus to
   the primary control (search input, first field). Enter activates the primary
   action; Esc cancels (item 1).
9. **Native controls first.** Use real `<button>` / `<a>` / `<input>` /
   `<select>` elements rather than click-wired `<div>`s, so focus, activation, and
   screen-reader semantics come for free. Only add ARIA roles when re-skinning a
   native control is unavoidable, and then wire the full keyboard contract
   yourself (e.g. the `role="menu"` group in `features/setup-tabs.ts` also sets
   `aria-expanded`/`aria-haspopup` and closes on click-outside).

### ARIA & labelling

10. **Every control is labelled.** Inputs, selects, and icon-only buttons have an
    accessible name — visible `<label>`, `aria-label`, or `title`. Purely
    decorative icons/emoji are hidden from assistive tech with
    `aria-hidden="true"` (see the search icon in `features/flow-list-search.ts`
    and the chevron SVG in `features/setup-tabs.ts`).
11. **State is exposed, not just styled.** Selection, expansion, and checked state
    are conveyed via ARIA, not colour alone: `aria-selected` on tabs,
    `aria-expanded` on disclosure/menu triggers, `aria-checked` where relevant —
    kept in sync as state changes (`features/setup-tabs.ts` updates
    `aria-selected`/`aria-expanded` on toggle).

### DOM discipline

12. **Zero `innerHTML`.** Build every node with `document.createElement` and set
    text with `.textContent`; build SVG with `createElementNS`. Never assign
    `innerHTML`/`outerHTML` or use `insertAdjacentHTML`. This makes injected UI
    XSS-safe by construction with no escaping pathway — org metadata (flow labels,
    field names, record data) is untrusted. (`features/setup-tabs.ts` builds even
    its chevron SVG node-by-node specifically to keep the file `innerHTML`-free.)
13. **Shadow-root mounting for injected UI.** Overlays and panels injected onto a
    Salesforce page should mount inside a shadow root so the host page's CSS cannot
    restyle our UI and our styles cannot leak onto the host. **This is not yet
    implemented** — there is currently no shadow-root usage in the extension
    (`attachShadow`/`shadowRoot` appear nowhere in source) and features mount in
    light DOM. A shared Shadow-DOM host is planned (the P0-3 item); when it lands,
    injected UI moves into it and the token custom properties must be injected into
    the shadow mount so `var(--sfdt-*)` still resolves (today `lib/tokens.ts`
    `ensureTokens` injects them into the light-DOM `document`). Until then, do not
    hand-roll a bespoke `attachShadow` per feature.

### Theming

14. **Theme tokens, never hard-coded colours.** All colours reference the design
    tokens as `var(--sfdt-color-*)` custom properties (`lib/tokens.ts`); no raw
    hex/rgb literals in feature or UI code. The tokens are the single swap point a
    dark theme (P0-2) flips. The **only** sanctioned exceptions are `lib/tokens.ts`
    itself (where the hex literals live) and the user-configurable runtime
    highlight colour in `features/canvas-search.ts`. Call `ensureTokens(doc)` on
    the document (or shadow mount) you render into so the variables resolve.
15. **Works in both themes.** After P0-2, any new colour must be legible and
    sufficient-contrast in **both** light and dark. Because you used tokens
    (item 14), this is automatic — do not special-case a theme with a literal.

---

<a id="reference-implementations"></a>
## Reference implementations

These two shipped features are the bar. When building new UI, copy their
patterns.

### `features/setup-tabs.ts` — injected navigation with correct ARIA + keyboard menu

Demonstrates:

- **Correct tab/menu ARIA, kept in sync.** Injected tabs set
  `role="presentation"` on the `<li>` and `role="tab"` + `aria-selected` on the
  anchor, computed from the active URL (`isActiveTab`). The grouped variant uses
  `role="menu"` / `role="menuitem"` and drives `aria-expanded` /
  `aria-haspopup` / `aria-selected` on the trigger, updating them on every toggle
  (`buildGroupedTab`, `toggle`, `closeDropdown`).
- **Esc-free dropdown that still dismisses correctly.** The group dropdown closes
  on click-outside via a capture-phase `document` click listener
  (`if (!li.contains(e.target)) closeDropdown(...)`) and closes sibling dropdowns
  when one opens — the click-outside half of checklist item 2.
- **`innerHTML`-free SVG.** The chevron icon is assembled with `createElementNS`
  node by node (item 12) rather than an HTML string.
- **Decorative icon hidden from AT.** The chevron `<svg>` is
  `aria-hidden="true"` / `focusable="false"` (item 10).
- **Feature-registry + kill-switch + opt-in.** Registers a settings schema,
  respects `isFeatureEnabled`, and re-injects live on settings change — the
  house-rule integration every feature owes.

### `features/flow-list-search.ts` — injected form controls with full labelling + keyboard path

Demonstrates:

- **Every control labelled (item 10).** The search `<input>`, both `<select>`
  filters, and the Clear `<button>` each carry an `aria-label`
  ("Search flows by label or API name", "Filter flows by status", "Filter flows
  by type", "Clear search and filters"). The 🔍 icon is `aria-hidden="true"`.
- **Native controls, full keyboard path (items 8–9).** Real `<input>` /
  `<select>` / `<button>` elements mean focus, typing, and activation work by
  keyboard with no extra wiring. `onActivate` focuses and selects the search
  input so keyboard users land on the primary control; Clear returns focus to the
  input (`searchInput?.focus()`).
- **State exposed, not colour-only.** Result count is announced as text
  ("`3 of 12 flows`", "No matching flows") via `.textContent`, not conveyed by
  styling alone (item 11).
- **`createElement` + `textContent` throughout (item 12).** Options, labels, and
  counts are all built as nodes / text — no `innerHTML`, so untrusted flow labels
  and API names cannot inject markup.

---

## Relationship to the Global Definition of Done

The board's Global DoD carries an "a11y checklist (P0-8)" line. That line
**is** the numbered checklist above — reviewers apply it verbatim. This document
also feeds **P6-3** (the accessibility retrofit sweep), which holds every
pre-existing feature to exactly these items (notably the focus-trap and
focus-restore gaps in items 3–4).
