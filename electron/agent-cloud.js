// What an agent may ask the app to do with Markie Cloud, through the agent
// bridge: report a file's Cloud state, sync it, and make or revoke its public
// link. Every answer that names a document carries its private link, the
// server's /d/<id> page, which opens only for its owner and the people it is
// shared with.
//
// Two consent rules, both enforced here and not in the MCP server, which is
// only a messenger:
//   - Syncing a file to Cloud asks the user the first time, with an option to
//     always allow it. The answer is remembered in agent-permissions.json and
//     can be withdrawn in the Agents dialog.
//   - A public link is confirmed by the user every single time. Nothing about
//     "always allow" ever extends to making a document public.
//
// Pure and dependency-injected so it is tested without Electron or a server.
"use strict";

const nodeFs = require("fs");
const nodePath = require("path");

const SYNCABLE = /\.(md|markdown|mdx|txt|text)$/i;
const MAX_SYNC_BYTES = 10 * 1024 * 1024;

function privateLinkFor(origin, cloudId) {
  return `${origin}/d/${encodeURIComponent(cloudId)}`;
}

/**
 * @param {object} deps
 * @param {object} deps.registry       electron/registry.js
 * @param {object} deps.sync           electron/sync.js
 * @param {string} deps.home           the user's home directory
 * @param {() => boolean} deps.unlocked  false while a private build is locked
 * @param {(ask: {kind: "sync"|"public", name: string, path: string}) => Promise<{allowed: boolean, always?: boolean}>} deps.confirm
 * @param {{get: () => {cloudSync?: string}, set: (next: object) => void}} deps.permissions
 * @param {() => void} [deps.libraryChanged]
 */
function createAgentCloud({ registry, sync, home, unlocked, confirm, permissions, libraryChanged = () => {}, fs = nodeFs }) {
  const realHome = (() => { try { return fs.realpathSync(home); } catch { return home; } })();

  function resolveDoc(raw) {
    if (typeof raw !== "string" || !raw.trim()) throw new Error("Give the absolute path of a file.");
    const expanded = raw.startsWith("~/") ? nodePath.join(home, raw.slice(2)) : raw;
    if (!nodePath.isAbsolute(expanded)) throw new Error("Give the absolute path of a file.");
    let real;
    try { real = fs.realpathSync(expanded); } catch { throw new Error(`No such file: ${expanded}`); }
    const rel = nodePath.relative(realHome, real);
    if (!rel || rel.startsWith("..") || nodePath.isAbsolute(rel)) throw new Error("Only files in your home folder can go to Markie Cloud.");
    if (!SYNCABLE.test(real)) throw new Error("Agents can sync Markdown and plain text files to Markie Cloud. Open other documents in Markie to share them.");
    const st = fs.statSync(real);
    if (!st.isFile()) throw new Error(`Not a file: ${real}`);
    return { path: real, name: nodePath.basename(real), size: st.size };
  }

  function requireUnlocked() {
    if (!unlocked()) throw new Error("Markie is locked. Sign in to Markie first.");
  }

  function describe(doc) {
    const row = registry.get(doc.path);
    const cloudId = row && row.cloud_doc_id ? row.cloud_doc_id : null;
    const server = cloudId ? sync.originOfRow(row) : null;
    return {
      path: doc.path,
      name: doc.name,
      synced: !!cloudId && (row.sync_state === "synced" || row.sync_state === "unpushed"),
      syncState: cloudId ? row.sync_state || "unknown" : "local",
      server,
      privateLink: cloudId ? privateLinkFor(server, cloudId) : null,
      role: row && row.share_role ? row.share_role : null,
    };
  }

  function linkedRow(doc) {
    const row = registry.get(doc.path);
    if (!row || !row.cloud_doc_id) throw new Error(`${doc.name} is not in Markie Cloud yet. Sync it first.`);
    return row;
  }

  async function status({ path: p }) {
    requireUnlocked();
    return describe(resolveDoc(p));
  }

  async function syncDoc({ path: p }) {
    requireUnlocked();
    const doc = resolveDoc(p);
    if (doc.size > MAX_SYNC_BYTES) throw new Error(`${doc.name} is too large to sync.`);
    if (permissions.get().cloudSync !== "always") {
      const answer = await confirm({ kind: "sync", name: doc.name, path: doc.path });
      if (!answer.allowed) throw new Error("The user declined to put this file in Markie Cloud.");
      if (answer.always) permissions.set({ ...permissions.get(), cloudSync: "always" });
    }
    const content = fs.readFileSync(doc.path, "utf8");
    const row = registry.get(doc.path);
    let res;
    if (row && row.cloud_doc_id) {
      res = await sync.push(doc.path, doc.name, content);
      if (res && res.skipped === "not synced") throw new Error(`${doc.name} has a sync conflict. Open it in Markie to resolve it.`);
    } else {
      registry.track(doc.path, doc.name, content);
      res = await sync.syncOn(doc.path, doc.name, content);
    }
    libraryChanged();
    if (res && res.conflict) throw new Error(`${doc.name} changed in Markie Cloud and here. Open it in Markie to resolve it.`);
    if (res && res.skipped) throw new Error(res.skipped === "not signed in" ? "Sign in to Markie Cloud in the Markie app first." : `Not synced: ${res.skipped}.`);
    if (res && res.error) throw new Error(res.error);
    return describe(doc);
  }

  async function cloudApi(row, method, suffix) {
    const origin = sync.originOfRow(row);
    const res = await sync.withOrigin(origin, () => sync.api(method, `/api/docs/${encodeURIComponent(row.cloud_doc_id)}/public-link${suffix || ""}`));
    if (res.status === 401) throw new Error("Sign in to Markie Cloud in the Markie app first.");
    if (res.status === 403) throw new Error("Only the owner of this document can change its public link.");
    if (res.status < 200 || res.status >= 300) throw new Error(res.status === 0 ? "Markie Cloud could not be reached." : `Markie Cloud refused (${res.status}).`);
    return res.data || {};
  }

  async function publicLink({ path: p, create }) {
    requireUnlocked();
    const doc = resolveDoc(p);
    const row = linkedRow(doc);
    const current = await cloudApi(row, "GET");
    if (current.url || !create) return { ...describe(doc), publicLink: current.url || null };
    const answer = await confirm({ kind: "public", name: doc.name, path: doc.path });
    if (!answer.allowed) throw new Error("The user declined to make a public link.");
    const made = await cloudApi(row, "POST");
    if (typeof made.url !== "string") throw new Error("Markie Cloud did not return a link.");
    return { ...describe(doc), publicLink: made.url };
  }

  async function revokePublicLink({ path: p }) {
    requireUnlocked();
    const doc = resolveDoc(p);
    await cloudApi(linkedRow(doc), "DELETE");
    return { ...describe(doc), publicLink: null };
  }

  return {
    handlers: {
      cloud_status: status,
      cloud_sync: syncDoc,
      cloud_public_link: publicLink,
      cloud_revoke_public_link: revokePublicLink,
    },
    privateLinkFor,
  };
}

module.exports = { createAgentCloud, privateLinkFor, SYNCABLE };
