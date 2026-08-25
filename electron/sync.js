// Snapshot sync engine — pushes/pulls whole-doc snapshots to the Markie API.
// The renderer provides the bearer token + server URL via sync-config IPC.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const registry = require("./registry");
const { isAllowedServerOrigin } = require("./share-origin");
// Every write below lands on a file the user owns, so none of them may leave a
// truncated document behind if the process dies mid-write.
const { writeFileAtomic } = require("./atomic-write");

let config = { token: null, serverURL: null };

// What the signed-in user may do with each cloud doc, keyed by cloud doc id.
// The renderer resolves the role once (src/lib/share-role.ts) and reports it
// here; libraryState fills in the rest from the doc list it already fetches.
// Nothing is inferred locally, so an unreported doc stays unknown.
const docRoles = new Map();

function setDocRole(cloudId, role) {
  if (!cloudId) return;
  if (role) docRoles.set(cloudId, role);
  else docRoles.delete(cloudId);
}

function setConfig(next) {
  const serverURL = next.serverURL ?? null;
  // SECURITY: only forward the bearer token to an allowlisted origin so a future
  // code path can't be tricked into exfiltrating the session token.
  const allowed = isAllowedServerOrigin(serverURL, {
    allowDev: process.env.NODE_ENV === "development",
  });
  config = { token: next.token ?? null, serverURL: allowed ? serverURL : null };
  // Roles belong to whoever was signed in. Another account's grants on the same
  // doc are a different answer entirely.
  docRoles.clear();
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
    // A 2xx whose body is not JSON — an HTML error page from a proxy, a
    // text/plain response from a server with no JSON notFound handler — is not
    // a success: every caller below reads fields out of `data`, and reading
    // them off null is how a shared-doc open used to take the window down.
    const data = await res.json().catch(() => null);
    if (res.status >= 200 && res.status < 300 && data === null) {
      return { status: res.status, data: null, unreadable: true };
    }
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

// What the user is told when the server answered, but with something this
// client cannot use. Distinct from a transport failure on purpose: retrying
// is not the fix, and pretending the doc is empty would be worse.
const UNREADABLE = "The server sent an unreadable copy of this document.";

// The doc from a GET response, or null when the body was not the shape this
// client expects. Callers write `doc.content` to disk, so a non-string content
// has to fail here rather than truncate the file to "undefined".
function readDoc(res) {
  const doc = res.data && res.data.doc;
  if (!doc || typeof doc.content !== "string") return null;
  return doc;
}

// The version from a PUT response, or null when the body was unusable. A
// missing version would be recorded as the local base version and make every
// later push look like a conflict.
function readVersion(res) {
  const v = res.data && res.data.version;
  return typeof v === "number" ? v : null;
}

// A viewer can read a shared doc and nothing else, so a snapshot push is a
// request the server only ever answers with 403. Refusing it here says what is
// actually wrong instead of reporting a failed backup. The server check stays:
// this is about not lying to the user, not about security.
function viewerRefusal(filePath, cloudId) {
  if (!cloudId || docRoles.get(cloudId) !== "viewer") return null;
  // The snapshot is on local disk and is never going to reach the cloud, so the
  // row must not keep telling the Library it is backed up.
  registry.update(filePath, { sync_state: "unpushed" });
  return {
    error:
      "You have view-only access to this shared document. Make a copy to keep your changes.",
  };
}

// Turn syncing on for a file: create the cloud doc (or push a new snapshot).
async function syncOn(filePath, name, content) {
  if (!isConfigured()) return { error: "not signed in" };
  const row = registry.get(filePath);
  const refused = viewerRefusal(filePath, row?.cloud_doc_id);
  if (refused) return refused;
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
    const version = readVersion(res);
    if (version === null) {
      // The server took the snapshot — we just cannot read what version it gave
      // it. Remembering the id it was stored under (and only the id) keeps the
      // next attempt a retry of the *same* cloud doc; without it every retry
      // minted a fresh uuid and left an orphan copy behind. No cloud_version is
      // recorded, so the row stays unpushed and the next push re-sends from 0.
      registry.update(filePath, { cloud_doc_id: cloudId, sync_state: "unpushed" });
      return { error: UNREADABLE };
    }
    registry.update(filePath, {
      cloud_doc_id: cloudId,
      cloud_version: version,
      content_hash: hash,
      sync_state: "synced",
      last_synced_at: new Date().toISOString(),
    });
    return { ok: true, version };
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
  const refused = viewerRefusal(filePath, row.cloud_doc_id);
  if (refused) return refused;
  const hash = registry.hashContent(content);
  const res = await api("PUT", `/api/docs/${row.cloud_doc_id}`, {
    name,
    content,
    hash,
    baseVersion: row.cloud_version ?? 0,
  });
  if (res.status === 200) {
    const version = readVersion(res);
    if (version === null) {
      registry.update(filePath, { sync_state: "unpushed" });
      return { error: UNREADABLE };
    }
    registry.update(filePath, {
      cloud_version: version,
      content_hash: hash,
      // Clears "unpushed" when a retry finally lands.
      sync_state: "synced",
      last_synced_at: new Date().toISOString(),
    });
    return { ok: true, version };
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
  const doc = readDoc(res);
  if (!doc) return { error: UNREADABLE };
  const name = typeof doc.name === "string" && doc.name ? doc.name : path.basename(targetPath);
  try {
    writeFileAtomic(targetPath, doc.content);
  } catch (e) {
    return { error: `Couldn't write ${targetPath}: ${e.message}` };
  }
  registry.track(targetPath, name, doc.content);
  registry.update(targetPath, {
    cloud_doc_id: cloudId,
    cloud_version: typeof doc.version === "number" ? doc.version : 0,
    sync_state: "synced",
    last_synced_at: new Date().toISOString(),
  });
  return { ok: true, path: targetPath, name };
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
    const doc = readDoc(res);
    if (!doc) return { error: UNREADABLE };
    try {
      writeFileAtomic(filePath, doc.content);
    } catch (e) {
      return { error: `Couldn't write ${filePath}: ${e.message}` };
    }
    const version = typeof doc.version === "number" ? doc.version : 0;
    registry.update(filePath, {
      cloud_version: version,
      content_hash: registry.hashContent(doc.content),
      sync_state: "synced",
      last_synced_at: new Date().toISOString(),
    });
    // The renderer may have this file open, and a buffer still holding the
    // replaced content would push it straight back on the next save.
    return {
      ok: true,
      reloaded: true,
      content: doc.content,
      version,
    };
  }
  // keep local: re-read server version, push on top of it
  const remote = await api("GET", `/api/docs/${row.cloud_doc_id}`);
  const remoteDoc = remote.status === 200 ? readDoc(remote) : null;
  const baseVersion =
    remoteDoc && typeof remoteDoc.version === "number" ? remoteDoc.version : 0;
  let content;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    return { error: `Couldn't read the local file: ${e.message}` };
  }
  const res = await api("PUT", `/api/docs/${row.cloud_doc_id}`, {
    name: row.name,
    content,
    hash: registry.hashContent(content),
    baseVersion,
  });
  if (res.status !== 200) return { error: `push failed (${res.status})` };
  const pushedVersion = readVersion(res);
  if (pushedVersion === null) return { error: UNREADABLE };
  registry.update(filePath, {
    cloud_version: pushedVersion,
    content_hash: registry.hashContent(content),
    sync_state: "synced",
    last_synced_at: new Date().toISOString(),
  });
  return { ok: true, pushed: true };
}

// Which tracked files the server has a newer snapshot of.
//
// One GET covers every file, so polling costs the same whether the library has
// three documents or three hundred, and no document content is fetched: the
// content only matters once someone opens the prompt, and fetching it here
// would mean downloading every out-of-date document on a timer.
async function checkUpdates() {
  if (!isConfigured()) return { updates: [] };
  const res = await api("GET", "/api/docs");
  // A list we never received says nothing about who is ahead. Reporting
  // "no updates" is right: it is the same as the state before the check, and
  // the alternative is a background failure interrupting someone's writing.
  if (res.status !== 200 || !Array.isArray(res.data?.docs)) return { updates: [] };
  const remote = new Map(res.data.docs.map((d) => [d.id, d]));
  const updates = [];
  for (const row of registry.list()) {
    if (!row.cloud_doc_id) continue;
    const r = remote.get(row.cloud_doc_id);
    // Absent from the list means deleted or revoked, which libraryState reports
    // as "paused". It is not an update to pull.
    if (!r) continue;
    const localVersion = row.cloud_version ?? 0;
    if (r.version > localVersion) {
      updates.push({
        path: row.path,
        cloudId: row.cloud_doc_id,
        name: row.name,
        localVersion,
        remoteVersion: r.version,
        // A clean buffer does not mean nothing is at risk. "conflict" and
        // "unpushed" both mean the file on disk holds changes the server never
        // took, so pulling over it destroys them even though nothing looks
        // unsaved. The caller cannot tell from the buffer alone.
        syncState: row.sync_state,
      });
    }
  }
  return { updates };
}

// The server's copy of a doc, for showing what a pull would cost before it
// happens. Read-only: nothing on disk or in the registry is touched.
async function remoteContent(filePath) {
  const row = registry.get(filePath);
  if (!row?.cloud_doc_id) return { error: "not synced" };
  if (!isConfigured()) return { error: "not signed in" };
  const res = await api("GET", `/api/docs/${row.cloud_doc_id}`);
  if (res.status !== 200) return { error: failure("fetch", res) };
  const doc = readDoc(res);
  if (!doc) return { error: UNREADABLE };
  return {
    ok: true,
    content: doc.content,
    version: doc.version,
    name: doc.name,
  };
}

// A path like "notes (my version).md" that does not already exist. Suffixes
// rather than overwrites: this function exists to stop work being destroyed,
// so it must not destroy a previous rescue on the way.
function keepBothPath(filePath, exists = fs.existsSync) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let n = 0; n < 1000; n++) {
    const suffix = n === 0 ? " (my version)" : ` (my version ${n + 1})`;
    const candidate = path.join(dir, `${stem}${suffix}${ext}`);
    if (!exists(candidate)) return candidate;
  }
  return null;
}

// Keep both copies: the local one moves to its own file, then the server copy
// takes over the original path.
//
// The order is the entire point. The local copy is on disk and tracked before
// anything overwrites the original, so a failure at any earlier step leaves the
// user with exactly what they had.
// localContent is the caller's version of "mine". The renderer passes its
// editor buffer, which is what the user means by their version and what the
// dialog counted the lines of; reading the file instead would rescue the last
// saved copy and drop every unsaved edit, in the one feature whose entire job
// is not losing them. Falls back to disk for callers with no buffer.
async function resolveKeepBoth(filePath, localContent) {
  const row = registry.get(filePath);
  if (!row?.cloud_doc_id) return { error: "not synced" };
  if (!isConfigured()) return { error: "not signed in" };

  let local;
  if (typeof localContent === "string") {
    local = localContent;
  } else {
    try {
      local = fs.readFileSync(filePath, "utf-8");
    } catch (e) {
      return { error: `Couldn't read the local file: ${e.message}` };
    }
  }

  // Fetch before writing anything: an unreachable server must not leave a
  // stray copy behind for a resolution that never happened.
  const res = await api("GET", `/api/docs/${row.cloud_doc_id}`);
  if (res.status !== 200) return { error: failure("fetch", res) };
  const doc = readDoc(res);
  if (!doc) return { error: UNREADABLE };

  const copyPath = keepBothPath(filePath);
  if (!copyPath) return { error: "Couldn't find an unused name for the copy." };
  try {
    writeFileAtomic(copyPath, local);
  } catch (e) {
    return { error: `Couldn't write the copy: ${e.message}` };
  }
  // local-only with no cloud_doc_id: a rescued copy must never become a second
  // window onto the document it was rescued from.
  registry.track(copyPath, path.basename(copyPath), local);
  registry.update(copyPath, {
    cloud_doc_id: null,
    cloud_version: 0,
    sync_state: "local-only",
    share_role: null,
  });

  try {
    writeFileAtomic(filePath, doc.content);
  } catch (e) {
    // The copy survives, so nothing was lost; say where it went.
    return { error: `Saved your version to ${copyPath}, but couldn't overwrite the original: ${e.message}` };
  }
  registry.update(filePath, {
    cloud_version: doc.version,
    content_hash: registry.hashContent(doc.content),
    sync_state: "synced",
    last_synced_at: new Date().toISOString(),
  });
  return { ok: true, keptAt: copyPath, content: doc.content, version: doc.version };
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
  // The list already says what this user may do with each doc, so record it and
  // a later push can refuse without asking the server a second time. A doc that
  // is shared but arrives without a role reads as view-only, not as an editor.
  for (const d of remote) {
    setDocRole(d.id, d.shared ? d.role ?? "viewer" : "owner");
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
  isConfigured,
  setConfig,
  setDocRole,
  syncOn,
  syncOff,
  push,
  pull,
  resolve,
  checkUpdates,
  remoteContent,
  resolveKeepBoth,
  keepBothPath,
  libraryState,
};
