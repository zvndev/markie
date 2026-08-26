import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLUSTERING,
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
