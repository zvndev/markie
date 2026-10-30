import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "@/lib/electron";
import {
  agentDisplayName,
  authorColor,
  authorLabel,
  formatVersionHeading,
  formatVersionTime,
  groupVersions,
  sectionFor,
} from "@/lib/version-history";

// Local time throughout: sections are calendar days where the user is.
const NOW = new Date(2026, 9, 30, 15, 0); // Friday 30 October 2026, 3pm
const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo, d, h, mi).toISOString();
let n = 0;
const v = (iso: string, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({
  stamp: `s${n++}`,
  iso,
  author: "user",
  bytes: 10,
  ...extra,
});

describe("sectionFor", () => {
  it("names calendar days, then the week, then months", () => {
    expect(sectionFor(Date.parse(at(2026, 9, 30, 0, 5)), NOW).label).toBe("Today");
    expect(sectionFor(Date.parse(at(2026, 9, 29, 23, 50)), NOW).label).toBe("Yesterday");
    expect(sectionFor(Date.parse(at(2026, 9, 25)), NOW).label).toBe("This week");
    expect(sectionFor(Date.parse(at(2026, 9, 23)), NOW).label).toBe("October");
    expect(sectionFor(Date.parse(at(2026, 8, 29)), NOW).label).toBe("September");
    expect(sectionFor(Date.parse(at(2025, 11, 2)), NOW).label).toBe("December 2025");
  });
});

describe("groupVersions", () => {
  it("groups newest-first versions into sections in order", () => {
    const groups = groupVersions(
      [v(at(2026, 9, 30, 14)), v(at(2026, 9, 29, 9)), v(at(2026, 9, 24, 9)), v(at(2026, 8, 3))],
      NOW
    );
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "This week", "September"]);
  });

  it("folds autosaves within thirty minutes of the newest into one row", () => {
    const entries = [
      v(at(2026, 9, 30, 14, 40)),
      v(at(2026, 9, 30, 14, 31)),
      v(at(2026, 9, 30, 14, 15)),
      // 35 minutes after the run's newest: a new row, even though it is only
      // 10 minutes from the previous one.
      v(at(2026, 9, 30, 14, 5)),
    ];
    const [today] = groupVersions(entries, NOW);
    expect(today.rows).toHaveLength(2);
    expect(today.rows[0].lead).toBe(entries[0]);
    expect(today.rows[0].minor).toEqual([entries[1], entries[2]]);
    expect(today.rows[1].minor).toEqual([]);
  });

  it("never folds across authors, agents or sections", () => {
    const entries = [
      v(at(2026, 9, 30, 0, 10)),
      v(at(2026, 9, 30, 0, 5), { author: "agent", agent: "claude-code" }),
      v(at(2026, 9, 30, 0, 4), { author: "agent", agent: "Codex" }),
      v(at(2026, 9, 29, 23, 59)),
    ];
    const groups = groupVersions(entries, NOW);
    expect(groups[0].rows).toHaveLength(3);
    expect(groups[1].rows).toHaveLength(1);
  });

  it("gives a named version its own row", () => {
    const entries = [
      v(at(2026, 9, 30, 14, 40)),
      v(at(2026, 9, 30, 14, 39), { name: "Sent to Ana" }),
      v(at(2026, 9, 30, 14, 38)),
    ];
    const rows = groupVersions(entries, NOW)[0].rows;
    expect(rows.map((r) => r.minor.length)).toEqual([0, 0, 0]);
    expect(rows[1].lead.name).toBe("Sent to Ana");
  });
});

describe("authors", () => {
  it("labels you, agents by name, and outside edits", () => {
    expect(authorLabel({ author: "user" })).toBe("You");
    expect(authorLabel({ author: "external" })).toBe("External edit");
    expect(authorLabel({ author: "unknown" })).toBe("Unknown");
    expect(authorLabel({ author: "agent", agent: "claude-code" })).toBe("Claude Code");
    expect(authorLabel({ author: "agent", agent: "codex-mcp-client" })).toBe("Codex");
    expect(authorLabel({ author: "agent", agent: "my-own-bot" })).toBe("my-own-bot");
    expect(agentDisplayName("an agent")).toBe("An agent");
    expect(agentDisplayName("")).toBe("An agent");
  });

  it("gives each author a stable colour", () => {
    expect(authorColor({ author: "user" })).toBe("var(--blue)");
    expect(authorColor({ author: "external" })).toBe("var(--muted)");
    const a = authorColor({ author: "agent", agent: "claude-code" });
    expect(authorColor({ author: "agent", agent: "claude-code" })).toBe(a);
  });
});

describe("times", () => {
  it("formats rows like Docs and drops the year when it is this year", () => {
    expect(formatVersionTime(at(2026, 9, 30, 14, 30), NOW)).toBe("October 30, 2:30 PM");
    expect(formatVersionTime(at(2025, 8, 29, 21, 38), NOW)).toBe("September 29, 2025, 9:38 PM");
    expect(formatVersionHeading(at(2026, 9, 30, 14, 30), NOW)).toBe("Today, 2:30 PM");
    expect(formatVersionHeading(at(2026, 9, 29, 9, 5), NOW)).toBe("Yesterday, 9:05 AM");
  });
});
