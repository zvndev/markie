// The two pieces of perf-baseline that decide what a capture says, rather than
// what it measures.
//
// Both have already been wrong once. Process selection matched any command line
// containing the bundle path, which counted this script's own node and shell as
// a 110 MB "main" process and inflated an idle total from 526 MB to 640 MB. The
// aggregation dropped timeouts, so a first response of [never, 9001, never]
// reported a median of 9,001 ms, which reads as "it answers in nine seconds"
// when two runs in three never answered at all. Neither is visible in a passing
// run; both quietly change the number the sprint is steering by.
import { describe, expect, it } from "vitest";
import { censoredText, selectRunProcesses, summarize } from "./perf-baseline.mjs";

const BUNDLE = "/Users/dev/repo/dist/mac-arm64/Markie.app";
const PROFILE = "/private/var/folders/xx/T/markie-perf-profile-AAAAAA";
const OTHER_PROFILE = "/private/var/folders/xx/T/markie-perf-profile-BBBBBB";

// pid ppid rss command, the shape of `ps -Awwo pid=,ppid=,rss=,command=`.
const psLine = (pid: number, ppid: number, rssKb: number, command: string) =>
  ` ${pid}  ${ppid}  ${rssKb}  ${command}`;

const helper = (type: string, profile: string) =>
  `${BUNDLE}/Contents/Frameworks/Markie Helper.app/Contents/MacOS/Markie Helper --type=${type} --user-data-dir=${profile}`;

const PS = [
  psLine(100, 1, 181000, `${BUNDLE}/Contents/MacOS/Markie --remote-debugging-port=1 --user-data-dir=${PROFILE}`),
  psLine(101, 100, 90000, helper("gpu-process", PROFILE)),
  psLine(
    102,
    100,
    56000,
    `${helper("utility", PROFILE)} --utility-sub-type=network.mojom.NetworkService`
  ),
  psLine(
    103,
    100,
    200000,
    `${BUNDLE}/Contents/Frameworks/Markie Helper (Renderer).app/Contents/MacOS/Markie Helper (Renderer) --type=renderer --user-data-dir=${PROFILE}`
  ),
  // Crashpad reparents to launchd and names the profile only in --database.
  psLine(
    104,
    1,
    9800,
    `${BUNDLE}/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler --database=${PROFILE}/Crashpad`
  ),
  // A helper of ours carrying no profile argument at all.
  psLine(105, 100, 12000, `${BUNDLE}/Contents/Frameworks/Markie Helper.app/Contents/MacOS/Markie Helper --type=utility`),
  // A lingering instance of the same dist build under another profile.
  psLine(200, 1, 179000, `${BUNDLE}/Contents/MacOS/Markie --remote-debugging-port=2 --user-data-dir=${OTHER_PROFILE}`),
  psLine(201, 200, 198000, helper("gpu-process", OTHER_PROFILE)),
  // The Markie a developer has open with their own documents.
  psLine(300, 1, 235000, "/Applications/Markie.app/Contents/MacOS/Markie"),
  // This script's own node and shell: their argv carries the bundle path.
  psLine(400, 1, 110000, `node scripts/perf-baseline.mjs --app ${BUNDLE} --runs 3`),
  psLine(401, 1, 3200, `/bin/zsh -c node scripts/perf-baseline.mjs --app ${BUNDLE}`),
].join("\n");

const select = () =>
  selectRunProcesses(PS, { bundlePath: BUNDLE, userDataDir: PROFILE, rootPid: 100 });

describe("which processes belong to one run of one bundle", () => {
  it("keeps every process of this run", () => {
    expect(select().processes.map((p) => p.pid).sort((a: number, b: number) => a - b)).toEqual([
      100, 101, 102, 103, 104, 105,
    ]);
  });

  it("drops a lingering instance of the same dist build under another profile", () => {
    const pids = select().processes.map((p) => p.pid);
    expect(pids).not.toContain(200);
    expect(pids).not.toContain(201);
  });

  it("drops the Markie installed in /Applications", () => {
    expect(select().processes.map((p) => p.pid)).not.toContain(300);
  });

  it("drops this script's own node and shell, whose argv names the bundle", () => {
    const pids = select().processes.map((p) => p.pid);
    expect(pids).not.toContain(400);
    expect(pids).not.toContain(401);
  });

  it("matches crashpad through the profile in its --database path", () => {
    const crashpad = select().processes.find((p) => p.pid === 104);
    expect(crashpad).toMatchObject({ role: "crashpad", matchedBy: "user-data-dir" });
  });

  it("falls back to descent for a helper that carries no profile argument", () => {
    expect(select().processes.find((p) => p.pid === 105)).toMatchObject({
      matchedBy: "descendant",
    });
  });

  it("totals only the rows it kept", () => {
    const table = select();
    expect(table.byRole).toEqual({
      main: 176.8,
      gpu: 87.9,
      utility: 66.4,
      renderer: 195.3,
      crashpad: 9.6,
    });
    expect(table.totalMb).toBe(536);
    expect(table.count).toBe(6);
  });
});

type FakeRun = Record<string, unknown>;

// Only the fields the aggregation reads.
const run = ({
  firstResponse,
  switchMs,
  switchSkipped = false,
}: {
  firstResponse: number | null;
  switchMs: number | null;
  switchSkipped?: boolean;
}): FakeRun => ({
  errors: [],
  largeDoc: {
    responsiveSeconds: firstResponse === null ? 0 : 1,
    firstResponsiveAfterOpenMs: firstResponse,
    longestUnresponsiveStretchSeconds: 20,
    toolbarNamedMs: 63000,
    editorReadyMs: 63000,
    stateSeenMs: 63000,
    settledMs: switchSkipped ? null : 64000,
    landed: !switchSkipped,
  },
  switchBack: switchSkipped
    ? { ms: null, timedOut: true, skipped: true }
    : { ms: switchMs, timedOut: switchMs === null, clickExecutedMs: switchMs },
});

describe("aggregating a metric that can time out", () => {
  it("reports the plain median when every run completed", () => {
    const summary = summarize([
      run({ firstResponse: 8000, switchMs: 400 }),
      run({ firstResponse: 10000, switchMs: 500 }),
      run({ firstResponse: 12000, switchMs: 600 }),
    ]);
    expect(summary.medians.largeDocFirstResponseMs).toBe(10000);
    expect(summary.censored.largeDocFirstResponseMs).toMatchObject({
      completedRuns: 3,
      timedOutRuns: 0,
      skippedRuns: 0,
      medianAtOrAboveCap: false,
    });
    expect(censoredText(summary, "largeDocFirstResponseMs")).toBe("3/3 runs, 10.0s");
  });

  it("censors a timeout at the cap instead of dropping it", () => {
    // The bug this exists for: dropping the two nulls reported 9,001 ms.
    const summary = summarize([
      run({ firstResponse: null, switchMs: 400 }),
      run({ firstResponse: 9001, switchMs: 400 }),
      run({ firstResponse: null, switchMs: 400 }),
    ]);
    expect(summary.medians.largeDocFirstResponseMs).toBe(20000);
    expect(summary.censored.largeDocFirstResponseMs).toMatchObject({
      capMs: 20000,
      attemptedRuns: 3,
      completedRuns: 1,
      timedOutRuns: 2,
      medianAtOrAboveCap: true,
      medianOfCompletedMs: 9001,
    });
    expect(censoredText(summary, "largeDocFirstResponseMs")).toBe("1/3 runs, 9.0s when it did");
  });

  it("says so plainly when no run completed", () => {
    const summary = summarize([
      run({ firstResponse: null, switchMs: null }),
      run({ firstResponse: null, switchMs: null }),
    ]);
    expect(summary.medians.switchBackMs).toBe(30000);
    expect(summary.censored.switchBackMs).toMatchObject({ completedRuns: 0, timedOutRuns: 2 });
    expect(censoredText(summary, "switchBackMs")).toBe("0/2 runs (>30s)");
  });

  it("keeps the minimum censored too, so it cannot flatter a run that never finished", () => {
    const summary = summarize([
      run({ firstResponse: null, switchMs: null }),
      run({ firstResponse: null, switchMs: null }),
    ]);
    expect(summary.minimums.switchBackMs).toBe(30000);
  });
});

describe("a measurement the run deliberately skipped", () => {
  it("is not counted as a timeout at the cap", () => {
    // A skipped switch means the 4.4 MB document never landed, so a switch back
    // could not be told from no switch at all. Substituting 30,000 ms there
    // invents a slow result out of an absent one.
    const summary = summarize([
      run({ firstResponse: null, switchMs: null, switchSkipped: true }),
      run({ firstResponse: null, switchMs: 500 }),
    ]);
    expect(summary.medians.switchBackMs).toBe(500);
    expect(summary.censored.switchBackMs).toMatchObject({
      attemptedRuns: 1,
      completedRuns: 1,
      timedOutRuns: 0,
      skippedRuns: 1,
    });
  });

  it("is reported beside the ratio rather than folded into it", () => {
    const summary = summarize([
      run({ firstResponse: null, switchMs: null, switchSkipped: true }),
      run({ firstResponse: null, switchMs: 500 }),
    ]);
    expect(censoredText(summary, "switchBackMs")).toBe("1/1 runs, 0.5s, 1 skipped");
  });

  it("still censors the landing itself, which was attempted and timed out", () => {
    // A skipped switch follows a document that never settled. That landing was
    // attempted, so it is a timeout at its own cap rather than a skip.
    const summary = summarize([
      run({ firstResponse: null, switchMs: null, switchSkipped: true }),
      run({ firstResponse: null, switchMs: 500 }),
    ]);
    expect(summary.censored.largeDocLandedMs).toMatchObject({
      attemptedRuns: 2,
      completedRuns: 1,
      timedOutRuns: 1,
      skippedRuns: 0,
    });
  });

  it("leaves the metric unmeasured when every run skipped it", () => {
    const summary = summarize([
      run({ firstResponse: null, switchMs: null, switchSkipped: true }),
      run({ firstResponse: null, switchMs: null, switchSkipped: true }),
    ]);
    expect(summary.medians.switchBackMs).toBeNull();
    expect(summary.censored.switchBackMs).toMatchObject({
      attemptedRuns: 0,
      completedRuns: 0,
      timedOutRuns: 0,
      skippedRuns: 2,
    });
    expect(censoredText(summary, "switchBackMs")).toBe("not attempted (2 skipped)");
  });
});
