// Pushing a document's media ahead of its text. One pass: what does the
// server lack, send exactly that, then tell it the document's full set. A
// failure leaves the row "pending" for the reconciliation pass; the text push
// that follows is never held up by a picture.
const fs = require("node:fs");
const { Readable } = require("node:stream");
const docAssets = require("./doc-assets");

function createAssetSync({ api, registry, grants, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxBytes = docAssets.MAX_ASSET_BYTES }) {
  const failure = (verb, res) => (res.status === 0 ? `${verb} failed (offline)` : `${verb} failed (${res.status})`);

  async function upload(entry) {
    let res = { status: 0 };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await sleep(500 * attempt);
      res = await api("PUT", `/api/assets/${entry.hash}`, undefined, {
        raw: { stream: Readable.toWeb(fs.createReadStream(entry.path)), size: entry.size, mime: entry.mime },
      });
      if (res.status >= 200 && res.status < 300) return { ok: true };
      if (res.status === 503) return { pending: true };
      if (res.status === 413 || res.status === 415 || res.status === 400) return { skipped: res.status === 413 ? "size" : "type" };
    }
    return { error: failure("media upload", res) };
  }

  async function pushAssets(filePath, cloudId, content) {
    const row = registry.get(filePath) ?? {};
    const refs = docAssets.extractRefs(content);
    const resolved = docAssets.resolveRefs(refs, { docPath: filePath, roots: grants.assetRoots(), files: grants.grantedFilePaths() });
    const entries = [];
    const skipped = [];
    for (const r of resolved) {
      if (r.skipped) {
        skipped.push({ ref: r.ref, reason: r.skipped });
        continue;
      }
      const { hash, size } = await docAssets.hashFile(r.path);
      if (size > maxBytes) {
        skipped.push({ ref: r.ref, reason: "size" });
        continue;
      }
      entries.push({ ref: r.ref, path: r.path, mime: r.mime, hash, size });
    }
    const fp = docAssets.fingerprint(entries);
    if (row.assets_state === "synced" && row.assets_fingerprint === fp) return { unchanged: true };

    const pending = (error) => {
      registry.update(filePath, { assets_state: "pending", assets_skipped: JSON.stringify(skipped) });
      return error ? { pending: true, error } : { pending: true };
    };

    let uploaded = 0;
    if (entries.length > 0) {
      const missing = await api("POST", `/api/docs/${cloudId}/assets/missing`, { hashes: entries.map((e) => e.hash) });
      if (missing.status === 503) return pending();
      if (missing.status !== 200 || !Array.isArray(missing.data?.missing)) return pending(failure("media check", missing));
      const need = new Set(missing.data.missing);
      for (const entry of entries) {
        if (!need.has(entry.hash)) continue;
        const res = await upload(entry);
        if (res.pending) return pending();
        if (res.error) return pending(res.error);
        if (res.skipped) {
          skipped.push({ ref: entry.ref, reason: res.skipped });
          entry.dropped = true;
          continue;
        }
        uploaded += 1;
      }
    }
    const linkRefs = [
      ...entries.filter((e) => !e.dropped).map((e) => ({ ref: e.ref, hash: e.hash })),
      ...refs.filter((ref) => !entries.some((e) => e.ref === ref && !e.dropped)).map((ref) => ({ ref })),
    ];
    const link = await api("PUT", `/api/docs/${cloudId}/assets`, { refs: linkRefs });
    if (link.status === 503) return pending();
    if (link.status !== 200) return pending(failure("media link", link));
    registry.update(filePath, {
      assets_state: "synced",
      assets_fingerprint: docAssets.fingerprint(entries.filter((e) => !e.dropped)),
      assets_skipped: JSON.stringify(skipped),
    });
    return { ok: true, uploaded, skipped };
  }

  return { pushAssets };
}

module.exports = { createAssetSync };
