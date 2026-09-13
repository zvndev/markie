// Pushing a document's media around its text, in two halves.
//
// Uploading bytes is safe at any time: an asset the server holds but nothing
// points at is kept for an hour before it is swept, so `stageAssets` can send
// every missing file before the text PUT goes out. Telling the server what
// the document points at is not safe at any time: a link that lands and a
// text PUT that then fails leaves the old text beside a media set that no
// longer holds its pictures, and an hour later the sweep takes them. So
// `linkAssets` runs only after the text has landed, against the version that
// PUT returned. `pushAssets` is the two back to back, for reconciliation,
// which writes no text at all.
//
// A failure in either half leaves the row "pending" for the reconciliation
// pass; the text push is never held up by a picture.
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const docAssets = require("./doc-assets");
const localAssets = require("./local-assets");

// A reference that, read anywhere else, names something outside the folder
// the document is in. Kept identical to refEscapes in server/src/assets.ts:
// the two have to agree, or a ref this stages is a ref the link route answers
// 400 to, and the row retries it on every pass for ever. Both separators are
// considered, because a reference is written by hand and Windows text reaches
// the same check.
function refEscapes(ref) {
  if (ref.startsWith("/") || ref.startsWith("\\")) return true;
  if (/^[A-Za-z]:/.test(ref)) return true;
  return ref.split(/[/\\]/).some((segment) => segment === "." || segment === "..");
}

// Whether the file a reference actually resolved to sits inside the
// document's own folder. The resolved path is already a realpath
// (local-assets.js resolves both sides), and this realpaths the folder, so a
// symlink beside the document cannot point out of it.
function insideDocFolder(resolvedPath, filePath) {
  let realDir;
  try {
    realDir = fs.realpathSync(path.dirname(filePath));
  } catch {
    // No folder, nothing is inside it.
    return false;
  }
  return localAssets.containedIn(realDir, resolvedPath);
}

function createAssetSync({
  api,
  registry,
  grants,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  maxBytes = docAssets.MAX_ASSET_BYTES,
  hashFile = docAssets.hashFile,
  // Whether anybody but this account can read a cloud document, as the last
  // listing the sync engine received said. Null or undefined is nobody having
  // said, which reads as exposed: the cost of being wrong that way is a
  // picture that does not travel, and the cost of being wrong the other way
  // is somebody else's file leaving this machine.
  isExposed = () => true,
}) {
  const failure = (verb, res) => (res.status === 0 ? `${verb} failed (offline)` : `${verb} failed (${res.status})`);

  // Hashing streams and reads the whole file. A document's media rarely
  // changes between pushes, so a push that only differs in some other ref
  // (or a reconciliation retry of a row a prior failure left "pending")
  // would otherwise re-read and re-hash every unchanged file too. Keyed by
  // path, good for the life of this createAssetSync — per-process memory
  // only, never persisted, and correctly invalidated the moment size or
  // mtime actually change.
  const hashCache = new Map();
  async function hashCached(path, size, mtimeMs) {
    const cached = hashCache.get(path);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.hash;
    const { hash } = await hashFile(path);
    hashCache.set(path, { size, mtimeMs, hash });
    return hash;
  }

  async function upload(entry) {
    let res = { status: 0 };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await sleep(500 * attempt);
      res = await api("PUT", `/api/assets/${entry.hash}`, undefined, {
        raw: { stream: Readable.toWeb(fs.createReadStream(entry.path)), size: entry.size, mime: entry.mime },
      });
      if (res.status >= 200 && res.status < 300) return { ok: true };
      if (res.status === 503) return { pending: true };
      // 413 and 415 are this server refusing the file itself, which no retry
      // changes. A 400 is the body not hashing to the name it was sent under,
      // which means the file moved between the hash and the upload: that is a
      // retry, and then a pending row, because the hash cache is keyed by size
      // and mtime and the next pass re-hashes a file that changed.
      if (res.status === 413 || res.status === 415) return { skipped: res.status === 413 ? "size" : "type" };
    }
    return { error: failure("media upload", res) };
  }

  function markPending(filePath, skipped, error) {
    registry.update(filePath, { assets_state: "pending", assets_skipped: JSON.stringify(skipped) });
    return error ? { pending: true, error } : { pending: true };
  }

  // Everything up to and including the uploads, and nothing that commits the
  // document to them. `{ unchanged: true }` for a synced row whose reference
  // set has not moved, `{ pending: true, error? }` for a failure (the row is
  // written pending), else `{ staged: { linkRefs, uploaded, skipped,
  // fingerprint } }` for the caller to hand to linkAssets once its text has
  // landed.
  async function stageAssets(filePath, cloudId, content) {
    const row = registry.get(filePath) ?? {};
    const refs = docAssets.extractRefs(content);
    const resolved = docAssets.resolveRefs(refs, { docPath: filePath, roots: grants.assetRoots(), files: grants.grantedFilePaths() });
    // What this machine may draw is the wrong question for a document
    // somebody else can read. Their text can name any path, this machine
    // resolves it against this user's own grants, and the bytes land in a
    // document they own. So for an exposed document only the files beside it
    // travel: those are the ones that arrived with the document itself.
    const exposed = isExposed(cloudId) !== false;
    const entries = [];
    const skipped = [];
    for (const r of resolved) {
      if (r.skipped) {
        skipped.push({ ref: r.ref, reason: r.skipped });
        continue;
      }
      if (exposed && (refEscapes(r.ref) || !insideDocFolder(r.path, filePath))) {
        // Same reason string as a reference the local viewer would refuse:
        // to the reader of the synced copy the outcome is the same picture
        // missing, and the Cloud page names either one.
        skipped.push({ ref: r.ref, reason: "outside" });
        continue;
      }
      // A cheap stat before a full read-and-hash: the cap is checked on the
      // authoritative size the filesystem reports, not on what hashing it
      // happens to measure along the way.
      const stat = fs.statSync(r.path);
      if (stat.size > maxBytes) {
        skipped.push({ ref: r.ref, reason: "size" });
        continue;
      }
      const hash = await hashCached(r.path, stat.size, stat.mtimeMs);
      entries.push({ ref: r.ref, path: r.path, mime: r.mime, hash, size: stat.size });
    }

    // The document's every reference, in the order it wrote them: a hash for
    // the ones that resolved and the server will hold, nothing for the rest.
    // This whole set is what the server is told and what the fingerprint
    // covers, so a ref that never resolved still counts as part of the
    // document and its removal is a change like any other.
    const byRef = new Map(entries.map((e) => [e.ref, e]));
    const linkRefsNow = () =>
      refs.map((ref) => {
        const entry = byRef.get(ref);
        return entry && !entry.dropped ? { ref, hash: entry.hash } : { ref };
      });
    if (row.assets_state === "synced" && row.assets_fingerprint === docAssets.fingerprint(linkRefsNow())) {
      return { unchanged: true };
    }

    let uploaded = 0;
    if (entries.length > 0) {
      const missing = await api("POST", `/api/docs/${cloudId}/assets/missing`, { hashes: entries.map((e) => e.hash) });
      if (missing.status === 503) return markPending(filePath, skipped);
      if (missing.status !== 200 || !Array.isArray(missing.data?.missing)) {
        return markPending(filePath, skipped, failure("media check", missing));
      }
      const need = new Set(missing.data.missing);
      for (const entry of entries) {
        if (!need.has(entry.hash)) continue;
        const res = await upload(entry);
        if (res.pending) return markPending(filePath, skipped);
        if (res.error) return markPending(filePath, skipped, res.error);
        if (res.skipped) {
          skipped.push({ ref: entry.ref, reason: res.skipped });
          entry.dropped = true;
          continue;
        }
        // Two refs to byte-identical files share a hash: once this upload has
        // landed, nothing else in this push still needs it.
        need.delete(entry.hash);
        uploaded += 1;
      }
    }
    const linkRefs = linkRefsNow();
    return { staged: { linkRefs, uploaded, skipped, fingerprint: docAssets.fingerprint(linkRefs) } };
  }

  // What the document points at, committed against `baseVersion`: the version
  // the caller's text PUT landed on, so the refs and the text describe the
  // same snapshot. The server answers 409 when the document has moved on
  // since, which leaves the refs unclaimed for the retry.
  async function linkAssets(filePath, cloudId, staged, { baseVersion } = {}) {
    const body = typeof baseVersion === "number" ? { refs: staged.linkRefs, baseVersion } : { refs: staged.linkRefs };
    const link = await api("PUT", `/api/docs/${cloudId}/assets`, body);
    if (link.status === 503) return markPending(filePath, staged.skipped);
    // Somebody else's snapshot landed in between. Reconciliation retries the
    // whole pass; all this has to do is leave the refs unclaimed.
    if (link.status === 409) return { ...markPending(filePath, staged.skipped), conflict: true };
    if (link.status !== 200) return markPending(filePath, staged.skipped, failure("media link", link));
    registry.update(filePath, {
      assets_state: "synced",
      assets_fingerprint: staged.fingerprint,
      assets_skipped: JSON.stringify(staged.skipped),
    });
    return { ok: true, uploaded: staged.uploaded, skipped: staged.skipped };
  }

  // Both halves back to back, for reconciliation: it pushes no text, so
  // there is no window between the two for a text failure to open.
  async function pushAssets(filePath, cloudId, content, { baseVersion } = {}) {
    const result = await stageAssets(filePath, cloudId, content);
    if (!result.staged) return result;
    return linkAssets(filePath, cloudId, result.staged, { baseVersion });
  }

  return { stageAssets, linkAssets, pushAssets };
}

module.exports = { createAssetSync };
