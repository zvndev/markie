#!/usr/bin/env python3
"""Large-document fixtures for editors 7.9 (docs/rust-port/PERF.md).

  gen-large.py <out-dir>

Writes large-{1,10,50,100}m.{md,txt}. Sizes are decimal megabytes, the unit
both apps' tiers use: 1,000,000, 10,000,000 and 50,000,000 bytes, and
99,999,000 for "100 MB", because both apps refuse a file of 100,000,000 bytes
or more. refused-100m.md is exactly 100,000,000 bytes, to time the refusal.
All text is made up and deterministic: Markdown from gen-fixtures.py's blocks
(headings, lists, tables, code, quotes, paragraphs), plain text as prose
paragraphs wrapped at about 80 columns. Existing files of the right size are
kept.
"""
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util

spec = importlib.util.spec_from_file_location("gen", os.path.join(os.path.dirname(os.path.abspath(__file__)), "gen-fixtures.py"))
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)

SIZES = {"1m": 1_000_000, "10m": 10_000_000, "50m": 50_000_000, "100m": 99_999_000}


def plain(target: int) -> str:
    rng = random.Random(target + 1)
    out, size = [], 0
    while size < target:
        words = " ".join(gen.sentence(rng).replace("**", "").replace("*", "").replace("`", "") for _ in range(rng.randint(3, 8)))
        lines, line = [], ""
        for w in words.split(" "):
            if len(line) + len(w) + 1 > 80:
                lines.append(line)
                line = w
            else:
                line = f"{line} {w}" if line else w
        lines.append(line)
        para = "\n".join(lines) + "\n\n"
        out.append(para)
        size += len(para)
    return "".join(out)[:target]


def write(path: str, text: str) -> None:
    data = text.encode("utf-8")
    with open(path, "wb") as f:
        f.write(data)
    print(f"{path} {len(data):,} bytes")


def main() -> None:
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    for label, size in SIZES.items():
        for ext in ("md", "txt"):
            path = os.path.join(out, f"large-{label}.{ext}")
            if os.path.exists(path) and os.path.getsize(path) == size:
                continue
            text = gen.markdown(size, f"Large fixture {label}") if ext == "md" else plain(size)
            write(path, text)
    path = os.path.join(out, "refused-100m.md")
    if not (os.path.exists(path) and os.path.getsize(path) == 100_000_000):
        src = open(os.path.join(out, "large-100m.md"), "rb").read()
        with open(path, "wb") as f:
            f.write(src + b"\n" * (100_000_000 - len(src)))


if __name__ == "__main__":
    main()
