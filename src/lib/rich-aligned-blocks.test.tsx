import { afterAll, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { richBaseExtensions } from "@/lib/rich-extensions";
import { describeLossRisks, probeReconstruction } from "@/lib/rich-roundtrip";
import { extractHoldAsides } from "@/lib/rich-hold-aside";
import { isAlignedBlockTag, isEditorOwnHtmlBlock } from "@/lib/rich-media-html";

const editor = new Editor({ extensions: richBaseExtensions({ collab: true }), content: "" });
afterAll(() => editor.destroy());

const markdownOf = () =>
  (editor.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown();
const load = (md: string) => {
  editor.commands.setContent(md, { emitUpdate: false });
  return markdownOf();
};

describe("an aligned paragraph", () => {
  it("reaches the file as the tag every renderer accepts, inline content as HTML", () => {
    load("Hello **bold** world");
    editor.commands.selectAll();
    editor.commands.setTextAlign("center");
    expect(markdownOf()).toBe('<p style="text-align: center;">Hello <strong>bold</strong> world</p>');
  });

  it("goes back to plain markdown when the alignment is taken off", () => {
    load("Hello **bold** world");
    editor.commands.selectAll();
    editor.commands.setTextAlign("right");
    editor.commands.setTextAlign("left");
    expect(markdownOf()).toBe("Hello **bold** world");
    editor.commands.setTextAlign("center");
    editor.commands.unsetTextAlign();
    expect(markdownOf()).toBe("Hello **bold** world");
  });

  it("is read back from that tag with its alignment and its marks", () => {
    const md = '<p style="text-align: center;">Hello <strong>bold</strong> world</p>';
    expect(load(md)).toBe(md);
    expect(editor.state.doc.firstChild?.attrs.textAlign).toBe("center");
    expect(editor.isActive("bold")).toBe(false);
    editor.commands.setTextSelection(8);
    expect(editor.isActive("bold")).toBe(true);
  });

  it("works for a heading too", () => {
    load("## Title");
    editor.commands.setTextSelection(2);
    editor.commands.setTextAlign("center");
    expect(markdownOf()).toBe('<h2 style="text-align: center;">Title</h2>');
    expect(load('<h2 style="text-align: right;">Title</h2>')).toBe(
      '<h2 style="text-align: right;">Title</h2>'
    );
    expect(editor.state.doc.firstChild?.type.name).toBe("heading");
    expect(editor.state.doc.firstChild?.attrs.level).toBe(2);
  });

  it("leaves every block nobody aligned exactly as it was", () => {
    for (const md of [
      "Plain words.",
      "# A heading",
      "### Deeper, with *emphasis*",
      "- a list\n- of things",
    ]) {
      expect(load(md), md).toBe(md);
    }
  });

  it("writes nothing for the blank paragraph select-all then centre also touched", () => {
    load("## Title");
    editor.commands.selectAll();
    editor.commands.setTextAlign("center");
    expect(markdownOf()).toBe('<h2 style="text-align: center;">Title</h2>');
  });

  it("reads a hand-written tag without the semicolon, and only rewrites it when edited", () => {
    const md = 'Before.\n\n<p style="text-align: center">Hand written</p>\n\nAfter.\n';
    expect(probeReconstruction(md)).toEqual({ clean: true, output: md });
    load(md);
    expect(editor.state.doc.child(1).attrs.textAlign).toBe("center");
  });
});

describe("opening a document with an aligned block", () => {
  const doc = [
    "# Report",
    "",
    '<p style="text-align: center;">Centred <em>words</em>.</p>',
    "",
    '<h2 style="text-align: right;">Right</h2>',
    "",
    "Plain closing words.",
    "",
  ].join("\n");

  it("is not held aside like raw HTML", () => {
    const { holds, text } = extractHoldAsides(doc);
    expect(holds).toHaveLength(0);
    expect(text).toBe(doc);
  });

  it("does not count as raw HTML the editor would rewrite", () => {
    expect(describeLossRisks(doc)).not.toContain("raw-html");
  });

  it("reproduces the whole document byte for byte, so rich editing stays on", () => {
    expect(probeReconstruction(doc)).toEqual({ clean: true, output: doc });
  });

  it("knows its own shape and nothing wider", () => {
    for (const line of [
      '<p style="text-align: center">x</p>',
      '<h1 style="text-align:right;">x</h1>',
      '<p style="text-align: justify">a <a href="https://x.y">link</a></p>',
    ]) {
      expect(isAlignedBlockTag(line), line).toBe(true);
      expect(isEditorOwnHtmlBlock(line), line).toBe(true);
    }
    for (const line of [
      '<p style="color: red">x</p>',
      '<p style="text-align: center">x</p> and more',
      '<div style="text-align: center">x</div>',
      "<p>x</p>",
      '<p style="text-align: center">',
    ]) {
      expect(isAlignedBlockTag(line), line).toBe(false);
    }
  });
});
