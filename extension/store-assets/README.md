# Chrome Web Store assets

Single source of truth for the `@sfdt/extension` Chrome Web Store **submission**.
Everything the CWS dashboard needs, version-controlled so it's diffable per release.

| File | What it is | CWS field |
|------|------------|-----------|
| `listing.md` | Item name, summary, detailed description, category, single-purpose, permission justifications, distribution | Listing + Privacy tabs |
| `store-icon-128.png` | 128×128 store icon (copy of `../public/icon/128.png`) | Store icon |
| `final_01`–`final_16*.png` | Screenshots (1280×800) | Screenshots |

## Keeping it in sync

- `listing.md` carries a **Store-sync status** note at the top — update it whenever the live store and this file diverge (e.g. after a release that adds features).
- This is the copy you paste into the CWS dashboard during the **manual upload** (the publish step in `.github/workflows/extension.yml` is a stub until CWS API secrets are configured).

## Do NOT move the runtime icons here

The extension's **runtime** icons live in `../public/icon/{16,32,48,128}.png` — wxt copies them into the build and the manifest references them, so they must stay there. `store-icon-128.png` here is a deliberate copy for the *store listing* (CWS uploads the store icon separately from the packaged icon).

## Screenshot set

`final_01`–`final_05` (May 23) cover flow/setup-era features. `final_06`–`final_16` were captured for 0.3.0 (1280×800, cover-cropped from 2× Retina originals kept locally in `_raw/`, which is gitignored):

- **0.3.0 Workspace:** `final_06` home, `final_07` Execute Anonymous Apex, `final_08` Debug Log Viewer, `final_09` Multi-Org Switcher, `final_10` Saved SOQL.
- **0.1.0 + 0.2.0:** `final_11` inspect-record, `final_12` data-import, `final_13` field-creator, `final_14` metadata-retrieve, `final_15` soap-explore, `final_16` event-monitor.

> CWS displays a max of **5** screenshots; the set above is a source pool. Suggested 5 to feature (lead with the Workspace story): `final_06`, `final_09`, `final_07`, `final_11`, `final_13`.

## Optional enhancements (not blocking submission)

The screenshot set above is submission-ready. Nice-to-haves, none required:

- A dedicated `final_17` for **Copy Schema for Prompt** (`export-for-prompt`) — it's already visible in the `final_06` Workspace nav, so a standalone shot is optional (menu label is "Copy Schema for Prompt", not "Export…").
- CWS promo tiles (440×280 small; 1400×560 marquee) — none exist yet.
