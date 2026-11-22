#!/usr/bin/env python3
"""Put two window captures side by side, labelled, for a visual diff.

Usage: side-by-side.py <electron.png> <markie-rs.png> <out.png> [--diff <diff.png>]
--diff also writes a per-pixel difference image (both scaled to the first's size).
Needs Pillow (the pyenv python3 on this Mac has it).
"""
import sys
from PIL import Image, ImageChops, ImageDraw

args = sys.argv[1:]
diff_out = None
if "--diff" in args:
    i = args.index("--diff"); diff_out = args[i + 1]; del args[i:i + 2]
left, right, out = Image.open(args[0]).convert("RGB"), Image.open(args[1]).convert("RGB"), args[2]
h = max(left.height, right.height); pad = 40
canvas = Image.new("RGB", (left.width + right.width + 20, h + pad), (128, 128, 128))
canvas.paste(left, (0, pad)); canvas.paste(right, (left.width + 20, pad))
d = ImageDraw.Draw(canvas)
d.text((10, 10), "Electron Markie", fill=(0, 0, 0)); d.text((left.width + 30, 10), "Markie RS", fill=(0, 0, 0))
canvas.save(out)
if diff_out:
    r = right.resize(left.size) if right.size != left.size else right
    ImageChops.difference(left, r).save(diff_out)
print(out)
