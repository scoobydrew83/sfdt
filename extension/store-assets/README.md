# Chrome Web Store assets

Single source of truth for the `@sfdt/extension` Chrome Web Store **submission**.
Everything the CWS dashboard needs, version-controlled so it's diffable per release.

| File | What it is | CWS field |
|------|------------|-----------|
| `listing.md` | Item name, summary, detailed description, category, single-purpose, permission justifications, distribution | Listing + Privacy tabs |
| `store-icon-128.png` | 128×128 store icon (copy of `../public/icon/128.png`) | Store icon |
| `final_01`–`final_05*.png` | Screenshots (1280×800 / 640×400) | Screenshots |

## Keeping it in sync

- `listing.md` carries a **Store-sync status** note at the top — update it whenever the live store and this file diverge (e.g. after a release that adds features).
- This is the copy you paste into the CWS dashboard during the **manual upload** (the publish step in `.github/workflows/extension.yml` is a stub until CWS API secrets are configured).

## Do NOT move the runtime icons here

The extension's **runtime** icons live in `../public/icon/{16,32,48,128}.png` — wxt copies them into the build and the manifest references them, so they must stay there. `store-icon-128.png` here is a deliberate copy for the *store listing* (CWS uploads the store icon separately from the packaged icon).

## TODO before next submission

- Refresh/add screenshots for features shipped since the current set was captured (0.1.0 + 0.2.0): `inspect-record`, `data-import`, `field-creator`, `metadata-retrieve`, `soap-explore`, `event-monitor`, `export-for-prompt`.
- Optional: add CWS promo tiles (440×280 small; 1400×560 marquee) — none exist yet.
