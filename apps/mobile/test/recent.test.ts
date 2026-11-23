import { describe, expect, it } from "vitest";
import type { RecentDoc } from "../src/lib/docs";
import {
  agentBadge, displayName, filterRecent, mergeRecent, nextCursor, parseSharedByMe, sectionRecent, sharedLabel, sharedOutIndex, sharedOutLabel,
  sharedOutRows, timeLabel,
} from "../src/lib/recent";

const NOW = Date.parse("2026-10-25T15:00:00.000Z");

function doc(id: string, name: string, updatedAt: string, extra: Partial<RecentDoc> = {}): RecentDoc {
  return {
    id, store: "docs", kind: "markdown", name, format: "markdown", createdAt: null, updatedAt,
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

  describe("shared by me", () => {
    const answer = {
      docs: [
        { id: "a", name: "Launch brief.md", updated_at: "2026-10-25T14:50:00.000Z", memberCount: 2, pendingCount: 1, folder_id: null },
        { id: "old", name: "Hiring plan.txt", updated_at: "2026-03-02T08:00:00.000Z", memberCount: 0, pendingCount: 2 },
        { id: "solo", name: "One reader.md", updated_at: "2026-10-01T08:00:00.000Z", memberCount: 1, pendingCount: 0 },
        // Left out: nobody on it, a bad id, no time, not an object.
        { id: "none", name: "Nobody.md", updated_at: "2026-10-01T08:00:00.000Z", memberCount: 0, pendingCount: 0 },
        { id: "../etc", name: "x.md", updated_at: "2026-10-01T08:00:00.000Z", memberCount: 1, pendingCount: 0 },
        { id: "undated", name: "x.md", memberCount: 1, pendingCount: 0 },
        "nonsense",
      ],
    };
    const list = parseSharedByMe(answer);

    it("reads the server's list and leaves out what it can't trust", () => {
      expect(list.map((x) => x.id)).toEqual(["a", "old", "solo"]);
      expect(list[0]).toEqual({ id: "a", name: "Launch brief.md", updatedAt: "2026-10-25T14:50:00.000Z", memberCount: 2, pendingCount: 1 });
      expect(parseSharedByMe({ docs: [{ id: "x", name: "x.md", updated_at: "2026-10-01T08:00:00.000Z", memberCount: -3, pendingCount: "4" }] })).toEqual([]);
      expect(() => parseSharedByMe({ error: "nope" })).toThrow();
      expect(() => parseSharedByMe(null)).toThrow();
    });

    it("says who a document is shared with, as far as the server says: how many", () => {
      const byId = sharedOutIndex(list);
      expect(sharedOutLabel(byId.get("a"))).toBe("Shared with 2, invited 1");
      expect(sharedOutLabel(byId.get("old"))).toBe("2 people invited");
      expect(sharedOutLabel(byId.get("solo"))).toBe("Shared with 1 person");
      expect(sharedOutLabel(byId.get("b"))).toBeNull();
    });

    it("lists every shared document, newest first, even one Recent hasn't paged to", () => {
      const rows = sharedOutRows(list, [a, b, c, d], "https://api.markiedocs.com");
      expect(rows.map((x) => x.id)).toEqual(["a", "solo", "old"]);
      // The loaded row is kept as it is, with what only Recent knows.
      expect(rows[0]).toBe(a);
      expect(rows[2]).toMatchObject({ store: "docs", format: "text", kind: "text", role: "owner", shared: false, privateLink: "https://markiedocs.com/d/old" });
    });

    it("searches and filters by type inside the scope", () => {
      const rows = sharedOutRows(list, [a], "https://api.markiedocs.com");
      expect(filterRecent(rows, "hiring", "mine").map((x) => x.id)).toEqual(["old"]);
      expect(filterRecent(rows, "", "mine", "text").map((x) => x.id)).toEqual(["old"]);
      expect(filterRecent(rows, "", "mine").map((x) => x.id)).toEqual(["a", "solo", "old"]);
    });
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
