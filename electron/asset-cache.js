// Media for a document that lives in the cloud, kept on disk so a picture is
// fetched once. Keyed by hash, so two documents sharing a file share a copy;
// the index maps (cloud id, ref) to that hash. Bounded, oldest use first.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

// A stray marker file, not a cached picture, so the wipe loops and the hash
// filename check below both have to know to ignore it.
const PENDING_CLEAR_MARKER = ".pending-clear";
const HASH_RE = /^[a-f0-9]{64}$/;

function createAssetCache({ dir, fetchAsset, limitBytes = 2 * 1024 * 1024 * 1024 }) {
  const indexPath = path.join(dir, "cache.json");
  let index = null; // { entries: { [cloudId\tref]: { hash, mime, size, used } } }
  const inflight = new Map();
  // Bumped by clear(). A fetch already in flight when a sign-out lands
  // captured the generation it started under; if that no longer matches by
  // the time it is ready to write, the account it was fetching for is gone,
  // and the file must not outlive it. The cache key alone does not carry an
  // account, so this is the only thing keeping two accounts on one machine
  // from sharing a picture.
  let generation = 0;

  // Date.now() has millisecond resolution; a hit and a fetch that land in the
  // same millisecond would otherwise tie, and the stable sort in evict() below
  // would then break the tie by insertion order rather than by which one
  // actually happened last. Strictly increasing, but still real time, so an
  // index loaded from a previous run compares correctly against a fresh one.
  let lastUsed = 0;
  function nextUsed() {
    lastUsed = Math.max(Date.now(), lastUsed + 1);
    return lastUsed;
  }

  // Every entry in `dir` gone, one at a time, so a file the OS refuses to
  // remove (a video another handle is still reading, an EPERM mid-stream on
  // Windows) does not stop the rest of an account's pictures from going.
  async function wipeDir() {
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      try {
        await fsp.rm(path.join(dir, name), { recursive: true, force: true });
      } catch {
        // Best effort. One locked file is not a reason to leave the rest of
        // a signed-out account's pictures sitting on disk.
      }
    }
  }

  async function load() {
    if (index) return index;
    await fsp.mkdir(dir, { recursive: true });
    // A sign-out's clear() can fail to finish; main.js's own catch leaves
    // this marker when it does. Honour it before this session reads or
    // writes anything, so the account that never got wiped still gets wiped
    // before the next one signs in and this cache serves anything at all.
    if (fs.existsSync(path.join(dir, PENDING_CLEAR_MARKER))) {
      generation += 1;
      await wipeDir();
      index = { entries: {} };
      await save();
      return index;
    }
    try {
      index = JSON.parse(await fsp.readFile(indexPath, "utf8"));
      if (!index || typeof index.entries !== "object") index = { entries: {} };
    } catch {
      index = { entries: {} };
    }
    // Seeds the clock from whatever this index already recorded, so a
    // system clock that moved backward since the last run (DST, an NTP
    // correction) cannot make a freshly touched entry look older than one
    // this run never opened.
    for (const entry of Object.values(index.entries)) {
      if (typeof entry.used === "number" && entry.used > lastUsed) lastUsed = entry.used;
    }
    return index;
  }
  async function save() {
    await fsp.writeFile(indexPath, JSON.stringify(index), "utf8");
  }
  const fileFor = (hash) => path.join(dir, hash);

  async function evict() {
    const entries = Object.entries(index.entries);
    const byHash = new Map();
    for (const [key, e] of entries) {
      const cur = byHash.get(e.hash) ?? { size: e.size, used: 0, keys: [] };
      cur.used = Math.max(cur.used, e.used);
      cur.keys.push(key);
      byHash.set(e.hash, cur);
    }
    let total = [...byHash.values()].reduce((n, e) => n + e.size, 0);
    const oldest = [...byHash.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [hash, e] of oldest) {
      if (total <= limitBytes) break;
      await fsp.rm(fileFor(hash), { force: true });
      for (const key of e.keys) delete index.entries[key];
      total -= e.size;
    }
  }

  async function get(cloudId, ref) {
    await load();
    const key = `${cloudId}\t${ref}`;
    const hit = index.entries[key];
    if (hit && fs.existsSync(fileFor(hit.hash))) {
      hit.used = nextUsed();
      await save();
      return { path: fileFor(hit.hash), mime: hit.mime, size: hit.size };
    }
    if (inflight.has(key)) return inflight.get(key);
    const startedInGeneration = generation;
    const job = (async () => {
      try {
        const fetched = await fetchAsset(cloudId, ref);
        if (!fetched) return null;
        // The hash names the file on disk; a server that sends something
        // that is not one is not a filename, it is an attempt to write
        // somewhere else on this disk.
        if (!HASH_RE.test(fetched.hash)) return null;
        const tmp = path.join(dir, `.${fetched.hash}.part-${process.pid}-${Date.now()}`);
        await pipeline(Readable.fromWeb(fetched.stream), fs.createWriteStream(tmp));
        if (generation !== startedInGeneration) {
          // A sign-out landed while this was in flight. The account that
          // asked for this picture is gone; keeping the file or the index
          // entry would hand both to whoever signs in next.
          await fsp.rm(tmp, { force: true });
          return null;
        }
        await fsp.rename(tmp, fileFor(fetched.hash));
        // Checked again: a clear() that lands during the rename itself
        // already took its snapshot of the directory before this file
        // existed, so it never touches it. Undoing it here is what keeps it
        // from outliving the account it was fetched for.
        if (generation !== startedInGeneration) {
          await fsp.rm(fileFor(fetched.hash), { force: true });
          return null;
        }
        index.entries[key] = { hash: fetched.hash, mime: fetched.mime, size: fetched.size, used: nextUsed() };
        await evict();
        await save();
        return { path: fileFor(fetched.hash), mime: fetched.mime, size: fetched.size };
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, job);
    return job;
  }

  async function clear() {
    await load();
    generation += 1;
    await wipeDir();
    index = { entries: {} };
    await save();
  }

  // Left by a caller whose own clear() could not finish, so the next time
  // this cache starts, load() finishes the wipe before anything is served
  // from what is left of the old account's index.
  async function markPendingClear() {
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, PENDING_CLEAR_MARKER), "");
    } catch {
      // Best effort: there is nothing else to fall back to if even this
      // cannot be written.
    }
  }

  return { get, clear, markPendingClear };
}

module.exports = { createAssetCache };
