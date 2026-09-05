import { afterAll, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { richBaseExtensions } from "@/lib/rich-extensions";
import { describeLossRisks, probeReconstruction } from "@/lib/rich-roundtrip";
import { extractHoldAsides } from "@/lib/rich-hold-aside";

// The real extension list, headless, the way the round-trip probe uses it.
const editor = new Editor({ extensions: richBaseExtensions({ collab: true }), content: "" });
afterAll(() => editor.destroy());

const markdownOf = () =>
  (editor.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown();

const load = (md: string) => {
  editor.commands.setContent(md, { emitUpdate: false });
  return markdownOf();
};

// Every image node in the document, in order, with its attributes.
const images = () => {
  const out: Record<string, unknown>[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "image") out.push({ ...node.attrs });
  });
  return out;
};

describe("a picture with a width", () => {
  it("is read from the HTML tag into the image node, width and all", () => {
    load('<img src="demo/shot.png" alt="beside" width="240">\n');
    expect(images()).toEqual([
      expect.objectContaining({ src: "demo/shot.png", alt: "beside", width: 240 }),
    ]);
  });

  it("is written back as the same tag, byte for byte", () => {
    const md = '<img src="demo/shot.png" alt="beside" width="240">\n';
    expect(load(md)).toBe(md.trimEnd());
  });

  it("goes back to the markdown syntax when the width is cleared", () => {
    load('<img src="demo/shot.png" alt="beside" width="240">');
    editor.commands.setNodeSelection(0);
    editor.commands.updateAttributes("image", { width: null });
    expect(markdownOf()).toBe("![beside](demo/shot.png)");
  });

  it("becomes the tag the moment a width is chosen", () => {
    load("![beside](demo/shot.png)");
    editor.commands.setNodeSelection(0);
    editor.commands.updateAttributes("image", { width: 300 });
    expect(markdownOf()).toBe('<img src="demo/shot.png" alt="beside" width="300">');
  });

  it("keeps a picture nobody resized exactly as it was", () => {
    // Title, parentheses, everything the default serializer handles. This is
    // the serializer tiptap-markdown would have used, called directly, so
    // the two cannot drift.
    for (const md of [
      "![beside](demo/shot.png)",
      '![a](b.png "title")',
      "![](x.png)",
      "![one](a.png)\n\n![two](b.png)\n\nafter",
    ]) {
      expect(load(md)).toBe(md);
    }
  });

  it("never keeps a height", () => {
    load('<img src="a.png" width="200" height="100">');
    expect(images()[0]).toEqual(expect.objectContaining({ width: 200, height: null }));
    expect(markdownOf()).toBe('<img src="a.png" width="200">');
  });

  it("ignores a width that is not a whole number of pixels", () => {
    load('<img src="a.png" width="50%">');
    expect(images()[0].width).toBeNull();
    expect(markdownOf()).toBe("![](a.png)");
  });
});

describe("a clip with a width", () => {
  it("is read from a video tag and written back with controls", () => {
    const md = '<video src="demo/clip.mp4" width="320" controls></video>';
    expect(load(md)).toBe(md);
    expect(images()[0]).toEqual(
      expect.objectContaining({ src: "demo/clip.mp4", width: 320 })
    );
  });

  it("is still the image node, so the markdown syntax comes back when unsized", () => {
    load('<video src="demo/clip.mp4" width="320" controls></video>');
    editor.commands.setNodeSelection(0);
    editor.commands.updateAttributes("image", { width: null });
    expect(markdownOf()).toBe("![](demo/clip.mp4)");
  });

  it("gives audio no width, whatever was asked", () => {
    load("![take](demo/take.m4a)");
    editor.commands.setNodeSelection(0);
    editor.commands.updateAttributes("image", { width: 320 });
    expect(markdownOf()).toBe("![take](demo/take.m4a)");
  });
});

describe("opening a document with a sized picture", () => {
  const doc = [
    "# Report",
    "",
    "Some words first.",
    "",
    '<img src="demo/shot.png" alt="beside" width="240">',
    "",
    "![plain](demo/other.png)",
    "",
    "<div class=\"note\">still raw HTML</div>",
    "",
    "Closing words.",
    "",
  ].join("\n");

  it("is not held aside like raw HTML, so the picture is in the rich pane", () => {
    const { holds, text } = extractHoldAsides(doc);
    expect(text).toContain('<img src="demo/shot.png" alt="beside" width="240">');
    // The div is still raw HTML and still held.
    expect(holds.map((h) => h.kind)).toEqual(["raw-html"]);
    expect(holds[0].source).toContain("<div");
  });

  it("does not count as raw HTML the editor would rewrite", () => {
    expect(describeLossRisks('<img src="a.png" width="10">\n\ntext\n')).not.toContain("raw-html");
    expect(describeLossRisks("<div>\ntext\n</div>\n")).toContain("raw-html");
  });

  it("reproduces the whole document byte for byte, so rich editing stays on", () => {
    const withoutDiv = doc.replace('<div class="note">still raw HTML</div>\n\n', "");
    expect(probeReconstruction(withoutDiv)).toEqual({ clean: true, output: withoutDiv });
    expect(probeReconstruction(doc).clean).toBe(true);
  });
});
