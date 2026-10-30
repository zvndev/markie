// Markie's own records about a document: comments today, branches and block
// versions next (docs/superpowers/specs/2026-10-30-doc-features-nightly.md,
// decision 1).
//
// One folder per document under userData/doc-meta/, named exactly like the
// version-history folder (slugFor in snapshots.js), so a person browsing
// userData finds a document's history and its records under the same name.
// Each kind of record is one JSON file in that folder (comments.json, later
// branches.json), and doc.json says which path the folder belongs to.
//
// Rules this module keeps:
//   - Markie's main process is the only writer, and it never writes into or
//     beside the user's file. Everything lives under userData.
//   - Every write is atomic (atomic-write.js), so a crash mid-write leaves the
//     previous records, never a truncated JSON file.
//   - A rename or move Markie makes carries the folder along (move()).
//   - Nothing here ever deletes a record because its document went missing. A
//     file moved outside Markie leaves its folder where it was, and doc.json
//     still names the old path, so a later "is this the same document?" step
//     can offer to reattach it.
//
// Electron-free and dependency-injected, like snapshots.js.
"use strict";

const nodeFs = require("fs");
const nodePath = require("path");
const nodeCrypto = require("crypto");
const { slugFor } = require("./snapshots.js");
const { writeFileAtomic } = require("./atomic-write.js");

const DOC_FILE = "doc.json";
// A record kind is a plain file name: no separators, no dots in front.
const KIND_RE = /^[a-z][a-z0-9-]{0,39}$/;

function createDocMeta(options = {}) {
  const {
    dir,
    fs = nodeFs,
    path = nodePath,
    crypto = nodeCrypto,
    now = () => new Date(),
    platform = process.platform,
  } = options;
  if (!dir) throw new Error("doc-meta needs a directory");
  const root = path.join(dir, "doc-meta");

  // No xattr copy: these are Markie's own files, there are no Finder tags to
  // keep, and on macOS reading them costs a subprocess per write.
  const write = (file, body) => writeFileAtomic(file, body, { fs, path, platform, spawn: () => null });

  function dirFor(filePath) {
    return path.join(root, slugFor(filePath, { path, crypto }));
  }

  function fileFor(filePath, kind) {
    if (!KIND_RE.test(String(kind))) throw new Error(`Not a record kind: ${kind}`);
    return path.join(dirFor(filePath), `${kind}.json`);
  }

  function readJson(file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  /** The record of this kind for the document, or null when there is none. */
  function read(filePath, kind) {
    return readJson(fileFor(filePath, kind));
  }

  /** Replace the record of this kind for the document, atomically. */
  function writeRecord(filePath, kind, value) {
    const file = fileFor(filePath, kind);
    const folder = path.dirname(file);
    fs.mkdirSync(folder, { recursive: true });
    write(file, JSON.stringify(value, null, 2));
    write(
      path.join(folder, DOC_FILE),
      JSON.stringify({ path: path.resolve(String(filePath)), updatedAt: now().toISOString() }, null, 2)
    );
    return file;
  }

  /** Every folder in the store with the path its doc.json names. */
  function all() {
    let slugs;
    try {
      slugs = fs.readdirSync(root);
    } catch {
      return [];
    }
    const out = [];
    for (const slug of slugs) {
      const folder = path.join(root, slug);
      const doc = readJson(path.join(folder, DOC_FILE));
      if (doc && typeof doc.path === "string") out.push({ folder, path: doc.path });
    }
    return out;
  }

  function within(parent, child) {
    const rel = path.relative(parent, child);
    return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  // Never overwrite a folder that is already there: a document created at the
  // destination path may have records of its own. Set it aside under a
  // suffixed name instead, so neither set is lost.
  function setAside(folder) {
    let n = 1;
    let target = `${folder}.replaced-${n}`;
    while (fs.existsSync(target)) target = `${folder}.replaced-${++n}`;
    fs.renameSync(folder, target);
  }

  function moveOne(fromFolder, toPath) {
    const toFolder = dirFor(toPath);
    if (fromFolder === toFolder) return false;
    if (fs.existsSync(toFolder)) setAside(toFolder);
    fs.mkdirSync(root, { recursive: true });
    fs.renameSync(fromFolder, toFolder);
    const docFile = path.join(toFolder, DOC_FILE);
    const doc = readJson(docFile) || {};
    write(docFile, JSON.stringify({ ...doc, path: path.resolve(toPath), movedAt: now().toISOString() }, null, 2));
    return true;
  }

  /**
   * Carry records along after Markie renamed or moved `from` to `to`. Either
   * may be a file or a folder: moving a folder carries every document under
   * it. Returns how many documents' records moved. Best effort per document,
   * so one stuck folder does not strand the rest.
   */
  function move(from, to) {
    const src = path.resolve(String(from || ""));
    const dest = path.resolve(String(to || ""));
    if (!from || !to || src === dest) return 0;
    let moved = 0;
    for (const entry of all()) {
      const recorded = path.resolve(entry.path);
      let next = null;
      if (recorded === src) next = dest;
      else if (within(src, recorded)) next = path.join(dest, path.relative(src, recorded));
      if (!next) continue;
      try {
        if (moveOne(entry.folder, next)) moved++;
      } catch {
        // leave this one where it is; doc.json still names its document
      }
    }
    return moved;
  }

  return { root, dirFor, read, write: writeRecord, move, all };
}

module.exports = { createDocMeta, DOC_FILE };
