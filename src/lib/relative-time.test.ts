import { describe, expect, it } from "vitest";
import { longAgo, relativeTime, shortAgo, updatedAgo, updatedOn } from "@/lib/relative-time";

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

describe("updatedAgo", () => {
  const MONTH_DAY = { month: "short", day: "numeric" } as const;

  it("counts minutes and hours, then names the day", () => {
    expect(updatedAgo(ago(20 * 1000), NOW)).toBe("just now");
    expect(updatedAgo(ago(5 * MIN), NOW)).toBe("5m ago");
    expect(updatedAgo(ago(2 * HOUR), NOW)).toBe("2h ago");
    expect(updatedAgo(ago(26 * HOUR), NOW)).toBe("yesterday");
  });

  it("falls back to the date within this year and to the year before that", () => {
    const march = Date.parse("2026-03-03T15:00:00Z");
    expect(updatedAgo(march, NOW)).toBe(new Date(march).toLocaleDateString(undefined, MONTH_DAY));
    expect(updatedAgo(Date.parse("2025-11-02T15:00:00Z"), NOW)).toBe("2025");
  });

  it("treats a timestamp from the future as now", () => {
    expect(updatedAgo(NOW + DAY, NOW)).toBe("just now");
  });

  it("says nothing for a missing timestamp", () => {
    expect(updatedAgo(NaN, NOW)).toBe("");
  });
});

describe("updatedOn", () => {
  it("spells the whole local date and time out for a tooltip", () => {
    const t = Date.parse("2026-03-03T15:00:00Z");
    expect(updatedOn(t)).toBe(new Date(t).toLocaleString());
  });

  it("says nothing for a missing timestamp", () => {
    expect(updatedOn(NaN)).toBe("");
  });
});
