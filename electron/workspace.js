// Files-view workspace: real folder operations on disk, confined to the user's
// workspace roots. Backs the Library "Files" finder view.
const fs = require("fs");
const path = require("path");
const os = require("os");
const registry = require("./registry");

const OPENABLE = /\.(md|markdown|mdx|txt|csv)$/i;

// Lazily, so this module can be required (and unit tested) outside Electron —
// the same reason registry.js defers better-sqlite3.
function electronShell() {
  return require("electron").shell;
}

// Where the OS actually puts Documents. Hard-coding ~/Documents is wrong on
// Windows whenever OneDrive Known Folder Move is on (Documents lives under
// %USERPROFILE%\OneDrive). On macOS/Linux we deliberately stay on
// os.homedir()/Documents: it honours a HOME override (the e2e scripts run the
// app against a temporary home), whereas Electron's getPath("documents") always
// resolves the real user folder and would leak test files into it.
function documentsDir(platform = process.platform) {
  if (platform === "win32") {
    try {
      const { app } = require("electron");
      const resolved = app && typeof app.getPath === "function" ? app.getPath("documents") : null;
      if (resolved) return resolved;
    } catch {
      // not running inside Electron (tests, tooling) — fall through
    }
  }
  return path.join(os.homedir(), "Documents");
}

function defaultRootPath() {
  return path.join(documentsDir(), "Markie");
}

// Names Windows refuses outright, whatever extension is attached.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// A file/folder name the user typed, made safe to join onto a path. Returns
// null when nothing usable survives, so callers report "Invalid name" instead
// of writing to a path the user did not mean. Windows rules are applied only on
// Windows (injected `platform` so the rule is testable from any host), but path
// separators, control characters and `.`/`..` are refused everywhere.
function sanitizeName(name, platform = process.platform) {
  let safe = String(name ?? "").replace(/[/\\]/g, "");
  // eslint-disable-next-line no-control-regex
  safe = safe.replace(/[\x00-\x1f]/g, "");
  if (platform === "win32") safe = safe.replace(/[:*?"<>|]/g, "");
  safe = safe.trim();
  // Windows silently strips trailing dots and spaces, so "notes." becomes a
  // different file from the one the user asked for.
  if (platform === "win32") safe = safe.replace(/[. ]+$/, "");
  if (!safe || safe === "." || safe === "..") return null;
  if (platform === "win32" && WINDOWS_RESERVED.test(safe)) return null;
  return safe;
}

// Create the default ~/Documents/Markie workspace and register it.
function createDefaultRoot() {
  const root = defaultRootPath();
  fs.mkdirSync(root, { recursive: true });
  registry.addRoot(root);
  return root;
}

function addRoot(rootPath) {
  if (!rootPath || !fs.existsSync(rootPath)) return { error: "Folder not found" };
  registry.addRoot(rootPath);
  return { ok: true, path: rootPath };
}

function removeRoot(rootPath) {
  registry.removeRoot(rootPath);
  return { ok: true };
}

function roots() {
  return registry.listRoots().filter((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false; // root folder was deleted/moved outside the app
    }
  });
}

// Windows paths are case-insensitive, so the same folder reached as
// C:\Users\me\Notes and c:\users\me\notes is one folder. Comparing them
// byte-for-byte locked the user out of their own workspace. Matches the rule
// file-grants.js already uses.
function normalizeForCompare(target, platform = process.platform) {
  const resolved = path.resolve(target);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

// A path is allowed if it sits inside (or equals) one of the workspace roots.
function withinRoots(target, { platform = process.platform, rootList = null } = {}) {
  const resolved = normalizeForCompare(target, platform);
  return (rootList ?? roots()).some((root) => {
    const r = normalizeForCompare(root, platform);
    return resolved === r || resolved.startsWith(r + path.sep);
  });
}

function guard(target) {
  if (!withinRoots(target)) throw new Error("Outside the workspace");
}

function listDir(dirPath) {
  guard(dirPath);
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const folders = [];
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue; // hide dotfiles
    const full = path.join(dirPath, e.name);
    if (e.isDirectory()) {
      folders.push({ name: e.name, path: full });
    } else if (OPENABLE.test(e.name)) {
      files.push({ name: e.name, path: full, ext: path.extname(e.name).slice(1) });
    }
  }
  folders.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { folders, files };
}

function mkdir(parent, name, { platform = process.platform } = {}) {
  guard(parent);
  const safe = sanitizeName(name, platform);
  if (!safe) return { error: "Invalid name" };
  const dir = path.join(parent, safe);
  if (fs.existsSync(dir)) return { error: "A folder with that name exists" };
  fs.mkdirSync(dir);
  return { ok: true, path: dir };
}

function newFile(parent, name, { platform = process.platform } = {}) {
  guard(parent);
  let safe = sanitizeName(name, platform) || "untitled.md";
  if (!/\.[a-z0-9]+$/i.test(safe)) safe += ".md";
  const file = path.join(parent, safe);
  if (fs.existsSync(file)) return { error: "A file with that name exists" };
  fs.writeFileSync(file, "", "utf-8");
  return { ok: true, path: file };
}

function move(src, destDir) {
  guard(src);
  guard(destDir);
  const base = path.basename(src);
  const dest = path.join(destDir, base);
  if (path.resolve(src) === path.resolve(dest)) return { ok: true, path: dest };
  if (fs.existsSync(dest)) return { error: "Already a file with that name there" };
  const isDir = fs.statSync(src).isDirectory();
  fs.renameSync(src, dest);
  if (isDir) registry.movePrefix(src + path.sep, dest + path.sep);
  else registry.movePath(src, dest);
  return { ok: true, path: dest };
}

function rename(target, newName, { platform = process.platform } = {}) {
  guard(target);
  const safe = sanitizeName(newName, platform);
  if (!safe) return { error: "Invalid name" };
  const dest = path.join(path.dirname(target), safe);
  if (fs.existsSync(dest)) return { error: "That name is taken" };
  const isDir = fs.statSync(target).isDirectory();
  fs.renameSync(target, dest);
  if (isDir) registry.movePrefix(target + path.sep, dest + path.sep);
  else registry.movePath(target, dest);
  return { ok: true, path: dest };
}

async function trash(target) {
  guard(target);
  await electronShell().trashItem(target);
  return { ok: true };
}

function reveal(target) {
  guard(target);
  electronShell().showItemInFolder(target);
  return { ok: true };
}

module.exports = {
  defaultRootPath,
  documentsDir,
  sanitizeName,
  withinRoots,
  createDefaultRoot,
  addRoot,
  removeRoot,
  roots,
  listDir,
  mkdir,
  newFile,
  move,
  rename,
  trash,
  reveal,
};
