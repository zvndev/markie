#!/usr/bin/env python3
"""Tables in View across styles, fonts, sizes, zoom, page widths and panes.

  table-sweep.py run <out-dir> [file]     draw every combination with scene.sh (SCENE_BIN names the binary)
  table-sweep.py sheet <out-dir> [names]  contact sheets of the frames, by group

Each frame is a `doc` scene with `report: true`, so the scene log says, for
every table drawn, its box width, its rows' width, whether it scrolls, and any
disagreement: rows wider than a box that does not scroll, or a cell's text past
the table's right edge. `run` writes them to <out-dir>/report.txt.

Everything is drawn in the background (docs/rust-port/SCREEN.md). Needs Pillow.
"""
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
STYLES = ["spacious", "compact", "classic", "technical", "editorial", "minimal"]
FONTS = ["system", "sans", "charter", "georgia", "iowan", "helvetica", "mono"]


def combos():
    out = []
    # Every style, both tones, the left panel open and closed.
    for style in STYLES:
        for tone in ("light", "dark"):
            for panel in ("", "skills"):
                out.append(("styles", dict(style=style, tone=tone, panel=panel, size="1280x1000")))
    # Every toolbar font at the smallest and largest sizes, and at 16 in a style with its own face.
    for font in FONTS:
        for size in (12, 24):
            out.append(("fonts", dict(style="spacious", tone="dark", panel="skills", font=font, fsize=size, size="1280x1000")))
        out.append(("fonts", dict(style="compact", tone="dark", panel="skills", font=font, fsize=16, size="1280x1000")))
    # Zoom by page width, the panel open.
    for style in ("spacious", "compact"):
        for zoom in (0.75, 1.25, 1.5):
            for width in (768, 1200, 1600):
                out.append(("zoom", dict(style=style, tone="dark", panel="skills", zoom=zoom, width=width, size="1280x1000")))
    # A narrow window with the panel open, as in Kirby's report.
    for style in STYLES:
        for zoom in (1.0, 1.5):
            out.append(("narrow", dict(style=style, tone="dark", panel="skills", zoom=zoom, size="965x1000")))
    return out


def name(group, c):
    parts = [group, c["style"], c["tone"], c.get("panel") or "nopanel"]
    for k in ("font", "fsize", "zoom", "width"):
        if k in c:
            parts.append(f"{k}{c[k]}")
    parts.append(c["size"])
    return "-".join(str(p) for p in parts)


def run(d, doc):
    os.makedirs(d, exist_ok=True)
    lines = []
    for group, c in combos():
        n = name(group, c)
        args = {"style": c["style"], "report": True}
        if c.get("panel"):
            args["panel"] = c["panel"]
        for src, dst in (("font", "font"), ("fsize", "size"), ("zoom", "zoom"), ("width", "width")):
            if src in c:
                args[dst] = c[src]
        env = dict(os.environ, MARKIE_RS_SCENE_SIZE=c["size"])
        out = os.path.join(d, n + ".png")
        r = subprocess.run([os.path.join(HERE, "..", "scene.sh"), "doc", out, c["tone"], json.dumps(args), doc], env=env, capture_output=True, text=True)
        tables = [l.split("scene: ", 1)[1] for l in r.stdout.splitlines() if "scene: table " in l]
        bad = [t for t in tables if not t.endswith(" ok")]
        lines.append(f"{n}: {'BAD ' if bad else ''}{len(tables)} tables" + "".join(f"\n    {t}" for t in tables))
        print(n, "BAD" if bad else "ok", len(tables), flush=True)
    open(os.path.join(d, "report.txt"), "w").write("\n".join(lines) + "\n")


def sheet(d, names=None):
    from PIL import Image, ImageDraw, ImageFont
    font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 22)
    groups = {}
    for f in sorted(os.listdir(d)):
        if f.endswith(".png") and not f.startswith("sheet-") and (not names or any(x in f for x in names)):
            groups.setdefault(f.split("-")[0], []).append(f)
    for g, files in groups.items():
        thumbs = []
        for f in files:
            im = Image.open(os.path.join(d, f)).convert("RGB")
            im.thumbnail((640, 640))
            t = Image.new("RGB", (im.width, im.height + 30), (40, 40, 44))
            t.paste(im, (0, 30))
            ImageDraw.Draw(t).text((6, 4), f[:-4], fill=(240, 240, 240), font=font)
            thumbs.append(t)
        cols = 4
        w = max(t.width for t in thumbs)
        h = max(t.height for t in thumbs)
        rows = (len(thumbs) + cols - 1) // cols
        out = Image.new("RGB", (cols * (w + 8), rows * (h + 8)), (90, 90, 90))
        for i, t in enumerate(thumbs):
            out.paste(t, ((i % cols) * (w + 8), (i // cols) * (h + 8)))
        out.save(os.path.join(d, f"sheet-{g}.png"))
        print(f"sheet-{g}.png", len(thumbs))


if __name__ == "__main__":
    cmd, d = sys.argv[1], sys.argv[2]
    if cmd == "run":
        run(d, sys.argv[3] if len(sys.argv) > 3 else os.path.join(HERE, "fixtures", "tables.md"))
    elif cmd == "sheet":
        sheet(d, sys.argv[3:] or None)
