#!/usr/bin/env python3
"""Renders a specimen sheet of every bundled font and checks each file loads.

A maintainer check, run by hand:

  python3 -I scripts/fonts/specimen.py [path-to-headless-chromium]

It writes .autoloop/runs/fonts/specimen.html, specimen.png and specimen.json.
The page uses the committed woff2 files directly. For every file it asks the
browser to load the face, and for every family it measures a line of text
against the same line in the fallback face: a font that failed to load or to
apply would measure the same. Exits 1 if any did.

Needs Python 3 with playwright. Headless only: no window is opened.
"""
import json
import sys
from html import escape
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
FONTS = ROOT / "src/assets/fonts"
OUT = ROOT / ".autoloop/runs/fonts"
GENERATED = (ROOT / "src/lib/fonts/bundled-files.generated.ts").read_text()
FAMILIES = json.loads(GENERATED[GENERATED.index("= [") + 2 : GENERATED.rindex("]") + 1])

PANGRAM = "Sphinx of black quartz, judge my vow. 0123456789"
EXTENDED = "Zażółć gęślą jaźń · Příliš žluťoučký kůň · Çığ öğüt · Ðể"
CODE = "const total = items.map((n) => n * 2).filter(Boolean); // != => <="
LICENSES = {"OFL-1.1": "SIL Open Font License 1.1", "Apache-2.0": "Apache License 2.0"}


def page_html() -> str:
    faces, rows = [], []
    for family in FAMILIES:
        for file in family["files"]:
            url = (FONTS / file["file"]).as_uri()
            faces.append(
                f"@font-face{{font-family:'{family['family']}';font-style:{file['style']};font-weight:{file['weight']};src:url('{url}') format('woff2')}}"
            )
        size = sum(file["bytes"] for file in family["files"])
        italic = any(file["style"] == "italic" for file in family["files"])
        name = escape(family["family"])
        rows.append(
            f"""<section data-family="{name}">
  <header><h2 style="font-family:'{name}'">{name}</h2>
  <span>{family['id']} · {LICENSES[family['license']]} · v{escape(family['version'])} · {len(family['files'])} file{'s' if len(family['files']) > 1 else ''} · {size / 1024:.0f} KB</span></header>
  <p class="line" data-probe style="font-family:'{name}', monospace">{escape(PANGRAM)}</p>
  <p class="line bold" style="font-family:'{name}', monospace">{escape(PANGRAM)}</p>
  <p class="line {'italic' if italic else 'muted'}" style="font-family:'{name}', monospace">{escape(EXTENDED)}{'' if italic else ' (no italic file)'}</p>
  <p class="small" style="font-family:'{name}', monospace">{escape(CODE)}</p>
</section>"""
        )
    total = sum(file["bytes"] for family in FAMILIES for file in family["files"])
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Markie bundled fonts</title><style>
{chr(10).join(faces)}
body{{margin:32px 40px;background:#fff;color:#18181b;font-family:-apple-system,system-ui,sans-serif;width:1120px}}
h1{{font-size:22px;margin:0 0 4px}} .summary{{color:#52525b;font-size:13px;margin:0 0 20px}}
main{{display:grid;grid-template-columns:1fr 1fr;gap:14px 28px}}
section{{border-top:1px solid #e4e4e7;padding-top:8px;min-width:0}}
header{{display:flex;align-items:baseline;justify-content:space-between;gap:12px}}
h2{{font-size:24px;font-weight:600;margin:0;white-space:nowrap}}
header span{{font-size:10.5px;color:#71717a;text-align:right}}
p{{margin:4px 0;white-space:nowrap;overflow:hidden;text-overflow:clip}}
.line{{font-size:17px}} .bold{{font-weight:700}} .italic{{font-style:italic}} .muted{{color:#71717a}} .small{{font-size:12.5px;color:#3f3f46}}
#fallback{{position:absolute;visibility:hidden;font-size:17px;font-family:monospace;white-space:nowrap}}
</style></head><body>
<h1>Markie bundled fonts</h1>
<p class="summary">{len(FAMILIES)} families, {sum(len(f['files']) for f in FAMILIES)} woff2 files, {total / 1024 / 1024:.2f} MB. Latin and Latin Extended. Regular, bold, italic (accented text), and a code line.</p>
<main>{chr(10).join(rows)}</main><p id="fallback">{escape(PANGRAM)}</p></body></html>"""


CHECK = """async () => {
  const faces = [...document.fonts];
  const loads = await Promise.all(faces.map((face) => face.load().then(() => ({ family: face.family.replace(/['"]/g, ''), style: face.style, weight: face.weight, status: face.status }), (error) => ({ family: face.family.replace(/['"]/g, ''), style: face.style, weight: face.weight, status: 'error: ' + error.message }))));
  await document.fonts.ready;
  const fallback = document.getElementById('fallback').getBoundingClientRect().width;
  const families = [...document.querySelectorAll('section')].map((section) => ({ family: section.dataset.family, width: section.querySelector('[data-probe]').getBoundingClientRect().width, fallback }));
  return { loads, families };
}"""


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    html = OUT / "specimen.html"
    html.write_text(page_html())
    with sync_playwright() as playwright:
        options = {"headless": True}
        if len(sys.argv) > 1:
            options["executable_path"] = sys.argv[1]
        browser = playwright.chromium.launch(**options)
        page = browser.new_page(viewport={"width": 1200, "height": 900}, device_scale_factor=2)
        page.goto(html.as_uri())
        result = page.evaluate(CHECK)
        page.screenshot(path=str(OUT / "specimen.png"), full_page=True)
        result["browser"] = browser.version
        browser.close()
    failed = [load for load in result["loads"] if load["status"] != "loaded"]
    # A face that did not apply measures exactly like the fallback.
    unapplied = [item["family"] for item in result["families"] if abs(item["width"] - item["fallback"]) < 0.5]
    result["ok"] = not failed and not unapplied and len(result["loads"]) == sum(len(f["files"]) for f in FAMILIES)
    (OUT / "specimen.json").write_text(json.dumps(result, indent=2))
    print(f"{len(result['loads'])} faces loaded, {len(failed)} failed, {len(unapplied)} not applied: {'ok' if result['ok'] else 'FAILED'}")
    for item in failed:
        print("  failed:", item)
    for item in unapplied:
        print("  not applied:", item)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
