// Repairing what was told to sync and never landed. One listing, one pass
// over the rows that are in the cloud and not paused or in conflict; the
// text is pushed where this device is ahead of a server that stood still,
// and the media is offered for every current document (pushAssets is what
// knows whether anything actually changed). Nothing is ever pulled here:
// the update flow owns that, because a pull can overwrite an edit.
/**
 * @param {{
 *   sync: { api: Function, push: Function },
 *   registry: { list: Function, get: Function, update: Function, hashContent: Function },
 *   assetSync: { pushAssets: Function },
 *   fs?: { existsSync: (path: string) => boolean, readFileSync: (path: string, encoding: string) => string },
 *   sleep?: (ms: number) => Promise<void>,
 *   gapMs?: number,
 * }} deps
 */
function createReconciler({ sync, registry, assetSync, fs = require("node:fs"), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), gapMs = 250 }) {
  let cursor = 0;

  async function run({ limit = 50 } = {}) {
    const result = { pushed: [], mediaPushed: [], skipped: [], errors: [] };
    let remote;
    let rows;
    // Building the listing is one unit: a throw from either the request or
    // the registry read means there is nothing safe to iterate, so it is
    // caught here rather than only around each row. Left uncaught, it would
    // reject run() itself and surface as an unhandled rejection through the
    // fire-and-forget callers in main.js.
    try {
      const res = await sync.api("GET", "/api/docs");
      if (res.status !== 200 || !Array.isArray(res.data?.docs)) {
        result.errors.push({ path: "*", error: "listing unavailable" });
        return result;
      }
      remote = new Map(res.data.docs.map((d) => [d.id, d]));
      rows = registry.list().filter((r) => r.cloud_doc_id && (r.sync_state === "synced" || r.sync_state === "unpushed"));
    } catch (err) {
      result.errors.push({ path: "*", error: err && err.message ? err.message : String(err) });
      return result;
    }
    if (cursor >= rows.length) cursor = 0;
    const slice = rows.slice(cursor, cursor + limit);
    cursor = cursor + limit >= rows.length ? 0 : cursor + limit;

    for (const [i, row] of slice.entries()) {
      if (i > 0) await sleep(gapMs);
      try {
        const r = remote.get(row.cloud_doc_id);
        if (!r) {
          result.skipped.push({ path: row.path, reason: "delisted" });
          continue;
        }
        // Somebody shared this document and gave this account reading rights
        // only. Both the text push and the asset call answer 403, which left
        // the row pending and retried it on every pass, so the Cloud panel
        // showed "media pending" forever for a document nobody here may
        // write.
        if (r.shared && r.role === "viewer") {
          result.skipped.push({ path: row.path, reason: "viewer" });
          continue;
        }
        if (!fs.existsSync(row.path)) {
          result.skipped.push({ path: row.path, reason: "missing" });
          continue;
        }
        if (r.version > (row.cloud_version ?? 0)) {
          result.skipped.push({ path: row.path, reason: "behind" });
          continue;
        }
        const content = fs.readFileSync(row.path, "utf8");
        const diskHash = registry.hashContent(content);
        const needsText = row.sync_state === "unpushed" || diskHash !== row.content_hash || r.hash !== row.content_hash;
        if (needsText) {
          const pushed = await sync.push(row.path, row.name, content);
          if (pushed && pushed.ok) result.pushed.push(row.path);
          else result.errors.push({ path: row.path, error: pushed?.error ?? "push refused" });
          // push already sent the media (Task 7); nothing more to do here.
          continue;
        }
        // The version this pass's listing agreed on. Another device can
        // advance the document between that listing and this call; without a
        // base version the link would replace the newer snapshot's references
        // with this device's stale set, and with one the server refuses it.
        const media = await assetSync.pushAssets(row.path, row.cloud_doc_id, content, {
          baseVersion: row.cloud_version ?? 0,
        });
        if (media && (media.ok || media.unchanged)) result.mediaPushed.push(row.path);
        else if (media && media.error) result.errors.push({ path: row.path, error: media.error });
      } catch (err) {
        result.errors.push({ path: row.path, error: err && err.message ? err.message : String(err) });
      }
    }
    return result;
  }

  return { run };
}

module.exports = { createReconciler };
