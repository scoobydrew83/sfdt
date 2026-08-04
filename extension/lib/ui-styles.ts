// Shared component stylesheet — the presentation half of the design system.
//
// lib/tokens.ts centralises the VALUES (colour, spacing, radius, type). This
// file centralises the COMPONENTS built from them: card, button, pill, meter,
// table, nav item. Before it existed there were four independently hand-rolled
// stylesheets (popup, options, workspace-host, shadow-host) and 800+ inline
// `element.style.cssText` assignments, so every surface reinvented a card and a
// button slightly differently — which is the structural reason the UI drifted
// toward looking hand-made.
//
// SCOPING RULE — every selector in here MUST start with `.sfdt-`.
// This sheet is destined for content-script surfaces, where it lands on a live
// Salesforce page. A bare element selector (`button { … }`, `table { … }`)
// would restyle Salesforce's own UI, and a generic class (`.card`) would
// collide with SLDS. test/ui-styles.test.ts enforces the prefix mechanically.
//
// COLOUR RULE — no raw hex here either; everything is a `var(--sfdt-color-*)`.
// Foreground uses the `-text` / `-strong` / `-on-accent` aliases so dark mode is
// correct (see the header of lib/tokens.ts for why the split exists).
//
// Adoption is incremental: surfaces move onto these classes as they're
// rebuilt. Nothing is deleted from the existing inline styles until the surface
// that owns them is migrated.

const COMPONENT_STYLE_ID = 'sfdt-component-styles';

export const SFDT_COMPONENT_CSS = `
/* --- surfaces ------------------------------------------------------------- */
.sfdt-card {
  background: var(--sfdt-color-surface);
  border: 1px solid var(--sfdt-color-border);
  border-radius: var(--sfdt-radius-xl);
  box-shadow: var(--sfdt-shadow-1);
}
.sfdt-card-head {
  display: flex;
  align-items: center;
  gap: var(--sfdt-space-2);
  padding: var(--sfdt-space-5) var(--sfdt-space-5) var(--sfdt-space-4);
}
.sfdt-card-head h2 {
  font: var(--sfdt-type-headline-md);
  margin: 0;
  color: var(--sfdt-color-text-strong);
}
.sfdt-card-head .sfdt-card-lead { display: flex; color: var(--sfdt-color-brand-text); }
.sfdt-card-head .sfdt-card-actions { margin-left: auto; display: flex; gap: var(--sfdt-space-2); }

/* A card used as a page section: same surface, but padded and stacked down a
   settings page rather than floated as a dialog. Was 'section.sfdt-card { … }'
   in the options page's own sheet, which restyled EVERY card on that page —
   including any a feature mounted there. */
.sfdt-card.sfdt-card-section {
  padding: var(--sfdt-space-4) var(--sfdt-space-5);
  margin-bottom: var(--sfdt-space-4);
}

/* Nested fills use 'color-bg', NOT a surface shade. It is the page
   backdrop, so it is guaranteed to sit a full step away from 'color-surface' in
   BOTH themes — light: white card, grey inset; dark: #202024 card, #141416
   inset. The shade-2 it replaced is #f3f6f9 in light, which against a #fff card
   read as a smudge rather than a distinct plane. */
.sfdt-tile {
  background: var(--sfdt-color-bg);
  border: 1px solid var(--sfdt-color-border);
  border-radius: var(--sfdt-radius-lg);
  padding: var(--sfdt-space-4);
}
.sfdt-tile .sfdt-tile-value {
  font: var(--sfdt-type-metric);
  color: var(--sfdt-color-text-strong);
  letter-spacing: -0.02em;
}
.sfdt-tile .sfdt-tile-value small {
  font: var(--sfdt-type-body-md);
  color: var(--sfdt-color-text-weak);
  letter-spacing: 0;
}

/* Header row for a compact panel-like surface: the toolbar popup and the ⚡ menu
   injected on Salesforce pages. Leading glyph, title, optional trailing action.
   Both surfaces declared this identically — same padding, same border, same gap
   — in two places, one of them an inline cssText string. Two provable consumers
   is what makes it a component rather than a wrapper.

   NOT the Workspace app bar (#sfdt-topbar): that carries org identity, a release
   badge, search and an action cluster at a fixed 64px. It is a structurally
   different thing with one implementation already shared by two surfaces, and
   folding it in here would be a false abstraction. */
.sfdt-panel-head {
  display: flex;
  align-items: center;
  gap: var(--sfdt-space-2);
  padding: var(--sfdt-space-4) var(--sfdt-space-4) var(--sfdt-space-3);
  border-bottom: 1px solid var(--sfdt-color-border);
  /* The leading glyph inherits this; the title overrides it below. */
  color: var(--sfdt-color-brand-text);
}
.sfdt-panel-head .sfdt-panel-title {
  font: var(--sfdt-type-headline-md);
  margin: 0;
  color: var(--sfdt-color-text-strong);
  /* Claims the slack so any trailing control sits hard right without the
     surfaces each inventing their own spacer. */
  margin-right: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Stacked title + context line (e.g. "Account › 001aj00003GCO5RAAX"). The
   wrapper takes over the auto margin so the title inside stops claiming it —
   otherwise the two rules fight and the subtitle wraps to its own column. */
.sfdt-panel-head .sfdt-panel-titles {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-right: auto;
  min-width: 0;
}
.sfdt-panel-head .sfdt-panel-titles .sfdt-panel-title { margin-right: 0; }
.sfdt-panel-sub {
  display: flex;
  align-items: center;
  gap: var(--sfdt-space-1);
  font: var(--sfdt-type-body-sm);
  color: var(--sfdt-color-text-weak);
  min-width: 0;
}
.sfdt-panel-sub > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sfdt-panel-head .sfdt-panel-actions { display: flex; align-items: center; gap: var(--sfdt-space-2); }

/* A control strip below a panel head — filter box, toggles, a trailing action.
   Distinct from '.sfdt-panel-head': that is identity (glyph + title), this is
   controls, and a surface can have the strip without the head. */
.sfdt-toolbar {
  display: flex;
  align-items: center;
  gap: var(--sfdt-space-3);
  flex-wrap: wrap;
  padding: var(--sfdt-space-3) var(--sfdt-space-4);
  border-bottom: 1px solid var(--sfdt-color-border);
  background: var(--sfdt-color-bg);
}
.sfdt-toolbar .sfdt-toolbar-grow { flex: 1 1 220px; min-width: 0; }
.sfdt-toolbar .sfdt-toolbar-end { margin-left: auto; }
/* Same strip pinned under the body instead of over it — counts, mode, status.
   A modifier rather than a '.sfdt-statusbar' class: the only difference is
   which edge carries the border. */
.sfdt-toolbar.sfdt-toolbar-foot {
  border-bottom: 0;
  border-top: 1px solid var(--sfdt-color-border);
  padding: var(--sfdt-space-2) var(--sfdt-space-4);
}

/* --- inputs --------------------------------------------------------------- */
/* Same reason '.sfdt-btn' sets 'color' explicitly: a native <input> takes its
   colour and font from UA styles, not from an inherited value, so an
   un-migrated input renders light-on-light in the dark palette. Inputs are the
   second most common dark-mode defect after buttons. */
.sfdt-field {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 10px;
  border: 1px solid var(--sfdt-color-border);
  border-radius: var(--sfdt-radius-md);
  background: var(--sfdt-color-surface);
  color: var(--sfdt-color-text);
  font: var(--sfdt-type-body-sm);
}
.sfdt-field::placeholder { color: var(--sfdt-color-text-muted); }
.sfdt-field:focus-visible {
  outline: 2px solid var(--sfdt-color-info);
  outline-offset: 1px;
  border-color: var(--sfdt-color-brand);
}
.sfdt-field.sfdt-mono { font: var(--sfdt-type-code-sm); }
/* Shrink-to-fit, for a field that shares a toolbar row with buttons instead of
   owning a form row. Without it the 100% above makes a <select> in a toolbar
   claim the whole strip. */
.sfdt-field.sfdt-auto { width: auto; }

.sfdt-check {
  display: inline-flex;
  align-items: center;
  gap: var(--sfdt-space-2);
  font: var(--sfdt-type-body-sm);
  color: var(--sfdt-color-text-weak);
  cursor: pointer;
  white-space: nowrap;
}

/* --- segmented toggle ----------------------------------------------------- */
/* Two-to-three exclusive views of the same data (Fields ⇄ JSON). Rows are real
   <button aria-pressed>, so the state is exposed rather than colour-only. */
.sfdt-segment {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--sfdt-color-border);
  border-radius: var(--sfdt-radius-md);
  background: var(--sfdt-color-bg);
}
.sfdt-segment > button {
  border: 0;
  background: none;
  padding: 4px 12px;
  border-radius: var(--sfdt-radius);
  font: var(--sfdt-type-label-caps);
  letter-spacing: var(--sfdt-tracking-caps);
  text-transform: uppercase;
  color: var(--sfdt-color-text-weak);
  cursor: pointer;
}
.sfdt-segment > button:hover { color: var(--sfdt-color-text-strong); }
.sfdt-segment > button:focus-visible { outline: 2px solid var(--sfdt-color-info); outline-offset: 1px; }
/* Both spellings: a toggle-button group states itself with aria-pressed, a real
   radiogroup with aria-checked. The SOQL runner has one of each side by side
   (query language is a radiogroup, transport is a toggle pair), and they must
   not look like two different controls. */
.sfdt-segment > button[aria-pressed="true"],
.sfdt-segment > button[aria-checked="true"] {
  background: var(--sfdt-color-brand);
  color: var(--sfdt-color-on-accent);
}
.sfdt-segment > button[disabled] {
  color: var(--sfdt-color-text-disabled);
  cursor: default;
}
.sfdt-segment > button[disabled]:hover { color: var(--sfdt-color-text-disabled); }

/* --- text ----------------------------------------------------------------- */
.sfdt-caps {
  font: var(--sfdt-type-label-caps);
  letter-spacing: var(--sfdt-tracking-caps);
  color: var(--sfdt-color-text-muted);
  text-transform: uppercase;
}
.sfdt-mono { font: var(--sfdt-type-code-sm); }
/* Secondary text: a keyboard hint, a status detail, a count. Small and quiet
   without reading as disabled. */
.sfdt-muted { font: var(--sfdt-type-body-sm); color: var(--sfdt-color-text-weak); }
/* Even quieter — a timestamp, a byte count, an inline hint beside a control. */
.sfdt-faint { font: var(--sfdt-type-body-sm); color: var(--sfdt-color-text-icon); }

/* The label above a form control. Seventeen sites declared this identically
   ('font-size: 11px; font-weight: 600; color: text-weak') and every settings
   form invented it separately, because nothing in the sheet covered the one
   piece of text every form is made of. */
.sfdt-label {
  display: block;
  font: var(--sfdt-type-body-sm);
  font-weight: 600;
  color: var(--sfdt-color-text-weak);
  margin-bottom: var(--sfdt-space-1);
}
/* A heading inside a pane that is not the view's title — 'Results', 'Filters',
   'Child Relationships'. Distinct from '.sfdt-section-title', which carries the
   pane's own gutter; this one sits inline in whatever already has padding. */
.sfdt-subhead {
  font: var(--sfdt-type-body-md);
  font-weight: 600;
  color: var(--sfdt-color-text-strong);
  margin: 0 0 var(--sfdt-space-2);
}

/* --- buttons -------------------------------------------------------------- */
.sfdt-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--sfdt-space-2);
  padding: 7px 14px;
  border-radius: var(--sfdt-radius-md);
  border: 1px solid var(--sfdt-color-border);
  background: var(--sfdt-color-surface);
  /* A native <button> ignores inherited colour (UA buttontext), so this must be
     set explicitly or themed buttons go dark-on-dark in the dark palette. */
  color: var(--sfdt-color-brand-text);
  font: var(--sfdt-type-body-sm);
  font-weight: 600;
  cursor: pointer;
}
.sfdt-btn:hover { background: var(--sfdt-color-surface-shade-2); }
.sfdt-btn:focus-visible { outline: 2px solid var(--sfdt-color-info); outline-offset: 2px; }
.sfdt-btn[disabled] { color: var(--sfdt-color-text-disabled); cursor: default; }
.sfdt-btn[disabled]:hover { background: var(--sfdt-color-surface); }

.sfdt-btn.sfdt-primary {
  background: var(--sfdt-color-brand);
  border-color: var(--sfdt-color-brand);
  color: var(--sfdt-color-on-accent);
}
.sfdt-btn.sfdt-primary:hover { background: var(--sfdt-color-brand-active); }

.sfdt-btn.sfdt-ghost {
  border-color: transparent;
  background: none;
  color: var(--sfdt-color-text-icon);
  padding: 6px;
}
.sfdt-btn.sfdt-ghost:hover {
  background: var(--sfdt-color-surface-shade-3);
  color: var(--sfdt-color-text-strong);
}

/* Destructive. Border-and-text rather than a filled block: a filled red button
   reads as the primary action of the row it sits in, which is the opposite of
   what a delete should look like. It fills only on hover, at the point of
   commitment. */
.sfdt-btn.sfdt-danger { color: var(--sfdt-color-error-text); }
.sfdt-btn.sfdt-danger:hover {
  background: var(--sfdt-color-error-bg);
  border-color: var(--sfdt-color-error);
}

/* Compact density for toolbars, table rows and result strips — the places a
   full-size button turns a one-line strip into a two-line one. */
.sfdt-btn.sfdt-sm {
  padding: 3px 8px;
  gap: var(--sfdt-space-1);
  font: var(--sfdt-type-body-sm);
  font-weight: 600;
}

/* Icon-only: square, so a row of them is an even rhythm rather than a set of
   different-width blocks. button() in lib/ui-controls.ts refuses to build one
   of these without an accessible name. */
.sfdt-btn.sfdt-icon { padding: 6px; }
.sfdt-btn.sfdt-icon.sfdt-sm { padding: 4px; }

/* Chip shape, for a scrolling row of selectable suggestions where the pill
   outline is what separates one item from the next. */
.sfdt-btn.sfdt-round { border-radius: var(--sfdt-radius-pill); }

/* --- status --------------------------------------------------------------- */
.sfdt-pill {
  display: inline-flex;
  align-items: center;
  padding: 3px 10px;
  border-radius: var(--sfdt-radius-pill);
  font: var(--sfdt-type-label-caps);
  letter-spacing: var(--sfdt-tracking-caps);
  text-transform: uppercase;
  background: var(--sfdt-color-surface-shade-4);
  color: var(--sfdt-color-text-weak);
}
/* A pill may lead with a glyph (a field-type chip, a mode marker). The glyph is
   decorative — the pill's text always carries the meaning. */
.sfdt-pill .sfdt-glyph { color: var(--sfdt-color-text-icon); margin-right: var(--sfdt-space-1); }
.sfdt-pill.sfdt-square { border-radius: var(--sfdt-radius); background: var(--sfdt-color-bg); border: 1px solid var(--sfdt-color-border); }
.sfdt-pill.sfdt-success { background: var(--sfdt-color-success-bg); color: var(--sfdt-color-success-text); }
.sfdt-pill.sfdt-warning { background: var(--sfdt-color-warning-bg); color: var(--sfdt-color-warning-text); }
.sfdt-pill.sfdt-error   { background: var(--sfdt-color-error-bg);   color: var(--sfdt-color-error-text); }

/* Decorative only — a status dot must always sit beside a text label, never
   convey the state on its own (CONVENTIONS.md a11y checklist). */
.sfdt-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--sfdt-radius-pill);
  display: inline-block;
  flex: 0 0 auto;
}

.sfdt-meter {
  height: 5px;
  border-radius: var(--sfdt-radius-pill);
  background: var(--sfdt-color-surface-shade-6);
  overflow: hidden;
}
.sfdt-meter > i {
  display: block;
  height: 100%;
  border-radius: var(--sfdt-radius-pill);
}

/* --- threshold state ------------------------------------------------------ */
/* Replaces 'el.style.color = ok ? success : error' and
   'fill.style.background = pct > 0.85 ? … : …' at every call site. The
   THRESHOLDS stay in code — they are policy, and they differ per metric — but
   the COLOURS come back to the sheet, which is what stops the same green from
   being spelled three ways across four features. */
.sfdt-text-ok { color: var(--sfdt-color-success-text); }
.sfdt-text-warn { color: var(--sfdt-color-warning-text); }
.sfdt-text-bad { color: var(--sfdt-color-error-text); }
.sfdt-text-info { color: var(--sfdt-color-brand-text); }
.sfdt-fill-ok { background: var(--sfdt-color-success-bg); }
.sfdt-fill-warn { background: var(--sfdt-color-warning-bg); }
.sfdt-fill-bad { background: var(--sfdt-color-error-bg); }
.sfdt-meter > i.sfdt-ok { background: var(--sfdt-color-success); }
.sfdt-meter > i.sfdt-warn { background: var(--sfdt-color-warning); }
.sfdt-meter > i.sfdt-bad { background: var(--sfdt-color-error); }
.sfdt-dot.sfdt-ok { background: var(--sfdt-color-success); }
.sfdt-dot.sfdt-warn { background: var(--sfdt-color-warning); }
.sfdt-dot.sfdt-bad { background: var(--sfdt-color-error); }
.sfdt-dot.sfdt-idle { background: var(--sfdt-color-text-disabled); }

/* --- layout primitives ---------------------------------------------------- */
/* THREE, deliberately. The header of this file warns against turning a design
   system into a second, worse layout engine, and a full utility set (.p-4,
   .mt-2, .flex-1) is exactly that. These three earn their place because every
   single migrated feature declared them inline, identically, and nothing else
   in the sheet covers them:
     - a row of controls,
     - a column of blocks,
     - a scrolling region inside a flex parent (which needs 'min-height: 0',
       the one rule people forget and then wonder why nothing scrolls).
   Anything more specific than these belongs in a named component. */
.sfdt-row {
  display: flex;
  align-items: center;
  gap: var(--sfdt-gap, var(--sfdt-space-2));
  min-width: 0;
}
.sfdt-row.sfdt-wrap { flex-wrap: wrap; }
/* Pushes the last child to the far edge — a title with a trailing action. */
.sfdt-row.sfdt-split { justify-content: space-between; }
.sfdt-row.sfdt-baseline { align-items: baseline; }
.sfdt-row.sfdt-bottom { align-items: flex-end; }
.sfdt-stack {
  display: flex;
  flex-direction: column;
  gap: var(--sfdt-gap, var(--sfdt-space-3));
  min-width: 0;
}

/* THREE gap modifiers, driven through one custom property so they work on both
   '.sfdt-row' and '.sfdt-stack' rather than needing a pair each.
   These exist because the call sites used TEN distinct gap values — 2, 4, 6, 8,
   10, 12, 14, 16, 20px — for the same handful of shapes. That is not ten design
   decisions, it is one decision made ten times from memory, and it is the exact
   drift a token scale is for. Converting snaps everything to the 4px grid. */
.sfdt-tight { --sfdt-gap: var(--sfdt-space-1); }
.sfdt-snug { --sfdt-gap: var(--sfdt-space-2); }
.sfdt-loose { --sfdt-gap: var(--sfdt-space-4); }

/* A bordered, padded block sitting inside a pane — a result group, a callout,
   a settings cluster. Distinct from '.sfdt-card', which is a top-level surface
   with elevation. */
.sfdt-panel {
  padding: var(--sfdt-space-3);
  border: 1px solid var(--sfdt-color-border);
  border-radius: var(--sfdt-radius-md);
}
/* Trailing rhythm for a block in a run of stacked siblings. The ONE spacing
   modifier in the sheet, and it exists only because these blocks sit in
   containers that are not yet '.sfdt-stack'. When a container is converted, its
   children should lose this rather than keep it — a stack's gap and a child's
   margin doing the same job is how spacing ends up doubled. */
.sfdt-below { margin-bottom: var(--sfdt-space-3); }

/* A hairline between stacked rows. */
.sfdt-divider { border-bottom: 1px solid var(--sfdt-color-border); }
/* A sub-header that stays put while its list scrolls under it. The opaque
   background is what makes it legible — rows would otherwise show through. */
.sfdt-sticky-head {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: var(--sfdt-space-2) var(--sfdt-space-3);
  background: var(--sfdt-color-surface-alt);
  border-bottom: 1px solid var(--sfdt-color-border);
  font-weight: 600;
}
/* Auto-fill card grid — same reasoning as '.sfdt-tiles', wider cells. */
.sfdt-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: var(--sfdt-gap, var(--sfdt-space-3));
}
.sfdt-scroll { flex: 1; min-height: 0; overflow: auto; }

/* Row/item highlight states that were each set as an inline background:
   'active' is the one the keyboard is on, 'flagged' is a value that changed. */
.sfdt-row-active { background: var(--sfdt-color-surface-shade); }
.sfdt-row-flagged { background: var(--sfdt-color-warning-bg); }

/* Type weight/slant that a component class doesn't already carry. Two, both
   earning their place by appearing in five files each. */
.sfdt-strong { font-weight: 600; color: var(--sfdt-color-text-strong); }
.sfdt-italic { font-style: italic; }
.sfdt-nowrap { white-space: nowrap; }
/* Claims the free space in a flex row. '.sfdt-toolbar-grow' is the toolbar-
   scoped version; this is the general one. */
.sfdt-grow { flex: 1; min-width: 0; }

/* A filter/search box sharing a toolbar row: wide enough to type into, and it
   must not collapse when the row gets tight. The six sites this replaces used
   FOUR different minimums (160/180/180/200px) for the same control — picking
   one is the point of having a system. */
.sfdt-field.sfdt-search { min-width: 180px; }

/* Editors and textareas that need a taller-than-default box. Two sizes because
   two surfaces asked for two; a third caller should pick one of these rather
   than add a number. */
/* A textarea that must not be user-resized — it lives in a fixed pane, and a
   drag handle that can break the layout is an affordance for a thing the user
   should not be able to do. */
.sfdt-field.sfdt-fixed { resize: none; }
.sfdt-field.sfdt-tall { min-height: 100px; }
.sfdt-field.sfdt-taller { min-height: 120px; }
/* An element that hosts an absolutely-positioned child (an inline editor, a
   badge). Declaring it inline meant the relationship lived in two files. */
.sfdt-anchor { position: relative; }
/* Fills the space its flex parent leaves without shrinking below its own
   min-height — the code editor and the results table both want this. */
.sfdt-fill { flex: 1 0 auto; }
/* Opts an element OUT of growing in a flex row. */
.sfdt-nogrow { flex-grow: 0; }
/* Pins a control to the start of a flex cross-axis instead of stretching it. */
.sfdt-selfstart { align-self: flex-start; }

/* A chip row that either wraps into a block or scrolls as a single line. The
   two branches were six inline writes each; as a class the two states are
   declared side by side where they can be compared. */
.sfdt-chiprow { display: flex; gap: 6px; flex-wrap: nowrap; overflow-x: auto; overflow-y: visible; }
.sfdt-chiprow.sfdt-chiprow-wrap { flex-wrap: wrap; overflow-x: visible; overflow-y: auto; max-height: 180px; }

/* zod-to-dom renders the settings form for every feature's schema. Its three
   inline declarations were the only styling it did. */
.sfdt-fieldset { border: 0; padding: 0; }
.sfdt-field-row { display: block; padding: 4px 0; }
.sfdt-field-name { margin-right: var(--sfdt-space-2); }
/* The empty/placeholder block inside a scrolling detail pane. */
.sfdt-placeholder { padding: var(--sfdt-space-6) var(--sfdt-space-4); }

/* A centred modal scrim that a feature raises for its OWN dialog — an options
   editor, a permissions picker — where presentView's card is the wrong shape.
   Shares the scrim token with presentView and confirmDialog, so stacked
   overlays dim the page by the same amount instead of the 0.3-vs-0.4 drift
   these had. */
.sfdt-modal-card { padding: var(--sfdt-space-4); overflow: hidden; }

.sfdt-overlay {
  position: fixed;
  inset: 0;
  z-index: 100030;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--sfdt-color-scrim);
}

/* A full-viewport scrim shown while a feature does its up-front work, before it
   has a view to put a spinner in. Three features declared this identically and
   two of them mounted it on 'doc.body' even inside a shadow-hosted surface. */
.sfdt-busy {
  position: fixed;
  inset: 0;
  z-index: 100020;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sfdt-space-3);
  background: var(--sfdt-color-scrim);
  color: var(--sfdt-color-on-accent);
  font: var(--sfdt-type-body-md);
}

/* --- shared panel chrome -------------------------------------------------- */
/* ui/panels.ts and ui/confirm-dialog.ts are the SHARED components, so their own
   spacing has to live here too — a builder that centralises a block and then
   styles it inline has only moved the problem one file. */
.sfdt-panel-loading { padding: var(--sfdt-space-5); }
.sfdt-panel-empty {
  padding: var(--sfdt-space-6);
  align-items: center;
  text-align: center;
}
.sfdt-panel-empty .sfdt-glyph { color: var(--sfdt-color-text-disabled); }
.sfdt-confirm-card {
  padding: var(--sfdt-space-5);
  min-width: 360px;
  max-width: 480px;
}
.sfdt-confirm-card > h2, .sfdt-confirm-card > p { margin: 0; }
.sfdt-confirm-card > ul { margin: 0; max-height: 140px; overflow: auto; }
.sfdt-confirm-card > .sfdt-row { justify-content: flex-end; }

/* A row/cell that activates on click. The pointer is the affordance; the
   element still needs a real role and key handler to be reachable. */
.sfdt-clickable { cursor: pointer; }

/* Inline link inside body copy or a table cell — a cross-link to another
   object, a record, a Setup page. Was hand-declared in schema-browser,
   inspect-record and soql-runner with three different underline conventions. */
.sfdt-link {
  color: var(--sfdt-color-brand-text);
  text-decoration: underline;
  cursor: pointer;
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
}

/* A tinted, bordered notice — a truncation warning, a pass/fail summary, a
   destructive-mode caution. Distinct from '.sfdt-console.sfdt-error', which is
   a monospace block for an ORG's error text; this is our own prose. Three
   features had built it with their own border/tint pairs. */
.sfdt-callout {
  padding: var(--sfdt-space-3) var(--sfdt-space-4);
  border: 1px solid var(--sfdt-color-border);
  border-radius: var(--sfdt-radius-md);
  font: var(--sfdt-type-body-sm);
}
.sfdt-callout.sfdt-warn {
  border-color: var(--sfdt-color-warning-border);
  background: var(--sfdt-color-warning-bg);
  color: var(--sfdt-color-warning-text);
}
.sfdt-callout.sfdt-bad {
  border-color: var(--sfdt-color-error-border);
  background: var(--sfdt-color-error-bg);
  color: var(--sfdt-color-error-text);
}
.sfdt-callout.sfdt-ok {
  border-color: var(--sfdt-color-success);
  background: var(--sfdt-color-success-bg);
  color: var(--sfdt-color-success-text);
}

/* Padded text block inside a pane — a description line, a hint, a result
   summary. The commonest remaining shape by a distance: 'padding + colour +
   size', spelled a dozen ways. */
.sfdt-prose {
  padding: var(--sfdt-space-3) var(--sfdt-space-4);
  font: var(--sfdt-type-body-sm);
  color: var(--sfdt-color-text);
}
.sfdt-prose.sfdt-muted { color: var(--sfdt-color-text-weak); }
/* Same block with no padding of its own — for a container that already pads. */
.sfdt-flush { padding: 0; }
/* Vertical padding only — a row in a list that supplies its own side gutter. */
.sfdt-flush-x { padding-left: 0; padding-right: 0; }

/* --- rail sections -------------------------------------------------------- */
/* A stack of titled blocks down the side of a split view: object metadata,
   record count, audit, relationships. Each was declaring the same padding and
   divider inline. */
.sfdt-rail-section {
  padding: var(--sfdt-space-4);
  border-bottom: 1px solid var(--sfdt-color-border);
}
.sfdt-rail-section > h3 {
  display: flex;
  align-items: center;
  gap: var(--sfdt-space-2);
  margin: 0 0 var(--sfdt-space-3);
  font: var(--sfdt-type-label-caps);
  letter-spacing: var(--sfdt-tracking-caps);
  text-transform: uppercase;
  color: var(--sfdt-color-text-muted);
}

/* The caveat under a figure: 'approximate', 'assumes Enterprise', 'N not
   shown'. Small, quiet, and always ATTACHED to the thing it qualifies — a
   number whose limitation is a scroll away is a number that gets quoted wrong. */
.sfdt-note {
  font: var(--sfdt-type-body-sm);
  color: var(--sfdt-color-text-weak);
  margin-top: var(--sfdt-space-2);
}

/* Any element that renders a Salesforce error message. Since
   lib/sf-error-guidance.ts those are multi-line — the org's text, then the
   "what to do" line — and HTML collapses the newline without this.
   test/error-render-newlines.test.ts treats this class as satisfying the rule. */
.sfdt-msg { white-space: pre-line; }

/* Applied for the duration of a scripted pan/zoom, then removed. Keep in step
   with the timeout in features/canvas-search.ts. */
.sfdt-animating { transition: transform 0.35s ease; }

/* Scrolls, no chrome — for a region already inside a bordered surface. */
.sfdt-scrollbox { overflow: auto; }

/* A bordered, scrollable inset: a diagram, a preview, a nested list that must
   not grow the pane it sits in. */
.sfdt-frame {
  border: 1px solid var(--sfdt-color-border);
  border-radius: var(--sfdt-radius-md);
  overflow: auto;
}

/* A heading and a list inside a scrolling detail pane, indented to the pane's
   own gutter rather than the card's. */
.sfdt-section-title {
  margin: var(--sfdt-space-5) var(--sfdt-space-4) var(--sfdt-space-2);
  color: var(--sfdt-color-text-strong);
  font: var(--sfdt-type-headline-md);
}
.sfdt-list {
  margin: 0 var(--sfdt-space-4) var(--sfdt-space-4);
  padding-left: var(--sfdt-space-5);
  font: var(--sfdt-type-body-sm);
  color: var(--sfdt-color-text-weak);
}
.sfdt-list > li { margin-bottom: 4px; }
/* A list used purely for grouping — no marker, no indent. */
.sfdt-bare { list-style: none; margin: 0; padding: 0; }

/* --- tables --------------------------------------------------------------- */
.sfdt-table { width: 100%; border-collapse: collapse; }
.sfdt-table th {
  text-align: left;
  padding: var(--sfdt-space-2) var(--sfdt-space-5);
  font: var(--sfdt-type-label-caps);
  letter-spacing: var(--sfdt-tracking-caps);
  text-transform: uppercase;
  color: var(--sfdt-color-text-muted);
  background: var(--sfdt-color-bg);
  border-top: 1px solid var(--sfdt-color-border);
  border-bottom: 1px solid var(--sfdt-color-border);
  /* Unconditional: with no scrolling ancestor 'sticky' lays out exactly like
     'static', so tables in a card are unchanged, and any table that IS in a
     scroll box keeps its header. The opaque 'background' above is what makes
     this legible — rows would otherwise show through. */
  position: sticky;
  top: 0;
  z-index: 1;
}
.sfdt-table td {
  padding: var(--sfdt-space-3) var(--sfdt-space-5);
  border-bottom: 1px solid var(--sfdt-color-border);
  font: var(--sfdt-type-body-sm);
  color: var(--sfdt-color-text);
}
.sfdt-table tbody tr:last-child td { border-bottom: 0; }
.sfdt-table tbody tr:hover { background: var(--sfdt-color-surface-shade-2); }
.sfdt-table td.sfdt-cell-code { font: var(--sfdt-type-code-sm); color: var(--sfdt-color-text-weak); }
.sfdt-table td.sfdt-center, .sfdt-table th.sfdt-center { text-align: center; }
/* Numeric column: right-aligned with tabular figures, so digits line up in a
   column you are meant to compare down. */
.sfdt-table td.sfdt-num, .sfdt-table th.sfdt-num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.sfdt-table td.sfdt-nowrap { white-space: nowrap; }
/* A cell whose content is long prose (help text, a formula): bounded, and the
   full value lives in the title attribute. */
.sfdt-table td.sfdt-cell-clip { max-width: 200px; }
.sfdt-table td.sfdt-cell-pre { white-space: pre-wrap; overflow-wrap: anywhere; }
/* Rows whose cells carry stacked detail rather than one value each — the
   baseline alignment a default table gives looks broken there. */
.sfdt-table.sfdt-align-top tbody td, .sfdt-table td.sfdt-align-top { vertical-align: top; }
.sfdt-table td .sfdt-cell-strong {
  display: flex;
  align-items: center;
  gap: var(--sfdt-space-2);
  color: var(--sfdt-color-text-strong);
  font: var(--sfdt-type-body-md);
  font-weight: 600;
}
.sfdt-table td .sfdt-cell-strong .sfdt-glyph { color: var(--sfdt-color-brand-text); display: flex; }

/* --- code editor ---------------------------------------------------------- */
/* Three layers that must agree to the pixel: the gutter counts lines, the
   highlight layer draws them coloured, and the textarea on top owns the caret.
   Font, line-height and vertical padding are therefore declared ONCE here and
   inherited, rather than repeated per layer where they would drift apart.
   Behaviour lives in lib/code-editor.ts. */
.sfdt-editor {
  display: flex;
  min-height: 180px;
  border: 1px solid var(--sfdt-color-border);
  border-radius: var(--sfdt-radius-md);
  background: var(--sfdt-color-bg);
  overflow: hidden;
  font: var(--sfdt-type-code-sm);
  line-height: 1.55;
}
.sfdt-editor:focus-within {
  border-color: var(--sfdt-color-brand);
  outline: 2px solid var(--sfdt-color-info);
  outline-offset: 1px;
}
.sfdt-editor-gutter {
  flex: 0 0 auto;
  min-width: 2.5em;
  padding: var(--sfdt-space-3) var(--sfdt-space-2);
  text-align: right;
  white-space: pre;
  color: var(--sfdt-color-text-disabled);
  background: var(--sfdt-color-surface-alt);
  border-right: 1px solid var(--sfdt-color-border);
  overflow: hidden;
  user-select: none;
}
.sfdt-editor-body { position: relative; flex: 1 1 auto; min-width: 0; }
.sfdt-editor-hl,
.sfdt-editor-input {
  margin: 0;
  padding: var(--sfdt-space-3);
  border: 0;
  font: inherit;
  line-height: inherit;
  white-space: pre;
  tab-size: 2;
}
.sfdt-editor-hl {
  position: absolute;
  inset: 0;
  color: var(--sfdt-color-text);
  overflow: hidden;
  /* Clicks must reach the textarea underneath this layer, not stop here. */
  pointer-events: none;
}
.sfdt-editor-input {
  position: relative;
  display: block;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  resize: none;
  overflow: auto;
  background: transparent;
  /* The glyphs are drawn by the layer below; this element contributes only the
     caret and the selection band. Set both properties: WebKit ignores a plain
     'color' on a textarea in some states, and a visible duplicate of the text
     sitting a hair off the highlight is the ugliest possible failure. */
  color: transparent;
  -webkit-text-fill-color: transparent;
  caret-color: var(--sfdt-color-text);
}
.sfdt-editor-input::placeholder {
  color: var(--sfdt-color-text-muted);
  -webkit-text-fill-color: var(--sfdt-color-text-muted);
}
/* The ring is drawn by the wrapper above, so the inner control must not draw a
   second one inside it. */
.sfdt-editor-input:focus-visible, .sfdt-editor-input:focus { outline: none; }

.sfdt-tok-k { color: var(--sfdt-color-code-keyword); font-weight: 600; }
.sfdt-tok-t { color: var(--sfdt-color-code-type); }
.sfdt-tok-s { color: var(--sfdt-color-code-string); }
.sfdt-tok-c { color: var(--sfdt-color-code-comment); font-style: italic; }
.sfdt-tok-n { color: var(--sfdt-color-code-number); }
.sfdt-tok-a { color: var(--sfdt-color-code-annotation); }

/* --- console -------------------------------------------------------------- */
/* Monospace output block — a run result, a raw log. Replaces the <pre> whose
   inline style every feature retyped slightly differently. */
.sfdt-console {
  margin: 0;
  padding: var(--sfdt-space-3) var(--sfdt-space-4);
  background: var(--sfdt-color-surface-alt);
  border: 1px solid var(--sfdt-color-border);
  border-radius: var(--sfdt-radius-md);
  color: var(--sfdt-color-text);
  font: var(--sfdt-type-code-sm);
  white-space: pre-wrap;
  overflow: auto;
  max-height: 280px;
}
.sfdt-console.sfdt-error { color: var(--sfdt-color-error-text); }

/* Per-line tinting for a raw Apex debug log. A log is line-oriented rather than
   token-oriented, so classification is by event type and the class goes on the
   whole line — there is nothing to highlight inside it.
   An earlier draft pinned this pane to a dark background in both themes. That
   was dropped: an always-dark surface needs its own foreground palette
   maintained by hand, and the moment anything is drawn *inside* it every
   semantic token below renders wrong (a light-theme '-text-strong' is dark navy
   — invisible on #1e1e1e). Following the theme costs one less palette.

   The tints are inline spans separated by real newline text nodes rather than
   'display: block' rows — the console is already 'pre-wrap', so it lays out the
   same, and it is the only version where selecting the pane copies the log
   instead of one unbroken line. */
.sfdt-log-frame { color: var(--sfdt-color-brand-text); font-weight: 600; }
.sfdt-log-debug {
  color: var(--sfdt-color-text-strong);
  background: var(--sfdt-color-surface-shade-4);
  font-weight: 600;
}
.sfdt-log-error { color: var(--sfdt-color-error-text); }
.sfdt-log-limit { color: var(--sfdt-color-warning-text); }
/* Allocation and statement chatter is most of a FINEST log by volume and almost
   never what anyone opened it to read. Dimmed, not dropped — the lines still
   carry timestamps people count against. */
.sfdt-log-noise { color: var(--sfdt-color-text-muted); }

/* --- drop target ---------------------------------------------------------- */
.sfdt-drop {
  display: flex;
  align-items: center;
  gap: var(--sfdt-space-3);
  padding: var(--sfdt-space-3) var(--sfdt-space-4);
  border: 1px dashed var(--sfdt-color-border);
  border-radius: var(--sfdt-radius-md);
  font: var(--sfdt-type-body-sm);
  color: var(--sfdt-color-text-weak);
}
/* A class rather than an inline background set on dragover, so the hover state
   is declared beside the resting one instead of in an event handler. */
.sfdt-drop.sfdt-drop-over {
  border-color: var(--sfdt-color-brand);
  background: var(--sfdt-color-bg);
}

/* --- view frame ----------------------------------------------------------- */
/* The scroll frame a presentView body needs: fill the card, and let exactly one
   inner region scroll. 'min-height: 0' is the whole point — a flex child
   defaults to min-height:auto, which refuses to shrink below its content, so
   without it the inner region never scrolls and the card grows off-screen
   instead. Every feature that has hit this fixed it inline, differently. */
.sfdt-view-body { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.sfdt-view-main {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--sfdt-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--sfdt-space-4);
}

/* A wide primary column with a narrower rail beside it — the Workspace overview
   and the options page both lay out this way. Collapses to one column when
   there isn't room, which is what keeps it usable in the docked side panel and
   on a narrow options window.
   NOT '.sfdt-split': that is a full-height flex row with independently
   scrolling panes. This is page content that flows and wraps. */
.sfdt-bento {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr);
  gap: var(--sfdt-space-4);
  align-items: start;
}
.sfdt-bento > * { min-width: 0; }
@media (max-width: 900px) {
  .sfdt-bento { grid-template-columns: minmax(0, 1fr); }
}
/* A commit bar pinned to the bottom of the viewport. 'sticky', not 'fixed', so
   it participates in layout and cannot overlap the last card. */
.sfdt-savebar {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sfdt-space-3);
  padding: var(--sfdt-space-3) var(--sfdt-space-6);
  background: var(--sfdt-color-surface);
  border-top: 1px solid var(--sfdt-color-border);
  box-shadow: var(--sfdt-shadow-2);
}

/* A column within the bento — cards stacked down one side. */
.sfdt-bento-col { display: flex; flex-direction: column; gap: var(--sfdt-space-4); min-width: 0; }

/* Auto-fit rather than a fixed column count, because the same DOM is presented
   at two widths: a 4-across strip in a full-width Workspace pane and a 2-across
   block in an 860px modal. A fixed rail would be right in one and cramped in
   the other. */
.sfdt-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--sfdt-space-3);
}
.sfdt-tile .sfdt-tile-label {
  font: var(--sfdt-type-label-caps);
  letter-spacing: var(--sfdt-tracking-caps);
  text-transform: uppercase;
  color: var(--sfdt-color-text-muted);
}
.sfdt-tile .sfdt-meter { margin-top: var(--sfdt-space-2); }

/* Which row a detail pane below is currently showing. 'aria-current' rather
   than a bare class: the fill alone is a colour-only signal, and this is valid
   on any element (unlike aria-selected, which needs a grid role). */
.sfdt-table tbody tr[aria-current="true"],
.sfdt-table tbody tr[aria-current="true"]:hover {
  background: var(--sfdt-color-surface-shade-4);
}

/* --- split layout --------------------------------------------------------- */
/* Master/detail, or master/detail/rail. 'min-height: 0' on both the row and the
   sides for the same reason as '.sfdt-view-body': without it a flex child
   refuses to shrink below its content and the inner panes never scroll.
   Consumers: the Schema Browser (3 columns). features/metadata-retrieve.ts
   hand-rolls the same two-column shape and is the pending second consumer —
   it lands in batch D. */
.sfdt-split { display: flex; flex: 1; min-height: 0; }
.sfdt-split-side {
  display: flex;
  flex-direction: column;
  flex: 0 0 240px;
  /* 'min-width: 0' is load-bearing, exactly like the 'min-height: 0' above it.
     A flex item defaults to 'min-width: auto', which refuses to shrink below
     its CONTENT — so a list of long API names ('AccountContactRoleChangeEvent')
     pushed this pane to ~985px and squeezed the field table down to two visible
     columns, despite the 240px basis. The basis is a request; this is what
     makes it binding. */
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--sfdt-color-border);
}
/* The trailing rail: the border moves to the other edge. */
/* The trailing rail runs wider than the leading one: it carries label/value
   rows and a diagram, where the object list only needs a name. */
.sfdt-split-side.sfdt-split-end {
  flex: 0 0 300px;
  border-right: 0;
  border-left: 1px solid var(--sfdt-color-border);
  overflow-y: auto;
}
.sfdt-split-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
/* Two equal columns rather than a fixed side and a fluid one. Same 'min-width:
   0' rule as '.sfdt-split-side' — without it the column refuses to shrink below
   its content and the 50/50 silently becomes 80/20. */
.sfdt-split-half {
  flex: 1 1 50%;
  min-width: 0;
  min-height: 0;
  padding: var(--sfdt-space-4);
  overflow: hidden;
}
.sfdt-split-half + .sfdt-split-half { border-left: 1px solid var(--sfdt-color-border); }

/* Label/value row for a rail section. */
.sfdt-kv {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sfdt-space-3);
  padding: 3px 0;
  font: var(--sfdt-type-body-sm);
}
.sfdt-kv .sfdt-kv-key { color: var(--sfdt-color-text-weak); white-space: nowrap; }
.sfdt-kv .sfdt-kv-val {
  color: var(--sfdt-color-text-strong);
  text-align: right;
  min-width: 0;
  overflow-wrap: anywhere;
}

/* Visually hidden, still announced. For a cell whose meaning is carried by an
   icon: the glyph is aria-hidden, so without this the screen-reader user gets
   an empty cell that is indistinguishable from 'false'.
   NOT 'display: none' and NOT 'visibility: hidden' — both remove it from the
   accessibility tree, which is the entire thing being avoided. */
.sfdt-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

/* A fixed-height drawer pinned under the main content — an execution log, a
   console. Its own toolbar header sits flush, so that loses its bottom rule. */
.sfdt-drawer {
  flex: 0 0 auto;
  border-top: 1px solid var(--sfdt-color-border);
  min-height: 0;
}
.sfdt-drawer > .sfdt-toolbar { border-bottom: 0; }

/* --- tabs ----------------------------------------------------------------- */
/* A horizontal tab strip. NOT '.sfdt-nav-item', which is a vertical sidebar row:
   it is full-width and marks the current item with a LEFT border, so used in a
   horizontal row every tab stretches and the active indicator points the wrong
   way. That shipped, from a bulk migration that matched on "row button with an
   active state" and missed that the axis is the whole difference.
   'aria-current' is both the accessible state and the style hook. */
.sfdt-tabs {
  display: flex;
  gap: var(--sfdt-space-1);
  padding: 0 var(--sfdt-space-2);
  background: var(--sfdt-color-bg);
  border-bottom: 1px solid var(--sfdt-color-border);
}
.sfdt-tab {
  padding: var(--sfdt-space-3) var(--sfdt-space-5);
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--sfdt-color-text-weak);
  font: var(--sfdt-type-body-sm);
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.sfdt-tab:hover { color: var(--sfdt-color-text-strong); }
.sfdt-tab:focus-visible { outline: 2px solid var(--sfdt-color-info); outline-offset: -2px; }
.sfdt-tab[aria-current='page'] {
  color: var(--sfdt-color-brand-text);
  border-bottom-color: var(--sfdt-color-brand);
}

/* --- spinner -------------------------------------------------------------- */
/* Lives here so the keyframes are declared ONCE. features/metadata-retrieve.ts
   appended its own <style> to doc.head on every open() and never removed it, so
   re-opening the tool ten times left ten identical keyframe blocks behind. */
.sfdt-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--sfdt-color-bg);
  border-top-color: var(--sfdt-color-brand);
  border-radius: var(--sfdt-radius-pill);
  animation: sfdt-spin 1s linear infinite;
}
@keyframes sfdt-spin { to { transform: rotate(360deg); } }
/* Respect the OS setting: a perpetual spinner is a common vestibular trigger,
   so it becomes a static ring rather than disappearing (it still marks "busy"). */
@media (prefers-reduced-motion: reduce) {
  .sfdt-spinner { animation: none; }
}

/* --- navigation ----------------------------------------------------------- */
.sfdt-nav-item {
  display: flex;
  align-items: center;
  gap: var(--sfdt-space-3);
  width: 100%;
  padding: 10px var(--sfdt-space-3);
  border: 0;
  border-left: 3px solid transparent;
  border-radius: 0 var(--sfdt-radius-md) var(--sfdt-radius-md) 0;
  background: none;
  text-align: left;
  font: var(--sfdt-type-body-md);
  color: var(--sfdt-color-text);
  cursor: pointer;
}
.sfdt-nav-item:hover { background: var(--sfdt-color-surface-shade-3); }
.sfdt-nav-item:focus-visible { outline: 2px solid var(--sfdt-color-info); outline-offset: -2px; }
/* A listbox option states "this one" with aria-selected, a nav item with
   aria-current. Same visual, two correct spellings — the Schema Browser's
   object list is a real listbox, not navigation. */
.sfdt-nav-item[aria-current="page"],
.sfdt-nav-item[aria-selected="true"] {
  background: var(--sfdt-color-surface-shade-3);
  border-left-color: var(--sfdt-color-brand);
  color: var(--sfdt-color-brand-text);
  font-weight: 600;
}
.sfdt-nav-item .sfdt-nav-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* A two-line nav item (label over API name) puts the text in CHILDREN, so the
   ellipsis has to be on them — it applies to the box that holds the text, and
   the wrapper holds only boxes. */
.sfdt-nav-item .sfdt-nav-label > * {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sfdt-nav-item .sfdt-nav-trail { margin-left: auto; }
.sfdt-glyph { display: flex; flex: 0 0 auto; }
`;

/**
 * Idempotently inject the component stylesheet into a document's head. Mirrors
 * `ensureTokens(doc)` in lib/tokens.ts, and depends on it — the components
 * reference `var(--sfdt-*)` throughout, so tokens must be present in the same
 * document (or an ancestor, since custom properties inherit into shadow trees).
 *
 * Safe to call repeatedly.
 */
export function ensureComponentStyles(doc: Document = document): void {
  if (doc.getElementById(COMPONENT_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = COMPONENT_STYLE_ID;
  style.textContent = SFDT_COMPONENT_CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}
