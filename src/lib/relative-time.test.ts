import { describe, expect, it } from "vitest";
import { longAgo, relativeTime, shortAgo } from "@/lib/relative-time";

const NOW = Date.parse("2026-08-26T12:00:00Z");
const ago = (ms: number) => NOW - ms;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  it("counts up through minutes, hours, and days", () => {
    expect(relativeTime(new Date(ago(10_000)).toISOString(), NOW)).toBe("moments ago");
    expect(relativeTime(new Date(ago(MIN)).toISOString(), NOW)).toBe("1 minute ago");
    expect(relativeTime(new Date(ago(5 * MIN)).toISOString(), NOW)).toBe("5 minutes ago");
    expect(relativeTime(new Date(ago(3 * HOUR)).toISOString(), NOW)).toBe("3 hours ago");
    expect(relativeTime(new Date(ago(2 * DAY)).toISOString(), NOW)).toBe("2 days ago");
  });

  it("says nothing rather than NaN for an unparseable date", () => {
    expect(relativeTime("not a date", NOW)).toBe("");
  });
});

describe("shortAgo", () => {
  it("fits every span into at most four characters", () => {
    const cases: Array<[number, string]> = [
      [0, "now"],
      [30 * 1000, "now"],
      [5 * MIN, "5m"],
      [3 * HOUR, "3h"],
      [2 * DAY, "2d"],
      [10 * DAY, "1w"],
      [60 * DAY, "2mo"],
      [800 * DAY, "2y"],
    ];
    for (const [delta, expected] of cases) {
      expect(shortAgo(ago(delta), NOW), `${delta}ms`).toBe(expected);
      expect(shortAgo(ago(delta), NOW).length).toBeLessThanOrEqual(4);
    }
  });

  it("treats a timestamp from the future as now, not as a negative age", () => {
    expect(shortAgo(NOW + DAY, NOW)).toBe("now");
  });

  it("says nothing for a missing timestamp", () => {
    expect(shortAgo(NaN, NOW)).toBe("");
  });
});

describe("longAgo", () => {
  it("reads a numeric timestamp the same way relativeTime reads an ISO one", () => {
    expect(longAgo(ago(3 * HOUR), NOW)).toBe("3 hours ago");
  });
});
