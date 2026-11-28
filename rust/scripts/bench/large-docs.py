#!/usr/bin/env python3
"""Editors 7.9: Markie RS against Electron Markie on large documents.

  large-docs.py run <scratch> [--runs 3] [--only 10m.md,...]
  large-docs.py summary <scratch>

Needs, under <scratch>:
  fx/            gen-large.py's fixtures
  esrc/          a copy of the Electron checkout (git archive), node_modules linked
  electron-out/  its renderer, built with vite (see PERF.md)
  electron/Electron.app   the Electron release the checkout pins
and rust/target/release/markie-rs built with --features scene.

Nothing is shown on screen: Markie RS runs as a scene (hidden window,
accessory app), Electron as electron-large/main.cjs (offscreen window,
accessory app). Each run opens a fresh copy of the fixture, because the
bench saves it. RSS is sampled every 100 ms over each app's whole process
tree; the peak is kept. Apps take turns, run by run.
"""
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
RUST = os.path.abspath(os.path.join(HERE, "..", ".."))
SCRATCH = "/nonexistent"
FIXTURES = [f"{s}.{e}" for s in ("1m", "10m", "50m", "100m") for e in ("md", "txt")]


def front() -> str:
    """The frontmost app's name and bundle path."""
    out = subprocess.run(["lsappinfo", "info", "-only", "name,bundlepath", subprocess.run(["lsappinfo", "front"], capture_output=True, text=True).stdout.strip()], capture_output=True, text=True).stdout
    return " ".join(re.findall(r'"([^"]*)"', out)) or out.strip()


def tree_rss_kb(root: int) -> int:
    rows = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,rss="], capture_output=True, text=True).stdout.split("\n")
    kids, rss = {}, {}
    for r in rows:
        p = r.split()
        if len(p) == 3:
            pid, ppid, kb = map(int, p)
            kids.setdefault(ppid, []).append(pid)
            rss[pid] = kb
    total, stack = 0, [root]
    while stack:
        p = stack.pop()
        total += rss.get(p, 0)
        stack.extend(kids.get(p, []))
    return total


def launch(cmd, env, log_path, timeout):
    before = front()
    load = os.getloadavg()[0]
    with open(log_path, "w") as log:
        t0 = time.time()
        proc = subprocess.Popen(cmd, env=env, stdout=log, stderr=subprocess.STDOUT)
        peak = 0
        while proc.poll() is None:
            peak = max(peak, tree_rss_kb(proc.pid))
            if time.time() - t0 > timeout:
                proc.kill()
                break
            time.sleep(0.1)
        proc.wait()
    after = front()
    # Kirby and other apps change the frontmost app while this runs. Only one
    # of the bench's own builds coming to the front is a harness failure.
    if before != after and (SCRATCH in after or os.path.join(RUST, "target") in after):
        print(f"  frontmost app changed: {before} -> {after}; stop and check the harness", file=sys.stderr)
        sys.exit(3)
    return {"spawn": t0 * 1000, "peak_rss_mb": peak / 1024, "load": load, "wall_s": time.time() - t0, "front": after}


def run_rs(scratch, fixture, out):
    home = os.path.join(out, "rs-home")
    for d in ("home", "data", "dl", "docs"):
        os.makedirs(os.path.join(home, d), exist_ok=True)
    doc = os.path.join(home, "docs", f"large-{fixture}")
    shutil.copyfile(os.path.join(scratch, "fx", f"large-{fixture}"), doc)
    env = {k: v for k, v in os.environ.items() if k not in ("CLAUDE_CONFIG_DIR", "CODEX_HOME", "MARKIE_RS_CLOUD_SERVER")}
    env.update(HOME=f"{home}/home", MARKIE_RS_DATA_DIR=f"{home}/data", MARKIE_RS_DOWNLOADS_DIR=f"{home}/dl", MARKIE_RS_DOCUMENTS_DIR=f"{home}/docs",
               MARKIE_RS_PERF="1", MARKIE_RS_SCENE="doc", MARKIE_RS_SCENE_ARGS=json.dumps({"bench": True, "timeout": 300, "settle": 100}),
               MARKIE_RS_SCENE_OUT=os.path.join(out, "rs.png"))
    log = os.path.join(out, "rs.log")
    meta = launch([os.path.join(RUST, "target", "release", "markie-rs"), doc], env, log, 900)
    text = open(log).read()
    r = dict(meta)
    for line in text.splitlines():
        if line.startswith("markie-perf "):
            ev = json.loads(line[len("markie-perf "):])
            if ev["event"] == "open" and ev.get("launch"):
                r["first_paint_ms"] = ev["ms"]
                r["launch_to_paint_ms"] = ev["t"] - meta["spawn"]
        m = re.match(r"markie-doc-bench (\S+) (?:landed (\d+) )?mean (\S+) median (\S+) p95 (\S+) max (\S+) over_16.7ms (\d+)", line)
        if m:
            r[m.group(1)] = {"landed": int(m.group(2) or 0), "mean": float(m.group(3)), "median": float(m.group(4)), "p95": float(m.group(5)), "max": float(m.group(6)), "over16": int(m.group(7))}
        for key in ("reopen_first_frame_ms", "reopen_editable_ms", "save_ms", "save_main_ms"):
            m = re.match(rf"markie-doc-bench {key} (\S+)", line)
            if m:
                r[key] = float(m.group(1))
        m = re.match(r"markie-doc-bench save_ms \S+ bytes_on_disk (\d+) dirty_after (\w+)", line)
        if m:
            r["saved_bytes"], r["dirty_after"] = int(m.group(1)), m.group(2)
        m = re.match(r"markie-doc-bench scroll_height_px (\S+)", line)
        if m:
            r["scroll_height_px"] = float(m.group(1))
        if "typed_landed" in line:
            r["typed_landed"] = line.strip().endswith("true")
    if "first_paint_ms" in r and "reopen_editable_ms" in r:
        # Open is synchronous: the text is in the editor when it paints. The
        # first keystroke's frame, measured on the reopen, is what remains.
        r["editable_ms"] = r["first_paint_ms"] + r["reopen_editable_ms"] - r["reopen_first_frame_ms"]
    shutil.rmtree(home, ignore_errors=True)
    return r


def stats(xs):
    s = sorted(xs)
    n = len(s)
    return {"mean": sum(xs) / n, "median": s[n // 2], "p95": s[n * 95 // 100], "max": s[-1], "over16": sum(x > 1000 / 60 for x in xs), "n": n}


def trace_busy(path):
    """Per keystroke: the renderer main thread's busy time, from the keydown's
    dispatch to the end of the first frame commit after it. Busy is the union
    of its top-level tasks, so time spent waiting for the frame is left out."""
    if not os.path.exists(path):
        return None
    d = json.load(open(path))
    ev = d["traceEvents"] if isinstance(d, dict) else d
    keys = sorted((e for e in ev if e.get("name") == "EventDispatch" and e.get("args", {}).get("data", {}).get("type") == "keydown"), key=lambda e: e["ts"])
    if not keys:
        return None
    thread = (keys[0]["pid"], keys[0]["tid"])
    on = lambda e: (e["pid"], e["tid"]) == thread and e.get("ph") == "X"
    tasks = sorted(((e["ts"], e["ts"] + e["dur"]) for e in ev if on(e) and e.get("name") == "ThreadControllerImpl::RunTask"))
    commits = sorted(e["ts"] + e["dur"] for e in ev if on(e) and e.get("name") == "Commit")
    out = []
    for k in keys:
        t0 = k["ts"]
        t1 = next((c for c in commits if c > t0), None)
        if t1 is None:
            continue
        busy, cur = 0, t0
        for a, b in tasks:
            a, b = max(a, cur), min(b, t1)
            if b > a:
                busy += b - a
                cur = b
        out.append(busy / 1000)
    return out


def run_electron(scratch, fixture, out):
    home = os.path.join(out, "e-home")
    os.makedirs(os.path.join(home, "ud"), exist_ok=True)
    doc = os.path.join(home, f"large-{fixture}")
    shutil.copyfile(os.path.join(scratch, "fx", f"large-{fixture}"), doc)
    env = {k: v for k, v in os.environ.items() if k not in ("ELECTRON_RUN_AS_NODE", "CLAUDE_CONFIG_DIR", "CODEX_HOME")}
    env.update(BENCH_TRACE_DIR=out, BENCH_ESRC=os.path.join(scratch, "esrc"), BENCH_OUT=os.path.join(scratch, "electron-out"), BENCH_TIMEOUT_MS="840000")
    log = os.path.join(out, "electron.log")
    meta = launch([os.path.join(scratch, "electron", "Electron.app", "Contents", "MacOS", "Electron"), os.path.join(HERE, "electron-large", "main.cjs"), f"--user-data-dir={home}/ud", doc], env, log, 900)
    r = dict(meta)
    for line in open(log).read().splitlines():
        if not line.startswith("markie-electron-bench "):
            continue
        ev = json.loads(line[len("markie-electron-bench "):])
        e = ev["event"]
        if e == "open":
            r["first_paint_ms"], r["editable_ms"] = ev["first_paint_ms"], ev["editable_ms"]
            r["launch_to_paint_ms"] = ev["requested"] + ev["first_paint_ms"] - meta["spawn"]
        elif e in ("type_start", "type_end"):
            r[f"{e}_probe_ms"] = ev["frame"]
            busy = trace_busy(os.path.join(out, f"trace-{e.replace('_', '-')}.json"))
            if busy:
                r[f"{e}_ms"] = stats(busy)
        elif e == "scroll_sweep":
            r["scroll_sweep_frame_ms"] = ev
        elif e == "scroll_sweep_gaps":
            r["scroll_sweep_gaps_ms"] = ev
        elif e == "save":
            r["save_ms"], r["save_main_ms"], r["saved_bytes"] = ev.get("ms"), ev.get("main_ms"), ev.get("on_disk")
        elif e in ("error", "timeout", "renderer-gone"):
            r["failure"] = ev
    shutil.rmtree(home, ignore_errors=True)
    return r


def main():
    global SCRATCH
    cmd, scratch = sys.argv[1], os.path.abspath(sys.argv[2])
    SCRATCH = scratch
    results_path = os.path.join(scratch, "large-results.json")
    results = json.load(open(results_path)) if os.path.exists(results_path) else []
    if cmd == "run":
        runs = int(sys.argv[sys.argv.index("--runs") + 1]) if "--runs" in sys.argv else 3
        only = sys.argv[sys.argv.index("--only") + 1].split(",") if "--only" in sys.argv else FIXTURES
        for n in range(runs):
            for fixture in only:
                for app in (("rs", "electron") if n % 2 == 0 else ("electron", "rs")):
                    if any(r["fixture"] == fixture and r["app"] == app and r["run"] == n and "failure" not in r for r in results):
                        continue
                    out = os.path.join(scratch, "runs", f"{fixture}-{app}-{n}-{int(time.time())}")
                    os.makedirs(out, exist_ok=True)
                    r = (run_rs if app == "rs" else run_electron)(scratch, fixture, out)
                    r.update(app=app, fixture=fixture, run=n, at=time.strftime("%Y-%m-%dT%H:%M:%S"))
                    results.append(r)
                    json.dump(results, open(results_path, "w"), indent=1)
                    print(f"{fixture} {app} run {n}: paint {r.get('first_paint_ms')} editable {r.get('editable_ms')} peak {r['peak_rss_mb']:.0f} MB "
                          f"type {r.get('type_start_ms', {}).get('median')}/{r.get('type_end_ms', {}).get('median')} "
                          f"scroll {r.get('scroll_sweep_frame_ms', {}).get('median')} save {r.get('save_ms')} load {r['load']:.0f} {r.get('failure', '')}", flush=True)
    summary(results)


def summary(results):
    med = lambda xs: statistics.median(xs) if xs else None
    print("| Fixture | App | First paint ms | Editable ms | Peak RSS MB | Scroll frame ms (median / p95 / max) | Type at start ms | Type at end ms | Save ms | Load |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for fixture in FIXTURES:
        for app in ("electron", "rs"):
            rs = [r for r in results if r["fixture"] == fixture and r["app"] == app and "failure" not in r]
            if not rs:
                continue
            # A peak RSS of 0 is the sampler failing (`ps` under heavy load), not a reading.
            g = lambda k: med([r[k] for r in rs if r.get(k) is not None and not (k == "peak_rss_mb" and r[k] == 0)])
            gs = lambda k, f: med([r[k][f] for r in rs if isinstance(r.get(k), dict)])
            fmt = lambda x: "n/a" if x is None else (f"{x:,.0f}" if x >= 100 else f"{x:.1f}")
            print(f"| {fixture} | {'Electron' if app == 'electron' else 'Markie RS'} | {fmt(g('first_paint_ms'))} | {fmt(g('editable_ms'))} | {fmt(g('peak_rss_mb'))} | "
                  f"{fmt(gs('scroll_sweep_frame_ms', 'median'))} / {fmt(gs('scroll_sweep_frame_ms', 'p95'))} / {fmt(gs('scroll_sweep_frame_ms', 'max'))} | "
                  f"{fmt(gs('type_start_ms', 'median'))} | {fmt(gs('type_end_ms', 'median'))} | {fmt(g('save_ms'))} | {fmt(g('load'))} ({len(rs)} runs) |")


if __name__ == "__main__":
    main()
