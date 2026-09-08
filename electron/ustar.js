// A tar reader, just enough of one to open a GitHub source tarball.
//
// Markie may not add a runtime dependency (the release preflight refuses one),
// and the skill catalog has to read `codeload.github.com/.../tar.gz`. Node
// gunzips it already, so the only missing piece is the archive format, and the
// slice of it GitHub emits is small: ustar headers, 512-byte blocks, the
// `prefix` field for paths over 100 characters, and the two long-name escapes
// (GNU `././@LongLink` and a pax extended header) that different git versions
// reach for on the same repository.
//
// Everything that is not a regular file is dropped rather than described. A
// symlink, a hardlink or a device node has no meaning in a skill folder, and
// unpacking one is how an archive writes outside the directory it was given.
// So is a path with `..` in it, or an absolute one, and both are refused here
// rather than at the call site.
const BLOCK = 512;

function text(buf) {
  const end = buf.indexOf(0);
  return buf.toString("utf8", 0, end === -1 ? buf.length : end);
}

// Header numbers are NUL- or space-terminated octal. A field left empty means
// zero, which is what an unset mode or a header-only entry carries.
function octal(buf) {
  const raw = text(buf).trim();
  if (!raw) return 0;
  const value = Number.parseInt(raw, 8);
  return Number.isFinite(value) ? value : 0;
}

function isZeroBlock(buf) {
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
  return true;
}

// The archive's own name for an entry, made safe to join onto a directory, or
// null when it can never be safe. Backslashes are folded to separators first so
// a Windows-shaped name cannot smuggle a segment past the `..` check.
function normalizePath(raw) {
  const candidate = String(raw || "").replace(/\\/g, "/");
  if (!candidate) return null;
  if (candidate.startsWith("/")) return null;
  if (/^[A-Za-z]:/.test(candidate)) return null;
  const parts = candidate.split("/").filter((part) => part !== "" && part !== ".");
  if (!parts.length) return null;
  if (parts.some((part) => part === "..")) return null;
  return parts.join("/");
}

// A pax extended header is a sequence of `<length> <key>=<value>\n` records.
// Only `path` matters here: it is what git writes instead of a GNU long name.
// The length counts bytes, so the boundaries are found on the bytes and each
// record is decoded on its own. Decoding the whole header first put the
// boundaries at character counts, and a path with a multibyte character in it
// then swallowed the start of the record after it.
function paxRecords(data) {
  const out = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.toString("latin1", offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const end = Math.min(offset + length, data.length);
    const record = data.toString("utf8", space + 1, end).replace(/\n$/, "");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return out;
}

/**
 * Read a tar archive.
 *
 * @param {Buffer} buffer the uncompressed archive
 * @returns {{ path: string, size: number, mode: number, type: "file", data: Buffer }[]}
 *   every regular file in it, in archive order, with unsafe paths dropped
 */
function parseTar(buffer) {
  const files = [];
  if (!buffer || !buffer.length) return files;
  let offset = 0;
  // Set by a long-name header and consumed by the entry that follows it.
  let overrideName = null;
  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) break;
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 0).replace("\0", "0");
    const dataStart = offset + BLOCK;
    const data = buffer.subarray(dataStart, Math.min(dataStart + size, buffer.length));
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "L") {
      // GNU `././@LongLink`: the next entry's real name is this entry's body.
      overrideName = text(data);
      continue;
    }
    if (type === "x") {
      const record = paxRecords(data).path;
      if (record) overrideName = record;
      continue;
    }
    // A global header (`g`) describes the archive, and `K` renames a link
    // target: neither says anything about the next file's own path.
    if (type === "g" || type === "K") continue;
    // Regular files only. "0" is one, and so is the historical NUL typeflag.
    if (type !== "0") {
      overrideName = null;
      continue;
    }

    const prefix = text(header.subarray(345, 500));
    const name = text(header.subarray(0, 100));
    const raw = overrideName || (prefix ? `${prefix}/${name}` : name);
    overrideName = null;
    const safe = normalizePath(raw);
    if (!safe) continue;
    files.push({ path: safe, size, mode: octal(header.subarray(100, 108)), type: "file", data });
  }
  return files;
}

module.exports = { parseTar, normalizePath };
