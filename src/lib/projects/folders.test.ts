import { describe, expect, it } from "vitest";
import {
  BUILTIN_FOLDER_NAMES,
  computeFolders,
  describeFolder,
  filterFolder,
  startOfDay,
} from "@/lib/projects/folders";
import { parseRules, type FolderRule } from "@/lib/projects/rules";
import type { FileNode, ProjectNode } from "@/lib/projects/taxonomy";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
// Fixed at midday so "today" and "the last 24 hours" are genuinely different
// windows and a test can tell which one is being used.
const NOW = new Date("2026-08-26T12:00:00.000Z").getTime();

const file = (name: string, dir: string, mtimeMs: number): FileNode => ({
  path: `${dir}/${name}`,
  name,
  dir,
  mtimeMs,
  birthtimeMs: mtimeMs,
  fmProject: null,
  fmBlock: null,
  repoName: null,
});

const project = (key: string, files: FileNode[], over: Partial<ProjectNode> = {}): ProjectNode => ({
  key,
  name: key,
  made: Math.min(...files.map((f) => f.mtimeMs)),
  updated: Math.max(...files.map((f) => f.mtimeMs)),
  fileCount: files.length,
  blocks: [{ id: `${key}-b`, name: "work", made: 0, updated: 0, files }],
  looseFiles: [],
  isUnfiled: false,
  ...over,
});

const opts = { now: NOW, home: "/home/u" };

// One project written this morning, one written two days ago, one ancient.
const PROJECTS = [
  project("Markie", [
    file("plan.md", "/home/u/Documents/Markie", NOW - HOUR),
    file("spec.md", "/home/u/Documents/Markie", NOW - 3 * HOUR),
  ]),
  project("Thesis", [file("ch1.md", "/home/u/Documents/Thesis", NOW - 2 * DAY)]),
  project("Archive", [file("old.md", "/home/u/Documents/Archive", NOW - 200 * DAY)]),
];

const byName = (name: string, projects = PROJECTS, custom: FolderRule[] = []) =>
  computeFolders(projects, custom, opts).find((f) => f.name === name)!;

describe("computeFolders built-ins", () => {
  it("ships exactly three, in widening order", () => {
    const folders = computeFolders(PROJECTS, [], opts);
    expect(folders.map((f) => f.name)).toEqual([...BUILTIN_FOLDER_NAMES]);
    expect(folders.every((f) => !f.custom)).toBe(true);
  });

  it("counts today from midnight, not from 24 hours ago", () => {
    // Written 20 hours ago: inside a rolling day, but yesterday by the clock,
    // and "updated today" is a claim about the calendar.
    const yesterdayEvening = [project("Late", [file("late.md", "/home/u/x", NOW - 20 * HOUR)])];
    expect(startOfDay(NOW)).toBeGreaterThan(NOW - 20 * HOUR);
    expect(byName("Updated today", yesterdayEvening).count).toBe(0);
    expect(byName("Updated in the past 3 days", yesterdayEvening).count).toBe(1);
  });

  it("nests, so a file never appears in the narrow folder and not the wide one", () => {
    const [today, three, week] = computeFolders(PROJECTS, [], opts);
    const paths = (f: (typeof today)) => f.groups.flatMap((g) => g.files.map((x) => x.path));
    expect(paths(today).every((p) => paths(three).includes(p))).toBe(true);
    expect(paths(three).every((p) => paths(week).includes(p))).toBe(true);
    expect(today.count).toBeLessThanOrEqual(three.count);
    expect(three.count).toBeLessThanOrEqual(week.count);
  });

  it("leaves out what falls outside the window", () => {
    const week = byName("Updated in the past week");
    expect(week.groups.map((g) => g.projectKey)).toEqual(["Markie", "Thesis"]);
    expect(week.count).toBe(3);
  });
});

describe("computeFolders grouping", () => {
  it("keeps every file attributed to the project it is still in", () => {
    // This is the whole answer to "is a folder a place". A file is in the
    // folder and in its project at the same time, and the folder says which.
    const week = byName("Updated in the past week");
    const markie = week.groups.find((g) => g.projectKey === "Markie")!;
    expect(markie.projectName).toBe("Markie");
    expect(markie.files.map((f) => f.name)).toEqual(["plan.md", "spec.md"]);
    expect(week.projectCount).toBe(2);
  });

  it("shows the name the user gave a project, not the derived key", () => {
    const renamed = [project("markdown-viewer-zvn", [file("a.md", "/home/u/r", NOW)], {
      name: "Markie",
    })];
    const today = byName("Updated today", renamed);
    expect(today.groups[0].projectName).toBe("Markie");
    expect(today.groups[0].projectKey).toBe("markdown-viewer-zvn");
  });

  it("sorts projects by their newest file, and files newest first inside each", () => {
    const week = byName("Updated in the past week");
    expect(week.groups.map((g) => g.projectKey)).toEqual(["Markie", "Thesis"]);
    expect(week.groups[0].files.map((f) => f.name)).toEqual(["plan.md", "spec.md"]);
  });

  it("puts the Unfiled group last inside a folder, however fresh its files are", () => {
    // Same rule as the project grid, and for the same reason: inside a folder
    // Unfiled is usually the freshest group, because a loose file is exactly
    // the kind that gets written and never filed.
    const unfiled = project("Unfiled", [file("scratch.md", "/home/u/Desktop", NOW - 60_000)], {
      isUnfiled: true,
    });
    const folders = computeFolders([...PROJECTS, unfiled], [], opts);
    const week = folders.find((f) => f.id === "week")!;
    expect(week.groups[week.groups.length - 1].projectKey).toBe("Unfiled");
    // and it really was the newest thing, so last place is the rule, not luck
    const newest = [...week.groups].sort((a, b) => b.updated - a.updated)[0];
    expect(newest.projectKey).toBe("Unfiled");
  });

  it("counts loose files too, not only the ones inside blocks", () => {
    const loose = [
      project("Mixed", [file("in-block.md", "/home/u/m", NOW)], {
        looseFiles: [file("loose.md", "/home/u/m", NOW)],
      }),
    ];
    expect(byName("Updated today", loose).count).toBe(2);
  });

  it("keeps an empty project out of every folder rather than showing a heading with nothing under it", () => {
    const empty = [
      ...PROJECTS,
      { ...project("New", [file("x.md", "/x", NOW)]), blocks: [], looseFiles: [], fileCount: 0 },
    ];
    expect(byName("Updated today", empty).groups.map((g) => g.projectKey)).not.toContain("New");
  });
});

describe("user-defined folders", () => {
  it("keeps files under a path", () => {
    const folders = computeFolders(PROJECTS, [
      { name: "Thesis chapters", withinMs: null, match: "~/Documents/Thesis/**" },
    ], opts);
    const mine = folders.find((f) => f.name === "Thesis chapters")!;
    expect(mine.custom).toBe(true);
    expect(mine.count).toBe(1);
    expect(mine.groups[0].projectKey).toBe("Thesis");
  });

  it("keeps files inside a window of its own", () => {
    const mine = byName("This year", PROJECTS, [
      { name: "This year", withinMs: 365 * DAY, match: null },
    ]);
    // Everything, including the file the shipped week folder leaves out.
    expect(mine.count).toBe(4);
    expect(byName("Updated in the past week").count).toBe(3);
  });

  it("requires both when both are given", () => {
    const mine = byName("Recent thesis", PROJECTS, [
      { name: "Recent thesis", withinMs: 7 * DAY, match: "~/Documents/Thesis/**" },
    ]);
    expect(mine.count).toBe(1);
    const stale = byName("Recent archive", PROJECTS, [
      { name: "Recent archive", withinMs: 7 * DAY, match: "~/Documents/Archive/**" },
    ]);
    expect(stale.count).toBe(0);
  });

  it("replaces a built-in it shares a name with, rather than sitting beside it", () => {
    // The only escape hatch the shipped three need, and it costs no syntax.
    const folders = computeFolders(PROJECTS, [
      { name: "Updated today", withinMs: 365 * DAY, match: null },
    ], opts);
    expect(folders.filter((f) => f.name === "Updated today")).toHaveLength(1);
    expect(folders[0].id).toBe("today");
    expect(folders[0].custom).toBe(true);
    // A year, in the slot "today" used to hold: the user's window, not ours.
    expect(folders[0].count).toBe(4);
  });

  it("gives two folders with the same name their own identities", () => {
    const folders = computeFolders(PROJECTS, [
      { name: "Specs", withinMs: null, match: "~/Documents/Markie/**" },
      { name: "Specs", withinMs: null, match: "~/Documents/Thesis/**" },
    ], opts);
    const ids = folders.filter((f) => f.name === "Specs").map((f) => f.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("reads its folders straight out of Projects.md", () => {
    const { rules, error } = parseRules(
      [
        "---",
        "markie_rules:",
        "  folders:",
        "    - name: This month",
        "      within: 30d",
        "    - name: Specs",
        '      match: "**/specs/**"',
        "---",
      ].join("\n")
    );
    expect(error).toBeNull();
    expect(rules!.folders).toEqual([
      { name: "This month", withinMs: 30 * DAY, match: null },
      { name: "Specs", withinMs: null, match: "**/specs/**" },
    ]);
  });
});

describe("describeFolder", () => {
  it("says what the folder keeps, in words a person can check", () => {
    expect(describeFolder({ withinMs: 3 * DAY, match: null })).toBe(
      "Files edited in the last 3 days."
    );
    expect(describeFolder({ withinMs: 7 * DAY, match: null })).toBe(
      "Files edited in the last 7 days."
    );
    expect(describeFolder({ withinMs: 12 * HOUR, match: null })).toBe(
      "Files edited in the last 12 hours."
    );
    expect(describeFolder({ withinMs: null, match: "**/specs/**" })).toBe(
      "Files stored under **/specs/**."
    );
    expect(describeFolder({ withinMs: DAY, match: "~/w/**" })).toBe(
      "Files edited in the last day and stored under ~/w/**."
    );
  });
});

describe("filterFolder", () => {
  const week = byName("Updated in the past week");

  it("narrows to matching files and drops the projects left with none", () => {
    const found = filterFolder(week, "ch1");
    expect(found.groups.map((g) => g.projectKey)).toEqual(["Thesis"]);
    expect(found.count).toBe(1);
    expect(found.projectCount).toBe(1);
  });

  it("keeps a whole project group when the project name matches", () => {
    expect(filterFolder(week, "markie").count).toBe(2);
  });

  it("returns the folder untouched for an empty filter", () => {
    expect(filterFolder(week, "  ")).toBe(week);
  });
});
