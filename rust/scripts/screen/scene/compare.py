#!/usr/bin/env python3
"""Compare an Electron and a Markie RS scene frame of the same size.

Usage: compare.py <electron.png> <rs.png> <out-prefix> [x y w h]
The box is in points (1280x820 window); default is the whole frame.
Writes <out-prefix>-sbs.png (side by side, labelled) and <out-prefix>-diff.png
(per-pixel difference, amplified), and prints the share of pixels that differ.
Needs Pillow (the pyenv python3 has it).
"""
import sys
from PIL import Image, ImageChops, ImageDraw

e, r, out = Image.open(sys.argv[1]).convert("RGB"), Image.open(sys.argv[2]).convert("RGB"), sys.argv[3]
if r.size != e.size:
    r = r.resize(e.size)
scale = e.width / 1280
if len(sys.argv) >= 8:
    x, y, w, h = (float(v) * scale for v in sys.argv[4:8])
    box = (int(x), int(y), int(x + w), int(y + h))
    e, r = e.crop(box), r.crop(box)
pad = 36
canvas = Image.new("RGB", (e.width * 2 + 20, e.height + pad), (128, 128, 128))
canvas.paste(e, (0, pad)); canvas.paste(r, (e.width + 20, pad))
d = ImageDraw.Draw(canvas)
d.text((10, 10), "Electron Markie 0.9.7 (headless renderer)", fill=(0, 0, 0))
d.text((e.width + 30, 10), "Markie RS (scene)", fill=(0, 0, 0))
canvas.save(out + "-sbs.png")
diff = ImageChops.difference(e, r)
diff.point(lambda v: min(255, v * 4)).save(out + "-diff.png")
px = list(diff.convert("L").tobytes())
changed = sum(1 for v in px if v > 24)
print(f"{out}-sbs.png  differing pixels: {100 * changed / len(px):.2f}%")
