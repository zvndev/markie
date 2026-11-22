# Markie RS performance

Date: 2026-11-22. Goal set by Kirby on 2026-11-21: Markie RS must be much faster than Electron Markie (0.9.7). "Much faster" means at least 2x on launch and open, and no worse anywhere.

## Status

Not finished. The fixes are in and profiled, but the final before-and-after run against Electron has not run yet. For about six hours this Mac had 0 to 15% idle CPU from other agents' Rust builds and iOS simulators, and once rebooted. A timed launch in those conditions measures the other agents, so the run waits for at least half the CPU to be idle before each sample, and that never happened for long enough.

The verdict so far:

- **Open of large files: fixed, and now well ahead.** 10 MB went from 8.4 s to 142 ms of open work; 900 KB rich from 730 ms to 146 ms. Both are profiled single launches, not yet the 5-run table.
- **Launch: not yet proven 2x.** Before the fixes Markie RS reached a full frame in 207 ms on a fresh data folder and 355 to 462 ms once a Library snapshot existed; Electron took 418 ms. The snapshot cost and 120 to 150 ms of other startup work are now off the launch path, but the 2x line (209 ms) needs the final run to confirm.
- **Memory:** Markie RS used half of Electron's RSS on small files, but 3 GB on 10 MB. That came from the soft wrap layout cache, which the large-file fix removes. To be confirmed by the final run.
- **Idle CPU:** 0.0% against Electron's 0.2% with a 10 KB file. With a 10 MB file Markie RS hashed the file every second; that is fixed.

### Run the final comparison

On a quiet Mac (no other agent building):

```sh
cd rust && ./scripts/bundle-mac.sh && cd ..
MARKIE_BENCH_RS_BEFORE="$PWD/.autoloop/runs/perf/bin-before/Markie RS.app" \
  python3 rust/scripts/bench/bench.py all --apps electron,rsb,rs --label final
```

`bin-before` is a copy of the build at 57b2342 plus the instrumentation, made before any fix. Build it again from that commit with `perf.rs` if the folder is gone. About 40 minutes.

## Baseline, before the fixes

Run on 2026-11-21 at normal load, 5 runs each, median (min to max). Electron 0.9.7 against Markie RS at 57b2342.

### Launch to first full frame, ms

| Fixture | Electron 0.9.7 | Markie RS | Ratio |
|---|---|---|---|
| 10 KB Markdown | 418 (416 to 450) | 373 (207 to 462) | 1.1x faster |
| 1 MB Markdown | 755 (730 to 805) | 856 (813 to 872) | 0.9x, slower |
| 10 MB Markdown | 937 (812 to 980) | 8,645 (7,388 to 9,255) | 9x slower |
| 50-page .docx | 668 (613 to 961) | 391 (266 to 394) | 1.7x faster |

Markie RS's 10 KB spread is the Library snapshot: 207 ms on the first run, 355 to 462 ms once a saved snapshot was parsed on the main thread.

### Markie RS open work (start of `open_path` to the painted frame), ms

| Fixture | Before | After (one profiled launch) |
|---|---|---|
| 10 KB Markdown | 61.5 (27.4 to 81.1) | not yet measured |
| 900 KB Markdown, rich | 730 to 750 | 146 |
| 1 MB Markdown | 580 (553 to 594) | not yet measured |
| 10 MB Markdown | 8,358 (7,129 to 8,972) | 142 |
| 50-page .docx | 56.2 (41.0 to 58.0) | not yet measured |

### Memory after open, MB

| Fixture | Electron RSS | Markie RS RSS | Electron footprint | Markie RS footprint |
|---|---|---|---|---|
| 10 KB Markdown | 519 | 277 | 240 | 237 |
| 1 MB Markdown | 526 | 525 | 286 | 359 |
| 10 MB Markdown | 611 | 2,965 | 366 | 1,877 |
| 50-page .docx | 601 | 288 | 331 | 298 |

Electron's numbers add up its four processes.

### Idle CPU over 30 s, 10 KB file open

Electron 0.2% (0.1 to 0.3). Markie RS 0.0%.

### Keystroke to frame, Markie RS

10 KB file: 3.3 ms median (3.1 to 4.1 across runs). In a smoke run, 900 KB and 1 MB took 17 to 18 ms a key with frames of 1 to 4 ms; the rest was whole-document work in the edit handler, now deferred. The baseline runs for those two sizes lost their keystrokes to a focus failure and are not reported. Electron is not measured (see the method).

### Scrolling, Markie RS (smoke run)

1 MB (Source): 0.7 ms frame cost, frames every 8.3 ms (120 Hz), none over 16.7 ms. 900 KB (rich): 5.1 ms frame cost, also no slow frames. The rich editor's per-frame cost came from one element per off-screen block, now merged.

## Where Markie RS is not clearly faster, and the plan

| Area | Reason | Fix or plan |
|---|---|---|
| Launch, 10 KB | About 150 ms of GPUI and AppKit startup before any app code: keyboard layout, power observers, system font enumeration in `gpui_component::init`, window and Metal setup | App-side work is now off the launch path. The rest is in gpui-kit; ask upstream for lazy font enumeration and power observers, or carry a small patch |
| 1 MB and 10 MB in Source | Large files now open without soft wrap, because gpui-kit measures every line before the first frame. Electron's CodeMirror wraps lazily | Lazy, viewport-only wrapping in gpui-base's `TextWrapper`, upstream or patched; then turn wrap back on |
| Keystroke latency on Electron | Not measured | A CDP-based measure would change what it measures; left out |
| Index scan | Both apps stop at the same 30 s budget on a real home folder | The fixed 20,000-file tree in the benchmark compares their speed; pending the final run |


## Parity behaviour kept over speed

Merging the parity audit (1ef4318) brought features that need the whole text on every edit. Where they clash with the deferred edit path, parity wins:

| Case | What happens per keystroke | Cost |
|---|---|---|
| Split view (Source beside View) | Each side copies the other's whole text, compares it with the saved text and recounts words and the outline, as before the fix | Grows with the document again, as before the fix. Not measured in split view; the smoke run without split was 17 to 18 ms a key at 900 KB and 1 MB |
| A live collaboration room | Source edits go to the room with the full text; rich edits serialize the document | Same as split view, while a room is live |
| Everything else | Only the edited marker; the full-text work runs 150 ms after typing pauses | As fixed |

The crash journal never waits for the deferred work. An edit on the deferred path schedules the journal at once, 250 ms after the last edit (2 s past 256 K characters), as Electron does, timed from the length counted at the last pause. The journal reads the current text when it fires and stays off for large documents. `markie_core::drafts::JournalPacer` holds that timing; its tests show the journal written with no settle run.

Two smaller notes:

- With a scratch `MARKIE_RS_DATA_DIR`, the app now scans the data folder instead of the home folder (from the audit). The benchmark's launches therefore index only scratch files; its scratch `HOME` is a second guard.
- The Library's search now has a background body search from the audit (`doc_text::search_documents`). The per-keystroke instant filter still uses `SearchIndex`; the body search runs off the main thread and is not in the search table.

## Hot spots found and fixed

Found with samply on a release build with line tables (`profile.sh`, `hot.py`, `timeline.py`). Times are from single profiled launches.

| Hot spot | Where | Cost before | Fix | After |
|---|---|---|---|---|
| Soft wrap measured every line of the file with CoreText before the first frame | gpui-kit `TextWrapper`, Source editor | 5 s and about 2.5 GB for 10 MB | Files in the large tier (1 MB and up, Source only) open without soft wrap | 10 MB opens in 142 ms |
| Outline counted lines from the top of the file for every heading | `markie-core/src/outline.rs` | 2 s for 10 MB, on open and on every edit | Counts lines incrementally | Linear, a few ms |
| Rich editor measured all blocks in the first frame, and again on each resize | `markie-editor/src/render.rs` | 680 ms at 900 KB (2,400 blocks) | Measures what is near the screen, plus 48 more blocks a frame until all are known | 900 KB opens in 146 ms |
| One spacer element per off-screen block, laid out every frame | `markie-editor/src/render.rs` | 4 to 5 ms a frame at 900 KB | One spacer per run of off-screen blocks | See the scrolling table |
| Saved Library snapshot parsed on the main thread before the first frame | `workspace.rs` `Workspace::new` | Launch grew from 207 ms to 355 to 460 ms once a snapshot existed | Loaded, saved and indexed in the background | No longer on the launch path |
| Every keystroke serialized the whole document, compared it with the saved text and recounted words and headings | `workspace.rs`, `workspace/rich.rs` | Grows with the document; 17 to 18 ms key to frame at 900 KB and 1 MB in a smoke run, against 2 ms at 10 KB | The edited marker is set at once; the exact check, counts and outline run 150 ms after typing pauses | See the typing table |
| Library search lowercased every name, path and 8 KB snippet on every query | `markie-core/src/search.rs` | 100,000 rows and 32 MB of snippets per keystroke | `SearchIndex` keeps lowercase keys and the recency order per snapshot; ASCII terms match snippets without copying | See the search table |
| Format counts recounted over every Library row on every frame | `library.rs` | 100,000 rows a frame | Counted once per list | Off the frame path |
| Recent and Starred rows stat each file on the main thread | `workspace.rs` `refresh_lists` | 68 ms of the launch | Built in the background | Off the launch path |
| Menu bar built before the first window | `main.rs` | 50 to 80 ms of the launch | Built just after the first frame | Off the launch path |
| The 1 s disk poll read and SHA-256 hashed the open file every second | `markie-core/src/disk.rs` | 76 ms of main thread a second for 10 MB | Reads only when size or mtime moved; fast in-memory hash | Idle |
| Opening parsed the rich document twice and fed a Markdown preview that is never shown | `workspace.rs` `open_path` | A second full parse, and a background parse of 10 MB | One parse; no preview feed | |
| The statistics panel recounted the whole text every frame | `workspace/panels.rs` | Linear in the document, per frame | Uses the counts kept at settle | |


## How it is measured

Everything lives in `rust/scripts/bench/`. One command runs it all:

```sh
cd rust && ./scripts/bundle-mac.sh
MARKIE_BENCH_RS_BEFORE=<a saved older Markie RS.app> \
  python3 scripts/bench/bench.py all --apps electron,rsb,rs --label final
python3 scripts/bench/bench.py summary --label final
```

Leave out `MARKIE_BENCH_RS_BEFORE` and `rsb` to compare only the current build with Electron. Results land in `.autoloop/runs/perf/results/` (gitignored) as JSON; `summary` prints the tables below.

| Script | What it does |
|---|---|
| `bench.py` | Drives every measurement, keeps the screen rules, writes results and tables |
| `gen-fixtures.py` | Deterministic fixtures: 10 KB, 900 KB, 1 MB and 10 MB Markdown, a 50-page `.docx`, and a 20,000-file folder tree |
| `firstframe.swift` | Watches one PID's window with `CGWindowListCreateImage` and reports when it first showed its final content |
| `postscroll.swift` | Wheel events for `act.sh <pid> scroll`; stops if the pointer leaves that window |
| `electron-index.cjs`, `asar-extract.cjs` | Run the installed Electron app's own `mdindex.js` and Library filter in Node |
| `profile.sh`, `hot.py`, `timeline.py` | A samply profile of one launch, its hottest functions, and what the main thread ran in each 10 ms |

### The measurements

- **Launch to first full frame.** The app is started with the fixture on the command line, under the shared screen lock. `firstframe` polls the window about every 16 ms. The first frame is the first capture whose document area already matches the settled window. Both apps are timed this way, from the same spawn. This is cold launch with a warm disk cache: one untimed launch of each app comes first.
- **Open.** The same launch, per fixture. Markie RS also reports, through `MARKIE_RS_PERF=1`, the time from the start of `open_path` to the end of the paint that shows the document.
- **Memory.** RSS and physical footprint one second after the first frame, summed over the app's whole process tree (Electron runs four processes).
- **Idle CPU.** With the 10 KB file open, after the startup index scan finishes, CPU time over 30 seconds, all processes.
- **Keystroke to frame (Markie RS).** `act.sh` types 44 characters at the end of a line. `MARKIE_RS_PERF=1` timestamps each keystroke as GPUI receives it and the end of the next painted frame. Frame cost is the main-thread time from the start of that frame's render to the end of its paint. Electron's typing latency is not measured: there is no comparable hook without a debugging protocol that changes what it measures.
- **Scrolling (Markie RS).** 240 wheel events 8 ms apart, down then back up. Each painted frame during the scroll logs its cost and the gap since the previous frame.
- **Index and search.** Both apps' own index code scans a fixed 20,000-file tree to completion, then the real home folder (read only). Both stop the home scan at their 30-second budget, so that row compares files found. Search runs five queries against the scan: Markie RS's `SearchIndex::search`, as the Library calls it per keystroke, and Electron's Library filter from `browse-view.tsx`. Electron's React re-render after the filter is not included, which flatters Electron.

Each number is the median of 5 runs, with the minimum and maximum in brackets.

### Rules the scripts keep

- Every app is launched directly, so the script knows its PID, and only that PID is ever signalled. Nothing is addressed by name.
- Electron is always started as `Markie --user-data-dir=<scratch> <fixture>`.
- Only fixtures passed on the command line are opened. No capture of Electron's Browse, Search or Library lists, and no capture of Markie RS's window is saved, because its Library lists file names from the home folder.
- The Markie RS data folder is scratch, seeded so it never imports the Electron registry.
- Other agents build Rust on the same Mac. Apps take turns run by run, each sample waits for the 1-minute load average to fall under the core count, and each result records the load it ran under.

### Instrumentation

`MARKIE_RS_PERF=1` turns on `crates/markie-app/src/perf.rs`. It writes `markie-perf {json}` lines to stderr: `main`, `first_paint`, `open`, `key`, `scroll_frame` and `scan`. Off, it costs one atomic load per call and draws nothing.
