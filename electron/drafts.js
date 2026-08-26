// The write-ahead net under autosave. The debounced file write is at most a
// second behind the buffer; this journal is at most one serializer tick behind
// THAT, lives in userData (never beside the user's file), and exists so a crash
// or a kill mid-burst costs nothing. Injected fs/clock, the same testability
// pattern as snapshots.js.
const nodeFs = require("fs");
const nodePath = require("path");
const nodeCrypto = require("crypto");

const DEFAULT_MAX_AGE_DAYS = 7;
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

// One file per document, named so a person browsing userData can tell which
// document it belongs to, and so two files with the same basename in different
// folders never share a draft.
function keyFor(docPath, { path = nodePath, crypto = nodeCrypto } = {}) {
  if (!docPath) return "untitled";
  const absolute = path.resolve(String(docPath));
  const hash = crypto.createHash("sha256").update(absolute).digest("hex").slice(0, 8);
  const base = path.basename(absolute).replace(/[^\w.\- ]/g, "_").slice(0, 60) || "document";
  return `${hash}-${base}`;
}

function createDrafts(options = {}) {
  const {
    dir,
    fs = nodeFs,
    path = nodePath,
    crypto = nodeCrypto,
    now = () => new Date(),
    maxAgeDays = DEFAULT_MAX_AGE_DAYS,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  } = options;

  const root = path.join(dir, "drafts");
  const indexFile = path.join(root, "index.json");

  function readIndex() {
    try {
      const parsed = JSON.parse(fs.readFileSync(indexFile, "utf-8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeIndex(index) {
    fs.mkdirSync(root, { recursive: true });
    const tmp = indexFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(index), "utf-8");
    fs.renameSync(tmp, indexFile);
  }

  const fileFor = (key) => path.join(root, `${key}.md`);

  function remove(index, key) {
    try {
      fs.rmSync(fileFor(key), { force: true });
    } catch {
      // an unremovable draft is not worth failing over
    }
    delete index[key];
  }

  function prune(index) {
    const cutoff = now().getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
    const entries = Object.entries(index).sort(
      (a, b) => Date.parse(a[1].savedAt) - Date.parse(b[1].savedAt)
    );
    let total = 0;
    for (const [key, meta] of entries) {
      if (Date.parse(meta.savedAt) < cutoff) remove(index, key);
      else total += meta.bytes || 0;
    }
    // Still over the byte cap: drop oldest first until it fits.
    for (const [key, meta] of entries) {
      if (total <= maxTotalBytes) break;
      if (!index[key]) continue;
      total -= meta.bytes || 0;
      remove(index, key);
    }
  }

  return {
    // An empty document clears its draft rather than journalling emptiness:
    // that is how "a committed save discards the draft" is said with the three
    // channels this module exposes.
    save(docKey, content) {
      const key = keyFor(docKey && docKey.path, { path, crypto });
      const index = readIndex();
      if (!String(content || "").trim()) {
        remove(index, key);
        writeIndex(index);
        return { ok: true, cleared: true };
      }
      fs.mkdirSync(root, { recursive: true });
      const tmp = fileFor(key) + ".tmp";
      fs.writeFileSync(tmp, content, "utf-8");
      fs.renameSync(tmp, fileFor(key));
      index[key] = {
        path: (docKey && docKey.path) || null,
        name: (docKey && docKey.name) || null,
        savedAt: now().toISOString(),
        bytes: Buffer.byteLength(content, "utf-8"),
      };
      prune(index);
      writeIndex(index);
      return { ok: true };
    },

    // Drafts worth offering back: newest first. A draft whose file has since
    // moved past it is stale (the save landed after all); a draft whose file
    // is gone is the only copy left, so it stays.
    check({ fileMtime }) {
      const index = readIndex();
      const out = [];
      for (const [key, meta] of Object.entries(index)) {
        if (meta.path) {
          const mtime = fileMtime(meta.path);
          if (mtime !== null && mtime >= Date.parse(meta.savedAt)) continue;
        }
        out.push({ key, ...meta });
      }
      return out.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
    },

    read(key) {
      try {
        return fs.readFileSync(fileFor(key), "utf-8");
      } catch {
        return null;
      }
    },

    discard(key) {
      const index = readIndex();
      remove(index, key);
      writeIndex(index);
      return { ok: true };
    },
  };
}

module.exports = { createDrafts, keyFor, DEFAULT_MAX_AGE_DAYS, DEFAULT_MAX_TOTAL_BYTES };
