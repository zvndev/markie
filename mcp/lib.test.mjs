import { test } from "node:test";
import assert from "node:assert/strict";
import { guardPath, matchQuery, classifyAgentFile, groupSkills } from "./lib.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";

const HOME = "/home/u";

// These "allow" cases use a REAL temp home because guardPath now canonicalizes
// via realpath (a fake /home/u would be rewritten by macOS autofs resolution).
test("guardPath allows ordinary markdown under home", () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  try {
    for (const rel of ["notes.md", "projects/app/README.md", "Desktop/Coding/x.markdown", "a/b/c.mdx"]) {
      const p = pjoin(home, rel);
      const r = guardPath(p, home);
      assert.equal(r.ok, true, `${p} should be allowed: ${r.error}`);
      assert.equal(r.path, p);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("guardPath expands ~ against home", () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  try {
    const r = guardPath("~/notes.md", home);
    assert.equal(r.ok, true);
    assert.equal(r.path, pjoin(home, "notes.md"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("guardPath allows the skill/agent allowlist roots despite the dot-dir", () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  try {
    for (const rel of [".claude/skills/kirby/SKILL.md", ".codex/AGENTS.md", ".codex/notes/todo.md"]) {
      assert.equal(guardPath(pjoin(home, rel), home).ok, true, `${rel} should be allowed`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("guardPath rejects non-markdown files", () => {
  const r = guardPath("/home/u/notes.txt", HOME);
  assert.equal(r.ok, false);
});

test("guardPath rejects paths outside home (incl. traversal)", () => {
  assert.equal(guardPath("/etc/passwd.md", HOME).ok, false);
  assert.equal(guardPath("/home/u/../etc/x.md", HOME).ok, false);
});

test("guardPath rejects excluded segments and hidden dirs", () => {
  for (const p of [
    "/home/u/proj/node_modules/x.md",
    "/home/u/app/tmp/x.md",
    "/home/u/app/temp/x.md",
    "/home/u/.config/x.md",
    "/home/u/.claude/sessions/x.md", // dot-dir, not an allowlist root
  ]) {
    assert.equal(guardPath(p, HOME).ok, false, `${p} should be rejected`);
  }
});

test("guardPath still prunes vendored dirs nested inside an allowlist root", () => {
  assert.equal(
    guardPath("/home/u/.claude/skills/k/node_modules/x.md", HOME).ok,
    false,
  );
});

test("matchQuery matches on name or path, case-insensitive; empty matches all", () => {
  const row = { name: "SKILL.md", path: "/home/u/.claude/skills/Brainstorm/SKILL.md", dir: "" };
  assert.equal(matchQuery(row, "skill"), true);
  assert.equal(matchQuery(row, "BRAINSTORM"), true);
  assert.equal(matchQuery(row, "nope"), false);
  assert.equal(matchQuery(row, ""), true);
});

test("classifyAgentFile mirrors src/lib/agent-files.ts", () => {
  assert.equal(classifyAgentFile("/x/.claude/CLAUDE.md", "CLAUDE.md"), "claude");
  assert.equal(classifyAgentFile("/x/proj/CLAUDE.md", "CLAUDE.md"), "claude");
  assert.equal(classifyAgentFile("/x/.claude/skills/k/SKILL.md", "SKILL.md"), "claude");
  assert.equal(classifyAgentFile("/x/proj/AGENTS.md", "AGENTS.md"), "openai");
  assert.equal(classifyAgentFile("/x/.codex/notes.md", "notes.md"), "openai");
  assert.equal(classifyAgentFile("/x/proj/GEMINI.md", "GEMINI.md"), "gemini");
  assert.equal(classifyAgentFile("/x/proj/.cursorrules", ".cursorrules"), "cursor");
  assert.equal(classifyAgentFile("/x/p/agents.md", "agents.md"), "openai");
  assert.equal(classifyAgentFile("/x/p/README.md", "README.md"), null);
});

test("groupSkills groups classified files by tool, in display order", () => {
  const rows = [
    { name: "README.md", path: "/x/README.md", dir: "/x" },
    { name: "AGENTS.md", path: "/x/.codex/AGENTS.md", dir: "/x/.codex" },
    { name: "CLAUDE.md", path: "/x/CLAUDE.md", dir: "/x" },
    { name: "SKILL.md", path: "/x/.claude/skills/k/SKILL.md", dir: "/x/.claude/skills/k" },
  ];
  const groups = groupSkills(rows);
  // README is not an agent file → excluded; empty groups dropped
  const ids = groups.map((g) => g.id);
  assert.deepEqual(ids, ["claude", "openai"]);
  assert.equal(groups[0].files.length, 2); // CLAUDE.md + SKILL.md
  assert.equal(groups[1].files.length, 1); // AGENTS.md
});

test("guardPath denies a .md symlink that points outside home (read escape)", () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  const outside = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-out-")));
  try {
    writeFileSync(pjoin(outside, "secret.txt"), "TOP SECRET");
    symlinkSync(pjoin(outside, "secret.txt"), pjoin(home, "link.md"));
    const r = guardPath(pjoin(home, "link.md"), home);
    assert.equal(r.ok, false, "symlink to outside-home non-md must be denied");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("guardPath denies writing through a symlinked directory (write escape)", () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  const outside = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-out-")));
  try {
    symlinkSync(outside, pjoin(home, "escape")); // dir symlink under home
    const r = guardPath(pjoin(home, "escape", "implanted.md"), home, { mode: "write" });
    assert.equal(r.ok, false, "write through a symlinked dir must be denied");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("guardPath allows an ordinary real .md under a real home", () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  try {
    mkdirSync(pjoin(home, "notes"));
    writeFileSync(pjoin(home, "notes", "a.md"), "# hi");
    const r = guardPath(pjoin(home, "notes", "a.md"), home);
    assert.equal(r.ok, true, r.error);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("guardPath write-mode denies the allowlist skill roots (no agent-file implant)", () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  try {
    mkdirSync(pjoin(home, ".claude", "skills"), { recursive: true });
    const r = guardPath(pjoin(home, ".claude", "skills", "x.md"), home, { mode: "write" });
    assert.equal(r.ok, false, "writing under ~/.claude/skills must be denied");
    // but reading is still fine
    assert.equal(guardPath(pjoin(home, ".claude", "skills", "x.md"), home).ok, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
