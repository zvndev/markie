// Pushes a document's link map (electron/doc-links.js) after its text, and
// remembers what landed so an unchanged map is never sent twice.
//
// Shaped like asset-sync.js's link step, with one difference: there are no
// bytes, so there is no staging half and no missing check. One PUT, four
// answers.
const docLinks = require("./doc-links");

// A refusal of the body itself, which the next pass would send unchanged. Named
// one by one, as asset-sync.js does: 401, 403 and 404 are about who is asking
// and whether the document is reachable, and the next pass may ask as a
// freshly signed-in caller against a server that has since learned the route.
const TERMINAL_STATUSES = new Set([400, 413]);

function createLinkSync({ api, registry, links = docLinks }) {
  async function pushLinks(filePath, cloudId, content, { baseVersion } = {}) {
    const refs = links.extractLinks(content);
    const { links: pairs, fingerprint } = links.resolveLinks(refs, { docPath: filePath, registry });
    const row = registry.get(filePath);
    // Settled at this fingerprint, whether the server took it or refused it:
    // nothing to say until the document's links change.
    if (row && row.links_fingerprint === fingerprint && (row.links_state === "synced" || row.links_state === "refused")) {
      return { unchanged: true };
    }
    const body = typeof baseVersion === "number" ? { links: pairs, baseVersion } : { links: pairs };
    const res = await api("PUT", `/api/docs/${cloudId}/links`, body);
    if (res.status === 200) {
      registry.update(filePath, { links_state: "synced", links_fingerprint: fingerprint });
      return { ok: true, linked: pairs.length };
    }
    if (res.status === 409) {
      registry.update(filePath, { links_state: "pending" });
      return { conflict: true };
    }
    if (TERMINAL_STATUSES.has(res.status)) {
      registry.update(filePath, { links_state: "refused", links_fingerprint: fingerprint });
      return { refused: res.status };
    }
    registry.update(filePath, { links_state: "pending" });
    return { error: res.status === 0 ? "link push failed (offline)" : `link push failed (${res.status})` };
  }

  return { pushLinks };
}

module.exports = { createLinkSync };
