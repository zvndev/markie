import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLUSTERING,
  DEFAULT_DUMPING_GROUNDS,
  applyRules,
  compileGlob,
  parseRules,
} from "@/lib/projects/rules";

const HOME = "/home/u";

const DOC = `---
markie_rules:
  version: 1
  clustering:
    gap_hours: 12
  rules:
    - match: "~/code/**"
      project: "{repo}"
    - match: "~/notes/**"
      project: Notes
      block: "{folder}"
  ignore:
    - "~/scratch/**"
---
# Projects
`;

describe("parseRules", () => {
  it("parses rules, tunables, and ignore globs", () => {
    const { rules, error } = parseRules(DOC);
    expect(error).toBeNull();
    expect(rules?.clustering.gapHours).toBe(12);
    expect(rules?.clustering.minFiles).toBe(DEFAULT_CLUSTERING.minFiles);
    expect(rules?.clustering.bulkMinFiles).toBe(DEFAULT_CLUSTERING.bulkMinFiles);
    expect(rules?.clustering.bulkWindowMinutes).toBe(DEFAULT_CLUSTERING.bulkWindowMinutes);
    expect(rules?.rules).toHaveLength(2);
    expect(rules?.rules[1]).toEqual({ match: "~/notes/**", project: "Notes", block: "{folder}" });
    expect(rules?.ignore).toEqual(["~/scratch/**"]);
  });

  it("reports malformed YAML as an error with no rules", () => {
    const { rules, error } = parseRules("---\nmarkie_rules: [unclosed\n---\n");
    expect(rules).toBeNull();
    expect(error).toMatch(/./); // a human-readable parse message
  });

  it("treats a document without markie_rules as empty rules, not an error", () => {
    const { rules, error } = parseRules("---\ntitle: x\n---\nbody");
    expect(error).toBeNull();
    expect(rules?.rules).toEqual([]);
  });

  it("treats a document with no front matter at all as empty rules", () => {
    const { rules, error } = parseRules("");
    expect(error).toBeNull();
    expect(rules?.clustering).toEqual(DEFAULT_CLUSTERING);
  });

  it("rejects rules missing match or project", () => {
    const bad = `---\nmarkie_rules:\n  rules:\n    - project: NoMatch\n---\n`;
    expect(parseRules(bad).rules).toBeNull();
    expect(parseRules(bad).error).toMatch(/match/);
    const noProject = `---\nmarkie_rules:\n  rules:\n    - match: "~/x/**"\n---\n`;
    expect(parseRules(noProject).error).toMatch(/project/);
  });

  it("rejects the wrong shape for markie_rules, rules, and ignore", () => {
    expect(parseRules("---\nmarkie_rules: nope\n---\n").error).toMatch(/mapping/);
    expect(parseRules("---\nmarkie_rules:\n  rules: nope\n---\n").error).toMatch(/list/);
    expect(parseRules("---\nmarkie_rules:\n  ignore: nope\n---\n").error).toMatch(/list/);
  });

  it("ignores tunables that are not positive numbers", () => {
    const doc = `---
markie_rules:
  clustering:
    gap_hours: 0
    min_files: "many"
    max_blocks_per_project: -3
---
`;
    expect(parseRules(doc).rules?.clustering).toEqual(DEFAULT_CLUSTERING);
  });

  it("accepts empty rules and ignore keys written out longhand", () => {
    const doc = `---\nmarkie_rules:\n  rules: []\n  ignore: []\n---\n`;
    const { rules, error } = parseRules(doc);
    expect(error).toBeNull();
    expect(rules?.rules).toEqual([]);
  });
});

describe("compileGlob", () => {
  it("expands ~, * within a segment, ** across segments", () => {
    const re = compileGlob("~/code/**", HOME);
    expect(re.test("/home/u/code/a/b/c.md")).toBe(true);
    expect(re.test("/home/u/notes/a.md")).toBe(false);
    const one = compileGlob("~/notes/*.md", HOME);
    expect(one.test("/home/u/notes/a.md")).toBe(true);
    expect(one.test("/home/u/notes/deep/a.md")).toBe(false);
  });

  it("matches the directory itself through **, not only what is under it", () => {
    expect(compileGlob("~/code/**", HOME).test("/home/u/code/a.md")).toBe(true);
  });

  it("escapes regex metacharacters in literals", () => {
    const re = compileGlob("~/we(ird)+/**", HOME);
    expect(re.test("/home/u/we(ird)+/x.md")).toBe(true);
    expect(re.test("/home/u/weirdd/x.md")).toBe(false);
  });

  it("does not let a question mark in a folder name become a quantifier", () => {
    const re = compileGlob("~/Q&A?/**", HOME);
    expect(re.test("/home/u/Q&A?/x.md")).toBe(true);
    expect(re.test("/home/u/Q&A/x.md")).toBe(false);
  });

  it("expands a bare ~ and leaves absolute patterns alone", () => {
    expect(compileGlob("~", HOME).test("/home/u")).toBe(true);
    expect(compileGlob("/opt/docs/**", HOME).test("/opt/docs/a.md")).toBe(true);
  });
});

describe("applyRules", () => {
  const parsed = parseRules(DOC).rules!;

  it("first match wins, with substitutions", () => {
    expect(
      applyRules(
        parsed,
        { path: "/home/u/code/myrepo/docs/a.md", dir: "/home/u/code/myrepo/docs", repoName: "myrepo" },
        HOME
      )
    ).toEqual({ project: "myrepo", block: null });
    expect(
      applyRules(
        parsed,
        { path: "/home/u/notes/ideas/a.md", dir: "/home/u/notes/ideas", repoName: null },
        HOME
      )
    ).toEqual({ project: "Notes", block: "ideas" });
  });

  it("a {repo} rule without a repo does not match (falls through)", () => {
    expect(
      applyRules(parsed, { path: "/home/u/code/loose.md", dir: "/home/u/code", repoName: null }, HOME)
    ).toBeNull();
  });

  it("ignore wins over everything", () => {
    expect(
      applyRules(parsed, { path: "/home/u/scratch/x.md", dir: "/home/u/scratch", repoName: null }, HOME)
    ).toEqual({ ignored: true });
  });

  it("returns null when nothing matches", () => {
    expect(
      applyRules(parsed, { path: "/home/u/elsewhere/x.md", dir: "/home/u/elsewhere", repoName: "r" }, HOME)
    ).toBeNull();
  });

  it("matches Windows-shaped paths by normalizing separators", () => {
    const rules = parseRules(`---\nmarkie_rules:\n  rules:\n    - match: "~/code/**"\n      project: Win\n---\n`).rules!;
    expect(
      applyRules(
        rules,
        { path: "C:\\Users\\u\\code\\a.md", dir: "C:\\Users\\u\\code", repoName: null },
        "C:\\Users\\u"
      )
    ).toEqual({ project: "Win", block: null });
  });

  it("keeps the project when a {folder} block has nothing to substitute", () => {
    const rules = parseRules(
      `---\nmarkie_rules:\n  rules:\n    - match: "/**"\n      project: Root\n      block: "{folder}"\n---\n`
    ).rules!;
    expect(applyRules(rules, { path: "/a.md", dir: "/", repoName: null }, HOME)).toEqual({
      project: "Root",
      block: null,
    });
  });
});

describe("dumping grounds and containers", () => {
  const at = (path: string) => ({ path, dir: path.slice(0, path.lastIndexOf("/")), repoName: null });

  it("ships defaults when the document never mentions dumping grounds", () => {
    const rules = parseRules("").rules!;
    expect(rules.dumpingGrounds).toEqual(DEFAULT_DUMPING_GROUNDS);
    // ~/Downloads is an inbox: an unzipped handoff bundle there is something
    // somebody sent, not a project this person started.
    expect(applyRules(rules, at("/home/u/Downloads/bundle/00-START.md"), HOME)).toEqual({
      ignored: true,
    });
    // A hidden directory under home is an agent's or an application's state.
    expect(applyRules(rules, at("/home/u/.codex/plugins/readme.md"), HOME)).toEqual({
      ignored: true,
    });
  });

  it("leaves ordinary work alone", () => {
    const rules = parseRules("").rules!;
    expect(applyRules(rules, at("/home/u/Desktop/Coding/proj/a.md"), HOME)).toBeNull();
    // A hidden FILE in home is a file, not a dumping ground.
    expect(applyRules(rules, at("/home/u/.notes.md"), HOME)).toBeNull();
    // A dot directory INSIDE a project belongs to that project.
    expect(applyRules(rules, at("/home/u/Desktop/proj/.claude/skills/s.md"), HOME)).toBeNull();
  });

  it("an explicit list is the user's answer and replaces the defaults", () => {
    const rules = parseRules(
      `---\nmarkie_rules:\n  dumping_grounds:\n    - "~/Inbox/**"\n---\n`
    ).rules!;
    expect(applyRules(rules, at("/home/u/Downloads/bundle/x.md"), HOME)).toBeNull();
    expect(applyRules(rules, at("/home/u/Inbox/x.md"), HOME)).toEqual({ ignored: true });
  });

  it("an empty list means ignore nothing, not fall back to the defaults", () => {
    const rules = parseRules(`---\nmarkie_rules:\n  dumping_grounds: []\n---\n`).rules!;
    expect(rules.dumpingGrounds).toEqual([]);
    expect(applyRules(rules, at("/home/u/Downloads/bundle/x.md"), HOME)).toBeNull();
  });

  it("reads the container lists, defaulting both to empty", () => {
    const rules = parseRules(
      `---\nmarkie_rules:\n  containers:\n    - "~/work"\n  not_containers:\n    - "~/work/solo"\n---\n`
    ).rules!;
    expect(rules.containers).toEqual(["~/work"]);
    expect(rules.notContainers).toEqual(["~/work/solo"]);
    expect(parseRules("").rules!.containers).toEqual([]);
    expect(parseRules("").rules!.notContainers).toEqual([]);
  });

  it("rejects a container list that is not a list", () => {
    expect(parseRules(`---\nmarkie_rules:\n  containers: "~/work"\n---\n`)).toEqual({
      rules: null,
      error: "containers must be a list",
    });
  });
});

describe("auto folder rules", () => {
  const folders = (yaml: string) =>
    parseRules(["---", "markie_rules:", "  folders:", yaml, "---"].join("\n"));
  const DAY = 24 * 3600_000;

  it("reads a window, a path, or both", () => {
    const { rules, error } = folders(
      [
        "    - name: This month",
        "      within: 30d",
        "    - name: Specs",
        '      match: "**/specs/**"',
        "    - name: Fresh specs",
        "      within: 14d",
        '      match: "**/specs/**"',
      ].join("\n")
    );
    expect(error).toBeNull();
    expect(rules!.folders).toEqual([
      { name: "This month", withinMs: 30 * DAY, match: null },
      { name: "Specs", withinMs: null, match: "**/specs/**" },
      { name: "Fresh specs", withinMs: 14 * DAY, match: "**/specs/**" },
    ]);
  });

  it("takes hours, days and weeks, and reads a bare number as days", () => {
    // `within: 7` is what a person types first, and refusing it teaches
    // nothing that accepting it does not.
    const units = folders(
      [
        "    - name: H",
        "      within: 12h",
        "    - name: D",
        "      within: 3d",
        "    - name: W",
        "      within: 2w",
        "    - name: Bare",
        "      within: 7",
      ].join("\n")
    ).rules!.folders;
    expect(units.map((f) => f.withinMs)).toEqual([
      12 * 3600_000,
      3 * DAY,
      14 * DAY,
      7 * DAY,
    ]);
  });

  it("ships with no folders of its own, so the three built-ins stand alone", () => {
    expect(parseRules("").rules!.folders).toEqual([]);
    expect(parseRules("---\nmarkie_rules:\n  rules: []\n---").rules!.folders).toEqual([]);
  });

  it("names the folder in the error, because that is what the user has to find", () => {
    expect(folders("    - within: 3d").error).toMatch(/folder 1 needs a name/);
    expect(folders("    - name: Nameless\n      within: 3 fortnights").error).toMatch(
      /folder "Nameless" has a within Markie cannot read/
    );
    expect(folders("    - name: Empty").error).toMatch(/folder "Empty" needs a within or a match/);
    expect(
      parseRules("---\nmarkie_rules:\n  folders: not-a-list\n---").error
    ).toMatch(/folders must be a list/);
  });

  it("a bad folder never takes the rest of the document down with it", () => {
    // The caller pairs a parse error with the last known-good rules, so the
    // view never empties. What must not happen is a half-parsed answer.
    const { rules, error } = folders("    - name: Broken\n      within: soon");
    expect(rules).toBeNull();
    expect(error).toBeTruthy();
  });
});
