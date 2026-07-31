# Chrome Web Store assets

Single source of truth for the `@sfdt/extension` Chrome Web Store **submission**.
Everything the CWS dashboard needs, version-controlled so it's diffable per release.

| File | What it is | CWS field |
|------|------------|-----------|
| `listing.md` | Item name, summary, detailed description, category, single-purpose, permission justifications, distribution | Listing + Privacy tabs |
| `store-icon-128.png` | 128×128 store icon (copy of `../public/icon/128.png`) | Store icon |
| `final_01`–`final_16*.png` | Screenshots (1280×800, 24-bit RGB, no alpha) | Screenshots |
| `promo-small-440x280.png` | 440×280 small promo tile (24-bit RGB, no alpha) — **generated, do not hand-edit** | Promotional → Small promo tile |
| `promo-marquee-1400x560.png` | 1400×560 marquee promo tile (24-bit RGB, no alpha) — **generated, do not hand-edit** | Promotional → Marquee promo tile |
| `make-promo-tile.py` | Regenerates both promo tiles from the catalog + `listing.md` | — |
| `normalize-screenshots.py` | Strips alpha from screenshots and flags any that are off-spec | — |

## Keeping it in sync

- `listing.md` carries a **Store-sync status** note at the top — update it whenever the live store and this file diverge (e.g. after a release that adds features).
- This is the copy you paste into the CWS dashboard. The **zip upload and publish are automated** — `.github/workflows/extension.yml` runs `chrome-webstore-upload-cli` with `--auto-publish` when an `extension/package.json` version bump lands on `main`, using the `CWS_*` secrets in the `extension-release` environment (validate them anytime with the manual `cws-verify` dispatch job, which uploads a draft only). What the workflow **cannot** set is everything in this folder: the listing text, the item title, the screenshots, the promo tile, and the permission justifications are all dashboard fields and still have to be pasted by hand.

## Do NOT move the runtime icons here

The extension's **runtime** icons live in `../public/icon/{16,32,48,128}.png` — wxt copies them into the build and the manifest references them, so they must stay there. `store-icon-128.png` here is a deliberate copy for the *store listing* (CWS uploads the store icon separately from the packaged icon).

## Screenshot set

`final_01`–`final_05` (May 23) cover flow/setup-era features. `final_06`–`final_16` were captured for 0.3.0 (1280×800, cover-cropped from 2× Retina originals kept locally in `_raw/`, which is gitignored):

- **0.3.0 Workspace:** `final_06` home, `final_07` Execute Anonymous Apex, `final_08` Debug Log Viewer, `final_09` Multi-Org Switcher, `final_10` Saved SOQL.
- **0.1.0 + 0.2.0:** `final_11` inspect-record, `final_12` data-import, `final_13` field-creator, `final_16` event-monitor.

`final_14` (metadata-retrieve) and `final_15` (soap-explore) were **deleted pending recapture** — `final_14` showed a live `Invalid Api version specified on URL : /m/v62.0` error (the SOAP bare-version bug, since fixed in `lib/salesforce-api.ts`), and `final_15` exposed a real org id, company name, and email. Recapture both against a scratch org before the next store submission.

> CWS displays a max of **5** screenshots; the set above is a source pool.

### The featured 5 — recapture plan for 0.11.0

**The whole pool is 0.3.x-era and the current featured set now undersells the product.**
Slot 1 (`final_06`) shows a Workspace nav from when there were 13 tools; there are now 45.
Nothing that shipped after 0.3.x has a frame at all.

Only **5** are ever displayed, so recapturing the whole pool is wasted work — capture these
five and the carousel is current:

| Slot | Capture | Replaces | Why this one |
|---|---|---|---|
| 1 | **Workspace home** | `final_06` | Hero. Kills the 13-tool nav — the single most dated frame in the set |
| 2 | **Field Impact Analysis** | — | 0.11.0's headline feature, currently zero coverage |
| 3 | **Schema Browser** | — | Biggest capability gap since 0.3.x |
| 4 | **SOQL Runner, SOSL mode** | — | The other 0.11.0 feature; show the SOQL\|SOSL toggle and per-object grouping |
| 5 | **Command Palette** *or* **side panel** | `final_18` | Both are post-0.3.x with no shot; pick whichever demos better |

**Specs:** **exactly** 1280×800, 24-bit RGB, **no alpha channel**. CWS rejects off-spec
screenshots rather than scaling them, and captures come off at whatever the viewport was
(1280×699, 1280×703, …) with an alpha channel attached. Cover-crop from 2× Retina originals
into `_raw/` (gitignored). Run before submitting:

```bash
python3 normalize-screenshots.py           # drop alpha, resize to 1280×800
python3 normalize-screenshots.py --check   # report only; non-zero exit if off-spec
```

Prefer capturing at an 800px-tall viewport. The script's resize scales straight to the
target rather than cropping, so a short frame stretches vertically — ~14% for a 699px
capture, which on a text-and-panels UI reads as slightly looser line spacing and is fine,
but it is a fallback, not the plan. The aspect-preserving alternative (scale to height,
centre-crop back to 1280) was rejected: it takes ~185px off the width, which on these
frames costs the sidebar edge or the org switcher.

**Capture against a scratch org, never production.** `final_15` was deleted for leaking a
real org id, company name and email — that is the failure mode to design against, not a
hypothetical. Check each frame for org names, usernames, emails and record ids before
committing.

This leaves **Trace Flags** still uncovered. Accepted: it is the least demo-able of the
gaps and there are only five slots.

**Avoid** for the featured 5: the empty-state shots `final_04` / `final_08` / `final_16`,
and anything showing an error state.

### Recapture is not release-blocking

CWS keeps the existing screenshots when none are uploaded, so a release can ship on the
current set. The promo tile is the asset that actually goes wrong on its own — see below.

## Promo tiles — generated, not hand-edited

Both tiles bake the **item name** and the **feature count** into pixels, so both rot
silently and no dashboard edit can fix them. The 0.10.0 tile shipped reading
"SF Helper" and "29 features" while the item was renamed and had grown to 45.

So they are generated rather than maintained:

```bash
python3 make-promo-tile.py                  # rebuild both
python3 make-promo-tile.py --size marquee   # or just one
python3 make-promo-tile.py --check          # fail if a committed PNG has drifted
```

| Tile | Size | When CWS shows it |
|------|------|-------------------|
| `promo-small-440x280.png` | 440×280 | Search results and category pages — **required** |
| `promo-marquee-1400x560.png` | 1400×560 | Only if Google features the listing; uploading it is what makes the item *eligible* for that. Never shown in normal browsing |

The marquee is **authored, not scaled** from the small tile — 2.5:1 is a different
composition from 1.57:1, so its geometry stands on its own in `SPECS["marquee"]`, and its
lockup centres on both axes rather than sitting left like the small tile's (left-anchoring
leaves the right half of a 1400px canvas visibly empty). Both share one `build()`, the
fitted gradient, and the same two read-never-typed strings.

Both strings are **read, never typed** — the count from `generated/chrome-features.json`
and the name from `listing.md`'s `## Item name`. Rename the item or add a feature and the
tile follows on the next run.

The layout, gradient and shadow were measured off the 0.10.0 art so rebuilds do not drift:
the background is a bilinear blend of four least-squares-fitted corner colours (rmse 4.7 —
a naive diagonal ramp scored 19.7), and the drop shadow was profiled from the original's
brightness falloff. Requires Pillow; the icon is composited from `../public/icon/128.png`,
so the tile tracks the runtime icon automatically.

## Optional enhancements (not blocking submission)

The screenshot set above is submission-ready. Nice-to-haves, none required:

- A dedicated `final_17` for **Copy Schema for Prompt** (`export-for-prompt`) — it's already visible in the `final_06` Workspace nav, so a standalone shot is optional (menu label is "Copy Schema for Prompt", not "Export…"). Not captured.
- A shot of the **Org Health** panel (`org-health`, added in 0.3.2) — **capture pending** (1280×800 of the audit/monitor snapshot side panel); slated for `final_19` once taken. (`final_18` is the Org Limits shot.)
- ~~CWS promo tiles: marquee 1400×560 not created.~~ Both tiles are now generated — see above.
