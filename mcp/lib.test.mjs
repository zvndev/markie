import { test } from "node:test";
import assert from "node:assert/strict";
import { guardPath, matchQuery, classifyAgentFile, groupSkills } from "./lib.mjs";

const HOME = "/home/u";

test("guardPath allows ordinary markdown under home", () => {
  for (const p of [
    "/home/u/notes.md",
    "/home/u/projects/app/README.md",
    "/home/u/Desktop/Coding/x.markdown",
    "/home/u/a/b/c.mdx",
  ]) {
    const r = guardPath(p, HOME);
    assert.equal(r.ok, true, `${p} should be allowed: ${r.error}`);
    assert.equal(r.path, p);
  }
});

test("guardPath expands ~ against home", () => {
  const r = guardPath("~/notes.md", HOME);
  assert.equal(r.ok, true);
  assert.equal(r.path, "/home/u/notes.md");
});

test("guardPath allows the skill/agent allowlist roots despite the dot-dir", () => {
  for (const p of [
    "/home/u/.claude/skills/kirby/SKILL.md",
    "/home/u/.codex/AGENTS.md",
    "/home/u/.codex/notes/todo.md",
  ]) {
    assert.equal(guardPath(p, HOME).ok, true, `${p} should be allowed`);
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
