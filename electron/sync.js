// Snapshot sync engine — pushes/pulls whole-doc snapshots to the Markie API.
// The renderer provides the bearer token + server URL via sync-config IPC.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const registry = require("./registry");
const { isAllowedServerOrigin } = require("./share-origin");

let config = { token: null, serverURL: null };

function setConfig(next) {
  const serverURL = next.serverURL ?? null;
  // SECURITY: only forward the bearer token to an allowlisted origin so a future
  // code path can't be tricked into exfiltrating the session token.
  const allowed = isAllowedServerOrigin(serverURL, {
    allowDev: process.env.NODE_ENV === "development",
  });
  config = { token: next.token ?? null, serverURL: allowed ? serverURL : null };
}

function isConfigured() {
  return !!(config.token && config.serverURL);
}

// Status for a request that never reached the server (offline, DNS failure,
// timeout). fetch throws in those cases, and a throw escaping from here used to
// abort the caller before it could record the failure, leaving the registry
// claiming a push had succeeded. Every caller now sees a status it must handle.
const NO_RESPONSE = 0;

async function api(method, p, body) {
  // Abort a hung request so the renderer's invoke() can't pend forever
  // (e.g. an unreachable server would otherwise freeze the save indicator).
  try {
    const res = await fetch(`${config.serverURL}${p}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  } catch {
    return { status: NO_RESPONSE, data: null };
  }
}

// "offline" reads as something the user can act on; a bare 0 does not.
function failure(verb, res) {
  return res.status === NO_RESPONSE
    ? `${verb} failed (offline)`
    : `${verb} failed (${res.status})`;
}

// Turn syncing on for a file: create the cloud doc (or push a new snapshot).
async function syncOn(filePath, name, content) {
  if (!isConfigured()) return { error: "not signed in" };
  const row = registry.get(filePath);
  const cloudId = row?.cloud_doc_id ?? crypto.randomUUID();
  const hash = registry.hashContent(content);
  const baseVersion = row?.cloud_doc_id ? (row.cloud_version ?? 0) : 0;
  const res = await api("PUT", `/api/docs/${cloudId}`, {
    name,
    content,
    hash,
    baseVersion,
  });
  if (res.status === 200) {
    registry.update(filePath, {
      cloud_doc_id: cloudId,
      cloud_version: res.data.version,
      content_hash: hash,
      sync_state: "synced",
      last_synced_at: new Date().toISOString(),
    });
    return { ok: true, version: res.data.version };
  }
  if (res.status === 409) {
    registry.update(filePath, { sync_state: "conflict" });
    return { conflict: true, serverVersion: res.data?.serverVersion };
  }
  // The server did not take the snapshot, so nothing is backed up. Leaving the
  // row on its previous state would tell the user otherwise.
  registry.update(filePath, { sync_state: "unpushed" });
  return { error: failure("push", res) };
}

// Push after save, only when tracked, cloud-linked, and content actually
// changed. "unpushed" is pushable on purpose: a row that failed its last push
// has to stay retryable or the local edit would never reach the server again.
async function push(filePath, name, content) {
  if (!isConfigured()) return { skipped: "not signed in" };
  const row = registry.get(filePath);
  const pushable =
    row?.sync_state === "synced" || row?.sync_state === "unpushed";
  if (!row || !pushable || !row.cloud_doc_id) {
    return { skipped: "not synced" };
  }
  const hash = registry.hashContent(content);
  const res = await api("PUT", `/api/docs/${row.cloud_doc_id}`, {
    name,
    content,
    hash,
    baseVersion: row.cloud_version ?? 0,
  });
  if (res.status === 200) {
    registry.update(filePath, {
      cloud_version: res.data.version,
      content_hash: hash,
      // Clears "unpushed" when a retry finally lands.
      sync_state: "synced",
      last_synced_at: new Date().toISOString(),
    });
    return { ok: true, version: res.data.version };
  }
  if (res.status === 409) {
    registry.update(filePath, { sync_state: "conflict" });
    return { conflict: true };
  }
  // This snapshot exists only on local disk. A row left on "synced" would tell
  // the user the edit is in the cloud and put "Take cloud" one click away from
  // overwriting it with an older copy the server never replaced.
  registry.update(filePath, { sync_state: "unpushed" });
  return { error: failure("push", res) };
}

// Turn syncing off; optionally delete the cloud copy.
async function syncOff(filePath, deleteRemote) {
  const row = registry.get(filePath);
  if (row?.cloud_doc_id && deleteRemote && isConfigured()) {
    const res = await api("DELETE", `/api/docs/${row.cloud_doc_id}`);
    // 404 is the outcome we wanted: it is already gone. On anything else the
    // cloud copy is still live and still served to everyone it was shared with,
    // so keep cloud_doc_id: it is the only handle left to retry the delete.
    if (res.status !== 200 && res.status !== 404) {
      return { error: failure("delete", res) };
    }
    registry.update(filePath, {
      sync_state: "local-only",
      cloud_doc_id: null,
      cloud_version: 0,
    });
    return { ok: true, deleted: true };
  }
  registry.update(filePath, { sync_state: "paused" });
  return { ok: true, paused: true };
}

// Download a cloud-only doc to a local path and track it as synced.
async function pull(cloudId, targetPath) {
  if (!isConfigured()) return { error: "not signed in" };
  const res = await api("GET", `/api/docs/${cloudId}`);
  if (res.status !== 200) return { error: `fetch failed (${res.status})` };
  const doc = res.data.doc;
  fs.writeFileSync(targetPath, doc.content, "utf-8");
  registry.track(targetPath, doc.name, doc.content);
  registry.update(targetPath, {
    cloud_doc_id: cloudId,
    cloud_version: doc.version,
    sync_state: "synced",
    last_synced_at: new Date().toISOString(),
  });
  return { ok: true, path: targetPath, name: doc.name };
}

// Resolve a conflict: "local" force-pushes the local file, "cloud" overwrites it.
async function resolve(filePath, strategy) {
  const row = registry.get(filePath);
  if (!row?.cloud_doc_id || !isConfigured()) return { error: "not resolvable" };
  if (strategy === "cloud") {
    // The server never received this file's latest edit, so the cloud copy is
    // strictly older and overwriting would destroy the only copy that exists.
    if (row.sync_state === "unpushed") {
      return {
        error:
          "This file has changes that never reached the cloud. Taking the cloud copy would delete them. Save again to retry the backup first.",
      };
    }
    const res = await api("GET", `/api/docs/${row.cloud_doc_id}`);
    if (res.status !== 200) return { error: failure("fetch", res) };
    fs.writeFileSync(filePath, res.data.doc.content, "utf-8");
    registry.update(filePath, {
      cloud_version: res.data.doc.version,
      content_hash: registry.hashContent(res.data.doc.content),
      sync_state: "synced",
      last_synced_at: new Date().toISOString(),
    });
    return { ok: true, reloaded: true };
  }
  // keep local: re-read server version, push on top of it
  const remote = await api("GET", `/api/docs/${row.cloud_doc_id}`);
  const baseVersion = remote.status === 200 ? remote.data.doc.version : 0;
  const content = fs.readFileSync(filePath, "utf-8");
  const res = await api("PUT", `/api/docs/${row.cloud_doc_id}`, {
    name: row.name,
    content,
    hash: registry.hashContent(content),
    baseVersion,
  });
  if (res.status !== 200) return { error: `push failed (${res.status})` };
  registry.update(filePath, {
    cloud_version: res.data.version,
    content_hash: registry.hashContent(content),
    sync_state: "synced",
    last_synced_at: new Date().toISOString(),
  });
  return { ok: true, pushed: true };
}

// Merged local + remote view for the Library.
async function libraryState() {
  // vanished local-only files (deleted agent worktrees, temp scratch docs)
  // leave the registry here instead of piling up as "Missing on disk" rows
  registry.pruneMissing();
  const local = registry.list();
  let remote = [];
  // A list request that failed is not the same as a server with no docs. Without
  // this flag one transient error relabels every synced row as deleted remotely.
  let remoteLoaded = false;
  if (isConfigured()) {
    const res = await api("GET", "/api/docs");
    if (res.status === 200 && Array.isArray(res.data?.docs)) {
      remote = res.data.docs;
      remoteLoaded = true;
    }
  }
  const byCloudId = new Map(local.filter((f) => f.cloud_doc_id).map((f) => [f.cloud_doc_id, f]));
  const items = local.map((f) => {
    const r = f.cloud_doc_id ? remote.find((d) => d.id === f.cloud_doc_id) : null;
    let state = f.sync_state;
    if (state === "synced" && r && r.version > (f.cloud_version ?? 0)) {
      state = "behind"; // newer snapshot exists on the server (other device)
    }
    // Only infer a remote deletion from a list we actually received.
    if (remoteLoaded && state === "synced" && f.cloud_doc_id && !r) {
      state = "paused"; // deleted remotely
    }
    return {
      kind: "local",
      path: f.path,
      name: f.name,
      cloudId: f.cloud_doc_id,
      state,
      lastOpenedAt: f.last_opened_at,
      remoteVersion: r?.version ?? null,
      exists: fs.existsSync(f.path),
      // a synced copy of a doc that was shared with you
      shared: !!r?.shared,
      role: r?.role ?? null,
      sharedBy: r?.shared_by ?? null,
    };
  });
  for (const d of remote) {
    if (!byCloudId.has(d.id)) {
      items.push({
        kind: d.shared ? "shared" : "cloud-only",
        path: null,
        name: d.name,
        cloudId: d.id,
        state: "cloud-only",
        lastOpenedAt: d.updated_at,
        remoteVersion: d.version,
        exists: false,
        shared: !!d.shared,
        role: d.role ?? null,
        sharedBy: d.shared_by ?? null,
      });
    }
  }
  return { signedIn: isConfigured(), items };
}

module.exports = {
  setConfig,
  syncOn,
  syncOff,
  push,
  pull,
  resolve,
  libraryState,
};
