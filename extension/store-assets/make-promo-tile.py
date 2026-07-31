#!/usr/bin/env python3
"""Regenerate promo-small-440x280.png, the Chrome Web Store small promo tile.

The tile bakes the item name and the feature count into pixels, so both go stale
silently — a dashboard edit cannot fix them. This script rebuilds it from the
runtime icon plus two inputs that are read, never typed:

  * the feature count, from generated/chrome-features.json
  * the item name, from extension/listing.md's "## Item name" section

Geometry was measured off the 0.10.0-era tile so the regenerated art keeps the
same layout rather than drifting each time it is rebuilt.

Usage:  python3 make-promo-tile.py [--check]
        --check verifies the committed PNG matches what this script produces
                (byte-identical), and exits non-zero if it has drifted.

CWS requires the small promo tile to be 440x280, 24-bit RGB with no alpha.
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

OUT = HERE / "promo-small-440x280.png"
ICON = EXT / "public" / "icon" / "128.png"
CATALOG = REPO / "generated" / "chrome-features.json"
LISTING = EXT / "listing.md"

W, H = 440, 280

# The background is a bilinear blend of four corner colours, not a simple
# diagonal ramp. These were least-squares fitted to the 0.10.0 tile's clean
# background pixels (rmse 4.7; a naive diagonal ramp scored 19.7).
GRAD_TL, GRAD_TR = (0x4D, 0x3E, 0xC3), (0x85, 0x6E, 0xF3)
GRAD_BL, GRAD_BR = (0x58, 0x4F, 0xE1), (0x7C, 0x4B, 0xEE)

# Soft drop shadow under the white tile, profiled off the original: ~0.81
# brightness right at the lower edge, back to 1.0 by ~18px below.
SHADOW_OFFSET, SHADOW_BLUR, SHADOW_ALPHA = (0, 6), 10, 80

# Measured off the previous tile — keep these stable so rebuilds don't drift.
PILL = (40, 36, 190, 66)  # x0, y0, x1, y1 — fully rounded
TILE_XY, TILE_WH, TILE_R = (40, 92), 96, 22  # white rounded square
ICON_XY, ICON_WH = (58, 110), 60
TEXT_X = 161
Y_WORDMARK, Y_NAME, Y_TAG1, Y_TAG2 = 95, 143, 185, 206

FONTS_BOLD = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Helvetica.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
]
FONTS_REG = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
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


def gradient() -> Image.Image:
    """Bilinear blend of the four fitted corner colours."""
    img = Image.new("RGB", (W, H))
    px = img.load()
    for y in range(H):
        v = y / (H - 1)
        top = [a + (b - a) * v for a, b in zip(GRAD_TL, GRAD_BL)]
        bot = [a + (b - a) * v for a, b in zip(GRAD_TR, GRAD_BR)]
        for x in range(W):
            u = x / (W - 1)
            px[x, y] = tuple(round(a + (b - a) * u) for a, b in zip(top, bot))
    return img


def rounded(size, radius, fill):
    """An RGBA layer holding one rounded rectangle, for alpha compositing."""
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle(size, radius=radius, fill=fill)
    return layer


def build() -> Image.Image:
    name, count = item_name(), feature_count()
    # "SFDT for Salesforce" renders as a bold wordmark plus a lighter qualifier.
    wordmark, _, qualifier = name.partition(" ")

    img = gradient()

    # Dot texture along the lower band — subtle, matches the original art.
    dots = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(dots)
    for gy in range(232, H, 12):
        for gx in range(16, W, 12):
            d.ellipse([gx, gy, gx + 2, gy + 2], fill=(255, 255, 255, 26))
    img = Image.alpha_composite(img.convert("RGBA"), dots)

    img = Image.alpha_composite(img, rounded(PILL, (PILL[3] - PILL[1]) // 2,
                                             (255, 255, 255, 48)))
    tx, ty = TILE_XY
    box = [tx, ty, tx + TILE_WH, ty + TILE_WH]

    ox, oy = SHADOW_OFFSET
    shadow = rounded([box[0] + ox, box[1] + oy, box[2] + ox, box[3] + oy],
                     TILE_R, (0, 0, 0, SHADOW_ALPHA))
    img = Image.alpha_composite(img, shadow.filter(
        ImageFilter.GaussianBlur(SHADOW_BLUR)))

    img = Image.alpha_composite(img, rounded(box, TILE_R, (255, 255, 255, 255)))

    icon = Image.open(ICON).convert("RGBA").resize(
        (ICON_WH, ICON_WH), Image.LANCZOS
    )
    img.alpha_composite(icon, ICON_XY)

    draw = ImageDraw.Draw(img)
    pill_text = f"{count} features · opt-in"
    f_pill = font(FONTS_REG, 13)
    pw = draw.textlength(pill_text, font=f_pill)
    draw.text(((PILL[0] + PILL[2]) / 2 - pw / 2, PILL[1] + 7), pill_text,
              font=f_pill, fill=(255, 255, 255, 235))

    draw.text((TEXT_X, Y_WORDMARK), wordmark, font=font(FONTS_BOLD, 40),
              fill=(255, 255, 255, 255))
    draw.text((TEXT_X, Y_NAME), qualifier, font=font(FONTS_REG, 24),
              fill=(255, 255, 255, 224))
    f_tag = font(FONTS_REG, 15)
    draw.text((TEXT_X, Y_TAG1), "Productivity tools for Salesforce",
              font=f_tag, fill=(255, 255, 255, 200))
    draw.text((TEXT_X, Y_TAG2), "admins & developers",
              font=f_tag, fill=(255, 255, 255, 200))

    return img.convert("RGB")  # CWS: 24-bit RGB, no alpha


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="fail if the committed PNG differs from a fresh build")
    args = ap.parse_args()

    img = build()
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    fresh = buf.getvalue()

    if args.check:
        if not OUT.exists():
            sys.exit(f"{OUT.name} is missing")
        if OUT.read_bytes() != fresh:
            sys.exit(f"{OUT.name} is stale — re-run: python3 {pathlib.Path(__file__).name}")
        print(f"{OUT.name} is current ({item_name()}, {feature_count()} features)")
        return

    OUT.write_bytes(fresh)
    print(f"wrote {OUT.relative_to(REPO)} — {img.size[0]}x{img.size[1]} {img.mode}, "
          f"{len(fresh):,} bytes ({item_name()}, {feature_count()} features)")


if __name__ == "__main__":
    main()
