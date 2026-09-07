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
//
// A skill's `folderHash` is its git tree object id, computed from the tarball
// by electron/git-tree-id.js. That is what the Vercel CLI records in the shared
// lock file and what it compares to decide an install is out of date, so any
// other digest would make each tool think the other's installs were stale.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { parseTar } = require("./ustar");
const { parseFrontmatter } = require("./skill-frontmatter");
const { treeId } = require("./git-tree-id");
const { writeFileAtomic } = require("./atomic-write");

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
// The compressed cap alone is not a bound: gzip happily turns a few kilobytes
// of zeros into gigabytes, and the whole archive is inflated in the main
// process before a single entry is looked at. So the inflate is bounded too.
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
// One deadline per source, covering the head query and the archive together.
// Two request timeouts in a row, three sources one after another, was three
// minutes of an empty Discover tab on a connection that never answered.
const SOURCE_DEADLINE_MS = 45000;
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
// The deepest directory that can be a skill, in path segments: the longest
// container plus the levels allowed inside it. Nothing below that depth is
// ever asked for its files, so nothing below it is indexed.
const MAX_SKILL_SEGMENTS =
  Math.max(...CONTAINERS.map((container) => (container ? container.split("/").length : 0))) +
  MAX_CONTAINER_DEPTH;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

// The tools a skill can be installed for, by the string the renderer sends.
const TOOL_TARGETS = ["claude", "codex", "cursor", "gemini", "universal"];

const SKILLS_SH_SEARCH = "https://skills.sh/api/search";
const LOCK_VERSION = 3;
// How many times a lock update starts over because the file changed under
// it. Another tool writing that often is not a race worth winning.
const LOCK_ATTEMPTS = 4;

// A segment that is nothing but dots is `.` or `..` wearing a hat. GitHub
// cannot name an account or a repository that way, and both segments become
// directory names under the download cache, so `../..` would otherwise resolve
// out of it and hand a recursive delete somebody else's folder.
const DOTS_ONLY_RE = /^\.+$/;

/**
 * `owner/repo` → `{ owner, repo }`, or null when it is not that shape.
 *
 * Lowercased, because GitHub answers for `Anthropics/Skills` and
 * `anthropics/skills` alike and the id is also a folder name in the download
 * cache, which on most machines does not tell the two apart either. Keeping
 * the spelling made one repository two sources that shared one folder, so
 * removing the second deleted the first's catalog.
 */
function parseOwnerRepo(value) {
  const text = String(value ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!OWNER_REPO_RE.test(text)) return null;
  const [owner, repo] = text.toLowerCase().split("/");
  if (DOTS_ONLY_RE.test(owner) || DOTS_ONLY_RE.test(repo)) return null;
  return { owner, repo };
}

// Windows paths compare case-blind, and the registry stores an install path
// lowercased there (see registry.js) while os.homedir() and the workspace list
// keep their spelling. Folding both sides is what lets a row match its root.
const foldCase = (p) => (process.platform === "win32" ? p.toLowerCase() : p);

/**
 * Is `target` strictly inside `root`? Both are resolved first, so this answers
 * for the real path rather than for the spelling, and the root itself does not
 * count: deleting the whole cache, or the whole home folder, is never what a
 * caller here means.
 */
function insideDir(root, target) {
  const base = foldCase(path.resolve(String(root ?? "")));
  const resolved = foldCase(path.resolve(String(target ?? "")));
  return resolved !== base && resolved.startsWith(base + path.sep);
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
  // Every file, filed under each directory above it that could be a skill.
  // Built once, so a skill's files are a lookup rather than a scan of the
  // whole archive: the scan made discovery grow with skills times files, and
  // a monorepo of skills froze the main process for seconds.
  const byDir = new Map();
  for (const file of files) {
    const segments = file.path.split("/");
    segments.pop();
    let dir = "";
    for (let depth = 0; depth < segments.length && depth < MAX_SKILL_SEGMENTS; depth++) {
      dir = dir ? `${dir}/${segments[depth]}` : segments[depth];
      let list = byDir.get(dir);
      if (!list) {
        list = [];
        byDir.set(dir, list);
      }
      list.push(file);
    }
  }
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
    const own = (byDir.get(skillPath) || []).map((entry) => ({
      path: entry.path.slice(prefix.length),
      data: entry.data,
      mode: entry.mode,
    }));
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
        folderHash: treeId(own),
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
 * @param {number} [deps.maxExpandedBytes] the inflate bound, lowered by tests
 * @param {number} [deps.deadlineMs] how long one source may take, lowered by tests
 */
function createSkillRegistry(deps = {}) {
  const home = deps.home || (() => os.homedir());
  const env = deps.env || process.env;
  const clock = deps.clock || (() => new Date());
  const fetchImpl = deps.fetchImpl || ((...args) => globalThis.fetch(...args));
  const roots = deps.roots || (() => []);
  const version = deps.version || "0.0.0";
  const store = deps.store || require("./registry");
  const maxExpandedBytes = deps.maxExpandedBytes || MAX_EXPANDED_BYTES;
  const deadlineMs = deps.deadlineMs || SOURCE_DEADLINE_MS;
  // The reason a source's requests are abandoned when its deadline passes,
  // so that abort can be told apart from the one the size cap raises.
  const DEADLINE = { deadline: true };
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

  // Inflate with a ceiling. zlib answers a RangeError with ERR_BUFFER_TOO_LARGE
  // when the output would pass it, and that is a different failure from a
  // corrupt download, so the two get different sentences.
  function inflate(bytes, owner, repo) {
    try {
      return zlib.gunzipSync(bytes, { maxOutputLength: maxExpandedBytes });
    } catch (err) {
      if (err && err.code === "ERR_BUFFER_TOO_LARGE") {
        throw new Error(
          `The archive for ${owner}/${repo} unpacks to more than ${Math.round(maxExpandedBytes / 1024 / 1024)} MB, which is too large to be a skill repository.`
        );
      }
      throw new Error(`${owner}/${repo} did not download as a readable archive.`);
    }
  }

  // One archive, as GitHub serves it: a commit's tarball when the head is
  // known, else whatever the branch holds right now. `controller` is the
  // source's own, shared with the head query, so one deadline covers both.
  async function downloadArchive(owner, repo, ref, controller) {
    const response = await fetchImpl(`https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`, {
      headers: { "User-Agent": userAgent },
      signal: controller.signal,
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${owner}/${repo}.`);
    return await readCapped(response, controller);
  }

  async function downloadBranch(owner, repo, controller) {
    let missing = false;
    for (const branch of BRANCHES) {
      const bytes = await downloadArchive(owner, repo, `refs/heads/${branch}`, controller);
      if (bytes) return { bytes, branch };
      missing = true;
    }
    throw new Error(
      missing
        ? `${owner}/${repo} has no main or master branch, or it is not a public repository.`
        : `${owner}/${repo} could not be downloaded.`
    );
  }

  // The commit at the head of the first branch that exists, or null when the
  // API will not say: it is rate-limited without a token, and being
  // rate-limited must not stop a catalog from being built. A branch that is
  // not there answers 404 (no such repository) or 422 (no such ref), and
  // both mean "try the next one"; when neither branch exists, that is the
  // answer, and it is the same one the tarball download would have given.
  async function resolveHead(owner, repo, signal) {
    let missing = false;
    for (const branch of BRANCHES) {
      try {
        const response = await fetchImpl(
          `https://api.github.com/repos/${owner}/${repo}/commits/${branch}`,
          {
            headers: { "User-Agent": userAgent, Accept: "application/vnd.github+json" },
            signal,
          }
        );
        if (response.status === 404 || response.status === 422) {
          missing = true;
          continue;
        }
        if (!response.ok) return null;
        const body = await response.json();
        if (body && typeof body.sha === "string" && /^[0-9a-f]{7,40}$/.test(body.sha)) {
          return { commit: body.sha, branch };
        }
        return null;
      } catch (err) {
        // Past the deadline there is nothing to fall back to.
        if (signal.aborted) throw err;
        return null; // offline, or answering something that is not JSON
      }
    }
    if (missing) {
      throw new Error(`${owner}/${repo} has no main or master branch, or it is not a public repository.`);
    }
    return null;
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
      const stale = path.join(dir, entry.name);
      if (!insideDir(cacheRoot(), stale)) continue;
      fs.rmSync(stale, { recursive: true, force: true });
    }
  }

  function writeCatalog(catalog) {
    fs.mkdirSync(sourceDir(catalog.owner, catalog.repo), { recursive: true });
    fs.writeFileSync(
      catalogFile(catalog.owner, catalog.repo),
      `${JSON.stringify(catalog, null, 2)}\n`,
      "utf8"
    );
  }

  // The head is resolved first and that commit's own archive is what gets
  // downloaded, so the folder named after a commit holds that commit and
  // nothing else. Downloading the branch and asking for its head afterwards
  // let the branch move in between: the folder was named after the new
  // commit but held the old files, and a later refresh of the new commit
  // found its folder already there and kept files upstream had removed.
  //
  // When the head is the commit already on disk there is nothing to fetch:
  // a commit's archive never changes, so the catalog is re-dated and kept.
  async function fetchSource(source) {
    const { owner, repo } = source;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(DEADLINE), deadlineMs);
    try {
      return await fetchSourceWithin(owner, repo, controller);
    } catch (err) {
      if (controller.signal.aborted && controller.signal.reason === DEADLINE) {
        const seconds = (deadlineMs / 1000).toFixed(deadlineMs % 1000 ? 1 : 0);
        throw new Error(`${owner}/${repo} did not answer within ${seconds} seconds.`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchSourceWithin(owner, repo, controller) {
    const head = await resolveHead(owner, repo, controller.signal);
    const previous = readCatalog(owner, repo);
    if (
      head &&
      previous &&
      previous.commit === head.commit &&
      previous.commitSource === "api" &&
      fs.existsSync(path.join(sourceDir(owner, repo), head.commit))
    ) {
      const catalog = { ...previous, ref: head.branch, fetchedAt: nowIso(), error: null };
      writeCatalog(catalog);
      errors.delete(`${owner}/${repo}`);
      return catalog;
    }
    let bytes;
    let branch;
    let commit;
    let commitSource;
    if (head) {
      bytes = await downloadArchive(owner, repo, head.commit, controller);
      if (!bytes) throw new Error(`${owner}/${repo} could not be downloaded.`);
      branch = head.branch;
      commit = head.commit;
      commitSource = "api";
    } else {
      // No head to name the folder after, so the archive's own digest does:
      // it is bound to these exact bytes just as a commit id is.
      ({ bytes, branch } = await downloadBranch(owner, repo, controller));
      commit = crypto.createHash("sha1").update(bytes).digest("hex");
      commitSource = "tarball";
    }
    const discovered = discoverSkills(parseTar(inflate(bytes, owner, repo)), { owner, repo });
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
    writeCatalog(catalog);
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

  // One entry per target a row serves, so a folder two tools share reads as
  // installed for both.
  function installedTo(skill, rows) {
    return rows
      .filter((row) => row.source === skill.source && row.skill_path === skill.skillPath)
      .flatMap((row) =>
        targetsServedBy(row).map((target) => ({
          target,
          path: row.path,
          upToDate: row.folder_hash === skill.folderHash,
        }))
      );
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
    // A repository that failed on the way in is not a row (see addSource), but
    // the reason has to reach the panel, which reads failures off this list.
    // So it is listed for this session only, with nothing behind it; removing
    // it clears the reason, and a restart forgets it.
    const listed = new Set(out.sources.map((s) => s.id));
    for (const [id, error] of errors) {
      if (listed.has(id)) continue;
      const parsed = parseOwnerRepo(id);
      if (!parsed) continue;
      out.sources.push({
        id,
        owner: parsed.owner,
        repo: parsed.repo,
        ref: null,
        commit: null,
        fetchedAt: null,
        builtin: false,
        error,
      });
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
  // Sources are independent, so they are fetched side by side: what lands is
  // listed, and a source that did not answer carries its reason on its row,
  // so the panel's wait is one deadline rather than one per source.
  async function refresh(source) {
    const named = source ? parseOwnerRepo(source) : null;
    if (source && !named) return listCatalog();
    const wanted = named
      ? sources().filter((s) => s.owner === named.owner && s.repo === named.repo)
      : sources();
    await Promise.allSettled(
      wanted
        .filter((entry) => named || isStale(readCatalog(entry.owner, entry.repo)))
        .map(async (entry) => {
          const id = `${entry.owner}/${entry.repo}`;
          try {
            await fetchSource(entry);
          } catch (err) {
            errors.set(id, err && err.message ? err.message : String(err));
          }
        })
    );
    return listCatalog();
  }

  // The row is written only once the repository has actually answered. A
  // source that was persisted on the way in stayed in the list forever with
  // nothing behind it, and offered a Remove that pointed at a directory that
  // was never created.
  async function addSource(ownerRepo) {
    const parsed = parseOwnerRepo(ownerRepo);
    if (!parsed) return listCatalog();
    const id = `${parsed.owner}/${parsed.repo}`;
    // Adding a built-in, however it was spelled, is asking for it again.
    const builtin = DEFAULT_SOURCES.some((s) => s.owner === parsed.owner && s.repo === parsed.repo);
    try {
      await fetchSource(parsed);
      if (!builtin) store.skillSourceAdd(id);
      errors.delete(id);
    } catch (err) {
      errors.set(id, err && err.message ? err.message : String(err));
    }
    return listCatalog();
  }

  function removeSource(ownerRepo) {
    const parsed = parseOwnerRepo(ownerRepo);
    if (!parsed) return listCatalog();
    const id = `${parsed.owner}/${parsed.repo}`;
    const dir = sourceDir(parsed.owner, parsed.repo);
    // A recursive delete is the most destructive thing this file does, so it
    // proves where it is pointing first rather than trusting the two segments
    // it was handed. parseOwnerRepo should already make this impossible; that
    // is the argument for checking, not against it.
    if (!insideDir(cacheRoot(), dir)) {
      const message = `Markie will not delete ${dir}: it is outside the skill cache.`;
      console.error(`skill-registry: refused to remove a source at ${dir}`);
      errors.set(id, message);
      return listCatalog();
    }
    store.skillSourceRemove(id);
    errors.delete(id);
    // The download is disposable; the installs it produced are not, and their
    // rows are keyed by destination rather than by source.
    fs.rmSync(dir, { recursive: true, force: true });
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

  // The cached folder of a catalog skill, for a preview that wants the files
  // beside its SKILL.md. Keyed on the skill's own source and its catalog id,
  // which is what the panel holds; a source that is not the skill's is a
  // lookup that misses, not a shortcut.
  function skillDir(sourceId, skillId) {
    const parsed = parseOwnerRepo(sourceId);
    if (!parsed) return { error: "Markie does not know that source." };
    const found = findSkill(skillId);
    if (!found || found.skill.source !== `${parsed.owner}/${parsed.repo}`) {
      return { error: "That skill is not in the catalog. Refresh its source and try again." };
    }
    if (!fs.existsSync(path.join(found.dir, "SKILL.md"))) {
      return { error: "That skill's files are not in the cache. Refresh its source and try again." };
    }
    return { dir: found.dir };
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
    return TOOL_TARGETS.includes(text) ? text : null;
  }

  // Every target an install could be asked for today: the tools, and each
  // registered project.
  function knownTargets() {
    const projects = (roots() || [])
      .filter((root) => typeof root === "string" && root.trim())
      .map((project) => ({ project }));
    return [...TOOL_TARGETS, ...projects];
  }

  const sameFolder = (a, b) => foldCase(path.resolve(a)) === foldCase(path.resolve(b));

  // Every target whose skills directory is the folder this row sits in, the
  // row's own first. Two targets can share one folder (CLAUDE_CONFIG_DIR
  // pointed at ~/.agents, say), and the one copy there is then both installs.
  // Decided when asked rather than recorded, because the answer changes when
  // the user moves a config folder.
  function targetsServedBy(row) {
    const own = targetFromKey(row.target);
    if (!own) return [];
    const out = [own];
    const parent = path.dirname(String(row.path || ""));
    for (const target of knownTargets()) {
      if (targetKey(target) === row.target) continue;
      const dir = targetDir(target);
      if (dir && sameFolder(dir, parent)) out.push(target);
    }
    return out;
  }

  // ── The lock file the Vercel CLI also reads ──────────────────────────────
  // Shared with `npx skills`, so a merge only ever touches this skill's entry.
  // A file we cannot parse is left alone: it is another tool's record, and
  // rewriting it from scratch would delete installs Markie knows nothing about.

  function lockPath() {
    return path.join(home(), ".agents", ".skill-lock.json");
  }

  // The file's bytes, "" when there is no file yet, null when it cannot be
  // read at all.
  function readLockText() {
    try {
      return fs.readFileSync(lockPath(), "utf8");
    } catch (err) {
      return err && err.code === "ENOENT" ? "" : null;
    }
  }

  function parseLock(text) {
    if (text === null) return null;
    if (text === "") return { version: LOCK_VERSION, skills: {} };
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      if (!parsed.skills || typeof parsed.skills !== "object") parsed.skills = {};
      return parsed;
    } catch {
      return null;
    }
  }

  // Apply one change to the lock file as it is right now.
  //
  // The other tool writes this file in place whenever it runs, so the change
  // is worked out against a fresh read, and the file is read once more just
  // before it is replaced: if it moved in between, the change is applied
  // again to what is there now rather than to what was. The replacement is
  // a rename, so a reader never sees half a file and a write that dies part
  // way leaves the one that was there. `mutate` returns false to say there
  // is nothing to write.
  function updateLock(mutate) {
    let text = readLockText();
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      const lock = parseLock(text);
      if (!lock) return;
      if (mutate(lock) === false) return;
      lock.version = LOCK_VERSION;
      const fresh = readLockText();
      if (fresh !== text) {
        text = fresh;
        continue;
      }
      fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
      writeFileAtomic(lockPath(), `${JSON.stringify(lock, null, 2)}\n`);
      return;
    }
  }

  function mergeLock(name, entry) {
    updateLock((lock) => {
      const existing = lock.skills[name];
      lock.skills[name] = {
        ...entry,
        installedAt: existing?.installedAt || entry.installedAt,
      };
    });
  }

  function dropFromLock(name) {
    updateLock((lock) => {
      if (!lock.skills[name]) return false;
      delete lock.skills[name];
    });
  }

  // `sourceUrl` carries the .git suffix and `skillPath` points at the
  // SKILL.md rather than its folder, because that is what the Vercel CLI
  // writes: this file is shared with it, so Markie's entries should read the
  // same as its own. `ref` is Markie's own addition; the CLI ignores keys it
  // does not know.
  function lockEntry({ source, skillPath, folderHash, ref, at }) {
    return {
      source,
      sourceType: "github",
      sourceUrl: `https://github.com/${source}.git`,
      ref: ref ?? null,
      skillPath: `${skillPath}/SKILL.md`,
      skillFolderHash: folderHash,
      installedAt: at,
      updatedAt: at,
    };
  }

  // The entry a remaining install row stands for. Its branch is not on the
  // row; the source's catalog knows it when the source is still around.
  function lockEntryFromRow(row) {
    const parsed = parseOwnerRepo(row.source);
    const catalog = parsed ? readCatalog(parsed.owner, parsed.repo) : null;
    return lockEntry({
      source: row.source,
      skillPath: row.skill_path,
      folderHash: row.folder_hash ?? null,
      ref: catalog?.ref ?? null,
      at: row.installed_at,
    });
  }

  // ── Install and remove ───────────────────────────────────────────────────

  // The row Markie wrote for this tool and this skill, found by what was
  // persisted rather than by recomputing where the folder ought to be. A user
  // who moves CLAUDE_CONFIG_DIR or unregisters a project still owns the folder
  // Markie made, and recomputing would lose it: Remove would fail forever, and
  // installing again would leave a second copy behind. A row written under
  // another target's name but sitting in this target's folder is this
  // target's install too.
  function ownedRow(target, name) {
    const key = targetKey(target);
    if (!key) return null;
    const rows = installRows().filter((row) => row.name === String(name));
    return (
      rows.find((row) => row.target === key) ||
      rows.find((row) => targetsServedBy(row).some((served) => targetKey(served) === key)) ||
      null
    );
  }

  // The folders Markie may write into: the home folder (every tool's default
  // lives under it), the two config folders a user can move, and each
  // registered project.
  function allowedRoots() {
    return [home(), env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, ...(roots() || [])]
      .filter((dir) => typeof dir === "string" && dir.trim())
      .map((dir) => path.resolve(dir));
  }

  // Today's roots plus the one the row recorded at install time.
  function rootsFor(row) {
    const out = allowedRoots();
    if (row && typeof row.root === "string" && path.isAbsolute(row.root)) out.push(path.resolve(row.root));
    return out;
  }

  // Where a path really is: the real path of its deepest existing ancestor
  // with the rest appended, so a folder that does not exist yet (a first
  // install's destination) still answers for the folder it would land in.
  // A link that leads nowhere is not an ancestor to build on, and answers
  // null.
  function realPathBound(target) {
    let existing = path.resolve(String(target || ""));
    const tail = [];
    for (;;) {
      try {
        const real = fs.realpathSync(existing);
        return tail.length ? path.join(real, ...tail.reverse()) : real;
      } catch (err) {
        if (!err || err.code !== "ENOENT") return null;
        try {
          if (fs.lstatSync(existing).isSymbolicLink()) return null;
        } catch {
          // not there at all, which is the ordinary case for a new folder
        }
        const parent = path.dirname(existing);
        if (parent === existing) return null;
        tail.push(path.basename(existing));
        existing = parent;
      }
    }
  }

  // The check the lexical one in ownedFolder cannot make. A recorded path
  // sits inside a root by its spelling, and a parent of it can be replaced
  // by a symlink after the install; a delete or a swap that followed the
  // link would land on a folder somewhere else entirely. So, immediately
  // before either, both sides are resolved for real, and the destination
  // has to be strictly inside one of the roots as they really are. A root
  // resolves the same way the destination does, so a config folder the tool
  // has not created yet still counts as the root it will be.
  function reallyInside(destination, candidates) {
    const real = realPathBound(destination);
    if (!real) return { ok: false, real: null };
    for (const root of candidates) {
      const realRoot = realPathBound(root);
      if (realRoot && insideDir(realRoot, real)) return { ok: true, real };
    }
    return { ok: false, real };
  }

  // The root a new install is recorded under: the most specific of today's
  // allowed roots that holds the destination, so a project install remembers
  // its project rather than the home folder that happens to contain it.
  function rootFor(destination) {
    const holding = allowedRoots().filter((root) => insideDir(root, destination));
    if (!holding.length) return null;
    return holding.reduce((best, root) => (root.length > best.length ? root : best));
  }

  // The folder a row says Markie created, or the reason the row is not
  // trusted. It has to have the shape every install produces, an absolute
  // `.../skills/<name>` whose last segment is the row's own name, and it has
  // to sit inside one of the allowed roots as they are today, or inside the
  // root the row itself recorded at install time. That recorded root is what
  // keeps a project install Markie's after the workspace is unregistered, and
  // an install under a config folder the tool has since moved away from. What
  // this refuses is a row that names the home folder itself, a workspace
  // root, or anything a corrupt record could point at outside those roots.
  function ownedFolder(row) {
    const notSkill = { ok: false, why: "not a skill folder" };
    const recorded = String(row?.path || "");
    if (!recorded || !path.isAbsolute(recorded)) return notSkill;
    const resolved = path.resolve(recorded);
    if (!validSkillName(row.name) || path.basename(resolved) !== row.name) return notSkill;
    if (path.basename(path.dirname(resolved)) !== "skills") return notSkill;
    if (!rootsFor(row).some((root) => insideDir(root, resolved))) {
      return { ok: false, why: "outside every folder Markie may write to" };
    }
    return { ok: true, path: resolved };
  }

  // Is the row's skill the one being installed? A destination Markie owns is
  // still not a destination it may hand to a different repository: two sources
  // both offering a `pdf` would otherwise overwrite each other silently.
  function sameSkill(row, skill) {
    return row.source === skill.source && row.skill_path === skill.skillPath;
  }

  function elsewhere(row, skill) {
    if (!row.source) return "another source";
    return row.source === skill.source ? `${row.source}/${row.skill_path}` : row.source;
  }

  // Copy into place without ever being between two versions.
  //
  // The old shape deleted the destination and then copied, so a disk error or
  // a locked file left the user with neither the version they had nor the one
  // they asked for, and a registry failure after the copy left a folder no row
  // claimed, which every later attempt then refused as somebody else's.
  //
  // Now the new copy is staged beside the destination (same filesystem, so the
  // swap is a rename), the old folder is moved aside rather than deleted, the
  // row is written, and only then is the old folder dropped. Anything that
  // throws before that point puts the previous folder back and leaves the row
  // exactly as it was.
  function swapIntoPlace(source, destination, writeRow) {
    const dir = path.dirname(destination);
    const name = path.basename(destination);
    const staging = path.join(dir, `.${name}.markie-staging`);
    const aside = path.join(dir, `.${name}.markie-previous`);
    let placed = false;
    let movedAside = false;
    try {
      fs.mkdirSync(dir, { recursive: true });
      // A crash mid-install can leave either of these behind. They are
      // dot-prefixed, so the index never walked them.
      fs.rmSync(staging, { recursive: true, force: true });
      fs.rmSync(aside, { recursive: true, force: true });
      fs.cpSync(source, staging, { recursive: true });
      if (fs.existsSync(destination)) {
        fs.renameSync(destination, aside);
        movedAside = true;
      }
      fs.renameSync(staging, destination);
      placed = true;
      writeRow();
    } catch (err) {
      try {
        // Whatever the copy managed before it stopped is in the staging
        // folder, or the folder is already gone because the rename took it.
        // Either way it is not wanted.
        fs.rmSync(staging, { recursive: true, force: true });
        if (placed) fs.rmSync(destination, { recursive: true, force: true });
        if (movedAside) fs.renameSync(aside, destination);
      } catch {
        // Restoring is best effort by definition: whatever stopped the install
        // may stop the undo too. The original error is the one worth reporting.
      }
      throw err;
    }
    // Past the point of no return. The files are in place and the row says so,
    // so a failure to tidy the old copy is a leftover directory and not a
    // reason to undo a good install.
    try {
      if (movedAside) fs.rmSync(aside, { recursive: true, force: true });
    } catch {
      // it will be cleared by the next install of this skill
    }
  }

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
    // One name, one source, whatever the target: the lock file has a single
    // entry per name, so a second source's copy of the same name under a
    // different tool would rewrite the first's record and leave it stale
    // when removed. A row for the name from anywhere else refuses the lot.
    const foreign = installRows().find((row) => row.name === skill.name && !sameSkill(row, skill));
    if (foreign) {
      for (const target of targets || []) {
        errorsOut.push({
          target,
          error: "exists",
          message: `${skill.name} is already installed from ${elsewhere(foreign, skill)}. Remove it first.`,
        });
      }
      return { installed, errors: errorsOut };
    }
    // Where each target's copy would go, worked out for every target before
    // anything is written. Two targets can resolve to one folder, and that
    // folder is written once and reported once, naming every target it
    // serves; writing it twice reported two installs of one copy and left the
    // row under whichever target came last.
    const plans = [];
    const byFolder = new Map();
    for (const target of targets || []) {
      if (!validSkillName(skill.name)) {
        errorsOut.push({
          target,
          error: "invalid-name",
          message: `"${skill.name}" is not a name Markie will create a folder for.`,
        });
        continue;
      }
      // What Markie already installed for this tool under this name, if
      // anything, before working out where a new install would go.
      let row = ownedRow(target, skill.name);
      let destination = null;
      if (row) {
        const owned = ownedFolder(row);
        if (!owned.ok) {
          errorsOut.push({
            target,
            error: "copy-failed",
            message: `Markie's record of ${skill.name} points at ${row.path}, which is ${owned.why}, so it will not write there.`,
          });
          continue;
        }
        destination = owned.path;
      } else {
        const dir = targetDir(target);
        if (!dir) {
          errorsOut.push({
            target,
            error: "no-such-target",
            message: "Markie does not know where to put a skill for that tool.",
          });
          continue;
        }
        destination = path.join(dir, skill.name);
        if (!path.resolve(destination).startsWith(path.resolve(dir) + path.sep)) {
          errorsOut.push({
            target,
            error: "invalid-name",
            message: `"${skill.name}" would be written outside ${dir}.`,
          });
          continue;
        }
        // A row keyed by this exact folder, from an install under some other
        // target. It is still Markie's folder, and the same rules apply to it.
        row = store.skillInstallGet(destination) || null;
      }
      const folder = foldCase(path.resolve(destination));
      const shared = byFolder.get(folder);
      if (shared) {
        shared.targets.push(target);
        continue;
      }
      const plan = { targets: [target], row, destination };
      byFolder.set(folder, plan);
      plans.push(plan);
    }
    for (const { targets: served, row, destination } of plans) {
      const target = served[0];
      if (!row && fs.existsSync(destination)) {
        errorsOut.push({
          target,
          targets: served,
          error: "exists",
          message: `There is already a folder at ${destination} that Markie did not install.`,
        });
        continue;
      }
      // Resolved for real at the last moment: see reallyInside.
      const bound = reallyInside(destination, row ? rootsFor(row) : allowedRoots());
      if (!bound.ok) {
        errorsOut.push({
          target,
          targets: served,
          error: "copy-failed",
          message: `${destination} resolves to ${bound.real ?? "nowhere"}, outside every folder Markie may write to, so Markie will not write there.`,
        });
        continue;
      }
      try {
        const at = nowIso();
        const place = destination;
        swapIntoPlace(found.dir, place, () => {
          store.skillInstallSet({
            path: place,
            // An existing row keeps the target it was written under: the
            // folder serves every target that resolves to it, and handing it
            // to whichever was asked for last only made it change hands.
            target: row ? row.target : targetKey(target),
            name: skill.name,
            source: skill.source,
            skill_path: skill.skillPath,
            folder_hash: skill.folderHash,
            root: row && row.root ? row.root : rootFor(place),
            installed_at: at,
          });
        });
        // Written after the swap and outside it: the install is already real
        // and recorded, and a lock file that will not take the entry is not a
        // reason to throw the skill away.
        try {
          mergeLock(
            skill.name,
            lockEntry({
              source: skill.source,
              skillPath: skill.skillPath,
              folderHash: skill.folderHash,
              ref: found.catalog.ref,
              at,
            })
          );
        } catch {
          // shared with another tool; not ours to fail an install over
        }
        installed.push({ target, targets: served, path: place });
      } catch (err) {
        errorsOut.push({
          target,
          targets: served,
          error: "copy-failed",
          message: err && err.message ? err.message : String(err),
        });
      }
    }
    return { installed, errors: errorsOut };
  }

  function remove(target, name) {
    if (!validSkillName(name)) {
      return { ok: false, error: `"${name}" is not a skill name Markie installs.` };
    }
    // The row, not a recomputed path: see ownedRow. Without a row this folder
    // is the user's, or another tool's, and deleting it would be Markie
    // throwing away something it never put there.
    const row = ownedRow(target, name);
    if (!row) {
      return { ok: false, error: "Markie did not install that skill, so it will not remove it." };
    }
    const owned = ownedFolder(row);
    if (!owned.ok) {
      return {
        ok: false,
        error: `Markie's record of ${name} points at ${row.path}, which is ${owned.why}, so it will not delete it.`,
      };
    }
    // Resolved for real at the last moment: see reallyInside.
    const bound = reallyInside(owned.path, rootsFor(row));
    if (!bound.ok) {
      return {
        ok: false,
        error: `Markie's record of ${name} points at ${row.path}, which resolves to ${bound.real ?? "nowhere"}, outside every folder Markie may write to, so it will not delete it.`,
      };
    }
    try {
      fs.rmSync(owned.path, { recursive: true, force: true });
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
    store.skillInstallDelete(row.path);
    // The lock is keyed by name alone, so the entry only goes when the last
    // copy of this skill does. While one remains, the entry is rebuilt from
    // it: whatever another tool wrote there in the meantime described a
    // copy that is gone now.
    const remaining = installRows().find((other) => other.name === String(name));
    try {
      if (!remaining) dropFromLock(String(name));
      else if (remaining.source) mergeLock(String(name), lockEntryFromRow(remaining));
    } catch {
      // shared with another tool; the removal itself is done
    }
    return { ok: true };
  }

  function installed() {
    const rows = installRows();
    const catalog = listCatalog();
    const bySkill = new Map(catalog.skills.map((skill) => [`${skill.source}/${skill.skillPath}`, skill]));
    return rows
      .map((row) => {
        const targets = targetsServedBy(row);
        if (!targets.length) return null;
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
          target: targets[0],
          targets,
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
    skillDir,
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
  parseOwnerRepo,
  validSkillName,
  insideDir,
  containerDepth,
  DEFAULT_SOURCES,
  MAX_TARBALL_BYTES,
  MAX_EXPANDED_BYTES,
};
