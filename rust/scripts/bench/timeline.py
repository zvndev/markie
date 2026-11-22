#!/usr/bin/env python3
"""Main-thread timeline of a samply profile: what ran in each time slice.

  timeline.py <profile.json> [--until ms] [--slice ms] [--depth n]

For each slice, the most frequent stack prefix of interest (frames from our
own binary, outermost first, cut to --depth below the run loop).
"""
import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import hot  # noqa: E402

import bisect


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("profile")
    ap.add_argument("--until", type=float, default=600)
    ap.add_argument("--slice", type=float, default=10)
    ap.add_argument("--depth", type=int, default=3)
    a = ap.parse_args()
    p = Path(a.profile)
    prof = json.loads(p.read_text())
    syms = hot.load_syms(p.with_suffix(".syms.json"))
    t = next(x for x in prof["threads"] if x.get("isMainThread"))
    ft, fn, rt, st, sa, strs = t["frameTable"], t["funcTable"], t["resourceTable"], t["stackTable"], t["samples"], t["stringArray"]
    cache = {}

    def name(f):
        if f in cache:
            return cache[f]
        func = ft["func"][f]
        res = fn["resource"][func]
        addr = ft["address"][f]
        nm = strs[fn["name"][func]]
        lib = None
        if res is not None and res >= 0:
            lib = prof["libs"][rt["lib"][res]]
            e = syms.get(lib.get("codeId", "").upper()) or syms.get(lib["debugName"])
            if e and addr is not None and addr >= 0:
                i = bisect.bisect_right(e[0], addr) - 1
                if i >= 0:
                    nm = e[2][e[1][i]["symbol"]]
        cache[f] = (hot.clean(nm), lib["debugName"] if lib else "")
        return cache[f]

    slices: dict[int, Counter] = {}
    now = 0.0
    start = None
    for i in range(sa["length"]):
        now += sa["timeDeltas"][i]
        if start is None:
            start = now
        rel = now - start
        if rel > a.until:
            break
        s = sa["stack"][i]
        frames = []
        while s is not None:
            frames.append(name(st["frame"][s]))
            s = st["prefix"][s]
        frames.reverse()
        ours = [n for n, lib in frames if lib == "markie-rs" and not n.startswith(("std::", "core::", "main", "<<gpui::app::Application>::run"))]
        leaf = frames[-1][0] if frames else "?"
        key = " > ".join(x[:70] for x in ours[: a.depth]) or f"(system) {leaf[:60]}"
        slices.setdefault(int(rel // a.slice), Counter())[key] += 1
    for k in sorted(slices):
        c = slices[k]
        top, n = c.most_common(1)[0]
        print(f"{k * a.slice:6.0f} ms  {sum(c.values()):3d}  {top}")


if __name__ == "__main__":
    main()
