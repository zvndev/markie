const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { createHash, randomUUID } = require("node:crypto");
const { writeFileAtomic } = require("./atomic-write.js");

const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const DOCUMENT_EXTENSIONS = ["md", "markdown", "mdx", "txt", "text", "log", "csv", "json", "yaml", "yml", "xml", "docx", "doc", "rtf", "html", "htm", "odt"];
const WRITABLE = /\.(?:md|markdown|mdx|txt|text|log|csv|json|ya?ml|xml|docx)$/i;
const OPENABLE = /\.(?:md|markdown|mdx|txt|text|log|csv|json|ya?ml|xml|docx|doc|rtf|html?|odt)$/i;
const EXTRA_LAUNCH = /\.(?:json|ya?ml|xml|docx|doc|rtf|html?|odt)$/i;
class NativeFileError extends Error { constructor(code, message) { super(message); this.code = code; } }
function fail(code, message) { throw new NativeFileError(code, message); }
function errorResult(error) { return { ok: false, error: { code: error instanceof NativeFileError ? error.code : "io-error", message: error instanceof NativeFileError ? error.message : "The file operation failed. Your previous file was not acknowledged as changed." } }; }
function validObject(value, keys) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) fail("invalid-request", "Invalid native document request."); return value; }
const identity = (stat) => `${stat.dev}:${stat.ino}`;
const stamp = (stat) => `${identity(stat)}:${stat.size}:${stat.mtimeNs ?? stat.mtimeMs}:${stat.ctimeNs ?? stat.ctimeMs}`;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const typedArrayName = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get;

/** Filesystem paths enter only through these main-process OS/dialog entry points. */
/** @param {{dialog?: {showOpenDialog?: Function, showSaveDialog?: Function}, getWindow?: Function, fileSystem?: typeof fs, platform?: string, maxBytes?: number, maxLeases?: number, maxQueued?: number}} options */
function createDocumentFileService({ dialog, getWindow = () => undefined, fileSystem = fs, platform = process.platform, maxBytes = MAX_DOCUMENT_BYTES, maxLeases = 128, maxQueued = 32 } = {}) {
  if (!dialog || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_DOCUMENT_BYTES || !Number.isSafeInteger(maxLeases) || maxLeases < 1 || !Number.isSafeInteger(maxQueued) || maxQueued < 1) throw new Error("Invalid native document service options.");
  const io = fileSystem, leases = new Map(), queued = [], owners = new Map(), targetQueues = new Map(), dropped = new Map();
  let dialogQueue = Promise.resolve(), pendingDialogs = 0, pendingOperations = 0, pendingWriteBytes = 0;
  const key = (target) => platform === "win32" ? target.toLowerCase() : target;
  const dropKey = (owner, selected) => `${owner}:${key(selected)}`;
  const epoch = (owner) => owners.get(owner) ?? 0;
  const ownerValid = (owner) => { if (!Number.isSafeInteger(owner) || owner < 1) fail("access-denied", "This window cannot access native documents."); };
  const protect = async (operation) => { try { return { ok: true, value: await operation() }; } catch (error) { return errorResult(error); } };
  const parentState = (target) => {
    const parent = path.dirname(target), real = io.realpathSync(parent), stat = io.lstatSync(real, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("access-denied", "The selected folder is not a regular local directory.");
    return { real, id: identity(stat) };
  };
  const assertParent = (entry) => {
    const current = parentState(entry.target);
    if (key(current.real) !== key(entry.parent.real) || current.id !== entry.parent.id) fail("conflict", "The selected folder was replaced. Choose the file again.");
  };
  const readSnapshot = (entry) => {
    assertParent(entry);
    let before;
    try { before = io.lstatSync(entry.target, { bigint: true }); } catch (error) { if (error.code === "ENOENT") { if (entry.fileId === null) return null; fail("conflict", "The selected file was removed or replaced. Reopen it before saving."); } throw error; }
    if (!before.isFile() || before.isSymbolicLink()) fail("access-denied", "Native document access does not follow symbolic links or special files.");
    if (entry.fileId !== undefined && identity(before) !== entry.fileId) fail("conflict", "The selected file was replaced. Reopen it with the native picker.");
    if (before.size > BigInt(maxBytes)) fail("too-large", "Native documents are limited to 32 MiB.");
    const fd = io.openSync(entry.target, io.constants.O_RDONLY | (io.constants.O_NOFOLLOW ?? 0));
    try {
      const first = io.fstatSync(fd, { bigint: true });
      if (!first.isFile() || stamp(first) !== stamp(before)) fail("conflict", "The document changed while it was being opened.");
      const buffer = Buffer.alloc(Number(first.size) + 1); let length = 0;
      while (length < buffer.length) { const got = io.readSync(fd, buffer, length, buffer.length - length, length); if (!got) break; length += got; }
      const after = io.fstatSync(fd, { bigint: true }), pathname = io.lstatSync(entry.target, { bigint: true });
      if (length !== Number(first.size) || stamp(first) !== stamp(after) || stamp(after) !== stamp(pathname)) fail("conflict", "The document changed during its bounded read. Reopen it before editing.");
      const bytes = new Uint8Array(buffer.subarray(0, length));
      return { bytes, fileId: identity(after), revision: sha(`${stamp(after)}:${sha(bytes)}`), size: length, lastModified: Number(after.mtimeNs / 1000000n) };
    } finally { io.closeSync(fd); }
  };
  const prepare = (selected, allowNew = false, readContents = true) => {
    if (typeof selected !== "string" || !path.isAbsolute(selected) || selected.length > 4096 || !OPENABLE.test(selected)) fail("unsupported", "Choose a supported local document file.");
    let target, selectedStat, existed = true;
    try { const stat = io.lstatSync(selected, { bigint: true }); if (stat.isSymbolicLink() || !stat.isFile()) fail("access-denied", "Choose a regular file, not a symbolic link or special file."); selectedStat = stat; target = io.realpathSync(selected); }
    catch (error) { if (!allowNew || error.code !== "ENOENT") throw error; existed = false; const parent = io.realpathSync(path.dirname(selected)); target = path.join(parent, path.basename(selected)); }
    const entry = { target, parent: parentState(target), fileId: existed ? undefined : null, revision: null, size: 0, lastModified: 0, writable: WRITABLE.test(target) };
    // sendSync only stamps the dropped inode; bulk drops must not copy every
    // document into memory before the renderer has even chosen what to open.
    if (!readContents && existed) {
      if (selectedStat.size > BigInt(maxBytes)) fail("too-large", "Native documents are limited to 32 MiB.");
      entry.fileId = identity(selectedStat);
      return entry;
    }
    const snapshot = readSnapshot(entry);
    if (snapshot) Object.assign(entry, snapshot, { bytes: undefined });
    else entry.fileId = null;
    return entry;
  };
  const descriptor = (id, entry) => ({ leaseId: id, name: path.basename(entry.target), size: entry.size, lastModified: entry.lastModified, revision: entry.revision, writable: entry.writable });
  const grant = (owner, entry) => {
    ownerValid(owner); if (leases.size >= maxLeases) fail("limit-exceeded", "Too many native files are retained. Close documents before opening more.");
    const id = randomUUID(); leases.set(id, { ...entry, owner }); return descriptor(id, entry);
  };
  const lease = (owner, id) => { ownerValid(owner); if (typeof id !== "string" || id.length !== 36) fail("invalid-request", "A native file lease is required."); const entry = leases.get(id); if (!entry || entry.owner !== owner) fail("access-denied", "This native file grant is no longer available."); return entry; };
  const onTarget = (target, operation) => {
    if (pendingOperations >= 64) fail("limit-exceeded", "Too many native document operations are pending.");
    pendingOperations++;
    const targetKey = key(target), previous = targetQueues.get(targetKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation); targetQueues.set(targetKey, next);
    void next.finally(() => { pendingOperations--; if (targetQueues.get(targetKey) === next) targetQueues.delete(targetKey); }).catch(() => undefined);
    return next;
  };
  const picker = (owner, operation) => {
    ownerValid(owner); const generation = epoch(owner);
    if (pendingDialogs >= maxQueued) fail("limit-exceeded", "Too many native file dialogs are queued.");
    pendingDialogs++;
    const run = dialogQueue.catch(() => undefined).then(async () => { if (epoch(owner) !== generation) return null; const selected = await operation(); if (epoch(owner) !== generation || !selected) return null; return grant(owner, selected); }).finally(() => { pendingDialogs--; });
    dialogQueue = run.catch(() => undefined); return run;
  };
  return {
    maxBytes,
    open(owner) { return protect(() => picker(owner, async () => { const result = await dialog.showOpenDialog(getWindow(), { properties: ["openFile"], filters: [{ name: "Documents", extensions: DOCUMENT_EXTENSIONS }] }); return result.canceled || !result.filePaths?.[0] ? null : prepare(result.filePaths[0]); })); },
    saveAs(owner, args) { return protect(() => { const v = validObject(args, ["suggestedName"]); if (typeof v.suggestedName !== "string" || !v.suggestedName || v.suggestedName.length > 256 || /[\\/:*?"<>|\x00-\x1f\x7f]/.test(v.suggestedName) || !WRITABLE.test(v.suggestedName)) fail("unsupported", "Choose a supported editable filename for Save As."); return picker(owner, async () => { const result = await dialog.showSaveDialog(getWindow(), { defaultPath: v.suggestedName, filters: [{ name: "Document", extensions: [path.extname(v.suggestedName).slice(1)] }] }); if (result.canceled || !result.filePath) return null; if (!WRITABLE.test(result.filePath)) fail("unsupported", "The selected rich source format is read-only. Choose DOCX or a text-copy extension."); return prepare(result.filePath, true); }); }); },
    read(owner, args) { return protect(() => { const v = validObject(args, ["leaseId"]), entry = lease(owner, v.leaseId); return onTarget(entry.target, () => { lease(owner, v.leaseId); const snapshot = readSnapshot(entry); if (!snapshot) { return { descriptor: descriptor(v.leaseId, entry), bytes: new Uint8Array() }; } Object.assign(entry, snapshot, { bytes: undefined }); return { descriptor: descriptor(v.leaseId, entry), bytes: snapshot.bytes }; }); }); },
    write(owner, args) { return protect(() => {
      const v = validObject(args, ["leaseId", "baseRevision", "bytes"]), entry = lease(owner, v.leaseId);
      if (!entry.writable) fail("access-denied", "This source format is read-only. Save an explicit converted copy instead.");
      if (!ArrayBuffer.isView(v.bytes) || typedArrayName.call(v.bytes) !== "Uint8Array" || v.bytes.byteLength > maxBytes) fail("too-large", "A native write requires at most 32 MiB of unsigned bytes.");
      if (v.baseRevision !== null && (typeof v.baseRevision !== "string" || !/^[a-f0-9]{64}$/.test(v.baseRevision))) fail("invalid-request", "A valid native base revision is required.");
      if (v.bytes.byteLength > 64 * 1024 * 1024 - pendingWriteBytes) fail("limit-exceeded", "Queued native writes exceed the byte budget.");
      const bytes = new Uint8Array(v.bytes); pendingWriteBytes += bytes.length;
      try { return onTarget(entry.target, () => {
        lease(owner, v.leaseId);
        if (entry.revision !== v.baseRevision) fail("conflict", "The native handle revision changed before saving.");
        const verify = () => { lease(owner, v.leaseId); const current = readSnapshot(entry); if ((current?.revision ?? null) !== v.baseRevision) fail("conflict", "The file changed on disk. Reopen it before overwriting those changes."); };
        verify();
        // Reuse Markie's fsync/metadata-preserving atomic writer. The final commit
        // hook rechecks CAS after staging, and new files use an atomic no-clobber link.
        const wrapped = Object.create(io); let committedId;
        wrapped.renameSync = (temporary, destination) => {
          if (destination !== entry.target) fail("access-denied", "The native save target changed.");
          verify();
          const stagedId = identity(io.lstatSync(temporary, { bigint: true }));
          if (entry.fileId === null) {
            try { io.linkSync(temporary, destination); } catch (error) { if (error.code === "EEXIST") fail("conflict", "A file appeared at the chosen Save As name. Choose another name."); throw error; }
            try { io.unlinkSync(temporary); } catch { /* Data is committed; a stray staged name must not cause a false failure. */ }
          } else io.renameSync(temporary, destination);
          committedId = stagedId;
        };
        writeFileAtomic(entry.target, bytes, { fs: wrapped, platform });
        // The atomic replace intentionally changes the inode. Rebind only this
        // winning lease; distinct old leases remain stale and cannot overwrite it.
        entry.fileId = committedId; const saved = readSnapshot(entry);
        Object.assign(entry, saved, { bytes: undefined }); return descriptor(v.leaseId, entry);
      }).finally(() => { pendingWriteBytes -= bytes.length; }); } catch (error) { pendingWriteBytes -= bytes.length; throw error; }
    }); },
    release(owner, args) { return protect(() => { const v = validObject(args, ["leaseId"]); lease(owner, v.leaseId); leases.delete(v.leaseId); return null; }); },
    releaseOwner(owner) {
      owners.set(owner, epoch(owner) + 1);
      for (const [id, entry] of leases) if (entry.owner === owner) leases.delete(id);
      for (const [id, entry] of dropped) if (entry.dropOwner === owner) dropped.delete(id);
      for (let i = queued.length - 1; i >= 0; i--) if (queued[i].dropOwner === owner) queued.splice(i, 1);
    },
    // Internal main-process bridge for the existing trusted File-drop channel.
    // It never broadens the classic grants used by Markdown, assets or sync.
    grantDroppedFile(owner, selected) {
      try {
        ownerValid(owner);
        if (typeof selected !== "string" || !EXTRA_LAUNCH.test(selected)) return { ok: true, value: false };
        const id = dropKey(owner, selected);
        if (!dropped.has(id) && dropped.size >= maxQueued) fail("limit-exceeded", "Too many native file drops are awaiting open.");
        dropped.set(id, { ...prepare(selected, false, false), dropOwner: owner });
        return { ok: true, value: true };
      } catch (error) { return errorResult(error); }
    },
    queueDroppedFile(owner, selected) {
      try {
        ownerValid(owner);
        if (typeof selected !== "string") return { ok: true, value: false };
        const id = dropKey(owner, selected), entry = dropped.get(id);
        if (!entry) return { ok: true, value: false };
        if (queued.length >= maxQueued) fail("limit-exceeded", "Too many OS document opens are queued.");
        const current = readSnapshot(entry);
        if (current) Object.assign(entry, current, { bytes: undefined });
        dropped.delete(id); queued.push(entry);
        return { ok: true, value: true };
      } catch (error) { return errorResult(error); }
    },
    queueOsFile(selected, { includeClassic = false } = {}) { try { if (!(includeClassic === true ? OPENABLE : EXTRA_LAUNCH).test(selected)) return { ok: true, value: false }; if (queued.length >= maxQueued) fail("limit-exceeded", "Too many OS document opens are queued."); queued.push(prepare(selected)); return { ok: true, value: true }; } catch (error) { return errorResult(error); } },
    takeInitial(owner) { return protect(() => { ownerValid(owner); const at = queued.findIndex((entry) => entry.dropOwner === undefined || entry.dropOwner === owner); if (at < 0) return null; if (leases.size >= maxLeases) fail("limit-exceeded", "Close a native document before accepting another OS open."); const [entry] = queued.splice(at, 1); const current = readSnapshot(entry); if (current) Object.assign(entry, current, { bytes: undefined }); return grant(owner, entry); }); },
  };
}

function findNativeDocumentLaunchFile(argv, { existsSync = fs.existsSync, resolvePath = path.resolve } = {}) {
  for (const arg of Array.isArray(argv) ? argv : []) {
    if (typeof arg !== "string") continue;
    let target = arg; if (/^file:\/\//i.test(target)) { try { target = fileURLToPath(target); } catch { continue; } }
    if (EXTRA_LAUNCH.test(target) && existsSync(target)) return resolvePath(target);
  }
  return null;
}
function registerDocumentFileIpc({ handle, service, ownerForEvent }) {
  for (const [channel, method] of [["open", "open"], ["save-as", "saveAs"], ["read", "read"], ["write", "write"], ["release", "release"], ["take-initial", "takeInitial"]]) {
    handle(`document-files:${channel}`, (event, args) => { const owner = ownerForEvent(event); if (!owner) return errorResult(new NativeFileError("access-denied", "This frame cannot access native document files.")); return service[method](owner, args); });
  }
}
module.exports = { createDocumentFileService, findNativeDocumentLaunchFile, registerDocumentFileIpc, MAX_DOCUMENT_BYTES, DOCUMENT_EXTENSIONS, EXTRA_LAUNCH };
