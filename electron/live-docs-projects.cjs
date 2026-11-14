// Live Docs, step M3: the projects a person has added to the Live Docs area,
// and the files of the one project that is open.
//
// The renderer is untrusted here. These rules hold in this module, and main.js
// holds the IPC edge to them (createLiveDocsProjectIpc below):
//
// - A folder enters only through the native folder picker in main. The list
//   is kept in main. The renderer names a project by an opaque id and a file by
//   a project-relative path, and never sends a path main uses as given.
// - Every file path is resolved under the open project's real root. `..`, an
//   absolute path, a symlink at the file, a folder on the way that resolves
//   outside the project, and a project folder moved or replaced after it was
//   opened are all refused. The folder identity check is the one
//   electron/document-files.cjs uses for documents (folderState).
// - Reads and writes are UTF-8 text only and capped at MAX_FILE_BYTES. A write
//   goes to a temp file beside the target and is renamed over it, never follows
//   a symlink at the target, and is refused when the file on disk is no longer
//   the revision the editor started from.
// - `.git` and `node_modules` are not part of the editable project. They are
//   hidden from the tree, ignored by the watcher, and refused for reads and
//   writes, including through a symlink inside the project that points into
//   them. Every other dot file and dot folder (.gitignore, .github, .env) is
//   the project's own and is shown and editable.
// - One recursive watcher, for the open project only. It is debounced, sends
//   at most WATCH_MAX_PATHS paths per batch, and is closed with the project.
// - Nothing here spawns a process. The atomic writer's extended-attribute copy
//   (which runs /usr/bin/xattr) is switched off for project files.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { writeFileAtomic } = require("./atomic-write.js");
const { folderState, sameFolderState } = require("./document-files.cjs");
const { checkProjectFolder } = require("./live-docs-preview.js");

const MAX_PROJECTS = 50;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TREE_ENTRIES = 5000;
const MAX_TREE_DEPTH = 24;
const MAX_RELATIVE_PATH = 1024;
const MAX_SEGMENTS = 32;
const MAX_STORE_BYTES = 256 * 1024;
const WATCH_DEBOUNCE_MS = 150;
const WATCH_MAX_WAIT_MS = 1000;
const WATCH_MAX_PATHS = 200;
// Not part of the editable project. Compared after NFKC and lower-casing, so
// `.GIT` on a case-insensitive disk, or a look-alike letter that folds to the
// same name, is refused as well.
// Never shown, watched, read or written. .git and node_modules first: a
// write into .git/hooks or node_modules/.bin runs code. The rest are the
// other places a planted file runs by itself or holds a credential: git hook
// managers (.husky, .githooks), package manager config (.npmrc can set
// node-options and hold auth tokens; .yarnrc*), and editor task files that
// run on open (.vscode, .idea). Everything else in a project stays editable,
// which is why M4 starts Run only from an action taken in main, never from a
// renderer call (docs/live-docs-area.md, "What hiding does not stop").
const HIDDEN_NAMES = new Set([".git", "node_modules", ".husky", ".githooks", ".npmrc", ".yarnrc", ".yarnrc.yml", ".yarnrc.yaml", ".vscode", ".idea"]);
const JUNK_NAMES = new Set([".ds_store"]);
// The atomic writer's staging name (electron/atomic-write.js tempPathFor).
const TEMP_NAME = /\.markie-[a-z0-9-]+\.tmp$/i;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const UNADDRESSABLE = /[\x00-\x1f\x7f\\]/;

class ProjectError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function refuse(code, message) { throw new ProjectError(code, message); }

const OUTSIDE = "Only files inside the open project can be opened.";
const HIDDEN = "Markie does not open or change anything inside .git or node_modules.";
const SYMLINK = "Markie does not follow symbolic links inside a project.";

function failure(error) {
  if (error instanceof ProjectError) return { ok: false, code: error.code, message: error.message };
  if (error && error.code === "ENOENT") return { ok: false, code: "missing", message: "That file or folder no longer exists." };
  if (error && (error.code === "EACCES" || error.code === "EPERM" || error.code === "EROFS")) return { ok: false, code: "denied", message: "macOS refused access to that file." };
  return { ok: false, code: "io-error", message: "The file operation failed." };
}
function guarded(operation) {
  try { return { ok: true, ...operation() }; } catch (error) { return failure(error); }
}

function exactObject(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some((name) => !keys.includes(name)) || keys.some((name) => !Object.prototype.hasOwnProperty.call(value, name))) {
    refuse("invalid-request", "Invalid Live Docs request.");
  }
  return value;
}
function projectId(value) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) refuse("invalid-request", "Invalid Live Docs request.");
  return value;
}

// NFKC folds look-alike letters; the ignorable code points (zero-width
// joiners, direction marks, the byte-order mark) are dropped because HFS+ and
// exFAT drop them from file names too, so ".g\u200cit" opens the real .git.
const foldName = (name) => name.normalize("NFKC").replace(/\p{Default_Ignorable_Code_Point}/gu, "").toLowerCase();
const isHiddenName = (name) => {
  const folded = foldName(name);
  return HIDDEN_NAMES.has(folded) || folded.startsWith(".yarnrc");
};
const identity = (stat) => `${stat.dev}:${stat.ino}`;
// Refuse a symlink in any part of the path, not only the last (macOS 11+).
// Every path opened below is built from a realpath, so none legitimately has
// one; a folder swapped for a symlink between the check and the open fails
// with ELOOP instead of reaching outside the project.
const O_NOFOLLOW_ANY_DARWIN = 0x20000000;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
// The atomic writer's xattr copy runs /usr/bin/xattr. M3 starts no process,
// so the probe answers "nothing to copy" without running anything.
const noSpawn = () => ({ status: 1, stdout: "" });

/**
 * The project-relative path the renderer sent, split into checked segments.
 * Never joined onto anything until every segment has passed.
 */
function parseRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_RELATIVE_PATH || UNADDRESSABLE.test(value)) {
    refuse("invalid-path", "That is not a file in this project.");
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || path.isAbsolute(value)) refuse("outside", OUTSIDE);
  const segments = value.split("/");
  if (segments.length > MAX_SEGMENTS || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    refuse("outside", OUTSIDE);
  }
  if (segments.some(isHiddenName)) refuse("hidden", HIDDEN);
  return segments;
}

/**
 * @param {{
 *   fs?: typeof fs,
 *   storePath: string,
 *   home?: string,
 *   platform?: string,
 *   maxFileBytes?: number,
 *   watch?: typeof fs.watch,
 *   onChange?: (change: { projectId: string, paths: string[], overflow: boolean, watching: boolean }) => void,
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout,
 *   now?: () => number,
 * }} options
 */
function createLiveDocsProjects({
  fs: io = fs,
  storePath,
  home = os.homedir(),
  platform = process.platform,
  maxFileBytes = MAX_FILE_BYTES,
  watch = (...args) => io.watch(...args),
  onChange = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
} = {}) {
  if (typeof storePath !== "string" || !path.isAbsolute(storePath)) throw new Error("Live Docs projects need an absolute store path.");
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > MAX_FILE_BYTES) throw new Error("Invalid Live Docs file cap.");
  const key = (value) => (platform === "win32" ? value.toLowerCase() : value);
  // macOS refuses O_NOFOLLOW_ANY together with O_NOFOLLOW (EINVAL), and the
  // first covers the second, so one or the other, never both.
  const noFollow = io.constants.O_NOFOLLOW_ANY ?? (platform === "darwin" ? O_NOFOLLOW_ANY_DARWIN : (io.constants.O_NOFOLLOW ?? 0));
  let homeReal = home;
  try { homeReal = io.realpathSync(home); } catch { /* keep the unresolved home */ }
  /** @type {{ id: string, root: string, name: string, addedAt: number }[] | null} */
  let projects = null;
  /** @type {null | { id: string, name: string, root: string, rootState: { real: string, id: string }, watcher: any, watching: boolean, timer: any }} */
  let open = null;

  // ── The list ──
  function load() {
    if (projects) return projects;
    projects = [];
    try {
      const stat = io.statSync(storePath);
      if (!stat.isFile() || stat.size > MAX_STORE_BYTES) return projects;
      const parsed = JSON.parse(io.readFileSync(storePath, "utf8"));
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.projects)) return projects;
      for (const item of parsed.projects) {
        if (projects.length >= MAX_PROJECTS) break;
        if (!item || typeof item !== "object" || typeof item.id !== "string" || !ID_PATTERN.test(item.id)) continue;
        if (typeof item.root !== "string" || item.root.length > 4096 || !path.isAbsolute(item.root) || /[\x00-\x1f\x7f]/.test(item.root)) continue;
        if (projects.some((known) => known.id === item.id || key(known.root) === key(item.root))) continue;
        projects.push({
          id: item.id,
          root: item.root,
          name: typeof item.name === "string" && item.name ? item.name.slice(0, 256) : path.basename(item.root),
          addedAt: Number.isFinite(item.addedAt) ? item.addedAt : 0,
        });
      }
    } catch { /* missing or unreadable: an empty list */ }
    return projects;
  }
  function save() {
    io.mkdirSync(path.dirname(storePath), { recursive: true });
    writeFileAtomic(storePath, `${JSON.stringify({ version: 1, projects: load() }, null, 2)}\n`, { fs: io, platform, spawn: noSpawn });
  }
  function location(root) {
    const prefix = homeReal.endsWith(path.sep) ? homeReal : homeReal + path.sep;
    return key(root).startsWith(key(prefix)) ? `~/${root.slice(prefix.length)}` : root;
  }
  function check(root) {
    return checkProjectFolder(root, { fs: io, home });
  }
  function publicEntry(entry) {
    const checked = check(entry.root);
    return {
      id: entry.id,
      kind: "local",
      name: entry.name,
      location: location(entry.root),
      available: checked.ok && key(checked.root) === key(entry.root),
      open: open?.id === entry.id,
    };
  }
  const publicOpen = (current) => ({ id: current.id, name: current.name, location: location(current.root), watching: current.watching });
  function find(id) {
    return load().find((entry) => entry.id === id) ?? refuse("unknown-project", "That project is no longer in the Live Docs list.");
  }

  // ── The open project ──
  function requireOpen() {
    if (!open) refuse("no-project", "Open a Live Docs project first.");
    return open;
  }
  function assertRoot(current) {
    let state;
    try { state = folderState(io, current.root); } catch { state = null; }
    if (!state || !sameFolderState(state, current.rootState, key)) {
      refuse("moved", `${current.name} was moved, renamed or replaced after it was opened. Open it again from the Live Docs list.`);
    }
  }
  // The part of `real` under the project root, or a refusal when it is not under it.
  function relativeInside(current, real) {
    if (key(real) === key(current.root)) return "";
    const prefix = current.root.endsWith(path.sep) ? current.root : current.root + path.sep;
    if (!key(real).startsWith(key(prefix))) refuse("outside", OUTSIDE);
    return real.slice(prefix.length);
  }
  function resolveFile(current, relative) {
    const segments = parseRelativePath(relative);
    assertRoot(current);
    const joined = path.join(current.root, ...segments);
    let parent;
    try { parent = folderState(io, path.dirname(joined)); }
    catch (error) {
      if (error && error.code === "ENOENT") refuse("missing", "That file no longer exists.");
      refuse("outside", OUTSIDE);
    }
    // A folder on the way may be a symlink. Where it really leads is what
    // counts: outside the project, or into .git or node_modules, is refused.
    const realRelative = relativeInside(current, parent.real);
    if (realRelative && realRelative.split(path.sep).some(isHiddenName)) refuse("hidden", HIDDEN);
    const target = path.join(parent.real, segments[segments.length - 1]);
    let stat;
    try { stat = io.lstatSync(target, { bigint: true }); }
    catch (error) {
      if (error && error.code === "ENOENT") refuse("missing", "That file no longer exists.");
      throw error;
    }
    if (stat.isSymbolicLink()) refuse("symlink", SYMLINK);
    if (!stat.isFile()) refuse("not-a-file", "That is not a regular file.");
    // A hard link has the same bytes under another name, possibly outside
    // the project; Markie edits only files that have one name.
    if (stat.nlink > 1n) refuse("hard-link", "Markie edits files with one name only. This one is a hard link; open it in another editor.");
    return { path: segments.join("/"), target, parent, stat };
  }
  function decode(bytes) {
    if (bytes.includes(0)) refuse("binary", "Markie edits text files only. This one is binary.");
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { refuse("binary", "Markie edits text files only. This one is not UTF-8 text."); }
  }
  const tooLarge = () => refuse("too-large", `Markie edits project files up to ${Math.floor(maxFileBytes / 1024 / 1024) || 1} MB. Open larger files in another editor.`);
  function readEntry(entry) {
    if (entry.stat.size > BigInt(maxFileBytes)) tooLarge();
    // O_NONBLOCK: a FIFO swapped in for the file can never hang main here.
    const fd = io.openSync(entry.target, io.constants.O_RDONLY | noFollow | (io.constants.O_NONBLOCK ?? 0));
    try {
      const opened = io.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || identity(opened) !== identity(entry.stat)) refuse("conflict", "The file changed while it was being opened. Try again.");
      if (opened.size > BigInt(maxFileBytes)) tooLarge();
      // One byte past the size, so a file that grew after the stat is caught.
      const size = Number(opened.size);
      const buffer = Buffer.alloc(size + 1);
      let length = 0;
      while (length < buffer.length) {
        const got = io.readSync(fd, buffer, length, buffer.length - length, length);
        if (!got) break;
        length += got;
      }
      if (length > size) refuse("conflict", "The file changed while it was being opened. Try again.");
      const bytes = buffer.subarray(0, length);
      return { text: decode(bytes), revision: sha(bytes), size: length };
    } finally {
      io.closeSync(fd);
    }
  }

  function closeWatcher(current) {
    if (current.timer) { clearTimer(current.timer); current.timer = null; }
    const watcher = current.watcher;
    current.watcher = null;
    current.watching = false;
    try { watcher?.close(); } catch { /* already closed */ }
  }
  function startWatcher(current) {
    const pending = new Set();
    let overflow = false;
    let firstAt = 0;
    const flush = () => {
      current.timer = null;
      firstAt = 0;
      if (open !== current) return;
      const change = { projectId: current.id, paths: overflow ? [] : [...pending], overflow, watching: current.watching };
      pending.clear();
      overflow = false;
      try { onChange(change); } catch { /* the window may be gone */ }
    };
    const schedule = () => {
      const at = now();
      if (!firstAt) firstAt = at;
      if (current.timer) clearTimer(current.timer);
      current.timer = setTimer(flush, at - firstAt >= WATCH_MAX_WAIT_MS ? 0 : WATCH_DEBOUNCE_MS);
    };
    const onEvent = (_type, filename) => {
      if (open !== current || !current.watcher) return;
      const name = typeof filename === "string" ? filename : Buffer.isBuffer(filename) ? filename.toString("utf8") : null;
      if (name === null || name === "") overflow = true;
      else {
        const relative = name.split(path.sep).join("/");
        const segments = relative.split("/");
        // Cheap, and first: an npm install inside node_modules must not even
        // schedule a batch.
        if (segments.some(isHiddenName) || JUNK_NAMES.has(segments[segments.length - 1].toLowerCase()) || TEMP_NAME.test(relative)) return;
        if (!overflow) {
          if (pending.size >= WATCH_MAX_PATHS) { overflow = true; pending.clear(); }
          else pending.add(relative);
        }
      }
      schedule();
    };
    try {
      current.watcher = watch(current.root, { recursive: true, persistent: false }, onEvent);
      current.watching = true;
      current.watcher.on?.("error", () => {
        if (open !== current) return;
        closeWatcher(current);
        overflow = true;
        flush();
      });
    } catch {
      current.watcher = null;
      current.watching = false;
    }
  }
  function close() {
    const current = open;
    open = null;
    if (current) closeWatcher(current);
  }

  return {
    maxFileBytes,
    list() {
      return guarded(() => ({ projects: load().map(publicEntry) }));
    },
    /** Main only: a folder the native picker answered. Never an IPC argument. */
    add(chosen) {
      return guarded(() => {
        const checked = check(chosen);
        if (!checked.ok) refuse(checked.code, checked.message);
        const list = load();
        const known = list.find((entry) => key(entry.root) === key(checked.root));
        if (known) return { project: publicEntry(known), existed: true };
        if (list.length >= MAX_PROJECTS) refuse("limit", `The Live Docs list holds up to ${MAX_PROJECTS} projects. Remove one first.`);
        const entry = { id: randomUUID(), root: checked.root, name: checked.name, addedAt: now() };
        list.push(entry);
        try { save(); } catch (error) { list.pop(); throw error; }
        return { project: publicEntry(entry), existed: false };
      });
    },
    /** Takes the project off the list. The folder itself is never touched. */
    remove(args) {
      return guarded(() => {
        const id = projectId(exactObject(args, ["id"]).id);
        const list = load();
        const at = list.findIndex((entry) => entry.id === id);
        if (at < 0) refuse("unknown-project", "That project is no longer in the Live Docs list.");
        if (open?.id === id) close();
        const [removed] = list.splice(at, 1);
        try { save(); } catch (error) { list.splice(at, 0, removed); throw error; }
        return {};
      });
    },
    open(args) {
      return guarded(() => {
        const entry = find(projectId(exactObject(args, ["id"]).id));
        const checked = check(entry.root);
        if (!checked.ok) refuse(checked.code, checked.message);
        // Added as one folder, now resolving to another: a symlink that was
        // repointed, or a folder swapped for one. Not the project that was added.
        if (key(checked.root) !== key(entry.root)) refuse("moved", `${entry.name} was moved or replaced. Remove it and add the folder again.`);
        const rootState = folderState(io, checked.root);
        close();
        const current = { id: entry.id, name: entry.name, root: checked.root, rootState, watcher: null, watching: false, timer: null };
        open = current;
        startWatcher(current);
        return { project: publicOpen(current) };
      });
    },
    close(args) {
      return guarded(() => {
        if (args !== undefined) refuse("invalid-request", "Invalid Live Docs request.");
        close();
        return {};
      });
    },
    /** Every file and folder of the open project, by project-relative path. */
    tree(args) {
      return guarded(() => {
        if (args !== undefined) refuse("invalid-request", "Invalid Live Docs request.");
        const current = requireOpen();
        assertRoot(current);
        const entries = [];
        let truncated = false;
        const walk = (folder, prefix, depth) => {
          let items;
          try { items = io.readdirSync(folder, { withFileTypes: true }); } catch { return; }
          for (const item of items) {
            if (entries.length >= MAX_TREE_ENTRIES) { truncated = true; return; }
            const name = item.name;
            if (isHiddenName(name) || JUNK_NAMES.has(name.toLowerCase()) || TEMP_NAME.test(name) || UNADDRESSABLE.test(name)) continue;
            const relative = prefix ? `${prefix}/${name}` : name;
            if (item.isSymbolicLink()) entries.push({ path: relative, kind: "link" });
            else if (item.isDirectory()) {
              entries.push({ path: relative, kind: "dir" });
              if (depth + 1 < MAX_TREE_DEPTH) walk(path.join(folder, name), relative, depth + 1);
              else truncated = true;
            } else if (item.isFile()) entries.push({ path: relative, kind: "file" });
          }
        };
        walk(current.root, "", 0);
        return { project: publicOpen(current), entries, truncated };
      });
    },
    read(args) {
      return guarded(() => {
        const request = exactObject(args, ["path"]);
        const entry = resolveFile(requireOpen(), request.path);
        const read = readEntry(entry);
        return { file: { path: entry.path, text: read.text, revision: read.revision, size: read.size } };
      });
    },
    write(args) {
      return guarded(() => {
        const request = exactObject(args, ["path", "text", "baseRevision"]);
        if (typeof request.text !== "string") refuse("invalid-request", "Invalid Live Docs request.");
        if (typeof request.baseRevision !== "string" || !REVISION_PATTERN.test(request.baseRevision)) refuse("invalid-request", "Invalid Live Docs request.");
        if (request.text.length > maxFileBytes) tooLarge();
        const bytes = Buffer.from(request.text, "utf8");
        if (bytes.length > maxFileBytes) tooLarge();
        if (bytes.includes(0)) refuse("binary", "Markie writes text files only.");
        const current = requireOpen();
        const entry = resolveFile(current, request.path);
        // Run before staging and again at the instant of the rename: the root
        // and the file's folder are the ones that were checked, the file is
        // still a regular file (not a symlink, not another inode), and its
        // bytes are the revision the editor started from.
        const verify = () => {
          assertRoot(current);
          let parent;
          try { parent = folderState(io, path.dirname(entry.target)); } catch { parent = null; }
          if (!parent || !sameFolderState(parent, entry.parent, key)) refuse("conflict", "The folder holding this file was moved or replaced. Reopen the project.");
          let stat;
          try { stat = io.lstatSync(entry.target, { bigint: true }); }
          catch (error) {
            if (error && error.code === "ENOENT") refuse("conflict", "This file was deleted or renamed outside Markie.");
            throw error;
          }
          if (stat.isSymbolicLink()) refuse("symlink", SYMLINK);
          if (!stat.isFile()) refuse("not-a-file", "That is not a regular file.");
          if (readEntry({ ...entry, stat }).revision !== request.baseRevision) refuse("conflict", "This file changed on disk since it was opened.");
          return stat;
        };
        const before = verify();
        const staged = Object.create(io);
        // atomic-write resolves a symlink at the target and writes through it.
        // A project write never does; at worst the swap is caught at rename.
        staged.realpathSync = () => refuse("symlink", SYMLINK);
        // The temporary file is created exclusively, refusing a symlink in any
        // part of its path, so it is pinned in the checked folder: a folder
        // swapped in later cannot receive it, and the rename then fails.
        staged.writeFileSync = (temporary, data, options = {}) => {
          const flags = io.constants.O_WRONLY | io.constants.O_CREAT | io.constants.O_EXCL | noFollow;
          const fd = io.openSync(temporary, flags, options.mode ?? 0o666);
          try { io.writeFileSync(fd, data, options.encoding ? { encoding: options.encoding } : undefined); }
          finally { io.closeSync(fd); }
        };
        staged.renameSync = (temporary, destination) => {
          if (destination !== entry.target || path.dirname(temporary) !== path.dirname(entry.target)) refuse("conflict", "The save target changed. Reopen the file.");
          const stat = verify();
          if (identity(stat) !== identity(before)) refuse("conflict", "This file was replaced on disk since it was opened.");
          // rename(2) replaces the name itself: it never writes through a
          // symlink that might appear at the destination.
          io.renameSync(temporary, destination);
        };
        writeFileAtomic(entry.target, bytes, { fs: staged, platform, spawn: noSpawn });
        const saved = readEntry(resolveFile(current, entry.path));
        return { file: { path: entry.path, revision: saved.revision, size: saved.size } };
      });
    },
    /** Main only: stop watching and forget the open project. Safe to call at any time. */
    closeNow() {
      try { close(); } catch { /* best effort */ }
    },
    /** Tests and main: the open project's id, or null. */
    openId() {
      return open?.id ?? null;
    },
  };
}

/**
 * The IPC edge. Every handler refuses unless the nightly gate is open in main
 * and the sender is the main window's own main frame, before it reads its
 * arguments. Folders come only from `pickFolder`, which main backs with the
 * native dialog.
 *
 * @param {{
 *   service: ReturnType<typeof createLiveDocsProjects>,
 *   enabled: () => boolean,
 *   trusted: (event: unknown) => boolean,
 *   pickFolder: () => Promise<string | null>,
 * }} options
 */
function createLiveDocsProjectIpc({ service, enabled, trusted, pickFolder }) {
  const refusal = (event) => {
    if (!enabled()) return { ok: false, code: "unavailable", message: "Live Docs projects are not in this build of Markie." };
    if (!trusted(event)) return { ok: false, code: "forbidden", message: "Only Markie's own window can use Live Docs projects." };
    return null;
  };
  const guard = (operation) => async (event, ...args) => {
    const refused = refusal(event);
    if (refused) return refused;
    if (args.length > 1) return failure(new ProjectError("invalid-request", "Invalid Live Docs request."));
    return operation(args[0]);
  };
  const noArguments = (args) => (args === undefined ? null : failure(new ProjectError("invalid-request", "Invalid Live Docs request.")));
  return {
    list: guard((args) => noArguments(args) ?? service.list()),
    add: guard(async (args) => {
      const invalid = noArguments(args);
      if (invalid) return invalid;
      let chosen;
      try { chosen = await pickFolder(); } catch { return { ok: false, code: "io-error", message: "The folder picker could not open." }; }
      if (typeof chosen !== "string" || !chosen) return { ok: false, code: "canceled", message: "" };
      return service.add(chosen);
    }),
    remove: guard((args) => service.remove(args)),
    open: guard((args) => service.open(args)),
    close: guard((args) => service.close(args)),
    tree: guard((args) => service.tree(args)),
    read: guard((args) => service.read(args)),
    write: guard((args) => service.write(args)),
  };
}

module.exports = {
  createLiveDocsProjects,
  createLiveDocsProjectIpc,
  parseRelativePath,
  MAX_FILE_BYTES,
  MAX_PROJECTS,
  MAX_TREE_ENTRIES,
  WATCH_MAX_PATHS,
  WATCH_DEBOUNCE_MS,
  HIDDEN_NAMES,
};
