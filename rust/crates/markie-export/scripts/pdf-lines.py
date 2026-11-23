#!/usr/bin/env python3
"""Line baselines of two PDFs, matched by text, and how far each moved.

Usage: pdf-lines.py <chromium.pdf> <rs.pdf> [--all] [--json out.json]
       pdf-lines.py --golden <chromium.pdf> <out.json>

Every span's baseline is grouped into visual lines per page (within 1 pt),
lines are matched in reading order by their letters and digits, and the
vertical offset (rs minus chromium, in pt) is printed for each pair that sits
on the same page. Needs PyMuPDF.
"""
import sys, re, json, difflib, unicodedata
import fitz

def lines(path):
    out = []
    for pno, page in enumerate(fitz.open(path)):
        spans = []
        for b in page.get_text("dict")["blocks"]:
            for l in b.get("lines", []):
                for s in l["spans"]:
                    t = s["text"]
                    if not t.strip():
                        continue
                    spans.append((s["origin"][1], s["origin"][0], t, s["size"]))
        spans.sort()
        rows = []
        for y, x, t, size in spans:
            if rows and abs(rows[-1]["y"] - y) <= 1.0 and size > 6:
                rows[-1]["parts"].append((x, t))
            else:
                rows.append({"y": y, "parts": [(x, t)], "size": size})
        for r in rows:
            r["parts"].sort()
            text = "".join(t for _, t in r["parts"])
            # NFKC folds math italic letters (markie-math) into plain ones (KaTeX).
            key = re.sub(r"[^0-9a-z]", "", unicodedata.normalize("NFKC", text).lower())
            if len(key) < 2:
                continue
            out.append({"page": pno + 1, "y": round(r["y"], 2), "x": round(r["parts"][0][0], 2), "text": text, "key": key})
    return out

def match(a, b):
    sm = difflib.SequenceMatcher(None, [l["key"] for l in a], [l["key"] for l in b], autojunk=False)
    pairs = []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal" or (op == "replace" and i2 - i1 == j2 - j1):
            for i, j in zip(range(i1, i2), range(j1, j2)):
                if op == "equal" or difflib.SequenceMatcher(None, a[i]["key"], b[j]["key"]).ratio() > 0.6:
                    pairs.append((a[i], b[j]))
    return pairs

def main():
    args = sys.argv[1:]
    if args[0] == "--golden":
        # The reference baselines tests/pdf.rs measures Markie RS against.
        rows = [{"page": l["page"], "y": l["y"], "key": l["key"]} for l in lines(args[1])]
        open(args[2], "w").write("[\n" + ",\n".join(json.dumps(r) for r in rows) + "\n]\n")
        return
    a, b = lines(args[0]), lines(args[1])
    pairs = match(a, b)
    worst = 0.0
    rows = []
    for x, y in pairs:
        same = x["page"] == y["page"]
        d = round(y["y"] - x["y"], 2) if same else None
        if d is not None:
            worst = max(worst, abs(d))
        rows.append({"page": x["page"], "rs_page": y["page"], "chromium_y": x["y"], "rs_y": y["y"], "dy": d, "dx": round(y["x"] - x["x"], 2), "text": x["text"][:60]})
        if "--all" in args or d is None or abs(d) > 2:
            print(f"p{x['page']}{'' if same else '->p'+str(y['page'])} c={x['y']:7.2f} r={y['y']:7.2f} dy={d if d is not None else 'PAGE'} dx={y['x']-x['x']:6.2f}  {x['text'][:60]}")
    print(f"matched {len(pairs)} of {len(a)} chromium lines, {len(b)} rs lines; max |dy| {worst:.2f} pt; off-page {sum(1 for r in rows if r['dy'] is None)}")
    if "--json" in args:
        json.dump({"matched": len(pairs), "chromium_lines": len(a), "rs_lines": len(b), "max_dy": worst, "rows": rows}, open(args[args.index("--json") + 1], "w"), indent=1)

main()
