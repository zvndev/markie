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
a fresh profile, so every run is a cold launch. Nothing is asserted: the script
exits non-zero only when the measurement itself failed, never because a number
is bad.

Optional: `--inspect-main` adds `--inspect` so the main process can be attached
to with a Node inspector client at the same time.

The two fixtures are generated per run into the throwaway home: a 200 KB
document of about 1,500 top level blocks and a 4.4 MB document of about 33,700,
both shaped like real writing (headings, prose with inline marks, lists, fenced
code, tables).

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
  170 ms) and the spawn to load number (about 560 ms warm, about 1,800 ms cold)
  is process startup and Electron boot, not page work.
* `firstPaintMs`, `firstContentfulPaintMs`, `paintEntries`: from the paint
  timeline. `first-contentful-paint` is absent on these runs. `MARKIE_E2E=1`
  keeps the window unshown, so the compositor never presents a frame with
  content in it and the entry is never recorded. `first-paint` is recorded.

### rssIdle and rssDoc

`ps -Awwo pid=,rss=,command=`, keeping only rows whose command starts with the
bundle path that was launched, so an installed Markie belonging to whoever is
running this is never counted. Rows are labelled `main`, `renderer`, `gpu`,
`utility` (with the Chromium sub type in `detail`) and `crashpad`, and reported
per process, per role, and as a total.

`rssIdle` is taken 5 seconds after load with no document open. `rssDoc` is taken
5 seconds after the 200 KB document has landed.

Read RSS as a comparison number between builds, not as "how much memory Markie
uses". Most of each Electron process's resident set is the same shared, read
only, file backed framework code, counted once per process. On this build the
main process reports about 177 MB of RSS and about 57 MB of macOS physical
footprint.

### smallDoc

* `toolbarNamedMs`: how long after the click before the toolbar shows the
  document's name. This lands as soon as the document state is set, anywhere from
  1 ms to about 300 ms here, and well before anything is on screen.
* `editorReadyMs`: how long before the rich editor actually holds the document
  (`__markieEditor.state.doc.content.size` past 100,000). This is the honest
  "the document arrived" number.

### largeDoc

The 4.4 MB document is opened from the Library the same way a person opens it.
From the moment of the click, `Runtime.evaluate` of `1+1` is sent once a second
for 20 seconds with a 200 ms deadline, and each sample records whether the
renderer answered in time.

* `responsiveSeconds` / `unresponsiveSeconds`: how many of the 20 answered.
* `firstResponsiveAfterOpenMs`: how long after the open before the first sample
  came back. `null` means none of the 20 did.
* `longestUnresponsiveStretchSeconds`: the longest run of consecutive samples
  that did not answer.
* `toolbarNamedWithinSamplingWindow`: whether the document had landed by the end
  of the 20 seconds.

### switchBack

Immediately after the sampling window, still while the 4.4 MB document is
landing, the 200 KB document is requested again from the Library, and the script
times how long until the toolbar names it, capped at 30 seconds.

Note that the toolbar is still naming the 200 KB document at this point, because
React has not committed the large one yet. So a name alone proves nothing, and
the measurement also requires the click itself to have run in the page.
`clickExecutedMs` is how long the app took merely to accept the click, and
`clickExecutionTimedOut` says it never did. On the 0.5.4 build the app never
accepts the click inside the cap, and `ms` is `null` with `timedOut: true`.
"Timed out" is a result, not a failure: the script tears the app down and still
writes its numbers.

## Medians and minimums

Both are reported for every metric because this capture was not made on a quiet
machine. Another engineer was running tests on the same laptop during it, so
some samples carry contention that has nothing to do with Markie. The median is
the number to quote; the minimum is the closest thing here to an uncontended
reading, and a large gap between the two means the run was noisy rather than
that the build changed.

One more caveat on launch specifically: the first run of a session is the only
one that reads the app bundle from disk. Runs 2 and 3 find it in the OS page
cache and come up in roughly a third of the time. In `2026-09-07-baseline.json`
run 1 is 1,803 ms and runs 2 and 3 are 571 ms and 552 ms, and the median of 571
ms therefore describes a warm launch, not a cold one. Compare like for like:
first run against first run.

## Captures

* `2026-09-07-baseline.json`: Markie 0.5.4, packaged `dist/mac-arm64`, macOS 26.5
  on Apple silicon, 3 runs.
  `launch 571ms · rss idle 526MB · rss doc 753MB · 4.4MB: responsive 0/20s, first response 9.0s · switch timed out (>30s)`
