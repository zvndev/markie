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
const docTiers = require("./doc-tiers");

let config = { token: null, serverURL: null };

// What the signed-in user may do with each cloud doc, keyed by cloud doc id.
// The renderer resolves the role once (src/lib/share-role.ts) and reports it
// here; libraryState fills in the rest from the doc list it already fetches.
// Nothing is inferred locally, so an unreported doc stays unknown.
const docRoles = new Map();

// Who is signed in, as the renderer last confirmed with the server. The roles
// the registry remembers were granted to one account, so reading them back for
// any other is worth nothing. Unknown until a confirmed session says, and
// unknown never claims ownership.
let principal = null;

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
  const token = next.token ?? null;
  const server = allowed ? serverURL : null;
  // The session is the token at a server. The same token string offered to
  // another address is a different session: nothing there has said whose it
  // is, and the renderer sends no user with it (setServerURL in auth-client).
  const sessionChanged = token !== config.token || server !== config.serverURL;
  config = { token, serverURL: server };
  // Roles belong to whoever was signed in. Another account's grants on the same
  // doc are a different answer entirely.
  docRoles.clear();
  // The principal is evidence about one token at one server. A different
  // token or server is a different session, whether or not anyone signed out
  // in between, so the old answer goes at once, and a user named in the same
  // push cannot have been confirmed for the new session yet: the renderer
  // sends whatever it last heard, which was said for the session before. The
  // principal comes back only with a later push made after /api/me answered
  // under this token at this server. A push that carries no user and the same
  // session leaves it alone: that usually means nobody has asked the server
  // yet, and offline nobody can. No token at all is a sign-out, and nobody is
  // signed in.
  if (sessionChanged || !token) principal = null;
  else if (next.userId) principal = next.userId;
  // The caller clears the asset cache on this. Cache keys carry no principal,
  // so a token swapped straight from one account to another with no sign-out
  // in between would otherwise leave the first account's pictures on disk for
  // the second to be served from.
  return { sessionChanged };
}

function isConfigured() {
  return !!(config.token && config.serverURL);
}

// Whether a session has been confirmed to belong to somebody, as opposed to
// merely holding a token. Reconciliation needs an account on the other end
// before it goes looking for what that account's server thinks it has.
function hasPrincipal() {
  return principal !== null;
}

// One asset of a cloud document, streamed with the session's token.
// `{ stream, mime, hash, size }` for a 200, `{ gone: true }` for a 404 or a
// 403, and null for anything else, so a caller can tell a revoked share from
// a server having a bad minute.
//
// `ifNoneMatch` is the ETag of a copy the caller already holds (the asset
// cache revalidating a hit). With one, an unchanged picture answers 304,
// reported as `{ notModified: true }`, and sends no bytes at all.
// How long to wait for the server to answer a revalidation, which happens
// while somebody is looking at the picture and the protocol handler waits on
// it, and how long a transfer may then take.
const ANSWER_TIMEOUT_MS = 5000;
const TRANSFER_TIMEOUT_MS = 300000;

async function fetchAsset(cloudId, ref, ifNoneMatch) {
  if (!isConfigured()) return null;
  // Two deadlines, not one. A signal handed to fetch governs the response
  // body as well as the wait for its headers, so a single five-second cap on
  // a revalidation would be five seconds for the whole replacement to
  // download: anything bigger would fail every time, the cache would keep
  // serving the copy it has, and the relink would never land. This one bounds
  // the answer, then is re-armed to bound the transfer.
  const abort = new AbortController();
  let deadline = setTimeout(() => abort.abort(), ifNoneMatch ? ANSWER_TIMEOUT_MS : TRANSFER_TIMEOUT_MS);
  let streaming = false;
  try {
    const headers = { Authorization: `Bearer ${config.token}` };
    if (ifNoneMatch) headers["If-None-Match"] = ifNoneMatch;
    const res = await fetch(`${config.serverURL}/api/docs/${encodeURIComponent(cloudId)}/assets/file?ref=${encodeURIComponent(ref)}`, {
      headers,
      signal: abort.signal,
    });
    clearTimeout(deadline);
    deadline = setTimeout(() => abort.abort(), TRANSFER_TIMEOUT_MS);
    if (ifNoneMatch && res.status === 304) return { notModified: true };
    // Definitive answers: the document has no such ref any more, or this
    // account may no longer read it. A cached copy has to go. Anything else,
    // a 5xx or a proxy's error page, says nothing about whether the picture
    // is still there, so it reads as no answer at all.
    if (res.status === 404 || res.status === 403) return { gone: true };
    if (res.status !== 200 || !res.body) return null;
    const hash = (res.headers.get("etag") ?? "").replace(/"/g, "");
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    streaming = true;
    const stream = res.body.pipeThrough(
      new TransformStream({
        // The transfer's deadline goes when the transfer does, whether the
        // body ran out or died on the way.
        flush: () => clearTimeout(deadline),
        cancel: () => clearTimeout(deadline),
      })
    );
    return { stream, mime: res.headers.get("content-type") ?? "application/octet-stream", hash, size: Number(res.headers.get("content-length") ?? 0) };
  } catch {
    return null;
  } finally {
    // Every path but the one that hands the body to a caller is done with the
    // connection here, and a timer left armed would abort nothing five
    // minutes later.
    if (!streaming) clearTimeout(deadline);
  }
}

// Status for a request that never reached the server (offline, DNS failure,
// timeout). fetch throws in those cases, and a throw escaping from here used to
// abort the caller before it could record the failure, leaving the registry
// claiming a push had succeeded. Every caller now sees a status it must handle.
const NO_RESPONSE = 0;

async function api(method, p, body, opts = {}) {
  // Abort a hung request so the renderer's invoke() can't pend forever
  // (e.g. an unreachable server would otherwise freeze the save indicator).
  try {
    const raw = opts.raw ?? null;
    const res = await fetch(`${config.serverURL}${p}`, {
      method,
      headers: raw
        ? { "Content-Type": raw.mime, "Content-Length": String(raw.size), Authorization: `Bearer ${config.token}` }
        : { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
      body: raw ? raw.stream : body ? JSON.stringify(body) : undefined,
      duplex: raw ? "half" : undefined,
      signal: AbortSignal.timeout(raw ? 300000 : 15000),
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

// Set by main once file grants exist; a null here means media is not pushed,
// which is what the tests that do not care about it get.
let assetSync = null;
function setAssetSync(next) {
  assetSync = next;
}
const mediaFailure = (err) => ({ pending: true, error: `media push failed (${err && err.message ? err.message : err})` });

// Everything up to and including the uploads. Safe before the text PUT: the
// server keeps an uploaded asset nothing points at for an hour, so bytes can
// wait for a snapshot that may never land.
async function stageMedia(filePath, cloudId, content) {
  if (!assetSync) return null;
  try {
    return await assetSync.stageAssets(filePath, cloudId, content);
  } catch (err) {
    return mediaFailure(err);
  }
}

// What the document points at, committed only once its text has landed, and
// against the version that PUT returned. Sent earlier, a link that succeeded
// in front of a text PUT that failed would leave the server's old text beside
// a media set that no longer holds its pictures.
async function linkMedia(filePath, cloudId, staged, baseVersion) {
  try {
    return await assetSync.linkAssets(filePath, cloudId, staged, { baseVersion });
  } catch (err) {
    registry.update(filePath, { assets_state: "pending" });
    return mediaFailure(err);
  }
}

// The text never landed, so the refs are never sent. Anything already staged
// is left for the reconciliation pass to finish.
function mediaLeftPending(filePath, staged) {
  if (staged && staged.staged) registry.update(filePath, { assets_state: "pending" });
}

// Turn syncing on for a file: create the cloud doc (or push a new snapshot).
async function syncOn(filePath, name, content) {
  if (!isConfigured()) return { error: "not signed in" };
  const row = registry.get(filePath);
  const refused = viewerRefusal(filePath, row?.cloud_doc_id);
  if (refused) return refused;
  const linked = row?.cloud_doc_id ?? null;
  const cloudId = linked ?? crypto.randomUUID();
  const baseVersion = linked ? (row.cloud_version ?? 0) : 0;
  // For a document the server already has this is an ordinary push, so its
  // bytes go up ahead of the snapshot that references them, exactly as in
  // push(), and the refs are claimed after the text lands. A document the
  // server has never seen is the one exception: both asset routes answer 404
  // for a cloud id it does not know, so even the uploads have to wait. That
  // one sends its text first, below, and stages after it.
  let staged = linked ? await stageMedia(filePath, cloudId, content) : null;
  let media = staged;
  const hash = registry.hashContent(content);
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
      mediaLeftPending(filePath, staged);
      return { error: UNREADABLE, media };
    }
    registry.update(filePath, {
      cloud_doc_id: cloudId,
      cloud_version: version,
      content_hash: hash,
      sync_state: "synced",
      last_synced_at: new Date().toISOString(),
    });
    if (!linked) {
      staged = await stageMedia(filePath, cloudId, content);
      media = staged;
    }
    if (staged && staged.staged) media = await linkMedia(filePath, cloudId, staged.staged, version);
    return { ok: true, version, media };
  }
  if (res.status === 409) {
    registry.update(filePath, { sync_state: "conflict" });
    mediaLeftPending(filePath, staged);
    return { conflict: true, serverVersion: res.data?.serverVersion, media };
  }
  // The server did not take the snapshot, so nothing is backed up. Leaving the
  // row on its previous state would tell the user otherwise.
  registry.update(filePath, { sync_state: "unpushed" });
  mediaLeftPending(filePath, staged);
  return { error: failure("push", res), media };
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
  const baseVersion = row.cloud_version ?? 0;
  const staged = await stageMedia(filePath, row.cloud_doc_id, content);
  let media = staged;
  const hash = registry.hashContent(content);
  const res = await api("PUT", `/api/docs/${row.cloud_doc_id}`, {
    name,
    content,
    hash,
    baseVersion,
  });
  if (res.status === 200) {
    const version = readVersion(res);
    if (version === null) {
      registry.update(filePath, { sync_state: "unpushed" });
      mediaLeftPending(filePath, staged);
      return { error: UNREADABLE, media };
    }
    registry.update(filePath, {
      cloud_version: version,
      content_hash: hash,
      // Clears "unpushed" when a retry finally lands.
      sync_state: "synced",
      last_synced_at: new Date().toISOString(),
    });
    if (staged && staged.staged) media = await linkMedia(filePath, row.cloud_doc_id, staged.staged, version);
    return { ok: true, version, media };
  }
  if (res.status === 409) {
    registry.update(filePath, { sync_state: "conflict" });
    mediaLeftPending(filePath, staged);
    return { conflict: true, media };
  }
  // This snapshot exists only on local disk. A row left on "synced" would tell
  // the user the edit is in the cloud and put "Take cloud" one click away from
  // overwriting it with an older copy the server never replaced.
  registry.update(filePath, { sync_state: "unpushed" });
  mediaLeftPending(filePath, staged);
  return { error: failure("push", res), media };
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
  const refused = overCap(doc, name);
  if (refused) return { error: refused };
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
  // This is also how a synced file that was deleted from disk comes back,
  // and the save dialog may have put it anywhere. One document, one file, one
  // row: the dead row for the old path is let go of, because left beside the
  // new one it is a second file that pushes over the first the moment it is
  // restored. A row whose file is still on disk is a different situation
  // (two live copies) and is left alone.
  for (const row of registry.list()) {
    if (row.cloud_doc_id !== cloudId || row.path === targetPath) continue;
    if (!fs.existsSync(row.path)) registry.forget(row.path);
  }
  return { ok: true, path: targetPath, name };
}

// A cloud copy over the cap is never written to disk: Markie could not open
// the file it had just made, and the pull is asked for from an open document,
// whose buffer would be left describing bytes that were replaced under it and
// would write them back over the accepted cloud copy on its next save. The
// message names the size so the refusal reads as a fact, not a failure.
function overCap(doc, name) {
  const size = Buffer.byteLength(String(doc.content ?? ""), "utf-8");
  if (docTiers.tierForSize(size) !== "tooLarge") return null;
  return (
    `${name} in the cloud is ${docTiers.formatMegabytes(size)}, more than Markie opens ` +
    `(${docTiers.formatMegabytes(docTiers.MAX_DOC_BYTES)}). Nothing was changed.`
  );
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
    const refused = overCap(doc, path.basename(filePath));
    if (refused) return { error: refused };
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
  // The local copy is what is about to become the cloud text, so it is what
  // its media is staged for.
  const staged = await stageMedia(filePath, row.cloud_doc_id, content);
  let media = staged;
  const res = await api("PUT", `/api/docs/${row.cloud_doc_id}`, {
    name: row.name,
    content,
    hash: registry.hashContent(content),
    baseVersion,
  });
  if (res.status !== 200) {
    mediaLeftPending(filePath, staged);
    return { error: `push failed (${res.status})`, media };
  }
  const pushedVersion = readVersion(res);
  if (pushedVersion === null) {
    mediaLeftPending(filePath, staged);
    return { error: UNREADABLE, media };
  }
  registry.update(filePath, {
    cloud_version: pushedVersion,
    content_hash: registry.hashContent(content),
    sync_state: "synced",
    last_synced_at: new Date().toISOString(),
  });
  if (staged && staged.staged) media = await linkMedia(filePath, row.cloud_doc_id, staged.staged, pushedVersion);
  return { ok: true, pushed: true, media };
}

// Which tracked files the server has a newer snapshot of.
//
// One GET covers every file, so polling costs the same whether the library has
// three documents or three hundred, and no document content is fetched: the
// content only matters once someone opens the prompt, and fetching it here
// would mean downloading every out-of-date document on a timer.
async function checkUpdates() {
  if (!isConfigured()) return { updates: [], listing: null, landed: [] };
  const res = await api("GET", "/api/docs");
  // A list we never received says nothing about who is ahead. Reporting
  // "no updates" is right: it is the same as the state before the check, and
  // the alternative is a background failure interrupting someone's writing.
  if (res.status !== 200 || !Array.isArray(res.data?.docs)) {
    return { updates: [], listing: null, landed: [] };
  }
  // Before anything else: a document synced from another machine lands here
  // by itself, so the loop below sees it as a file of this device's own.
  const landed = await landCloudDocs(res.data.docs);
  const remote = new Map(res.data.docs.map((d) => [d.id, d]));
  // What the list looked like, in one string. The renderer keeps the previous
  // one and refreshes the Library when it moves, which is how a document synced
  // from another machine appears here without anyone reopening the panel.
  const rows = registry.list();
  const listing = listingFingerprint(res.data.docs, rows);
  const updates = [];
  for (const row of rows) {
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
  return { updates, listing, landed };
}

// ── Landing ────────────────────────────────────────────────────────────────
// "Sync to cloud" on one machine means the document turns up on the others,
// not that a row appears in a list with a button to click. Owned documents
// this device has never seen land under <default workspace>/Cloud, the way
// they arrived: a file on disk, registered as synced, that the Library shows
// beside everything else on this device.
//
// Two things are deliberately not landed. A document shared with you opens
// into Downloads when you ask, and is not yours to keep a copy of unasked. And
// a document this device already knows by cloud id, whether its file is
// present, paused, or deleted by hand, is never landed again: deleting the
// file is a decision, and re-creating it every minute would be a haunting.
const LANDING_FOLDER = "Cloud";
let landingNow = false;

function landingDir() {
  // Required lazily: workspace pulls in Electron's app for the Windows
  // Documents folder, and nothing else here needs it.
  const workspace = require("./workspace");
  return path.join(workspace.defaultRootPath(), LANDING_FOLDER);
}

// A file name the document can be written under. Names come from whichever
// machine synced it, so anything that is not a plain base name is reduced to
// one, and a document with no extension becomes markdown, which is what it is.
function landingName(name) {
  let base = path.basename(String(name ?? "").replace(/[\\/]/g, "/")).replace(/[\u0000-\u001f]/g, "").trim();
  if (!base || base === "." || base === "..") base = "document.md";
  if (!path.extname(base)) base = `${base}.md`;
  return base;
}

// "notes.md", then "notes (2).md": a file already there is someone's, and a
// landing must never write over it.
function freePath(dir, base, exists = fs.existsSync) {
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let n = 1; n < 1000; n++) {
    const candidate = path.join(dir, n === 1 ? base : `${stem} (${n})${ext}`);
    if (!exists(candidate)) return candidate;
  }
  return null;
}

async function landCloudDocs(docs) {
  if (landingNow) return [];
  const known = new Set(registry.list().map((r) => r.cloud_doc_id).filter(Boolean));
  const arriving = docs.filter((d) => d && !d.shared && d.id && !known.has(d.id));
  if (arriving.length === 0) return [];
  landingNow = true;
  const landed = [];
  try {
    const dir = landingDir();
    fs.mkdirSync(dir, { recursive: true });
    // The folder is under the default workspace. A machine with no workspace
    // root yet gets the default one, the same way opening the Library would;
    // a machine whose roots were chosen by hand keeps them as they are.
    const workspace = require("./workspace");
    if (workspace.roots().length === 0) workspace.createDefaultRoot();
    for (const doc of arriving) {
      const target = freePath(dir, landingName(doc.name));
      if (!target) continue;
      // A failure is left for the next check: the document stays "in your
      // cloud" in the Library, with the same pull a click would make.
      const pulled = await pull(doc.id, target);
      if (pulled?.ok) landed.push({ path: pulled.path, name: pulled.name, cloudId: doc.id });
    }
  } catch {
    // The workspace could not be made or read; nothing landed, nothing lost.
  } finally {
    landingNow = false;
  }
  return landed;
}

// assets_skipped is stored as JSON text; a row from before Task 6, or one no
// asset was ever skipped on, has none. Either way the Cloud page gets a list,
// never a string to guard against or a parse error to catch itself.
const safeJson = (s) => {
  try {
    const parsed = s ? JSON.parse(s) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

function listingFingerprint(docs, rows = []) {
  const parts = docs
    .map((d) => `${d.id}:${d.version ?? 0}:${d.shared ? 1 : 0}:${d.name ?? ""}`)
    .sort();
  // A row's media state is part of what the Library draws, and a background
  // reconciliation pass moves it without anything on the server changing.
  // Left out, the renderer deduplicated that refresh away and an open Cloud
  // panel went on saying "media pending" until something unrelated moved.
  const media = rows
    .filter((r) => r.cloud_doc_id)
    .map((r) => `${r.cloud_doc_id}:${r.assets_state ?? ""}:${r.assets_skipped ?? ""}`)
    .sort();
  return crypto.createHash("sha1").update([...parts, ...media].join("\n")).digest("hex");
}

// The server's copy of a doc, for showing what a pull would cost before it
// happens. Read-only: nothing on disk or in the registry is touched. The cap
// holds here as it does for the pull: the renderer diffs what comes back, and
// a copy Markie would refuse to open is refused before it gets there.
async function remoteContent(filePath) {
  const row = registry.get(filePath);
  if (!row?.cloud_doc_id) return { error: "not synced" };
  if (!isConfigured()) return { error: "not signed in" };
  const res = await api("GET", `/api/docs/${row.cloud_doc_id}`);
  if (res.status !== 200) return { error: failure("fetch", res) };
  const doc = readDoc(res);
  if (!doc) return { error: UNREADABLE };
  const refused = overCap(doc, path.basename(filePath));
  if (refused) return { error: refused };
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
// No media push here: this function never PUTs text to the cloud. The kept
// copy is deliberately local-only (cloud_doc_id: null below) and never gets a
// cloud id to push its media against, and the original path only pulls the
// cloud's existing content over local, the same "pull, don't push" case as
// resolve("cloud").
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
  // Before the copy too: a "keep both" that keeps one is a stray file.
  const refused = overCap(doc, path.basename(filePath));
  if (refused) return { error: refused };

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

// The role the registry remembers for this document, when it is the only word
// there is. A list that loaded outranks it entirely: a complete list that
// omits a document is the server saying the document is not this account's
// now, whatever it once was (deleted, access revoked, or it belongs to the
// account that was signed in before this one). Without a list, the last thing
// the server said is all an offline session has, and it counts only for the
// account it was said to, and only once this session has confirmed who that
// is. Anything else is null: nobody has said.
function rememberedRole(row, remoteLoaded) {
  if (remoteLoaded) return null;
  if (!principal || row.share_role_user !== principal) return null;
  const role = row.share_role;
  return role === "owner" || role === "editor" || role === "viewer" ? role : null;
}

// Who owns a cloud document, as far as anything can actually say. The list the
// server just sent is the live answer. Without one, the remembered role is the
// last answer the server gave. With neither, ownership is unknown, and unknown
// must not read as "mine": a list that failed used to make someone else's
// document look like your own.
function ownership(remoteRecord, row, remoteLoaded) {
  if (remoteRecord) return !remoteRecord.shared;
  // Nothing in the cloud to own.
  if (!row.cloud_doc_id) return true;
  const role = rememberedRole(row, remoteLoaded);
  if (role === "owner") return true;
  if (role === "editor" || role === "viewer") return false;
  return null;
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
  // A list that did not load used to look exactly like an account with no
  // documents: "signed in", nothing in the cloud, no word about why. On a
  // second machine that reads as "sync is broken".
  let cloudError = null;
  if (isConfigured()) {
    const res = await api("GET", "/api/docs");
    if (res.status === 200 && Array.isArray(res.data?.docs)) {
      remote = res.data.docs;
      remoteLoaded = true;
    } else {
      cloudError = listFailure(res.status);
    }
  }
  // The list already says what this user may do with each doc, so record it and
  // a later push can refuse without asking the server a second time. A doc that
  // is shared but arrives without a role reads as view-only, not as an editor.
  for (const d of remote) {
    setDocRole(d.id, d.shared ? d.role ?? "viewer" : "owner");
  }
  // Rows from before share_role_user existed carry a role and nobody beside
  // it, which offline reads as nobody having said. Opening the document
  // online writes the account in, and a document never opened again would
  // stay unconfirmed for ever; the list names the same rows, so it does the
  // writing. Only rows it names: a row it omits is already read as not this
  // account's while the list is loaded, and gets nothing written.
  if (remoteLoaded && principal) {
    const named = new Map(remote.map((d) => [d.id, d]));
    for (const f of local) {
      const d = f.cloud_doc_id ? named.get(f.cloud_doc_id) : null;
      if (!d) continue;
      const role = d.shared ? (d.role === "editor" ? "editor" : "viewer") : "owner";
      if (f.share_role === role && f.share_role_user === principal) continue;
      registry.update(f.path, { share_role: role, share_role_user: principal });
      f.share_role = role;
      f.share_role_user = principal;
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
    // A document somebody else owns stays shared with you while the server is
    // unreachable. The list is the live answer; without one, a viewer or
    // editor role this account remembers is the server having said so, and
    // reading its absence as "not shared" left the document in no section of
    // the Cloud page for the length of an outage. Who shared it is not
    // remembered, so that stays unknown until the list comes back.
    const remembered = r || !f.cloud_doc_id ? null : rememberedRole(f, remoteLoaded);
    const sharedFromMemory = remembered === "editor" || remembered === "viewer";
    return {
      kind: "local",
      path: f.path,
      name: f.name,
      cloudId: f.cloud_doc_id,
      state,
      lastOpenedAt: f.last_opened_at,
      remoteVersion: r?.version ?? null,
      exists: fs.existsSync(f.path),
      // true mine, false someone else's, null nobody has said
      owned: ownership(r, f, remoteLoaded),
      // a synced copy of a doc that was shared with you
      shared: !!r?.shared || sharedFromMemory,
      role: r?.role ?? (sharedFromMemory ? remembered : null),
      sharedBy: r?.shared_by ?? null,
      media: {
        state: f.assets_state ?? null,
        skipped: safeJson(f.assets_skipped),
      },
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
        // Straight off the list that just loaded, so never in doubt.
        owned: !d.shared,
        shared: !!d.shared,
        role: d.role ?? null,
        sharedBy: d.shared_by ?? null,
      });
    }
  }
  return { signedIn: isConfigured(), items, cloudError };
}

function listFailure(status) {
  if (status === 401 || status === 403) {
    return "Your sign-in has expired. Sign in again to see your cloud documents.";
  }
  if (status === NO_RESPONSE) {
    return "Couldn't reach the server, so your cloud documents may be out of date.";
  }
  return `Couldn't load your cloud documents (HTTP ${status}).`;
}

module.exports = {
  isConfigured,
  hasPrincipal,
  setConfig,
  setDocRole,
  api,
  fetchAsset,
  syncOn,
  syncOff,
  push,
  pull,
  resolve,
  setAssetSync,
  checkUpdates,
  remoteContent,
  resolveKeepBoth,
  keepBothPath,
  libraryState,
  landCloudDocs,
  landingName,
  freePath,
};
