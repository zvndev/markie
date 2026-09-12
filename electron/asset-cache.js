// Media for a document that lives in the cloud, kept on disk so a picture is
// fetched once. Keyed by hash, so two documents sharing a file share a copy;
// the index maps (cloud id, ref) to that hash. Bounded, oldest use first.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

function createAssetCache({ dir, fetchAsset, limitBytes = 2 * 1024 * 1024 * 1024 }) {
  const indexPath = path.join(dir, "cache.json");
  let index = null; // { entries: { [cloudId\tref]: { hash, mime, size, used } } }
  const inflight = new Map();

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

  async function load() {
    if (index) return index;
    await fsp.mkdir(dir, { recursive: true });
    try {
      index = JSON.parse(await fsp.readFile(indexPath, "utf8"));
      if (!index || typeof index.entries !== "object") index = { entries: {} };
    } catch {
      index = { entries: {} };
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
    const job = (async () => {
      try {
        const fetched = await fetchAsset(cloudId, ref);
        if (!fetched) return null;
        const tmp = path.join(dir, `.${fetched.hash}.part-${process.pid}-${Date.now()}`);
        await pipeline(Readable.fromWeb(fetched.stream), fs.createWriteStream(tmp));
        await fsp.rename(tmp, fileFor(fetched.hash));
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
    for (const name of await fsp.readdir(dir)) await fsp.rm(path.join(dir, name), { recursive: true, force: true });
    index = { entries: {} };
    await save();
  }

  return { get, clear };
}

module.exports = { createAssetCache };
