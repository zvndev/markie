#!/usr/bin/env python3
"""Markie RS against Electron Markie: launch, open, memory, idle CPU, typing
and scrolling. See docs/rust-port/PERF.md for what each number means.

  bench.py all     [--runs 5] [--out DIR]   everything below, then a summary
  bench.py launch  [--runs 5] [--out DIR]   launch + open + RSS (+ idle CPU)
  bench.py typing  [--runs 5] [--out DIR]   Markie RS keystroke to frame
  bench.py scroll  [--runs 5] [--out DIR]   Markie RS scroll frame times
  bench.py index   [--runs 5] [--out DIR]   device index scan + search
  bench.py summary [--out DIR]              print the tables from saved runs

Rules it keeps (docs/rust-port/SCREEN.md):
- Every app it starts is launched directly, so it knows the PID, and it only
  ever signals those PIDs.
- Electron is always started with --user-data-dir=<scratch>.
- Each timed launch and every keystroke or scroll holds the shared screen
  lock (with-screen-lock.sh, act.sh).
- Data folders and fixtures live under DIR (default .autoloop/runs/perf).
- Every app runs with HOME=DIR/home (a generated tree) and without
  CLAUDE_CONFIG_DIR or CODEX_HOME, so its index never sees Kirby's files.
"""
import argparse
import json
import os
import shutil
import signal
import sqlite3
import statistics
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUST = HERE.parent.parent
REPO = RUST.parent
SCREEN = RUST / "scripts" / "screen"
TOOLS = RUST / "target" / "bench-tools"
# MARKIE_BENCH_RS_APP points at another build, for example a saved "before" copy.
RS_APP = Path(os.environ.get("MARKIE_BENCH_RS_APP", RUST / "target" / "release" / "Markie RS.app"))
RS_BIN = RS_APP / "Contents" / "MacOS" / "markie-rs"
EL_BIN = Path("/Applications/Markie.app/Contents/MacOS/Markie")
EL_ASAR = Path("/Applications/Markie.app/Contents/Resources/app.asar")

FIXTURES = ["doc-10k.md", "doc-900k.md", "doc-1m.md", "doc-10m.md", "doc-50p.docx"]


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def now_ms() -> float:
    return time.time() * 1000


def tools():
    TOOLS.mkdir(parents=True, exist_ok=True)
    for name in ("firstframe", "postscroll"):
        src, exe = HERE / f"{name}.swift", TOOLS / name
        if not exe.exists() or exe.stat().st_mtime < src.stat().st_mtime:
            subprocess.run(["swiftc", "-O", "-target", "arm64-apple-macos13", str(src), "-o", str(exe)],
                           check=True, stderr=subprocess.DEVNULL)


def fixtures(out: Path) -> Path:
    d = out / "fixtures"
    if not (d / "doc-50p.docx").exists():
        subprocess.run([sys.executable, str(HERE / "gen-fixtures.py"), str(d)], check=True, stdout=subprocess.DEVNULL)
    return d


def tree_pids(root: int) -> list[int]:
    """root and every descendant (Electron's helpers are children)."""
    rows = subprocess.run(["ps", "-A", "-o", "pid=,ppid="], capture_output=True, text=True).stdout.split("\n")
    kids: dict[int, list[int]] = {}
    for r in rows:
        parts = r.split()
        if len(parts) == 2:
            kids.setdefault(int(parts[1]), []).append(int(parts[0]))
    out, todo = [], [root]
    while todo:
        p = todo.pop()
        out.append(p)
        todo.extend(kids.get(p, []))
    return out


def rss_mb(root: int) -> float:
    pids = ",".join(map(str, tree_pids(root)))
    rows = subprocess.run(["ps", "-o", "rss=", "-p", pids], capture_output=True, text=True).stdout.split()
    return sum(int(x) for x in rows) / 1024


def footprint_mb(root: int) -> float | None:
    """Physical footprint (what Activity Monitor calls Memory), summed."""
    total = 0.0
    for pid in tree_pids(root):
        r = subprocess.run(["footprint", "-p", str(pid)], capture_output=True, text=True)
        # `footprint` prints "<name> [pid]: 64-bit    Footprint: 123 MB (16384 bytes per page)"
        for line in r.stdout.splitlines():
            if "Footprint:" in line:
                val = line.split("Footprint:")[1].strip().split()
                num, unit = float(val[0]), val[1].upper()
                total += num * {"B": 1 / 1048576, "KB": 1 / 1024, "MB": 1, "GB": 1024}.get(unit, 1)
                break
    return total or None


def cpu_seconds(root: int) -> float:
    pids = ",".join(map(str, tree_pids(root)))
    rows = subprocess.run(["ps", "-o", "time=", "-p", pids], capture_output=True, text=True).stdout.split()
    total = 0.0
    for t in rows:
        parts = t.split(":")
        sec = 0.0
        for p in parts:
            sec = sec * 60 + float(p)
        total += sec
    return total


def kill_tree(root: int):
    """Only the PID we launched; Electron takes its helpers down itself."""
    try:
        os.kill(root, signal.SIGTERM)
    except ProcessLookupError:
        return
    for _ in range(50):
        try:
            os.kill(root, 0)
        except ProcessLookupError:
            return
        time.sleep(0.1)
    try:
        os.kill(root, signal.SIGKILL)
    except ProcessLookupError:
        pass


def seed_rs_data(data: Path):
    """A scratch data folder that never imports from the Electron registry."""
    data.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(data / "registry.db")
    db.execute("CREATE TABLE IF NOT EXISTS rs_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    db.execute("INSERT OR REPLACE INTO rs_settings VALUES ('electron_import', 'skipped by bench')")
    db.commit()
    db.close()


# A second Markie RS build to run alongside, e.g. the saved "before" copy:
# MARKIE_BENCH_RS_BEFORE=<path to Markie RS.app>, app name "rsb".
RSB_APP = os.environ.get("MARKIE_BENCH_RS_BEFORE")


def scratch_env(out: Path) -> dict:
    """The environment for every app this script starts. The device index
    walks $HOME and $CLAUDE_CONFIG_DIR/skills and $CODEX_HOME/skills, and
    agent shells point those at real folders, so they are dropped and HOME
    is a scratch folder holding a generated 20,000-file tree: the Library
    is realistic and none of it is Kirby's. (The index benchmark's scan of
    the real home folder is the one read-only exception.)"""
    env = {k: v for k, v in os.environ.items() if k not in ("CLAUDE_CONFIG_DIR", "CODEX_HOME")}
    home = out / "home"
    if not (home / "notes" / ".done").exists():
        subprocess.run([sys.executable, str(HERE / "gen-fixtures.py"), "--tree", str(home / "notes")], check=True)
    env["HOME"] = str(home)
    return env


def is_rs(app: str) -> bool:
    return app in ("rs", "rsb")


def launch_cmd(app: str, file: Path, data: Path) -> tuple[list[str], dict]:
    # Electron refuses a relative profile path; both get absolute paths.
    file, data = file.resolve(), data.resolve()
    env = scratch_env(data.parent.parent)
    if is_rs(app):
        env["MARKIE_RS_DATA_DIR"] = str(data)
        env["MARKIE_RS_PERF"] = "1"
        binary = RS_BIN if app == "rs" else Path(RSB_APP) / "Contents" / "MacOS" / "markie-rs"
        return [str(binary), str(file)], env
    return [str(EL_BIN), f"--user-data-dir={data}", str(file)], env


def timed_launch(app: str, file: Path, data: Path, logf: Path, png: Path | None = None) -> dict:
    """Launch under the screen lock, wait for the first full frame, release."""
    cmd, env = launch_cmd(app, file, data)
    logf.parent.mkdir(parents=True, exist_ok=True)
    inner = [sys.executable, str(Path(__file__)), "_launch", app, str(file), str(data), str(logf)]
    if png:
        inner.append(str(png))
    r = subprocess.run([str(SCREEN / "with-screen-lock.sh"), f"bench-launch-{app}", "--", *inner],
                       capture_output=True, text=True, env=env)
    if r.returncode != 0:
        raise RuntimeError(f"launch failed: {r.stderr.strip()}")
    return json.loads(r.stdout.strip().splitlines()[-1])


def _launch(app: str, file: str, data: str, logf: str, png: str | None):
    cmd, env = launch_cmd(app, Path(file), Path(data))
    t0 = now_ms()
    with open(logf, "w") as lf:
        p = subprocess.Popen(cmd, env=env, stdout=subprocess.DEVNULL, stderr=lf, start_new_session=True)
    ff = [str(TOOLS / "firstframe"), str(p.pid), f"{t0:.3f}", "--timeout", "30", "--settle", "2"]
    if png:
        ff += ["--png", png]
    r = subprocess.run(ff, capture_output=True, text=True)
    res = json.loads(r.stdout.strip() or "{}")
    res.update(pid=p.pid, t0=t0)
    print(json.dumps(res))


def perf_events(logf: Path) -> list[dict]:
    out = []
    try:
        for line in logf.read_text(errors="replace").splitlines():
            if line.startswith("markie-perf "):
                try:
                    out.append(json.loads(line[len("markie-perf "):]))
                except json.JSONDecodeError:
                    pass
    except FileNotFoundError:
        pass
    return out


def wait_for(pred, timeout: float, step: float = 0.25) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(step)
    return False


def save(out: Path, name: str, data):
    (out / "results").mkdir(parents=True, exist_ok=True)
    (out / "results" / f"{name}.json").write_text(json.dumps(data, indent=1))


def load(out: Path, name: str):
    p = out / "results" / f"{name}.json"
    return json.loads(p.read_text()) if p.exists() else None


# ---------------------------------------------------------------- launch / open

def load1() -> float:
    return os.getloadavg()[0]


def wait_quiet(limit: float, max_wait: float = 600):
    """Other agents build Rust on this Mac. Wait until the 1-minute load is
    under `limit` (or give up after max_wait s) so a sample is not a build."""
    end = time.time() + max_wait
    while load1() > limit and time.time() < end:
        time.sleep(5)


def one_launch(out: Path, app: str, name: str, i: int, label: str, idle: bool) -> dict:
    fx = out / "fixtures"
    data = out / "data" / f"{app}-{label}"
    logf = out / "logs" / f"{label}-{app}-{name}-{i}.log"
    # Electron only: its captured window shows the document and the icon
    # rail. Markie RS's window shows its Library, which lists files from the
    # home folder, so it is never saved.
    png = out / "shots" / f"{label}-{app}-{name}.png" if i == 1 and app == "electron" else None
    if png:
        png.parent.mkdir(parents=True, exist_ok=True)
    res = timed_launch(app, fx / name, data, logf, png)
    res["load1"] = load1()
    pid = res["pid"]
    try:
        if is_rs(app):
            wait_for(lambda: any(e["event"] == "open" for e in perf_events(logf)), 15)
        time.sleep(1.0)
        res["rss_mb"] = rss_mb(pid)
        res["footprint_mb"] = footprint_mb(pid)
        ev = perf_events(logf)
        if is_rs(app):
            main = next((e for e in ev if e["event"] == "main"), None)
            opened = next((e for e in ev if e["event"] == "open"), None)
            if opened:
                res["rs_open_ms"] = opened["ms"]
                res["rs_open_frame_ms"] = opened["t"] - res["t0"]
            if main:
                res["rs_main_ms"] = main["t"] - res["t0"]
        if idle:
            # Idle: let the startup scan finish, then 30 s of nothing.
            if is_rs(app):
                wait_for(lambda: any(e["event"] == "scan" for e in perf_events(logf)), 45)
                time.sleep(3)
            else:
                time.sleep(35)
            c0 = cpu_seconds(pid)
            time.sleep(30)
            res["idle_cpu_pct"] = (cpu_seconds(pid) - c0) / 30 * 100
            res["idle_rss_mb"] = rss_mb(pid)
    finally:
        kill_tree(pid)
        time.sleep(0.5)
    return res


def bench_launch(out: Path, runs: int, idle: bool, apps: list[str], label: str, fixtures_list: list[str],
                 load_limit: float):
    fixtures(out)
    results = load(out, f"launch-{label}") or {}
    for app in apps:
        if is_rs(app):
            seed_rs_data(out / "data" / f"{app}-{label}")
    for name in fixtures_list:
        rows: dict[str, list] = {app: [] for app in apps}
        # One untimed launch of each first: a first run creates the profile
        # and warms the disk cache, for every app alike. Then the apps take
        # turns, run by run, so a load spike hits them all alike.
        for i in range(runs + 1):
            order = apps if i % 2 == 0 else list(reversed(apps))
            for app in order:
                wait_quiet(load_limit)
                res = one_launch(out, app, name, i, label, idle and name == "doc-10k.md" and i > 0)
                if i == 0:
                    log(f"{app} {name}: warm-up {res.get('content_ms')} ms")
                    continue
                log(f"{app} {name} run {i}: content {res.get('content_ms')} ms, rss {res['rss_mb']:.0f} MB, "
                    f"load {res['load1']:.0f}"
                    + (f", rs open {res.get('rs_open_ms', 0):.1f} ms" if is_rs(app) else "")
                    + (f", idle cpu {res['idle_cpu_pct']:.2f}%" if "idle_cpu_pct" in res else ""))
                rows[app].append(res)
        for app in apps:
            results[f"{app}/{name}"] = rows[app]
        save(out, f"launch-{label}", results)
    return results


# ---------------------------------------------------------------- typing / scroll

def act(pid: int, *args: str):
    subprocess.run([str(SCREEN / "act.sh"), str(pid), *args], check=True, capture_output=True)


def window_size(pid: int) -> tuple[int, int] | None:
    r = subprocess.run(["osascript", "-l", "JavaScript", str(SCREEN / "windows.js"), str(pid)], capture_output=True, text=True)
    rows = [json.loads(l) for l in r.stdout.splitlines() if l.strip()]
    if not rows:
        return None
    rows.sort(key=lambda w: w["w"] * w["h"], reverse=True)
    return int(rows[0]["w"]), int(rows[0]["h"])


def rs_session(out: Path, app: str, label: str, file: Path, logf: Path, load_limit: float, body):
    """Launch one Markie RS build on `file`, wait for the open and the startup
    scan (the Library full, as a user has it, and the scan no longer
    competing for the CPU), run `body(pid)`, quit."""
    data = out / "data" / f"{app}-{label}"
    seed_rs_data(data)
    wait_quiet(load_limit)
    res = timed_launch(app, file, data, logf)
    pid = res["pid"]
    try:
        wait_for(lambda: any(e["event"] == "open" for e in perf_events(logf)), 15)
        wait_for(lambda: any(e["event"] == "scan" for e in perf_events(logf)), 60)
        time.sleep(0.5)
        return body(pid)
    except subprocess.CalledProcessError as e:
        log(f"  {app}: input refused ({(e.stderr or b'').decode(errors='replace').strip()}); run skipped")
        return None
    finally:
        kill_tree(pid)
        time.sleep(0.5)


def bench_typing(out: Path, runs: int, label: str, apps: list[str], load_limit: float):
    fx = fixtures(out)
    results = load(out, f"typing-{label}") or {}
    for name in ("doc-10k.md", "doc-900k.md", "doc-1m.md"):
        rows: dict[str, list] = {app: [] for app in apps}
        for i in range(runs):
            for app in apps:
                # Type into a scratch copy, so the fixture never changes.
                copy = out / "scratch" / f"type-{app}-{i}-{name}"
                copy.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy(fx / name, copy)
                logf = out / "logs" / f"{label}-typing-{app}-{name}-{i}.log"

                def body(pid, logf=logf):
                    # Click into the text, go to the end of that line, type.
                    act(pid, "click", "700", "260")
                    act(pid, "keys", "key code 119")  # End
                    before = len([e for e in perf_events(logf) if e["event"] == "key"])
                    act(pid, "type", " the quick brown fox jumps over the lazy dog")
                    time.sleep(0.6)
                    keys = [e for e in perf_events(logf) if e["event"] == "key"][before:]
                    return {"ms": [k["ms"] for k in keys], "cost": [k["cost"] for k in keys], "load1": load1()}

                r = rs_session(out, app, label, copy, logf, load_limit, body)
                if r and r["ms"]:
                    rows[app].append(r)
                    log(f"typing {app} {name} run {i + 1}: {len(r['ms'])} frames for 44 keys, "
                        f"median {statistics.median(r['ms']):.1f} ms, load {r['load1']:.0f}")
        for app in apps:
            results[f"{app}/{name}"] = rows[app]
        save(out, f"typing-{label}", results)


def bench_scroll(out: Path, runs: int, label: str, apps: list[str], load_limit: float):
    fx = fixtures(out)
    results = load(out, f"scroll-{label}") or {}
    for name in ("doc-1m.md", "doc-900k.md"):
        rows: dict[str, list] = {app: [] for app in apps}
        for i in range(runs):
            for app in apps:
                logf = out / "logs" / f"{label}-scroll-{app}-{name}-{i}.log"

                def body(pid, logf=logf):
                    # 240 wheel events, 8 ms apart, over the document: down, then up.
                    act(pid, "scroll", "700", "400", "-60", "240", "8")
                    time.sleep(0.4)
                    frames = [e for e in perf_events(logf) if e["event"] == "scroll_frame"]
                    return {"cost": [f["cost"] for f in frames], "gap": [f["gap"] for f in frames[1:]], "load1": load1()}

                r = rs_session(out, app, label, fx / name, logf, load_limit, body)
                if r and r["cost"]:
                    rows[app].append(r)
                    log(f"scroll {app} {name} run {i + 1}: {len(r['cost'])} frames, median cost "
                        f"{statistics.median(r['cost']):.2f} ms, load {r['load1']:.0f}")
        for app in apps:
            results[f"{app}/{name}"] = rows[app]
        save(out, f"scroll-{label}", results)


# ---------------------------------------------------------------- index / search

def bench_index(out: Path, runs: int, label: str, load_limit: float):
    el_dir = out / "electron-app"
    if not (el_dir / "electron" / "mdindex.js").exists():
        subprocess.run(["node", str(HERE / "asar-extract.cjs"), str(EL_ASAR), str(el_dir), "electron/"], check=True,
                       capture_output=True)
    tree = out / "tree"
    subprocess.run([sys.executable, str(HERE / "gen-fixtures.py"), "--tree", str(tree)], check=True)
    subprocess.run(["cargo", "build", "--release", "-q", "-p", "markie-core", "--example", "perf_index"], cwd=RUST, check=True)
    rs_bin = RUST / "target" / "release" / "examples" / "perf_index"
    result = {}
    # The fixed tree first (both walk all of it), then the real home folder
    # (both stop at their 30 s budget, so the number is files found).
    for where, home in (("tree", str(tree)), ("home", None)):
        env = dict(os.environ)
        if home:
            env["MARKIE_BENCH_HOME"] = home
        else:
            env.pop("MARKIE_BENCH_HOME", None)
        wait_quiet(load_limit)
        rs = json.loads(subprocess.run([str(rs_bin), str(runs)], env=env, capture_output=True, text=True, check=True).stdout.strip().splitlines()[-1])
        wait_quiet(load_limit)
        el = json.loads(subprocess.run(["node", str(HERE / "electron-index.cjs"), str(el_dir), str(runs)], env=env,
                                       capture_output=True, text=True, check=True).stdout.strip().splitlines()[-1])
        result[where] = {"rs": rs, "electron": el, "load1": load1()}
        log(f"index {where}: rs median {statistics.median(rs['scan_ms']):.0f} ms ({rs['files']} files), "
            f"electron median {statistics.median(el['scan_ms']):.0f} ms ({el['files']} files)")
        save(out, f"index-{label}", result)


# ---------------------------------------------------------------- summary

def stat(xs: list[float]) -> str:
    xs = [x for x in xs if x is not None]
    if not xs:
        return "n/a"
    m = statistics.median(xs)
    return f"{m:.1f} ({min(xs):.1f} to {max(xs):.1f})" if m < 100 else f"{m:.0f} ({min(xs):.0f} to {max(xs):.0f})"


def summary(out: Path, label: str):
    lines = []
    launch = load(out, f"launch-{label}")
    if launch:
        names = {"electron": "Electron 0.9.7", "rsb": "Markie RS before", "rs": "Markie RS"}
        apps = [a for a in ("electron", "rsb", "rs") if any(k.startswith(a + "/") for k in launch)]
        for metric, title in (("content_ms", "Launch to first full frame, ms"),
                              ("rs_open_ms", "Markie RS open_path to painted frame, ms"),
                              ("rss_mb", "RSS after open, MB (all processes)"),
                              ("footprint_mb", "Physical footprint after open, MB")):
            cols = [a for a in apps if metric != "rs_open_ms" or is_rs(a)]
            lines.append(f"\n### {title} ({label}): median (min to max)\n")
            lines.append("| Fixture | " + " | ".join(names[a] for a in cols) + " |")
            lines.append("|---" * (len(cols) + 1) + "|")
            for name in FIXTURES:
                if not any(f"{a}/{name}" in launch for a in cols):
                    continue
                lines.append(f"| {name} | " + " | ".join(stat([r.get(metric) for r in launch.get(f"{a}/{name}", [])]) for a in cols) + " |")
        lines.append("\nIdle CPU over 30 s, 10 KB document open, %: " + ", ".join(
            f"{names[a]} {stat([r.get('idle_cpu_pct') for r in launch.get(f'{a}/doc-10k.md', [])])}" for a in apps))
        loads = [r.get("load1") for rows in launch.values() for r in rows if r.get("load1") is not None]
        if loads:
            lines.append(f"\nLoad average during samples: {stat(loads)}")
    typing = load(out, f"typing-{label}")
    if typing:
        lines.append(f"\n## Keystroke to frame ({label}): median of per-run medians (min to max), ms\n")
        lines.append("| Build / fixture | key to painted frame | frame cost | p95 key to frame |")
        lines.append("|---|---|---|---|")
        for name, rows in typing.items():
            meds = [statistics.median(r["ms"]) for r in rows if r["ms"]]
            costs = [statistics.median(r["cost"]) for r in rows if r["cost"]]
            p95 = [sorted(r["ms"])[int(len(r["ms"]) * 0.95) - 1] for r in rows if len(r["ms"]) > 5]
            lines.append(f"| {name} | {stat(meds)} | {stat(costs)} | {stat(p95)} |")
    scroll = load(out, f"scroll-{label}")
    if scroll:
        lines.append(f"\n## Scrolling ({label}): per-run values, ms\n")
        lines.append("| Build / fixture | median frame cost | p95 frame cost | median gap between frames | frames over 16.7 ms |")
        lines.append("|---|---|---|---|---|")
        for name, rows in scroll.items():
            med = [statistics.median(r["cost"]) for r in rows if r["cost"]]
            p95 = [sorted(r["cost"])[int(len(r["cost"]) * 0.95) - 1] for r in rows if len(r["cost"]) > 5]
            gap = [statistics.median(r["gap"]) for r in rows if r["gap"]]
            slow = [100 * sum(1 for c in r["cost"] if c > 16.7) / len(r["cost"]) for r in rows if r["cost"]]
            lines.append(f"| {name} | {stat(med)} | {stat(p95)} | {stat(gap)} | {stat(slow)} % |")
    index = load(out, f"index-{label}")
    if index:
        lines.append(f"\n## Device index and search ({label}): median (min to max), ms\n")
        for where, title in (("tree", "Fixed 20,000-file tree"), ("home", "Home folder (both stop at their 30 s budget)")):
            if where not in index:
                continue
            rs, el = index[where]["rs"], index[where]["electron"]
            lines.append(f"**{title}.** Scan: Electron {stat(el['scan_ms'])} for {el['files']} files; "
                         f"Markie RS {stat(rs['scan_ms'])} for {rs['files']} files.\n")
            lines.append("| Query | Electron filter | Markie RS search | Electron hits | RS hits |")
            lines.append("|---|---|---|---|---|")
            for qe, qr in zip(el["queries"], rs["queries"]):
                lines.append(f"| `{qe['query']}` | {stat(qe['ms'])} | {stat(qr['ms'])} | {qe['hits']} | {qr['hits']} |")
            lines.append("")
    print("\n".join(lines))


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "_launch":
        _launch(*sys.argv[2:6], sys.argv[6] if len(sys.argv) > 6 else None)
        return
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["all", "launch", "typing", "scroll", "index", "summary"])
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--out", default=str(REPO / ".autoloop" / "runs" / "perf"))
    ap.add_argument("--label", default="current", help="results name, e.g. before or after")
    ap.add_argument("--apps", default="electron,rs")
    ap.add_argument("--no-idle", action="store_true")
    ap.add_argument("--fixtures", default=",".join(FIXTURES))
    ap.add_argument("--load-limit", type=float, default=float(os.cpu_count() or 8),
                    help="wait for the 1-minute load average to fall under this before each sample")
    a = ap.parse_args()
    out = Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    tools()
    apps = a.apps.split(",")
    if "rsb" in apps and not RSB_APP:
        sys.exit("set MARKIE_BENCH_RS_BEFORE to the other Markie RS.app")
    if "rs" in apps and not RS_BIN.exists():
        sys.exit(f"build the app first: {RUST}/scripts/bundle-mac.sh")
    if a.what in ("all", "launch"):
        bench_launch(out, a.runs, not a.no_idle, apps, a.label, a.fixtures.split(","), a.load_limit)
    if a.what in ("all", "typing"):
        bench_typing(out, a.runs, a.label, [x for x in apps if is_rs(x)], a.load_limit)
    if a.what in ("all", "scroll"):
        bench_scroll(out, a.runs, a.label, [x for x in apps if is_rs(x)], a.load_limit)
    if a.what in ("all", "index"):
        bench_index(out, a.runs, a.label, a.load_limit)
    summary(out, a.label)


if __name__ == "__main__":
    main()
