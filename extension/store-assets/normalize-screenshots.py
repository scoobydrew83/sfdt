#!/usr/bin/env python3
"""Normalize final_*.png screenshots to the Chrome Web Store's exact spec.

CWS accepts screenshots at 1280x800 or 640x400 only, as JPEG or 24-bit PNG with
no alpha — and it rejects, rather than scales, anything off-spec. Browser
captures come off at whatever the viewport was (1280x699, 1280x703, …) with an
alpha channel attached, so they need a pass before submission.

Two fixes:

  * alpha is dropped. macOS/Chrome captures carry the channel even when every
    pixel is opaque, so this is lossless.
  * the frame is resized to 1280x800.

The resize is a straight scale to the target, so nothing is cropped. For a
capture that is already 1280 wide this stretches vertically — ~14% for a 699px
frame — which on a text-and-panels UI reads as slightly looser line spacing.
That is the deliberate trade: the alternative that preserves aspect (scale to
height, centre-crop back to 1280) takes ~185px off the width, which on these
frames means losing the sidebar edge or the org switcher.

Capturing at an 800px-tall viewport avoids the trade entirely and is what the
recapture plan in README.md calls for — this script is the fallback for frames
already taken at the wrong height.

Usage:  python3 normalize-screenshots.py [--check] [FILE ...]
        default targets every final_*.png here
        --check reports without rewriting; non-zero exit if anything is off-spec
"""

import argparse
import pathlib
import sys

from PIL import Image

HERE = pathlib.Path(__file__).resolve().parent
TARGET = (1280, 800)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="*", type=pathlib.Path)
    ap.add_argument("--check", action="store_true",
                    help="report without rewriting")
    args = ap.parse_args()

    files = args.files or sorted(HERE.glob("final_*.png"))
    if not files:
        sys.exit("no final_*.png found")

    offspec = []
    for f in files:
        img = Image.open(f)
        before = f"{img.size[0]}x{img.size[1]} {img.mode}"
        ok = img.size == TARGET and img.mode == "RGB"

        if args.check:
            print(f"{f.name}: {before} {'ok' if ok else 'OFF-SPEC'}")
            if not ok:
                offspec.append(f.name)
            continue

        if ok:
            print(f"skip  {f.name}: {before} already on spec")
            continue

        out = img.convert("RGB")
        if out.size != TARGET:
            out = out.resize(TARGET, Image.LANCZOS)
        out.save(f, "PNG", optimize=True)
        print(f"wrote {f.name}: {before} -> {TARGET[0]}x{TARGET[1]} RGB")

    if offspec:
        sys.exit(f"off-spec: {', '.join(offspec)}")


if __name__ == "__main__":
    main()
