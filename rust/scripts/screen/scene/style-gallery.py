#!/usr/bin/env python3
"""The Markdown style gallery: Electron beside Markie RS, per preset and tone.

  style-gallery.py parts <dir>            split fixtures/lighthouse.md into four files that each fit a window
  style-gallery.py jobs <dir> <out.json>  the Electron jobs for shoot.mjs (editing view and read view)
  style-gallery.py rs <dir>               draw every preset in Markie RS (scene.sh; SCENE_BIN names the binary)
  style-gallery.py pdfjobs <dir> <out.json>  the Electron jobs that print its export page as PDFs (shoot.mjs)
  style-gallery.py pdf <dir>              pair <dir>/pdf/electron-*.pdf with rs-*.pdf, page by page (needs PyMuPDF)
  style-gallery.py build <dir>            crop, stack and pair the frames; writes <dir>/gallery and GALLERY.md

The Markie RS PDFs come from the exporter's own example:
  cargo run --release -p markie-export --example export_pdf -- fixtures/lighthouse.md <dir>/pdf/rs-<style>-<tone>.pdf <tone> --style <style>
Screenshots of "Readers see my look" go in <dir>/look (docs/rust-port/STYLES-FONTS.md says how they are made).

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


PDF_STYLES = ["technical", "editorial", "classic"]


def pdfjobs(d, out):
    fixture = os.path.join(HERE, "fixtures", "lighthouse.md")
    os.makedirs(os.path.join(d, "pdf"), exist_ok=True)
    js = [{"scene": "export", "theme": t, "out": os.path.join(d, "pdf", f"electron-{s}-{t}.pdf"), "args": {"file": fixture, "style": s, "theme": t},
           "ready": "body[data-scene-export]", "settle": 800, "pdf": True} for s in PDF_STYLES for t in TONES]
    json.dump(js, open(out, "w"))
    print(f"{len(js)} jobs")


def pdf(d):
    import fitz
    from PIL import Image, ImageDraw, ImageFont
    font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 26)

    def pages(path):
        out = []
        for page in fitz.open(path):
            pm = page.get_pixmap(dpi=110)
            out.append(Image.frombytes("RGB", (pm.width, pm.height), pm.samples))
        return out

    os.makedirs(os.path.join(d, "gallery"), exist_ok=True)
    for s in PDF_STYLES:
        for t in TONES:
            pair = [os.path.join(d, "pdf", f"{app}-{s}-{t}.pdf") for app in ("electron", "rs")]
            if not all(os.path.exists(p) for p in pair):
                continue
            e, r = pages(pair[0]), pages(pair[1])
            n, w, h, head = max(len(e), len(r)), e[0].width, e[0].height, 50
            sheet = Image.new("RGB", (w * 2 + 20, (h + 10) * n + head), (120, 120, 120))
            draw = ImageDraw.Draw(sheet)
            draw.rectangle((0, 0, sheet.width, head), fill=(32, 32, 36))
            draw.text((16, 10), f"Electron PDF: {s}, {t} ({len(e)} pages)", fill=(240, 240, 240), font=font)
            draw.text((w + 36, 10), f"Markie RS PDF: {s}, {t} ({len(r)} pages)", fill=(240, 240, 240), font=font)
            for i in range(n):
                if i < len(e):
                    sheet.paste(e[i], (0, head + i * (h + 10)))
                if i < len(r):
                    sheet.paste(r[i], (w + 20, head + i * (h + 10)))
            sheet.save(os.path.join(d, "gallery", f"pdf-{s}-{t}.png"))
            print(s, t, len(e), len(r))


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
    sheets = sorted(f for f in os.listdir(g) if f.startswith("pdf-"))
    if sheets:
        lines += ["## PDF export", "", "The Lighthouse sample exported as a PDF. Left: Electron's export page printed by headless Chromium. Right: Markie RS's own exporter.", ""]
        for f in sheets:
            lines += [f"### {f[4:-4].replace('-', ', ').capitalize()}", "", f"![{f}](gallery/{f})", ""]
    look = os.path.join(d, "look")
    captions = [("rs-share-off.png", "Markie RS: Share, before the look is pinned"), ("rs-share-on.png", "Markie RS: Share, after \"Turn on\""),
                ("electron-share-on.png", "Electron: Share on the same document, reading the look Markie RS pinned"), ("public-link.png", "The public link, as anyone reads it, in the pinned look")]
    if os.path.isdir(look) and any(os.path.exists(os.path.join(look, f)) for f, _ in captions):
        lines += ["## Readers see my look", "", "A document on a scratch server with `docs.enforced_style` (Electron main's server). The look was pinned from Markie RS: the Markie theme and the Technical style.", ""]
        for f, caption in captions:
            if os.path.exists(os.path.join(look, f)):
                lines += [f"### {caption}", "", f"![{caption}](look/{f})", ""]
    open(os.path.join(d, "GALLERY.md"), "w").write("\n".join(lines))


if __name__ == "__main__":
    cmd = sys.argv[1]
    {"parts": lambda: print(parts(sys.argv[2])), "jobs": lambda: jobs(sys.argv[2], sys.argv[3]), "rs": lambda: rs(sys.argv[2]), "pdfjobs": lambda: pdfjobs(sys.argv[2], sys.argv[3]), "pdf": lambda: pdf(sys.argv[2]), "build": lambda: build(sys.argv[2])}[cmd]()
