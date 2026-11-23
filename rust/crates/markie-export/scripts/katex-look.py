#!/usr/bin/env python3
"""Compare the captures katex-look.mjs wrote, Electron against Markie RS.

Usage: katex-look.py <captures dir>
For each theme: page heights, every formula's box (position and size in CSS
px), and the pixels of the whole page and of each formula. A pixel differs
when any channel is more than 24 apart (font smoothing stays under that).
Writes <theme>-sbs.png, <theme>-diff.png (amplified) and summary.txt.
Needs Pillow (the pyenv python3 has it).
"""
import json, sys
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw

out = Path(sys.argv[1])
report = json.loads((out / "boxes.json").read_text())
lines = [f"Chromium {report['chromium']}"]

def differing(a, b):
    d = ImageChops.difference(a, b).convert("L")
    hist = d.histogram()
    return sum(hist[25:]), d.width * d.height, max(i for i, n in enumerate(hist) if n)

worst = 0.0
for theme in ["light", "dark"]:
    e_facts, r_facts = report["pages"][f"katex.{theme}.electron"], report["pages"][f"katex.{theme}.rs"]
    e = Image.open(out / f"katex.{theme}.electron.png").convert("RGB")
    r = Image.open(out / f"katex.{theme}.rs.png").convert("RGB")
    lines.append(f"\n{theme}: page height {e_facts['height']} (Electron) vs {r_facts['height']} (Markie RS) CSS px; capture {e.size} vs {r.size}")
    lines.append(f"  fonts loaded, Electron: {', '.join(sorted(set(e_facts['fonts'])))}")
    lines.append(f"  fonts loaded, Markie RS: {', '.join(sorted(set(r_facts['fonts'])))}")
    if e.size == r.size:
        n, total, peak = differing(e, r)
        lines.append(f"  whole page: {n} of {total} pixels differ ({100 * n / total:.4f}%), largest channel difference {peak}")
        worst = max(worst, 100 * n / total)
        diff = ImageChops.difference(e, r).point(lambda v: min(255, v * 8))
        diff.save(out / f"{theme}-diff.png")
    canvas = Image.new("RGB", (e.width + r.width + 20, max(e.height, r.height) + 40), (128, 128, 128))
    canvas.paste(e, (0, 40)); canvas.paste(r, (e.width + 20, 40))
    d = ImageDraw.Draw(canvas)
    d.text((10, 12), f"Electron Markie 0.9.7, KaTeX 0.19.1 ({theme})", fill=(0, 0, 0))
    d.text((e.width + 30, 12), f"Markie RS, katex-rs ({theme})", fill=(0, 0, 0))
    canvas.save(out / f"{theme}-sbs.png")
    ef, rf = e_facts["formulas"], r_facts["formulas"]
    lines.append(f"  formulas: {len(ef)} (Electron) vs {len(rf)} (Markie RS)")
    moved = 0
    for i, (a, b) in enumerate(zip(ef, rf)):
        delta = max(abs(a[k] - b[k]) for k in ("x", "y", "w", "h"))
        box = tuple(int(v * 2) for v in (a["x"], a["y"], a["x"] + a["w"], a["y"] + a["h"]))
        n, total, peak = differing(e.crop(box), r.crop(box)) if box[2] > box[0] and box[3] > box[1] else (0, 1, 0)
        if delta > 0.01 or n:
            moved += 1
        lines.append(f"  {i:2} {a['kind']:<14} box delta {delta:.3f} px, {n:4} of {total:6} px differ, peak {peak:3}  {a['tex'][:60]!r}")
    lines.append(f"  formulas that moved or differ: {moved}")
summary = "\n".join(lines)
(out / "summary.txt").write_text(summary + "\n")
print(summary)
