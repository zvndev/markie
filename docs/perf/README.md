# Performance baselines

`scripts/perf-baseline.mjs` measures a packaged Markie build: how long it takes
to come up, how much memory it holds, and what a large document does to it. The
numbers in this folder are the "before" that the 0.6 performance work is
measured against.

## Running it

```
MARKIE_ALLOW_E2E=1 node scripts/perf-baseline.mjs \
  --app dist/mac-arm64/Markie.app \
  --runs 3 \
  --out docs/perf/$(date +%F)-baseline.json
```

`MARKIE_ALLOW_E2E=1` is the consent gate every script that opens a real window
goes through (see `scripts/lib/e2e-consent.mjs`). The run launches the packaged
build with a throwaway `$HOME` and a throwaway `--user-data-dir`, and with
`MARKIE_E2E=1` set for the app, which is what keeps it from taking or being
handed the single instance lock of a Markie you already have open. Each run gets
a fresh profile, so every run is a cold launch.

`--inspect` is passed as well, so the main process's own `process.memoryUsage()`
can be read over its inspector port. Pass `--no-inspect-main` to skip that; the
capture in this folder was taken with it on, so compare like with like.

### Exit code

A slow number exits 0. Bad numbers are the point of a baseline. A run that could
not be measured (the renderer never reachable, a selector drifted, the app died)
exits non-zero, and the artifact is still written with whatever that run managed
to record plus its error, and with `"ok": false` at the top. A capture with a
hole in it must not pass for a capture, so check the exit code, not just the
file.

### Fixtures

Both are generated per run into the throwaway home: a 200 KB document of about
1,500 top level blocks and a 4.4 MB document of about 33,700, both shaped like
real writing (headings, prose with inline marks, lists, fenced code, tables).

## What each number means

### launch

* `spawnToLoadEventFiredMs`: wall clock from `spawn()` of the app binary to the
  CDP `Page.loadEventFired` event. This is the headline launch number.
* `spawnToLoadEventEndMs`: the same interval computed from the renderer's own
  `performance.timeOrigin + navigation.loadEventEnd`. It does not depend on the
  CDP connection being open early enough to catch the event, so it is the one to
  trust if the two ever disagree.
* `domContentLoadedEventEndMs`, `loadEventEndMs`: from
  `performance.getEntriesByType("navigation")[0]`, relative to the renderer's
  own time origin rather than to spawn. The gap between `loadEventEndMs` (about
  180 ms) and the spawn to load number is process startup and Electron boot, not
  page work.
* `firstPaintMs`, `firstContentfulPaintMs`, `paintEntries`: from the paint
  timeline. `first-contentful-paint` is absent on these runs. `MARKIE_E2E=1`
  keeps the window unshown, so the compositor never presents a frame with
  content in it and the entry is never recorded. `first-paint` is recorded.

### rssIdle and rssDoc

`ps -Awwo pid=,ppid=,rss=,command=`, filtered three ways. The command must start
with the bundle path that was launched, which keeps out an installed Markie and
keeps out this script's own shell and node (their command lines carry the bundle
path as an argument). Then the row must belong to *this* run: either its command
line carries this run's throwaway profile directory, which Chromium propagates
to every helper and which crashpad carries as its `--database` path, or the
process descends from the one we spawned. Without that second filter a
concurrent smoke run of the same `dist/` build would be added to these totals.
Each row records which rule matched it in `matchedBy`.

Rows are labelled `main`, `renderer`, `gpu`, `utility` (with the Chromium sub
type in `detail`) and `crashpad`, and reported per process, per role, and as a
total. `rssIdle` is taken 5 seconds after load with no document open; `rssDoc`
5 seconds after the 200 KB document has landed.

Read RSS as a comparison number between builds, not as "how much memory Markie
uses". Most of each Electron process's resident set is the same shared, read
only, file backed framework code, counted once per process. On this build the
main process reports about 178 MB of RSS and about 57 MB of macOS physical
footprint.

### mainMemory

The main process's own `process.memoryUsage()`, read by connecting to the Node
inspector that `--inspect` puts on it and evaluating there. Recorded at the two
points the RSS tables are taken, as `idle` and `withSmallDoc`, in MB plus the
raw `bytes`. This is the number that says how much of the main process is
actually Markie: `heapUsed` is about 8 MB idle against 178 MB of RSS.

Note that the inspector's default evaluation context is Electron's bootstrap
context, where `require` is undefined. `process` is defined, which is all this
needs; `process.mainModule.require(...)` is the way in if more is ever wanted.

### smallDoc

* `toolbarNamedMs`: how long after the click before the toolbar shows the
  document's name. The clock starts at the click, not at the moment the click's
  CDP reply came back, so any delay the renderer took to dispatch it is inside
  the number. The name lands as soon as the document state is set, well before
  anything is on screen.
* `editorReadyMs`: how long before the rich editor actually holds the document
  (`__markieEditor.state.doc.content.size` past 100,000). This is the honest
  "the document arrived" number.

Both are polled every 100 ms, so read them at that granularity: 4 ms and 105 ms
are one poll and three polls, not a real 26x difference.

### largeDoc

The 4.4 MB document is opened from the Library the same way a person opens it.
From the moment of the click, `Runtime.evaluate` of `1+1` is sent once a second
for 20 seconds with a 200 ms deadline, and each sample records whether the
renderer answered in time.

* `responsiveSeconds` / `unresponsiveSeconds`: how many of the 20 answered.
* `firstResponsiveAfterOpenMs`: how long after the open before the first sample
  came back. `null` means none of the 20 did, which the summary censors at the
  20 second cap rather than dropping (see below).
* `longestUnresponsiveStretchSeconds`: the longest run of consecutive samples
  that did not answer.
* `toolbarNamedMs` and `editorReadyMs`: how long from the click until the
  document actually lands, capped at `landCapMs` (120 s). `landed` is false,
  with an explicit `note`, if it never did.

  The watcher for these starts at the click and runs alongside the sampling
  loop, not after it. That matters for the build this baseline exists to
  compare against: if 0.6 lands the 4.4 MB fixture in three seconds, an observer
  that could not look until the twenty second window closed would report it as
  twenty, and the whole improvement would vanish into the sampling window. It is
  polled every 150 ms, one request per poll for both signals.

* `stateSeenMs` and `settledMs`: landing is two events, and the first one alone
  lies. Both probe signals above are state, not paint:
  `__markieEditor.state.doc.content.size` becomes millions as soon as the
  ProseMirror document is built, which is long before the DOM for 33,700 blocks
  exists. On 0.5.4 the renderer reports the new document and then wedges for
  another minute building that DOM. A capture that called that first moment
  "landed" recorded 1.7 s for a document the app could not then accept a click
  about for another thirty seconds.

  So `stateSeenMs` is the first moment the renderer reported the new document,
  and `settledMs` is the first moment after that when it answered three quick
  probes in a row, which is when a person would say the document is open.
  `landed`, and the gate on the switch back, are `settledMs`.

  The gap between the two is the most useful thing in this capture. On 0.5.4 the
  4.4 MB document is parsed and in the editor's state after about 1.6 seconds,
  and the app is not usable again for about another minute. Whatever costs that
  minute, it is not the markdown parser.

  This matters when comparing captures: on a contended machine the renderer is
  descheduled more, which gives probes more windows to slip through, so a loaded
  run reports a *smaller* `stateSeenMs` than a quiet one. `settledMs` does not
  move that way. Compare captures with similar `host.loadAverage` regardless.

### switchBack

Once the 4.4 MB document has landed, the 200 KB document is requested again from
the Library and the script times the switch.

The landing gate matters. Until React commits the large document the toolbar is
still naming the small one from the previous step, so a toolbar reading taken
after a click would "prove" a switch that never happened. For the same reason
the end marker is not the toolbar text: it is the editor falling back into the
small document's size band (at least 100,000 and under 1,000,000, against the
4.4 MB document's 4.3 million), which only a completed new load produces.
`toolbarNamedMs` is kept alongside for comparison, and `clickExecutedMs` is how
long the app took merely to accept the click.

If the large document never landed, the switch is not attempted and is recorded
as `skipped` with a note, because in that state a fast switch and no switch at
all look identical. A skipped switch is left out of the aggregation entirely
rather than censored at the cap, and counted in `skippedRuns`: substituting 30
seconds there would invent a slow result out of an absent one.

So `switchBack.ms` answers "once the big document is finally open, how long to
get back to the small one", and the cost of the freeze itself lives in
`largeDoc.toolbarNamedMs` and the responsiveness samples. On 0.5.4 those are
about 65 seconds and 0 of 20 respectively, while the switch back is under half a
second.

## Medians, minimums and censoring

Both a median and a minimum are reported for every metric because this capture
was not made on a quiet machine. Another engineer was running tests on the same
laptop during it, so some samples carry contention that has nothing to do with
Markie. The median is the number to quote; the minimum is the closest thing here
to an uncontended reading, and a large gap between the two means the run was
noisy rather than that the build changed.

Metrics that can time out are **censored at their cap** rather than having the
timeout dropped. Dropping it leaves the slowest runs out of the summary
entirely: a first response of `[never, 9001, never]` would otherwise report a
median of 9,001 ms, which reads as "it answers in nine seconds" when two runs in
three never answered at all. Instead a timeout counts as its cap, so the median
is at least as bad as the truth, and `summary.censored` carries the completion
ratio, the cap, whether the median sits at the cap, the median of only the runs
that did complete, and how many runs skipped the measurement outright. The one
line summary says the same thing as `first response 1/3 runs, 10.0s when it
did`, and appends `, 1 skipped` when a run declined to measure.

A skipped run is not a timeout and is never substituted with the cap. If every
run skipped a metric, its median is `null` and the summary reads
`not attempted (N skipped)`.

## Tests

`scripts/perf-baseline.test.ts` covers the two parts that decide what a capture
says rather than what it measures: which processes belong to one run of one
bundle, and how a metric that can time out or be skipped is aggregated. Both
have been wrong once already. Run them with
`npx vitest run scripts/perf-baseline.test.ts`.

## Cold versus warm launch

Only a launch that reads the app bundle from disk is a cold launch. Once the
bundle is in the OS page cache the app comes up in roughly a third of the time,
and the cache stays warm for a long while.

**The capture in `2026-09-07-baseline.json` contains no cold launch.** Earlier
runs of the same bundle preceded it, so all three found it in the page cache and
report 559 ms, 767 ms and 636 ms. Cold launches of this same build on this
machine measured 1,803 ms, 1,894 ms, 2,067 ms and 2,196 ms. To capture a cold
one, do not launch that bundle for a while before the run, and treat run 1 alone
as the cold number. Purging the page cache needs `sudo purge` and is
deliberately not done here.

## Captures

* `2026-09-07-baseline.json`: Markie 0.5.4, packaged `dist/mac-arm64`, macOS 26.5
  on an 18 core Apple M5 Max, 3 runs, `--inspect-main` on, `host.loadAverage`
  around 7.9.
  `launch 636ms · rss idle 525MB · rss doc 753MB · 4.4MB: responsive 0/20s, first response 1/3 runs, 11.0s when it did · landed 3/3 runs, 63.3s · switch 3/3 runs, 0.4s`

  The 4.4 MB document is in the editor's state at about 1.6 s
  (`largeDocStateSeenMs`) and the app is usable again at about 63 s
  (`largeDocLandedMs`), answering none to one of the 20 liveness samples in
  between.
