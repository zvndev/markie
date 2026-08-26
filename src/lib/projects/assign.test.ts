import { describe, expect, it } from "vitest";
import {
  assignProjects,
  containerChild,
  discoverContainers,
  UNFILED,
  type EngineFile,
} from "@/lib/projects/assign";
import { parseRules } from "@/lib/projects/rules";

const HOME = "/home/u";
const f = (over: Partial<EngineFile>): EngineFile => ({
  path: "/home/u/x.md",
  name: "x.md",
  dir: "/home/u",
  mtimeMs: 1,
  birthtimeMs: null,
  fmProject: null,
  fmBlock: null,
  repoName: null,
  ...over,
});

const RULES = parseRules(`---
markie_rules:
  rules:
    - match: "~/code/**"
      project: "{repo}"
---
`).rules!;

describe("assignProjects: the precedence ladder", () => {
  it("1. a pin beats front matter, rules, and derivation", () => {
    const file = f({
      path: "/home/u/code/repo1/a.md",
      dir: "/home/u/code/repo1",
      repoName: "repo1",
      fmProject: "FM Project",
    });
    const { assignments } = assignProjects([file], {
      pins: [{ path: file.path, project: "Pinned", block_id: "b9" }],
      rules: RULES,
      home: HOME,
    });
    expect(assignments[0]).toMatchObject({
      project: "Pinned",
      pinnedBlockId: "b9",
      source: "pin",
    });
  });

  it("2. front matter beats rules", () => {
    const file = f({
      path: "/home/u/code/repo1/a.md",
      dir: "/home/u/code/repo1",
      repoName: "repo1",
      fmProject: "FM Project",
      fmBlock: "fm-block",
    });
    const { assignments } = assignProjects([file], { pins: [], rules: RULES, home: HOME });
    expect(assignments[0]).toMatchObject({
      project: "FM Project",
      fixedBlock: "fm-block",
      source: "frontmatter",
    });
  });

  it("3. rules beat derivation", () => {
    const file = f({
      path: "/home/u/code/repo1/a.md",
      dir: "/home/u/code/repo1",
      repoName: "repo1",
    });
    const { assignments } = assignProjects([file], { pins: [], rules: RULES, home: HOME });
    expect(assignments[0]).toMatchObject({ project: "repo1", source: "rule" });
  });

  it("4a. fallback: repo name", () => {
    const file = f({
      path: "/home/u/elsewhere/repo2/notes/a.md",
      dir: "/home/u/elsewhere/repo2/notes",
      repoName: "repo2",
    });
    const { assignments } = assignProjects([file], { pins: [], rules: RULES, home: HOME });
    expect(assignments[0]).toMatchObject({ project: "repo2", source: "derived" });
  });

  it("4b. fallback: highest ancestor under a container", () => {
    const file = f({
      path: "/home/u/Documents/Thesis/chapter1/a.md",
      dir: "/home/u/Documents/Thesis/chapter1",
    });
    const { assignments } = assignProjects([file], { pins: [], rules: RULES, home: HOME });
    expect(assignments[0]).toMatchObject({ project: "Thesis", source: "derived" });
  });

  it("4c. a file directly in a container goes to Unfiled", () => {
    const file = f({ path: "/home/u/Desktop/loose.md", dir: "/home/u/Desktop" });
    expect(
      assignProjects([file], { pins: [], rules: RULES, home: HOME }).assignments[0].project
    ).toBe(UNFILED);
    const atHome = f({ path: "/home/u/loose.md", dir: "/home/u" });
    expect(
      assignProjects([atHome], { pins: [], rules: RULES, home: HOME }).assignments[0].project
    ).toBe(UNFILED);
  });

  it("4d. a file outside every container and every repo goes to Unfiled", () => {
    const file = f({ path: "/Volumes/Ext/a.md", dir: "/Volumes/Ext" });
    expect(
      assignProjects([file], { pins: [], rules: RULES, home: HOME }).assignments[0].project
    ).toBe(UNFILED);
  });

  it("a pin to a project without a block leaves the block to derivation", () => {
    const file = f({ path: "/home/u/a.md" });
    const { assignments } = assignProjects([file], {
      pins: [{ path: file.path, project: "Pinned", block_id: null }],
      rules: RULES,
      home: HOME,
    });
    expect(assignments[0]).toMatchObject({ pinnedBlockId: null, source: "pin" });
  });

  it("ignore rules drop files from the taxonomy and count them", () => {
    const rules = parseRules(`---\nmarkie_rules:\n  ignore:\n    - "~/skip/**"\n---\n`).rules!;
    const { assignments, ignored } = assignProjects(
      [f({ path: "/home/u/skip/a.md", dir: "/home/u/skip" })],
      { pins: [], rules, home: HOME }
    );
    expect(assignments).toHaveLength(0);
    expect(ignored).toBe(1);
  });

  it("an ignore rule cannot silence a file the user pinned by hand", () => {
    const rules = parseRules(`---\nmarkie_rules:\n  ignore:\n    - "~/skip/**"\n---\n`).rules!;
    const file = f({ path: "/home/u/skip/a.md", dir: "/home/u/skip" });
    const { assignments, ignored } = assignProjects([file], {
      pins: [{ path: file.path, project: "Kept", block_id: null }],
      rules,
      home: HOME,
    });
    expect(ignored).toBe(0);
    expect(assignments[0].project).toBe("Kept");
  });
});

describe("containerChild", () => {
  it("prefers the deepest container", () => {
    expect(containerChild("/home/u/Documents/Thesis/ch1", HOME)).toBe("Thesis");
    expect(containerChild("/home/u/Projects/App", HOME)).toBe("Projects");
  });

  it("returns null in a container itself", () => {
    for (const dir of ["/home/u", "/home/u/Desktop", "/home/u/Documents", "/home/u/Downloads"]) {
      expect(containerChild(dir, HOME)).toBeNull();
    }
  });

  it("tolerates a trailing separator on either side", () => {
    expect(containerChild("/home/u/Desktop/", HOME)).toBeNull();
    expect(containerChild("/home/u/Desktop/Work", "/home/u/")).toBe("Work");
  });

  it("reads Windows paths", () => {
    expect(containerChild("C:\\Users\\u\\Documents\\Thesis\\ch1", "C:\\Users\\u")).toBe("Thesis");
  });
});

// A directory that mostly holds other projects is a shelf, not a project. The
// real index put 608 files under one project called "Coding" — the folder that
// contains every project on the machine — which tells a reader nothing.
describe("container discovery", () => {
  const inRepo = (repo: string, sub: string) =>
    f({
      path: `/home/u/Desktop/Coding/${sub}/${repo}/a.md`,
      dir: `/home/u/Desktop/Coding/${sub}/${repo}`,
      repoName: repo,
    });
  const loose = (dir: string) => f({ path: `${dir}/notes.md`, dir });
  const EMPTY = parseRules("").rules!;
  const assign = (files: EngineFile[], rules = EMPTY) =>
    assignProjects(files, { pins: [], rules, home: HOME }).assignments;

  it("finds a directory holding several repositories", () => {
    const found = discoverContainers(
      [inRepo("one", "ZVN"), inRepo("two", "ZVN"), inRepo("three", "ZVN")],
      HOME
    );
    expect(found.has("/home/u/Desktop/Coding")).toBe(true);
    expect(found.has("/home/u/Desktop/Coding/ZVN")).toBe(true);
    // The checkout itself holds exactly one repository: itself.
    expect(found.has("/home/u/Desktop/Coding/ZVN/one")).toBe(false);
  });

  it("leaves a directory holding a couple of checkouts alone", () => {
    const found = discoverContainers([inRepo("one", "ZVN"), inRepo("two", "ZVN")], HOME);
    expect(found.has("/home/u/Desktop/Coding")).toBe(false);
  });

  it("walks past a shelf to the folder the work is actually in", () => {
    const work = loose("/home/u/Desktop/Coding/ZVN/research");
    const assigned = assign([
      inRepo("one", "ZVN"),
      inRepo("two", "ZVN"),
      inRepo("three", "ZVN"),
      work,
    ]);
    expect(assigned.find((a) => a.path === work.path)?.project).toBe("research");
  });

  it("sends a file sitting loose in a shelf to Unfiled", () => {
    const stray = loose("/home/u/Desktop/Coding");
    const assigned = assign([
      inRepo("one", "ZVN"),
      inRepo("two", "ZVN"),
      inRepo("three", "ZVN"),
      stray,
    ]);
    expect(assigned.find((a) => a.path === stray.path)?.project).toBe(UNFILED);
  });

  it("a repository is still its own project inside a shelf", () => {
    const assigned = assign([inRepo("one", "ZVN"), inRepo("two", "ZVN"), inRepo("three", "ZVN")]);
    expect(assigned.map((a) => a.project).sort()).toEqual(["one", "three", "two"]);
  });

  it("takes a container the user names, and gives back one the user exempts", () => {
    const work = loose("/home/u/notes/journal");
    const named = parseRules(
      `---\nmarkie_rules:\n  containers:\n    - "~/notes"\n---\n`
    ).rules!;
    expect(assign([work], named)[0].project).toBe("journal");

    const exempted = parseRules(
      `---\nmarkie_rules:\n  containers:\n    - "~/notes"\n  not_containers:\n    - "~/notes"\n---\n`
    ).rules!;
    expect(assign([work], exempted)[0].project).toBe("notes");
  });

  it("lets the user take back a shelf Markie found on its own", () => {
    const work = loose("/home/u/Desktop/Coding/ZVN/research");
    const exempted = parseRules(
      `---\nmarkie_rules:\n  not_containers:\n    - "~/Desktop/Coding"\n---\n`
    ).rules!;
    const assigned = assign(
      [inRepo("one", "ZVN"), inRepo("two", "ZVN"), inRepo("three", "ZVN"), work],
      exempted
    );
    expect(assigned.find((a) => a.path === work.path)?.project).toBe("Coding");
  });
});
