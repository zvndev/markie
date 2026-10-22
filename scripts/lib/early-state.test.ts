import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOAK_DAYS,
  markPromoted,
  markSuperseded,
  markWithdrawn,
  planPromoteDue,
  promotionBlocker,
  recordEarlyPublish,
  resolveSoakDays,
  setHold,
} from "./early-state.mjs";

const T0 = "2026-10-20T12:00:00.000Z";
const at = (iso: string, days: number) => new Date(Date.parse(iso) + days * 86_400_000);

function published(version = "0.9.0", { platform = "mac", publishedAt = T0, soakDays = 3 } = {}) {
  return recordEarlyPublish(null, {
    version,
    commit: "abc123",
    platform,
    publishedAt,
    soakDays,
    platformRecord: { files: [] },
  });
}

describe("soak length", () => {
  it("defaults to three days", () => {
    expect(DEFAULT_SOAK_DAYS).toBe(3);
    expect(resolveSoakDays(undefined, undefined)).toBe(3);
  });

  it("takes the manifest default, and a flag over that", () => {
    expect(resolveSoakDays(undefined, 5)).toBe(5);
    expect(resolveSoakDays("0.5", 5)).toBe(0.5);
    expect(resolveSoakDays("0", 5)).toBe(0);
  });

  it("refuses anything that is not a plain number of days", () => {
    // An empty or garbled flag must not quietly become "promote immediately".
    for (const bad of ["", "abc", "-1", "61", "3d"]) {
      expect(() => resolveSoakDays(bad, 3)).toThrow(/soak must be/);
    }
  });
});

describe("recordEarlyPublish", () => {
  it("starts the clock at publish time", () => {
    const state = published();
    expect(state.publishedAt).toBe(T0);
    expect(state.soakUntil).toBe(at(T0, 3).toISOString());
    expect(state.held).toBe(false);
    expect(Object.keys(state.platforms)).toEqual(["mac"]);
  });

  it("restarts the clock when a second platform lands later, and keeps a hold", () => {
    const mac = setHold(published(), true, { now: T0, reason: "crash report" });
    const both = recordEarlyPublish(mac, {
      version: "0.9.0",
      commit: "abc123",
      platform: "win",
      publishedAt: at(T0, 1).toISOString(),
      platformRecord: { files: [] },
    });
    expect(both.publishedAt).toBe(T0);
    expect(both.soakUntil).toBe(at(T0, 4).toISOString());
    expect(both.soakDays).toBe(3);
    expect(both.held).toBe(true);
    expect(Object.keys(both.platforms).sort()).toEqual(["mac", "win"]);
  });

  it("refuses a prerelease, a different commit, and a version already promoted", () => {
    expect(() => published("0.9.0-beta.1")).toThrow(/stable version/);
    expect(() =>
      recordEarlyPublish(published(), {
        version: "0.9.0",
        commit: "different",
        platform: "win",
        publishedAt: T0,
        platformRecord: { files: [] },
      })
    ).toThrow(/second commit/);
    expect(() =>
      recordEarlyPublish(markPromoted(published(), at(T0, 3)), {
        version: "0.9.0",
        commit: "abc123",
        platform: "mac",
        publishedAt: T0,
        platformRecord: { files: [] },
      })
    ).toThrow(/already promoted/);
  });
});

describe("promotionBlocker", () => {
  it("blocks during the soak and lets --now skip only the soak", () => {
    const state = published();
    expect(promotionBlocker(state, at(T0, 1))).toMatch(/soaking until/);
    expect(promotionBlocker(state, at(T0, 1), { force: true })).toBeNull();
    expect(promotionBlocker(state, at(T0, 3))).toBeNull();
  });

  it("never lets --now override a hold, a withdrawal, or a supersede", () => {
    const now = at(T0, 10);
    const held = setHold(published(), true, { now: T0, reason: "wait for QA" });
    expect(promotionBlocker(held, now, { force: true })).toMatch(/held \(wait for QA\)/);
    expect(promotionBlocker(markWithdrawn(published(), now), now, { force: true })).toMatch(/withdrawn/);
    expect(promotionBlocker(markSuperseded(published(), now, "0.9.1"), now, { force: true })).toMatch(
      /superseded by 0\.9\.1/
    );
  });

  it("refuses an unknown or already-promoted release", () => {
    expect(promotionBlocker(null, T0)).toMatch(/no early release/);
    expect(promotionBlocker(markPromoted(published(), at(T0, 3)), at(T0, 4))).toMatch(/already promoted/);
  });

  it("unhold restores normal soak rules without restarting the clock", () => {
    const state = setHold(setHold(published(), true, { now: T0 }), false, { now: at(T0, 5) });
    expect(state.held).toBe(false);
    expect(state.soakUntil).toBe(at(T0, 3).toISOString());
    expect(promotionBlocker(state, at(T0, 5))).toBeNull();
  });
});

describe("planPromoteDue", () => {
  it("does nothing with no releases", () => {
    expect(planPromoteDue([], T0)).toEqual({ due: null, superseded: [], summary: "nothing pending" });
  });

  it("reports a soaking release in one line", () => {
    const plan = planPromoteDue([published()], at(T0, 1));
    expect(plan.due).toBeNull();
    expect(plan.summary).toBe(`0.9.0 soaking until ${at(T0, 3).toISOString()} (2d 0h left)`);
  });

  it("reports a hold", () => {
    const plan = planPromoteDue([setHold(published(), true, { now: T0, reason: "bug" })], at(T0, 9));
    expect(plan.due).toBeNull();
    expect(plan.summary).toBe("0.9.0 held (bug)");
  });

  it("names the release that is due", () => {
    const plan = planPromoteDue([published()], at(T0, 3));
    expect(plan.due?.version).toBe("0.9.0");
  });

  it("lets a newer early release replace an older one and restart the clock", () => {
    const older = published("0.9.0");
    const newer = published("0.9.1", { publishedAt: at(T0, 2).toISOString() });
    // The old one's soak is over, but it is no longer what early users run.
    const plan = planPromoteDue([older, newer], at(T0, 3.5));
    expect(plan.due).toBeNull();
    expect(plan.superseded).toEqual(["0.9.0"]);
    expect(plan.summary).toMatch(/^0\.9\.1 soaking until/);
    expect(planPromoteDue([older, newer], at(T0, 5)).due?.version).toBe("0.9.1");
  });

  it("is idempotent once a release is promoted", () => {
    const done = markPromoted(published(), at(T0, 3));
    expect(planPromoteDue([done], at(T0, 30)).due).toBeNull();
  });

  it("never auto-promotes an old build because a newer one was withdrawn", () => {
    const older = published("0.9.0");
    const newer = markWithdrawn(published("0.9.1", { publishedAt: at(T0, 1).toISOString() }), at(T0, 2));
    expect(planPromoteDue([older, newer], at(T0, 9)).due).toBeNull();
  });

  it("ignores legacy prerelease state", () => {
    const legacy = { ...published(), version: "0.9.0-beta.1" };
    expect(planPromoteDue([legacy], at(T0, 9)).due).toBeNull();
  });
});
