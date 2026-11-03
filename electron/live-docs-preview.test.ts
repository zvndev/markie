import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NODE_MISSING_MESSAGE,
  PREVIEW_PARTITION,
  WATCHDOG_SCRIPT,
  checkProjectFolder,
  createDevServerRunner,
  devServerEnv,
  findDarkmownCli,
  findExecutable,
  lockDownSession,
  lockNavigation,
  navigationDecision,
  parsePathProbe,
  previewBounds,
  previewWebPreferences,
  resolveNode,
} from "./live-docs-preview.js";

const temps: string[] = [];
function tempDir(prefix = "markie-live-docs-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}
function write(file: string, content = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("checkProjectFolder", () => {
  it("refuses anything that is not an absolute, plain path", () => {
    for (const candidate of [undefined, null, 42, "", "relative/site", "/tmp/evil\nname", "/tmp/a\x00b", `/${"a".repeat(5000)}`]) {
      const result = checkProjectFolder(candidate);
      expect(result.ok, String(candidate)).toBe(false);
      if (!result.ok) expect(result.code).toBe("invalid-path");
    }
  });

  it("refuses a folder that does not exist, and a file", () => {
    const dir = tempDir();
    expect(checkProjectFolder(path.join(dir, "gone"))).toMatchObject({ ok: false, code: "missing" });
    write(path.join(dir, "file.wd"), "# hi");
    expect(checkProjectFolder(path.join(dir, "file.wd"))).toMatchObject({ ok: false, code: "not-a-folder" });
  });

  it("refuses the home folder and the filesystem root even when they look like projects", () => {
    const home = tempDir();
    fs.mkdirSync(path.join(home, "site", "pages"), { recursive: true });
    expect(checkProjectFolder(home, { home })).toMatchObject({ ok: false, code: "too-broad" });
    expect(checkProjectFolder("/", { home })).toMatchObject({ ok: false, code: "too-broad" });
  });

  it("accepts a folder with site/pages", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "site", "pages"), { recursive: true });
    expect(checkProjectFolder(dir, { home: "/nowhere" })).toEqual({
      ok: true,
      root: dir,
      name: path.basename(dir),
      reasons: ["has site/pages"],
    });
  });

  it("accepts a folder whose package.json depends on @zvndev/darkmown", () => {
    const dir = tempDir();
    write(path.join(dir, "package.json"), JSON.stringify({ devDependencies: { "@zvndev/darkmown": "^2.13.0" } }));
    expect(checkProjectFolder(dir, { home: "/nowhere" })).toMatchObject({ ok: true, reasons: ["depends on @zvndev/darkmown"] });
  });

  it("says why an ordinary folder was refused", () => {
    const dir = tempDir();
    write(path.join(dir, "package.json"), JSON.stringify({ dependencies: { react: "19" } }));
    write(path.join(dir, "site", "README.md"), "# not pages");
    const result = checkProjectFolder(dir, { home: "/nowhere" });
    expect(result).toMatchObject({ ok: false, code: "not-a-project" });
    if (!result.ok) expect(result.message).toMatch(/no site\/pages folder.*@zvndev\/darkmown/);
  });

  it("treats a broken package.json as no dependency instead of failing", () => {
    const dir = tempDir();
    write(path.join(dir, "package.json"), "{ not json");
    expect(checkProjectFolder(dir, { home: "/nowhere" })).toMatchObject({ ok: false, code: "not-a-project" });
  });

  it("keeps the real folder behind a symlink", () => {
    const dir = tempDir();
    const real = path.join(dir, "real");
    fs.mkdirSync(path.join(real, "site", "pages"), { recursive: true });
    fs.symlinkSync(real, path.join(dir, "link"));
    expect(checkProjectFolder(path.join(dir, "link"), { home: "/nowhere" })).toMatchObject({ ok: true, root: real });
  });
});

describe("findDarkmownCli", () => {
  it("runs the project's own installed darkmown", () => {
    const dir = tempDir();
    write(path.join(dir, "node_modules", "@zvndev", "darkmown", "src", "cli.js"), "#!/usr/bin/env node\n");
    fs.mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
    fs.symlinkSync("../@zvndev/darkmown/src/cli.js", path.join(dir, "node_modules", ".bin", "darkmown"));
    expect(findDarkmownCli(dir)).toEqual({ ok: true, cli: path.join(dir, "node_modules", ".bin", "darkmown") });
  });

  it("runs the framework checkout's CLI from source", () => {
    const dir = tempDir();
    write(path.join(dir, "package.json"), JSON.stringify({ name: "@zvndev/darkmown", bin: { darkmown: "./src/cli.js" } }));
    write(path.join(dir, "src", "cli.js"), "");
    expect(findDarkmownCli(dir)).toEqual({ ok: true, cli: path.join(dir, "src", "cli.js") });
  });

  it("never follows a bin entry out of the project", () => {
    const dir = tempDir();
    write(path.join(dir, "package.json"), JSON.stringify({ name: "@zvndev/darkmown", bin: { darkmown: "../../usr/bin/env" } }));
    expect(findDarkmownCli(dir)).toMatchObject({ ok: false, code: "not-installed" });
  });

  it("asks for npm install when darkmown is not installed", () => {
    const dir = tempDir();
    const result = findDarkmownCli(dir);
    expect(result).toMatchObject({ ok: false, code: "not-installed" });
    if (!result.ok) expect(result.message).toMatch(/npm install/);
  });
});

describe("finding node through the login shell", () => {
  it("reads PATH between the markers and ignores what the profile printed", () => {
    const stdout = "Welcome!\n__MARKIE_PATH__\n/opt/homebrew/bin:/usr/bin\n__MARKIE_PATH_END__\nbye from .zlogout\n";
    expect(parsePathProbe(stdout)).toBe("/opt/homebrew/bin:/usr/bin");
    expect(parsePathProbe("no markers here")).toBeNull();
    expect(parsePathProbe("__MARKIE_PATH__\n\n__MARKIE_PATH_END__")).toBeNull();
  });

  it("finds only executable files, in PATH order", () => {
    const dir = tempDir();
    write(path.join(dir, "a", "node"), "");
    fs.chmodSync(path.join(dir, "a", "node"), 0o644);
    fs.mkdirSync(path.join(dir, "b", "node"), { recursive: true });
    write(path.join(dir, "c", "node"), "");
    fs.chmodSync(path.join(dir, "c", "node"), 0o755);
    const searchPath = ["relative/dir", path.join(dir, "a"), path.join(dir, "b"), path.join(dir, "c")].join(":");
    expect(findExecutable("node", searchPath)).toBe(path.join(dir, "c", "node"));
    expect(findExecutable("node", path.join(dir, "a"))).toBeNull();
  });

  type ExecCall = { file: string; args: string[]; options: { env?: NodeJS.ProcessEnv; killSignal?: string } };
  function fakeExec(answer: (call: ExecCall) => string) {
    const calls: ExecCall[] = [];
    const execFile = (file: string, args: string[], options: ExecCall["options"], callback: (error: Error | null, stdout: string) => void) => {
      const call = { file, args, options };
      calls.push(call);
      setImmediate(() => callback(null, answer(call)));
    };
    return { calls, execFile };
  }
  function nodeDir(version = "v22.11.0") {
    const dir = tempDir();
    write(path.join(dir, "node"), "");
    fs.chmodSync(path.join(dir, "node"), 0o755);
    return { dir, version };
  }
  const env = { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv;

  it("asks a plain login shell first, with a fixed command and no path in it", async () => {
    const { dir } = nodeDir();
    const { calls, execFile } = fakeExec((call) =>
      call.file === "/bin/zsh" ? `motd\n__MARKIE_PATH__\n${dir}:/usr/bin\n__MARKIE_PATH_END__\n` : "v22.11.0\n");
    const result = await resolveNode({ platform: "darwin", env, execFile: execFile as never });
    expect(result).toEqual({ ok: true, node: path.join(dir, "node"), version: "v22.11.0", path: `${dir}:/usr/bin`, via: "zsh -l" });
    expect(calls[0].args).toEqual(["-l", "-c", "echo __MARKIE_PATH__; /usr/bin/printenv PATH; echo __MARKIE_PATH_END__"]);
    expect(calls[0].options.killSignal).toBe("SIGKILL");
    expect(calls[1]).toMatchObject({ file: path.join(dir, "node"), args: ["--version"] });
  });

  it("falls back to an interactive login shell for node set up in .zshrc", async () => {
    const { dir } = nodeDir();
    const { calls, execFile } = fakeExec((call) => {
      if (call.file !== "/bin/zsh") return "v24.1.0\n";
      return call.args[0] === "-l"
        ? "__MARKIE_PATH__\n/usr/bin:/bin\n__MARKIE_PATH_END__\n"
        : `__MARKIE_PATH__\n${dir}:/usr/bin\n__MARKIE_PATH_END__\n`;
    });
    const result = await resolveNode({ platform: "darwin", env, execFile: execFile as never });
    expect(result).toMatchObject({ ok: true, via: "zsh -i -l", version: "v24.1.0" });
    expect(calls.filter((call) => call.file === "/bin/zsh").map((call) => call.args.slice(0, -2))).toEqual([["-l"], ["-i", "-l"]]);
  });

  it("says clearly when there is no node at all", async () => {
    const { execFile } = fakeExec(() => "__MARKIE_PATH__\n/usr/bin:/bin\n__MARKIE_PATH_END__\n");
    const result = await resolveNode({ platform: "darwin", env, execFile: execFile as never, fs: { ...fs, statSync: () => { throw new Error("ENOENT"); } } as never });
    expect(result).toEqual({ ok: false, code: "node-missing", message: NODE_MISSING_MESSAGE });
    expect(NODE_MISSING_MESSAGE).toMatch(/Node\.js.*20 or newer/);
  });

  it("refuses a node older than Darkmown supports", async () => {
    const { dir } = nodeDir();
    const { execFile } = fakeExec((call) => call.file === "/bin/zsh" ? `__MARKIE_PATH__\n${dir}\n__MARKIE_PATH_END__\n` : "v18.20.0\n");
    const result = await resolveNode({ platform: "darwin", env, execFile: execFile as never });
    expect(result).toMatchObject({ ok: false, code: "node-too-old" });
  });

  it("does not try on Windows yet", async () => {
    expect(await resolveNode({ platform: "win32" })).toMatchObject({ ok: false, code: "unsupported-platform" });
  });
});

describe("the dev server environment", () => {
  it("pins the server to loopback on the chosen port and drops Electron's switches", () => {
    const env = devServerEnv(
      { HOME: "/Users/k", ELECTRON_RUN_AS_NODE: "1", DARKMOWN_ALLOWED_HOSTS: "*", HOST: "0.0.0.0", PATH: "/usr/bin" } as NodeJS.ProcessEnv,
      "/opt/homebrew/bin:/usr/bin",
      51234
    );
    expect(env).toMatchObject({ HOME: "/Users/k", PATH: "/opt/homebrew/bin:/usr/bin", PORT: "51234", HOST: "127.0.0.1" });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.DARKMOWN_ALLOWED_HOSTS).toBeUndefined();
  });
});

describe("createDevServerRunner", () => {
  let nextPid = 4242;
  class FakeChild extends EventEmitter {
    pid = nextPid++;
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    stdin = Object.assign(new EventEmitter(), { ended: false, end() { this.ended = true; } });
    exit(code: number | null, signal: string | null = null) { this.emit("exit", code, signal); }
  }

  function setup({ ready = () => true, onSpawn }: { ready?: (origin: string) => boolean; onSpawn?: (child: FakeChild, index: number) => void } = {}) {
    nextPid = 4242;
    const project = tempDir();
    write(path.join(project, "node_modules", ".bin", "darkmown"), "");
    const nodeHome = tempDir();
    write(path.join(nodeHome, "node"), "");
    fs.chmodSync(path.join(nodeHome, "node"), 0o755);
    const spawned: Array<{ file: string; args: string[]; options: Record<string, unknown>; child: FakeChild }> = [];
    const kills: Array<[number, string]> = [];
    let port = 50100;
    const runner = createDevServerRunner({
      platform: "darwin",
      env: { SHELL: "/bin/zsh", ELECTRON_RUN_AS_NODE: "1" } as NodeJS.ProcessEnv,
      execFile: ((file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) =>
        setImmediate(() => callback(null, file === "/bin/zsh" ? `__MARKIE_PATH__\n${nodeHome}\n__MARKIE_PATH_END__\n` : "v22.0.0\n"))) as never,
      spawn: ((file: string, args: string[], options: Record<string, unknown>) => {
        const child = new FakeChild();
        spawned.push({ file, args, options, child });
        onSpawn?.(child, spawned.length - 1);
        return child;
      }) as never,
      pickPort: async () => port++,
      probeReady: async (origin: string) => ready(origin),
      pollMs: 1,
      readyTimeoutMs: 200,
      stopGraceMs: 20,
      kill: (pid: number, signal: string) => {
        kills.push([pid, signal]);
        const run = spawned.find((entry) => entry.child.pid === -pid);
        setImmediate(() => run?.child.exit(null, signal));
      },
    });
    return { project, nodeHome, runner, spawned, kills };
  }

  it("spawns the project's darkmown under the watchdog, without a shell, and waits for it to answer", async () => {
    const { project, nodeHome, runner, spawned } = setup();
    const result = await runner.start(project);
    expect(result).toEqual({
      ok: true,
      origin: "http://127.0.0.1:50100",
      port: 50100,
      cli: path.join(project, "node_modules", ".bin", "darkmown"),
      node: { path: path.join(nodeHome, "node"), version: "v22.0.0", via: "zsh -l" },
    });
    expect(spawned).toHaveLength(1);
    const [{ file, args, options }] = spawned;
    expect(file).toBe(path.join(nodeHome, "node"));
    expect(args).toEqual(["-e", WATCHDOG_SCRIPT, "--", path.join(project, "node_modules", ".bin", "darkmown"), "dev"]);
    expect(options).toMatchObject({ cwd: project, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    expect(options.env).toMatchObject({ PORT: "50100", HOST: "127.0.0.1", PATH: nodeHome });
    expect((options.env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(WATCHDOG_SCRIPT).not.toContain(project);
    expect(runner.running()).toBe(true);
  });

  it("reports the server's own output when it dies before answering", async () => {
    const { project, runner } = setup({
      ready: () => false,
      onSpawn: (child) => setImmediate(() => { child.stderr.emit("data", "\x1b[31mError: Cannot find module 'x'\x1b[0m\n"); child.exit(1); }),
    });
    const result = await runner.start(project);
    expect(result).toMatchObject({ ok: false, code: "start-failed", log: ["Error: Cannot find module 'x'"] });
    expect(runner.running()).toBe(false);
  });

  it("tries a second port once when the first was taken in between", async () => {
    const { project, runner, spawned } = setup({
      ready: (origin) => origin.endsWith(":50101"),
      onSpawn: (child, index) => {
        if (index === 0) setImmediate(() => { child.stderr.emit("data", "Error: listen EADDRINUSE: address already in use 127.0.0.1:50100\n"); child.exit(1); });
      },
    });
    expect(await runner.start(project)).toMatchObject({ ok: true, port: 50101 });
    expect(spawned).toHaveLength(2);
  });

  it("gives up with a timeout instead of waiting forever", async () => {
    const { project, runner, kills } = setup({ ready: () => false });
    expect(await runner.start(project)).toMatchObject({ ok: false, code: "start-timeout" });
    expect(kills[0]).toEqual([-4242, "SIGTERM"]);
  });

  it("stops the whole process group and closes the watchdog's stdin", async () => {
    const { project, runner, spawned, kills } = setup();
    await runner.start(project);
    await runner.stop();
    expect(kills).toEqual([[-4242, "SIGTERM"]]);
    expect(spawned[0].child.stdin.ended).toBe(true);
    expect(runner.running()).toBe(false);
  });

  it("reports a ready server that stops on its own, and not one it stopped itself", async () => {
    const { project, runner, spawned } = setup();
    const exits: unknown[] = [];
    await runner.start(project, { onExit: (info: unknown) => exits.push(info) });
    spawned[0].child.stdout.emit("data", "Rebuilt 1 of 1 routes\n");
    spawned[0].child.exit(1);
    expect(exits).toEqual([{ code: 1, signal: null, log: ["Rebuilt 1 of 1 routes"] }]);

    await runner.start(project, { onExit: (info: unknown) => exits.push(info) });
    await runner.stop();
    expect(exits).toHaveLength(1);
  });

  it("refuses before spawning anything when darkmown is not installed", async () => {
    const { runner, spawned } = setup();
    expect(await runner.start(tempDir())).toMatchObject({ ok: false, code: "not-installed" });
    expect(spawned).toHaveLength(0);
  });

  it("signals right away on the quit path without waiting", async () => {
    const { project, runner, kills } = setup();
    await runner.start(project);
    runner.stopNow();
    expect(kills).toEqual([[-4242, "SIGTERM"]]);
  });
});

// The real watchdog, under the real node running this test: when Markie's end
// of its stdin goes away, as it does when Markie crashes, the server goes too.
describe("the watchdog", () => {
  function alive(pid: number) {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
  async function until(check: () => boolean, ms = 8000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return check();
  }

  it("takes the dev server down when its parent's pipe closes", async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, "server.pid");
    const fakeCli = path.join(dir, "fake-cli.js");
    write(fakeCli, `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const watchdog: ChildProcess = spawn(process.execPath, ["-e", WATCHDOG_SCRIPT, "--", fakeCli, "dev"], { stdio: ["pipe", "ignore", "ignore"] });
    try {
      expect(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").length > 0)).toBe(true);
      const serverPid = Number(fs.readFileSync(pidFile, "utf8"));
      expect(alive(serverPid)).toBe(true);
      watchdog.stdin?.end();
      expect(await until(() => !alive(serverPid))).toBe(true);
      expect(await until(() => watchdog.exitCode !== null || watchdog.signalCode !== null)).toBe(true);
    } finally {
      if (watchdog.exitCode === null) watchdog.kill("SIGKILL");
    }
  });
});

describe("navigationDecision", () => {
  const origin = "http://127.0.0.1:51234";
  it("allows only the dev server's exact origin", () => {
    expect(navigationDecision("http://127.0.0.1:51234/", origin)).toBe("allow");
    expect(navigationDecision("http://127.0.0.1:51234/docs/?q=1#top", origin)).toBe("allow");
  });
  it("sends every other web address to the browser", () => {
    for (const url of ["http://127.0.0.1:51235/", "http://localhost:51234/", "https://127.0.0.1:51234/", "https://darkmown.com/docs/"]) {
      expect(navigationDecision(url, origin), url).toBe("external");
    }
  });
  it("blocks everything that is not an ordinary web address", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "about:blank", "app://markie/index.html", "markie://open", "http://user:pw@127.0.0.1:51234/", "not a url", 42]) {
      expect(navigationDecision(url, origin), String(url)).toBe("block");
    }
  });
});

describe("lockNavigation", () => {
  const origin = "http://127.0.0.1:51234";
  function fakeContents() {
    const contents = Object.assign(new EventEmitter(), {
      windowOpen: null as null | ((details: { url: string }) => { action: string }),
      loaded: [] as string[],
      setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) { this.windowOpen = handler; },
      loadURL(url: string) { this.loaded.push(url); return Promise.resolve(); },
    });
    return contents;
  }
  function navigate(contents: EventEmitter, name: string, url: string, isMainFrame = true) {
    const event = { url, isMainFrame, prevented: false, preventDefault() { this.prevented = true; } };
    contents.emit(name, event, url, false, isMainFrame);
    return event.prevented;
  }
  function setup() {
    let clock = 10_000;
    const opened: string[] = [];
    const contents = fakeContents();
    lockNavigation(contents as never, { origin, openExternal: (url: string) => opened.push(url), now: () => clock });
    const click = () => contents.emit("input-event", {}, { type: "mouseDown" });
    return { contents, opened, click, tick: (ms: number) => { clock += ms; } };
  }

  it("lets same-origin links through", () => {
    const { contents, opened } = setup();
    expect(navigate(contents, "will-navigate", `${origin}/docs/`)).toBe(false);
    expect(opened).toEqual([]);
  });

  it("opens another site in the browser only right after a click, once per click", () => {
    const { contents, opened, click, tick } = setup();
    expect(navigate(contents, "will-navigate", "https://darkmown.com/")).toBe(true);
    expect(opened).toEqual([]);
    click();
    tick(200);
    expect(navigate(contents, "will-navigate", "https://darkmown.com/")).toBe(true);
    expect(navigate(contents, "will-navigate", "https://example.com/")).toBe(true);
    expect(opened).toEqual(["https://darkmown.com/"]);
    click();
    tick(5_000);
    expect(navigate(contents, "will-navigate", "https://example.com/")).toBe(true);
    expect(opened).toEqual(["https://darkmown.com/"]);
  });

  it("never opens a non-web address, click or not", () => {
    const { contents, opened, click } = setup();
    click();
    expect(navigate(contents, "will-navigate", "file:///etc/hosts")).toBe(true);
    expect(opened).toEqual([]);
  });

  it("stops a top-level redirect off the origin but leaves frames alone", () => {
    const { contents } = setup();
    expect(navigate(contents, "will-redirect", "https://elsewhere.test/")).toBe(true);
    expect(navigate(contents, "will-redirect", `${origin}/moved/`)).toBe(false);
    expect(navigate(contents, "will-redirect", "https://www.youtube-nocookie.com/embed/x", false)).toBe(false);
  });

  it("never opens a window: same-origin loads in place, the rest goes to the browser or nowhere", () => {
    const { contents, opened, click } = setup();
    const open = (url: string) => contents.windowOpen!({ url });
    expect(open(`${origin}/other/`)).toEqual({ action: "deny" });
    expect(contents.loaded).toEqual([`${origin}/other/`]);
    expect(open("https://darkmown.com/")).toEqual({ action: "deny" });
    expect(opened).toEqual([]);
    click();
    expect(open("https://darkmown.com/")).toEqual({ action: "deny" });
    expect(opened).toEqual(["https://darkmown.com/"]);
    click();
    expect(open("javascript:alert(1)")).toEqual({ action: "deny" });
    expect(opened).toEqual(["https://darkmown.com/"]);
  });
});

describe("the preview's session and view", () => {
  it("uses its own in-memory partition, no preload, a sandbox, and no devtools when packaged", () => {
    const prefs = previewWebPreferences({ isPackaged: true });
    expect(PREVIEW_PARTITION).not.toMatch(/^persist:/);
    expect(prefs).toMatchObject({
      partition: PREVIEW_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      devTools: false,
    });
    expect(prefs).not.toHaveProperty("preload");
    expect(previewWebPreferences({ isPackaged: false }).devTools).toBe(true);
  });

  it("denies every permission and every download, once per session", () => {
    const handlers: Record<string, (...args: unknown[]) => unknown> = {};
    const session = Object.assign(new EventEmitter(), {
      setPermissionRequestHandler: (fn: (...args: unknown[]) => unknown) => { handlers.request = fn; },
      setPermissionCheckHandler: (fn: (...args: unknown[]) => unknown) => { handlers.check = fn; },
      setDevicePermissionHandler: (fn: (...args: unknown[]) => unknown) => { handlers.device = fn; },
    });
    lockDownSession(session as never);
    lockDownSession(session as never);
    const answers: boolean[] = [];
    for (const permission of ["media", "geolocation", "notifications", "clipboard-read", "openExternal"]) {
      handlers.request({}, permission, (allowed: boolean) => answers.push(allowed));
    }
    expect(answers).toEqual([false, false, false, false, false]);
    expect(handlers.check({}, "media")).toBe(false);
    expect(handlers.device({})).toBe(false);
    expect(session.listenerCount("will-download")).toBe(1);
    let prevented = false;
    session.emit("will-download", { preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
  });
});

describe("previewBounds", () => {
  const content = { width: 1280, height: 820 };
  it("rounds the placeholder's rectangle into the window", () => {
    expect(previewBounds({ x: 12.4, y: 48.6, width: 900.2, height: 600.5 }, content)).toEqual({ x: 12, y: 49, width: 900, height: 601 });
  });
  it("scales by the renderer's zoom", () => {
    expect(previewBounds({ x: 10, y: 20, width: 100, height: 50 }, content, 1.5)).toEqual({ x: 15, y: 30, width: 150, height: 75 });
  });
  it("keeps the view inside the window", () => {
    expect(previewBounds({ x: -40, y: 700, width: 5000, height: 400 }, content)).toEqual({ x: 0, y: 700, width: 1280, height: 120 });
  });
  it("hides the view for anything malformed or empty", () => {
    for (const layout of [null, "x", {}, { x: "1", y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: Number.NaN, height: 10 }, { x: 0, y: 0, width: 0, height: 10 }]) {
      expect(previewBounds(layout, content)).toBeNull();
    }
  });
});

// main.js cannot load without Electron, so the IPC edge is read as source, the
// way electron/ipc-contract.test.ts reads it.
describe("the Live Docs gate in main.js", () => {
  const mainSrc = fs.readFileSync(new URL("./main.js", import.meta.url), "utf8");
  const all = [...mainSrc.matchAll(/handle\("(live-docs-preview-[a-z-]+)"/g)].map((match) => match[1]).sort();
  const gated = [...mainSrc.matchAll(/handle\("(live-docs-preview-[a-z-]+)", (?:async )?\(([^)]*)\) => \{\n {2}const refused = liveDocsRefusal\(event\);\n {2}if \(refused\) return refused;\n/g)];

  it("checks the build and the sender before anything else in every handler", () => {
    expect(all).toEqual(["live-docs-preview-choose", "live-docs-preview-layout", "live-docs-preview-start", "live-docs-preview-stop"]);
    expect(gated.map((match) => match[1]).sort()).toEqual(all);
    const refusal = mainSrc.slice(mainSrc.indexOf("function liveDocsRefusal(event)"), mainSrc.indexOf("function liveDocsPublicProject"));
    expect(refusal).toMatch(/if \(!nightlyEnabledInMain\(\)\) return/);
    expect(refusal).toMatch(/if \(!currentCloseSender\(event\)\) return/);
  });

  it("takes no path or command from the renderer", () => {
    for (const [, channel, params] of gated) {
      expect(params.split(",").map((param) => param.trim()), channel).toEqual(channel === "live-docs-preview-layout" ? ["event", "layout"] : ["event"]);
    }
  });

  it("keeps only a folder the native picker returned and the gate accepted", () => {
    expect([...mainSrc.matchAll(/liveDocsProject = ([^;]+);/g)].map((match) => match[1])).toEqual(["null", "checked"]);
    expect(mainSrc).toMatch(/const checked = liveDocs\.checkProjectFolder\(result\.filePaths\[0\]\);\n {2}if \(!checked\.ok\) return checked;/);
  });

  it("tells the renderer about the preview build only when the packaged manifest says so", () => {
    expect(mainSrc).toMatch(/\.\.\.\(isDesktopPreview \? \["--markie-desktop-preview"\] : \[\]\)/);
    expect(mainSrc).toMatch(/function nightlyEnabledInMain\(\) \{\n {2}return !!privateReleaseConfig \|\| !app\.isPackaged \|\| isDesktopPreview;\n\}/);
  });
});
