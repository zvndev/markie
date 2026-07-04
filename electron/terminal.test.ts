import { describe, it, expect } from "vitest";
import {
  buildEnv,
  commandExists,
  externalApps,
  isKnownApp,
  openExternal,
  resolveContext,
  resolveShell,
  terminalLabel,
} from "./terminal.js";

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

  it("uses the newly active document context for future shells", () => {
    const workspaceRoots = ["/Users/me/Docs/Markie"];
    const documentA = resolveContext(
      { filePath: "/Users/me/Docs/Markie/project/notes/a.md" },
      workspaceRoots
    );
    const firstShellEnv = buildEnv(documentA, { PATH: "/usr/bin" });

    const documentB = resolveContext(
      { filePath: "/Users/me/Docs/Markie/project/drafts/b.md" },
      workspaceRoots
    );
    const nextShellEnv = buildEnv(documentB, firstShellEnv);

    expect(nextShellEnv).toMatchObject({
      PATH: "/usr/bin",
      MARKIE_FILE: "/Users/me/Docs/Markie/project/drafts/b.md",
      MARKIE_DIR: "/Users/me/Docs/Markie/project/drafts",
      MARKIE_WORKSPACE: "/Users/me/Docs/Markie",
    });
  });
});

describe("resolveShell", () => {
  it("uses the user's login shell on macOS", () => {
    expect(resolveShell("darwin", { SHELL: "/bin/fish" })).toEqual({
      command: "/bin/fish",
      args: ["-l"],
    });
  });

  it("falls back to zsh on macOS when SHELL is missing", () => {
    expect(resolveShell("darwin", {})).toEqual({
      command: "/bin/zsh",
      args: ["-l"],
    });
  });

  it("uses bash as the Linux fallback instead of a macOS-only shell", () => {
    expect(resolveShell("linux", {})).toEqual({
      command: "/bin/bash",
      args: ["-l"],
    });
  });

  it("uses ComSpec on Windows without Unix login-shell args", () => {
    expect(resolveShell("win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" })).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [],
    });
  });

  it("falls back to PowerShell on Windows when ComSpec is missing", () => {
    expect(resolveShell("win32", {})).toEqual({
      command: "powershell.exe",
      args: [],
    });
  });
});

describe("external terminal launchers", () => {
  it("detects executable terminal commands on PATH", () => {
    expect(
      commandExists("wt.exe", {
        platform: "win32",
        env: { PATH: "C:\\Tools", PATHEXT: ".EXE;.CMD" },
        existsSync: (p: string) => p.endsWith("wt.exe"),
      })
    ).toBe(true);

    expect(
      commandExists("gnome-terminal", {
        platform: "linux",
        env: { PATH: "/usr/local/bin:/usr/bin" },
        existsSync: (p: string) => p === "/usr/bin/gnome-terminal",
      })
    ).toBe(true);
  });

  it("returns safe Windows terminal choices instead of macOS-only emptiness", () => {
    const apps = externalApps({
      platform: "win32",
      env: { PATH: "C:\\Tools", PATHEXT: ".EXE;.CMD" },
      existsSync: (p: string) => p.endsWith("wt.exe"),
    });

    expect(apps).toEqual([
      { id: "windows-terminal", name: "Windows Terminal" },
      { id: "powershell", name: "PowerShell" },
      { id: "cmd", name: "Command Prompt" },
    ]);
  });

  it("returns Linux terminal choices from TERMINAL and common detected emulators", () => {
    const apps = externalApps({
      platform: "linux",
      env: { TERMINAL: "alacritty", PATH: "/usr/bin" },
      existsSync: (p: string) => p === "/usr/bin/alacritty" || p === "/usr/bin/konsole",
    });

    expect(apps).toEqual([
      { id: "env-terminal", name: "alacritty" },
      { id: "konsole", name: "Konsole" },
    ]);
  });

  it("launches PowerShell in the requested folder without using a shell string", () => {
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const result = openExternal("PowerShell", "C:\\Users\\me\\Documents\\Markie", {
      platform: "win32",
      existsSync: (p: string) => p === "C:\\Users\\me\\Documents\\Markie",
      home: "C:\\Users\\me",
      spawnFn: (command: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ command, args, options });
        return { unref() {} };
      },
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        command: "powershell.exe",
        args: ["-NoExit", "-Command", "Set-Location -LiteralPath 'C:\\Users\\me\\Documents\\Markie'"],
        options: expect.objectContaining({
          cwd: "C:\\Users\\me\\Documents\\Markie",
          shell: false,
        }),
      },
    ]);
  });

  it("launches detected Linux terminals in the requested folder", () => {
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const result = openExternal("GNOME Terminal", "/home/me/notes", {
      platform: "linux",
      env: { PATH: "/usr/bin" },
      existsSync: (p: string) => p === "/home/me/notes" || p === "/usr/bin/gnome-terminal",
      home: "/home/me",
      spawnFn: (command: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ command, args, options });
        return { unref() {} };
      },
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        command: "gnome-terminal",
        args: ["--working-directory", "/home/me/notes"],
        options: expect.objectContaining({
          cwd: "/home/me/notes",
          shell: false,
        }),
      },
    ]);
  });

  it("rejects unknown renderer-supplied terminal names", () => {
    expect(openExternal("Calculator", "/tmp", { platform: "linux" })).toEqual({
      error: "unknown terminal app",
    });
    expect(
      openExternal("GNOME Terminal", "/tmp", {
        platform: "linux",
        env: { PATH: "/usr/bin" },
        existsSync: () => false,
      })
    ).toEqual({ error: "terminal app unavailable" });
    expect(isKnownApp("Calculator")).toBe(false);
  });

  it("uses a neutral shell label across desktop platforms", () => {
    expect(terminalLabel("darwin", { SHELL: "/bin/zsh" })).toBe("zsh");
    expect(terminalLabel("linux", {})).toBe("bash");
    expect(terminalLabel("win32", {})).toBe("powershell");
  });
});
