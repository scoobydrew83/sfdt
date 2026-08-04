# Design mockups

Not shipped code. A throwaway comparison surface for judging dashboard and popup
designs **against the real extension palette** before anything under
`entrypoints/` changes.

```bash
cd extension
npx vite mockups
```

Vite is resolved from the repo root (`node_modules/.bin/vite`), the same one WXT
uses. WXT only scans `entrypoints/`, so this directory never reaches the store
build — verified by diffing `.output/chrome-mv3` file lists with and without it.

Three controls in the top bar: **Screen** (dashboard / popup), **Palette**
(SLDS / Stitch), **Theme** (light / dark / auto).

## What's real and what isn't

| | |
|---|---|
| **Real** | Every `--sfdt-color-*` value — imported live from `lib/tokens.ts`. Edit a token, refresh, see it. |
| **Real** | The theme switch: `data-sfdt-theme` on `<html>`, the exact attribute `lib/theme.ts` writes. `Auto` removes it and lets the sheet's `prefers-color-scheme` block decide. |
| **Real** | Tool labels and ordering — imported from `lib/feature-icons.ts`. |
| **Proposed** | The non-colour scales (`--sfdt-space-*`, `--sfdt-radius-*`, `--sfdt-type-*`, `--sfdt-shadow-*`) in `PROPOSED_TOKENS`. Ported from `../DESIGN.md`, plus a `display`/`metric` step for the larger Stitch hierarchy. |
| **Proposed** | Inline SVG line icons (`icons.ts`) replacing the emoji in `lib/feature-icons.ts`. |
| **A/B** | The Stitch Material-3 palette, behind the `SLDS` / `Stitch` toggle (`STITCH_PALETTE`). |
| **Fixture** | Org limit numbers, chart series, Recent Activity rows. |

## What actually made the difference

The first pass of this mock looked flat next to Stitch's render. The gap was
**not** the palette:

1. **Emoji icons.** `lib/feature-icons.ts` uses 🗂 ⭐ 🪵 ⚡. Stitch uses one
   uniform line-icon family. This was the single biggest tell — replaced by
   `icons.ts`, 24×24 / 1.5px stroke / `currentColor`.
2. **Uncurated nav.** The Workspace sidebar lists all 25 `WORKSPACE_TOOLS`;
   Stitch shows seven and hides the rest behind "All tools".
3. **Timid type scale.** Everything was 13–20px. Stitch runs the greeting at
   30px and metric numerals at 32–36px. Hierarchy is most of "professional".
4. **No chart.** A dashboard without a graph reads as a settings page.

**The palette is close to a no-op.** Flip the toggle in dark mode: Stitch's
`#131313`/`#00a1e0` vs the shipping `#141416`/`#1573cf` differ by a slightly
cooler accent and a darker sidebar. In light mode Stitch is white cards on soft
grey with a saturated blue — which is what SLDS already is. Swapping the palette
would re-render 40+ feature files and force re-tuning the WCAG assertions in
`test/tokens.test.ts` to fix approximately none of items 1–4.

## Why icons are inline SVG, not Material Symbols

Stitch loads Material Symbols from Google Fonts. An MV3 extension cannot: CSP
blocks the request, and it's a third-party network call from a tool that markets
local-only telemetry. Bundling a subset woff2 is possible but adds a binary to
ship, version and audit. Inline SVG has no network, no FOUT, works inside a
shadow root, inherits `currentColor`, and only the icons actually used exist.

Same reason the mock uses the system font stack rather than Inter: on macOS and
Windows the system UI face is close enough that ~100 KB of variable font buys
almost nothing.

## The centralisation gap

`lib/tokens.ts` centralises **colour** and nothing else. Measured across
`features/`, `ui/`, `entrypoints/`, `lib/`:

- **832** inline `element.style.cssText = '…'` assignments
- **4** independently hand-rolled stylesheets — `entrypoints/popup/main.ts`,
  `entrypoints/options/main.ts`, `ui/workspace-host.ts`, `ui/shadow-host.ts`

So there is no shared card, button, table, pill, meter or icon. Every surface
reinvents them, slightly differently each time — which is the structural reason
the UI drifts toward looking hand-made. Whichever design wins, the durable fix is
to grow `lib/` into a real design-system layer:

| Module | Contents |
|---|---|
| `lib/tokens.ts` (exists) | colours **+** the space/radius/type/shadow scales from `PROPOSED_TOKENS` |
| `lib/ui-styles.ts` (new) | one `SFDT_COMPONENT_CSS` string — `.sfdt-card`, `.sfdt-btn`, `.sfdt-pill`, `.sfdt-meter`, `.sfdt-table`, `.sfdt-field` — plus `ensureComponentStyles(doc)`, mirroring `ensureTokens(doc)` |
| `lib/icons.ts` (new) | promote `mockups/icons.ts` |

Surfaces then set a class instead of writing CSS. Migration is incremental —
new and redesigned surfaces adopt it, existing ones convert as they're touched.
A big-bang rewrite of 832 call sites is not the move.

## Known gap

Recent Activity has no data source. `lib/palette-recents.ts` stores command ids
only — no timestamp, resource or status. `mock.ts` defines the `ActivityEntry`
contract and renders fixtures; the backing store (`lib/activity-log.ts`, a
bounded `chrome.storage.local` ring buffer) is a separate change and needs a
`PRIVACY.md` line, since it persists query text locally.

## Source

`~/Downloads/stitch_modern_chrome_extension_interface/` — three Stitch screens
plus the design system, mirrored at `../DESIGN.md`. The Stitch `code.html` files
are reference images only, never a starting point: Tailwind from a CDN `<script>`
(blocked by MV3 CSP), Google Fonts and Material Symbols over the network, and
raw HTML — against this extension's zero-`innerHTML` rule.

One deliberate departure beyond the palette: the Stitch popup drops the
session/bridge status rows. They're kept — they are the popup's only answer to
"why isn't the tool working", and the dot is never the sole signal.

## Deleting this

It's a decision aid. Once a design is picked and the tokens/components are
promoted into `lib/`, delete the directory.
