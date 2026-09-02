#!/usr/bin/env python3
"""Regenerate the Chrome Web Store promo tiles.

The tiles bake the item name and the feature count into pixels, so both go stale
silently — a dashboard edit cannot fix them. This script rebuilds them from the
runtime icon plus two inputs that are read, never typed:

  * the feature count, from generated/chrome-features.json
  * the item name, from extension/listing.md's "## Item name" section

Two sizes, both required by CWS to be 24-bit RGB with no alpha:

  small    440x280  — shown in search results and category pages (required)
  marquee  1400x560 — only shown if Google features the listing (optional)

The small tile's geometry was measured off the 0.10.0-era art so rebuilds keep
that layout rather than drifting. The marquee is authored, not scaled: 2.5:1 is
a different composition from 1.57:1, so its numbers stand on their own.

Usage:  python3 make-promo-tile.py [--check] [--size small|marquee|all]
        --check verifies the committed PNGs match what this script produces
                (byte-identical), and exits non-zero if any has drifted.
"""

import argparse
import io
import json
import pathlib
import re
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = pathlib.Path(__file__).resolve().parent
EXT = HERE.parent
REPO = EXT.parent

ICON = EXT / "public" / "icon" / "128.png"
CATALOG = REPO / "generated" / "chrome-features.json"
LISTING = EXT / "listing.md"

# The background is a bilinear blend of four corner colours, not a simple
# diagonal ramp. These were least-squares fitted to the 0.10.0 tile's clean
# background pixels (rmse 4.7; a naive diagonal ramp scored 19.7). Colours are
# size-independent, so both tiles share them.
GRAD_TL, GRAD_TR = (0x4D, 0x3E, 0xC3), (0x85, 0x6E, 0xF3)
GRAD_BL, GRAD_BR = (0x58, 0x4F, 0xE1), (0x7C, 0x4B, 0xEE)

SPECS = {
    # Measured off the shipped 0.10.0 tile — keep stable so rebuilds don't drift.
    "small": dict(
        out="promo-small-440x280.png",
        size=(440, 280),
        pill=(40, 36, 190, 66),          # x0, y0, x1, y1 — fully rounded
        tile_xy=(40, 92), tile_wh=96, tile_r=22,   # white rounded square
        icon_xy=(58, 110), icon_wh=60,
        # Soft drop shadow under the white tile, profiled off the original: ~0.81
        # brightness right at the lower edge, back to 1.0 by ~18px below.
        shadow_offset=(0, 6), shadow_blur=10, shadow_alpha=80,
        text_x=161, pill_pad=7,
        y_wordmark=95, y_name=143, y_tag1=185, y_tag2=206,
        f_pill=13, f_wordmark=40, f_name=24, f_tag=15,
        dots_y=232, dots_x=16, dots_step=12, dots_r=2,
    ),
    # Authored for 2.5:1, not scaled from the small tile. The lockup centres on
    # both axes — left-anchoring it the way the 440x280 does leaves the right
    # half of a 1400px canvas visibly empty — and runs bigger, since the marquee
    # is only ever displayed large.
    "marquee": dict(
        out="promo-marquee-1400x560.png",
        size=(1400, 560),
        pill=(623, 128, 899, 172),
        tile_xy=(413, 192), tile_wh=176, tile_r=40,
        icon_xy=(446, 225), icon_wh=110,
        shadow_offset=(0, 11), shadow_blur=18, shadow_alpha=80,
        text_x=623, pill_pad=10,
        y_wordmark=190, y_name=282, y_tag1=356, y_tag2=394,
        f_pill=22, f_wordmark=76, f_name=44, f_tag=26,
        dots_y=470, dots_x=28, dots_step=20, dots_r=3,
    ),
}

FONTS_BOLD = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Helvetica.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]
FONTS_REG = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def font(paths, size):
    for p in paths:
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    raise SystemExit(f"no usable font among {paths}")


def feature_count() -> int:
    data = json.loads(CATALOG.read_text())
    feats = data["features"] if isinstance(data, dict) and "features" in data else data
    return len(feats)


def item_name() -> str:
    m = re.search(r"^## Item name\n(.+?)$", LISTING.read_text(), re.M)
    if not m:
        raise SystemExit("could not read '## Item name' from listing.md")
    return m.group(1).strip()


def gradient(size) -> Image.Image:
    """Bilinear blend of the four fitted corner colours."""
    w, h = size
    img = Image.new("RGB", size)
    px = img.load()
    for y in range(h):
        v = y / (h - 1)
        top = [a + (b - a) * v for a, b in zip(GRAD_TL, GRAD_BL)]
        bot = [a + (b - a) * v for a, b in zip(GRAD_TR, GRAD_BR)]
        for x in range(w):
            u = x / (w - 1)
            px[x, y] = tuple(round(a + (b - a) * u) for a, b in zip(top, bot))
    return img


def rounded(size, box, radius, fill):
    """An RGBA layer holding one rounded rectangle, for alpha compositing."""
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle(box, radius=radius, fill=fill)
    return layer


def build(spec) -> Image.Image:
    name, count = item_name(), feature_count()
    # "SFDT for Salesforce" renders as a bold wordmark plus a lighter qualifier.
    wordmark, _, qualifier = name.partition(" ")

    size = spec["size"]
    w, h = size
    pill = spec["pill"]
    img = gradient(size)

    # Dot texture along the lower band — subtle, matches the original art.
    dots = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(dots)
    step, r = spec["dots_step"], spec["dots_r"]
    for gy in range(spec["dots_y"], h, step):
        for gx in range(spec["dots_x"], w, step):
            d.ellipse([gx, gy, gx + r, gy + r], fill=(255, 255, 255, 26))
    img = Image.alpha_composite(img.convert("RGBA"), dots)

    img = Image.alpha_composite(img, rounded(size, pill, (pill[3] - pill[1]) // 2,
                                             (255, 255, 255, 48)))
    tx, ty = spec["tile_xy"]
    tw = spec["tile_wh"]
    box = [tx, ty, tx + tw, ty + tw]

    ox, oy = spec["shadow_offset"]
    shadow = rounded(size, [box[0] + ox, box[1] + oy, box[2] + ox, box[3] + oy],
                     spec["tile_r"], (0, 0, 0, spec["shadow_alpha"]))
    img = Image.alpha_composite(img, shadow.filter(
        ImageFilter.GaussianBlur(spec["shadow_blur"])))

    img = Image.alpha_composite(img, rounded(size, box, spec["tile_r"],
                                             (255, 255, 255, 255)))

    iw = spec["icon_wh"]
    icon = Image.open(ICON).convert("RGBA").resize((iw, iw), Image.LANCZOS)
    img.alpha_composite(icon, spec["icon_xy"])

    draw = ImageDraw.Draw(img)
    pill_text = f"{count} features · opt-in"
    f_pill = font(FONTS_REG, spec["f_pill"])
    pw = draw.textlength(pill_text, font=f_pill)
    draw.text(((pill[0] + pill[2]) / 2 - pw / 2, pill[1] + spec["pill_pad"]),
              pill_text, font=f_pill, fill=(255, 255, 255, 235))

    x = spec["text_x"]
    draw.text((x, spec["y_wordmark"]), wordmark, font=font(FONTS_BOLD, spec["f_wordmark"]),
              fill=(255, 255, 255, 255))
    draw.text((x, spec["y_name"]), qualifier, font=font(FONTS_REG, spec["f_name"]),
              fill=(255, 255, 255, 224))
    f_tag = font(FONTS_REG, spec["f_tag"])
    draw.text((x, spec["y_tag1"]), "Productivity tools for Salesforce",
              font=f_tag, fill=(255, 255, 255, 200))
    draw.text((x, spec["y_tag2"]), "admins & developers",
              font=f_tag, fill=(255, 255, 255, 200))

    return img.convert("RGB")  # CWS: 24-bit RGB, no alpha


def render(spec) -> bytes:
    buf = io.BytesIO()
    build(spec).save(buf, "PNG", optimize=True)
    return buf.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="fail if a committed PNG differs from a fresh build")
    ap.add_argument("--size", choices=[*SPECS, "all"], default="all")
    args = ap.parse_args()

    names = list(SPECS) if args.size == "all" else [args.size]
    stale = []
    for n in names:
        spec = SPECS[n]
        out = HERE / spec["out"]
        fresh = render(spec)

        if args.check:
            if not out.exists():
                stale.append(f"{out.name} is missing")
            elif out.read_bytes() != fresh:
                stale.append(f"{out.name} is stale")
            else:
                print(f"{out.name} is current")
            continue

        out.write_bytes(fresh)
        w, h = spec["size"]
        print(f"wrote {out.relative_to(REPO)} — {w}x{h} RGB, {len(fresh):,} bytes")

    if stale:
        sys.exit("; ".join(stale) +
                 f" — re-run: python3 {pathlib.Path(__file__).name}")
    if args.check:
        print(f"({item_name()}, {feature_count()} features)")


if __name__ == "__main__":
    main()
