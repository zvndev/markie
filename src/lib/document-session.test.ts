import { describe, expect, it } from "vitest";
import { acceptDocumentPersistence, createDocumentSession, documentNeedsRecoverySave, editDocumentDetails, editDocumentText, openDocumentSession, preserveDocumentNewlines, restoreDocumentText, serializeDocumentSession } from "./document-session";
import { decodeTextDocument, encodeTextDocument } from "./document-formats";
import type { LibraryRecord } from "./document-library";

describe("shared document sessions", () => {
  it.each([
    ["a\r\nb\r\n", "a\nb\n", "a\r\nb\r\n"],
    ["a\r\nb\r\n", "a\nb changed\n", "a\r\nb changed\r\n"],
    ["a\r\nb\nc\r", "a\nb\nc\n", "a\r\nb\nc\r"],
    ["a\r\nb\nc\r", "a\ninsert\nb\nc\n", "a\r\ninsert\r\nb\nc\r"],
    ["a\r\nb\nc\r", "a\nb changed\nc\n", "a\r\nb changed\nc\r"],
    ["", "hello\n", "hello\n"],
  ])("preserves unaffected separators while editing %j", (before, input, expected) => {
    expect(preserveDocumentNewlines(before, input)).toBe(expected);
  });

  it("creates literal text and exports exactly what was typed", async () => {
    const session = editDocumentText(await createDocumentSession("text"), "# not a heading\n");
    expect(new TextDecoder().decode(await serializeDocumentSession(session))).toBe("# not a heading\n");
    expect(documentNeedsRecoverySave(session)).toBe(true);
  });

  it("creates Darkmown source as .wd without converting its directives", async () => {
    const source = ':state count = 0\n\n:button "Add one" -> count++\n';
    const session = editDocumentText(await createDocumentSession("darkmown"), source);
    expect(session).toMatchObject({ name: "Untitled.wd", format: "darkmown", text: source, office: null });
    expect(decodeTextDocument(await serializeDocumentSession(session)).text).toBe(source);
    expect(editDocumentDetails(session, { name: "Counter" }).name).toBe("Counter.wd");
    expect(() => editDocumentDetails(session, { name: "Counter.md" })).toThrow(/file type/);
  });

  it.each(["utf-8", "utf-16le", "utf-16be"] as const)("preserves %s Darkmown BOM and mixed source separators through edits and undo", async (encoding) => {
    const source = '# Counter\r\n\r\n:state count = 0\nCount: { count }.\r';
    const bytes = encodeTextDocument(source, { encoding, bom: true });
    const record: LibraryRecord = { schemaVersion: 1, id: "counter", name: "Counter.wd", format: "darkmown", bytes, tags: [], collection: null, revision: 1, exportedRevision: 1, createdAt: 1, updatedAt: 1 };
    const opened = await openDocumentSession(record);
    expect(opened.office).toBeNull();
    expect(await serializeDocumentSession(opened)).toEqual(bytes);
    const edited = editDocumentText(opened, source.replace(/\r\n?/g, "\n").replace("count = 0", "count = 2"));
    expect(decodeTextDocument(await serializeDocumentSession(edited))).toMatchObject({ text: source.replace("count = 0", "count = 2"), encoding, bom: true, newline: "mixed" });
    expect(await serializeDocumentSession(restoreDocumentText(edited, source))).toEqual(bytes);
    expect(documentNeedsRecoverySave(edited)).toBe(true);
  });

  it("preserves UTF-16 BOM and CRLF on open/edit/export", async () => {
    const record = { schemaVersion: 1, id: "one", name: "notes.txt", format: "text", bytes: encodeTextDocument("one\r\ntwo", { encoding: "utf-16be", bom: true }), tags: [], collection: null, revision: 1, exportedRevision: 1, createdAt: 1, updatedAt: 1 } as LibraryRecord;
    const session = editDocumentText(await openDocumentSession(record), "one\ntwo edited");
    expect(decodeTextDocument(await serializeDocumentSession(session))).toMatchObject({ text: "one\r\ntwo edited", encoding: "utf-16be", bom: true });
  });
  it("restores exact mixed source separators during undo without changing encoding", async () => {
    const text = "one\r\ntwo\nthree\r";
    const record = { schemaVersion: 1, id: "history", name: "notes.txt", format: "text", bytes: encodeTextDocument(text, { encoding: "utf-16le", bom: true }), tags: [], collection: null, revision: 1, exportedRevision: 1, createdAt: 1, updatedAt: 1 } as LibraryRecord;
    const session = await openDocumentSession(record);
    const edited = editDocumentText(session, "replacement\n");
    const restored = restoreDocumentText(edited, text);
    expect(decodeTextDocument(await serializeDocumentSession(restored))).toMatchObject({ text, encoding: "utf-16le", bom: true });
    expect(restored.generation).toBe(2);
    expect(() => restoreDocumentText(restored, "bad\u0000text")).toThrow();
  });

  it("does not mark edits made during a save as recovered", async () => {
    const start = await createDocumentSession("text");
    const saved = editDocumentText(start, "saved");
    const newer = editDocumentText(saved, "newer");
    const record = { id: start.id, revision: 1 } as LibraryRecord;
    const result = acceptDocumentPersistence(newer, saved, record);
    expect(result.text).toBe("newer");
    expect(result.record?.revision).toBe(1);
    expect(documentNeedsRecoverySave(result)).toBe(true);
    expect(acceptDocumentPersistence(newer, { ...saved, id: "other" }, record)).toBe(newer);
  });

  it("deduplicates tags and tracks metadata edits", async () => {
    const session = editDocumentDetails(await createDocumentSession("text"), { tags: [" draft ", "draft", ""], collection: " Personal " });
    expect(session.tags).toEqual(["draft"]);
    expect(session.collection).toBe("Personal");
    expect(session.generation).toBe(1);
  });

  it("keeps the file type when renaming and rejects disguised format conversion", async () => {
    const session = await createDocumentSession("docx");
    expect(editDocumentDetails(session, { name: "My report" }).name).toBe("My report.docx");
    expect(() => editDocumentDetails(session, { name: "My report.txt" })).toThrow(/file type/);
    expect(() => editDocumentDetails(session, { name: "../My report.docx" })).toThrow(/file type/);
  });

  it("never regresses an accepted generation or record revision on a late save", async () => {
    const start = await createDocumentSession("text");
    const old = editDocumentText(start, "old");
    const newer = editDocumentText(old, "newer");
    const accepted = acceptDocumentPersistence(newer, newer, { id: start.id, revision: 3 } as LibraryRecord);
    expect(acceptDocumentPersistence(accepted, old, { id: start.id, revision: 2 } as LibraryRecord)).toBe(accepted);
    expect(acceptDocumentPersistence(accepted, old, { id: start.id, revision: 4 } as LibraryRecord)).toBe(accepted);
    expect(acceptDocumentPersistence({ ...newer, epoch: "reopened" }, newer, { id: start.id, revision: 4 } as LibraryRecord).record).toBeNull();
  });
});
