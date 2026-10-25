import { describe, expect, it } from "vitest";
import type { RecentDoc } from "../src/lib/docs";
import { agentBadge, displayName, filterRecent, mergeRecent, nextCursor, sectionRecent, sharedLabel, timeLabel } from "../src/lib/recent";

const NOW = Date.parse("2026-10-25T15:00:00.000Z");

function doc(id: string, name: string, updatedAt: string, extra: Partial<RecentDoc> = {}): RecentDoc {
  return {
    id, name, format: "markdown", createdAt: null, updatedAt,
    origin: { kind: "app", agent: null }, shared: false, role: "owner", sharedBy: null,
    privateLink: `https://api.markiedocs.com/d/${id}`, ...extra,
  };
}

const a = doc("a", "Launch brief.md", "2026-10-25T14:50:00.000Z", { origin: { kind: "agent", agent: "Claude Code" } });
const b = doc("b", "Café menu.md", "2026-10-24T09:00:00.000Z", { shared: true, sharedBy: "ana@example.com", role: "viewer" });
const c = doc("c", "Counter.wd", "2026-10-20T09:00:00.000Z", { format: "darkmown", origin: { kind: "agent", agent: null } });
const d = doc("d", "Old notes.txt", "2026-08-01T09:00:00.000Z", { format: "text" });

describe("recent list", () => {
  it("merges pages newest first, one row per id, keeping the newer copy", () => {
    const stale = { ...a, name: "Old title.md", updatedAt: "2026-10-25T10:00:00.000Z" };
    expect(mergeRecent([stale, c], [b, a, d]).map((x) => [x.id, x.name])).toEqual([["a", "Launch brief.md"], ["b", "Café menu.md"], ["c", "Counter.wd"], ["d", "Old notes.txt"]]);
  });

  it("pages with the oldest row's time, and stops on a short page", () => {
    expect(nextCursor([a, b, c], 3)).toBe(c.updatedAt);
    expect(nextCursor([a, b], 3)).toBeNull();
    expect(nextCursor([], 3)).toBeNull();
  });

  it("searches names only, ignoring case and accents, word by word", () => {
    const docs = [a, b, c, d];
    expect(filterRecent(docs, "cafe", "all").map((x) => x.id)).toEqual(["b"]);
    expect(filterRecent(docs, "BRIEF launch", "all").map((x) => x.id)).toEqual(["a"]);
    expect(filterRecent(docs, "  ", "all")).toHaveLength(4);
    expect(filterRecent(docs, "zzz", "all")).toEqual([]);
  });

  it("filters to what was shared with you", () => {
    expect(filterRecent([a, b, c, d], "", "shared").map((x) => x.id)).toEqual(["b"]);
    expect(filterRecent([a, b, c, d], "launch", "shared")).toEqual([]);
  });

  it("badges agent documents by name, or as an agent when unnamed", () => {
    expect(agentBadge(a)).toBe("from Claude Code");
    expect(agentBadge(c)).toBe("from an agent");
    expect(agentBadge(b)).toBeNull();
  });

  it("labels shared rows and trims the extension the icon already shows", () => {
    expect(sharedLabel(b)).toBe("Shared by ana@example.com");
    expect(sharedLabel({ shared: true, sharedBy: null })).toBe("Shared with you");
    expect(sharedLabel(a)).toBeNull();
    expect(displayName("Launch brief.md")).toBe("Launch brief");
    expect(displayName("Counter.wd")).toBe("Counter");
    expect(displayName(".md")).toBe(".md");
  });

  it("says how long ago in the desktop's words", () => {
    expect(timeLabel(a.updatedAt, NOW)).toBe("10m ago");
    expect(timeLabel("not a date", NOW)).toBe("");
  });

  it("groups into Today, Yesterday, the past week, then months", () => {
    const sections = sectionRecent([a, b, c, d], NOW);
    expect(sections.map((s) => [s.title, s.docs.map((x) => x.id)])).toEqual([
      ["Today", ["a"]],
      ["Yesterday", ["b"]],
      ["Previous 7 Days", ["c"]],
      [new Date(d.updatedAt).toLocaleDateString(undefined, { month: "long" }), ["d"]],
    ]);
  });
});
