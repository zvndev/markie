import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { isExcludedDir, shouldDescend, walk } from "./mdindex.js";

describe("isExcludedDir", () => {
  it("excludes any dot-directory", () => {
    for (const n of [".git", ".next", ".venv", ".bun", ".cargo", ".scion", ".design", ".claude"])
      expect(isExcludedDir(n)).toBe(true);
  });
  it("excludes named vendored/build dirs", () => {
    for (const n of ["node_modules", "Library", "vendor", "bower_components", "dist", "build", "out", "target", "Pods", "venv", "site-packages", "DerivedData"])
      expect(isExcludedDir(n)).toBe(true);
  });
  it("excludes tmp and temp dirs", () => {
    for (const n of ["tmp", "temp"]) expect(isExcludedDir(n)).toBe(true);
  });
  it("keeps normal directories", () => {
    for (const n of ["Documents", "Coding", "skills", "docs", "notes", "src"])
      expect(isExcludedDir(n)).toBe(false);
  });
});

describe("shouldDescend", () => {
  const home = os.homedir();
  it("descends normal dirs", () => {
    expect(shouldDescend(path.join(home, "Documents"), "Documents", home)).toBe(true);
  });
  it("prunes excluded dirs", () => {
    expect(shouldDescend(path.join(home, "p", "node_modules"), "node_modules", home)).toBe(false);
    expect(shouldDescend(path.join(home, ".git"), ".git", home)).toBe(false);
  });
  it("prunes go/pkg specifically", () => {
    expect(shouldDescend(path.join(home, "go", "pkg"), "pkg", home)).toBe(false);
  });
  it("re-includes ~/.claude/skills and its path", () => {
    expect(shouldDescend(path.join(home, ".claude"), ".claude", home)).toBe(true);
    expect(shouldDescend(path.join(home, ".claude", "skills"), "skills", home)).toBe(true);
    expect(shouldDescend(path.join(home, ".claude", "skills", "kirby"), "kirby", home)).toBe(true);
  });
  it("still prunes other .claude subdirs", () => {
    expect(shouldDescend(path.join(home, ".claude", "sessions"), "sessions", home)).toBe(false);
    expect(shouldDescend(path.join(home, ".claude", "plugins"), "plugins", home)).toBe(false);
  });
  it("re-includes ~/.codex (OpenAI Codex agent files)", () => {
    expect(shouldDescend(path.join(home, ".codex"), ".codex", home)).toBe(true);
    expect(shouldDescend(path.join(home, ".codex", "sub"), "sub", home)).toBe(true);
  });
  it("still prunes node_modules and nested dot-dirs INSIDE an allowlisted root", () => {
    // allowlisting ~/.codex must not drag in its node_modules / nested .git
    expect(shouldDescend(path.join(home, ".codex", "node_modules"), "node_modules", home)).toBe(false);
    expect(shouldDescend(path.join(home, ".codex", ".git"), ".git", home)).toBe(false);
    expect(shouldDescend(path.join(home, ".claude", "skills", "node_modules"), "node_modules", home)).toBe(false);
  });
});

describe("walk", () => {
  it("finds .md, skips excluded dirs, descends allowlisted", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mdwalk-"));
    const mk = (p: string, body = "x") => {
      fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
      fs.writeFileSync(path.join(root, p), body);
    };
    mk("a.md");
    mk("notes/b.md");
    mk("notes/readme.txt");
    mk("node_modules/pkg/c.md");
    mk(".git/d.md");
    mk(".claude/sessions/e.md");
    mk(".claude/skills/kirby/skill.md");

    const rows = await walk(root, { home: root });
    const rel = rows.map((r) => r.path.slice(root.length + 1)).sort();
    expect(rel).toEqual([".claude/skills/kirby/skill.md", "a.md", "notes/b.md"].sort());
    const a = rows.find((r) => r.name === "a.md")!;
    expect(a.dir).toBe(root);
    expect(typeof a.mtimeMs).toBe("number");
  });
});
