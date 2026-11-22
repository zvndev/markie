#!/usr/bin/env python3
"""Hottest functions in a samply profile saved with --unstable-presymbolicate.

  hot.py <profile.json> [--thread main|all|<name>] [--top 40] [--filter substr]

Prints inclusive and self sample counts per function (Rust symbols
demangled-ish by trimming hashes). Samples are 1 ms apart by default, so
counts are roughly milliseconds of CPU on that thread.
"""
import argparse
import bisect
import json
import re
from collections import Counter
from pathlib import Path


def load_syms(path: Path):
    s = json.loads(path.read_text())
    strings = s["string_table"]
    table = {}
    for lib in s["data"]:
        rows = sorted(lib["symbol_table"], key=lambda r: r["rva"])
        table[lib["code_id"].upper()] = ([r["rva"] for r in rows], rows, strings)
        table[lib["debug_name"]] = table[lib["code_id"].upper()]
    return table


def clean(name: str) -> str:
    name = re.sub(r"::h[0-9a-f]{16}$", "", name)
    name = re.sub(r"<impl [^>]*>", "<impl>", name)
    return name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("profile")
    ap.add_argument("--thread", default="main")
    ap.add_argument("--top", type=int, default=40)
    ap.add_argument("--filter", default=None)
    a = ap.parse_args()
    prof = json.loads(Path(a.profile).read_text())
    syms = load_syms(Path(a.profile).with_suffix(".syms.json"))
    libs = prof["libs"]

    incl, selfc = Counter(), Counter()
    total = 0
    for t in prof["threads"]:
        if a.thread == "main" and not t.get("isMainThread"):
            continue
        if a.thread not in ("main", "all") and a.thread not in t["name"]:
            continue
        ft, fn, rt, st, sa, strs = t["frameTable"], t["funcTable"], t["resourceTable"], t["stackTable"], t["samples"], t["stringArray"]
        cache = {}

        def frame_name(f):
            if f in cache:
                return cache[f]
            func = ft["func"][f]
            res = fn["resource"][func]
            addr = ft["address"][f]
            name = strs[fn["name"][func]]
            if res is not None and res >= 0:
                lib = libs[rt["lib"][res]]
                entry = syms.get(lib.get("codeId", "").upper()) or syms.get(lib["debugName"])
                if entry and addr is not None and addr >= 0:
                    rvas, rows, sstr = entry
                    i = bisect.bisect_right(rvas, addr) - 1
                    if i >= 0 and addr < rows[i]["rva"] + max(rows[i]["size"], 1) + 64:
                        name = sstr[rows[i]["symbol"]]
                name = f"{clean(name)} [{lib['debugName']}]"
            cache[f] = name
            return name

        weights = sa.get("weight") or [1] * sa["length"]
        for i in range(sa["length"]):
            s = sa["stack"][i]
            if s is None:
                continue
            w = weights[i] if weights[i] is not None else 1
            total += w
            seen = set()
            leaf = True
            while s is not None:
                n = frame_name(st["frame"][s])
                if leaf:
                    selfc[n] += w
                    leaf = False
                if n not in seen:
                    incl[n] += w
                    seen.add(n)
                s = st["prefix"][s]
    print(f"samples: {total}")
    keep = (lambda n: a.filter in n) if a.filter else (lambda n: True)
    print("\n-- inclusive --")
    for n, c in [x for x in incl.most_common() if keep(x[0])][: a.top]:
        print(f"{c:7d} {100 * c / max(total, 1):5.1f}%  {n[:170]}")
    print("\n-- self --")
    for n, c in [x for x in selfc.most_common() if keep(x[0])][: a.top]:
        print(f"{c:7d} {100 * c / max(total, 1):5.1f}%  {n[:170]}")


if __name__ == "__main__":
    main()
