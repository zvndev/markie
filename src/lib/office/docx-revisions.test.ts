import { describe, expect, it } from "vitest";
import { applyDocxOperations, createDocx, exportDocx, openDocx, replaceDocxText } from "./docx";
import { readZip, writeZip } from "./zip";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
async function mainXml(doc: Awaited<ReturnType<typeof createDocx>>) {
  return decoder.decode((await readZip(await exportDocx(doc))).find((p) => p.name === "word/document.xml")!.data);
}
async function incoming(content: string) {
  const parts = await readZip(await exportDocx(await createDocx("Baseline")));
  const main = parts.find((p) => p.name === "word/document.xml")!;
  main.data = encoder.encode(`<w:document xmlns:w="${W}"><w:body>${content}</w:body></w:document>`);
  return writeZip(parts);
}
const attrs = 'w:id="1" w:author="Reviewer" w:date="2026-10-15T05:00:00Z"';

describe("original paragraph text revision engine", () => {
  it("writes genuine authored/datetime deletion and insertion ranges with final/original views", async () => {
    const original = await createDocx("Original 😀\nOther paragraph");
    const doc = applyDocxOperations(original, [{ type: "track-paragraph-text", paragraphId: "p0", text: "Replacement <&>", author: 'Writer "A"' }]);
    expect(doc.text).toBe("Replacement <&>\nOther paragraph");
    expect(doc.originalText).toBe(original.text);
    expect(doc.revisions.map((r) => [r.type, r.text, r.author])).toEqual([["deletion", "Original 😀", 'Writer "A"'], ["insertion", "Replacement <&>", 'Writer "A"']]);
    expect(new Set(doc.revisions.map((r) => r.id)).size).toBe(2);
    expect(doc.revisions.every((r) => r.date.match(/^\d{4}-\d{2}-\d{2}T/))).toBe(true);
    expect(doc.paragraphs[0].revisionIds).toHaveLength(2);
    const xml = await mainXml(doc);
    expect(xml).toContain("<w:del "); expect(xml).toContain("<w:delText"); expect(xml).toContain("Original 😀"); expect(xml).toContain("<w:ins ");
    const saved = await openDocx(await exportDocx(doc));
    expect(saved.canEdit).toBe(true);
    expect(saved.text).toBe(doc.text);
    expect(saved.originalText).toBe(original.text);
    expect(saved.revisions).toEqual(doc.revisions);
    expect(original.revisions).toHaveLength(0);
  });

  it("preserves deleted direct run formatting, paragraph properties and portable comments", async () => {
    const original = applyDocxOperations(await createDocx("Bold plain"), [
      { type: "format-range", paragraphId: "p0", start: 0, end: 4, style: { bold: true, color: "123456" } },
      { type: "format-paragraph", paragraphId: "p0", format: { alignment: "center", spacingAfterPoints: 12 } },
      { type: "add-comment", paragraphId: "p0", author: "C", text: "Comment stays" },
    ]);
    const doc = applyDocxOperations(original, [{ type: "track-paragraph-text", paragraphId: "p0", text: "New text", author: "R" }]);
    expect(doc.comments[0].text).toBe("Comment stays");
    expect(doc.paragraphs[0]).toMatchObject({ originalText: "Bold plain", text: "New text", alignment: "center", spacingAfterPoints: 12 });
    expect(doc.paragraphs[0].originalRuns?.filter((r) => r.text).map((r) => [r.text, r.style.bold])).toEqual([["Bold", true], [" plain", undefined]]);
    const rejected = applyDocxOperations(doc, [{ type: "reject-all-revisions" }]);
    const saved = await openDocx(await exportDocx(rejected));
    expect(saved.text).toBe(original.text);
    expect(saved.revisions).toHaveLength(0);
    expect(saved.comments[0].text).toBe("Comment stays");
    expect(saved.paragraphs[0].runs.filter((r) => r.text).map((r) => [r.text, r.style.bold])).toEqual([["Bold", true], [" plain", undefined]]);
  });

  it("accepts all ranges by deleting old text/provenance and keeping insertion text", async () => {
    const original = await createDocx("OLD PRIVATE TEXT");
    const tracked = applyDocxOperations(original, [{ type: "track-paragraph-text", paragraphId: "p0", text: "Final", author: "Revision Author" }]);
    const accepted = applyDocxOperations(tracked, [{ type: "accept-all-revisions" }]);
    const xml = await mainXml(accepted);
    expect(xml).not.toContain("OLD PRIVATE TEXT"); expect(xml).not.toContain("Revision Author"); expect(xml).not.toContain("delText");
    expect(xml).not.toMatch(/<w:(?:del|ins)[\x20>]/);
    const saved = await openDocx(await exportDocx(accepted));
    expect(saved.text).toBe("Final"); expect(saved.originalText).toBe("Final"); expect(saved.revisions).toHaveLength(0);
    expect(tracked.originalText).toBe("OLD PRIVATE TEXT"); // Immutable undo, not exported hidden data.
  });

  it("supports accept/reject one range with genuine individual Word semantics", async () => {
    const tracked = applyDocxOperations(await createDocx("Old"), [{ type: "track-paragraph-text", paragraphId: "p0", text: "New", author: "R" }]);
    const deletion = tracked.revisions.find((r) => r.type === "deletion")!;
    const insertion = tracked.revisions.find((r) => r.type === "insertion")!;
    const rejectDeletion = applyDocxOperations(tracked, [{ type: "reject-revision", revisionId: deletion.id }]);
    expect(rejectDeletion.text).toBe("OldNew");
    expect(rejectDeletion.revisions.map((r) => r.id)).toEqual([insertion.id]);
    expect((await openDocx(await exportDocx(applyDocxOperations(rejectDeletion, [{ type: "accept-revision", revisionId: insertion.id }])))).text).toBe("OldNew");
    const acceptDeletion = applyDocxOperations(tracked, [{ type: "accept-revision", revisionId: deletion.id }]);
    const rejectInsertion = applyDocxOperations(acceptDeletion, [{ type: "reject-revision", revisionId: insertion.id }]);
    expect((await openDocx(await exportDocx(rejectInsertion))).text).toBe("");
  });

  it("coalesces continuous same-author typing without nested revisions or losing original text", async () => {
    const original = await createDocx("Original");
    let doc = applyDocxOperations(original, [{ type: "track-paragraph-text", paragraphId: "p0", text: "N", author: "R" }]);
    const ids = doc.revisions.map((r) => r.id);
    for (const text of ["Ne", "New", "New text"]) doc = applyDocxOperations(doc, [{ type: "track-paragraph-text", paragraphId: "p0", text, author: "R" }]);
    expect(doc.revisions.map((r) => r.id)).toEqual(ids);
    expect(doc.originalText).toBe("Original"); expect(doc.text).toBe("New text");
    expect(() => applyDocxOperations(doc, [{ type: "track-paragraph-text", paragraphId: "p0", text: "Other author", author: "Someone else" }])).toThrow(/Resolve/);
    expect((await openDocx(await exportDocx(doc))).revisions).toHaveLength(2);
  });

  it("tracks insertion-only/deletion-only edits and keeps empty comment anchors inspectable", async () => {
    const empty = await createDocx("");
    const inserted = applyDocxOperations(empty, [{ type: "track-paragraph-text", paragraphId: "p0", text: "Inserted", author: "R" }]);
    expect(inserted.revisions.map((r) => r.type)).toEqual(["insertion"]);
    expect(inserted.originalText).toBe("");
    expect((await openDocx(await exportDocx(applyDocxOperations(inserted, [{ type: "reject-all-revisions" }])))).text).toBe("");
    const original = applyDocxOperations(await createDocx("Delete me"), [{ type: "add-comment", paragraphId: "p0", text: "Anchor", author: "C" }]);
    const deleted = applyDocxOperations(original, [{ type: "track-paragraph-text", paragraphId: "p0", text: "", author: "R" }]);
    expect(deleted.revisions.map((r) => r.type)).toEqual(["deletion"]);
    expect(deleted.comments).toHaveLength(1);
    const saved = await openDocx(await exportDocx(applyDocxOperations(deleted, [{ type: "accept-all-revisions" }])));
    expect(saved.text).toBe(""); expect(saved.comments).toHaveLength(1); expect(saved.canEdit).toBe(true);
  });

  it("coalesces insertion back to an originally empty formatted/commented paragraph safely", async () => {
    const original = applyDocxOperations(await createDocx(""), [{ type: "format-run", runId: "p0:r0", style: { bold: true } }, { type: "add-comment", paragraphId: "p0", author: "C", text: "Point comment" }]);
    const typed = applyDocxOperations(original, [{ type: "track-paragraph-text", paragraphId: "p0", text: "Typed", author: "R" }]);
    const emptied = applyDocxOperations(typed, [{ type: "track-paragraph-text", paragraphId: "p0", text: "", author: "R" }]);
    const saved = await openDocx(await exportDocx(emptied));
    expect(saved.text).toBe(""); expect(saved.comments).toHaveLength(1); expect(saved.revisions).toHaveLength(0); expect(saved.paragraphs[0].runs[0].style.bold).toBe(true);
    const typedAgain = applyDocxOperations(emptied, [{ type: "track-paragraph-text", paragraphId: "p0", text: "Again", author: "R" }]);
    expect(typedAgain.revisions[0].id).not.toBe(typed.revisions[0].id);
  });

  it("rejects untracked destruction and revision edits through ordinary run/paragraph APIs", async () => {
    const doc = applyDocxOperations(await createDocx("Old\nOther"), [{ type: "track-paragraph-text", paragraphId: "p0", text: "New", author: "R" }]);
    const id = doc.paragraphs[0].runs[0].id;
    expect(() => replaceDocxText(doc, [{ runId: id, text: "Flatten" }])).toThrow();
    expect(() => applyDocxOperations(doc, [{ type: "replace-paragraph", paragraphId: "p0", text: "Flatten" }])).toThrow(/Resolve/);
    expect(() => applyDocxOperations(doc, [{ type: "delete-paragraph", paragraphId: "p0" }])).toThrow(/Resolve/);
    expect(() => applyDocxOperations(doc, [{ type: "format-range", paragraphId: "p0", start: 0, end: 1, style: { bold: true } }])).toThrow(/Resolve/);
    const other = applyDocxOperations(doc, [{ type: "replace-paragraph", paragraphId: "p1", text: "Other edited" }]);
    expect((await openDocx(await exportDocx(other))).revisions).toHaveLength(2);
  });

  it.each([
    `<w:p><w:ins ${attrs}><w:ins w:id="2" w:author="R" w:date="2026-10-15T05:00:00Z"><w:r><w:t>N</w:t></w:r></w:ins></w:ins></w:p>`,
    `<w:p><w:del ${attrs}><w:r><w:t>Wrong text kind</w:t></w:r></w:del></w:p>`,
    `<w:p><w:r><w:delText>Orphan</w:delText></w:r></w:p>`,
    `<w:p><w:rPr><w:del ${attrs}/></w:rPr><w:r><w:t>A</w:t></w:r></w:p>`,
    `<w:p><w:moveFrom ${attrs}><w:r><w:t>Move</w:t></w:r></w:moveFrom></w:p>`,
    `<w:p><w:ins ${attrs.replace('w:date="2026-10-15T05:00:00Z"', 'w:date="2026-02-30T05:00:00Z"')}><w:r><w:t>Bad date</w:t></w:r></w:ins></w:p>`,
    `<w:p><w:ins ${attrs.replace('w:id="1"', 'w:id="01"')}><w:r><w:t>Bad ID</w:t></w:r></w:ins></w:p>`,
    `<w:p><w:ins ${attrs}><w:r><w:t>A</w:t></w:r></w:ins><w:ins ${attrs}><w:r><w:t>B</w:t></w:r></w:ins></w:p>`,
    `<w:p><w:ins ${attrs.replace(' w:author="Reviewer"', '')}><w:r><w:t>Missing author</w:t></w:r></w:ins></w:p>`,
  ])("keeps unsupported/unsafe incoming revision combinations read-only and byte-identical", async (body) => {
    const bytes = await incoming(body);
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(false);
    expect(await exportDocx(doc)).toEqual(bytes);
    expect(() => applyDocxOperations(doc, [{ type: "accept-all-revisions" }])).toThrow(/safely/);
  });

  it("imports simple partial insertion/deletion ranges for individual review without flattening", async () => {
    const bytes = await incoming(`<w:p><w:r><w:t>Before </w:t></w:r><w:del ${attrs}><w:r><w:delText>Old</w:delText></w:r></w:del><w:ins ${attrs.replace('w:id="1"', 'w:id="2"')}><w:r><w:t>New</w:t></w:r></w:ins><w:r><w:t> after</w:t></w:r></w:p>`);
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(true); expect(doc.text).toBe("Before New after"); expect(doc.originalText).toBe("Before Old after");
    expect(await exportDocx(doc)).toEqual(bytes);
    expect(() => applyDocxOperations(doc, [{ type: "track-paragraph-text", paragraphId: "p0", text: "Whole replacement", author: "Reviewer" }])).toThrow(/Resolve/);
    expect((await openDocx(await exportDocx(applyDocxOperations(doc, [{ type: "reject-all-revisions" }])))).text).toBe("Before Old after");
  });

  it("preserves namespace bindings local to imported wrappers through review and coalescing", async () => {
    const bytes = await incoming(`<w:p><q:del xmlns:q="${W}" q:id="1" q:author="Reviewer" q:date="2026-10-15T05:00:00Z"><q:r><q:rPr><q:b/></q:rPr><q:delText>Old</q:delText></q:r></q:del><q:ins xmlns:q="${W}" q:id="2" q:author="Reviewer" q:date="2026-10-15T05:00:00Z"><q:r><q:t>New</q:t></q:r></q:ins></w:p>`);
    const original = await openDocx(bytes);
    expect(original.canEdit).toBe(true);
    const coalesced = applyDocxOperations(original, [{ type: "track-paragraph-text", paragraphId: "p0", text: "Newest", author: "Reviewer" }]);
    expect((await openDocx(await exportDocx(coalesced))).text).toBe("Newest");
    const rejected = await openDocx(await exportDocx(applyDocxOperations(original, [{ type: "reject-all-revisions" }])));
    expect(rejected.text).toBe("Old"); expect(rejected.paragraphs[0].runs[0].style.bold).toBe(true);
    expect((await openDocx(await exportDocx(applyDocxOperations(original, [{ type: "accept-all-revisions" }])))).text).toBe("New");
  });
});
