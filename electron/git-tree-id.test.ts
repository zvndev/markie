import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { treeId } = require("./git-tree-id.js") as {
  treeId: (files: { path: string; data: Buffer; mode: number }[]) => string;
};

// The only assertion worth making about this module is that git agrees, so the
// test builds a real repository and asks it. Every name below is chosen to make
// git's sort rule visible: `a-b` and `a.md` are files, `a` is a directory, and
// a plain byte sort would put the directory first. Git compares it as "a/",
// which lands it between "a-b" and "a.md".
const TREE: Record<string, { body: string; mode: number }> = {
  "skills/.curated/deep-dive/SKILL.md": {
    body: "---\nname: deep-dive\ndescription: A curated skill.\n---\n\n# Deep dive\n",
    mode: 0o644,
  },
  "skills/.curated/deep-dive/a-b": { body: "a-b sorts before the directory a\n", mode: 0o644 },
  "skills/.curated/deep-dive/a.md": { body: "a.md sorts after it\n", mode: 0o644 },
  "skills/.curated/deep-dive/a/inside.md": { body: "inside the directory a\n", mode: 0o644 },
  "skills/.curated/deep-dive/a/deeper/still.md": { body: "two levels down\n", mode: 0o644 },
  "skills/.curated/deep-dive/scripts/run.sh": { body: "#!/bin/sh\necho hi\n", mode: 0o755 },
  "skills/pdf/SKILL.md": {
    body: "---\nname: pdf\ndescription: Work with PDF files.\n---\n\n# PDF\n",
    mode: 0o644,
  },
  "skills/pdf/reference.md": { body: "# Reference\n", mode: 0o644 },
  "skills/pdf/scripts/extract.py": { body: "print('pdf')\n", mode: 0o755 },
  "skills/pdf/scripts/lib/helper.py": { body: "HELPER = 1\n", mode: 0o644 },
  "README.md": { body: "# kit\n", mode: 0o644 },
};

function filesUnder(folder: string) {
  const prefix = `${folder}/`;
  return Object.entries(TREE)
    .filter(([p]) => p.startsWith(prefix))
    .map(([p, entry]) => ({
      path: p.slice(prefix.length),
      data: Buffer.from(entry.body, "utf8"),
      mode: entry.mode,
    }));
}

describe("git tree id", () => {
  let repo = "";
  const gitId = (ref: string) =>
    execFileSync("git", ["rev-parse", ref], { cwd: repo, encoding: "utf8" }).trim();

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "markie-tree-"));
    for (const [rel, entry] of Object.entries(TREE)) {
      const full = path.join(repo, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, entry.body, "utf8");
      fs.chmodSync(full, entry.mode);
    }
    // An identity and an empty config, so this works on a machine that has
    // never configured git (a fresh CI runner, most obviously).
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Markie Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Markie Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      GIT_CONFIG_GLOBAL: path.join(repo, "nonexistent-gitconfig"),
      GIT_CONFIG_SYSTEM: path.join(repo, "nonexistent-gitconfig"),
    };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: "pipe" });
    git("init", "--quiet", "--initial-branch=main");
    git("add", "--all");
    git("commit", "--quiet", "--message", "fixture");
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("matches git for a skill folder with nested subfolders and an executable script", () => {
    expect(treeId(filesUnder("skills/pdf"))).toBe(gitId("HEAD:skills/pdf"));
  });

  it("matches git for a folder inside skills/.curated", () => {
    expect(treeId(filesUnder("skills/.curated/deep-dive"))).toBe(
      gitId("HEAD:skills/.curated/deep-dive")
    );
  });

  it("matches git for the containers above a skill, and for the repository root", () => {
    for (const folder of ["skills", "skills/.curated", "skills/pdf/scripts"]) {
      expect(treeId(filesUnder(folder)), folder).toBe(gitId(`HEAD:${folder}`));
    }
    const root = Object.entries(TREE).map(([p, entry]) => ({
      path: p,
      data: Buffer.from(entry.body, "utf8"),
      mode: entry.mode,
    }));
    expect(treeId(root)).toBe(gitId("HEAD^{tree}"));
  });

  it("sorts a directory as though its name ended in a slash, the way git does", () => {
    // The proof is the folder holding `a-b`, `a.md` and the directory `a`: a
    // plain byte sort of the names puts `a` first and gets a different id.
    const files = filesUnder("skills/.curated/deep-dive");
    expect(files.map((f) => f.path)).toContain("a/inside.md");
    expect(treeId(files)).toBe(gitId("HEAD:skills/.curated/deep-dive"));
    expect(treeId([...files].reverse())).toBe(treeId(files));
  });

  it("gives the executable bit its own mode, so chmod alone changes the id", () => {
    const files = filesUnder("skills/pdf");
    const plain = files.map((f) =>
      f.path === "scripts/extract.py" ? { ...f, mode: 0o644 } : f
    );
    expect(treeId(plain)).not.toBe(treeId(files));
  });

  it("answers git's empty tree for a folder with nothing in it", () => {
    expect(treeId([])).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });
});
