// Media for a document that lives in the cloud, kept on disk so a picture is
// fetched once. Keyed by hash, so two documents sharing a file share a copy;
// the index maps (cloud id, ref) to that hash. Bounded, oldest use first.
const fs = require("node:fs");
const nodeFsp = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

// A stray marker file, not a cached picture, so the wipe loops and the hash
// filename check below both have to know to ignore it.
const PENDING_CLEAR_MARKER = ".pending-clear";
// How long one revalidation's answer stands for. Long enough that seeking
// through a video is not a conversation with the server, short enough that a
// relinked picture appears while somebody is still looking at the document.
const VALID_FOR_MS = 60000;
const HASH_RE = /^[a-f0-9]{64}$/;

/**
 * A body from the network or from node:stream/web: the DOM and Node types
 * for a web stream are structurally different, and both arrive here.
 * @typedef {ReadableStream | import("node:stream/web").ReadableStream} AnyReadableStream
 * @typedef {{ stream: AnyReadableStream, mime: string, hash: string, size: number }} FetchedAsset
 *
 * `gone` is the server saying this ref is not the document's any more, or is
 * not this account's to read; null is anything inconclusive, which leaves a
 * cached copy alone.
 *
 * @param {{
 *   dir: string,
 *   fetchAsset: (cloudId: string, ref: string) => Promise<FetchedAsset | { gone: true } | null>,
 *   revalidate?: (cloudId: string, ref: string, etag: string) =>
 *     Promise<{ fresh: true } | { fetched: FetchedAsset } | { gone: true } | null>,
 *   limitBytes?: number,
 *   fsp?: typeof import("node:fs/promises"),
 * }} options
 */
function createAssetCache({ dir, fetchAsset, revalidate, limitBytes = 2 * 1024 * 1024 * 1024, fsp = nodeFsp }) {
  const indexPath = path.join(dir, "cache.json");
  let index = null; // { entries: { [cloudId\tref]: { hash, mime, size, used, validatedAt? } } }
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
  // Returns how many entries would not go: one locked file is not a reason to
  // stop, but it is a reason for the caller to know the wipe is unfinished.
  async function wipeDir() {
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch (err) {
      // Nothing there is nothing left behind. Any other failure means this
      // cannot claim the account's pictures are gone.
      return err && err.code === "ENOENT" ? 0 : 1;
    }
    let failed = 0;
    for (const name of names) {
      try {
        await fsp.rm(path.join(dir, name), { recursive: true, force: true });
      } catch {
        failed += 1;
      }
    }
    return failed;
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

  // Fetched bytes written under their hash and recorded for this key. Null
  // when the account they were fetched for signed out mid-flight, or when
  // what came back cannot name a file on this disk. Throws if the download
  // itself fails.
  async function store(key, fetched, startedInGeneration, validatedAt) {
    // The hash names the file on disk; a server that sends something
    // that is not one is not a filename, it is an attempt to write
    // somewhere else on this disk.
    if (!HASH_RE.test(fetched.hash)) return null;
    const tmp = path.join(dir, `.${fetched.hash}.part-${process.pid}-${Date.now()}`);
    try {
      await pipeline(Readable.fromWeb(fetched.stream), fs.createWriteStream(tmp));
    } catch (err) {
      // A download that died mid-stream leaves a part file nothing will ever
      // read, and nothing else knows its name.
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
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
    // validatedAt is undefined for a plain fetch, and JSON drops it: only a
    // revalidation's answer is worth memoing.
    index.entries[key] = { hash: fetched.hash, mime: fetched.mime, size: fetched.size, used: nextUsed(), validatedAt };
    await evict();
    await save();
    return { path: fileFor(fetched.hash), mime: fetched.mime, size: fetched.size };
  }

  // The file behind a hash the index no longer names. `force` covers a file
  // that is already gone; the catch covers Windows, where an open handle on a
  // video currently being served refuses the unlink. Orphaning the file there
  // is better than failing the request over it.
  async function dropFileIfUnshared(hash) {
    if (Object.values(index.entries).some((e) => e.hash === hash)) return;
    await fsp.rm(fileFor(hash), { force: true }).catch(() => {});
  }

  // Everything this cache remembers about one key, for a picture the server
  // has told us is not ours to show any more.
  async function forget(key) {
    const entry = index.entries[key];
    if (!entry) return;
    delete index.entries[key];
    await dropFileIfUnshared(entry.hash);
    await save();
  }

  // One job per key at a time, handed to everyone who asks while it runs, so
  // two views of the same document never fetch or revalidate the same picture
  // twice.
  function share(key, run) {
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      try {
        return await run();
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, job);
    return job;
  }

  async function get(cloudId, ref) {
    // Read synchronously, before the first await: a clear() that lands
    // while this call is merely suspended inside load() must still bump
    // the counter ahead of this capture, or the job it starts can never
    // tell it was signed out from under it.
    const startedInGeneration = generation;
    await load();
    const key = `${cloudId}\t${ref}`;
    const hit = index.entries[key];
    if (hit && fs.existsSync(fileFor(hit.hash))) {
      hit.used = nextUsed();
      await save();
      // A sign-out can land in that write. Every path below returns this
      // file, and the memo returns it without asking anyone, so on a platform
      // where the wipe could not unlink it this is the only thing standing
      // between the next account and the last one's picture.
      if (generation !== startedInGeneration) return null;
      const cached = { path: fileFor(hit.hash), mime: hit.mime, size: hit.size };
      if (!revalidate) return cached;
      // Chromium asks for a video one Range at a time and the protocol
      // handler calls this for every slice, so an unmemoed check would be a
      // conditional request per seek. One answer stands for a minute. Never
      // asked is NaN here, and a clock that moved backward since is negative:
      // both mean ask.
      const validatedAgo = Date.now() - hit.validatedAt;
      if (validatedAgo >= 0 && validatedAgo < VALID_FOR_MS) return cached;
      // A ref is a name, not a hash: the same reference can be relinked to
      // different bytes on the server, and this copy would otherwise be
      // shown until something evicted it. So ask, carrying the ETag of what
      // is here: unchanged costs a 304 and no bytes, and no answer at all
      // (offline, an error) is not a reason to stop showing the picture.
      const previousHash = hit.hash;
      return share(key, async () => {
        const answer = await revalidate(cloudId, ref, `"${previousHash}"`);
        // A sign-out landed while this was out asking: the copy it would
        // fall back to has been wiped with the rest of that account's
        // pictures, and nothing here is this account's to serve.
        if (generation !== startedInGeneration) return null;
        // Not the document's picture any more, or not this account's to see.
        if (answer && answer.gone) {
          await forget(key);
          return null;
        }
        // Nothing conclusive came back (offline, a 5xx). What is on disk is
        // still the best answer there is.
        if (!answer) return cached;
        if (!answer.fetched) {
          hit.validatedAt = Date.now();
          await save();
          return cached;
        }
        let stored;
        try {
          stored = await store(key, answer.fetched, startedInGeneration, Date.now());
        } catch {
          // The replacement died mid-download. A stale picture beats a blank
          // one, and the next view asks again.
          return cached;
        }
        // store() answers null for a signed-out account, where nothing here
        // is ours to serve, and for a hash that cannot name a file, where
        // the copy on disk is still the last one that worked.
        if (!stored) return generation === startedInGeneration ? cached : null;
        if (previousHash !== answer.fetched.hash) await dropFileIfUnshared(previousHash);
        return stored;
      });
    }
    return share(key, async () => {
      const fetched = await fetchAsset(cloudId, ref);
      if (fetched && fetched.gone) {
        // Nothing to fetch and nothing to keep: an entry whose file had
        // vanished from under the cache would otherwise be tried again on
        // every view.
        await forget(key);
        return null;
      }
      if (!fetched) return null;
      return store(key, fetched, startedInGeneration);
    });
  }

  async function clear() {
    await load();
    generation += 1;
    const failed = await wipeDir();
    index = { entries: {} };
    await save();
    // The state is reset either way: nothing this cache remembers is the old
    // account's to serve any more. But bytes the OS would not unlink are
    // still that account's, sitting on this disk, so the caller is told and
    // its catch leaves the marker that makes the next start finish the job.
    if (failed > 0) throw new Error(`asset cache: ${failed} file(s) could not be removed`);
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
