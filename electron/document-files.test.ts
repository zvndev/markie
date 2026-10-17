import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { createDocumentFileService, findNativeDocumentLaunchFile, registerDocumentFileIpc } from "./document-files.cjs";
const folders: string[] = [];
const fixture = () => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "markie-native-documents-")); folders.push(directory); return directory; };
afterEach(() => { for (const directory of folders.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function service(selected: string, overrides: Record<string, unknown> = {}) {
  return createDocumentFileService({ dialog: { async showOpenDialog() { return { canceled: false, filePaths: [selected] }; }, async showSaveDialog() { return { canceled: false, filePath: selected }; } }, platform: "linux", ...overrides });
}
function value<T>(result: { ok: boolean; value?: T; error?: { code: string; message: string } }): T { expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error?.message); return result.value as T; }

describe("bounded opaque native document grants", () => {
  it("requires an exact owner-scoped drop grant before queuing rich bytes", async () => {
    const directory = fixture(), target = path.join(directory, "source.docx"), other = path.join(directory, "other.docx");
    const original = Buffer.from([80, 75, 3, 4, 255, 0]); fs.writeFileSync(target, original); fs.writeFileSync(other, "other");
    const api = service(target);
    expect(api.queueDroppedFile(1, target)).toEqual({ ok: true, value: false });
    expect(api.grantDroppedFile(1, target)).toEqual({ ok: true, value: true });
    expect(api.queueDroppedFile(2, target)).toEqual({ ok: true, value: false });
    expect(api.queueDroppedFile(1, other)).toEqual({ ok: true, value: false });
    expect(api.queueDroppedFile(1, target)).toEqual({ ok: true, value: true });
    expect(api.queueDroppedFile(1, target)).toEqual({ ok: true, value: false });
    expect(value(await api.takeInitial(2))).toBeNull();
    const opened = value<{ leaseId: string }>(await api.takeInitial(1));
    expect(value<{ bytes: Uint8Array }>(await api.read(1, { leaseId: opened.leaseId })).bytes).toEqual(new Uint8Array(original));
    expect(fs.readFileSync(target)).toEqual(original);
  });
  it("revokes pending and queued drop grants with their window owner", async () => {
    const directory = fixture(), first = path.join(directory, "first.docx"), second = path.join(directory, "second.json");
    fs.writeFileSync(first, "first"); fs.writeFileSync(second, "second"); const api = service(first);
    expect(api.grantDroppedFile(1, first).ok).toBe(true); expect(api.queueDroppedFile(1, first).ok).toBe(true);
    expect(api.grantDroppedFile(1, second).ok).toBe(true); api.releaseOwner(1);
    expect(api.queueDroppedFile(1, second)).toEqual({ ok: true, value: false });
    expect(value(await api.takeInitial(1))).toBeNull(); expect(value(await api.takeInitial(2))).toBeNull();
    expect(api.queueOsFile(first).ok).toBe(true); expect(value<{ name: string }>(await api.takeInitial(2)).name).toBe("first.docx");
  });
  it("bounds drop grants, queues and bytes and keeps classic types outside native drops", async () => {
    const directory = fixture(), first = path.join(directory, "first.docx"), second = path.join(directory, "second.json"), classic = path.join(directory, "classic.md");
    fs.writeFileSync(first, "first"); fs.writeFileSync(second, "second"); fs.writeFileSync(classic, "markdown"); const api = service(first, { maxQueued: 1 });
    expect(api.grantDroppedFile(1, classic)).toEqual({ ok: true, value: false });
    expect(api.grantDroppedFile(1, first).ok).toBe(true); expect(api.grantDroppedFile(1, first).ok).toBe(true);
    expect(api.grantDroppedFile(1, second)).toMatchObject({ ok: false, error: { code: "limit-exceeded" } });
    expect(api.queueOsFile(second).ok).toBe(true);
    expect(api.queueDroppedFile(1, first)).toMatchObject({ ok: false, error: { code: "limit-exceeded" } });
    expect(api.grantDroppedFile(0, first)).toMatchObject({ ok: false, error: { code: "access-denied" } });
    expect(service(first, { maxBytes: 0 }).grantDroppedFile(1, first)).toMatchObject({ ok: false, error: { code: "too-large" } });
  });
  it("stamps dropped file identity without reading document contents in the synchronous grant", () => {
    const target = path.join(fixture(), "source.docx"); fs.writeFileSync(target, "source");
    let reads = 0;
    const api = service(target, { fileSystem: { ...fs, readSync(...args: Parameters<typeof fs.readSync>) { reads++; return fs.readSync(...args); } } });
    expect(api.grantDroppedFile(1, target)).toEqual({ ok: true, value: true }); expect(reads).toBe(0);
    expect(api.queueDroppedFile(1, target)).toEqual({ ok: true, value: true }); expect(reads).toBeGreaterThan(0);
  });
  it("rejects rich drop symlinks and inode or parent replacement before queue handoff", () => {
    const directory = fixture(), folder = path.join(directory, "chosen"); fs.mkdirSync(folder);
    const target = path.join(folder, "source.docx"), link = path.join(directory, "link.docx"); fs.writeFileSync(target, "original"); fs.symlinkSync(target, link);
    const api = service(target); expect(api.grantDroppedFile(1, link)).toMatchObject({ ok: false, error: { code: "access-denied" } });
    expect(api.grantDroppedFile(1, target).ok).toBe(true); fs.renameSync(target, path.join(folder, "old.docx")); fs.writeFileSync(target, "replacement");
    expect(api.queueDroppedFile(1, target)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(api.grantDroppedFile(1, target).ok).toBe(true); fs.renameSync(folder, path.join(directory, "old-folder")); fs.mkdirSync(folder); fs.writeFileSync(target, "new parent");
    expect(api.queueDroppedFile(1, target)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
  it("opens and reads exact synthetic binary bytes without renderer filesystem paths", async () => {
    const target = path.join(fixture(), "source.docx"), original = Buffer.from([80, 75, 3, 4, 255, 0]); fs.writeFileSync(target, original);
    const api = service(target), opened = value<{ leaseId: string; revision: string }>(await api.open(1));
    expect(JSON.stringify(opened)).not.toContain(path.dirname(target)); expect(opened).not.toHaveProperty("path");
    const read = value<{ bytes: Uint8Array }>(await api.read(1, { leaseId: opened.leaseId })); expect(read.bytes).toEqual(new Uint8Array(original)); read.bytes.fill(0); expect(fs.readFileSync(target)).toEqual(original);
    expect(await api.read(2, { leaseId: opened.leaseId })).toMatchObject({ ok: false, error: { code: "access-denied" } });
    expect(await api.read(1, { leaseId: opened.leaseId, path: target })).toMatchObject({ ok: false, error: { code: "invalid-request" } });
  });
  it("defers new Save As creation until write and preserves the selected revision", async () => {
    const target = path.join(fixture(), "new.docx"), api = service(target), opened = value<{ leaseId: string; revision: null }>(await api.saveAs(1, { suggestedName: "new.docx" }));
    expect(opened.revision).toBeNull(); expect(fs.existsSync(target)).toBe(false);
    const bytes = new Uint8Array([1, 2, 3]), saving = api.write(1, { leaseId: opened.leaseId, baseRevision: null, bytes }); bytes.fill(0);
    const saved = value<{ revision: string }>(await saving); expect(saved.revision).toMatch(/^[a-f0-9]{64}$/); expect(fs.readFileSync(target)).toEqual(Buffer.from([1, 2, 3]));
  });
  it("serializes distinct leases for one target and rejects the stale second writer", async () => {
    const target = path.join(fixture(), "source.txt"); fs.writeFileSync(target, "before"); const api = service(target);
    const a = value<{ leaseId: string; revision: string }>(await api.open(1)), b = value<{ leaseId: string; revision: string }>(await api.open(1));
    const results = await Promise.all([api.write(1, { leaseId: a.leaseId, baseRevision: a.revision, bytes: new TextEncoder().encode("winner") }), api.write(1, { leaseId: b.leaseId, baseRevision: b.revision, bytes: new TextEncoder().encode("loser") })]);
    expect(results[0].ok).toBe(true); expect(results[1]).toMatchObject({ ok: false, error: { code: "conflict" } }); expect(fs.readFileSync(target, "utf8")).toBe("winner");
  });
  it("refuses external edits, inode replacements and final-component symlinks", async () => {
    const directory = fixture(), target = path.join(directory, "source.txt"), other = path.join(directory, "other.txt"); fs.writeFileSync(target, "original"); fs.writeFileSync(other, "other");
    const api = service(target), opened = value<{ leaseId: string; revision: string }>(await api.open(1)); fs.writeFileSync(target, "external");
    expect(await api.write(1, { leaseId: opened.leaseId, baseRevision: opened.revision, bytes: new Uint8Array([1]) })).toMatchObject({ ok: false, error: { code: "conflict" } }); expect(fs.readFileSync(target, "utf8")).toBe("external");
    fs.renameSync(target, path.join(directory, "old.txt")); fs.writeFileSync(target, "replacement"); expect(await api.read(1, { leaseId: opened.leaseId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const link = path.join(directory, "link.txt"); fs.symlinkSync(other, link); expect(await service(link).open(1)).toMatchObject({ ok: false, error: { code: "access-denied" } });
  });
  it("refuses symlink and folder replacement after the OS grant", async () => {
    const directory = fixture(), folder = path.join(directory, "chosen"); fs.mkdirSync(folder); const target = path.join(folder, "source.txt"), other = path.join(directory, "other.txt"); fs.writeFileSync(target, "original"); fs.writeFileSync(other, "other");
    const api = service(target), opened = value<{ leaseId: string; revision: string }>(await api.open(1)); fs.renameSync(target, path.join(folder, "old.txt")); fs.symlinkSync(other, target);
    expect(await api.read(1, { leaseId: opened.leaseId })).toMatchObject({ ok: false, error: { code: "access-denied" } }); expect(fs.readFileSync(other, "utf8")).toBe("other");
    fs.unlinkSync(target); fs.renameSync(folder, path.join(directory, "old-folder")); fs.mkdirSync(folder); fs.writeFileSync(target, "replacement folder file");
    expect(await api.read(1, { leaseId: opened.leaseId })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
  it.each(["rtf", "odt", "wd"])("saves native .%s bytes only through its exact owner and source revision", async (extension) => {
    const target = path.join(fixture(), `source.${extension}`); fs.writeFileSync(target, "original");
    const api = service(target), opened = value<{ leaseId: string; revision: string; writable: boolean }>(await api.open(1));
    expect(opened.writable).toBe(true);
    expect(await api.write(2, { leaseId: opened.leaseId, baseRevision: opened.revision, bytes: new TextEncoder().encode("foreign") })).toMatchObject({ ok: false, error: { code: "access-denied" } });
    expect(fs.readFileSync(target, "utf8")).toBe("original");
    const saved = value<{ revision: string }>(await api.write(1, { leaseId: opened.leaseId, baseRevision: opened.revision, bytes: new TextEncoder().encode("same-format bytes") }));
    expect(fs.readFileSync(target, "utf8")).toBe("same-format bytes");
    expect(saved.revision).not.toBe(opened.revision);
    expect(await api.write(1, { leaseId: opened.leaseId, baseRevision: opened.revision, bytes: new Uint8Array([1]) })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
  it.each(["doc", "html"])("keeps .%s source leases read-only", async (extension) => {
    const target = path.join(fixture(), `source.${extension}`); fs.writeFileSync(target, "source"); const api = service(target), opened = value<{ leaseId: string; revision: string; writable: boolean }>(await api.open(1));
    expect(opened.writable).toBe(false); expect(await api.write(1, { leaseId: opened.leaseId, baseRevision: opened.revision, bytes: new Uint8Array([1]) })).toMatchObject({ ok: false, error: { code: "access-denied" } }); expect(fs.readFileSync(target, "utf8")).toBe("source");
  });
  it("preserves existing files and cleans staged bytes after a commit failure", async () => {
    const directory = fixture(), target = path.join(directory, "source.txt"); fs.writeFileSync(target, "original");
    const io = { ...fs, renameSync() { throw new Error("synthetic disk failure"); } };
    const api = service(target, { fileSystem: io }), opened = value<{ leaseId: string; revision: string }>(await api.open(1));
    expect(await api.write(1, { leaseId: opened.leaseId, baseRevision: opened.revision, bytes: new Uint8Array([1]) })).toMatchObject({ ok: false, error: { code: "io-error" } }); expect(fs.readFileSync(target, "utf8")).toBe("original"); expect(fs.readdirSync(directory)).toEqual(["source.txt"]);
  });
  it("never clobbers a file appearing at a previously absent Save As target", async () => {
    const directory = fixture(), target = path.join(directory, "new.txt"), io = { ...fs, writeFileSync(name: string, data: Uint8Array, options: unknown) { fs.writeFileSync(name, data, options as fs.WriteFileOptions); if (name.includes(".markie-")) fs.writeFileSync(target, "external winner"); } };
    const api = service(target, { fileSystem: io }), opened = value<{ leaseId: string }>(await api.saveAs(1, { suggestedName: "new.txt" }));
    expect(await api.write(1, { leaseId: opened.leaseId, baseRevision: null, bytes: new Uint8Array([1]) })).toMatchObject({ ok: false, error: { code: "conflict" } }); expect(fs.readFileSync(target, "utf8")).toBe("external winner"); expect(fs.readdirSync(directory)).toEqual(["new.txt"]);
  });
  it("rechecks existing-file content after staging, immediately before final replace", async () => {
    const directory = fixture(), target = path.join(directory, "source.txt"); fs.writeFileSync(target, "original");
    const io = { ...fs, writeFileSync(name: string, data: Uint8Array, options: unknown) { fs.writeFileSync(name, data, options as fs.WriteFileOptions); if (name.includes(".markie-")) fs.writeFileSync(target, "external after staging"); } };
    const api = service(target, { fileSystem: io }), opened = value<{ leaseId: string; revision: string }>(await api.open(1));
    expect(await api.write(1, { leaseId: opened.leaseId, baseRevision: opened.revision, bytes: new Uint8Array([1]) })).toMatchObject({ ok: false, error: { code: "conflict" } }); expect(fs.readFileSync(target, "utf8")).toBe("external after staging"); expect(fs.readdirSync(directory)).toEqual(["source.txt"]);
  });
  it("returns cancellations without grants and invalidates in-flight dialogs on window release", async () => {
    const target = path.join(fixture(), "source.txt"); fs.writeFileSync(target, "source");
    const canceled = service(target, { dialog: { async showOpenDialog() { return { canceled: true }; }, async showSaveDialog() { return { canceled: true }; } } }); expect(value(await canceled.open(1))).toBeNull(); expect(value(await canceled.saveAs(1, { suggestedName: "new.txt" }))).toBeNull();
    let complete: ((value: unknown) => void) | undefined;
    const delayed = service(target, { dialog: { showOpenDialog: () => new Promise((resolve) => { complete = resolve; }) } }); const opening = delayed.open(1); await new Promise<void>((resolve) => setImmediate(resolve)); delayed.releaseOwner(1); complete!({ canceled: false, filePaths: [target] }); expect(value(await opening)).toBeNull();
  });
  it("bounds read bytes, retained leases and queued OS opens with FIFO handoff", async () => {
    const directory = fixture(), first = path.join(directory, "a.docx"), second = path.join(directory, "b.json"); fs.writeFileSync(first, "a"); fs.writeFileSync(second, "b"); const api = service(first, { maxLeases: 1, maxQueued: 2 });
    expect(api.queueOsFile(first).ok).toBe(true); expect(api.queueOsFile(second).ok).toBe(true); expect(api.queueOsFile(first)).toMatchObject({ ok: false, error: { code: "limit-exceeded" } });
    const one = value<{ leaseId: string; name: string }>(await api.takeInitial(1)); expect(one.name).toBe("a.docx"); expect(await api.takeInitial(1)).toMatchObject({ ok: false, error: { code: "limit-exceeded" } }); value(await api.release(1, { leaseId: one.leaseId })); expect(value<{ name: string }>(await api.takeInitial(1)).name).toBe("b.json");
    expect(await service(first, { maxBytes: 0 }).open(1)).toMatchObject({ ok: false, error: { code: "too-large" } });
  });
  it("rejects sparse files over 32 MiB before reading and rejects untrusted Save As paths", async () => {
    const target = path.join(fixture(), "large.docx"); fs.writeFileSync(target, ""); fs.truncateSync(target, 33 * 1024 * 1024); const api = service(target);
    expect(await api.open(1)).toMatchObject({ ok: false, error: { code: "too-large" } }); expect(fs.statSync(target).size).toBe(33 * 1024 * 1024);
    expect(await api.saveAs(1, { suggestedName: "copy.docx", path: target })).toMatchObject({ ok: false, error: { code: "invalid-request" } });
  });
  it("rejects DataView and signed/clamped/spoofed byte arrays without touching disk", async () => {
    const target = path.join(fixture(), "source.txt"); fs.writeFileSync(target, "original"); const api = service(target), opened = value<{ leaseId: string; revision: string }>(await api.open(1));
    const spoofed = new Int8Array([1]); Object.defineProperty(spoofed, Symbol.toStringTag, { value: "Uint8Array" });
    for (const bytes of [new DataView(new ArrayBuffer(1)), new Uint8ClampedArray([1]), spoofed, new Proxy(new Uint8Array([1]), {})]) expect(await api.write(1, { leaseId: opened.leaseId, baseRevision: opened.revision, bytes })).toMatchObject({ ok: false, error: { code: "too-large" } });
    expect(fs.readFileSync(target, "utf8")).toBe("original");
  });
  it("rejects released queued writes before touching disk and bounds queued operations", async () => {
    const target = path.join(fixture(), "source.txt"); fs.writeFileSync(target, "original"); const api = service(target), opened = value<{ leaseId: string; revision: string }>(await api.open(1));
    const saving = api.write(1, { leaseId: opened.leaseId, baseRevision: opened.revision, bytes: new Uint8Array([1]) }); api.releaseOwner(1);
    expect(await saving).toMatchObject({ ok: false, error: { code: "access-denied" } }); expect(fs.readFileSync(target, "utf8")).toBe("original");
    const next = value<{ leaseId: string }>(await api.open(1)), reads = Array.from({ length: 70 }, () => api.read(1, { leaseId: next.leaseId }));
    const results = await Promise.all(reads); expect(results.filter((r) => r.ok)).toHaveLength(64); expect(results.filter((r) => !r.ok)).toHaveLength(6);
  });
  it("registers all six IPC methods behind the supplied trusted-window gate", async () => {
    const target = path.join(fixture(), "source.txt"); fs.writeFileSync(target, "source"); const api = service(target), handlers = new Map<string, (event: { allowed: boolean }, args?: unknown) => unknown>();
    registerDocumentFileIpc({ handle: (channel: string, fn: (event: { allowed: boolean }, args?: unknown) => unknown) => handlers.set(channel, fn), service: api, ownerForEvent: (event: { allowed: boolean }) => event.allowed ? 1 : null });
    expect(handlers.size).toBe(6); for (const handler of handlers.values()) expect(await handler({ allowed: false })).toMatchObject({ ok: false, error: { code: "access-denied" } }); expect((await handlers.get("document-files:open")!({ allowed: true }) as { ok: boolean }).ok).toBe(true);
  });
  it("finds only extra-format OS launch paths and keeps classic Markdown/TXT/CSV separate", () => {
    const target = path.join(fixture(), "source.docx"); fs.writeFileSync(target, "source"); expect(findNativeDocumentLaunchFile(["Markie", pathToFileURL(target).href])).toBe(target); expect(findNativeDocumentLaunchFile(["/notes/classic.md", "/notes/classic.txt", "/notes/table.csv"], { existsSync: () => true })).toBeNull();
  });
  it("routes Darkmown OS opens and drops through opaque grants while preserving literal source bytes", async () => {
    const target = path.join(fixture(), "Counter.WD"), source = Buffer.from([255, 254, 58, 0, 115, 0, 13, 0, 10, 0]);
    fs.writeFileSync(target, source);
    expect(findNativeDocumentLaunchFile(["Markie", pathToFileURL(target).href])).toBe(target);
    const api = service(target);
    expect(api.queueOsFile(target)).toEqual({ ok: true, value: true });
    const opened = value<{ leaseId: string; writable: boolean }>(await api.takeInitial(1));
    expect(opened.writable).toBe(true);
    expect(value<{ bytes: Uint8Array }>(await api.read(1, { leaseId: opened.leaseId })).bytes).toEqual(new Uint8Array(source));
    expect(api.grantDroppedFile(1, target)).toEqual({ ok: true, value: true });
    expect(api.queueDroppedFile(2, target)).toEqual({ ok: true, value: false });
    expect(api.queueDroppedFile(1, target)).toEqual({ ok: true, value: true });
    expect(value<{ name: string }>(await api.takeInitial(1)).name).toBe("Counter.WD");
    expect(fs.readFileSync(target)).toEqual(source);
  });
  it("allows native Darkmown Save As but refuses unrelated project execution files", async () => {
    const target = path.join(fixture(), "Counter.wd"), api = service(target);
    const opened = value<{ leaseId: string; revision: null; writable: boolean }>(await api.saveAs(1, { suggestedName: "Counter.wd" }));
    expect(opened).toMatchObject({ revision: null, writable: true });
    const source = new TextEncoder().encode(':state count = 0\r\n:button "Add" -> count++\r\n');
    value(await api.write(1, { leaseId: opened.leaseId, baseRevision: null, bytes: source }));
    expect(fs.readFileSync(target)).toEqual(Buffer.from(source));
    for (const name of ["Counter.skin", "Counter.wd.js", "Counter.js"]) expect(await api.saveAs(1, { suggestedName: name })).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });
  it.each(["txt", "md", "csv"])("preserves exact UTF-16 BOM/CRLF bytes for explicit active-Documents .%s OS handoff", async (extension) => {
    const target = path.join(fixture(), `source.${extension}`), original = Buffer.from([255, 254, 65, 0, 13, 0, 10, 0]); fs.writeFileSync(target, original); const api = service(target);
    expect(api.queueOsFile(target)).toEqual({ ok: true, value: false }); expect(value(await api.takeInitial(1))).toBeNull();
    expect(api.queueOsFile(target, { includeClassic: true })).toEqual({ ok: true, value: true }); const opened = value<{ leaseId: string }>(await api.takeInitial(1));
    const read = value<{ bytes: Uint8Array }>(await api.read(1, { leaseId: opened.leaseId })); expect(read.bytes).toEqual(new Uint8Array(original)); expect(fs.readFileSync(target)).toEqual(original);
  });
});
