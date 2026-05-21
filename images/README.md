# sfdt Brand Assets

Source of truth for sfdt logos, marks, icons, and social cards. Every asset is provided in three formats — pick the right one for the surface.

## Quick reference

| Asset | Use it for | Don't use it for |
|---|---|---|
| `sfdt_full_logo` | README hero, docs site header, landing page, footer with attribution, marketing one-pagers | Anywhere too small to read "sfdt" (under ~120px wide) — use a mark instead |
| `sfdt_mark_white` | Dark UI surfaces, dark-mode favicon, social avatars on dark, terminal art, single-color light-on-dark print | Light backgrounds (it's white — it will disappear) |
| `sfdt_mark_black` | Light UI surfaces, light-mode favicon, single-color dark-on-light print, monochrome documents | Dark backgrounds (use the white mark instead) |
| `sfdt_extension_icon` | Master source for the Chrome extension tile (see `icons/` for the 4 manifest sizes), extension popup header | Anywhere needing the wordmark — this is the icon only. Do not link this 1MB master directly from `manifest.json`; use the resized files in `icons/` |
| `icons/icon-{16,32,48,128}.png` | Direct references in Chrome `manifest.json` — these are the only files the browser should actually load | Marketing or docs — they're tiny and will look mushy when scaled up |
| `sfdt_chrome_store` | Chrome Web Store listing tile (440×280 promo, 128×128 store icon), README hero image, marketing/blog post thumbnails | Inside the extension itself — the shadow won't render correctly on toolbar backgrounds |
| `sfdt_open_graph` | `<meta property="og:image">`, `<meta name="twitter:image">`, LinkedIn share preview, GitHub repo social preview (1200×630) | Anywhere not 1.91:1 — it will crop badly. Use a different asset for square or vertical surfaces |

## Format guidance

Each asset exists as `.png`, `.svg`, and (for originals) `.jpg`. Choose by context:

- **SVG** — preferred for the wordmark and the two marks (`sfdt_mark_white`, `sfdt_mark_black`). They are 3–4 KB, scale infinitely, and stay crisp at every size.
- **PNG** — required for Chrome extension manifest icons, OpenGraph cards, and the Chrome Web Store listing. These platforms either demand PNG or render PNG more reliably than SVG.
- **SVG of the gradient assets** (`sfdt_extension_icon.svg`, `sfdt_chrome_store.svg`, `sfdt_open_graph.svg`) is included for completeness but the trace bands the gradients. Prefer the PNG in production.
- **JPG** — original source files from the generator. Kept as archive only. Do not link to them from the app.

## Mark variants

The two single-glyph marks are intentionally different:

- `sfdt_mark_white` uses the **double-chevron** glyph (cloud followed by `»`). This matches the full logo.
- `sfdt_mark_black` uses the **single-chevron** glyph (cloud followed by `›`). This matches the Chrome extension icon.

If you need a matched pair (both double-chevron or both single-chevron in the same color treatment), regenerate the source image with an instruction that the glyph must be identical across all four quadrants.

## Brand colors

| Token | Hex | Use |
|---|---|---|
| Indigo (primary) | `#4F46E5` | Mark fill, primary UI, headings on dark |
| Violet (accent) | `#7C3AED` | Gradient endpoint, accent details inside the mark |
| Indigo (deep) | `#1E1B4B` | OG card top-left gradient stop, dark surfaces |
| Violet (deep) | `#4C1D95` | OG card bottom-right gradient stop |
| Light violet | `#C4B5FD` | Tagline text on dark surfaces |

The standard gradient is a diagonal from `#4F46E5` (top-left) to `#7C3AED` (bottom-right) for icons, and from `#1E1B4B` to `#4C1D95` for the OpenGraph card background.

## Recommended sizes

### Chrome extension (`manifest.json`)

The 4 manifest sizes are pre-built in `icons/`. Reference them directly:

```json
{
  "icons": {
    "16": "images/icons/icon-16.png",
    "32": "images/icons/icon-32.png",
    "48": "images/icons/icon-48.png",
    "128": "images/icons/icon-128.png"
  }
}
```

A note on 16×16 legibility: at toolbar size the cloud+chevron is unavoidably mushy — there are only ~12 usable pixels after accounting for the rounded corners. This is a constraint of every Chrome extension icon, not a build issue. If 16px clarity becomes critical, commission a **simplified single-glyph variant** designed natively at 16×16 (typically a stylized "S" or just the chevron arrow) rather than expecting the full mark to scale down.

### Chrome Web Store listing

- Store icon: 128×128 (`sfdt_extension_icon.png` resized)
- Small promo tile: 440×280 (`sfdt_chrome_store.png` resized — keep the shadow)
- Marquee promo tile: 1400×560 (commission a new asset; this one isn't designed for that ratio)

### Web app

- Favicon: `sfdt_mark_black.svg` (light theme) and `sfdt_mark_white.svg` (dark theme), served via `<link rel="icon">` with `media="(prefers-color-scheme: ...)"`
- Apple touch icon: 180×180, resize from `sfdt_chrome_store.png`
- OG image: `sfdt_open_graph.png` at 1200×630, served as a static asset

## Don'ts

- Do not recolor the marks. The indigo (`#4F46E5`) is the brand color — keep it.
- Do not place the wordmark on a busy background. Use the mark alone instead.
- Do not vectorize the OG card and use the SVG. The gradient bands; PNG is correct.
- Do not edit the JPG originals — they're frozen. Edit the PNG or SVG and regenerate.
- Do not embed the 1MB extension icon PNG in HTML. Resize to the size you actually need.
