import { describe, expect, it } from "vitest";
import { applyRichOperations, createRichDocument, exportRichDocument, getRichCapabilities, getRichImageBytes, openRichDocument, replaceRichText, sameRichSource } from "./rich-document";
import { createMemoryDocumentLibrary, type LibraryResult } from "../document-library";
import { createDocumentSession, editOfficeDocument, openDocumentSession, serializeDocumentSession } from "../document-session";

function value<T>(result: LibraryResult<T>): T { if (!result.ok) throw new Error(result.error.message); return result.value; }
describe("same-format native rich adapter and recovery", () => {
  it.each(["rtf", "odt"] as const)("opens, edits and exports %s without a disguised DOCX intermediate", async (format) => {
    const document = await createRichDocument(format, "First\nSecond");
    const bytes = await exportRichDocument(document);
    const opened = await openRichDocument(format, bytes);
    expect(opened.format).toBe(format); expect(opened.text).toBe("First\nSecond");
    expect(await exportRichDocument(opened)).toEqual(bytes);
    const edited = applyRichOperations(opened, [{ type: "format-run", runId: opened.paragraphs[0].runs[0].id, style: { bold: true, fontFamily: "Georgia", color: "336699", fontSizePoints: 16 } }, { type: "format-paragraph", paragraphId: opened.paragraphs[0].id, format: { alignment: "center", spacingAfterPoints: 12 } }]);
    const changed = replaceRichText(edited, [{ runId: edited.paragraphs[1].runs[0].id, text: "Updated" }]);
    const saved = await exportRichDocument(changed), reopened = await openRichDocument(format, saved);
    expect(reopened.text).toBe("First\nUpdated");
    expect(reopened.paragraphs[0].runs[0].style).toMatchObject({ bold: true, fontFamily: "Georgia", color: "336699", fontSizePoints: 16 });
    expect(reopened.paragraphs[0]).toMatchObject({ alignment: "center", spacingAfterPoints: 12 });
    expect(format === "rtf" ? new TextDecoder().decode(saved).startsWith("{\\rtf1") : saved[0] === 0x50 && saved[1] === 0x4b).toBe(true);
  });
  it.each(["rtf", "odt"] as const)("keeps %s local record shape/version and same-format recovery", async (format) => {
    const session = await createDocumentSession(format, `letter.${format}`);
    const office = replaceRichText(session.office!, [{ runId: session.office!.paragraphs[0].runs[0].id, text: "Recovered rich text" }]);
    const edited = editOfficeDocument(session, office), bytes = await serializeDocumentSession(edited);
    const library = createMemoryDocumentLibrary({ createId: () => "native-rich" });
    const saved = value(await library.put({ name: edited.name, format, bytes, extractedText: edited.text }, null));
    expect(saved.schemaVersion).toBe(1); expect(saved.format).toBe(format);
    const reopened = await openDocumentSession(value(await library.get(saved.id))!);
    expect(reopened.office?.format).toBe(format); expect(reopened.text).toBe("Recovered rich text"); expect(await serializeDocumentSession(reopened)).toEqual(bytes);
    const second = value(await library.put({ id: saved.id, name: saved.name, format, bytes: await exportRichDocument(await createRichDocument(format, "Other")) }, saved.revision));
    const restored = value(await library.restoreRecovery(saved.id, saved.revision, second.revision));
    expect((await openDocumentSession(restored)).text).toBe("Recovered rich text");
    expect(value(await library.list({ formats: [format] }))).toHaveLength(1);
    expect(() => editOfficeDocument(reopened, { ...office, format: format === "rtf" ? "odt" : "rtf" })).toThrow(/original document format/);
    library.close();
  });
  it.each(["rtf", "odt"] as const)("gates %s unsupported commands in the adapter, not only the UI", async (format) => {
    const doc = await createRichDocument(format, "text");
    expect(getRichCapabilities(doc)).toMatchObject({ runFormatting: true, paragraphFormatting: true, pageLayout: false, review: false, hyperlinks: false, namedStyles: false, tables: false });
    expect(() => applyRichOperations(doc, [{ type: "set-page-layout", layout: { paper: "a4" } }])).toThrow(/does not support/);
    expect(() => applyRichOperations(doc, [{ type: "insert-table", rows: 1, columns: 1 }])).toThrow();
    expect(() => getRichImageBytes(doc, "anything")).toThrow();
    expect(await exportRichDocument(doc)).toEqual(await exportRichDocument(doc));
  });
  it("routes DOCX to its own original package engine unchanged", async () => {
    const doc = await createRichDocument("docx", "Word");
    expect(getRichCapabilities(doc).tables).toBe(true);
    const updated = applyRichOperations(doc, [{ type: "format-run", runId: doc.paragraphs[0].runs[0].id, style: { italic: true } }]);
    expect((await openRichDocument("docx", await exportRichDocument(updated))).paragraphs[0].runs[0].style.italic).toBe(true);
  });
  it("exports and reopens ODT at the joined-text budget, refusing an extra separator atomically", async () => {
    const initial = await createRichDocument("odt", "a".repeat(999_999));
    const boundary = applyRichOperations(initial, [{ type: "insert-paragraph", afterParagraphId: initial.paragraphs[0].id, text: "" }]);
    const bytes = await exportRichDocument(boundary);
    expect((await openRichDocument("odt", bytes)).text).toBe(boundary.text);
    expect(() => applyRichOperations(boundary, [{ type: "insert-paragraph", afterParagraphId: boundary.paragraphs[1].id, text: "" }])).toThrow(/size/);
    expect(await exportRichDocument(boundary)).toEqual(bytes);
    expect(boundary.text.length).toBe(1_000_000); expect(boundary.paragraphs).toHaveLength(2);
  });
  it.each(["rtf", "odt"] as const)("refuses foreign %s source replacement while accepting derived edits and undo", async (format) => {
    const source = await createDocumentSession(format), bytes = await serializeDocumentSession(source);
    const other = await openRichDocument(format, bytes);
    expect(sameRichSource(source.office!, other)).toBe(false);
    expect(() => editOfficeDocument(source, other)).toThrow(/original document session/);
    expect(sameRichSource(source.office!, { ...source.office! })).toBe(false);
    expect(() => editOfficeDocument(source, { ...source.office! })).toThrow(/original document session/);
    const edited = replaceRichText(source.office!, [{ runId: source.office!.paragraphs[0].runs[0].id, text: "Derived" }]);
    expect(sameRichSource(source.office!, edited)).toBe(true);
    const changed = editOfficeDocument(source, edited);
    expect(editOfficeDocument(changed, source.office!).text).toBe(source.text);
    expect(sameRichSource(edited, await createRichDocument(format === "rtf" ? "odt" : "rtf"))).toBe(false);
    expect(await serializeDocumentSession(source)).toEqual(bytes);
  });
});
