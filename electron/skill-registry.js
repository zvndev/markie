// The skill catalog: what can be installed, what is installed, and the copy in
// between.
//
// Three rules shape everything here.
//
// Nothing is ever executed. A skill is a folder of markdown and scripts written
// by a stranger; Markie downloads it, reads its front matter and copies files.
// It never runs one, and it never asks a package manager to.
//
// Nothing is ever overwritten that Markie did not put there. A folder at the
// destination with no row in `skill_installs` belongs to the user or to another
// tool, and the install refuses rather than replacing it.
//
// Installs are copies, never symlinks. A symlink needs Developer Mode on
// Windows, and the Vercel CLI falls back to copying for the same reason, so a
// copy is the only form both tools agree on.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { parseTar } = require("./ustar");
const { parseFrontmatter } = require("./skill-frontmatter");

// The three repositories every install starts with. They are not rows: a user
// can add sources and remove the ones they added, but these come back.
const DEFAULT_SOURCES = [
  { owner: "anthropics", repo: "skills" },
  { owner: "obra", repo: "superpowers" },
  { owner: "openai", repo: "skills" },
];

const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// The name is also a directory name in someone's home folder, so it is the
// narrow shape the agent tools all agree on and nothing else.
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_SKILL_NAME = 64;
// A source tarball this size is not a skill repository, it is an accident or an
// attack, and it arrives in memory.
const MAX_TARBALL_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30000;
const SEARCH_TIMEOUT_MS = 8000;
const STALE_MS = 24 * 60 * 60 * 1000;
// Two commits per source: the one in use, and the one it just replaced, so a
// catalog written moments ago still resolves while the new files land.
const KEEP_COMMITS = 2;
const BRANCHES = ["main", "master"];

// Where a repository is allowed to keep skills, and how deep inside each of
// those a skill folder may sit. The containers overlap on purpose: a skill in
// `skills/.curated/x` is one level inside that container even though it is two
// inside `skills/`.
const CONTAINERS = [
  "",
  "skills",
  "skills/.curated",
  "skills/.experimental",
  "skills/.system",
  ".claude/skills",
  ".agents/skills",
  ".codex/skills",
];
const MAX_CONTAINER_DEPTH = 3;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

const SKILLS_SH_SEARCH = "https://skills.sh/api/search";
const LOCK_VERSION = 3;

/** SHA-256 over every file in a folder: the sorted `path\0bytes` of each. */
function folderHash(entries) {
  const hash = crypto.createHash("sha256");
  const ordered = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of ordered) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.data);
  }
  return hash.digest("hex");
}

/** `owner/repo` → `{ owner, repo }`, or null when it is not that shape. */
function parseOwnerRepo(value) {
  const text = String(value ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!OWNER_REPO_RE.test(text)) return null;
  const [owner, repo] = text.split("/");
  return { owner, repo };
}

/** Is this a name Markie will create a folder for? */
function validSkillName(name) {
  const text = String(name ?? "");
  return text.length > 0 && text.length <= MAX_SKILL_NAME && SKILL_NAME_RE.test(text);
}

// How many levels below one of the containers this directory sits, or 0 when it
// is not inside any of them. Dot-directories only count when the container
// itself names them, so `.claude/skills/x` is a skill and `.github/x` is not.
function containerDepth(dir) {
  if (!dir) return 0;
  if (dir.split("/").some((segment) => SKIP_DIRS.has(segment))) return 0;
  let best = 0;
  for (const container of CONTAINERS) {
    const prefix = container ? `${container}/` : "";
    if (prefix && !dir.startsWith(prefix)) continue;
    const rest = dir.slice(prefix.length);
    if (!rest) continue;
    const segments = rest.split("/");
    if (segments.some((segment) => segment.startsWith("."))) continue;
    if (segments.length <= MAX_CONTAINER_DEPTH && (!best || segments.length < best)) {
      best = segments.length;
    }
  }
  return best;
}

// GitHub wraps a source tarball in one directory named after the repository and
// the branch. Every path in the catalog is relative to the repository itself.
function stripArchiveRoot(files) {
  if (!files.length) return files;
  const root = files[0].path.split("/")[0];
  if (!files.every((file) => file.path.startsWith(`${root}/`))) return files;
  return files.map((file) => ({ ...file, path: file.path.slice(root.length + 1) }));
}

function stringField(fields, key) {
  const value = fields[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function metadataField(fields) {
  const value = fields.metadata;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

/**
 * Read a repository's tar entries into catalog rows.
 *
 * @param {{ path: string, size: number, mode: number, data: Buffer }[]} entries
 * @param {{ owner: string, repo: string }} source
 * @returns {{ skill: object, files: { path: string, data: Buffer, mode: number }[] }[]}
 */
function discoverSkills(entries, { owner, repo }) {
  const files = stripArchiveRoot(entries).filter(
    (file) => !file.path.split("/").some((segment) => SKIP_DIRS.has(segment))
  );
  const found = [];
  const seen = new Set();
  for (const file of files) {
    if (!file.path.endsWith("/SKILL.md")) continue;
    const skillPath = file.path.slice(0, -"/SKILL.md".length);
    if (seen.has(skillPath)) continue;
    if (!containerDepth(skillPath)) continue;
    const { fields } = parseFrontmatter(file.data.toString("utf8"));
    const name = stringField(fields, "name");
    const description = stringField(fields, "description");
    if (!name || !description) continue;
    const metadata = metadataField(fields);
    // A skill a repository marks internal is machinery for its own agents, not
    // something to offer a user.
    if (metadata.internal === "true") continue;
    seen.add(skillPath);

    const prefix = `${skillPath}/`;
    const own = files
      .filter((entry) => entry.path.startsWith(prefix))
      .map((entry) => ({ path: entry.path.slice(prefix.length), data: entry.data, mode: entry.mode }));
    found.push({
      files: own,
      skill: {
        id: `${owner}/${repo}/${skillPath}`,
        source: `${owner}/${repo}`,
        skillPath,
        name,
        description,
        license: stringField(fields, "license"),
        compatibility: stringField(fields, "compatibility"),
        allowedTools: stringField(fields, "allowed-tools"),
        metadata,
        files: own.map((entry) => ({
          path: entry.path,
          size: entry.data.length,
          executable: Boolean(entry.mode & 0o111),
        })),
        folderHash: folderHash(own),
      },
    });
  }
  return found.sort((a, b) => (a.skill.id < b.skill.id ? -1 : a.skill.id > b.skill.id ? 1 : 0));
}

/**
 * @param {object} [deps]
 * @param {() => string} [deps.home] the user's home directory
 * @param {string} [deps.cacheDir] where downloaded skill folders are kept
 * @param {object} [deps.store] the registry tables (see electron/registry.js)
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => string[]} [deps.roots] workspace roots, the only allowed projects
 * @param {string} [deps.version] Markie's version, for the User-Agent
 * @param {Record<string, string | undefined>} [deps.env]
 * @param {() => Date} [deps.clock]
 */
function createSkillRegistry(deps = {}) {
  const home = deps.home || (() => os.homedir());
  const env = deps.env || process.env;
  const clock = deps.clock || (() => new Date());
  const fetchImpl = deps.fetchImpl || ((...args) => globalThis.fetch(...args));
  const roots = deps.roots || (() => []);
  const version = deps.version || "0.0.0";
  const store = deps.store || require("./registry");
  // Required lazily for the same reason registry.js defers better-sqlite3:
  // `require("electron")` throws outside the app, and every test supplies its
  // own directory rather than reaching for the real one.
  const cacheRoot = () =>
    deps.cacheDir || path.join(require("electron").app.getPath("userData"), "skill-cache");
  const userAgent = `Markie/${version}`;
  // A failed fetch has nowhere on disk to live when the source has never been
  // fetched at all, so the reason is remembered for this session.
  const errors = new Map();

  const nowIso = () => clock().toISOString();
  const sourceDir = (owner, repo) => path.join(cacheRoot(), owner, repo);
  const catalogFile = (owner, repo) => path.join(sourceDir(owner, repo), "catalog.json");

  // ── Sources ──────────────────────────────────────────────────────────────

  function sources() {
    const out = DEFAULT_SOURCES.map((s) => ({ ...s, builtin: true }));
    const known = new Set(out.map((s) => `${s.owner}/${s.repo}`));
    let rows = [];
    try {
      rows = store.skillSourcesAll();
    } catch {
      rows = [];
    }
    for (const row of rows) {
      const parsed = parseOwnerRepo(row.id);
      if (!parsed || known.has(row.id)) continue;
      known.add(row.id);
      out.push({ ...parsed, builtin: false });
    }
    return out;
  }

  function readCatalog(owner, repo) {
    try {
      return JSON.parse(fs.readFileSync(catalogFile(owner, repo), "utf8"));
    } catch {
      return null;
    }
  }

  // ── Fetch ────────────────────────────────────────────────────────────────

  async function readCapped(response, controller) {
    const body = response.body;
    if (!body || typeof body.getReader !== "function") {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_TARBALL_BYTES) throw new Error(tooLarge());
      return buffer;
    }
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_TARBALL_BYTES) {
        controller.abort();
        throw new Error(tooLarge());
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  function tooLarge() {
    return `That repository's download is over ${Math.round(MAX_TARBALL_BYTES / 1024 / 1024)} MB, which is too big to be a skill repository.`;
  }

  async function downloadTarball(owner, repo) {
    let lastStatus = 0;
    for (const branch of BRANCHES) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await fetchImpl(
          `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/${branch}`,
          { headers: { "User-Agent": userAgent }, signal: controller.signal }
        );
        if (response.status === 404) {
          lastStatus = 404;
          continue;
        }
        if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${owner}/${repo}.`);
        return { bytes: await readCapped(response, controller), branch };
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(
      lastStatus === 404
        ? `${owner}/${repo} has no main or master branch, or it is not a public repository.`
        : `${owner}/${repo} could not be downloaded.`
    );
  }

  // The repository's head commit, which names the cache folder. The API is
  // rate-limited without a token, and being rate-limited must not stop a
  // catalog from being built, so the tarball's own digest stands in.
  async function headCommit(owner, repo, branch, bytes) {
    try {
      const response = await fetchImpl(
        `https://api.github.com/repos/${owner}/${repo}/commits/${branch}`,
        {
          headers: { "User-Agent": userAgent, Accept: "application/vnd.github+json" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        }
      );
      if (response.ok) {
        const body = await response.json();
        if (body && typeof body.sha === "string" && /^[0-9a-f]{7,40}$/.test(body.sha)) {
          return { commit: body.sha, commitSource: "api" };
        }
      }
    } catch {
      // offline, rate-limited, or answering something that is not JSON
    }
    return { commit: crypto.createHash("sha1").update(bytes).digest("hex"), commitSource: "tarball" };
  }

  // Everything a skill folder holds, under `<cache>/<owner>/<repo>/<commit>/`.
  // The executable bit only survives for `scripts/`, which is the one place a
  // skill's own instructions tell an agent to run something from.
  function extract(dir, discovered) {
    for (const { skill, files } of discovered) {
      for (const file of files) {
        const target = path.join(dir, skill.skillPath, file.path);
        if (!path.resolve(target).startsWith(path.resolve(dir) + path.sep)) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.data);
        if (file.path.startsWith("scripts/") && file.mode & 0o111) {
          try {
            fs.chmodSync(target, 0o755);
          } catch {
            // a filesystem without modes: the file is still there
          }
        }
      }
    }
  }

  // Keep the commit just written and the one before it, and drop the rest, so
  // a source refreshed every week does not accumulate a copy of itself each
  // time. Sorting by mtime cannot be trusted to put the new folder first (two
  // writes inside the same millisecond tie), so it is named and never dropped.
  function pruneCommits(owner, repo, current) {
    const dir = sourceDir(owner, repo);
    let names = [];
    try {
      names = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return;
    }
    const dated = names
      .filter((name) => name !== current)
      .map((name) => {
        try {
          return { name, at: fs.statSync(path.join(dir, name)).mtimeMs };
        } catch {
          return { name, at: 0 };
        }
      })
      .sort((a, b) => b.at - a.at);
    for (const entry of dated.slice(KEEP_COMMITS - 1)) {
      fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
    }
  }

  async function fetchSource(source) {
    const { owner, repo } = source;
    const { bytes, branch } = await downloadTarball(owner, repo);
    let archive;
    try {
      archive = zlib.gunzipSync(bytes);
    } catch {
      throw new Error(`${owner}/${repo} did not download as a readable archive.`);
    }
    const discovered = discoverSkills(parseTar(archive), { owner, repo });
    const { commit, commitSource } = await headCommit(owner, repo, branch, bytes);
    const dir = path.join(sourceDir(owner, repo), commit);
    fs.mkdirSync(dir, { recursive: true });
    extract(dir, discovered);
    const catalog = {
      owner,
      repo,
      ref: branch,
      commit,
      commitSource,
      fetchedAt: nowIso(),
      error: null,
      skills: discovered.map((entry) => entry.skill),
    };
    fs.mkdirSync(sourceDir(owner, repo), { recursive: true });
    fs.writeFileSync(catalogFile(owner, repo), `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    pruneCommits(owner, repo, commit);
    errors.delete(`${owner}/${repo}`);
    return catalog;
  }

  // ── Catalog ──────────────────────────────────────────────────────────────

  function installRows() {
    try {
      return store.skillInstallsAll();
    } catch {
      return [];
    }
  }

  function installedTo(skill, rows) {
    return rows
      .filter((row) => row.source === skill.source && row.skill_path === skill.skillPath)
      .map((row) => ({
        target: targetFromKey(row.target),
        path: row.path,
        upToDate: row.folder_hash === skill.folderHash,
      }))
      .filter((entry) => entry.target !== null);
  }

  function listCatalog() {
    const rows = installRows();
    const out = { sources: [], skills: [] };
    for (const source of sources()) {
      const id = `${source.owner}/${source.repo}`;
      const catalog = readCatalog(source.owner, source.repo);
      out.sources.push({
        id,
        owner: source.owner,
        repo: source.repo,
        ref: catalog?.ref ?? null,
        commit: catalog?.commit ?? null,
        fetchedAt: catalog?.fetchedAt ?? null,
        builtin: source.builtin,
        error: errors.get(id) ?? null,
      });
      for (const skill of catalog?.skills ?? []) {
        out.skills.push({ ...skill, installedTo: installedTo(skill, rows) });
      }
    }
    return out;
  }

  function isStale(catalog) {
    if (!catalog || !catalog.fetchedAt) return true;
    const at = Date.parse(catalog.fetchedAt);
    return !Number.isFinite(at) || clock().getTime() - at >= STALE_MS;
  }

  // With a source named, the user asked for that one and it is fetched. With no
  // source, this is the periodic catch-up and only stale catalogs are fetched.
  async function refresh(source) {
    const named = source ? parseOwnerRepo(source) : null;
    if (source && !named) return listCatalog();
    const wanted = named
      ? sources().filter((s) => s.owner === named.owner && s.repo === named.repo)
      : sources();
    for (const entry of wanted) {
      const id = `${entry.owner}/${entry.repo}`;
      if (!named && !isStale(readCatalog(entry.owner, entry.repo))) continue;
      try {
        await fetchSource(entry);
      } catch (err) {
        errors.set(id, err && err.message ? err.message : String(err));
      }
    }
    return listCatalog();
  }

  async function addSource(ownerRepo) {
    const parsed = parseOwnerRepo(ownerRepo);
    if (!parsed) return listCatalog();
    const id = `${parsed.owner}/${parsed.repo}`;
    store.skillSourceAdd(id);
    try {
      await fetchSource(parsed);
    } catch (err) {
      errors.set(id, err && err.message ? err.message : String(err));
    }
    return listCatalog();
  }

  function removeSource(ownerRepo) {
    const parsed = parseOwnerRepo(ownerRepo);
    if (!parsed) return listCatalog();
    const id = `${parsed.owner}/${parsed.repo}`;
    store.skillSourceRemove(id);
    errors.delete(id);
    // The download is disposable; the installs it produced are not, and their
    // rows are keyed by destination rather than by source.
    fs.rmSync(sourceDir(parsed.owner, parsed.repo), { recursive: true, force: true });
    return listCatalog();
  }

  // ── skills.sh ────────────────────────────────────────────────────────────
  // Undocumented, so every failure is silent and answers with nothing. The
  // catalogs Markie already holds are the real search; this only widens it.
  async function search(query) {
    const text = String(query ?? "").trim();
    if (text.length < 2) return [];
    try {
      const url = `${SKILLS_SH_SEARCH}?q=${encodeURIComponent(text)}&limit=20`;
      const response = await fetchImpl(url, {
        headers: { "User-Agent": userAgent, Accept: "application/json" },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      if (!response.ok) return [];
      const body = await response.json();
      const hits = Array.isArray(body) ? body : Array.isArray(body?.skills) ? body.skills : [];
      return hits
        .map((hit) => ({
          id: typeof hit?.id === "string" ? hit.id : "",
          name: typeof hit?.name === "string" ? hit.name : "",
          source: typeof hit?.source === "string" ? hit.source : "",
          installs: Number.isFinite(hit?.installs) ? hit.installs : 0,
        }))
        .filter((hit) => hit.id && hit.name);
    } catch {
      return [];
    }
  }

  // ── Reading one skill out of the cache ───────────────────────────────────

  function findSkill(id) {
    const text = String(id ?? "");
    const parts = text.split("/");
    if (parts.length < 3) return null;
    const owner = parts[0];
    const repo = parts[1];
    const catalog = readCatalog(owner, repo);
    const skill = catalog?.skills?.find((entry) => entry.id === text);
    if (!skill) return null;
    return { skill, catalog, dir: path.join(sourceDir(owner, repo), catalog.commit, skill.skillPath) };
  }

  function readSkill(id) {
    const found = findSkill(id);
    if (!found) return { body: "", files: [] };
    let markdown = "";
    try {
      markdown = fs.readFileSync(path.join(found.dir, "SKILL.md"), "utf8");
    } catch {
      return { body: "", files: found.skill.files };
    }
    return { body: parseFrontmatter(markdown).body, files: found.skill.files };
  }

  // ── Targets ──────────────────────────────────────────────────────────────

  function targetDir(target) {
    if (typeof target === "string") {
      switch (target) {
        // Claude Code and Codex both let the user move their config folder, and
        // installing into the folder they are not reading is a silent failure.
        case "claude":
          return path.join(env.CLAUDE_CONFIG_DIR || path.join(home(), ".claude"), "skills");
        case "codex":
          return path.join(env.CODEX_HOME || path.join(home(), ".codex"), "skills");
        case "cursor":
          return path.join(home(), ".cursor", "skills");
        case "gemini":
          return path.join(home(), ".gemini", "skills");
        case "universal":
          return path.join(home(), ".agents", "skills");
        default:
          return null;
      }
    }
    if (target && typeof target.project === "string") {
      const project = path.resolve(target.project);
      // Only a folder the user registered as a workspace root. Anything else
      // would let a renderer name any directory on the machine.
      const allowed = (roots() || []).some((root) => path.resolve(root) === project);
      if (!allowed) return null;
      return path.join(project, ".claude", "skills");
    }
    return null;
  }

  function targetKey(target) {
    if (typeof target === "string") return target;
    if (target && typeof target.project === "string") return `project:${path.resolve(target.project)}`;
    return "";
  }

  function targetFromKey(key) {
    const text = String(key ?? "");
    if (text.startsWith("project:")) return { project: text.slice("project:".length) };
    return ["claude", "codex", "cursor", "gemini", "universal"].includes(text) ? text : null;
  }

  // ── The lock file the Vercel CLI also reads ──────────────────────────────
  // Shared with `npx skills`, so a merge only ever touches this skill's entry.
  // A file we cannot parse is left alone: it is another tool's record, and
  // rewriting it from scratch would delete installs Markie knows nothing about.

  function lockPath() {
    return path.join(home(), ".agents", ".skill-lock.json");
  }

  function readLock() {
    try {
      const parsed = JSON.parse(fs.readFileSync(lockPath(), "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      if (!parsed.skills || typeof parsed.skills !== "object") parsed.skills = {};
      return parsed;
    } catch (err) {
      return err && err.code === "ENOENT" ? { version: LOCK_VERSION, skills: {} } : null;
    }
  }

  function writeLock(lock) {
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    fs.writeFileSync(lockPath(), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  }

  function mergeLock(name, entry) {
    const lock = readLock();
    if (!lock) return;
    lock.version = LOCK_VERSION;
    const existing = lock.skills[name];
    lock.skills[name] = {
      ...entry,
      installedAt: existing?.installedAt || entry.installedAt,
    };
    writeLock(lock);
  }

  function dropFromLock(name) {
    const lock = readLock();
    if (!lock || !lock.skills[name]) return;
    delete lock.skills[name];
    writeLock(lock);
  }

  // ── Install and remove ───────────────────────────────────────────────────

  function install(id, targets) {
    const found = findSkill(id);
    const installed = [];
    const errorsOut = [];
    if (!found) {
      for (const target of targets || []) {
        errorsOut.push({
          target,
          error: "copy-failed",
          message: "That skill is not in the catalog any more. Refresh its source and try again.",
        });
      }
      return { installed, errors: errorsOut };
    }
    const { skill } = found;
    for (const target of targets || []) {
      if (!validSkillName(skill.name)) {
        errorsOut.push({
          target,
          error: "invalid-name",
          message: `"${skill.name}" is not a name Markie will create a folder for.`,
        });
        continue;
      }
      const dir = targetDir(target);
      if (!dir) {
        errorsOut.push({
          target,
          error: "no-such-target",
          message: "Markie does not know where to put a skill for that tool.",
        });
        continue;
      }
      const destination = path.join(dir, skill.name);
      if (!path.resolve(destination).startsWith(path.resolve(dir) + path.sep)) {
        errorsOut.push({
          target,
          error: "invalid-name",
          message: `"${skill.name}" would be written outside ${dir}.`,
        });
        continue;
      }
      const row = store.skillInstallGet(destination);
      if (fs.existsSync(destination) && !row) {
        errorsOut.push({
          target,
          error: "exists",
          message: `There is already a folder at ${destination} that Markie did not install.`,
        });
        continue;
      }
      try {
        fs.rmSync(destination, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        fs.cpSync(found.dir, destination, { recursive: true });
        const at = nowIso();
        store.skillInstallSet({
          path: destination,
          target: targetKey(target),
          name: skill.name,
          source: skill.source,
          skill_path: skill.skillPath,
          folder_hash: skill.folderHash,
          installed_at: at,
        });
        // `sourceUrl` carries the .git suffix and `skillPath` points at the
        // SKILL.md rather than its folder, because that is what the Vercel CLI
        // writes: this file is shared with it, so Markie's entries should read
        // the same as its own. `ref` is Markie's own addition; the CLI ignores
        // keys it does not know.
        mergeLock(skill.name, {
          source: skill.source,
          sourceType: "github",
          sourceUrl: `https://github.com/${skill.source}.git`,
          ref: found.catalog.ref,
          skillPath: `${skill.skillPath}/SKILL.md`,
          skillFolderHash: skill.folderHash,
          installedAt: at,
          updatedAt: at,
        });
        installed.push({ target, path: destination });
      } catch (err) {
        errorsOut.push({
          target,
          error: "copy-failed",
          message: err && err.message ? err.message : String(err),
        });
      }
    }
    return { installed, errors: errorsOut };
  }

  function remove(target, name) {
    const dir = targetDir(target);
    if (!dir) return { ok: false, error: "Markie does not know where that tool keeps its skills." };
    if (!validSkillName(name)) return { ok: false, error: `"${name}" is not a skill name Markie installs.` };
    const destination = path.join(dir, String(name));
    const row = store.skillInstallGet(destination);
    // Without a row this folder is the user's, or another tool's. Deleting it
    // would be Markie throwing away something it never put there.
    if (!row) return { ok: false, error: "Markie did not install that skill, so it will not remove it." };
    try {
      fs.rmSync(destination, { recursive: true, force: true });
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
    store.skillInstallDelete(destination);
    // The lock is keyed by name alone, so the entry only goes when the last
    // copy of this skill does.
    if (!installRows().some((other) => other.name === String(name))) dropFromLock(String(name));
    return { ok: true };
  }

  function installed() {
    const rows = installRows();
    const catalog = listCatalog();
    const bySkill = new Map(catalog.skills.map((skill) => [`${skill.source}/${skill.skillPath}`, skill]));
    return rows
      .map((row) => {
        const target = targetFromKey(row.target);
        if (!target) return null;
        let description = null;
        try {
          const markdown = fs.readFileSync(path.join(row.path, "SKILL.md"), "utf8");
          const value = parseFrontmatter(markdown).fields.description;
          description = typeof value === "string" ? value : null;
        } catch {
          // the folder was removed outside Markie; the row still describes it
        }
        const known = bySkill.get(`${row.source}/${row.skill_path}`);
        return {
          name: row.name,
          target,
          path: row.path,
          description,
          source: row.source ?? null,
          folderHash: row.folder_hash ?? null,
          updateAvailable: Boolean(known && known.folderHash !== row.folder_hash),
          installedByMarkie: true,
        };
      })
      .filter(Boolean);
  }

  return {
    listCatalog,
    refresh,
    addSource,
    removeSource,
    search,
    readSkill,
    install,
    remove,
    installed,
    // Exposed for the check script and for tests that need the resolved paths.
    targetDir,
    lockPath,
  };
}

module.exports = {
  createSkillRegistry,
  discoverSkills,
  folderHash,
  parseOwnerRepo,
  validSkillName,
  containerDepth,
  DEFAULT_SOURCES,
  MAX_TARBALL_BYTES,
};
