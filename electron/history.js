// Every committed save is a version. The store is the existing snapshots
// directory, so 0.4.x snapshots are already the oldest versions and nothing
// migrates. What this adds over snapshots.js: an author per version (you, an
// outside edit, or a named agent), content-hash dedupe, names a person gives a
// version, and time-shaped retention, because autosave would blow through a
// flat 20-per-file cap in an afternoon.
//
// Attribution. A version holds what the file said before a write replaced it,
// so its author is whoever wrote those bytes, not whoever replaced them.
// last-write.json beside the versions remembers the hash, author and time of
// the newest write Markie knows about: the user's own save, or an agent's
// write announced over the agent bridge just before it lands. When the bytes
// being kept hash the same, that writer is the author and its time is the
// version's time. When they do not, something outside Markie wrote them.
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

const NAME_MAX = 120;

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

// A version name is one printable line, shown in a list row and nowhere else.
function cleanName(raw) {
  if (typeof raw !== "string") return "";
  const line = raw
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(line).slice(0, NAME_MAX).join("").trim();
}

// entries: [{ stamp, ms, bytes, named? }] in any order. Returns stamps to
// delete. An entry with a null ms is never dropped: we could not date it, and
// guessing against it costs the user a version. A named entry is never
// dropped either: naming a version is how a person says "keep this one". It
// does not take an hour or day slot from an autosave, and it does not count
// toward the newest-N floor.
function planRetention(entries, nowMs, caps = {}) {
  const c = { ...DEFAULT_CAPS, ...caps };
  const named = entries.filter((e) => e.named);
  const undated = entries.filter((e) => !e.named && (e.ms === null || e.ms === undefined));
  const sorted = entries
    .filter((e) => !e.named && e.ms !== null && e.ms !== undefined)
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
  // Per-file cap, oldest dropped first, applied after time thinning. Named
  // versions take room under the cap but are never what gets dropped.
  const kept = sorted.filter((e) => !drop.has(e.stamp));
  const room = Math.max(0, c.maxPerFile - undated.length - named.length);
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
  const lastWriteFile = (filePath) => path.join(snaps.dirFor(filePath), "last-write.json");

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

  function readLastWrite(filePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(lastWriteFile(filePath), "utf-8"));
      return parsed && typeof parsed.hash === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  function writeLastWrite(filePath, rec) {
    try {
      fs.mkdirSync(snaps.dirFor(filePath), { recursive: true });
      fs.writeFileSync(lastWriteFile(filePath), JSON.stringify(rec), "utf-8");
    } catch {
      // best effort, like meta
    }
  }

  const isNamed = (m) => !!(m && typeof m.name === "string" && m.name);

  function entryList(filePath, meta = readMeta(filePath)) {
    const folder = snaps.dirFor(filePath);
    return snaps.list(filePath).map((name) => {
      const stamp = name.replace(/\.md$/, "");
      let bytes = 0;
      try {
        bytes = fs.statSync(path.join(folder, name)).size;
      } catch {
        // gone between list and stat
      }
      return { stamp, ms: msForStamp(stamp), bytes, named: isNamed(meta[stamp]) };
    });
  }

  function removeVersion(folder, stamp) {
    try {
      fs.rmSync(path.join(folder, `${stamp}.md`), { force: true });
    } catch {
      // best effort
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

  // Oldest first across every document, so the global cap can compare versions
  // that belong to different files. Mirrors snapshots.js's own total prune,
  // which is switched off here because retention is this module's job. Named
  // versions count toward the total but are never the ones removed.
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
      const folderMeta = readMetaIn(folder) || {};
      for (const name of names) {
        if (!name.endsWith(".md")) continue;
        const file = path.join(folder, name);
        let bytes = 0;
        try {
          bytes = fs.statSync(file).size;
        } catch {
          continue;
        }
        all.push({ file, folder, name, bytes, named: isNamed(folderMeta[name.replace(/\.md$/, "")]) });
      }
    }
    all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let total = all.reduce((sum, e) => sum + e.bytes, 0);
    for (const e of all) {
      if (total <= c.maxTotalBytes) break;
      if (e.named) continue;
      removeVersion(e.folder, e.name.replace(/\.md$/, ""));
      const meta = readMetaIn(e.folder);
      if (meta) {
        delete meta[e.name.replace(/\.md$/, "")];
        writeMetaIn(e.folder, meta);
      }
      total -= e.bytes;
    }
  }

  function retain(filePath) {
    const folder = snaps.dirFor(filePath);
    const meta = readMeta(filePath);
    const dropStamps = planRetention(entryList(filePath, meta), now().getTime(), c);
    if (dropStamps.length) {
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

  // When the bytes on disk were written, as far as the file can say. For bytes
  // Markie did not write itself, the file's own modified time is the best
  // answer there is; never later than now.
  function writtenAt(filePath) {
    try {
      const ms = fs.statSync(filePath).mtimeMs;
      if (Number.isFinite(ms) && ms > 0) return new Date(Math.min(ms, now().getTime())).toISOString();
    } catch {
      // gone; fall through
    }
    return now().toISOString();
  }

  // Who wrote the bytes hashing to `bytesHash`. `fallback` answers when Markie
  // has no record of any write to this file yet (a document from before
  // attribution existed, or one Markie has never written).
  function attribute(filePath, bytesHash, fallback) {
    const last = readLastWrite(filePath);
    if (last && last.hash === bytesHash) {
      const who = { author: last.author || "unknown", iso: last.iso || now().toISOString() };
      if (last.agent) who.agent = last.agent;
      return who;
    }
    return { author: last ? "external" : fallback, iso: writtenAt(filePath) };
  }

  // writer: { author, agent? } of the write about to replace the file, or
  // null when the bytes on disk are themselves the version (an outside edit).
  // nextHash: the hash of what the writer will write, when only that is known.
  function record(filePath, nextContent, writer, nextHash) {
    const stampWriter = () => {
      if (!writer) return;
      const hash =
        typeof nextHash === "string" && nextHash
          ? nextHash
          : typeof nextContent === "string"
            ? hashOf(nextContent)
            : null;
      if (!hash) return;
      const rec = { hash, author: writer.author, iso: now().toISOString() };
      if (writer.agent) rec.agent = writer.agent;
      writeLastWrite(filePath, rec);
    };
    let previous;
    try {
      previous = fs.readFileSync(filePath, "utf-8");
    } catch {
      stampWriter();
      return { skipped: "no-file" };
    }
    const previousHash = hashOf(previous);
    // The version at the top of the chain already holds these bytes. That is
    // exactly the watcher-then-save sequence: the watcher records the external
    // edit, the user's save would record it a second time.
    if (previousHash === newestContentHash(filePath)) {
      stampWriter();
      return { skipped: "duplicate" };
    }
    if ((typeof nextHash === "string" && nextHash === previousHash) || nextContent === previous) {
      stampWriter();
      return { skipped: "unchanged" };
    }
    // The user saving over a file Markie never saw written keeps the label it
    // always had. An agent replacing such a file cannot know who wrote it.
    const who = attribute(
      filePath,
      previousHash,
      !writer ? "external" : writer.author === "user" ? "user" : "unknown"
    );
    const res = snaps.capture(filePath, nextContent);
    if (!res.ok) return res;
    const stamp = path.basename(res.path).replace(/\.md$/, "");
    const meta = readMeta(filePath);
    meta[stamp] = who;
    writeMeta(filePath, meta);
    stampWriter();
    retain(filePath);
    return res;
  }

  function setName(filePath, stamp, rawName) {
    if (!snaps.list(filePath).includes(`${String(stamp)}.md`)) {
      return { ok: false, error: "That version is gone." };
    }
    const name = cleanName(rawName);
    const meta = readMeta(filePath);
    const entry = { ...(meta[stamp] || {}) };
    if (name) entry.name = name;
    else delete entry.name;
    meta[stamp] = entry;
    writeMeta(filePath, meta);
    // Unnaming hands the version back to retention. Prune now, so the list the
    // user sees is the list that is kept.
    if (!name) retain(filePath);
    return { ok: true, stamp, name: name || null };
  }

  return {
    capture(filePath, nextContent, { author = "user", agent } = {}) {
      return record(filePath, nextContent, agent ? { author, agent } : { author });
    },
    // nextContent stays undefined: snapshots.capture stores whatever is on
    // disk, which for an outside edit is exactly the version to record. Its
    // author is whoever announced those bytes (an agent over the bridge), or
    // "external" when nobody did.
    captureExternal(filePath) {
      return record(filePath, undefined, null);
    },
    // An agent is about to write bytes hashing to `hash` over this file. Keep
    // what is there now as a version, because the agent's write may land while
    // Markie is not watching the file, and remember the agent as the author of
    // the bytes it is about to write.
    noteAgentWrite(filePath, { agent, hash } = {}) {
      const h = typeof hash === "string" ? hash.toLowerCase() : "";
      if (!/^[a-f0-9]{64}$/.test(h)) return { skipped: "bad-hash" };
      return record(filePath, undefined, { author: "agent", agent: String(agent || "") }, h);
    },
    // Who wrote `content` (the text on screen; what is on disk when omitted),
    // as far as Markie knows. Null when it cannot say: no record of any write
    // to this file, or text on screen that is neither the last known write
    // nor what is on disk (a disk change the user has not reloaded yet).
    head(filePath, content) {
      let disk;
      try {
        disk = fs.readFileSync(filePath, "utf-8");
      } catch {
        return null;
      }
      const text = typeof content === "string" ? content : disk;
      const last = readLastWrite(filePath);
      if (!last) return null;
      if (last.hash === hashOf(text)) {
        return { author: last.author, iso: last.iso || null, ...(last.agent ? { agent: last.agent } : {}) };
      }
      return text === disk ? { author: "external", iso: null } : null;
    },
    // Name, rename, or (with "") unname a stored version.
    name(filePath, stamp, rawName) {
      return setName(filePath, String(stamp || ""), rawName);
    },
    // Keep what is on disk now as a version, and name it. The current text is
    // not a stored version until something replaces it, and a name has to
    // hang on something that stays.
    nameCurrent(filePath, rawName) {
      if (!cleanName(rawName)) return { ok: false, error: "A name is required." };
      let disk;
      try {
        disk = fs.readFileSync(filePath, "utf-8");
      } catch {
        return { ok: false, error: "The file is not on disk." };
      }
      const diskHash = hashOf(disk);
      const names = snaps.list(filePath);
      let stamp;
      if (names.length && newestContentHash(filePath) === diskHash) {
        stamp = names[names.length - 1].replace(/\.md$/, "");
      } else {
        const who = attribute(filePath, diskHash, "user");
        const res = snaps.capture(filePath, undefined);
        if (!res.ok) return { ok: false, error: "This version could not be kept." };
        stamp = path.basename(res.path).replace(/\.md$/, "");
        const meta = readMeta(filePath);
        meta[stamp] = who;
        writeMeta(filePath, meta);
      }
      return setName(filePath, stamp, rawName);
    },
    list(filePath) {
      const meta = readMeta(filePath);
      return entryList(filePath, meta)
        .sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0))
        .map((e) => {
          const m = meta[e.stamp] || {};
          const item = {
            stamp: e.stamp,
            iso: m.iso || (e.ms === null ? new Date(0).toISOString() : new Date(e.ms).toISOString()),
            author: m.author || "unknown",
            bytes: e.bytes,
          };
          if (typeof m.agent === "string" && m.agent) item.agent = m.agent;
          if (isNamed(m)) item.name = m.name;
          return item;
        });
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

module.exports = { createHistory, planRetention, msForStamp, cleanName, DEFAULT_CAPS, slugFor, stampFor };
