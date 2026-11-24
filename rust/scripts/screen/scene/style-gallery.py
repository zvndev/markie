#!/usr/bin/env python3
"""The Markdown style gallery: Electron beside Markie RS, per preset and tone.

  style-gallery.py parts <dir>            split fixtures/lighthouse.md into four files that each fit a window
  style-gallery.py jobs <dir> <out.json>  the Electron jobs for shoot.mjs (editing view and read view)
  style-gallery.py rs <dir>               draw every preset in Markie RS (scene.sh; SCENE_BIN names the binary)
  style-gallery.py build <dir>            crop, stack and pair the frames; writes <dir>/gallery and GALLERY.md

Everything is drawn in the background (docs/rust-port/SCREEN.md). Needs Pillow.
"""
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
PRESETS = ["spacious", "compact", "classic", "technical", "editorial", "minimal"]
TONES = ["light", "dark"]
PARTS = ["### Through the night", "## The log", "## Signals"]
W, H = 1280, 1000          # both windows, in points
COLUMN = 768               # the reading column
RS_LEFT, RS_TOP = 282, 77 # where Markie RS's document pane puts the column, under its toolbar
EL_LEFT, EL_TOP = (W - COLUMN) // 2, 0
MARGIN = 24                # shown either side of the column


def parts(d):
    text = open(os.path.join(HERE, "fixtures", "lighthouse.md")).read()
    cuts = [0] + [text.index(p) for p in PARTS] + [len(text)]
    os.makedirs(os.path.join(d, "parts"), exist_ok=True)
    for i in range(len(cuts) - 1):
        open(os.path.join(d, "parts", f"part{i + 1}.md"), "w").write(text[cuts[i]:cuts[i + 1]])
    return len(cuts) - 1


def jobs(d, out):
    n = parts(d)
    js = []
    for surface in ("rich", "read"):
        for style in PRESETS:
            for tone in TONES:
                for p in range(1, n + 1):
                    js.append({
                        "scene": "doc", "theme": tone, "out": os.path.join(d, "electron", f"{surface}-{style}-{tone}-{p}.png"),
                        "args": {"file": os.path.join(d, "parts", f"part{p}.md"), "style": style, "surface": surface},
                        "viewport": {"width": W, "height": H}, "ready": "[data-scene-doc] :is(h1,h2,h4)", "settle": 900, "blur": True,
                    })
    os.makedirs(os.path.join(d, "electron"), exist_ok=True)
    json.dump(js, open(out, "w"))
    print(f"{len(js)} jobs")


def rs(d):
    n = parts(d)
    os.makedirs(os.path.join(d, "rs"), exist_ok=True)
    env = dict(os.environ, MARKIE_RS_SCENE_SIZE=f"{W}x{H}")
    for style in PRESETS:
        for tone in TONES:
            for p in range(1, n + 1):
                out = os.path.join(d, "rs", f"{style}-{tone}-{p}.png")
                r = subprocess.run([os.path.join(HERE, "..", "scene.sh"), "doc", out, tone, json.dumps({"style": style}), os.path.join(d, "parts", f"part{p}.md")], env=env, capture_output=True, text=True)
                print(style, tone, p, "ok" if os.path.exists(out) else r.stdout[-300:] + r.stderr[-300:])


def column(path, left, top):
    from PIL import Image
    im = Image.open(path).convert("RGB")
    s = im.width // W
    return im.crop(((left - MARGIN) * s, top * s, (left + COLUMN + MARGIN) * s, im.height))


def trim(im):
    """Drop the empty page below the last drawn row."""
    from PIL import ImageChops, Image
    bg = Image.new("RGB", im.size, im.getpixel((2, im.height - 2)))
    box = ImageChops.difference(im, bg).getbbox()
    return im.crop((0, 0, im.width, min(im.height, (box[3] if box else im.height) + 40)))


def stack(frames):
    from PIL import Image
    out = Image.new("RGB", (frames[0].width, sum(f.height for f in frames)), frames[0].getpixel((2, 2)))
    y = 0
    for f in frames:
        out.paste(f, (0, y))
        y += f.height
    return out


def build(d):
    from PIL import Image, ImageDraw, ImageFont
    n = len(PARTS) + 1
    g = os.path.join(d, "gallery")
    os.makedirs(g, exist_ok=True)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 30)
    except OSError:
        font = ImageFont.load_default()
    lines = ["# Markdown styles: Electron and Markie RS", "",
             "The Lighthouse sample in each preset. Left: Electron's editing view (TipTap in headless Chromium), the surface Markie RS's View mirrors. Middle: Markie RS. Right: Electron's read view (the rendered page a shared link shows), for reference.", ""]
    for tone in TONES:
        lines += [f"## {tone.capitalize()}", ""]
        for style in PRESETS:
            cols = []
            for label, pattern, left, top in (("Electron (editing view)", f"electron/rich-{style}-{tone}-%d.png", EL_LEFT, EL_TOP), ("Markie RS", f"rs/{style}-{tone}-%d.png", RS_LEFT, RS_TOP), ("Electron (read view)", f"electron/read-{style}-{tone}-%d.png", EL_LEFT, EL_TOP)):
                frames = [trim(column(os.path.join(d, pattern % p), left, top)) for p in range(1, n + 1) if os.path.exists(os.path.join(d, pattern % p))]
                if frames:
                    cols.append((label, stack(frames)))
            if not cols:
                continue
            head = 70
            sheet = Image.new("RGB", (sum(c.width for _, c in cols) + 20 * (len(cols) - 1), max(c.height for _, c in cols) + head), (128, 128, 128))
            draw = ImageDraw.Draw(sheet)
            x = 0
            for label, c in cols:
                draw.rectangle((x, 0, x + c.width, head), fill=(32, 32, 36))
                draw.text((x + 24, 18), f"{label}: {style}, {tone}", fill=(240, 240, 240), font=font)
                sheet.paste(c, (x, head))
                x += c.width + 20
            name = f"{style}-{tone}.png"
            sheet.save(os.path.join(g, name))
            lines += [f"### {style.capitalize()}", "", f"![{style} {tone}](gallery/{name})", ""]
            print(name, sheet.size)
    open(os.path.join(d, "GALLERY.md"), "w").write("\n".join(lines))


if __name__ == "__main__":
    cmd = sys.argv[1]
    {"parts": lambda: print(parts(sys.argv[2])), "jobs": lambda: jobs(sys.argv[2], sys.argv[3]), "rs": lambda: rs(sys.argv[2]), "build": lambda: build(sys.argv[2])}[cmd]()
