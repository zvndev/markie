import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLiveDocsProjectIpc,
  createLiveDocsProjects,
  parseRelativePath,
  MAX_PROJECTS,
  WATCH_MAX_PATHS,
} from "./live-docs-projects.cjs";

const temps: string[] = [];
function tempDir(prefix = "markie-m3-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}
function write(file: string, content: string | Uint8Array = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// A small Darkmown site, like the scaffold: pages, an include, a skin, page
// script, an api handler, data, and the folders the area must hide.
function scratchProject(parent = tempDir()) {
  const root = path.join(parent, "site-project");
  write(path.join(root, "package.json"), JSON.stringify({ name: "scratch", dependencies: { "@zvndev/darkmown": "^0.9.0" } }));
  write(path.join(root, "site/pages/index.wd"), "# Home\n\n:state count = 0\n");
  write(path.join(root, "site/pages/index.skin"), "body\n  color: red\n");
  write(path.join(root, "site/pages/index.js"), "export const x = 1;\n");
  write(path.join(root, "site/_/header.wd"), "## Header\n");
  write(path.join(root, "api/hello.js"), "export default () => ({ hi: true });\n");
  write(path.join(root, ".gitignore"), "node_modules\n");
  write(path.join(root, ".git/config"), "[core]\n");
  write(path.join(root, ".git/hooks/pre-commit"), "#!/bin/sh\n");
  write(path.join(root, "node_modules/@zvndev/darkmown/package.json"), "{}");
  write(path.join(root, ".DS_Store"), new Uint8Array([0, 1, 2]));
  return { parent, root };
}

function service(options: Partial<Parameters<typeof createLiveDocsProjects>[0]> = {}) {
  const userData = tempDir("markie-m3-userdata-");
  const changes: unknown[] = [];
  const projects = createLiveDocsProjects({
    storePath: path.join(userData, "live-docs-projects.json"),
    home: tempDir("markie-m3-home-"),
    onChange: (change: unknown) => changes.push(change),
    ...options,
  });
  return { projects, changes, userData };
}

function openScratch(options: Partial<Parameters<typeof createLiveDocsProjects>[0]> = {}) {
  const made = scratchProject();
  const s = service({ watch: () => Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as fs.FSWatcher, ...options });
  const added = s.projects.add(made.root);
  if (!added.ok) throw new Error(JSON.stringify(added));
  const opened = s.projects.open({ id: added.project.id });
  if (!opened.ok) throw new Error(JSON.stringify(opened));
  return { ...made, ...s, id: added.project.id };
}

function read(projects: ReturnType<typeof createLiveDocsProjects>, file: string) {
  const result = projects.read({ path: file });
  if (!result.ok) throw new Error(`${file}: ${JSON.stringify(result)}`);
  return result.file;
}

describe("the Live Docs project list", () => {
  it("adds a folder with site/pages or a Darkmown dependency, and refuses anything else", () => {
    const { projects } = service();
    const parent = tempDir();
    write(path.join(parent, "pages-only/site/pages/index.wd"), "# Hi\n");
    write(path.join(parent, "dep-only/package.json"), JSON.stringify({ devDependencies: { "@zvndev/darkmown": "*" } }));
    write(path.join(parent, "plain/readme.md"), "# no\n");
    expect(projects.add(path.join(parent, "pages-only"))).toMatchObject({ ok: true, existed: false, project: { name: "pages-only", kind: "local", available: true } });
    expect(projects.add(path.join(parent, "dep-only"))).toMatchObject({ ok: true, project: { name: "dep-only" } });
    expect(projects.add(path.join(parent, "plain"))).toMatchObject({ ok: false, code: "not-a-project" });
    expect(projects.add("relative/path")).toMatchObject({ ok: false, code: "invalid-path" });
  });

  it("keeps the list across launches, never hands out the folder path as a handle, and dedupes", () => {
    const { root } = scratchProject();
    const userData = tempDir("markie-m3-userdata-");
    const storePath = path.join(userData, "live-docs-projects.json");
    const first = createLiveDocsProjects({ storePath });
    const added = first.add(root);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.add(root)).toMatchObject({ ok: true, existed: true, project: { id: added.project.id } });
    const second = createLiveDocsProjects({ storePath });
    const listed = second.list();
    expect(listed).toMatchObject({ ok: true, projects: [{ id: added.project.id, name: "site-project", available: true }] });
  });

  it("shortens the home folder for display", () => {
    const home = tempDir("markie-m3-home-");
    const { root } = scratchProject(home);
    const projects = createLiveDocsProjects({ storePath: path.join(tempDir(), "s.json"), home });
    expect(projects.add(root)).toMatchObject({ ok: true, project: { location: "~/site-project" } });
  });

  it("removes a project from the list without touching its folder", () => {
    const { projects } = service();
    const { root } = scratchProject();
    const added = projects.add(root);
    if (!added.ok) throw new Error("add failed");
    expect(projects.remove({ id: added.project.id })).toEqual({ ok: true });
    expect(projects.list()).toEqual({ ok: true, projects: [] });
    expect(fs.existsSync(path.join(root, "site/pages/index.wd"))).toBe(true);
    expect(projects.remove({ id: added.project.id })).toMatchObject({ ok: false, code: "unknown-project" });
  });

  it("caps the list", () => {
    const { projects } = service();
    const parent = tempDir();
    for (let i = 0; i < MAX_PROJECTS; i += 1) {
      write(path.join(parent, `p${i}/site/pages/index.wd`), "#\n");
      expect(projects.add(path.join(parent, `p${i}`)).ok).toBe(true);
    }
    write(path.join(parent, "one-more/site/pages/index.wd"), "#\n");
    expect(projects.add(path.join(parent, "one-more"))).toMatchObject({ ok: false, code: "limit" });
  });

  it("marks a project whose folder is gone, and refuses to open it", () => {
    const { projects } = service();
    const { root } = scratchProject();
    const added = projects.add(root);
    if (!added.ok) throw new Error("add failed");
    fs.rmSync(root, { recursive: true });
    expect(projects.list()).toMatchObject({ ok: true, projects: [{ available: false }] });
    expect(projects.open({ id: added.project.id })).toMatchObject({ ok: false, code: "missing" });
  });

  it("ignores a store file someone else edited into nonsense", () => {
    const userData = tempDir();
    const storePath = path.join(userData, "s.json");
    fs.writeFileSync(storePath, JSON.stringify({ version: 1, projects: [{ id: "x", root: "/etc" }, { id: "11111111-1111-4111-8111-111111111111", root: "relative" }, null] }));
    expect(createLiveDocsProjects({ storePath }).list()).toEqual({ ok: true, projects: [] });
    fs.writeFileSync(storePath, "{not json");
    expect(createLiveDocsProjects({ storePath }).list()).toEqual({ ok: true, projects: [] });
  });
});

describe("the open project's tree", () => {
  it("lists every project file, including .wd, .skin, .js, api/ and dot files", () => {
    const { projects } = openScratch();
    const tree = projects.tree();
    expect(tree.ok).toBe(true);
    if (!tree.ok) return;
    const paths = tree.entries.map((entry: { path: string }) => entry.path).sort();
    expect(paths).toEqual([
      ".gitignore",
      "api",
      "api/hello.js",
      "package.json",
      "site",
      "site/_",
      "site/_/header.wd",
      "site/pages",
      "site/pages/index.js",
      "site/pages/index.skin",
      "site/pages/index.wd",
    ]);
    expect(tree.truncated).toBe(false);
  });

  it("hides .git and node_modules, shows a symlink as a link and never walks through it", () => {
    const { projects, root } = openScratch();
    const outside = tempDir("markie-m3-outside-");
    write(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(outside, path.join(root, "site/escape"));
    const tree = projects.tree();
    if (!tree.ok) throw new Error("tree failed");
    const byPath = Object.fromEntries(tree.entries.map((entry: { path: string; kind: string }) => [entry.path, entry.kind]));
    expect(byPath["site/escape"]).toBe("link");
    expect(Object.keys(byPath).some((p) => p.includes("secret"))).toBe(false);
    expect(Object.keys(byPath).some((p) => p.startsWith(".git/") || p === ".git" || p.includes("node_modules") || p.includes(".DS_Store"))).toBe(false);
  });

  it("needs an open project", () => {
    const { projects } = service();
    expect(projects.tree()).toMatchObject({ ok: false, code: "no-project" });
    expect(projects.read({ path: "a.wd" })).toMatchObject({ ok: false, code: "no-project" });
  });
});

describe("reading and saving project files", () => {
  it.each(["site/pages/index.wd", "site/pages/index.skin", "site/pages/index.js", "api/hello.js", ".gitignore"])("saves %s atomically and returns the new revision", (file) => {
    const { projects, root } = openScratch();
    const before = read(projects, file);
    expect(before.revision).toBe(sha(fs.readFileSync(path.join(root, file))));
    fs.chmodSync(path.join(root, file), 0o640);
    const saved = projects.write({ path: file, text: `${before.text}// edited\n`, baseRevision: before.revision });
    expect(saved).toMatchObject({ ok: true, file: { path: file, revision: sha(`${before.text}// edited\n`) } });
    expect(fs.readFileSync(path.join(root, file), "utf8")).toBe(`${before.text}// edited\n`);
    expect(fs.statSync(path.join(root, file)).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(path.dirname(path.join(root, file))).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("keeps a byte-order mark and non-ASCII text exactly", () => {
    const { projects, root } = openScratch();
    write(path.join(root, "site/pages/bom.wd"), "\uFEFF# Café ☕\n");
    const file = read(projects, "site/pages/bom.wd");
    expect(file.text).toBe("\uFEFF# Café ☕\n");
    projects.write({ path: "site/pages/bom.wd", text: file.text, baseRevision: file.revision });
    expect(fs.readFileSync(path.join(root, "site/pages/bom.wd"))).toEqual(Buffer.from("\uFEFF# Café ☕\n"));
  });

  it("refuses to overwrite an edit made outside Markie since the file was opened", () => {
    const { projects, root } = openScratch();
    const file = read(projects, "site/pages/index.wd");
    fs.writeFileSync(path.join(root, "site/pages/index.wd"), "# Changed elsewhere\n");
    expect(projects.write({ path: "site/pages/index.wd", text: "# Mine\n", baseRevision: file.revision })).toMatchObject({ ok: false, code: "conflict" });
    expect(fs.readFileSync(path.join(root, "site/pages/index.wd"), "utf8")).toBe("# Changed elsewhere\n");
  });

  it("validates the request shape", () => {
    const { projects } = openScratch();
    const file = read(projects, "site/pages/index.wd");
    for (const bad of [undefined, null, "site/pages/index.wd", [], { path: "site/pages/index.wd", extra: 1 }, { path: 7 }]) {
      expect(projects.read(bad as never)).toMatchObject({ ok: false });
    }
    expect(projects.write({ path: "site/pages/index.wd", text: 5, baseRevision: file.revision } as never)).toMatchObject({ ok: false, code: "invalid-request" });
    expect(projects.write({ path: "site/pages/index.wd", text: "x", baseRevision: "nope" })).toMatchObject({ ok: false, code: "invalid-request" });
    expect(projects.write({ path: "site/pages/index.wd", text: "x" } as never)).toMatchObject({ ok: false, code: "invalid-request" });
    expect(projects.open({ id: "../../etc" })).toMatchObject({ ok: false, code: "invalid-request" });
  });
});

describe("refusals", () => {
  it.each([
    ["..", "../outside.txt"],
    ["a nested ..", "site/../../outside.txt"],
    ["a .", "site/./pages/index.wd"],
    ["an empty segment", "site//pages/index.wd"],
    ["an absolute path", "/etc/passwd"],
    ["a project-rooted absolute path", "/site/pages/index.wd"],
    ["a drive path", "C:/Windows/win.ini"],
    ["a backslash", "site\\pages\\index.wd"],
    ["a NUL byte", "site/pages/index.wd\u0000.txt"],
  ])("refuses %s for reads and writes", (_label, bad) => {
    const { projects, parent } = openScratch();
    write(path.join(parent, "outside.txt"), "outside");
    expect(projects.read({ path: bad })).toMatchObject({ ok: false });
    expect(projects.write({ path: bad, text: "pwned", baseRevision: sha("outside") })).toMatchObject({ ok: false });
    expect(fs.readFileSync(path.join(parent, "outside.txt"), "utf8")).toBe("outside");
  });

  it("refuses a file that is a symlink out of the project, for reads and writes", () => {
    const { projects, root } = openScratch();
    const outside = tempDir("markie-m3-outside-");
    write(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "site/pages/link.wd"));
    expect(projects.read({ path: "site/pages/link.wd" })).toMatchObject({ ok: false, code: "symlink" });
    expect(projects.write({ path: "site/pages/link.wd", text: "pwned", baseRevision: sha("secret") })).toMatchObject({ ok: false, code: "symlink" });
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("secret");
  });

  it("refuses a file reached through a folder that is a symlink out of the project", () => {
    const { projects, root } = openScratch();
    const outside = tempDir("markie-m3-outside-");
    write(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(outside, path.join(root, "site/escape"));
    expect(projects.read({ path: "site/escape/secret.txt" })).toMatchObject({ ok: false, code: "outside" });
    expect(projects.write({ path: "site/escape/secret.txt", text: "pwned", baseRevision: sha("secret") })).toMatchObject({ ok: false, code: "outside" });
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("secret");
  });

  it("refuses writes into .git, by name in any case and through a symlink inside the project", () => {
    const { projects, root } = openScratch();
    const hooks = path.join(root, ".git/hooks/pre-commit");
    for (const bad of [".git/config", ".git/hooks/pre-commit", ".GIT/config", ".Git/hooks/pre-commit", "node_modules/@zvndev/darkmown/package.json"]) {
      expect(projects.read({ path: bad })).toMatchObject({ ok: false, code: "hidden" });
      expect(projects.write({ path: bad, text: "#!/bin/sh\ncurl example.com\n", baseRevision: sha("#!/bin/sh\n") })).toMatchObject({ ok: false, code: "hidden" });
    }
    fs.symlinkSync(path.join(root, ".git/hooks"), path.join(root, "hooks"));
    expect(projects.write({ path: "hooks/pre-commit", text: "#!/bin/sh\ncurl example.com\n", baseRevision: sha("#!/bin/sh\n") })).toMatchObject({ ok: false, code: "hidden" });
    expect(fs.readFileSync(hooks, "utf8")).toBe("#!/bin/sh\n");
  });

  it("refuses everything once the project folder is replaced after it was opened", () => {
    const { projects, root, parent } = openScratch();
    const file = read(projects, "site/pages/index.wd");
    fs.renameSync(root, path.join(parent, "moved-away"));
    write(path.join(root, "site/pages/index.wd"), "# Impostor\n");
    expect(projects.tree()).toMatchObject({ ok: false, code: "moved" });
    expect(projects.read({ path: "site/pages/index.wd" })).toMatchObject({ ok: false, code: "moved" });
    expect(projects.write({ path: "site/pages/index.wd", text: "x", baseRevision: file.revision })).toMatchObject({ ok: false, code: "moved" });
    expect(fs.readFileSync(path.join(root, "site/pages/index.wd"), "utf8")).toBe("# Impostor\n");
  });

  it("refuses a project folder swapped for a symlink to another folder", () => {
    const { projects, root, parent } = openScratch();
    fs.renameSync(root, path.join(parent, "real"));
    fs.symlinkSync(path.join(parent, "real"), root);
    expect(projects.read({ path: "site/pages/index.wd" })).toMatchObject({ ok: false, code: "moved" });
  });

  it("refuses a file that grew past the cap, for reads and writes", () => {
    const { projects, root } = openScratch({ maxFileBytes: 1024 });
    write(path.join(root, "site/pages/big.wd"), "x".repeat(2048));
    expect(projects.read({ path: "site/pages/big.wd" })).toMatchObject({ ok: false, code: "too-large" });
    const small = read(projects, "site/pages/index.wd");
    expect(projects.write({ path: "site/pages/index.wd", text: "é".repeat(600), baseRevision: small.revision })).toMatchObject({ ok: false, code: "too-large" });
    expect(fs.readFileSync(path.join(root, "site/pages/index.wd"), "utf8")).toBe(small.text);
  });

  it("refuses binary files and text that is not UTF-8", () => {
    const { projects, root } = openScratch();
    write(path.join(root, "site/pages/logo.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]));
    write(path.join(root, "site/pages/latin1.txt"), new Uint8Array([0x63, 0x61, 0x66, 0xe9]));
    expect(projects.read({ path: "site/pages/logo.png" })).toMatchObject({ ok: false, code: "binary" });
    expect(projects.read({ path: "site/pages/latin1.txt" })).toMatchObject({ ok: false, code: "binary" });
    const file = read(projects, "site/pages/index.wd");
    expect(projects.write({ path: "site/pages/index.wd", text: "a\u0000b", baseRevision: file.revision })).toMatchObject({ ok: false, code: "binary" });
  });

  it("refuses a folder, and a file that does not exist", () => {
    const { projects } = openScratch();
    expect(projects.read({ path: "site/pages" })).toMatchObject({ ok: false, code: "not-a-file" });
    expect(projects.read({ path: "site/pages/nope.wd" })).toMatchObject({ ok: false, code: "missing" });
    expect(projects.write({ path: "site/pages/nope.wd", text: "x", baseRevision: sha("") })).toMatchObject({ ok: false, code: "missing" });
  });

  it("refuses a save when the file became a symlink after it was opened, and writes nothing through it", () => {
    const { projects, root } = openScratch();
    const target = path.join(root, "site/pages/index.wd");
    const file = read(projects, "site/pages/index.wd");
    const outside = tempDir("markie-m3-outside-");
    write(path.join(outside, "victim.txt"), file.text);
    fs.rmSync(target);
    fs.symlinkSync(path.join(outside, "victim.txt"), target);
    expect(projects.write({ path: "site/pages/index.wd", text: "pwned", baseRevision: file.revision })).toMatchObject({ ok: false, code: "symlink" });
    expect(fs.readFileSync(path.join(outside, "victim.txt"), "utf8")).toBe(file.text);
  });

  it("refuses a save when the file is swapped for a symlink between staging and the rename", () => {
    const { root, parent } = scratchProject();
    const outside = tempDir("markie-m3-outside-");
    const target = path.join(root, "site/pages/index.wd");
    const original = fs.readFileSync(target, "utf8");
    write(path.join(outside, "victim.txt"), original);
    // A filesystem that swaps the file for a symlink the moment the staged
    // temp file is written: the race the rename-time recheck exists for.
    const racing = Object.create(fs);
    racing.writeFileSync = (file: string, ...rest: unknown[]) => {
      (fs.writeFileSync as (...args: unknown[]) => void)(file, ...rest);
      if (String(file).startsWith(`${target}.markie-`)) { fs.rmSync(target); fs.symlinkSync(path.join(outside, "victim.txt"), target); }
    };
    const projects = createLiveDocsProjects({ fs: racing, storePath: path.join(parent, "s.json"), watch: () => Object.assign(new EventEmitter(), { close() {} }) as never });
    const added = projects.add(root);
    if (!added.ok) throw new Error("add failed");
    projects.open({ id: added.project.id });
    const file = read(projects, "site/pages/index.wd");
    expect(projects.write({ path: "site/pages/index.wd", text: "pwned", baseRevision: file.revision })).toMatchObject({ ok: false, code: "symlink" });
    expect(fs.readFileSync(path.join(outside, "victim.txt"), "utf8")).toBe(original);
    expect(fs.readdirSync(path.dirname(target)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("starts no process while saving", () => {
    // The CommonJS module object, which electron/atomic-write.js reads.
    const childProcess = createRequire(import.meta.url)("node:child_process");
    const spawnSync = vi.spyOn(childProcess, "spawnSync");
    const spawn = vi.spyOn(childProcess, "spawn");
    const execFile = vi.spyOn(childProcess, "execFile");
    try {
      const { projects } = openScratch();
      const file = read(projects, "site/pages/index.wd");
      expect(projects.write({ path: "site/pages/index.wd", text: "# Saved\n", baseRevision: file.revision }).ok).toBe(true);
      expect(spawnSync).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(execFile).not.toHaveBeenCalled();
    } finally {
      spawnSync.mockRestore(); spawn.mockRestore(); execFile.mockRestore();
    }
  });
});

describe("parseRelativePath", () => {
  it("accepts plain project paths, including dot files and other dot folders", () => {
    expect(parseRelativePath("site/pages/index.wd")).toEqual(["site", "pages", "index.wd"]);
    expect(parseRelativePath(".env")).toEqual([".env"]);
    expect(parseRelativePath(".github/workflows/ci.yml")).toEqual([".github", "workflows", "ci.yml"]);
  });
  it("refuses a look-alike of .git or node_modules that a case-insensitive disk would treat as the same", () => {
    expect(() => parseRelativePath("node_moduleſ/x/package.json")).toThrow(/node_modules/);
    expect(() => parseRelativePath("ＮＯＤＥ_modules/x")).toThrow(/node_modules/);
  });
});

describe("the project watcher", () => {
  function fakeWatch() {
    const watchers: Array<EventEmitter & { close: ReturnType<typeof vi.fn>; emitChange: (name: string | null) => void; root: string; options: unknown }> = [];
    const watch = vi.fn((root: string, options: unknown, listener: (type: string, name: string | null) => void) => {
      const watcher = Object.assign(new EventEmitter(), { close: vi.fn(), root, options, emitChange: (name: string | null) => listener("change", name) });
      watchers.push(watcher);
      return watcher;
    });
    return { watch, watchers };
  }
  function clock() {
    let time = 1000;
    const timers = new Map<number, { at: number; run: () => void }>();
    let next = 1;
    return {
      now: () => time,
      setTimer: (run: () => void, ms: number) => { const id = next++; timers.set(id, { at: time + ms, run }); return id; },
      clearTimer: (id: number) => { timers.delete(id); },
      advance(ms: number) {
        time += ms;
        for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.run(); }
      },
      pending: () => timers.size,
    };
  }

  it("watches only the open project, recursively, and batches changes", () => {
    const { watch, watchers } = fakeWatch();
    const time = clock();
    const { root, changes, id } = openScratch({ watch: watch as never, setTimer: time.setTimer as never, clearTimer: time.clearTimer as never, now: time.now });
    expect(watch).toHaveBeenCalledTimes(1);
    expect(watchers[0].root).toBe(root);
    expect(watchers[0].options).toMatchObject({ recursive: true, persistent: false });
    watchers[0].emitChange(path.join("site", "pages", "index.wd"));
    watchers[0].emitChange(path.join("site", "pages", "index.skin"));
    time.advance(100);
    expect(changes).toEqual([]);
    time.advance(100);
    expect(changes).toEqual([{ projectId: id, paths: ["site/pages/index.wd", "site/pages/index.skin"], overflow: false, watching: true }]);
  });

  it("ignores .git, node_modules, .DS_Store and Markie's own staging files", () => {
    const { watch, watchers } = fakeWatch();
    const time = clock();
    const { changes } = openScratch({ watch: watch as never, setTimer: time.setTimer as never, clearTimer: time.clearTimer as never, now: time.now });
    for (const name of [".git/index.lock", "node_modules/x/y.js", "site/.DS_Store", "site/pages/index.wd.markie-abc-def-123456.tmp", ".git"]) watchers[0].emitChange(name);
    expect(time.pending()).toBe(0);
    time.advance(5000);
    expect(changes).toEqual([]);
  });

  it("caps a batch and says it overflowed instead of listing thousands of paths", () => {
    const { watch, watchers } = fakeWatch();
    const time = clock();
    const { changes } = openScratch({ watch: watch as never, setTimer: time.setTimer as never, clearTimer: time.clearTimer as never, now: time.now });
    for (let i = 0; i < WATCH_MAX_PATHS + 50; i += 1) watchers[0].emitChange(`site/pages/p${i}.wd`);
    time.advance(200);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ paths: [], overflow: true });
  });

  it("still reports within a second while changes keep arriving", () => {
    const { watch, watchers } = fakeWatch();
    const time = clock();
    const { changes } = openScratch({ watch: watch as never, setTimer: time.setTimer as never, clearTimer: time.clearTimer as never, now: time.now });
    for (let i = 0; i < 20; i += 1) { watchers[0].emitChange("site/pages/index.wd"); time.advance(100); }
    expect(changes.length).toBeGreaterThanOrEqual(1);
  });

  it("closes the watcher when the project closes, is removed, or another opens", () => {
    const { watch, watchers } = fakeWatch();
    const time = clock();
    const s = openScratch({ watch: watch as never, setTimer: time.setTimer as never, clearTimer: time.clearTimer as never, now: time.now });
    expect(s.projects.close()).toEqual({ ok: true });
    expect(watchers[0].close).toHaveBeenCalled();
    watchers[0].emitChange("site/pages/index.wd");
    time.advance(5000);
    expect(s.changes).toEqual([]);

    s.projects.open({ id: s.id });
    const other = scratchProject();
    const added = s.projects.add(other.root);
    if (!added.ok) throw new Error("add failed");
    s.projects.open({ id: added.project.id });
    expect(watchers[1].close).toHaveBeenCalled();
    s.projects.remove({ id: added.project.id });
    expect(watchers[2].close).toHaveBeenCalled();
    expect(s.projects.openId()).toBeNull();
    s.projects.open({ id: s.id });
    s.projects.closeNow();
    expect(watchers[3].close).toHaveBeenCalled();
  });

  it("reports a watcher that failed, once, and stops", () => {
    const { watch, watchers } = fakeWatch();
    const time = clock();
    const { changes, projects } = openScratch({ watch: watch as never, setTimer: time.setTimer as never, clearTimer: time.clearTimer as never, now: time.now });
    watchers[0].emit("error", new Error("EMFILE"));
    expect(changes).toMatchObject([{ overflow: true, watching: false }]);
    expect(watchers[0].close).toHaveBeenCalled();
    expect(projects.tree()).toMatchObject({ ok: true, project: { watching: false } });
  });

  it("sees an edit made outside Markie through the real file watcher", async () => {
    const changes: Array<{ paths: string[]; overflow: boolean }> = [];
    const { root } = scratchProject();
    const projects = createLiveDocsProjects({ storePath: path.join(tempDir(), "s.json"), onChange: (change: { paths: string[]; overflow: boolean }) => changes.push(change) });
    const added = projects.add(root);
    if (!added.ok) throw new Error("add failed");
    projects.open({ id: added.project.id });
    try {
      // FSEvents can take a moment to start delivering on a fresh watch.
      await new Promise((resolve) => setTimeout(resolve, 300));
      fs.writeFileSync(path.join(root, "site/pages/index.skin"), "body\n  color: blue\n");
      const started = Date.now();
      while (Date.now() - started < 8000 && !changes.some((change) => change.overflow || change.paths.includes("site/pages/index.skin"))) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(changes.some((change) => change.overflow || change.paths.includes("site/pages/index.skin"))).toBe(true);
    } finally {
      projects.closeNow();
    }
  });
});

describe("the IPC edge", () => {
  function edge({ enabled = true, trusted = true, picked = null as string | null } = {}) {
    const fake = {
      list: vi.fn(() => ({ ok: true, projects: [] })),
      add: vi.fn(() => ({ ok: true })),
      remove: vi.fn(() => ({ ok: true })),
      open: vi.fn(() => ({ ok: true })),
      close: vi.fn(() => ({ ok: true })),
      tree: vi.fn(() => ({ ok: true })),
      read: vi.fn(() => ({ ok: true })),
      write: vi.fn(() => ({ ok: true })),
    };
    const pickFolder = vi.fn(async () => picked);
    const ipc = createLiveDocsProjectIpc({ service: fake as never, enabled: () => enabled, trusted: () => trusted, pickFolder });
    return { ipc, fake, pickFolder };
  }
  const methods = ["list", "add", "remove", "open", "close", "tree", "read", "write"] as const;

  it.each(methods)("refuses %s when the nightly gate is off in main", async (method) => {
    const { ipc, fake, pickFolder } = edge({ enabled: false });
    expect(await ipc[method]({}, { path: "site/pages/index.wd" } as never)).toMatchObject({ ok: false, code: "unavailable" });
    expect(fake[method]).not.toHaveBeenCalled();
    expect(pickFolder).not.toHaveBeenCalled();
  });

  it.each(methods)("refuses %s from anything but the main window's main frame", async (method) => {
    const { ipc, fake, pickFolder } = edge({ trusted: false });
    expect(await ipc[method]({}, { path: "site/pages/index.wd" } as never)).toMatchObject({ ok: false, code: "forbidden" });
    expect(fake[method]).not.toHaveBeenCalled();
    expect(pickFolder).not.toHaveBeenCalled();
  });

  it("takes a folder only from the picker, never from the renderer", async () => {
    const { ipc, fake, pickFolder } = edge({ picked: "/Users/someone/site" });
    expect(await ipc.add({}, "/etc" as never)).toMatchObject({ ok: false, code: "invalid-request" });
    expect(pickFolder).not.toHaveBeenCalled();
    await ipc.add({});
    expect(fake.add).toHaveBeenCalledWith("/Users/someone/site");
    const canceled = edge({ picked: null });
    expect(await canceled.ipc.add({})).toMatchObject({ ok: false, code: "canceled" });
    expect(canceled.fake.add).not.toHaveBeenCalled();
  });

  it("refuses extra arguments", async () => {
    const { ipc, fake } = edge();
    expect(await ipc.list({}, { path: "x" } as never)).toMatchObject({ ok: false, code: "invalid-request" });
    expect(await ipc.read({}, { path: "x" }, "more" as never)).toMatchObject({ ok: false, code: "invalid-request" });
    expect(fake.list).not.toHaveBeenCalled();
    expect(fake.read).not.toHaveBeenCalled();
  });
});

// main.js cannot load without Electron, so these read its source, the way
// electron/ipc-contract.test.ts and document-files-main.test.ts do.
describe("main.js wiring", () => {
  const source = fs.readFileSync(new URL("./main.js", import.meta.url), "utf8");
  const channels = {
    "live-docs-projects-list": "list",
    "live-docs-projects-add": "add",
    "live-docs-projects-remove": "remove",
    "live-docs-project-open": "open",
    "live-docs-project-close": "close",
    "live-docs-project-tree": "tree",
    "live-docs-project-read": "read",
    "live-docs-project-write": "write",
  };

  it("routes every channel through the guarded IPC edge", () => {
    for (const [channel, method] of Object.entries(channels)) {
      expect(source).toContain(`handle("${channel}", (event, ...args) => liveDocsProjectIpc.${method}(event, ...args));`);
    }
    const setup = source.slice(source.indexOf("const liveDocsProjectIpc = createLiveDocsProjectIpc("), source.indexOf('handle("live-docs-projects-list"'));
    expect(setup).toContain("enabled: nightlyEnabledInMain");
    expect(setup).toContain("trusted: currentCloseSender");
    expect(setup).toContain("dialog.showOpenDialog(mainWindow");
    expect(setup).toContain('properties: ["openDirectory"]');
  });

  it("closes the project watcher on reload, renderer loss, window close, lock and quit", () => {
    const window = source.slice(source.indexOf("const nativeDocumentOwner"), source.indexOf('mainWindow.once("ready-to-show"'));
    expect(window.match(/closeLiveDocsProjectNow\(\)/g)?.length).toBe(3);
    expect(window).toMatch(/once\("destroyed"[^\n]*closeLiveDocsProjectNow\(\)/);
    expect(window).toMatch(/on\("render-process-gone"[^\n]*closeLiveDocsProjectNow\(\)/);
    expect(window).toMatch(/on\("did-start-navigation"[^\n]*closeLiveDocsProjectNow\(\)/);
    const lock = source.slice(source.indexOf("const privateRelease = createPrivateReleaseGate("), source.indexOf("const autoUpdater"));
    expect(lock).toContain("closeLiveDocsProjectNow()");
    const quit = source.slice(source.indexOf('app.on("will-quit"'), source.indexOf("process.on(\"exit\""));
    expect(quit).toContain("closeLiveDocsProjectNow()");
  });

  it("refuses a real IPC event from a subframe, through main's own sender check", async () => {
    const snippet = source.slice(source.indexOf("function currentCloseSender("), source.indexOf('ipcMain.on("app-close-ready"'));
    const mainFrame = { url: "app://markie/index.html" };
    const subFrame = { url: "app://markie/index.html" };
    const webContents = { mainFrame };
    const context: Record<string, unknown> = {
      mainWindow: { webContents, isDestroyed: () => false },
      isAppUrl: (url: string) => url.startsWith("app://markie/"),
    };
    runInNewContext(`${snippet}\nthis.currentCloseSender = currentCloseSender;`, context);
    const trusted = context.currentCloseSender as (event: unknown) => boolean;
    const { root } = scratchProject();
    const projects = createLiveDocsProjects({ storePath: path.join(tempDir(), "s.json"), watch: () => Object.assign(new EventEmitter(), { close() {} }) as never });
    const added = projects.add(root);
    if (!added.ok) throw new Error("add failed");
    projects.open({ id: added.project.id });
    const ipc = createLiveDocsProjectIpc({ service: projects, enabled: () => true, trusted, pickFolder: async () => null });
    expect(await ipc.read({ sender: webContents, senderFrame: subFrame }, { path: "site/pages/index.wd" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await ipc.read({ sender: { mainFrame: subFrame }, senderFrame: mainFrame }, { path: "site/pages/index.wd" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await ipc.read({ sender: webContents, senderFrame: { url: "https://example.com/" } }, { path: "site/pages/index.wd" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await ipc.read({ sender: webContents, senderFrame: mainFrame }, { path: "site/pages/index.wd" })).toMatchObject({ ok: true, file: { path: "site/pages/index.wd" } });
  });
});
