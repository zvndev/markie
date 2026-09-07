import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  createSkillRegistry,
  validSkillName,
  parseOwnerRepo,
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
  let store: ReturnType<typeof makeStore>;
  let tarball: Buffer;
  let fetchImpl: ReturnType<typeof vi.fn>;

  function registry(overrides: Record<string, unknown> = {}) {
    return createSkillRegistry({
      home: () => home,
      cacheDir,
      store,
      fetchImpl,
      roots: () => [project],
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
    expect(pdf.folderHash).toMatch(/^[0-9a-f]{64}$/);
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
      if (url.endsWith("/refs/heads/main")) return response(null, { status: 404 });
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
    expect(catalog.sources.find((s: { id: string }) => s.id === "acme/kit").error).toMatch(/too big/);
    expect(catalog.skills).toEqual([]);
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

  // ── Install ──────────────────────────────────────────────────────────────

  async function installOnce(targets: unknown[] = ["claude"]) {
    const { skills } = await load();
    return { skills, result: skills.install("acme/kit/skills/pdf", targets) };
  }

  it("copies a skill into the tool's folder and remembers that it did", async () => {
    const { result } = await installOnce();
    const dest = path.join(home, ".claude", "skills", "pdf");
    expect(result.errors).toEqual([]);
    expect(result.installed).toEqual([{ target: "claude", path: dest }]);
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

  // ── The lock file ────────────────────────────────────────────────────────

  it("merges into the lock file without touching another tool's entries", async () => {
    const lock = path.join(home, ".agents", ".skill-lock.json");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(
      lock,
      JSON.stringify({ version: 3, skills: { "someone-elses": { source: "other/repo", sourceType: "github" } } }),
      "utf8"
    );
    await installOnce();
    const written = JSON.parse(fs.readFileSync(lock, "utf8"));
    expect(written.version).toBe(3);
    expect(written.skills["someone-elses"]).toEqual({ source: "other/repo", sourceType: "github" });
    expect(written.skills.pdf).toMatchObject({
      source: "acme/kit",
      sourceType: "github",
      sourceUrl: "https://github.com/acme/kit",
      ref: "main",
      skillPath: "skills/pdf",
    });
    expect(written.skills.pdf.skillFolderHash).toMatch(/^[0-9a-f]{64}$/);
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
