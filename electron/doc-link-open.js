// What a link inside a rendered document is, and how to open it.
//
// Four answers per href. "local": the file is beside the document on this
// disk, and the ordinary local-file path opens it. "cloud": the document
// lives in the cloud and the server says this account may read the target;
// carries the target's id. "none": the server knows the link and would not
// name its target, so this account may not follow it. "unknown": nothing to
// add, today's behaviour applies. Disk wins over the cloud, so the author's
// own machine and a second machine with the same layout never fetch.
//
// Kept out of main.js so the ordering and the memo can be tested without
// Electron.
const path = require("node:path");
const { isLocal, refOf, refIsMalformed } = require("./doc-assets");
const { isDocRef } = require("./doc-links");

const NOT_SHARED = "This document isn't shared with you.";
const LANDING_FAILED = "Couldn't open that document. Check your connection, or ask for it to be shared again.";
// How long the server's answer for one document is kept. A share granted in
// the meantime shows up on the next look after this.
const MEMO_MS = 60_000;

/**
 * @param {{
 *   sync: { isConfigured: Function, api: Function },
 *   registry: { get: Function, list: Function },
 *   localAssets: { candidatePath: Function },
 *   land: Function,
 *   fs?: { existsSync: (path: string) => boolean },
 *   now?: () => number,
 * }} deps
 */
function createDocLinkOpener({ sync, registry, localAssets, land, fs = require("node:fs"), now = Date.now }) {
  // cloud id -> { at, links: Map<ref, target | null> }
  const memo = new Map();

  async function linksFor(cloudId) {
    const hit = memo.get(cloudId);
    if (hit && now() - hit.at < MEMO_MS) return hit.links;
    if (!sync.isConfigured()) return null;
    const res = await sync.api("GET", `/api/docs/${cloudId}/links`);
    if (res.status !== 200 || !res.data || !Array.isArray(res.data.links)) return null;
    const links = new Map();
    for (const entry of res.data.links) {
      if (!entry || typeof entry.ref !== "string") continue;
      links.set(entry.ref, typeof entry.target === "string" && entry.target ? entry.target : null);
    }
    memo.set(cloudId, { at: now(), links });
    return links;
  }

  function forget(cloudId) {
    memo.delete(cloudId);
  }

  async function resolve(docPath, hrefs) {
    const out = hrefs.map((href) => ({ href, kind: "unknown" }));
    if (!docPath) return out;
    const docDir = path.dirname(docPath);
    const row = registry.get(docPath);
    let cloud = null;
    let asked = false;
    for (const entry of out) {
      // Agrees with extractLinks/resolveLinks (electron/doc-links.js), which
      // both refuse a scheme href before ever looking at its reference:
      // isDocRef alone would pass file:///etc/hosts.txt or //cdn/x.md
      // straight through to the disk and cloud checks below.
      if (!isLocal(entry.href)) continue;
      const ref = refOf(entry.href);
      if (!ref || refIsMalformed(ref) || !isDocRef(ref)) continue;
      const candidate = localAssets.candidatePath(entry.href, docDir);
      if (candidate && fs.existsSync(candidate)) {
        entry.kind = "local";
        continue;
      }
      if (!row || !row.cloud_doc_id) continue;
      if (!asked) {
        cloud = await linksFor(row.cloud_doc_id);
        asked = true;
      }
      if (!cloud || !cloud.has(ref)) continue;
      const target = cloud.get(ref);
      if (target) {
        entry.kind = "cloud";
        entry.target = target;
      } else {
        entry.kind = "none";
      }
    }
    return out;
  }

  async function open(docPath, href) {
    const [answer] = await resolve(docPath, [href]);
    if (answer.kind === "none") return { ok: false, kind: "none", error: NOT_SHARED };
    if (answer.kind !== "cloud") return { ok: false, kind: answer.kind };
    // Land once, then reuse: a copy this machine already tracks (the reader's
    // own synced file, or one landed by an earlier click) is the document.
    const live = registry.list().find((r) => r.cloud_doc_id === answer.target && fs.existsSync(r.path));
    if (live) return { ok: true, path: live.path };
    const landedDoc = await land(answer.target);
    if (!landedDoc || landedDoc.error) return { ok: false, kind: "cloud", error: LANDING_FAILED };
    return { ok: true, path: landedDoc.path };
  }

  return { resolve, open, forget };
}

module.exports = { createDocLinkOpener, NOT_SHARED, LANDING_FAILED };
