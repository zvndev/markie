// A copy of what the file said before this save.
//
// Atomic writes make sure a save never leaves a half-written document. They do
// nothing about the save itself being wrong: an agent that rewrote the buffer,
// a paste over a selection, a sync resolution the user regrets. Undo is in the
// editor's memory and dies with the window, and Time Machine is not on by
// default. So every overwrite of an existing document first copies the previous
// content to userData/snapshots/<hash8(path)>-<basename>/<timestamp>.md.
//
// Bounded on purpose. Snapshots are a safety net, not a backup product: 20 per
// document and 200 MB across all of them, oldest pruned first, so a machine
// with a busy agent does not quietly fill its disk with old drafts.
//
// Electron-free and dependency-injected, so it is testable without the binary.

const nodeFs = require("fs");
const nodePath = require("path");
const nodeCrypto = require("crypto");

const DEFAULT_MAX_PER_FILE = 20;
const DEFAULT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

// One directory per document, named so a person browsing userData can tell
// which file it belongs to, and so two documents with the same basename in
// different folders never share a directory.
function slugFor(filePath, { path = nodePath, crypto = nodeCrypto } = {}) {
  const absolute = path.resolve(String(filePath || ""));
  const hash = crypto.createHash("sha256").update(absolute).digest("hex").slice(0, 8);
  const base = path.basename(absolute).replace(/[^\w.\- ]/g, "_").slice(0, 60) || "document";
  return `${hash}-${base}`;
}

// Colons are legal on POSIX and illegal on Windows, and Finder renders them as
// slashes. An ISO stamp needs them replaced before it can be a filename.
function stampFor(date) {
  return date.toISOString().replace(/:/g, "-");
}

function createSnapshots(options = {}) {
  const {
    dir,
    fs = nodeFs,
    path = nodePath,
    crypto = nodeCrypto,
    now = () => new Date(),
    maxPerFile = DEFAULT_MAX_PER_FILE,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  } = options;

  const root = path.join(dir, "snapshots");

  function dirFor(filePath) {
    return path.join(root, slugFor(filePath, { path, crypto }));
  }

  // Newest last. The names are ISO stamps with the colons swapped, so string
  // order is time order.
  function list(filePath) {
    try {
      return fs
        .readdirSync(dirFor(filePath))
        .filter((name) => name.endsWith(".md"))
        .sort();
    } catch {
      return [];
    }
  }

  function has(filePath) {
    return list(filePath).length > 0;
  }

  function sizeOf(file) {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  }

  // Oldest first, across every document. Used by the global cap, which has to
  // compare snapshots that belong to different files.
  function allSnapshots() {
    let slugs;
    try {
      slugs = fs.readdirSync(root);
    } catch {
      return [];
    }
    const out = [];
    for (const slug of slugs) {
      const folder = path.join(root, slug);
      let names;
      try {
        names = fs.readdirSync(folder);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".md")) continue;
        const file = path.join(folder, name);
        out.push({ file, name, bytes: sizeOf(file) });
      }
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  function remove(file) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // an unremovable snapshot is not worth failing a save over
    }
  }

  function prunePerFile(filePath) {
    const names = list(filePath);
    const folder = dirFor(filePath);
    for (const name of names.slice(0, Math.max(0, names.length - maxPerFile))) {
      remove(path.join(folder, name));
    }
  }

  function pruneTotal() {
    const all = allSnapshots();
    let total = all.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of all) {
      if (total <= maxTotalBytes) break;
      remove(entry.file);
      total -= entry.bytes;
    }
  }

  // capture(filePath, nextContent) — snapshot what is on disk now, if it is
  // worth snapshotting.
  //
  // Returns { ok } with the snapshot path, or { skipped } with a reason. A
  // failure is reported, never thrown: this runs in front of a save, and the
  // save is the thing that matters.
  function capture(filePath, nextContent) {
    let previous;
    try {
      previous = fs.readFileSync(filePath, "utf-8");
    } catch {
      // No file there yet. Save As to a new name has nothing to protect.
      return { skipped: "no-file" };
    }
    if (typeof nextContent === "string" && nextContent === previous) {
      return { skipped: "unchanged" };
    }
    const folder = dirFor(filePath);
    let target = path.join(folder, `${stampFor(now())}.md`);
    try {
      fs.mkdirSync(folder, { recursive: true });
      // `wx`: two saves inside the same millisecond must not have the second
      // overwrite the first's snapshot. The second gets a suffixed name
      // instead of losing its snapshot.
      try {
        fs.writeFileSync(target, previous, { encoding: "utf-8", flag: "wx" });
      } catch (err) {
        if (!err || err.code !== "EEXIST") throw err;
        target = path.join(folder, `${stampFor(now())}-2.md`);
        fs.writeFileSync(target, previous, { encoding: "utf-8", flag: "wx" });
      }
    } catch (err) {
      return { skipped: "write-failed", error: String(err && err.message ? err.message : err) };
    }
    try {
      prunePerFile(filePath);
      pruneTotal();
    } catch {
      // over the cap for one more save is better than a failed save
    }
    return { ok: true, path: target };
  }

  return { capture, dirFor, list, has, root };
}

module.exports = {
  createSnapshots,
  slugFor,
  stampFor,
  DEFAULT_MAX_PER_FILE,
  DEFAULT_MAX_TOTAL_BYTES,
};
