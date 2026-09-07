import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  createSkillRegistry,
  discoverSkills,
  validSkillName,
  parseOwnerRepo,
  insideDir,
  MAX_TARBALL_BYTES,
} = require("./skill-registry.js");

const searchFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "skills-sh-search.json"), "utf8")
);

type Row = {
  path: string;
  target: string;
  name: string;
  source: string | null;
  skill_path: string | null;
  folder_hash: string | null;
  root?: string | null;
  installed_at: string;
};

// The registry tables, in memory. Nothing here reaches ~/.claude or a real
// database: the whole point of the injected store and home is that a test can
// prove the install without writing into the developer's own agent folders.
function makeStore() {
  const sources = new Map<string, string>();
  const installs = new Map<string, Row>();
  return {
    sources,
    installs,
    skillSourcesAll: () => [...sources.entries()].map(([id, added_at]) => ({ id, added_at })),
    skillSourceAdd: (id: string) => {
      if (!sources.has(id)) sources.set(id, new Date().toISOString());
    },
    skillSourceRemove: (id: string) => void sources.delete(id),
    skillInstallsAll: () => [...installs.values()],
    skillInstallGet: (p: string) => installs.get(p),
    skillInstallSet: (row: Row) => void installs.set(row.path, { ...row }),
    skillInstallDelete: (p: string) => void installs.delete(p),
  };
}

function skillDoc(name: string, description: string, extra = "") {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nHow to use it.\n`;
}

// A GitHub source tarball has one wrapping directory, so the fixture has one
// too: everything the discovery rules look at is relative to it.
function buildRepoTarball(dir: string, files: Record<string, string>, executables: string[] = []) {
  const tree = path.join(dir, "repo");
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(tree, "kit-main", rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  for (const rel of executables) fs.chmodSync(path.join(tree, "kit-main", rel), 0o755);
  const archive = path.join(dir, "kit-main.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", tree, "kit-main"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  return fs.readFileSync(archive);
}

const REPO_FILES: Record<string, string> = {
  "skills/pdf/SKILL.md": skillDoc("pdf", "Work with PDF files.", "license: Proprietary\nallowed-tools: Bash(git:*) Read\n"),
  "skills/pdf/reference.md": "# Reference\n",
  "skills/pdf/scripts/run.sh": "#!/bin/sh\necho pdf\n",
  "skills/.curated/deep-dive/SKILL.md": skillDoc("deep-dive", "A curated skill."),
  "skills/.experimental/wip/SKILL.md": skillDoc("wip", "Not finished yet."),
  "skills/.system/plumbing/SKILL.md": skillDoc("plumbing", "Internal machinery.", 'metadata:\n  internal: "true"\n'),
  ".claude/skills/claude-only/SKILL.md": skillDoc("claude-only", "Only for Claude Code."),
  ".agents/skills/universal-one/SKILL.md": skillDoc("universal-one", "For every agent."),
  ".codex/skills/codex-one/SKILL.md": skillDoc("codex-one", "For Codex."),
  "root-skill/SKILL.md": skillDoc("root-skill", "Lives at the repository root."),
  "skills/group/team/nested/SKILL.md": skillDoc("nested", "Three levels inside skills/."),
  "a/b/c/d/too-deep/SKILL.md": skillDoc("too-deep", "Four levels below the root."),
  "node_modules/vendored/SKILL.md": skillDoc("vendored", "Someone else's dependency."),
  ".github/actions/ci/SKILL.md": skillDoc("ci", "A workflow, not a skill."),
  "skills/Shouty_Name/SKILL.md": skillDoc("Shouty_Name", "A name no folder should have."),
  "skills/no-description/SKILL.md": "---\nname: no-description\n---\n\nNothing here.\n",
  "README.md": "# kit\n",
};

const COMMIT = "a".repeat(40);

function response(body: unknown, { status = 200, bytes = null as Buffer | null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    arrayBuffer: async () =>
      bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : new ArrayBuffer(0),
  };
}

describe("skill registry", () => {
  let tmp = "";
  let home = "";
  let cacheDir = "";
  let project = "";
  let roots: string[] = [];
  let store: ReturnType<typeof makeStore>;
  let tarball: Buffer;
  let fetchImpl: ReturnType<typeof vi.fn>;

  function registry(overrides: Record<string, unknown> = {}) {
    return createSkillRegistry({
      home: () => home,
      cacheDir,
      store,
      fetchImpl,
      roots: () => roots,
      version: "0.6.0",
      env: {},
      ...overrides,
    });
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "markie-skills-"));
    home = path.join(tmp, "home");
    cacheDir = path.join(tmp, "cache");
    project = path.join(tmp, "project");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    roots = [project];
    store = makeStore();
    tarball = buildRepoTarball(tmp, REPO_FILES, ["skills/pdf/scripts/run.sh"]);
    fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://codeload.github.com/")) return response(null, { bytes: tarball });
      if (url.startsWith("https://api.github.com/")) return response({ sha: COMMIT });
      if (url.startsWith("https://skills.sh/")) return response(searchFixture);
      throw new Error(`unexpected request to ${url}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // A repository has to be a source before anything fetches it, and adding one
  // fetches it, so every case starts here.
  async function load(overrides: Record<string, unknown> = {}) {
    const skills = registry(overrides);
    const catalog = await skills.addSource("acme/kit");
    return { skills, catalog };
  }

  // ── Discovery ────────────────────────────────────────────────────────────

  it("finds a skill in every container it is allowed to look in", async () => {
    const { catalog } = await load();
    const names = catalog.skills.map((s: { name: string }) => s.name).sort();
    // Shouty_Name is in the catalog: the discovery rules are about where a
    // skill lives, not about whether Markie will make a folder for it. That
    // second question is the install's, and it says no.
    expect(names).toEqual(
      ["Shouty_Name", "claude-only", "codex-one", "deep-dive", "nested", "pdf", "root-skill", "universal-one", "wip"].sort()
    );
  });

  it("leaves out an internal skill, a vendored one, and anything too deep or in a dot folder", async () => {
    const { catalog } = await load();
    const names = catalog.skills.map((s: { name: string }) => s.name);
    expect(names).not.toContain("plumbing");
    expect(names).not.toContain("vendored");
    expect(names).not.toContain("too-deep");
    expect(names).not.toContain("ci");
    expect(names).not.toContain("no-description");
  });

  it("describes a skill from its front matter and lists its files", async () => {
    const { catalog } = await load();
    const pdf = catalog.skills.find((s: { name: string }) => s.name === "pdf");
    expect(pdf.id).toBe("acme/kit/skills/pdf");
    expect(pdf.source).toBe("acme/kit");
    expect(pdf.description).toBe("Work with PDF files.");
    expect(pdf.license).toBe("Proprietary");
    expect(pdf.allowedTools).toBe("Bash(git:*) Read");
    expect(pdf.files.map((f: { path: string }) => f.path).sort()).toEqual([
      "SKILL.md",
      "reference.md",
      "scripts/run.sh",
    ]);
    const script = pdf.files.find((f: { path: string }) => f.path === "scripts/run.sh");
    expect(script.executable).toBe(true);
    expect(script.size).toBeGreaterThan(0);
    expect(pdf.folderHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("records the source, its branch and the commit it read", async () => {
    const { catalog } = await load();
    const source = catalog.sources.find((s: { id: string }) => s.id === "acme/kit");
    expect(source).toMatchObject({ owner: "acme", repo: "kit", ref: "main", commit: COMMIT, builtin: false });
    expect(source.fetchedAt).toBeTruthy();
    expect(source.error).toBeNull();
  });

  it("falls back to master when there is no main branch", async () => {
    fetchImpl.mockImplementation(async (url: string) => {
      if (url.endsWith("/main")) return response(null, { status: 404 });
      if (url.startsWith("https://codeload.github.com/")) return response(null, { bytes: tarball });
      return response({ sha: COMMIT });
    });
    const { catalog } = await load();
    expect(catalog.sources.find((s: { id: string }) => s.id === "acme/kit").ref).toBe("master");
  });

  it("names the cache folder after the tarball when GitHub will not say the commit", async () => {
    fetchImpl.mockImplementation(async (url: string) => {
      if (url.startsWith("https://api.github.com/")) return response({ message: "rate limited" }, { status: 403 });
      return response(null, { bytes: tarball });
    });
    const { catalog } = await load();
    const commit = catalog.sources.find((s: { id: string }) => s.id === "acme/kit").commit;
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(commit).not.toBe(COMMIT);
    expect(fs.existsSync(path.join(cacheDir, "acme", "kit", commit, "skills", "pdf", "SKILL.md"))).toBe(true);
  });

  it("refuses a download that is over the size cap", async () => {
    fetchImpl.mockImplementation(async () => response(null, { bytes: Buffer.alloc(MAX_TARBALL_BYTES + 1) }));
    const { catalog } = await load();
    expect(catalog.skills).toEqual([]);
    expect(store.sources.size).toBe(0);
    expect(catalog.sources.find((s: { id: string }) => s.id === "acme/kit").error).toMatch(/too big/);
  });

  it("does not remember a source that never answered, but does say why", async () => {
    fetchImpl.mockImplementation(async () => {
      throw new Error("offline");
    });
    const { skills, catalog } = await load();
    // Nothing persisted: a row written on the way in stayed in the list
    // forever with nothing behind it.
    expect(store.sources.size).toBe(0);
    // The reason still reaches the panel, which reads failures off the source
    // list, as a row for this session with nothing behind it.
    expect(catalog.sources.find((s: { id: string }) => s.id === "acme/kit")).toMatchObject({
      builtin: false,
      fetchedAt: null,
      commit: null,
      error: "offline",
    });
    // A fresh registry over the same store has no trace of it.
    expect(registry().listCatalog().sources.map((s: { id: string }) => s.id)).not.toContain("acme/kit");
    // And dismissing it clears the reason.
    expect(skills.removeSource("acme/kit").sources.map((s: { id: string }) => s.id)).not.toContain("acme/kit");
  });

  it("refuses an archive that inflates past the cap, and keeps the catalog it had", async () => {
    const { skills } = await load({ maxExpandedBytes: 1024 * 1024 });
    // Two megabytes of zeros compress to about two kilobytes, so the download
    // cap never sees this one coming. The inflate is what has to stop it.
    const bomb = zlib.gzipSync(Buffer.alloc(2 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(MAX_TARBALL_BYTES);
    fetchImpl.mockImplementation(async (url: string) =>
      url.startsWith("https://api.github.com/")
        ? response({ sha: "b".repeat(40) })
        : response(null, { bytes: bomb })
    );
    const catalog = await skills.refresh("acme/kit");
    const source = catalog.sources.find((s: { id: string }) => s.id === "acme/kit");
    expect(source.error).toMatch(/unpacks to more than 1 MB/);
    expect(catalog.skills.some((s: { name: string }) => s.name === "pdf")).toBe(true);
  });

  it("extracts the skill's files and keeps scripts executable", async () => {
    await load();
    const dir = path.join(cacheDir, "acme", "kit", COMMIT, "skills", "pdf");
    expect(fs.readFileSync(path.join(dir, "reference.md"), "utf8")).toBe("# Reference\n");
    expect(fs.statSync(path.join(dir, "scripts", "run.sh")).mode & 0o111).toBeTruthy();
    expect(fs.statSync(path.join(dir, "reference.md")).mode & 0o111).toBe(0);
  });

  it("reads one skill's body and file list out of the cache", async () => {
    const { skills } = await load();
    const read = skills.readSkill("acme/kit/skills/pdf");
    expect(read.body).toContain("# pdf");
    expect(read.body).not.toContain("description:");
    expect(read.files.length).toBe(3);
    expect(skills.readSkill("acme/kit/skills/nope")).toEqual({ body: "", files: [] });
  });

  it("keeps at most two commit folders per source", async () => {
    const { skills } = await load();
    for (const sha of ["b".repeat(40), "c".repeat(40)]) {
      fetchImpl.mockImplementation(async (url: string) => {
        if (url.startsWith("https://api.github.com/")) return response({ sha });
        return response(null, { bytes: tarball });
      });
      await skills.refresh("acme/kit");
    }
    const dirs = fs
      .readdirSync(path.join(cacheDir, "acme", "kit"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(dirs.length).toBe(2);
    expect(dirs).toContain("c".repeat(40));
  });

  // ── The archive is the commit it is filed under ──────────────────────────
  // A branch tarball is whatever the branch holds at the moment of the
  // download, and the head query is a second request. Between the two the
  // branch can move, and then the cache folder is named after one commit and
  // holds another.

  const NEXT = "b".repeat(40);

  // The same repository with one file gone, the way an upstream commit
  // removes it.
  function revisedTarball() {
    const files = { ...REPO_FILES };
    delete files["skills/pdf/reference.md"];
    return buildRepoTarball(path.join(tmp, "revised"), files, ["skills/pdf/scripts/run.sh"]);
  }

  it("downloads the commit the head query named, not whatever the branch serves now", async () => {
    const revised = revisedTarball();
    fetchImpl.mockImplementation(async (url: string) => {
      if (url.startsWith("https://api.github.com/")) return response({ sha: NEXT });
      // The branch has moved on past what the head query answered.
      if (url.includes("/refs/heads/")) return response(null, { bytes: tarball });
      if (url.startsWith("https://codeload.github.com/")) return response(null, { bytes: revised });
      throw new Error(`unexpected request to ${url}`);
    });
    const { catalog } = await load();
    const downloads = fetchImpl.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.startsWith("https://codeload.github.com/"));
    expect(downloads).toEqual([`https://codeload.github.com/acme/kit/tar.gz/${NEXT}`]);
    expect(catalog.sources.find((s: { id: string }) => s.id === "acme/kit").commit).toBe(NEXT);
    const dir = path.join(cacheDir, "acme", "kit", NEXT, "skills", "pdf");
    expect(fs.existsSync(path.join(dir, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "reference.md"))).toBe(false);
  });

  it("extracts a new head into a fresh folder, without a file the commit removed", async () => {
    const { skills } = await load();
    const revised = revisedTarball();
    fetchImpl.mockImplementation(async (url: string) => {
      if (url.startsWith("https://api.github.com/")) return response({ sha: NEXT });
      return response(null, { bytes: revised });
    });
    const catalog = await skills.refresh("acme/kit");
    expect(catalog.sources.find((s: { id: string }) => s.id === "acme/kit").commit).toBe(NEXT);
    const pdf = catalog.skills.find((s: { name: string }) => s.name === "pdf");
    expect(pdf.files.map((f: { path: string }) => f.path)).not.toContain("reference.md");
    expect(fs.existsSync(path.join(cacheDir, "acme", "kit", NEXT, "skills", "pdf", "reference.md"))).toBe(false);
    expect(skills.readSkill("acme/kit/skills/pdf").files.map((f: { path: string }) => f.path)).not.toContain(
      "reference.md"
    );
    // The commit it replaced is kept for a while, and untouched.
    expect(fs.existsSync(path.join(cacheDir, "acme", "kit", COMMIT, "skills", "pdf", "reference.md"))).toBe(true);
  });

  it("does not download again when the head is the commit it already has", async () => {
    const clock = { at: new Date("2026-09-07T10:00:00Z") };
    const { skills } = await load({ clock: () => clock.at });
    const before = fetchImpl.mock.calls.length;
    clock.at = new Date("2026-09-08T12:00:00Z");
    const catalog = await skills.refresh("acme/kit");
    const since = fetchImpl.mock.calls.slice(before).map((call) => String(call[0]));
    expect(since.some((url) => url.startsWith("https://api.github.com/"))).toBe(true);
    expect(since.some((url) => url.startsWith("https://codeload.github.com/"))).toBe(false);
    const source = catalog.sources.find((s: { id: string }) => s.id === "acme/kit");
    expect(source).toMatchObject({ commit: COMMIT, error: null, fetchedAt: "2026-09-08T12:00:00.000Z" });
    expect(catalog.skills.some((s: { name: string }) => s.name === "pdf")).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, "acme", "kit", COMMIT, "skills", "pdf", "reference.md"))).toBe(true);
  });

  it("discovers a large repository in time proportional to its size", () => {
    // Twenty thousand entries, which is what a monorepo of skills looks like
    // and well inside the archive cap. Discovery used to scan every entry once
    // per SKILL.md, so this took seconds and grew with the square of the size.
    const entries: { path: string; size: number; mode: number; data: Buffer }[] = [];
    const count = 5000;
    for (let i = 0; i < count; i++) {
      const dir = `kit-main/skills/skill-${i}`;
      entries.push({
        path: `${dir}/SKILL.md`,
        size: 0,
        mode: 0o644,
        data: Buffer.from(skillDoc(`skill-${i}`, `Skill number ${i}.`)),
      });
      for (const name of ["reference.md", "notes/more.md", "scripts/run.sh"]) {
        entries.push({ path: `${dir}/${name}`, size: 0, mode: 0o644, data: Buffer.from(`# ${i}\n`) });
      }
    }
    const started = performance.now();
    const found = discoverSkills(entries, { owner: "acme", repo: "kit" });
    const elapsed = performance.now() - started;
    expect(found.length).toBe(count);
    // Each skill lists its own files and nobody else's: skill-1's folder is
    // not a prefix of skill-10's.
    const one = found.find((entry: { skill: { name: string } }) => entry.skill.name === "skill-1");
    expect(one.skill.files.map((f: { path: string }) => f.path).sort()).toEqual(
      ["SKILL.md", "notes/more.md", "reference.md", "scripts/run.sh"]
    );
    expect(found.every((entry: { files: unknown[] }) => entry.files.length === 4)).toBe(true);
    // Generous for a loaded machine; the quadratic version takes several times this.
    expect(elapsed).toBeLessThan(2000);
  });

  // ── Sources ──────────────────────────────────────────────────────────────

  it("starts with the three built-in sources and takes an added one", async () => {
    const skills = registry();
    const before = skills.listCatalog();
    expect(before.sources.map((s: { id: string }) => s.id)).toEqual([
      "anthropics/skills",
      "obra/superpowers",
      "openai/skills",
    ]);
    expect(before.sources.every((s: { builtin: boolean }) => s.builtin)).toBe(true);
    const after = await skills.addSource("acme/kit");
    expect(after.sources.map((s: { id: string }) => s.id)).toContain("acme/kit");
    expect(store.sources.has("acme/kit")).toBe(true);
    expect(skills.removeSource("acme/kit").sources.map((s: { id: string }) => s.id)).not.toContain("acme/kit");
  });

  it("refuses anything that is not owner/repo", async () => {
    const skills = registry();
    await skills.addSource("not a repo");
    await skills.addSource("../../etc");
    expect(store.sources.size).toBe(0);
    expect(parseOwnerRepo("owner/repo")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseOwnerRepo("owner/repo/extra")).toBeNull();
  });

  // GitHub does not distinguish Anthropics/Skills from anthropics/skills, and
  // neither does the filesystem the cache lives on for most users. Markie
  // should not either, or one repository becomes two sources sharing a folder.
  it("reads a source id case-blind, so a built-in spelled differently is still built in", async () => {
    expect(parseOwnerRepo("Anthropics/Skills")).toEqual({ owner: "anthropics", repo: "skills" });
    const skills = registry();
    const catalog = await skills.addSource("Anthropics/Skills");
    const ids = catalog.sources.map((s: { id: string }) => s.id);
    expect(ids.filter((id: string) => id.toLowerCase() === "anthropics/skills")).toEqual(["anthropics/skills"]);
    expect(catalog.sources.find((s: { id: string }) => s.id === "anthropics/skills").builtin).toBe(true);
    // A built-in is refreshed, not registered a second time.
    expect(store.sources.size).toBe(0);
    expect(fs.readdirSync(cacheDir)).toEqual(["anthropics"]);
    expect(fs.readdirSync(path.join(cacheDir, "anthropics"))).toEqual(["skills"]);
    expect(catalog.skills.some((s: { source: string }) => s.source === "anthropics/skills")).toBe(true);
  });

  it("keeps one row and one cache folder for a user source however it is spelled", async () => {
    const skills = registry();
    await skills.addSource("Acme/Kit");
    const catalog = await skills.addSource("acme/kit");
    expect([...store.sources.keys()]).toEqual(["acme/kit"]);
    expect(catalog.sources.filter((s: { id: string }) => s.id.toLowerCase() === "acme/kit").length).toBe(1);
    expect(fs.readdirSync(cacheDir)).toEqual(["acme"]);
    expect(fs.readdirSync(path.join(cacheDir, "acme"))).toEqual(["kit"]);
  });

  // Both segments become directory names under the download cache, and
  // removing a source hands that directory to a recursive delete.
  it("refuses a repository name made only of dots", () => {
    for (const bad of ["../..", "a/..", "../a", "a/.", "./.", ".../..."]) {
      expect(parseOwnerRepo(bad), bad).toBeNull();
    }
    expect(parseOwnerRepo("a.b/c.d")).toEqual({ owner: "a.b", repo: "c.d" });
  });

  it("knows what is inside a folder and what is not", () => {
    const root = path.join(tmp, "cache");
    expect(insideDir(root, path.join(root, "acme", "kit"))).toBe(true);
    expect(insideDir(root, root)).toBe(false);
    expect(insideDir(root, path.join(root, "..", ".."))).toBe(false);
    expect(insideDir(root, path.join(root, "acme", "..", "..", "elsewhere"))).toBe(false);
    expect(insideDir(root, `${root}-next`)).toBe(false);
  });

  it("deletes nothing outside the cache when asked to remove a source", async () => {
    const { skills } = await load();
    // What `skill-cache/../..` would have reached: on a real machine, the
    // application support folder Markie's own database lives in.
    const precious = path.join(tmp, "precious");
    fs.mkdirSync(precious, { recursive: true });
    fs.writeFileSync(path.join(precious, "keep.txt"), "not yours\n", "utf8");
    for (const bad of ["../..", "../precious", "a/.."]) {
      skills.removeSource(bad);
    }
    expect(fs.existsSync(path.join(precious, "keep.txt"))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, "acme", "kit", "catalog.json"))).toBe(true);
    expect(store.sources.has("acme/kit")).toBe(true);
  });

  // ── Install ──────────────────────────────────────────────────────────────

  async function installOnce(targets: unknown[] = ["claude"]) {
    const { skills } = await load();
    return { skills, result: skills.install("acme/kit/skills/pdf", targets) };
  }

  it("copies a skill into the tool's folder and remembers that it did", async () => {
    const { result } = await installOnce();
    const dest = path.join(home, ".claude", "skills", "pdf");
    expect(result.errors).toEqual([]);
    expect(result.installed).toEqual([{ target: "claude", targets: ["claude"], path: dest }]);
    expect(fs.readFileSync(path.join(dest, "reference.md"), "utf8")).toBe("# Reference\n");
    expect(fs.statSync(path.join(dest, "scripts", "run.sh")).mode & 0o111).toBeTruthy();
    expect(store.installs.get(dest)).toMatchObject({
      target: "claude",
      name: "pdf",
      source: "acme/kit",
      skill_path: "skills/pdf",
    });
  });

  it("honours CLAUDE_CONFIG_DIR and CODEX_HOME", async () => {
    const { skills } = await load({
      env: { CLAUDE_CONFIG_DIR: path.join(tmp, "cfg"), CODEX_HOME: path.join(tmp, "codex") },
    });
    skills.install("acme/kit/skills/pdf", ["claude", "codex"]);
    expect(fs.existsSync(path.join(tmp, "cfg", "skills", "pdf", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "codex", "skills", "pdf", "SKILL.md"))).toBe(true);
  });

  it("installs into a project only when it is a workspace root", async () => {
    const { skills } = await load();
    const stranger = path.join(tmp, "elsewhere");
    fs.mkdirSync(stranger);
    const good = skills.install("acme/kit/skills/pdf", [{ project }]);
    expect(good.installed[0].path).toBe(path.join(project, ".claude", "skills", "pdf"));
    const bad = skills.install("acme/kit/skills/pdf", [{ project: stranger }]);
    expect(bad.errors[0].error).toBe("no-such-target");
    expect(fs.existsSync(path.join(stranger, ".claude"))).toBe(false);
  });

  it("refuses a name that is not a plain lower-case folder name", async () => {
    const { skills } = await load();
    const result = skills.install("acme/kit/skills/Shouty_Name", ["claude"]);
    expect(result.installed).toEqual([]);
    expect(result.errors[0].error).toBe("invalid-name");
    expect(fs.existsSync(path.join(home, ".claude", "skills"))).toBe(false);
    expect(validSkillName("web-artifacts-builder")).toBe(true);
    expect(validSkillName("../escape")).toBe(false);
    expect(validSkillName("Shouty")).toBe(false);
    expect(validSkillName("a".repeat(65))).toBe(false);
    expect(validSkillName("trailing-")).toBe(false);
  });

  it("refuses an unknown tool rather than guessing a folder", async () => {
    const { skills } = await load();
    const result = skills.install("acme/kit/skills/pdf", ["emacs", { project: "../../etc" }]);
    expect(result.installed).toEqual([]);
    expect(result.errors.map((e: { error: string }) => e.error)).toEqual(["no-such-target", "no-such-target"]);
  });

  it("never replaces a folder Markie did not install", async () => {
    const { skills } = await load();
    const dest = path.join(home, ".claude", "skills", "pdf");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "SKILL.md"), "mine, hand written\n", "utf8");
    const result = skills.install("acme/kit/skills/pdf", ["claude"]);
    expect(result.installed).toEqual([]);
    expect(result.errors[0].error).toBe("exists");
    expect(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8")).toBe("mine, hand written\n");
  });

  it("replaces a folder it did install, which is what Update means", async () => {
    const { skills } = await installOnce();
    const dest = path.join(home, ".claude", "skills", "pdf");
    fs.writeFileSync(path.join(dest, "leftover.md"), "from the old version\n", "utf8");
    const again = skills.install("acme/kit/skills/pdf", ["claude"]);
    expect(again.errors).toEqual([]);
    expect(fs.existsSync(path.join(dest, "leftover.md"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "SKILL.md"))).toBe(true);
  });

  it("refuses to replace a skill that came from a different source", async () => {
    const { skills } = await installOnce();
    const dest = path.join(home, ".claude", "skills", "pdf");
    // A second repository offering a skill by the same name. Owning the folder
    // is not the same as owning it on behalf of anyone who asks.
    const rival = buildRepoTarball(path.join(tmp, "rival"), {
      "skills/pdf/SKILL.md": skillDoc("pdf", "A different pdf skill entirely."),
      "skills/pdf/rival.md": "# Rival\n",
    });
    fetchImpl.mockImplementation(async (url: string) => {
      if (url.startsWith("https://api.github.com/")) return response({ sha: "e".repeat(40) });
      if (url.includes("/rival/kit/")) return response(null, { bytes: rival });
      return response(null, { bytes: tarball });
    });
    await skills.addSource("rival/kit");
    const result = skills.install("rival/kit/skills/pdf", ["claude"]);
    expect(result.installed).toEqual([]);
    expect(result.errors[0].error).toBe("exists");
    expect(result.errors[0].message).toBe("pdf is already installed from acme/kit. Remove it first.");
    expect(fs.existsSync(path.join(dest, "rival.md"))).toBe(false);
    expect(fs.readFileSync(path.join(dest, "reference.md"), "utf8")).toBe("# Reference\n");
    expect(store.installs.get(dest)!.source).toBe("acme/kit");
  });

  // ── The update is a swap, not a delete and a hope ────────────────────────

  it("leaves the version it had when there is nothing to copy from", async () => {
    const { skills } = await installOnce();
    const dest = path.join(home, ".claude", "skills", "pdf");
    const before = { ...store.installs.get(dest)! };
    // The cache the copy reads from goes away between the two installs.
    fs.rmSync(path.join(cacheDir, "acme", "kit", COMMIT, "skills", "pdf"), {
      recursive: true,
      force: true,
    });
    const again = skills.install("acme/kit/skills/pdf", ["claude"]);
    expect(again.installed).toEqual([]);
    expect(again.errors[0].error).toBe("copy-failed");
    expect(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8")).toContain("name: pdf");
    expect(fs.readFileSync(path.join(dest, "reference.md"), "utf8")).toBe("# Reference\n");
    expect(store.installs.get(dest)).toEqual(before);
    expect(fs.readdirSync(path.dirname(dest))).toEqual(["pdf"]);
  });

  // A file with no read permission is how a copy is made to stop part way
  // through. Root reads it anyway, and Windows has no such bit.
  const canDenyRead =
    process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;

  it.skipIf(!canDenyRead)("leaves the version it had when the copy fails half way through", async () => {
    const { skills } = await installOnce();
    const dest = path.join(home, ".claude", "skills", "pdf");
    const before = { ...store.installs.get(dest)! };
    // One file in the cache that cannot be read, so the copy writes some of
    // the folder and then stops: what a disk error or a locked file looks
    // like from here.
    const unreadable = path.join(cacheDir, "acme", "kit", COMMIT, "skills", "pdf", "reference.md");
    fs.chmodSync(unreadable, 0o000);
    let again;
    try {
      again = skills.install("acme/kit/skills/pdf", ["claude"]);
    } finally {
      fs.chmodSync(unreadable, 0o644);
    }
    expect(again.installed).toEqual([]);
    expect(again.errors[0].error).toBe("copy-failed");
    expect(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8")).toContain("name: pdf");
    expect(fs.readFileSync(path.join(dest, "reference.md"), "utf8")).toBe("# Reference\n");
    expect(store.installs.get(dest)).toEqual(before);
    // And no half-copied staging folder is left beside it.
    expect(fs.readdirSync(path.dirname(dest))).toEqual(["pdf"]);
  });

  it("puts the previous folder back when the registry will not take the row", async () => {
    const { skills } = await installOnce();
    const dest = path.join(home, ".claude", "skills", "pdf");
    // Something only the old copy has, so "the previous folder is back" is a
    // different claim from "the new copy is still there".
    fs.writeFileSync(path.join(dest, "only-in-the-old-one.md"), "v1\n", "utf8");
    const before = { ...store.installs.get(dest)! };
    store.skillInstallSet = () => {
      throw new Error("database is locked");
    };
    const again = skills.install("acme/kit/skills/pdf", ["claude"]);
    expect(again.installed).toEqual([]);
    expect(again.errors[0].error).toBe("copy-failed");
    expect(again.errors[0].message).toContain("database is locked");
    expect(fs.readFileSync(path.join(dest, "only-in-the-old-one.md"), "utf8")).toBe("v1\n");
    expect(store.installs.get(dest)).toEqual(before);
    expect(fs.readdirSync(path.dirname(dest))).toEqual(["pdf"]);
  });

  it("cleans up after itself when a first install fails", async () => {
    const { skills } = await load();
    store.skillInstallSet = () => {
      throw new Error("database is locked");
    };
    const result = skills.install("acme/kit/skills/pdf", ["claude"]);
    expect(result.errors[0].error).toBe("copy-failed");
    // Nothing was installed, so nothing may be left behind: a folder with no
    // row is one every later attempt refuses as somebody else's.
    expect(fs.existsSync(path.join(home, ".claude", "skills", "pdf"))).toBe(false);
    expect(fs.readdirSync(path.join(home, ".claude", "skills"))).toEqual([]);
  });

  // ── The row is the record, not a recomputed path ─────────────────────────

  it("removes an install by its recorded path after the tool's folder moves", async () => {
    const env: Record<string, string> = { CODEX_HOME: path.join(home, ".config", "codex-one") };
    const { skills } = await load({ env });
    const dest = path.join(home, ".config", "codex-one", "skills", "pdf");
    expect(skills.install("acme/kit/skills/pdf", ["codex"]).installed).toEqual([
      { target: "codex", targets: ["codex"], path: dest },
    ]);
    // The user points Codex somewhere else. The folder Markie made is still
    // the folder Markie made, and it is still under the home folder.
    env.CODEX_HOME = path.join(home, ".config", "codex-two");
    expect(skills.remove("codex", "pdf")).toEqual({ ok: true });
    expect(fs.existsSync(dest)).toBe(false);
    expect(store.installs.size).toBe(0);
  });

  it("updates the folder it made rather than making a second one", async () => {
    const env: Record<string, string> = { CODEX_HOME: path.join(home, ".config", "codex-one") };
    const { skills } = await load({ env });
    const dest = path.join(home, ".config", "codex-one", "skills", "pdf");
    skills.install("acme/kit/skills/pdf", ["codex"]);
    env.CODEX_HOME = path.join(home, ".config", "codex-two");
    const again = skills.install("acme/kit/skills/pdf", ["codex"]);
    expect(again.errors).toEqual([]);
    expect(again.installed).toEqual([{ target: "codex", targets: ["codex"], path: dest }]);
    expect(fs.existsSync(path.join(home, ".config", "codex-two", "skills", "pdf"))).toBe(false);
    expect(store.installs.size).toBe(1);
  });

  it("will not act on a recorded path that is not a skill folder", async () => {
    const { skills } = await installOnce();
    const dest = path.join(home, ".claude", "skills", "pdf");
    const row = store.installs.get(dest)!;
    store.installs.delete(dest);
    // A corrupt record, pointing at the user's home folder.
    store.installs.set(home, { ...row, path: home });
    const result = skills.remove("claude", "pdf");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not a skill folder");
    expect(fs.existsSync(home)).toBe(true);
    expect(fs.existsSync(path.join(home, ".claude"))).toBe(true);
  });

  it("keeps a project install after the workspace is unregistered", async () => {
    // The project is outside the home folder, so once it is not a workspace
    // root either, nothing about today's roots says the folder is Markie's.
    // The row does: it remembers the root it was installed under.
    const { skills } = await load();
    const dest = path.join(project, ".claude", "skills", "pdf");
    expect(skills.install("acme/kit/skills/pdf", [{ project }]).installed[0].path).toBe(dest);
    expect(store.installs.get(dest)!.root).toBe(project);
    roots = [];
    const again = skills.install("acme/kit/skills/pdf", [{ project }]);
    expect(again.errors).toEqual([]);
    expect(again.installed[0].path).toBe(dest);
    expect(store.installs.size).toBe(1);
    expect(skills.installed().map((row: { path: string }) => row.path)).toEqual([dest]);
    expect(skills.remove({ project }, "pdf")).toEqual({ ok: true });
    expect(fs.existsSync(dest)).toBe(false);
    expect(store.installs.size).toBe(0);
    // A new install there is still gated by today's roots.
    expect(skills.install("acme/kit/skills/pdf", [{ project }]).errors[0].error).toBe("no-such-target");
  });

  it("keeps an install under a config folder the tool has since moved away from", async () => {
    const env: Record<string, string> = { CODEX_HOME: path.join(tmp, "elsewhere") };
    const { skills } = await load({ env });
    const dest = path.join(tmp, "elsewhere", "skills", "pdf");
    expect(skills.install("acme/kit/skills/pdf", ["codex"]).installed).toEqual([
      { target: "codex", targets: ["codex"], path: dest },
    ]);
    expect(store.installs.get(dest)!.root).toBe(path.join(tmp, "elsewhere"));
    env.CODEX_HOME = path.join(home, ".codex");
    const again = skills.install("acme/kit/skills/pdf", ["codex"]);
    expect(again.errors).toEqual([]);
    expect(again.installed[0].path).toBe(dest);
    expect(fs.existsSync(path.join(home, ".codex", "skills", "pdf"))).toBe(false);
    expect(skills.remove("codex", "pdf")).toEqual({ ok: true });
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("will not touch a recorded folder outside every root when the row has no root", async () => {
    // A row from before the root was recorded, pointing outside home and
    // every project: nothing says Markie may write there today.
    const env: Record<string, string> = { CODEX_HOME: path.join(tmp, "elsewhere") };
    const { skills } = await load({ env });
    const dest = path.join(tmp, "elsewhere", "skills", "pdf");
    skills.install("acme/kit/skills/pdf", ["codex"]);
    store.installs.set(dest, { ...store.installs.get(dest)!, root: null });
    env.CODEX_HOME = path.join(home, ".codex");
    const removed = skills.remove("codex", "pdf");
    expect(removed.ok).toBe(false);
    expect(removed.error).toContain("outside every folder Markie may write to");
    expect(fs.existsSync(path.join(dest, "SKILL.md"))).toBe(true);
    expect(store.installs.size).toBe(1);
    // Nor does an update go there, or start a second copy at the new folder.
    const again = skills.install("acme/kit/skills/pdf", ["codex"]);
    expect(again.installed).toEqual([]);
    expect(again.errors[0].error).toBe("copy-failed");
    expect(again.errors[0].message).toContain("outside every folder Markie may write to");
    expect(fs.existsSync(path.join(home, ".codex", "skills", "pdf"))).toBe(false);
    expect(store.installs.size).toBe(1);
    // Pointing the tool back at it is what makes it Markie's again.
    env.CODEX_HOME = path.join(tmp, "elsewhere");
    expect(skills.remove("codex", "pdf")).toEqual({ ok: true });
    expect(fs.existsSync(dest)).toBe(false);
  });

  // ── Two targets, one folder ──────────────────────────────────────────────

  it("installs once when two targets share a folder, and lists both", async () => {
    // Claude Code pointed at the universal folder: both targets resolve to
    // ~/.agents/skills, and the copy that lands there is both installs.
    const { skills } = await load({ env: { CLAUDE_CONFIG_DIR: path.join(home, ".agents") } });
    const dest = path.join(home, ".agents", "skills", "pdf");
    const result = skills.install("acme/kit/skills/pdf", ["claude", "universal"]);
    expect(result.errors).toEqual([]);
    expect(result.installed).toEqual([{ target: "claude", targets: ["claude", "universal"], path: dest }]);
    expect(store.installs.size).toBe(1);
    expect(store.installs.get(dest)!.target).toBe("claude");
    const rows = skills.installed();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target: "claude", targets: ["claude", "universal"], path: dest });
    const pdf = skills.listCatalog().skills.find((s: { name: string }) => s.name === "pdf");
    expect(pdf.installedTo).toEqual([
      { target: "claude", path: dest, upToDate: true },
      { target: "universal", path: dest, upToDate: true },
    ]);
    // Asking for the other target again updates the same row, and does not
    // hand it over.
    const again = skills.install("acme/kit/skills/pdf", ["universal"]);
    expect(again.installed).toEqual([{ target: "universal", targets: ["universal"], path: dest }]);
    expect(store.installs.size).toBe(1);
    expect(store.installs.get(dest)!.target).toBe("claude");
    // And removing under either name removes the one folder.
    expect(skills.remove("universal", "pdf")).toEqual({ ok: true });
    expect(fs.existsSync(dest)).toBe(false);
    expect(store.installs.size).toBe(0);
  });

  // ── The lock file ────────────────────────────────────────────────────────

  it("merges into the lock file without touching another tool's entries", async () => {
    const lock = path.join(home, ".agents", ".skill-lock.json");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(
      lock,
      JSON.stringify({
        version: 3,
        skills: { "someone-elses": { source: "other/repo", sourceType: "github" } },
        dismissed: ["a-skill-they-said-no-to"],
        lastSelectedAgents: ["claude"],
      }),
      "utf8"
    );
    await installOnce();
    const written = JSON.parse(fs.readFileSync(lock, "utf8"));
    expect(written.version).toBe(3);
    expect(written.skills["someone-elses"]).toEqual({ source: "other/repo", sourceType: "github" });
    // The Vercel CLI keeps its own top-level keys in here too.
    expect(written.dismissed).toEqual(["a-skill-they-said-no-to"]);
    expect(written.lastSelectedAgents).toEqual(["claude"]);
    // The shape the Vercel CLI itself writes, read off a real lock file: the
    // .git suffix, and a path to the SKILL.md rather than to its folder.
    expect(written.skills.pdf).toMatchObject({
      source: "acme/kit",
      sourceType: "github",
      sourceUrl: "https://github.com/acme/kit.git",
      ref: "main",
      skillPath: "skills/pdf/SKILL.md",
    });
    expect(written.skills.pdf.skillFolderHash).toMatch(/^[0-9a-f]{40}$/);
    expect(written.skills.pdf.installedAt).toBeTruthy();
  });

  it("creates the lock file when there is not one yet", async () => {
    await installOnce();
    const written = JSON.parse(fs.readFileSync(path.join(home, ".agents", ".skill-lock.json"), "utf8"));
    expect(Object.keys(written.skills)).toEqual(["pdf"]);
  });

  it("leaves a lock file it cannot read alone", async () => {
    const lock = path.join(home, ".agents", ".skill-lock.json");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "not json at all", "utf8");
    const { result } = await installOnce();
    expect(result.installed.length).toBe(1);
    expect(fs.readFileSync(lock, "utf8")).toBe("not json at all");
  });

  // The file is shared with `npx skills`, which reads and writes it in place
  // whenever it runs. Markie's update has to survive that: a write that dies
  // part way must not leave half a file, and an entry the CLI added while
  // Markie was working out its own change must not be lost.

  it("leaves the lock file as it found it when a write dies part way through", async () => {
    const { skills } = await installOnce();
    const lock = path.join(home, ".agents", ".skill-lock.json");
    const before = fs.readFileSync(lock, "utf8");
    const original = fs.writeFileSync;
    // What a full disk or a kill looks like: the file is truncated, some of
    // it lands, and then nothing more does.
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, ...rest) => {
      if (path.basename(String(file)).startsWith(".skill-lock.json")) {
        original(file, String(data).slice(0, 1), ...(rest as []));
        throw new Error("no space left on device");
      }
      return original(file, data, ...(rest as []));
    });
    const result = skills.install("acme/kit/root-skill", ["claude"]);
    vi.restoreAllMocks();
    // The install itself is real: the lock is another tool's record and not
    // a reason to throw the skill away.
    expect(result.installed.length).toBe(1);
    expect(fs.readFileSync(lock, "utf8")).toBe(before);
    expect(Object.keys(JSON.parse(fs.readFileSync(lock, "utf8")).skills)).toEqual(["pdf"]);
    expect(fs.readdirSync(path.dirname(lock))).toEqual([".skill-lock.json"]);
  });

  it("keeps an entry another tool wrote while the change was being worked out", async () => {
    const { skills } = await installOnce();
    const lock = path.join(home, ".agents", ".skill-lock.json");
    const original = fs.readFileSync;
    let raced = false;
    // On Markie's first read of the lock, `npx skills` lands its own entry
    // right after: the bytes Markie got are already stale.
    vi.spyOn(fs, "readFileSync").mockImplementation((file, ...rest) => {
      const text = original(file, ...(rest as []));
      if (!raced && String(file) === lock) {
        raced = true;
        const theirs = JSON.parse(String(text));
        theirs.skills["someone-elses"] = { source: "other/repo", sourceType: "github" };
        fs.writeFileSync(lock, JSON.stringify(theirs), "utf8");
      }
      return text;
    });
    const result = skills.install("acme/kit/root-skill", ["claude"]);
    vi.restoreAllMocks();
    expect(result.installed.length).toBe(1);
    expect(raced).toBe(true);
    const written = JSON.parse(fs.readFileSync(lock, "utf8"));
    expect(Object.keys(written.skills).sort()).toEqual(["pdf", "root-skill", "someone-elses"]);
    expect(written.skills["someone-elses"]).toEqual({ source: "other/repo", sourceType: "github" });
  });

  // ── One name, one source ─────────────────────────────────────────────────
  // The lock has one entry per name, whatever the target, so a name can only
  // ever come from one place.

  async function addRival(skills: ReturnType<typeof registry>) {
    const rival = buildRepoTarball(path.join(tmp, "rival"), {
      "skills/pdf/SKILL.md": skillDoc("pdf", "A different pdf skill entirely."),
      "skills/pdf/rival.md": "# Rival\n",
    });
    fetchImpl.mockImplementation(async (url: string) => {
      if (url.startsWith("https://api.github.com/")) return response({ sha: "e".repeat(40) });
      if (url.includes("/rival/kit/")) return response(null, { bytes: rival });
      return response(null, { bytes: tarball });
    });
    await skills.addSource("rival/kit");
  }

  it("refuses a name already installed from another source, whatever the target", async () => {
    const { skills } = await installOnce(["claude"]);
    await addRival(skills);
    const result = skills.install("rival/kit/skills/pdf", ["codex"]);
    expect(result.installed).toEqual([]);
    expect(result.errors).toEqual([
      { target: "codex", error: "exists", message: "pdf is already installed from acme/kit. Remove it first." },
    ]);
    expect(fs.existsSync(path.join(home, ".codex", "skills", "pdf"))).toBe(false);
    const lock = JSON.parse(fs.readFileSync(path.join(home, ".agents", ".skill-lock.json"), "utf8"));
    expect(lock.skills.pdf.source).toBe("acme/kit");
    // The other way round is the same refusal.
    skills.remove("claude", "pdf");
    expect(skills.install("rival/kit/skills/pdf", ["codex"]).installed.length).toBe(1);
    const back = skills.install("acme/kit/skills/pdf", ["claude", "cursor"]);
    expect(back.installed).toEqual([]);
    expect(back.errors.map((e: { message: string }) => e.message)).toEqual([
      "pdf is already installed from rival/kit. Remove it first.",
      "pdf is already installed from rival/kit. Remove it first.",
    ]);
  });

  it("rebuilds the lock entry from the copy that remains, and drops it with the last one", async () => {
    const { skills } = await installOnce(["claude", "codex"]);
    const lockFile = path.join(home, ".agents", ".skill-lock.json");
    const hash = JSON.parse(fs.readFileSync(lockFile, "utf8")).skills.pdf.skillFolderHash;
    // Another tool has since rewritten the entry with its own idea of pdf.
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    lock.skills.pdf = { source: "other/repo", sourceType: "github", skillFolderHash: "f".repeat(40) };
    fs.writeFileSync(lockFile, JSON.stringify(lock), "utf8");
    expect(skills.remove("claude", "pdf")).toEqual({ ok: true });
    const rebuilt = JSON.parse(fs.readFileSync(lockFile, "utf8")).skills.pdf;
    expect(rebuilt).toMatchObject({
      source: "acme/kit",
      sourceType: "github",
      sourceUrl: "https://github.com/acme/kit.git",
      ref: "main",
      skillPath: "skills/pdf/SKILL.md",
      skillFolderHash: hash,
    });
    expect(skills.remove("codex", "pdf")).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(lockFile, "utf8")).skills).toEqual({});
  });

  // ── Remove and the installed list ────────────────────────────────────────

  it("removes a skill it installed, and its lock entry with it", async () => {
    const { skills } = await installOnce();
    const dest = path.join(home, ".claude", "skills", "pdf");
    expect(skills.remove("claude", "pdf")).toEqual({ ok: true });
    expect(fs.existsSync(dest)).toBe(false);
    expect(store.installs.size).toBe(0);
    const written = JSON.parse(fs.readFileSync(path.join(home, ".agents", ".skill-lock.json"), "utf8"));
    expect(written.skills).toEqual({});
  });

  it("keeps the lock entry while another copy of the skill is still installed", async () => {
    const { skills } = await installOnce(["claude", "cursor"]);
    skills.remove("claude", "pdf");
    const written = JSON.parse(fs.readFileSync(path.join(home, ".agents", ".skill-lock.json"), "utf8"));
    expect(Object.keys(written.skills)).toEqual(["pdf"]);
  });

  it("refuses to remove a folder it has no row for", async () => {
    const skills = registry();
    const dest = path.join(home, ".claude", "skills", "pdf");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "SKILL.md"), "mine\n", "utf8");
    const result = skills.remove("claude", "pdf");
    expect(result.ok).toBe(false);
    expect(fs.existsSync(dest)).toBe(true);
  });

  it("lists what is installed, with the description and whether an update is waiting", async () => {
    const { skills } = await installOnce();
    const rows = skills.installed();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "pdf",
      target: "claude",
      targets: ["claude"],
      source: "acme/kit",
      description: "Work with PDF files.",
      updateAvailable: false,
      installedByMarkie: true,
    });

    // The source moves on: same skill, different bytes, so the catalog hash no
    // longer matches the one recorded at install time.
    tarball = buildRepoTarball(
      path.join(tmp, "next"),
      { ...REPO_FILES, "skills/pdf/reference.md": "# Reference, revised\n" },
      ["skills/pdf/scripts/run.sh"]
    );
    fetchImpl.mockImplementation(async (url: string) => {
      if (url.startsWith("https://api.github.com/")) return response({ sha: "d".repeat(40) });
      return response(null, { bytes: tarball });
    });
    await skills.refresh("acme/kit");
    expect(skills.installed()[0].updateAvailable).toBe(true);
    const pdf = skills.listCatalog().skills.find((s: { name: string }) => s.name === "pdf");
    expect(pdf.installedTo).toEqual([
      { target: "claude", path: path.join(home, ".claude", "skills", "pdf"), upToDate: false },
    ]);
  });

  // ── skills.sh ────────────────────────────────────────────────────────────

  it("maps a skills.sh answer to hits, and asks for nothing under two characters", async () => {
    const skills = registry();
    expect(await skills.search("p")).toEqual([]);
    const hits = await skills.search("pdf");
    expect(hits[0]).toEqual({
      id: "anthropics/skills/pdf",
      name: "pdf",
      source: "anthropics/skills",
      installs: 192000,
    });
    expect(hits.length).toBe(searchFixture.skills.length);
  });

  it("degrades to nothing when skills.sh is unreachable or answers rubbish", async () => {
    const skills = registry();
    fetchImpl.mockImplementation(async () => {
      throw new Error("offline");
    });
    expect(await skills.search("pdf")).toEqual([]);
    fetchImpl.mockImplementation(async () => response("<html>maintenance</html>"));
    expect(await skills.search("pdf")).toEqual([]);
  });

  // ── Staleness ────────────────────────────────────────────────────────────

  it("only re-fetches a source with no name given once its catalog is a day old", async () => {
    const clock = { at: new Date("2026-09-07T10:00:00Z") };
    const { skills } = await load({ clock: () => clock.at });
    const calls = fetchImpl.mock.calls.length;
    await skills.refresh();
    expect(fetchImpl.mock.calls.length).toBe(calls + 6); // the three defaults, tarball plus commit
    clock.at = new Date("2026-09-08T11:00:00Z");
    await skills.refresh();
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(calls + 6);
  });
});
