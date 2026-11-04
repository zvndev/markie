import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { richBaseExtensions } from "@/lib/rich-extensions";
import { formatMarkdownTables } from "@/lib/format-tables";
import { delimiterFor } from "@/lib/rich-table-align";

// Parse, optionally edit, serialize and pad: the path an edited table takes.
function roundTrip(markdown: string, edit?: (editor: Editor) => void): string {
  const editor = new Editor({ extensions: richBaseExtensions({ collab: true }), content: "" });
  try {
    editor.commands.setContent(markdown, { emitUpdate: false });
    edit?.(editor);
    return formatMarkdownTables((editor.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown());
  } finally {
    editor.destroy();
  }
}

// Types `text` at the end of the first cell whose text is `cell`.
const typeInCell = (cell: string, text: string) => (editor: Editor) => {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at === -1 && node.isText && node.text === cell) at = pos + node.nodeSize;
  });
  editor.commands.insertContentAt(at, text);
};

describe("table column alignment", () => {
  it("writes each alignment as GFM does", () => {
    expect(delimiterFor("left")).toBe(":---");
    expect(delimiterFor("center")).toBe(":---:");
    expect(delimiterFor("right")).toBe("---:");
    expect(delimiterFor(null)).toBe("---");
    expect(delimiterFor("justify")).toBe("---");
  });

  it("keeps every column's alignment through an edit inside the table", () => {
    const table = "| Left | Centre | Right | None |\n| :--- | :---: | ---: | --- |\n| a | b | c | d |\n";
    // Untouched, the padding is the pretty aligner's (block preservation keeps the source).
    expect(roundTrip(table)).toBe(formatMarkdownTables(table));
    expect(roundTrip(table, typeInCell("b", "bb"))).toBe(
      "| Left | Centre | Right | None |\n| :--- | :----: | ----: | ---- |\n| a    | bbb    | c     | d    |\n"
    );
  });

  it("keeps the alignment when a row is added", () => {
    const table = "| Item | Price |\n| :--- | ---: |\n| Tea | 3 |\n";
    const out = roundTrip(table, (editor) => {
      let pos = -1;
      editor.state.doc.descendants((node, p) => { if (pos === -1 && node.isText && node.text === "Tea") pos = p; });
      editor.chain().setTextSelection(pos + 1).addRowAfter().run();
    });
    expect(out).toBe("| Item | Price |\n| :--- | ----: |\n| Tea  | 3     |\n|      |       |\n");
  });

  it("writes a table without alignment exactly as before", () => {
    const table = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
    // Untouched, the padding is the pretty aligner's (block preservation keeps the source).
    expect(roundTrip(table)).toBe(formatMarkdownTables(table));
    expect(roundTrip(table, typeInCell("1", "0"))).toBe("| a   | b   |\n| --- | --- |\n| 10  | 2   |\n");
  });

  it("draws an aligned column aligned in the editor", () => {
    const editor = new Editor({ extensions: richBaseExtensions(), content: "" });
    try {
      editor.commands.setContent("| a | b |\n| :---: | ---: |\n| 1 | 2 |\n", { emitUpdate: false });
      const html = editor.getHTML();
      expect(html).toContain('<th style="text-align: center;"');
      expect(html).toContain('<td style="text-align: right;"');
    } finally {
      editor.destroy();
    }
  });

  it("writes a table markdown cannot say (merged cells) as HTML, as before", () => {
    const out = roundTrip("| a | b |\n| --- | --- |\n| 1 | 2 |\n", (editor) => {
      let pos = -1;
      editor.state.doc.descendants((node, p) => { if (pos === -1 && node.isText && node.text === "1") pos = p; });
      editor.chain().setTextSelection(pos).setCellSelection({ anchorCell: pos - 2, headCell: pos + 3 }).mergeCells().run();
    });
    expect(out).toMatch(/^<table/);
  });
});
