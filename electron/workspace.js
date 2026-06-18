// Files-view workspace: real folder operations on disk, confined to the user's
// workspace roots. Backs the Library "Files" finder view.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { shell } = require("electron");
const registry = require("./registry");

const OPENABLE = /\.(md|markdown|mdx|txt|csv)$/i;

function defaultRootPath() {
  return path.join(os.homedir(), "Documents", "Markie");
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

// A path is allowed if it sits inside (or equals) one of the workspace roots.
function withinRoots(target) {
  const resolved = path.resolve(target);
  return roots().some((root) => {
    const r = path.resolve(root);
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

function mkdir(parent, name) {
  guard(parent);
  const safe = name.replace(/[/\\]/g, "").trim();
  if (!safe) return { error: "Invalid name" };
  const dir = path.join(parent, safe);
  if (fs.existsSync(dir)) return { error: "A folder with that name exists" };
  fs.mkdirSync(dir);
  return { ok: true, path: dir };
}

function newFile(parent, name) {
  guard(parent);
  let safe = name.replace(/[/\\]/g, "").trim() || "untitled.md";
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

function rename(target, newName) {
  guard(target);
  const safe = newName.replace(/[/\\]/g, "").trim();
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
  await shell.trashItem(target);
  return { ok: true };
}

function reveal(target) {
  shell.showItemInFolder(target);
  return { ok: true };
}

module.exports = {
  defaultRootPath,
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
