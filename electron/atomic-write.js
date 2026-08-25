// One way to write a file the user owns.
//
// fs.writeFileSync truncates first and writes after. A crash, a full disk, or a
// process kill in between leaves the document empty or half written, and the
// only copy of it was the one being replaced. Every user-file write in the main
// process goes through here instead: a temp file beside the original, fsynced,
// then renamed over it. rename(2) is atomic within a filesystem, so a reader
// either sees the old file or the new one and never a truncated one.
//
// Two things the naive version loses and this one keeps:
//   - the original's permission bits, because a 0600 note must not come back
//     0644 after a save;
//   - macOS extended attributes, which is where Finder tags live. A document
//     that loses its colour tag on every save is a document the user stops
//     trusting.
//
// Known tradeoff, accepted: rename replaces the inode, so a hard link to the
// document no longer follows its edits. Symlinks are followed (resolved before
// the write) so saving through one still updates the file it points at.
//
// Dependency-injected and Electron-free, like crash-log.js, so it can be tested
// with fakes and against a real tmpdir.

const nodeFs = require("fs");
const nodePath = require("path");
const nodeChildProcess = require("child_process");

const XATTR = "/usr/bin/xattr";
// Bounded work on a path that is best-effort anyway: a document with hundreds
// of extended attributes must not turn one save into hundreds of subprocesses.
const MAX_XATTRS = 32;

function uniqueSuffix() {
  return `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

// Beside the original, not in /tmp: rename is only atomic within one
// filesystem, and /tmp is frequently a different one.
//
// The name starts with the original's, so a test (or a person) watching the
// directory can tell which document a stray temp file belongs to.
function tempPathFor(filePath, path) {
  return path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.markie-${uniqueSuffix()}.tmp`
  );
}

function runXattr(spawn, args) {
  const res = spawn(XATTR, args, { encoding: "utf-8" });
  if (!res || res.error || res.status !== 0) return null;
  return typeof res.stdout === "string" ? res.stdout : "";
}

// [{ key, hex }] for the file's extended attributes, or [] when there are none,
// when this is not macOS, or when anything at all goes wrong. Hex (-x) because
// an attribute value is arbitrary bytes and the plain form is not round-trippable.
function readXattrs(filePath, { spawn, platform }) {
  if (platform !== "darwin") return [];
  try {
    const listed = runXattr(spawn, [filePath]);
    if (!listed) return [];
    const keys = listed
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, MAX_XATTRS);
    const out = [];
    for (const key of keys) {
      const hex = runXattr(spawn, ["-p", "-x", filePath, key]);
      if (hex == null) continue;
      const compact = hex.replace(/[^0-9a-fA-F]/g, "");
      if (compact) out.push({ key, hex: compact });
    }
    return out;
  } catch {
    return []; // metadata is a nicety; the write is not
  }
}

function restoreXattrs(filePath, attrs, { spawn, platform }) {
  if (platform !== "darwin" || attrs.length === 0) return;
  for (const attr of attrs) {
    try {
      runXattr(spawn, ["-w", "-x", attr.key, attr.hex, filePath]);
    } catch {
      // one lost tag is not worth failing a save that already succeeded
    }
  }
}

// writeFileAtomic(filePath, data) — write, fsync, rename over the original.
//
// Throws what the underlying write throws: callers already report a failed save
// to the user, and swallowing it here would report a success that never landed.
function writeFileAtomic(filePath, data, options = {}) {
  const {
    fs = nodeFs,
    path = nodePath,
    platform = process.platform,
    spawn = nodeChildProcess.spawnSync,
    encoding = "utf-8",
  } = options;

  // A save through a symlink must update the file the link points at, not
  // replace the link with a regular file.
  // Only when it really is one: resolving every path would rewrite /var to
  // /private/var on macOS and report a path the caller never asked about.
  let target = filePath;
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      target = fs.realpathSync(filePath);
    }
  } catch {
    // no such file yet (the common create case) — write where we were asked to
  }

  let mode;
  try {
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    mode = undefined; // new file: let the process umask decide
  }
  const attrs = readXattrs(target, { spawn, platform });

  const tmp = tempPathFor(target, path);
  try {
    fs.writeFileSync(tmp, data, {
      encoding,
      ...(mode === undefined ? {} : { mode }),
      // Refuse to follow anything already sitting at the temp name: in a shared
      // directory that is a symlink-swap invitation.
      flag: "wx",
    });
    // The rename is atomic, but only with respect to what the filesystem has
    // actually been handed. Without this, a crash after the rename can leave
    // the new name pointing at a file whose contents never reached the disk.
    const fd = fs.openSync(tmp, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    restoreXattrs(tmp, attrs, { spawn, platform });
    fs.renameSync(tmp, target);
    // The data was fsynced above; the rename itself lives in the directory.
    // Best effort — a filesystem that refuses to open a directory still
    // performed the rename, and Windows has no directory fsync at all.
    if (platform !== "win32") {
      try {
        const dirFd = fs.openSync(path.dirname(target), "r");
        try {
          fs.fsyncSync(dirFd);
        } finally {
          fs.closeSync(dirFd);
        }
      } catch {
        // the rename happened; durability of the name is best effort
      }
    }
    return target;
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // a stray temp file is better than masking the real failure
    }
    // A permission failure here names the temp file, which the user has never
    // heard of and which no longer exists. Name the file they were saving and
    // the folder that refused.
    if (err && (err.code === "EACCES" || err.code === "EPERM" || err.code === "EROFS")) {
      const friendly = new Error(
        `Markie can't write "${path.basename(target)}" because the folder ` +
          `"${path.dirname(target)}" doesn't allow it (${err.code}).`
      );
      friendly.code = err.code;
      friendly.cause = err;
      throw friendly;
    }
    throw err;
  }
}

module.exports = { writeFileAtomic, tempPathFor };
