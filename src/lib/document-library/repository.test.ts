import { describe, expect, it } from "vitest";
import { createIndexedDbDocumentLibrary, createMemoryDocumentLibrary, queryLibraryRecords, type LibraryPutInput, type LibraryRecord, type LibraryResult } from "./index";
import { createMemoryLibraryStorage } from "./memory";
import { createDocumentLibrary } from "./repository";
import type { LibraryStorageAdapter } from "./storage";

const encode = (text: string) => new TextEncoder().encode(text);
const input = (name = "note.txt", text = "hello"): LibraryPutInput => ({ name, format: "text", bytes: encode(text) });
function value<T>(result: LibraryResult<T>): T { expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error.message); return result.value; }
function library() { let id = 0, time = 100; return createMemoryDocumentLibrary({ createId: () => `doc-${++id}`, now: () => ++time }); }
function recordInput(record: LibraryRecord, text: string): LibraryPutInput { return { id: record.id, name: record.name, format: record.format, tags: record.tags, collection: record.collection, bytes: encode(text) }; }

describe("durable document repository contract with explicit memory adapter", () => {
  it("creates, lists, gets and updates exact immutable bytes and metadata", async () => {
    const repo = library(), bytes = new Uint8Array([0, 255, 13, 10]), tags = ["work"];
    const pending = repo.put({ name: "sample.doc", format: "doc", bytes, tags, collection: "Research", extractedText: "searchable" }, null);
    bytes.fill(9); tags.push("changed");
    const created = value(await pending);
    expect(created).toMatchObject({ schemaVersion: 1, revision: 1, exportedRevision: null, tags: ["work"], collection: "Research" });
    expect(created.bytes).toEqual(new Uint8Array([0, 255, 13, 10]));
    created.bytes.fill(44); (created.tags as string[]).push("mutated");
    const read = value(await repo.get(created.id))!; expect(read.bytes).toEqual(new Uint8Array([0, 255, 13, 10])); expect(read.tags).toEqual(["work"]);
    const updated = value(await repo.put(recordInput(read, "second"), read.revision));
    expect(updated.revision).toBe(2); expect(updated.createdAt).toBe(read.createdAt); expect(updated.updatedAt).toBeGreaterThan(read.updatedAt);
    const listed = value(await repo.list()); listed[0].bytes.fill(0);
    expect(value(await repo.get(read.id))!.bytes).toEqual(encode("second"));
  });
  it("copies Node Buffer inputs without retaining aliased byte storage", async () => {
    const repo = library(), bytes = Buffer.from([1, 2, 3]);
    const saved = repo.put({ ...input(), bytes }, null); bytes.fill(0);
    expect(value(await saved).bytes).toEqual(new Uint8Array([1, 2, 3]));
  });
  it("serializes optimistic compare-and-swap for concurrent saves", async () => {
    const repo = library(), created = value(await repo.put(input(), null));
    const [first, second] = await Promise.all([repo.put(recordInput(created, "winner"), 1), repo.put(recordInput(created, "stale"), 1)]);
    expect(first.ok).toBe(true); expect(second).toMatchObject({ ok: false, error: { code: "conflict", actualRevision: 2 } });
    expect(value(await repo.get(created.id))!.bytes).toEqual(encode("winner"));
  });
  it("requires explicit creation/update revisions and refuses overwrites or stale deletes", async () => {
    const repo = library(), created = value(await repo.put({ ...input(), id: "one" }, null));
    expect(await repo.put({ ...input(), id: "one" }, null)).toMatchObject({ ok: false, error: { code: "conflict", actualRevision: 1 } });
    expect(await repo.put(input(), 1)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await repo.remove(created.id, 2)).toMatchObject({ ok: false, error: { code: "conflict" } });
    value(await repo.remove(created.id, 1)); expect(value(await repo.get(created.id))).toBeNull(); expect(value(await repo.listRecovery(created.id))).toEqual([]);
    expect(await repo.remove(created.id, 1)).toMatchObject({ ok: false, error: { code: "conflict", actualRevision: null } });
  });
  it("keeps recovery distinct from confirmed export state", async () => {
    const repo = library(), first = value(await repo.put(input(), null));
    const exported = value(await repo.markExported(first.id, 1));
    expect(exported).toMatchObject({ revision: 1, exportedRevision: 1, updatedAt: first.updatedAt });
    const second = value(await repo.put(recordInput(first, "second"), 1));
    expect(second).toMatchObject({ revision: 2, exportedRevision: 1 });
    expect(await repo.markExported(first.id, 1)).toMatchObject({ ok: false, error: { code: "conflict" } });
    const history = value(await repo.listRecovery(first.id)); expect(history.map((r) => r.revision)).toEqual([2, 1]);
    history[1].record.bytes.fill(0);
    const restored = value(await repo.restoreRecovery(first.id, 1, 2));
    expect(restored).toMatchObject({ revision: 3, exportedRevision: 1 }); expect(restored.bytes).toEqual(encode("hello"));
    expect(await repo.restoreRecovery(first.id, 1, 2)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await repo.restoreRecovery(first.id, 999, 3)).toMatchObject({ ok: false, error: { code: "not-found" } });
  });
  it("keeps Darkmown source bytes in local records and recovery independently from Markdown", async () => {
    const repo = library(), source = new Uint8Array([0xef, 0xbb, 0xbf, ...encode(":state count = 0\r\n")]);
    const first = value(await repo.put({ name: "Counter.wd", format: "darkmown", bytes: source }, null));
    value(await repo.put({ name: "Counter.md", format: "markdown", bytes: source }, null));
    const edited = value(await repo.put({ id: first.id, name: first.name, format: first.format, bytes: encode(":state count = 1\r\n") }, first.revision));
    expect(value(await repo.list({ formats: ["darkmown"] })).map((record) => record.name)).toEqual(["Counter.wd"]);
    const restored = value(await repo.restoreRecovery(first.id, first.revision, edited.revision));
    expect(restored).toMatchObject({ format: "darkmown", name: "Counter.wd", revision: 3 });
    expect(restored.bytes).toEqual(source);
    expect(value(await repo.listRecovery(first.id)).every((entry) => entry.record.format === "darkmown")).toBe(true);
  });
  it("bounds per-document recovery and restores into a new revision", async () => {
    const repo = createMemoryDocumentLibrary({ createId: () => "one", now: () => 1, limits: { maxRecoveryPerDocument: 2 } });
    let current = value(await repo.put(input(), null));
    for (let i = 0; i < 4; i++) current = value(await repo.put(recordInput(current, `${i}`), current.revision));
    expect(value(await repo.listRecovery("one")).map((r) => r.revision)).toEqual([5, 4]);
    expect(await repo.restoreRecovery("one", 1, 5)).toMatchObject({ ok: false, error: { code: "not-found" } });
  });
  it("evicts old recovery to respect count and total payload budgets, never documents", async () => {
    const repo = createMemoryDocumentLibrary({ createId: () => "one", now: () => 1, limits: { maxTotalBytes: 500, maxRecoveryRecords: 2 } });
    let current = value(await repo.put(input("a", "a"), null));
    for (let i = 0; i < 6; i++) current = value(await repo.put(recordInput(current, "x".repeat(40)), current.revision));
    expect(value(await repo.list())).toHaveLength(1); expect(value(await repo.listRecovery("one")).length).toBeLessThanOrEqual(2);
    const rejected = await repo.put(recordInput(current, "x".repeat(400)), current.revision);
    expect(rejected).toMatchObject({ ok: false, error: { code: "limit-exceeded" } });
    expect(value(await repo.get("one"))!.revision).toBe(current.revision);
  });
  it("enforces record and document-byte limits without partial changes", async () => {
    const repo = createMemoryDocumentLibrary({ limits: { maxRecords: 1, maxDocumentBytes: 5 }, createId: () => "one" });
    value(await repo.put(input(), null));
    expect(await repo.put({ ...input(), id: "two" }, null)).toMatchObject({ ok: false, error: { code: "limit-exceeded" } });
    expect(await repo.put({ ...input("n", "123456"), id: "one" }, 1)).toMatchObject({ ok: false, error: { code: "limit-exceeded" } });
    expect(value(await repo.get("one"))!.revision).toBe(1); expect(value(await repo.listRecovery("one"))).toHaveLength(1);
  });
  it("validates record fields, IDs, revisions, tags and clocks", async () => {
    const repo = library();
    for (const candidate of [input("../escape"), { ...input(), format: "vault" }, { ...input(), tags: ["a", "a"] }, { ...input(), bytes: [1, 2] }, { ...input(), plaintext: "secret" }, { ...input(), collection: "" }]) expect(await repo.put(candidate as LibraryPutInput, null)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await repo.get("../bad")).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await repo.remove("one", 0)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    const clock = createMemoryDocumentLibrary({ now: () => NaN }); expect(await clock.put(input(), null)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  });
  it("refuses corrupt, future-schema and orphan recovery data instead of overwriting it", async () => {
    const good = value(await library().put(input(), null));
    for (const corrupt of [{ ...good, schemaVersion: 2 }, { ...good, revision: -1 }, { ...good, exportedRevision: 2 }, { ...good, updatedAt: -1 }, { ...good, extra: "unrecognized" }, { ...good, bytes: "not bytes" }]) {
      const repo = createDocumentLibrary(createMemoryLibraryStorage({ documents: [corrupt], recovery: [] }));
      expect(await repo.list()).toMatchObject({ ok: false, error: { code: "corrupt-storage" } });
      expect(await repo.put({ ...input(), id: good.id }, 1)).toMatchObject({ ok: false, error: { code: "corrupt-storage" } });
    }
    const orphan = createDocumentLibrary(createMemoryLibraryStorage({ documents: [], recovery: [{ schemaVersion: 1, documentId: good.id, revision: good.revision, savedAt: good.updatedAt, record: good }] }));
    expect(await orphan.list()).toMatchObject({ ok: false, error: { code: "corrupt-storage" } });
  });
  it("rejects mismatched recovery metadata and exhausted revision counters", async () => {
    const good = value(await library().put(input(), null));
    const repo = createDocumentLibrary(createMemoryLibraryStorage({ documents: [good], recovery: [{ schemaVersion: 1, documentId: good.id, revision: 99, savedAt: good.updatedAt, record: good }] }));
    expect(await repo.listRecovery(good.id)).toMatchObject({ ok: false, error: { code: "corrupt-storage" } });
    const exhausted = { ...good, revision: Number.MAX_SAFE_INTEGER };
    const maxed = createDocumentLibrary(createMemoryLibraryStorage({ documents: [exhausted], recovery: [] }));
    expect(await maxed.put(recordInput(exhausted, "new"), exhausted.revision)).toMatchObject({ ok: false, error: { code: "limit-exceeded" } });
    expect(value(await maxed.get(good.id))!.revision).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("keeps timestamps monotonic when the local clock moves backwards", async () => {
    let now = 100; const repo = createMemoryDocumentLibrary({ now: () => now, createId: () => "one" });
    const first = value(await repo.put(input(), null)); now = 1;
    expect(value(await repo.put(recordInput(first, "new"), 1)).updatedAt).toBe(100);
  });
  it("returns explicit asynchronous quota/unavailable failures without a memory fallback", async () => {
    for (const cause of [new DOMException("quota", "QuotaExceededError"), new Error("private failure detail")]) {
      const adapter: LibraryStorageAdapter = { persistence: "indexeddb", execute: async () => { await Promise.resolve(); throw cause; }, close() {} };
      const repo = createDocumentLibrary(adapter), result = await repo.put(input(), null);
      expect(result).toMatchObject({ ok: false, error: { code: cause.name === "QuotaExceededError" ? "storage-quota" : "storage-unavailable" } });
      expect(JSON.stringify(result)).not.toContain("private failure detail"); expect(repo.persistence).toBe("indexeddb");
    }
    expect(await createIndexedDbDocumentLibrary({ indexedDB: null })).toMatchObject({ ok: false, error: { code: "storage-unavailable" } });
  });
  it("rejects operations after close rather than pretending persistence", async () => {
    const repo = library(); repo.close(); expect(await repo.put(input(), null)).toMatchObject({ ok: false, error: { code: "closed" } });
  });
});

describe("pure ordinary-library search, filters and deterministic sorting", () => {
  it("searches extracted text/name/tags/collection and applies all filters", async () => {
    const repo = library();
    value(await repo.put({ ...input("Zoo.json"), format: "json", extractedText: "Blue ocean", tags: ["work", "review"], collection: "Research" }, null));
    value(await repo.put({ ...input("Alpha.txt"), tags: ["work"], extractedText: "Green" }, null));
    value(await repo.put({ ...input("Beta.csv"), format: "csv", collection: "Research", tags: ["review"] }, null));
    expect(value(await repo.list({ search: "BLUE research", tags: ["review", "work"], formats: ["json"], collection: "Research" })).map((r) => r.name)).toEqual(["Zoo.json"]);
    expect(value(await repo.list({ collection: null })).map((r) => r.name)).toEqual(["Alpha.txt"]);
    expect(value(await repo.list({ sortBy: "name" })).map((r) => r.name)).toEqual(["Alpha.txt", "Beta.csv", "Zoo.json"]);
    expect(value(await repo.list({ sortBy: "name", sortDirection: "desc" })).map((r) => r.name)).toEqual(["Zoo.json", "Beta.csv", "Alpha.txt"]);
    expect(value(await repo.list()).map((r) => r.name)).toEqual(["Beta.csv", "Alpha.txt", "Zoo.json"]);
    expect(await repo.list({ sortBy: "bad" } as never)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  });
  it("has stable ID tie-breaks and never mutates the source array or record bytes", async () => {
    const repo = createMemoryDocumentLibrary({ now: () => 1 });
    const b = value(await repo.put({ ...input("same"), id: "b" }, null)), a = value(await repo.put({ ...input("same"), id: "a" }, null));
    const original = [b, a], queried = queryLibraryRecords(original, { sortBy: "name", sortDirection: "desc" });
    expect(queried.map((r) => r.id)).toEqual(["a", "b"]); expect(original.map((r) => r.id)).toEqual(["b", "a"]);
    queried[0].bytes.fill(0); expect(a.bytes).toEqual(encode("hello"));
  });
});
