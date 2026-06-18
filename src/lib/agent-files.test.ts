import { describe, it, expect } from "vitest";
import { classifyAgentFile } from "./agent-files";

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
