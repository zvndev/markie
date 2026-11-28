# Markie RS performance

Date: 2026-11-22. Goal set by Kirby on 2026-11-21: Markie RS must be much faster than Electron Markie (0.9.7). "Much faster" means at least 2x on launch and open, and no worse anywhere.

## Large documents (editors 7.9)

Date: 2026-11-28, branch `t3/markie-rs-large-file-speed` (from `t3/markie-rs-perf-79`), against Electron Markie 0.9.7 (main e8440384 on Electron 42.11.18). Three runs of each, medians. The first timed run, on branch `t3/markie-rs-perf-79` before these fixes, is the "Before" column.

### Summary

- **Markie RS is now faster than Electron at every size, in both .md and .txt, on open and on save.** It also keeps its lead in typing, scrolling and memory.
- **Open**: 100 MB is editable in 341 to 360 ms, against Electron's 640 ms (text) and 1,418 ms (Markdown). Before the fixes it took 1.9 s.
- **Save**: 100 MB saves in 87 to 114 ms, against Electron's 479 to 557 ms. Before the fixes it took 0.8 to 0.9 s. The main thread is held for 1 to 3 ms of it.
- **Verdict for 7.9: PASS.** Every row is equal or better.
- A file of exactly 100,000,000 bytes is refused by both apps before it is read (`MAX_DOC_BYTES`), so "100 MB" here is 99,999,000 bytes.

| Fixture | Editable: Electron | Before | After | Save: Electron | Before | After |
|---|---|---|---|---|---|---|
| 1 MB .md | 304 | 101 | 78.7 | 27.0 | 24.2 | 16.6 |
| 1 MB .txt | 276 | 80.4 | 50.8 | 23.0 | 20.0 | 15.8 |
| 10 MB .md | 406 | 254 | 98.9 | 74.0 | 99.7 | 22.2 |
| 10 MB .txt | 283 | 210 | 98.5 | 73.0 | 101 | 42.5 |
| 50 MB .md | 999 | 952 | 251 | 245 | 466 | 55.0 |
| 50 MB .txt | 467 | 995 | 196 | 291 | 459 | 52.6 |
| 100 MB .md | 1,418 | 1,905 | 360 | 557 | 940 | 114 |
| 100 MB .txt | 640 | 1,895 | 341 | 479 | 806 | 87.0 |

Editable and save are in ms. Electron's columns are from this run, taking turns with the "After" build; "Before" is Markie RS in the first run. Markie RS is 1.9x (100 MB .txt) to 5.4x (1 MB .txt) faster to open, and 1.5x (1 MB .txt) to 5.5x (50 and 100 MB .txt) faster to save.

### Results

Medians of 3 runs. Load is the 1-minute load average when the run started, on 18 cores. "Save, main thread" is how long ⌘S held Markie RS's main thread; the save column is the whole save, until it has landed and been recorded.

| Fixture | App | First paint ms | Editable ms | Peak RSS MB | Scroll frame ms (median / p95 / max) | Key at start ms | Key at end ms | Save ms | Save, main thread ms | Load |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 MB .md | Electron | 284 | 304 | 1,207 | 3.1 / 3.9 / 4.5 | 6.6 | 26.7 | 27.0 | n/a | 530 |
| 1 MB .md | Markie RS | 76.2 | 78.7 | 282 | 1.4 / 1.8 / 3.8 | 1.0 | 1.1 | 16.6 | 1.6 | 436 |
| 1 MB .txt | Electron | 262 | 276 | 1,016 | 2.6 / 3.1 / 3.5 | 5.1 | 4.9 | 23.0 | n/a | 465 |
| 1 MB .txt | Markie RS | 48.9 | 50.8 | 161 | 1.2 / 1.5 / 3.9 | 0.7 | 0.7 | 15.8 | 1.1 | 496 |
| 10 MB .md | Electron | 348 | 406 | 1,556 | 4.2 / 5.3 / 16.7 | 15.1 | 34.8 | 74.0 | n/a | 397 |
| 10 MB .md | Markie RS | 96.4 | 98.9 | 807 | 1.6 / 1.9 / 4.3 | 0.9 | 0.9 | 22.2 | 2.8 | 368 |
| 10 MB .txt | Electron | 254 | 283 | 1,177 | 4.4 / 5.6 / 10.9 | 17.2 | 16.1 | 73.0 | n/a | 296 |
| 10 MB .txt | Markie RS | 95.4 | 98.5 | 293 | 1.5 / 1.7 / 4.2 | 0.8 | 0.8 | 42.5 | 1.2 | 277 |
| 50 MB .md | Electron | 879 | 999 | 2,543 | 7.0 / 14.5 / 25.6 | 67.8 | 83.1 | 245 | n/a | 249 |
| 50 MB .md | Markie RS | 248 | 251 | 1,989 | 1.6 / 1.9 / 4.2 | 0.9 | 1.0 | 55.0 | 1.6 | 231 |
| 50 MB .txt | Electron | 374 | 467 | 2,511 | 12.3 / 21.0 / 30.3 | 66.2 | 64.6 | 291 | n/a | 219 |
| 50 MB .txt | Markie RS | 194 | 196 | 855 | 1.3 / 1.6 / 3.8 | 0.7 | 0.7 | 52.6 | 1.0 | 410 |
| 100 MB .md | Electron | 1,239 | 1,418 | 4,190 | 20.1 / 35.5 / 50.5 | 116 | 138 | 557 | n/a | 388 |
| 100 MB .md | Markie RS | 357 | 360 | 2,607 | 1.5 / 1.8 / 4.1 | 0.8 | 0.9 | 114 | 1.5 | 408 |
| 100 MB .txt | Electron | 491 | 640 | 4,047 | 20.8 / 35.4 / 48.3 | 138 | 130 | 479 | n/a | 264 |
| 100 MB .txt | Markie RS | 339 | 341 | 1,556 | 1.3 / 1.6 / 3.3 | 0.7 | 0.7 | 87.0 | 1.2 | 261 |

The peak RSS of 1 MB .md in Markie RS is the median of two runs: on its first run the sampler read 0 twice, once in the full run and once when that sample was run again (`ps` failing under a load of 340 to 570).

### What changed

Profiled at 100 MB with samply on the scene bench. Before, opening spent about 1.05 s counting words and the outline and about 1 s on the editor's first frame; saving spent most of its time in SHA-256 and in copies of the text, all on the main thread.

| Change | Where | Effect at 100 MB |
|---|---|---|
| Word counts and the outline of a document in the large tier (1 MB and up) are counted on a background thread and land a moment after the text shows. Smaller documents count as before | `workspace.rs` `update_stats` | About 1 s off the open, and off every pause in typing |
| Without soft wrap, gpui-base finds the editor's rows in one pass over the rope's chunks instead of one rope seek per line (1.6 million lines) | `rust/vendor/gpui-base`, patched copy of 0.10.0 (`rust/vendor/README.md`) | About 1 s off the first frame |
| A large document in Source saves on its own thread. The main thread checks for an outside edit and clones the rope; the thread copies the text once, keeps the History version, writes and hashes, the last three side by side | `workspace/save_job.rs`, `markie_core::document::write_text_document` and `TextWrite` | ⌘S holds the main thread for 1 to 3 ms |
| SHA-256 uses the ARMv8 instructions (sha2 0.11 instead of 0.10, which ran in software here at about 160 MB/s) | `markie-core/Cargo.toml` | History's two hashes of a save, under the same load: about 1.4 s to about 0.25 s |
| History skips reading its newest version when its length differs from the file's | `markie-core/src/history.rs` | A 100 MB read and hash saved on most saves |
| Opening remembers the file's size and modified time from before the read, so the first save does not read the file back to check for an outside edit | `markie-core/src/disk.rs` `remember_read` | A 100 MB read and hash off the first save |
| UTF-8 decoding keeps the read buffer, and one byte pass checks control characters and line endings; a UTF-8 save without BOM writes the text's own bytes | `markie-core/src/formats.rs`, `document.rs` | Two copies and two char-by-char passes fewer |

What keeps a save exact:

- One save runs at a time. A save asked for while one runs writes the newest text after it.
- Typing during a save keeps the edited marker, since the save wrote the text as it was when it started.
- Quitting, closing the window, opening another document, a reload and every save on the main thread wait for a running save to finish (`wait_for_save`).
- The disk poll skips while a save runs, so Markie's own write is never taken for an outside edit.
- History reads the old bytes before the new file replaces them, and dates the version from the old file's modified time.
- After one 100 MB bench save the file held exactly the expected bytes, the History version was byte for byte the original, and the last-write hash matched the file.

Tests: `markie-core` covers exact bytes in UTF-8, UTF-8 with BOM and UTF-16, the version kept and not duplicated, a large text, autosave drafts kept on failure and cleared on success, and a running save waited for (`finishing_a_running_save_waits_for_the_bytes`). The gpui-base patch is checked row for row against the old loop (`unwrapped_rows_match_the_per_row_loop`), and gpui-base's 445 input tests pass with it.

### What else was running

The Mac was never quiet. Load averages were 140 to 570 on 18 cores during the runs: other agents' Rust builds and tests, iOS simulators, Spotlight, and this branch's own `cargo test --workspace` for the first round. Kirby's own Markie was open and was not touched. Both apps ran under the same load, taking turns run by run, so the comparison holds better than the absolute numbers.

### How it was measured

Nothing was shown on screen and no input reached Kirby's display. The frontmost app was checked before and after every run.

- **Markie RS**: a release build with `--features scene`, the `doc` scene with `bench: true` (`scene.rs` `doc_bench`). The window is hidden, so GPU presentation is not in any figure.
- **Electron**: `rust/scripts/bench/electron-large/main.cjs` runs Electron 42.11.18 with the checkout's real preload, its renderer built by Vite, and main's own read and save modules (`doc-tiers`, `disk-memory`, `history`, `atomic-write`). The window is offscreen and the app is an accessory, so it never shows or activates. Input goes through `webContents.sendInputEvent`. Every other IPC channel answers null; the registry row a large open writes is skipped, which flatters Electron slightly.
- **First paint**: Markie RS, `open_path` to the end of the first frame showing the document, at launch (`MARKIE_RS_PERF`). Electron, main receiving `get-initial-file` (it reads the file then) to the frame after the first line of text appears. Both include reading the file.
- **Editable**: until a keystroke typed at once lands on screen. Markie RS opens synchronously, so it is first paint plus the first keystroke's frame.
- **Peak RSS**: sampled every 100 ms over each app's whole process tree for the whole run (open, typing, scrolling, save). Electron's four processes are summed.
- **Scroll**: 600 frames that sweep the document from top to bottom. Each frame's main-thread cost: Markie RS, setting the offset to the end of the frame's paint; Electron, setting `scrollTop`, CodeMirror's scroll handler and forced style and layout (paint not included, which flatters Electron).
- **Typing**: 30 keys at the start, then 30 at the end of the document. Markie RS, keystroke to the end of the frame's paint. Electron, from Chromium's own trace: the renderer main thread's busy time from the keydown to the end of the frame's commit, with idle time left out. Waiting for the next frame is in neither.
- **Save**: Markie RS, its ⌘S function until the save has landed: written, recorded as saved, and the frame after drawn. A large document saves on its own thread, so the main thread's share is reported apart (`save_main_ms`). An autosave still running from the typing finishes, untimed, before ⌘S. Electron, the menu's save sent to the page until main's write finished: the page's save, IPC, the snapshot, the atomic write.

Run it again:

```sh
S=<scratch>
python3 rust/scripts/bench/gen-large.py $S/fx
mkdir -p $S/esrc && git -C <electron checkout> archive HEAD | tar -x -C $S/esrc && ln -s <electron checkout>/node_modules $S/esrc/node_modules
cat > $S/esrc/vite.bench.config.ts <<'TS'
import base from "./vite.config";
export default { ...base, cacheDir: process.env.BENCH_VITE_CACHE, build: { ...base.build, outDir: process.env.BENCH_OUT } };
TS
(cd $S/esrc && BENCH_VITE_CACHE=$S/vite-cache BENCH_OUT=$S/electron-out npx vite build --config vite.bench.config.ts)
# Electron 42.11.18 for darwin-arm64 from its GitHub release, checked against node_modules/electron/checksums.json, unzipped to $S/electron
(cd rust && cargo build --release -p markie-app --features scene)
python3 rust/scripts/bench/large-docs.py run $S --runs 3    # about 60 minutes under load; resumes if stopped
python3 rust/scripts/bench/large-docs.py summary $S
```

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

## The CSV table: 100,000 rows

Date: 2026-11-24, branch `t3/markie-rs-csv-table`. The file is the one Electron's own test builds: `id,name,amount,note` and 100,000 rows like `7,Name 7,10.50,"note, 7"`, 4.0 MB. The Mac was busy while this ran (1-minute load 70 to 100), so the numbers are on the slow side for both apps.

| | Electron (PR #149, headless Chromium) | Markie RS |
|---|---|---|
| Open to the first cells | 114 ms (43 ms of it the parse) | 47 ms, 47 to 63 over 7 opens (3.5 ms of it the parse) |
| Sort a column | 65 to 77 ms | 11 ms by number, 17 ms by text |
| Filter | 17 ms | 9 ms |
| Scroll | 60 fps | 1.5 ms a frame on average, 2.2 ms the slowest of 600; none over 16.7 ms |

What the Markie RS numbers are: main-thread time from the action to the end of the frame it causes, in a release build. Open is `open_path` to the first frame with cells: the file read and decoded, the table parsed, the columns measured, the window rendered, laid out and painted. Sort and filter are the model's work plus that frame. Scroll is 600 frames 240 points apart through the whole file. The window is hidden (scene mode), so presenting the frame on the GPU is not included, and the scroll figure is frame cost, not a measured frame rate on a display.

The model alone, best of 9 (`times_100_000_rows`): parse 3.5 ms, serialize 0.6 ms, sort by number 6.4 ms, sort by text 11.6 ms, filter 5.4 ms.

### The CSV sheet

Date: 2026-11-24, branch `t3/markie-rs-csv-sheet`: the table redrawn as a spreadsheet (AUDIT-EDITORS.md section 7b). The same file and the same run, on the binary before the change and the one after, turn about, twice each. The Mac was busier still (1-minute load 110 to 120), so read the two columns against each other, not against the table above.

| | Before (the table) | After (the sheet) |
|---|---|---|
| Open to the first cells | 42 to 47 ms | 46 to 50 ms |
| Sort a column | 10 to 11 ms by number, 16 ms by text | 12 to 13 ms by number, 18 to 19 ms by text |
| Filter | 8 to 9 ms | 11 ms |
| Scroll, a frame on average | 1.4 to 1.6 ms, 2.2 ms the slowest of 600 | 2.2 to 2.3 ms, 3.1 ms the slowest of 600; none over 16.7 ms |

Every figure is 1 to 3 ms higher, and all of it is the frame, not the model: the model's own times (`times_100_000_rows`) did not move (parse 3.2 ms, serialize 0.6 ms, sort 5.9 ms by number and 10.5 ms by text, filter 4.7 ms). A frame costs about 0.7 ms more because there is more in it. Rows are 24 points tall where they were 30, so a quarter more of them are on screen; each visible cell is read for how it is drawn (number, date, link); the cells that line up on the right are shaped with tabular figures; the empty sheet's lines, the name box, the formula bar and the sheet tab are drawn. Sort, filter and open each end in one such frame. Electron's sheet (PR #154, headless Chromium, 100,000 rows by 8 columns) holds 60 fps as its table did, 17.0 ms a frame against 16.7.

Run it again:

```sh
(cd rust && cargo build --release -p markie-app --features scene)
rust/scripts/screen/scene.sh csv out.png light '{"bench":true,"timeout":120}' rows-100k.csv   # markie-csv-bench lines in the scene log; keep SCENE_HOME to read it
(cd rust && cargo test --release -p markie-core csv_table::tests::times -- --ignored --nocapture)
```

## The Recent page: 200 documents with live previews

Date: 2026-11-26, branch `t3/doc-card-previews`. Each Markdown card draws its document with the reader itself (`doc_mini.rs`) and scrolls through its first two pages. 200 made-up documents (`many-fixture.py`: 70% Markdown from a few lines to several pages, the rest text, CSV, JSON and PDF), window 1440 by 1000, two runs.

| | Markie RS |
|---|---|
| Open, first frame (every thumbnail and live view dropped first) | 4.6 to 4.9 ms |
| Open, until every card on screen has its preview | 94 to 97 ms over 4 frames; the slowest frame 17 ms |
| Scroll the page: one trackpad gesture across the cards, 600 events 40 points apart | 8.3 to 8.5 ms a frame on average, 13.8 to 14.3 ms at p95, 20 ms the slowest; 7 to 9 of 600 over 16.7 ms |
| Scroll one card's preview, to its end and back | 6.1 ms a frame on average, 8.1 to 8.3 ms at p95; none over 16.7 ms |
| Live views held | 48, the cap |
| Memory (RSS) at the end | 232 to 236 MB |

The scrolls are real wheel events dispatched to the window, so they go through the grid's router and the page's own scroll as a person's would. The bench checks the latch too: the page gesture moved the page 9,121 points and no preview; the preview gesture moved its card to the end (417 points) and the rest of the gesture moved the page (756 points).

What keeps it there: a card more than a screen from view draws only its outline; a card a screen away has its live view made and loaded, but only a card on screen draws it; a live view draws only the blocks in the card's window and moves itself, so it never lays out two pages to show 150 points; at most 6 new views are made a frame; the pool holds 48 and drops the least recently drawn. The first try, which drew every card in full and two pages per live view, cost 50 to 60 ms a frame.

Run it again:

```sh
python3 rust/scripts/screen/scene/many-fixture.py $S 200
SCENE_HOME=$S/home MARKIE_RS_SCENE_SIZE=1440x1000 rust/scripts/screen/scene.sh recent out.png light \
  "$(python3 -c "import json;d=json.load(open('$S/many.json'));print(json.dumps({'recents':d['recents'],'bench':True}))")"
grep markie-recent-bench $S/home/scene-recent.log
```
