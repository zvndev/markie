const fs = require("fs");
const path = require("path");

const OPENABLE = /\.(md|markdown|mdx|txt|csv)$/i;

function defaultRealpath(target) {
  return fs.realpathSync.native(target);
}

function createFileGrants({
  workspaceRoots = () => [],
  exists = fs.existsSync,
  realpath = defaultRealpath,
  platform = process.platform,
} = {}) {
  const grantedFiles = new Set();
  // Files the user dragged into a document. Deliberately a separate set from
  // grantedFiles: dropping a PDF onto a document is permission to show or open
  // that one file, and must never become permission to load it as a document
  // or write over it. Only the asset rule reads this.
  const attachedFiles = new Set();
  const isWindows = platform === "win32";

  const key = (target) => (isWindows ? target.toLowerCase() : target);

  const normalizeExisting = (target) => {
    if (typeof target !== "string" || target.trim() === "") return null;
    try {
      return path.resolve(realpath(target));
    } catch {
      return null;
    }
  };

  const normalizeParentBound = (target) => {
    if (typeof target !== "string" || target.trim() === "") return null;
    const resolved = path.resolve(target);
    if (exists(resolved)) return normalizeExisting(resolved);
    const parent = normalizeExisting(path.dirname(resolved));
    if (!parent) return null;
    return path.join(parent, path.basename(resolved));
  };

  const isOpenable = (target) => OPENABLE.test(path.basename(String(target || "")));

  const contains = (parent, child) => {
    const rel = path.relative(parent, child);
    return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
  };

  const canonicalWorkspaceRoots = () =>
    workspaceRoots()
      .map((root) => normalizeExisting(root))
      .filter(Boolean);

  const isInWorkspaceRoot = (target) => {
    const normalized = normalizeParentBound(target);
    if (!normalized) return false;
    return canonicalWorkspaceRoots().some((root) => contains(root, normalized));
  };

  // Which folders a document is allowed to show pictures from. Deliberately
  // derived from grants rather than declared by the renderer: a folder is
  // reachable because the user opened a document out of it, which already went
  // through canRead above. Nothing new is trusted by adding assets.
  const assetRoots = () => {
    const dirs = new Set();
    for (const granted of grantedFiles) dirs.add(path.dirname(granted));
    for (const root of canonicalWorkspaceRoots()) dirs.add(root);
    return [...dirs];
  };

  // Any file type, because an attachment is a picture, a clip, a PDF or a zip.
  // The gate is that a person dragged it in, which is the same gesture as
  // choosing it in the Open dialog and is the only thing that makes it
  // reachable at all.
  const grantAttachment = (target) => {
    const normalized = normalizeExisting(target);
    if (!normalized) return { ok: false, error: "File not found" };
    attachedFiles.add(key(normalized));
    return { ok: true, path: normalized };
  };

  // Every file the user has explicitly opened or dropped, for the asset rule.
  // Their folders are not included on purpose: dropping one file off the
  // Desktop must not make the whole Desktop readable by any open document.
  const grantedFilePaths = () => [...grantedFiles, ...attachedFiles];

  const hasExactFileGrant = (target) => {
    const normalized = normalizeExisting(target);
    return !!normalized && grantedFiles.has(key(normalized));
  };

  const grantFile = (target) => {
    if (!isOpenable(target)) return { ok: false, error: "Unsupported file type" };
    const normalized = normalizeExisting(target);
    if (!normalized) return { ok: false, error: "File not found" };
    grantedFiles.add(key(normalized));
    return { ok: true, path: normalized };
  };

  const canRead = (target) => {
    if (!isOpenable(target)) return { ok: false, error: "Unsupported file type" };
    const normalized = normalizeExisting(target);
    if (!normalized) return { ok: false, error: "File not found" };
    if (grantedFiles.has(key(normalized)) || isInWorkspaceRoot(normalized)) {
      return { ok: true, path: normalized };
    }
    return { ok: false, error: "File access was not granted" };
  };

  const canWrite = (target) => {
    if (!isOpenable(target)) return { ok: false, error: "Unsupported file type" };
    const normalized = normalizeParentBound(target);
    if (!normalized) return { ok: false, error: "File path is not writable" };
    if (grantedFiles.has(key(normalized)) || isInWorkspaceRoot(normalized)) {
      return { ok: true, path: normalized };
    }
    return { ok: false, error: "File access was not granted" };
  };

  const safeRenameTarget = (oldPath, newName) => {
    if (typeof newName !== "string") return null;
    const trimmed = newName.trim();
    if (!trimmed || trimmed !== path.basename(trimmed)) return null;
    if (!isOpenable(trimmed)) return null;
    const oldNormalized = normalizeExisting(oldPath);
    if (!oldNormalized) return null;
    return path.join(path.dirname(oldNormalized), trimmed);
  };

  const canRename = (oldPath, newName) => {
    const oldGrant = canWrite(oldPath);
    if (!oldGrant.ok) return oldGrant;
    const nextPath = safeRenameTarget(oldGrant.path, newName);
    if (!nextPath) return { ok: false, error: "Invalid file name" };
    if (exists(nextPath)) return { ok: false, error: "A file with that name already exists" };
    return { ok: true, oldPath: oldGrant.path, newPath: nextPath, name: path.basename(nextPath) };
  };

  const moveGrant = (oldPath, newPath) => {
    const oldNormalized = normalizeExisting(oldPath) ?? normalizeParentBound(oldPath);
    const nextNormalized = normalizeExisting(newPath);
    if (!oldNormalized || !nextNormalized) return;
    if (grantedFiles.delete(key(oldNormalized))) {
      grantedFiles.add(key(nextNormalized));
    }
  };

  return {
    grantFile,
    canRead,
    canWrite,
    canRename,
    moveGrant,
    isInWorkspaceRoot,
    hasExactFileGrant,
    assetRoots,
    grantAttachment,
    grantedFilePaths,
  };
}

module.exports = { createFileGrants, OPENABLE };
