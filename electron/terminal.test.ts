import { afterEach, describe, it, expect } from "vitest";
import type { PathLike } from "node:fs";
import {
  MAX_SESSIONS,
  buildEnv,
  commandExists,
  create,
  externalApps,
  isKnownApp,
  killAll,
  openExternal,
  resolveContext,
  resolveShell,
  sessionCount,
  terminalLabel,
} from "./terminal.js";


// NODE_ENV is required on ProcessEnv here, and a terminal fixture only ever
// sets the variables under test.
const fakeEnv = (vars: Partial<NodeJS.ProcessEnv>): NodeJS.ProcessEnv =>
  vars as NodeJS.ProcessEnv;

// The detectors default to fs.existsSync, so what they hand a fixture is a
// PathLike, not a plain string.
const fakeExists =
  (match: (candidate: string) => boolean) =>
  (candidate: PathLike): boolean =>
    match(String(candidate));

// commandExists, externalApps and openExternal share one option bag. spawnFn
// defaults to child_process.spawn, whose overload set is far wider than the
// three-argument call the launcher actually makes.
type TerminalDeps = NonNullable<Parameters<typeof openExternal>[2]>;
const fakeDeps = (o: {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  existsSync?: (candidate: PathLike) => boolean;
  home?: string;
  spawnFn?: (
    command: string,
    args: string[],
    options: Record<string, unknown>
  ) => { unref(): void };
}): TerminalDeps => o as unknown as TerminalDeps;

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
      fakeEnv({ PATH: "/usr/bin", MARKIE_FILE: "stale.md" })
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
    const firstShellEnv = buildEnv(documentA, fakeEnv({ PATH: "/usr/bin" }));

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
    expect(resolveShell("darwin", fakeEnv({ SHELL: "/bin/fish" }))).toEqual({
      command: "/bin/fish",
      args: ["-l"],
    });
  });

  it("falls back to zsh on macOS when SHELL is missing", () => {
    expect(resolveShell("darwin", fakeEnv({}))).toEqual({
      command: "/bin/zsh",
      args: ["-l"],
    });
  });

  it("uses bash as the Linux fallback instead of a macOS-only shell", () => {
    expect(resolveShell("linux", fakeEnv({}))).toEqual({
      command: "/bin/bash",
      args: ["-l"],
    });
  });

  it("uses ComSpec on Windows without Unix login-shell args", () => {
    expect(resolveShell("win32", fakeEnv({ ComSpec: "C:\\Windows\\System32\\cmd.exe" }))).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [],
    });
  });

  it("falls back to PowerShell on Windows when ComSpec is missing", () => {
    expect(resolveShell("win32", fakeEnv({}))).toEqual({
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
        env: fakeEnv({ PATH: "C:\\Tools", PATHEXT: ".EXE;.CMD" }),
        existsSync: fakeExists((p) => p.endsWith("wt.exe")),
      })
    ).toBe(true);

    expect(
      commandExists("gnome-terminal", {
        platform: "linux",
        env: fakeEnv({ PATH: "/usr/local/bin:/usr/bin" }),
        existsSync: fakeExists((p) => p === "/usr/bin/gnome-terminal"),
      })
    ).toBe(true);
  });

  it("returns safe Windows terminal choices instead of macOS-only emptiness", () => {
    const apps = externalApps({
      platform: "win32",
      env: fakeEnv({ PATH: "C:\\Tools", PATHEXT: ".EXE;.CMD" }),
      existsSync: fakeExists((p) => p.endsWith("wt.exe")),
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
      env: fakeEnv({ TERMINAL: "alacritty", PATH: "/usr/bin" }),
      existsSync: fakeExists((p) => p === "/usr/bin/alacritty" || p === "/usr/bin/konsole"),
    });

    expect(apps).toEqual([
      { id: "env-terminal", name: "alacritty" },
      { id: "konsole", name: "Konsole" },
    ]);
  });

  it("launches PowerShell in the requested folder without using a shell string", () => {
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const result = openExternal("PowerShell", "C:\\Users\\me\\Documents\\Markie", fakeDeps({
      platform: "win32",
      existsSync: fakeExists((p) => p === "C:\\Users\\me\\Documents\\Markie"),
      home: "C:\\Users\\me",
      spawnFn: (command: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ command, args, options });
        return { unref() {} };
      },
    }));

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
    const result = openExternal("GNOME Terminal", "/home/me/notes", fakeDeps({
      platform: "linux",
      env: fakeEnv({ PATH: "/usr/bin" }),
      existsSync: fakeExists((p) => p === "/home/me/notes" || p === "/usr/bin/gnome-terminal"),
      home: "/home/me",
      spawnFn: (command: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ command, args, options });
        return { unref() {} };
      },
    }));

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
        env: fakeEnv({ PATH: "/usr/bin" }),
        existsSync: () => false,
      })
    ).toEqual({ error: "terminal app unavailable" });
    expect(isKnownApp("Calculator")).toBe(false);
  });

  it("uses a neutral shell label across desktop platforms", () => {
    expect(terminalLabel("darwin", fakeEnv({ SHELL: "/bin/zsh" }))).toBe("zsh");
    expect(terminalLabel("linux", fakeEnv({}))).toBe("bash");
    expect(terminalLabel("win32", fakeEnv({}))).toBe("powershell");
  });
});


describe("session ceiling", () => {
  afterEach(() => killAll());

  // Each session is a real login shell. A renderer that keeps asking for tabs
  // used to get them forever, leaving orphaned shells behind the app.
  const fakePty = () => {
    const spawned: Array<{ killed: boolean }> = [];
    const spawnPty = () => {
      const p = {
        killed: false,
        onData() {},
        onExit() {},
        kill() {
          p.killed = true;
        },
        write() {},
        resize() {},
      };
      spawned.push(p);
      return p;
    };
    return { spawned, spawnPty };
  };

  it("refuses to open more than MAX_SESSIONS shells, and says why", () => {
    const { spawned, spawnPty } = fakePty();
    const results: Array<string | { error: string; limit?: number; message?: string }> = [];
    for (let i = 0; i < MAX_SESSIONS + 5; i += 1) {
      results.push(create({}, () => {}, () => {}, { spawnPty }));
    }
    expect(results.filter((r) => typeof r === "string")).toHaveLength(MAX_SESSIONS);
    for (const refused of results.slice(MAX_SESSIONS)) {
      // A bare null told the renderer nothing; the cap has to be nameable.
      expect(typeof refused).toBe("object");
      expect((refused as { error: string }).error).toBe("limit");
      expect((refused as { limit: number }).limit).toBe(MAX_SESSIONS);
      expect((refused as { message: string }).message).toMatch(/Close one/);
    }
    expect(spawned).toHaveLength(MAX_SESSIONS);
    expect(sessionCount()).toBe(MAX_SESSIONS);
  });

  it("says the terminal is unavailable when there is no pty to spawn", () => {
    expect(create({}, () => {}, () => {}, { spawnPty: null })).toEqual({
      error: "unavailable",
      message: "The built-in terminal isn't available in this build of Markie.",
    });
  });

  it("lets a new shell open once one is killed", () => {
    const { spawnPty } = fakePty();
    for (let i = 0; i < MAX_SESSIONS; i += 1) create({}, () => {}, () => {}, { spawnPty });
    expect(create({}, () => {}, () => {}, { spawnPty })).toMatchObject({ error: "limit" });
    killAll();
    expect(sessionCount()).toBe(0);
    expect(create({}, () => {}, () => {}, { spawnPty })).toBeTruthy();
  });

  it("kills every live shell on killAll", () => {
    const { spawned, spawnPty } = fakePty();
    create({}, () => {}, () => {}, { spawnPty });
    create({}, () => {}, () => {}, { spawnPty });
    killAll();
    expect(spawned.every((p) => p.killed)).toBe(true);
    expect(sessionCount()).toBe(0);
  });
});
