import { describe, expect, it } from "vitest";
import {
  convertForExport,
  EXPORT_FORMATS,
  exportFileName,
  exportFormatsFor,
  markdownBlocks,
  textToMarkdown,
} from "./export-formats";
import { openDocx } from "./office/docx";
import { openRtf } from "./office/rtf";
import { openOdt } from "./office/odt";
import type { RichDocument } from "./office/rich-document";
import type { DocxParagraph } from "./office/docx-types";
import { decodeTextDocument } from "./document-formats";

// Every export is read back through Markie's own reader for that format, the
// one that opens the file when a user double-clicks it, and checked for the
// parts of the document a reader would miss first.
const SOURCE = [
  "---",
  "title: front matter stays out",
  "---",
  "# Project plan",
  "",
  "Intro with **bold**, *italic*, `code` and a [link](https://example.com/docs).",
  "",
  "## Steps",
  "",
  "- First item",
  "- Second **strong** item",
  "  - Nested item",
  "",
  "1. One",
  "2. Two",
  "",
  "| Name | Score |",
  "| --- | --- |",
  "| **Ada** | 10 |",
  "| [Bob](https://example.com/bob) | 7 |",
  "",
  "> A quote",
  "",
  "```js",
  "const x = 1;",
  "```",
  "",
  "### Done",
  "",
  "See [the notes](./notes.md).",
  "",
].join("\n");

const paragraph = (doc: RichDocument, text: string): DocxParagraph => {
  const found = doc.paragraphs.find((p) => p.text === text);
  if (!found) throw new Error(`No paragraph "${text}" in: ${JSON.stringify(doc.paragraphs.map((p) => p.text))}`);
  return found;
};
const runFor = (p: DocxParagraph, text: string) => {
  const found = p.runs.find((r) => r.text.includes(text));
  if (!found) throw new Error(`No run "${text}" in: ${JSON.stringify(p.runs.map((r) => r.text))}`);
  return found;
};

describe("export format list", () => {
  it("offers Word, RTF, ODT and text for Markdown, and Markdown instead of text for a text file", () => {
    expect(exportFormatsFor("markdown").map((f) => f.id)).toEqual(["docx", "rtf", "odt", "txt"]);
    expect(exportFormatsFor("text").map((f) => f.id)).toEqual(["docx", "rtf", "odt", "md"]);
    expect(new Set(EXPORT_FORMATS.map((f) => f.extension)).size).toBe(EXPORT_FORMATS.length);
  });

  it("names the file after the document", () => {
    expect(exportFileName("Plan.md", "docx")).toBe("Plan.docx");
    expect(exportFileName("notes.v2.txt", "md")).toBe("notes.v2.md");
    expect(exportFileName(null, "odt")).toBe("document.odt");
  });
});

describe("Word export", () => {
  it("round-trips headings, lists, bold, links and tables through Markie's Word reader", async () => {
    const doc = await openDocx(await convertForExport(SOURCE, "markdown", "docx"));
    expect(doc.canEdit).toBe(true);
    expect(doc.text).not.toContain("front matter");

    expect(paragraph(doc, "Project plan").styleId).toBe("Heading1");
    expect(paragraph(doc, "Steps").styleId).toBe("Heading2");
    expect(paragraph(doc, "Done").styleId).toBe("Heading3");

    const intro = paragraph(doc, "Intro with bold, italic, code and a link.");
    expect(runFor(intro, "bold").style.bold).toBe(true);
    expect(runFor(intro, "italic").style.italic).toBe(true);
    expect(runFor(intro, "code").style.fontFamily).toBe("Courier New");
    expect(doc.hyperlinks.find((l) => l.text === "link")?.target).toBe("https://example.com/docs");

    expect(paragraph(doc, "First item").listKind).toBe("bullet");
    expect(paragraph(doc, "Nested item").listKind).toBe("bullet");
    expect(paragraph(doc, "Nested item").listLevel).toBe(1);
    expect(paragraph(doc, "First item").listLevel ?? 0).toBe(0);
    expect(runFor(paragraph(doc, "Second strong item"), "strong").style.bold).toBe(true);
    expect(paragraph(doc, "One").listKind).toBe("numbered");
    expect(paragraph(doc, "Two").listKind).toBe("numbered");
    expect([paragraph(doc, "One").listNumber, paragraph(doc, "Two").listNumber]).toEqual([1, 2]);

    expect(doc.tables).toHaveLength(1);
    const cells = doc.tables[0].rows.map((row) => row.cells.map((cell) => cell.paragraphs.map((p) => p.text).join("")));
    expect(cells).toEqual([["Name", "Score"], ["Ada", "10"], ["Bob", "7"]]);
    expect(doc.tables[0].rows[0].cells[0].paragraphs[0].runs[0].style.bold).toBe(true);
    expect(doc.tables[0].rows[1].cells[0].paragraphs[0].runs[0].style.bold).toBe(true);
    expect(doc.hyperlinks.find((l) => l.text === "Bob")?.target).toBe("https://example.com/bob");
    // The table sits where it was written: after the numbered list, before the quote.
    const order = doc.blocks.map((b) => (b.kind === "table" ? "TABLE" : doc.paragraphs.find((p) => p.id === b.paragraphId)?.text));
    expect(order.indexOf("TABLE")).toBe(order.indexOf("Two") + 1);

    expect(runFor(paragraph(doc, "A quote"), "A quote").style.italic).toBe(true);
    expect(runFor(paragraph(doc, "const x = 1;"), "const").style.fontFamily).toBe("Courier New");
    // Word cannot link to a relative file, so the address stays readable instead.
    expect(paragraph(doc, "See the notes (./notes.md).")).toBeTruthy();
  });

  it("numbers lists the way the Markdown does: restarts, start numbers and nested levels", async () => {
    const md = "1. a\n2. b\n\nBreak\n\n1. c\n2. d\n\n- x\n\n7. g\n\nAgain\n\n1. p\n   1. q\n   2. r\n2. s\n";
    const doc = await openDocx(await convertForExport(md, "markdown", "docx"));
    const numbers = Object.fromEntries(doc.paragraphs.filter((p) => p.listKind).map((p) => [p.text, [p.listKind, p.listLevel ?? 0, p.listNumber ?? null]]));
    expect(numbers).toEqual({
      a: ["numbered", 0, 1], b: ["numbered", 0, 2],
      c: ["numbered", 0, 1], d: ["numbered", 0, 2],
      x: ["bullet", 0, null],
      g: ["numbered", 0, 7],
      p: ["numbered", 0, 1], q: ["numbered", 1, 1], r: ["numbered", 1, 2], s: ["numbered", 0, 2],
    });
  });

  it("keeps a plain-text file literal", async () => {
    const doc = await openDocx(await convertForExport("# not a heading\n**not bold**\n\nlast", "text", "docx"));
    expect(doc.paragraphs.map((p) => p.text)).toEqual(["# not a heading", "**not bold**", "", "last"]);
    expect(doc.paragraphs.every((p) => !p.styleId)).toBe(true);
    expect(doc.paragraphs[1].runs.every((r) => !r.style.bold)).toBe(true);
  });

  it("writes an empty document and a document that is only a table", async () => {
    expect((await openDocx(await convertForExport("", "markdown", "docx"))).text).toBe("");
    const table = await openDocx(await convertForExport("| a | b |\n| - | - |\n| 1 | 2 |\n", "markdown", "docx"));
    expect(table.tables).toHaveLength(1);
  });
});

describe.each(["rtf", "odt"] as const)("%s export", (format) => {
  const open = (bytes: Uint8Array) => (format === "rtf" ? openRtf(bytes) : openOdt(bytes));

  it("round-trips headings, lists, bold, links and table text through Markie's reader", async () => {
    const doc = await open(await convertForExport(SOURCE, "markdown", format));
    expect(doc.format).toBe(format);
    // Reopens editable: nothing it wrote is outside the codec's own subset.
    expect(doc.canEdit).toBe(true);
    expect(doc.text).not.toContain("front matter");

    const h1 = runFor(paragraph(doc, "Project plan"), "Project plan").style;
    expect(h1.bold).toBe(true);
    expect(h1.fontSizePoints).toBe(24);
    expect(runFor(paragraph(doc, "Steps"), "Steps").style.fontSizePoints).toBe(18);

    const intro = paragraph(doc, "Intro with bold, italic, code and a link (https://example.com/docs).");
    expect(runFor(intro, "bold").style.bold).toBe(true);
    expect(runFor(intro, "italic").style.italic).toBe(true);
    expect(runFor(intro, "code").style.fontFamily).toBe("Courier New");
    const link = runFor(intro, "link");
    expect(link.style.underline).toBe("single");
    expect(link.style.color?.toLowerCase()).toBe("1155cc");

    expect(paragraph(doc, "• First item")).toBeTruthy();
    expect(paragraph(doc, "    • Nested item")).toBeTruthy();
    expect(runFor(paragraph(doc, "• Second strong item"), "strong").style.bold).toBe(true);
    expect(paragraph(doc, "1. One")).toBeTruthy();
    expect(paragraph(doc, "2. Two")).toBeTruthy();

    const header = paragraph(doc, "Name\tScore");
    expect(header.runs.every((r) => r.style.bold)).toBe(true);
    expect(paragraph(doc, "Ada\t10")).toBeTruthy();
    expect(paragraph(doc, "Bob (https://example.com/bob)\t7")).toBeTruthy();

    expect(runFor(paragraph(doc, "A quote"), "A quote").style.italic).toBe(true);
    expect(runFor(paragraph(doc, "const x = 1;"), "const").style.fontFamily).toBe("Courier New");
  });

  it("keeps a plain-text file literal", async () => {
    const doc = await open(await convertForExport("# not a heading\n**not bold**", "text", format));
    expect(doc.paragraphs.map((p) => p.text)).toEqual(["# not a heading", "**not bold**"]);
    expect(doc.paragraphs.flatMap((p) => p.runs).every((r) => !r.style.bold)).toBe(true);
  });
});

describe("plain text export", () => {
  it("keeps headings, list markers, link addresses and table rows as text", async () => {
    const { text } = decodeTextDocument(await convertForExport(SOURCE, "markdown", "txt"));
    expect(text).not.toContain("front matter");
    expect(text).not.toContain("**");
    expect(text.split("\n")).toEqual(expect.arrayContaining([
      "Project plan",
      "Intro with bold, italic, code and a link (https://example.com/docs).",
      "- First item",
      "- Second strong item",
      "  - Nested item",
      "1. One",
      "2. Two",
      "Name\tScore",
      "Ada\t10",
      "Bob (https://example.com/bob)\t7",
      "> A quote",
      "const x = 1;",
      "See the notes (./notes.md).",
    ]));
  });

  it("exports a text file's text unchanged", async () => {
    expect(new TextDecoder().decode(await convertForExport("a\r\nb", "text", "txt"))).toBe("a\nb");
  });
});

describe("Markdown export of a plain-text file", () => {
  const TEXT = "# not a heading\n*not emphasis* and [not](a link)\n- not a list\n1. not numbered\n    indented\nprice $5 and $6 <b>\n\nnext paragraph";

  it("reads back through Markie's Markdown parser as the same text, line for line", async () => {
    const markdown = new TextDecoder().decode(await convertForExport(TEXT, "text", "md"));
    const blocks = await markdownBlocks(markdown);
    expect(blocks.every((b) => b.kind === "paragraph")).toBe(true);
    const lines = blocks.map((b) => (b.kind === "paragraph" ? b.content.map((i) => i.text).join("") : ""));
    expect(lines).toEqual([
      "# not a heading",
      "*not emphasis* and [not](a link)",
      "- not a list",
      "1. not numbered",
      "    indented",
      "price $5 and $6 <b>",
      "next paragraph",
    ]);
    expect(blocks.flatMap((b) => (b.kind === "paragraph" ? b.content : [])).every((i) => !i.bold && !i.italic && !i.href && !i.code)).toBe(true);
  });

  it("leaves ordinary prose readable", () => {
    expect(textToMarkdown("Hello, world. It's 3pm.")).toBe("Hello, world. It's 3pm.");
  });

  it("does not convert a Markdown document to itself", async () => {
    expect(new TextDecoder().decode(await convertForExport("# Title\r\n", "markdown", "md"))).toBe("# Title\n");
  });
});
