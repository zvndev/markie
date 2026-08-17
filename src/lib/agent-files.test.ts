import { describe, it, expect } from "vitest";
import {
  agentFileKind,
  agentFileLabel,
  classifyAgentFile,
  collapseSkills,
  isCachedAgentPath,
  skillRootOf,
} from "./agent-files";

describe("classifyAgentFile", () => {
  const home = "/Users/x";
  it("classifies Claude files", () => {
    expect(classifyAgentFile(`${home}/.claude/CLAUDE.md`, "CLAUDE.md")).toBe("claude");
    expect(classifyAgentFile(`${home}/proj/CLAUDE.md`, "CLAUDE.md")).toBe("claude");
    expect(classifyAgentFile(`${home}/.claude/skills/kirby/SKILL.md`, "SKILL.md")).toBe("claude");
  });
  it("classifies OpenAI/Codex files", () => {
    expect(classifyAgentFile(`${home}/proj/AGENTS.md`, "AGENTS.md")).toBe("openai");
    expect(classifyAgentFile(`${home}/.codex/notes.md`, "notes.md")).toBe("openai");
  });
  it("classifies Gemini files", () => {
    expect(classifyAgentFile(`${home}/proj/GEMINI.md`, "GEMINI.md")).toBe("gemini");
  });
  it("classifies Cursor files", () => {
    expect(classifyAgentFile(`${home}/proj/.cursorrules`, ".cursorrules")).toBe("cursor");
  });
  it("is case-insensitive", () => {
    expect(classifyAgentFile(`${home}/p/agents.md`, "agents.md")).toBe("openai");
  });
  it("returns null for ordinary markdown", () => {
    expect(classifyAgentFile(`${home}/p/README.md`, "README.md")).toBe(null);
    expect(classifyAgentFile(`${home}/p/notes/todo.md`, "todo.md")).toBe(null);
  });
});

describe("keeping cached copies out", () => {
  const home = "/Users/x";

  // ~/.claude/plugins/cache is cloned plugin repositories. On a real machine
  // it was 1,110 of 3,782 markdown files, so the panel was mostly other
  // people's READMEs with the user's own skills lost among them.
  it("rejects everything under the plugin cache", () => {
    expect(
      classifyAgentFile(
        `${home}/.claude/plugins/cache/some-plugin/6.2.0/skills/x/SKILL.md`,
        "SKILL.md"
      )
    ).toBe(null);
  });

  it("rejects marketplace clones", () => {
    expect(
      classifyAgentFile(`${home}/.claude/plugins/marketplaces/repo/CLAUDE.md`, "CLAUDE.md")
    ).toBe(null);
  });

  it("rejects vendored and version-control copies", () => {
    expect(isCachedAgentPath(`${home}/p/node_modules/lib/CLAUDE.md`)).toBe(true);
    expect(isCachedAgentPath(`${home}/p/.git/x.md`)).toBe(true);
    expect(isCachedAgentPath(`${home}/.claude/.removed-skills/old/SKILL.md`)).toBe(true);
  });

  // The point is to remove noise, not to remove the user's own work.
  it("keeps the files actually written on this machine", () => {
    expect(isCachedAgentPath(`${home}/.claude/skills/smoke-audit/SKILL.md`)).toBe(false);
    expect(classifyAgentFile(`${home}/.claude/skills/smoke-audit/SKILL.md`, "SKILL.md")).toBe(
      "claude"
    );
    expect(classifyAgentFile(`${home}/.claude/CLAUDE.md`, "CLAUDE.md")).toBe("claude");
    expect(classifyAgentFile(`${home}/proj/CLAUDE.md`, "CLAUDE.md")).toBe("claude");
  });

  it("does not care how the path is spelled", () => {
    expect(isCachedAgentPath("C:\\Users\\x\\.claude\\plugins\\cache\\a\\b.md")).toBe(true);
    expect(isCachedAgentPath(`${home}/.claude/Plugins/Cache/a.md`)).toBe(true);
  });
});

describe("what an agent file is for", () => {
  const home = "/Users/x";

  it("separates the kinds that share a folder tree", () => {
    expect(agentFileKind(`${home}/.claude/skills/implement/SKILL.md`, "SKILL.md")).toBe("skill");
    expect(agentFileKind(`${home}/.claude/agents/product-designer.md`, "product-designer.md")).toBe("agent");
    expect(agentFileKind(`${home}/.codex/prompts/api-reviewer.md`, "api-reviewer.md")).toBe("command");
    expect(agentFileKind(`${home}/.claude/agent-memory/x/note.md`, "note.md")).toBe("memory");
    expect(agentFileKind(`${home}/.claude/projects/-proj/MEMORY.md`, "MEMORY.md")).toBe("memory");
  });

  it("treats the top-level instruction files as one kind wherever they live", () => {
    expect(agentFileKind(`${home}/.claude/CLAUDE.md`, "CLAUDE.md")).toBe("instructions");
    expect(agentFileKind(`${home}/proj/AGENTS.md`, "AGENTS.md")).toBe("instructions");
    expect(agentFileKind(`${home}/proj/GEMINI.md`, "GEMINI.md")).toBe("instructions");
  });

  // A repo's CLAUDE.md sitting inside a skills/ directory is still the
  // instruction file, not a skill.
  it("prefers the filename over the folder it happens to sit in", () => {
    expect(agentFileKind(`${home}/x/skills/CLAUDE.md`, "CLAUDE.md")).toBe("instructions");
  });

  it("falls back rather than guessing", () => {
    expect(agentFileKind(`${home}/.codex/instruction-fork/REVIEW.md`, "REVIEW.md")).toBe("other");
  });
});

describe("what a row is called", () => {
  // Every skill is <name>/SKILL.md, so a list of them all read "SKILL.md".
  it("names a skill by its folder", () => {
    expect(agentFileLabel("/Users/x/.claude/skills/smoke-audit/SKILL.md", "SKILL.md")).toBe(
      "smoke-audit/SKILL.md"
    );
    expect(agentFileLabel("/Users/x/.codex/instruction-fork/README.md", "README.md")).toBe(
      "instruction-fork/README.md"
    );
  });

  it("leaves a distinctive name alone", () => {
    expect(agentFileLabel("/Users/x/.claude/CLAUDE.md", "CLAUDE.md")).toBe("CLAUDE.md");
    expect(agentFileLabel("/Users/x/.claude/agents/designer.md", "designer.md")).toBe("designer.md");
  });
});

describe("a skill is a folder, not a file", () => {
  const rows = (paths: string[]) =>
    paths.map((p) => ({ path: p, name: p.split("/").pop()! }));

  it("finds the skill a file belongs to", () => {
    expect(skillRootOf("/Users/x/.codex/skills/vercel/references/hooks.md")).toBe(
      "/Users/x/.codex/skills/vercel"
    );
    expect(skillRootOf("/Users/x/.claude/skills/implement/SKILL.md")).toBe(
      "/Users/x/.claude/skills/implement"
    );
  });

  it("does not claim a file that merely sits in skills/", () => {
    expect(skillRootOf("/Users/x/.claude/skills/README.md")).toBe(null);
    expect(skillRootOf("/Users/x/proj/notes.md")).toBe(null);
  });

  // The complaint: one skill produced 67 rows.
  it("turns a skill folder into one row", () => {
    const collapsed = collapseSkills(
      rows([
        "/Users/x/.codex/skills/vercel/SKILL.md",
        "/Users/x/.codex/skills/vercel/references/a.md",
        "/Users/x/.codex/skills/vercel/references/b.md",
        "/Users/x/.codex/skills/vercel/docs/c.md",
      ])
    );
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].label).toBe("vercel");
    expect(collapsed[0].contains).toBe(4);
    expect(collapsed[0].file.name).toBe("SKILL.md");
  });

  it("keeps separate skills separate", () => {
    const collapsed = collapseSkills(
      rows([
        "/Users/x/.claude/skills/implement/SKILL.md",
        "/Users/x/.claude/skills/audit/SKILL.md",
      ])
    );
    expect(collapsed.map((c) => c.label)).toEqual(["audit", "implement"]);
  });

  it("opens the shallowest file when a skill has no SKILL.md", () => {
    const collapsed = collapseSkills(
      rows([
        "/Users/x/.claude/skills/odd/deep/nested/z.md",
        "/Users/x/.claude/skills/odd/README.md",
      ])
    );
    expect(collapsed[0].file.name).toBe("README.md");
  });

  it("passes through files that belong to no skill", () => {
    const collapsed = collapseSkills(rows(["/Users/x/.claude/CLAUDE.md"]));
    expect(collapsed).toEqual([
      { file: { path: "/Users/x/.claude/CLAUDE.md", name: "CLAUDE.md" }, label: "CLAUDE.md", contains: 1 },
    ]);
  });
});

describe("keeping temporary plugin trees out", () => {
  it("rejects the codex temp and vendor trees", () => {
    expect(isCachedAgentPath("/Users/x/.codex/.tmp/plugins/a/skills/b/SKILL.md")).toBe(true);
    expect(isCachedAgentPath("/Users/x/.codex/vendor_imports/skills/a/SKILL.md")).toBe(true);
    expect(isCachedAgentPath("/Users/x/.codex/.tmp/bundled-marketplaces/a.md")).toBe(true);
  });

  it("still keeps the real codex skills", () => {
    expect(isCachedAgentPath("/Users/x/.codex/skills/speech/SKILL.md")).toBe(false);
  });
});
