import { describe, it, expect } from "vitest";
import { buildEnv, isKnownApp, resolveContext } from "./terminal.js";

describe("isKnownApp", () => {
  it("accepts detected terminal ids and names", () => {
    expect(isKnownApp("ghostty")).toBe(true);
    expect(isKnownApp("iTerm")).toBe(true);
    expect(isKnownApp("terminal")).toBe(true);
    expect(isKnownApp("Terminal")).toBe(true);
  });
  it("rejects anything else (no arbitrary app launch)", () => {
    expect(isKnownApp("Calculator")).toBe(false);
    expect(isKnownApp("")).toBe(false);
    expect(isKnownApp("../../evil")).toBe(false);
  });
});

describe("terminal Markie context", () => {
  it("resolves cwd, document path, document dir, and nearest workspace root", () => {
    const context = resolveContext(
      {
        cwd: "/Users/me/Docs/Markie/project",
        filePath: "/Users/me/Docs/Markie/project/notes/today.md",
      },
      ["/Users/me/Docs", "/Users/me/Docs/Markie"]
    );

    expect(context).toEqual({
      cwd: "/Users/me/Docs/Markie/project",
      filePath: "/Users/me/Docs/Markie/project/notes/today.md",
      dir: "/Users/me/Docs/Markie/project/notes",
      workspace: "/Users/me/Docs/Markie",
    });
  });

  it("falls back to the active document folder when no workspace root contains it", () => {
    const context = resolveContext(
      { filePath: "/tmp/loose/draft.md" },
      ["/Users/me/Docs/Markie"]
    );

    expect(context.cwd).toBe("/tmp/loose");
    expect(context.workspace).toBe("/tmp/loose");
  });

  it("injects only the active Markie document context into new shells", () => {
    const env = buildEnv(
      {
        filePath: "/Users/me/Docs/Markie/project/notes/today.md",
        dir: "/Users/me/Docs/Markie/project/notes",
        workspace: "/Users/me/Docs/Markie",
      },
      { PATH: "/usr/bin", MARKIE_FILE: "stale.md" }
    );

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      TERM: "xterm-256color",
      MARKIE_FILE: "/Users/me/Docs/Markie/project/notes/today.md",
      MARKIE_DIR: "/Users/me/Docs/Markie/project/notes",
      MARKIE_WORKSPACE: "/Users/me/Docs/Markie",
    });
  });
});
