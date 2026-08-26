import { describe, expect, it } from "vitest";
import {
  INDEX,
  PROJECTS_AT_KEY,
  parseLocation,
  readLocation,
  resolveLocation,
  sameLocation,
  searchScope,
  serializeLocation,
  writeLocation,
  type ProjectsLocation,
} from "@/lib/projects-nav";

describe("serializing where you are", () => {
  const cases: Array<[ProjectsLocation, string]> = [
    [INDEX, "index:"],
    [{ kind: "project", key: "alt-ui" }, "project:alt-ui"],
    [{ kind: "folder", id: "today" }, "folder:today"],
  ];

  it("round-trips every location", () => {
    for (const [loc, raw] of cases) {
      expect(serializeLocation(loc)).toBe(raw);
      expect(parseLocation(raw)).toEqual(loc);
    }
  });

  it("keeps a project name containing a colon whole", () => {
    // Project names come from folders on disk, and a folder may contain any
    // character the filesystem allows.
    const loc: ProjectsLocation = { kind: "project", key: "notes: 2026" };
    expect(parseLocation(serializeLocation(loc))).toEqual(loc);
  });

  it("reads anything it does not understand as the index", () => {
    expect(parseLocation(null)).toEqual(INDEX);
    expect(parseLocation("")).toEqual(INDEX);
    expect(parseLocation("nonsense")).toEqual(INDEX);
    expect(parseLocation("project:")).toEqual(INDEX);
    expect(parseLocation("elsewhere:x")).toEqual(INDEX);
  });

  it("compares locations by what they mean", () => {
    expect(sameLocation({ kind: "project", key: "a" }, { kind: "project", key: "a" })).toBe(true);
    expect(sameLocation({ kind: "project", key: "a" }, { kind: "folder", id: "a" })).toBe(false);
  });
});

describe("remembering where you were", () => {
  it("writes under one key and reads it back", () => {
    const store = new Map<string, string>();
    writeLocation((k, v) => store.set(k, v), { kind: "folder", id: "week" });
    expect(store.get(PROJECTS_AT_KEY)).toBe("folder:week");
    expect(readLocation((k) => store.get(k) ?? null)).toEqual({ kind: "folder", id: "week" });
  });

  it("survives storage that refuses to answer, in both directions", () => {
    expect(
      readLocation(() => {
        throw new Error("blocked");
      })
    ).toEqual(INDEX);
    expect(() =>
      writeLocation(() => {
        throw new Error("blocked");
      }, INDEX)
    ).not.toThrow();
  });
});

describe("resolveLocation", () => {
  const known = { projectKeys: ["alt-ui", "Thesis"], folderIds: ["today", "week"] };

  it("keeps a destination that still exists", () => {
    expect(resolveLocation({ kind: "project", key: "Thesis" }, known)).toEqual({
      kind: "project",
      key: "Thesis",
    });
    expect(resolveLocation({ kind: "folder", id: "week" }, known)).toEqual({
      kind: "folder",
      id: "week",
    });
  });

  it("falls back to the index when the destination is gone", () => {
    // The repository was deleted, or the rule that named the project changed.
    // Landing on a header that names nothing is worse than landing at the top.
    expect(resolveLocation({ kind: "project", key: "deleted" }, known)).toEqual(INDEX);
    expect(resolveLocation({ kind: "folder", id: "u-old" }, known)).toEqual(INDEX);
  });
});

describe("searchScope", () => {
  it("says the field searches everything at the index", () => {
    const scope = searchScope(INDEX, "");
    expect(scope.badge).toBe("All projects");
    expect(scope.placeholder).toMatch(/every project and file/i);
    expect(scope.label).toBe(scope.placeholder);
  });

  it("names the thing you are inside, so the badge survives typing", () => {
    // A placeholder disappears the moment you type, which is exactly when
    // "what am I searching" stops being obvious.
    const scope = searchScope({ kind: "project", key: "alt-ui" }, "alt-ui");
    expect(scope.badge).toBe("In alt-ui");
    expect(scope.placeholder).toBe("Search inside alt-ui");
  });

  it("works the same for a folder", () => {
    expect(searchScope({ kind: "folder", id: "today" }, "Updated today").badge).toBe(
      "In Updated today"
    );
  });
});
