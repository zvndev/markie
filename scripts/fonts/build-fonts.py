#!/usr/bin/env python3
"""Rebuild Markie's bundled font files.

A maintainer tool, not part of any build: the woff2 files it writes are
committed. It reads scripts/fonts/sources.json, downloads each family from the
pinned commit of the official Google Fonts repository (nowhere else), keeps
Latin and Latin Extended, drops every variable axis but weight, and writes

  src/assets/fonts/<id>/<name>.woff2      the font files
  src/assets/fonts/<id>/LICENSE.txt       the family's own license text
  src/lib/fonts/bundled-files.generated.ts  what the registry reads

Needs Python 3 with fonttools and brotli:  pip install fonttools brotli
Run from the repo root:  python3 -I scripts/fonts/build-fonts.py [cache-dir]

The optional cache directory keeps the downloaded originals between runs. It
must be outside the repo; the originals are never committed.
"""
import hashlib
import io
import json
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parents[2]
SPEC = json.loads((ROOT / "scripts/fonts/sources.json").read_text())
OUT = ROOT / "src/assets/fonts"
GENERATED = ROOT / "src/lib/fonts/bundled-files.generated.ts"

# Google Fonts' own "latin" and "latin-ext" subsets, plus the arrows and the
# few comparison signs prose and code comments use.
RANGES = (
    "0000-00FF,0131,0152-0153,02BB-02BC,02C6,02DA,02DC,0304,0308,0329,2000-206F,"
    "20AC,2122,2190-2193,2212,2215,FEFF,FFFD,"
    "0100-02BA,02BD-02C5,02C7-02CC,02CE-02D7,02DD-02FF,1D00-1DBF,1E00-1E9F,"
    "1EF2-1EFF,2020,20A0-20AB,20AD-20C0,2113,2C60-2C7F,A720-A7FF,"
    "2260,2264-2265,2248,221E,25CF,25CB,2713,2717"
)


def unicodes():
    result = []
    for part in RANGES.split(","):
        if "-" in part:
            start, end = part.split("-")
            result.extend(range(int(start, 16), int(end, 16) + 1))
        else:
            result.append(int(part, 16))
    return result


def fetch(cache: Path, directory: str, name: str, url: str = "") -> Path:
    target = cache / directory.replace("/", "_") / name
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        url = url or f"https://raw.githubusercontent.com/google/fonts/{SPEC['commit']}/{directory}/{urllib.parse.quote(name)}"
        with urllib.request.urlopen(url) as response:
            target.write_bytes(response.read())
    return target


def version_of(font: TTFont) -> str:
    record = font["name"].getDebugName(5) or ""
    return record.split(";")[0].replace("Version ", "").strip()


def build(cache: Path):
    families = []
    for spec in SPEC["families"]:
        folder = OUT / spec["id"]
        folder.mkdir(parents=True, exist_ok=True)
        for old in folder.glob("*.woff2"):
            old.unlink()
        # A family whose folder carries no license file names the foundry's
        # own copy (licenseUrl), at a pinned commit of the foundry's repo.
        license_text = fetch(cache, spec["dir"], spec["licenseFile"], spec.get("licenseUrl", "")).read_bytes()
        (folder / "LICENSE.txt").write_bytes(license_text)
        files = []
        version = ""
        for entry in spec["files"]:
            source_name, style = entry[0], entry[1]
            font = TTFont(fetch(cache, spec["dir"], source_name))
            version = version or version_of(font)
            weight = entry[2] if len(entry) > 2 else None
            if "fvar" in font:
                axes = {axis.axisTag: axis for axis in font["fvar"].axes}
                drop = {tag: None for tag in axes if tag != "wght"}
                if drop:
                    # Saved and read back: the subsetter needs the instanced
                    # tables as a font on disk would hold them.
                    buffer = io.BytesIO()
                    instancer.instantiateVariableFont(font, drop).save(buffer)
                    buffer.seek(0)
                    font = TTFont(buffer)
                wght = axes["wght"]
                weight = f"{int(wght.minValue)} {int(wght.maxValue)}"
            options = Options()
            options.flavor = "woff2"
            options.layout_features += ["tnum", "lnum", "pnum", "onum", "zero", "case"]
            options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
            options.notdef_outline = True
            # TrueType hinting is close to a third of the static families and
            # does nothing on macOS, iOS or Android. Metrics are untouched.
            options.hinting = False
            options.drop_tables += ["DSIG"]
            subsetter = Subsetter(options)
            subsetter.populate(unicodes=unicodes())
            subsetter.subset(font)
            stem = source_name.split("[")[0].replace(".ttf", "")
            out_name = f"{stem}.woff2"
            font.flavor = "woff2"
            font.save(folder / out_name)
            data = (folder / out_name).read_bytes()
            files.append({
                "file": f"{spec['id']}/{out_name}",
                "style": style,
                "weight": weight,
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            })
            print(f"{spec['id']:16} {out_name:44} {len(data):8}")
        families.append({
            "id": spec["id"],
            "family": spec["family"],
            "license": spec["license"],
            "licenseFile": f"{spec['id']}/LICENSE.txt",
            "source": f"{SPEC['repo']}/tree/{SPEC['commit']}/{spec['dir']}",
            **({"licenseSource": spec["licenseUrl"]} if spec.get("licenseUrl") else {}),
            "version": version,
            "files": files,
        })
    body = json.dumps(families, indent=2)
    GENERATED.parent.mkdir(parents=True, exist_ok=True)
    GENERATED.write_text(
        "// Generated by scripts/fonts/build-fonts.py from scripts/fonts/sources.json.\n"
        "// Do not edit by hand: change sources.json and run the script again.\n"
        "export interface BundledFontFile {\n"
        "  /** Path under src/assets/fonts. */\n"
        "  file: string;\n"
        "  style: \"normal\" | \"italic\";\n"
        "  /** A CSS font-weight: one value, or the two ends of a variable range. */\n"
        "  weight: string;\n"
        "  bytes: number;\n"
        "  sha256: string;\n"
        "}\n\n"
        "export interface BundledFontFiles {\n"
        "  id: string;\n"
        "  family: string;\n"
        "  license: \"OFL-1.1\" | \"Apache-2.0\";\n"
        "  /** Path under src/assets/fonts. */\n"
        "  licenseFile: string;\n"
        "  /** The folder the originals came from, at the pinned commit. */\n"
        "  source: string;\n"
        "  /** Where the license text came from, when the folder above has none. */\n"
        "  licenseSource?: string;\n"
        "  version: string;\n"
        "  files: BundledFontFile[];\n"
        "}\n\n"
        f"export const BUNDLED_FONT_FILES: BundledFontFiles[] = {body};\n"
    )
    total = sum(f["bytes"] for family in families for f in family["files"])
    print(f"{len(families)} families, {sum(len(f['files']) for f in families)} files, {total} bytes")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        build(Path(sys.argv[1]).resolve())
    else:
        with tempfile.TemporaryDirectory() as temp:
            build(Path(temp))
