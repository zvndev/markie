// Every committed save is a version. The store is the existing snapshots
// directory, so 0.4.x snapshots are already the oldest versions and nothing
// migrates. What this adds over snapshots.js: an author per version (user vs
// external), content-hash dedupe, and time-shaped retention, because autosave
// would blow through a flat 20-per-file cap in an afternoon.
const nodeFs = require("fs");
const nodePath = require("path");
const nodeCrypto = require("crypto");
const { createSnapshots, slugFor, stampFor } = require("./snapshots.js");

const DEFAULT_CAPS = {
  keepAllMs: 24 * 3600_000,
  hourlyUntilMs: 7 * 24 * 3600_000,
  dailyUntilMs: 30 * 24 * 3600_000,
  keepNewest: 5,
  maxPerFile: 200,
  maxTotalBytes: 500 * 1024 * 1024,
};

// Snapshot filenames are ISO stamps with the colons swapped for dashes, and
// two writes inside one millisecond give the second a "-2" suffix. Reverse
// just enough to parse, and refuse to read a name we cannot date as epoch
// zero: that would prune a version seconds old as though it were ancient.
function msForStamp(stamp) {
  const iso = String(stamp).replace(
    /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}(?:\.\d+)?Z)/,
    "$1:$2:$3"
  );
  const parsed = Date.parse(iso);
  if (!Number.isNaN(parsed)) return parsed;
  // "…Z-2": drop the collision suffix and try once more.
  const trimmed = Date.parse(iso.replace(/Z-\d+$/, "Z"));
  return Number.isNaN(trimmed) ? null : trimmed;
}

// entries: [{ stamp, ms, bytes }] in any order. Returns stamps to delete.
// An entry with a null ms is never dropped: we could not date it, and
// guessing against it costs the user a version.
function planRetention(entries, nowMs, caps = {}) {
  const c = { ...DEFAULT_CAPS, ...caps };
  const undated = entries.filter((e) => e.ms === null || e.ms === undefined);
  const sorted = entries
    .filter((e) => e.ms !== null && e.ms !== undefined)
    .sort((a, b) => b.ms - a.ms); // newest first
  const drop = new Set();
  const seenHour = new Set();
  const seenDay = new Set();
  sorted.forEach((e, i) => {
    if (i < c.keepNewest) return; // the floor
    const age = nowMs - e.ms;
    if (age <= c.keepAllMs) return;
    if (age <= c.hourlyUntilMs) {
      const bucket = Math.floor(e.ms / 3600_000);
      if (seenHour.has(bucket)) drop.add(e.stamp);
      else seenHour.add(bucket);
      return;
    }
    if (age <= c.dailyUntilMs) {
      const bucket = Math.floor(e.ms / (24 * 3600_000));
      if (seenDay.has(bucket)) drop.add(e.stamp);
      else seenDay.add(bucket);
      return;
    }
    drop.add(e.stamp);
  });
  // Per-file cap, oldest dropped first, applied after time thinning.
  const kept = sorted.filter((e) => !drop.has(e.stamp));
  const room = Math.max(0, c.maxPerFile - undated.length);
  for (let i = kept.length - 1; i >= room; i--) drop.add(kept[i].stamp);
  return [...drop];
}

function createHistory(options = {}) {
  const {
    dir,
    fs = nodeFs,
    path = nodePath,
    crypto = nodeCrypto,
    now = () => new Date(),
    caps = {},
  } = options;
  const snaps = createSnapshots({
    dir,
    fs,
    path,
    crypto,
    now,
    // Neutralize the old flat caps; retention below is the real policy.
    maxPerFile: Number.MAX_SAFE_INTEGER,
    maxTotalBytes: Number.MAX_SAFE_INTEGER,
  });
  const c = { ...DEFAULT_CAPS, ...caps };

  const metaFile = (filePath) => path.join(snaps.dirFor(filePath), "meta.json");

  function readMeta(filePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(metaFile(filePath), "utf-8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  function writeMeta(filePath, meta) {
    try {
      fs.mkdirSync(snaps.dirFor(filePath), { recursive: true });
      fs.writeFileSync(metaFile(filePath), JSON.stringify(meta), "utf-8");
    } catch {
      // metadata is best effort; the version bytes matter more
    }
  }

  function entryList(filePath) {
    const folder = snaps.dirFor(filePath);
    return snaps.list(filePath).map((name) => {
      const stamp = name.replace(/\.md$/, "");
      let bytes = 0;
      try {
        bytes = fs.statSync(path.join(folder, name)).size;
      } catch {
        // gone between list and stat
      }
      return { stamp, ms: msForStamp(stamp), bytes };
    });
  }

  function removeVersion(folder, stamp) {
    try {
      fs.rmSync(path.join(folder, `${stamp}.md`), { force: true });
    } catch {
      // best effort
    }
  }

  // Oldest first across every document, so the global cap can compare versions
  // that belong to different files. Mirrors snapshots.js's own total prune,
  // which is switched off here because retention is this module's job.
  function pruneTotal() {
    let slugs;
    try {
      slugs = fs.readdirSync(snaps.root);
    } catch {
      return;
    }
    const all = [];
    for (const slug of slugs) {
      const folder = path.join(snaps.root, slug);
      let names;
      try {
        names = fs.readdirSync(folder);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".md")) continue;
        const file = path.join(folder, name);
        let bytes = 0;
        try {
          bytes = fs.statSync(file).size;
        } catch {
          continue;
        }
        all.push({ file, folder, name, bytes });
      }
    }
    all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let total = all.reduce((sum, e) => sum + e.bytes, 0);
    for (const e of all) {
      if (total <= c.maxTotalBytes) break;
      removeVersion(e.folder, e.name.replace(/\.md$/, ""));
      const meta = readMetaIn(e.folder);
      if (meta) {
        delete meta[e.name.replace(/\.md$/, "")];
        writeMetaIn(e.folder, meta);
      }
      total -= e.bytes;
    }
  }

  function readMetaIn(folder) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(folder, "meta.json"), "utf-8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  function writeMetaIn(folder, meta) {
    try {
      fs.writeFileSync(path.join(folder, "meta.json"), JSON.stringify(meta), "utf-8");
    } catch {
      // best effort
    }
  }

  function retain(filePath) {
    const folder = snaps.dirFor(filePath);
    const dropStamps = planRetention(entryList(filePath), now().getTime(), c);
    if (dropStamps.length) {
      const meta = readMeta(filePath);
      for (const stamp of dropStamps) {
        removeVersion(folder, stamp);
        delete meta[stamp];
      }
      writeMeta(filePath, meta);
    }
    pruneTotal();
  }

  function hashOf(text) {
    return crypto.createHash("sha256").update(text, "utf8").digest("hex");
  }

  function newestContentHash(filePath) {
    const names = snaps.list(filePath);
    if (!names.length) return null;
    try {
      return hashOf(
        fs.readFileSync(path.join(snaps.dirFor(filePath), names[names.length - 1]), "utf-8")
      );
    } catch {
      return null;
    }
  }

  function record(filePath, nextContent, author) {
    let previous;
    try {
      previous = fs.readFileSync(filePath, "utf-8");
    } catch {
      return { skipped: "no-file" };
    }
    // The version at the top of the chain already holds these bytes. That is
    // exactly the watcher-then-save sequence: the watcher records the external
    // edit, the user's save would record it a second time.
    if (hashOf(previous) === newestContentHash(filePath)) return { skipped: "duplicate" };
    const res = snaps.capture(filePath, nextContent);
    if (!res.ok) return res;
    const stamp = path.basename(res.path).replace(/\.md$/, "");
    const meta = readMeta(filePath);
    meta[stamp] = { author, iso: now().toISOString() };
    writeMeta(filePath, meta);
    retain(filePath);
    return res;
  }

  return {
    capture(filePath, nextContent, { author = "user" } = {}) {
      return record(filePath, nextContent, author);
    },
    // nextContent stays undefined: snapshots.capture stores whatever is on
    // disk, which for an external edit is exactly the version to record.
    captureExternal(filePath) {
      return record(filePath, undefined, "external");
    },
    list(filePath) {
      const meta = readMeta(filePath);
      return entryList(filePath)
        .sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0))
        .map((e) => ({
          stamp: e.stamp,
          iso:
            (meta[e.stamp] && meta[e.stamp].iso) ||
            (e.ms === null ? new Date(0).toISOString() : new Date(e.ms).toISOString()),
          author: (meta[e.stamp] && meta[e.stamp].author) || "unknown",
          bytes: e.bytes,
        }));
    },
    read(filePath, stamp) {
      try {
        return fs.readFileSync(
          path.join(snaps.dirFor(filePath), `${String(stamp)}.md`),
          "utf-8"
        );
      } catch {
        return null;
      }
    },
    has(filePath) {
      return snaps.has(filePath);
    },
    root: snaps.root,
  };
}

module.exports = { createHistory, planRetention, msForStamp, DEFAULT_CAPS, slugFor, stampFor };
