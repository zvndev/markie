import { describe, expect, it } from "vitest";
import { canonicalFolder, skillGroupFor } from "@/lib/skills-panel";

describe("which tool a file belongs to", () => {
  it("reads the four folders the panel already knew", () => {
    expect(skillGroupFor("/home/me/.claude/skills/pdf/SKILL.md", "SKILL.md")).toBe("claude");
    expect(skillGroupFor("/home/me/.codex/skills/pdf/SKILL.md", "SKILL.md")).toBe("codex");
    expect(skillGroupFor("/home/me/.cursor/rules/house.md", "house.md")).toBe("cursor");
    expect(skillGroupFor("/home/me/work/GEMINI.md", "GEMINI.md")).toBe("gemini");
  });

  it("reads the three skill folders classifyAgentFile predates", () => {
    expect(skillGroupFor("/home/me/.cursor/skills/pdf/SKILL.md", "SKILL.md")).toBe("cursor");
    expect(skillGroupFor("/home/me/.gemini/skills/pdf/SKILL.md", "SKILL.md")).toBe("gemini");
    expect(skillGroupFor("/home/me/.agents/skills/pdf/SKILL.md", "SKILL.md")).toBe("universal");
  });

  it("calls Codex Codex, not OpenAI", () => {
    expect(skillGroupFor("/home/me/work/AGENTS.md", "AGENTS.md")).toBe("codex");
  });

  it("still drops a cached copy of someone else's repository", () => {
    expect(
      skillGroupFor("/home/me/.claude/plugins/cache/x/.agents/skills/pdf/SKILL.md", "SKILL.md")
    ).toBeNull();
  });

  it("classifies a Windows path the way it classifies a POSIX one", () => {
    expect(skillGroupFor("C:\\Users\\me\\.agents\\skills\\pdf\\SKILL.md", "SKILL.md")).toBe(
      "universal"
    );
  });

  it("says nothing about a file that is not an agent file", () => {
    expect(skillGroupFor("/home/me/notes/today.md", "today.md")).toBeNull();
  });

  it("takes the tool main decided from its roots, where the path says nothing", () => {
    // CODEX_HOME moved to ~/.config/codex: there is no /.codex/ to read.
    const path = "/home/me/.config/codex/skills/x/SKILL.md";
    expect(skillGroupFor(path, "SKILL.md", { tool: "codex", description: "Does x" })).toBe("codex");
    // Pinned so the fallback stays visible: a row without the field is
    // classified by its path, and this path classifies as nothing.
    expect(skillGroupFor(path, "SKILL.md")).toBeNull();
  });

  it("keeps a project skill under Claude when main calls it no tool's", () => {
    expect(
      skillGroupFor("/home/me/work/app/.claude/skills/x/SKILL.md", "SKILL.md", {
        tool: null,
        description: null,
      })
    ).toBe("claude");
  });
});

describe("one key per folder", () => {
  it("folds separators and trailing slashes on every platform", () => {
    expect(canonicalFolder("/Users/me/.claude/skills/pdf/", "darwin")).toBe(
      "/Users/me/.claude/skills/pdf"
    );
  });

  it("folds case on Windows, where the registry stores paths lower and the index does not", () => {
    expect(canonicalFolder("C:\\Users\\Me\\.claude\\skills\\pdf", "win32")).toBe(
      canonicalFolder("c:/users/me/.claude/skills/pdf", "win32")
    );
  });

  it("keeps case everywhere else, where two spellings are two folders", () => {
    expect(canonicalFolder("/Users/me/.claude/skills/PDF", "darwin")).not.toBe(
      canonicalFolder("/Users/me/.claude/skills/pdf", "darwin")
    );
  });
});

describe("skillGroupFor and a tool's cache", () => {
  it("keeps a clone under a tool's cache out, whatever main labelled it", () => {
    // A vendored or plugin-cached clone sits inside ~/.codex, so main says
    // "codex"; it is a cache, not an install.
    const cached = "/home/me/.codex/plugins/cache/some-plugin/1.0.0/skills/pdf/SKILL.md";
    expect(skillGroupFor(cached, "SKILL.md", { tool: "codex", description: null })).toBeNull();
    expect(skillGroupFor("/home/me/.codex/skills/pdf/SKILL.md", "SKILL.md", { tool: "codex", description: null })).toBe(
      "codex"
    );
  });
});
