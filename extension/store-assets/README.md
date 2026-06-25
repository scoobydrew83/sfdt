# Chrome Web Store assets

Single source of truth for the `@sfdt/extension` Chrome Web Store **submission**.
Everything the CWS dashboard needs, version-controlled so it's diffable per release.

| File | What it is | CWS field |
|------|------------|-----------|
| `listing.md` | Item name, summary, detailed description, category, single-purpose, permission justifications, distribution | Listing + Privacy tabs |
| `store-icon-128.png` | 128×128 store icon (copy of `../public/icon/128.png`) | Store icon |
| `final_01`–`final_16*.png` | Screenshots (1280×800) | Screenshots |
| `promo-small-440x280.png` | 440×280 small promo tile (24-bit RGB, no alpha) | Promotional → Small promo tile |

## Keeping it in sync

- `listing.md` carries a **Store-sync status** note at the top — update it whenever the live store and this file diverge (e.g. after a release that adds features).
- This is the copy you paste into the CWS dashboard during the **manual upload** (the publish step in `.github/workflows/extension.yml` is a stub until CWS API secrets are configured).

## Do NOT move the runtime icons here

The extension's **runtime** icons live in `../public/icon/{16,32,48,128}.png` — wxt copies them into the build and the manifest references them, so they must stay there. `store-icon-128.png` here is a deliberate copy for the *store listing* (CWS uploads the store icon separately from the packaged icon).

## Screenshot set

`final_01`–`final_05` (May 23) cover flow/setup-era features. `final_06`–`final_16` were captured for 0.3.0 (1280×800, cover-cropped from 2× Retina originals kept locally in `_raw/`, which is gitignored):

- **0.3.0 Workspace:** `final_06` home, `final_07` Execute Anonymous Apex, `final_08` Debug Log Viewer, `final_09` Multi-Org Switcher, `final_10` Saved SOQL.
- **0.1.0 + 0.2.0:** `final_11` inspect-record, `final_12` data-import, `final_13` field-creator, `final_14` metadata-retrieve, `final_15` soap-explore, `final_16` event-monitor.

> CWS displays a max of **5** screenshots; the set above is a source pool.
>
> **Suggested 5 to feature** (carousel order — covers both admin + dev personas and the Flow → Workspace → 0.3.2 arc, with no empty/error/PII frames):
> 1. `final_06` — Workspace home (hero: all 13 tools + the "runs in its own tab" value prop)
> 2. `final_01` — Flow Builder missing-description flags (flagship Flow visual)
> 3. `final_07` — Execute Anonymous Apex (developer appeal)
> 4. `final_11` — Inspect Record / Show All Data (admin appeal)
> 5. `final_18` — Org Limits (governor-limit usage at a glance; monitoring appeal)
>
> The newest 0.3.2 **Org Health** panel does not have a screenshot yet (see Optional enhancements); once captured as `final_19` it's a candidate to swap into slot 5.
>
> **Avoid** for the featured 5: `final_14` (shows an API-version error), `final_15` (leaks a real email/org in the SOAP response), and the empty-state shots `final_04` / `final_08` / `final_16`.

## Optional enhancements (not blocking submission)

The screenshot set above is submission-ready. Nice-to-haves, none required:

- A dedicated `final_17` for **Copy Schema for Prompt** (`export-for-prompt`) — it's already visible in the `final_06` Workspace nav, so a standalone shot is optional (menu label is "Copy Schema for Prompt", not "Export…"). Not captured.
- A shot of the **Org Health** panel (`org-health`, added in 0.3.2) — **capture pending** (1280×800 of the audit/monitor snapshot side panel); slated for `final_19` once taken. (`final_18` is the Org Limits shot.)
- CWS promo tiles: **small 440×280 done** (`promo-small-440x280.png`). Marquee 1400×560 — not created; only needed if Google features the listing in the homepage carousel (not worth it for a niche dev tool).
