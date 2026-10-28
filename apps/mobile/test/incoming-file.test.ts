// Files handed to Markie by Mail, AirDrop or Files: which URLs count, what the
// file is called, and what each kind turns into.
import { describe, expect, it } from "vitest";
import { createDocx, exportDocx } from "@/lib/office/docx";
import { decodeIncomingFile, docxToMarkdown, IncomingFileError, isIncomingFileUrl, nameFromFileUrl, readIncomingFile } from "../src/lib/incoming-file";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("incoming file URLs", () => {
  it("are file:// and content:// URLs, never links", () => {
    expect(isIncomingFileUrl("file:///private/var/mobile/Containers/Data/Application/X/Documents/Inbox/Plan.md")).toBe(true);
    expect(isIncomingFileUrl("content://com.google.android.gm.sapi/attachment/1")).toBe(true);
    expect(isIncomingFileUrl("https://markiedocs.com/d/abc")).toBe(false);
    expect(isIncomingFileUrl("markie-mobile://d/abc")).toBe(false);
  });

  it("name the file from its URL", () => {
    expect(nameFromFileUrl("file:///var/Inbox/Trip%20plan.md")).toBe("Trip plan.md");
    expect(nameFromFileUrl("content://media/external/file/1234")).toBe("Shared file");
    expect(nameFromFileUrl("file:///var/Inbox/%2E%2E%2Fescape.md")).toBe(".. escape.md");
  });
});

describe("decoding what arrives", () => {
  it("keeps text files as they are", async () => {
    expect(await decodeIncomingFile("Plan.md", bytes("# Plan\n"))).toEqual({ name: "Plan.md", format: "markdown", content: "# Plan\n", convertedFrom: null });
    expect(await decodeIncomingFile("budget.csv", bytes("a,b\n"))).toMatchObject({ format: "text", content: "a,b\n" });
    expect(await decodeIncomingFile("Counter.wd", bytes(":state n = 0\n"))).toMatchObject({ format: "darkmown" });
    expect(await decodeIncomingFile("notes", bytes("hello"))).toMatchObject({ name: "notes.txt", format: "text" });
  });

  it("turns a Word document into Markdown", async () => {
    const docx = await exportDocx(await createDocx("First paragraph\nSecond paragraph"));
    const file = await decodeIncomingFile("Report.docx", docx);
    expect(file).toMatchObject({ name: "Report.md", format: "markdown", convertedFrom: "Word" });
    expect(file.content).toContain("First paragraph");
    expect(file.content).toContain("Second paragraph");
  });

  it("writes Word headings, lists and tables as Markdown", () => {
    const paragraph = (id: string, text: string, extra: object = {}) => ({ id, text, runs: [], ...extra });
    const markdown = docxToMarkdown({
      text: "",
      paragraphs: [paragraph("p1", "Title", { styleId: "Heading1" }), paragraph("p2", "One", { listKind: "bullet" }), paragraph("p3", "Two", { listKind: "bullet" }), paragraph("p4", "Body")],
      tables: [{ id: "t1", rows: [{ cells: [{ paragraphs: [paragraph("c1", "A")] }, { paragraphs: [paragraph("c2", "B")] }] }, { cells: [{ paragraphs: [paragraph("c3", "1")] }, { paragraphs: [paragraph("c4", "2")] }] }] }],
      blocks: [{ kind: "paragraph", paragraphId: "p1" }, { kind: "paragraph", paragraphId: "p2" }, { kind: "paragraph", paragraphId: "p3" }, { kind: "table", tableId: "t1" }, { kind: "paragraph", paragraphId: "p4" }],
    } as never);
    expect(markdown).toBe("# Title\n\n- One\n- Two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nBody\n");
  });

  it("reads bullets typed as characters, and never indents a paragraph into code", () => {
    const paragraph = (id: string, text: string, extra: object = {}) => ({ id, text, runs: [], ...extra });
    const markdown = docxToMarkdown({
      text: "",
      paragraphs: [paragraph("p1", "Report", { styleId: "Heading 2" }), paragraph("p2", "\t•\tNorth"), paragraph("p3", "\t•\tSouth"), paragraph("p4", "    Indented text")],
      tables: [],
      blocks: ["p1", "p2", "p3", "p4"].map((paragraphId) => ({ kind: "paragraph", paragraphId })),
    } as never);
    expect(markdown).toBe("## Report\n\n- North\n- South\n\nIndented text\n");
  });

  it("turns RTF into a text copy", async () => {
    const file = await decodeIncomingFile("Letter.rtf", bytes("{\\rtf1\\ansi Hello from RTF\\par}"));
    expect(file).toMatchObject({ name: "Letter.txt", format: "text", convertedFrom: "RTF" });
    expect(file.content).toContain("Hello from RTF");
  });

  it("refuses binaries, old Word files and oversized files with a sentence", async () => {
    await expect(decodeIncomingFile("photo.md", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]))).rejects.toBeInstanceOf(IncomingFileError);
    await expect(decodeIncomingFile("old.doc", new Uint8Array([1]))).rejects.toThrow(/\.docx/);
    await expect(decodeIncomingFile("big.md", new Uint8Array(17 * 1024 * 1024))).rejects.toThrow(/too large/);
  });

  it("says so when the file can't be read at all", async () => {
    await expect(readIncomingFile("file:///gone.md", async () => { throw new Error("404"); })).rejects.toThrow(/couldn't read/);
    expect(await readIncomingFile("file:///var/Inbox/a.md", async () => bytes("# A"))).toMatchObject({ name: "a.md", content: "# A" });
  });
});
