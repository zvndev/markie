// A picture inlined as a data: URI must come through the rich editor exactly
// as written: drawn as a picture, saved back byte for byte, carried by a live
// room, and kept by every export. markdown-it's default address check refused
// every type but gif, png, jpeg and webp, so an SVG chart became its own
// literal text and was saved escaped (`!\[alt\](data:…)`), the picture gone.
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { richBaseExtensions } from "@/lib/rich-extensions";
import { probeReconstruction, probeRoundTrip } from "@/lib/rich-roundtrip";
import { roomRendering } from "@/lib/live-snapshot-rich";
import { richRoomCannotCarry } from "@/lib/live-room-carry";
import { liveSnapshotRefusal } from "@/lib/live-snapshot";
import { renderMarkdownHTML } from "@/lib/markdown-html";
import { convertForExport } from "@/lib/export-formats";
import { editorRefusesImageSrc, hasRefusedImage, isImageDataUri } from "@/lib/rich-data-images";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"><rect width="4" height="2" fill="#EC4431"/></svg>';

const PICTURES: Array<[string, string]> = [
  ["png", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="],
  ["jpeg", "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA="],
  ["gif", "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="],
  ["webp", "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=="],
  ["svg+xml base64", `data:image/svg+xml;base64,${btoa(SVG)}`],
  ["svg+xml percent-encoded", `data:image/svg+xml,${encodeURIComponent(SVG)}`],
  ["avif", "data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUEAAADybWV0YQ=="],
];

const doc = (src: string) =>
  `# Cellar report\n\n![Bottles opened per month](${src})\n\nThe chart above is the whole year.\n`;

/** The rich pane's own steps: parse into the editor, then read both sides. */
function rich(markdown: string): { html: string; markdown: string } {
  const editor = new Editor({ extensions: richBaseExtensions({ collab: true }), content: "" });
  try {
    editor.commands.setContent(markdown, { emitUpdate: false });
    const written = (editor.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown();
    return { html: editor.getHTML(), markdown: written };
  } finally {
    editor.destroy();
  }
}

describe("a data: picture through the rich editor", () => {
  it.each(PICTURES)("draws %s as a picture with the address as written", (_type, src) => {
    const html = rich(doc(src)).html;
    expect(html).toContain(`<img src="${src}" alt="Bottles opened per month">`);
    expect(html).not.toContain("![");
  });

  it.each(PICTURES)("serializes %s back byte for byte", (_type, src) => {
    const md = doc(src);
    // Raw, with no block preservation to hide behind: this is what an edited
    // block and a live room both write.
    expect(rich(md).markdown).toBe(md.trimEnd());
    expect(probeRoundTrip(md).clean).toBe(true);
    expect(probeReconstruction(md)).toEqual({ clean: true, output: md });
  });

  it.each(PICTURES)("keeps %s when the document around it is edited", (_type, src) => {
    const editor = new Editor({ extensions: richBaseExtensions(), content: "" });
    try {
      editor.commands.setContent(doc(src), { emitUpdate: false });
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, " Edited.");
      const written = (editor.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown();
      expect(written).toBe(doc(src).replace("whole year.\n", "whole year. Edited."));
    } finally {
      editor.destroy();
    }
  });

  it.each(PICTURES)("is carried by a live rich room as %s", (_type, src) => {
    const md = doc(src);
    // What a room seeded from this text writes back (live-snapshot.ts rule 6
    // compares against exactly this).
    expect(roomRendering(md)).toBe(md.trimEnd());
    expect(richRoomCannotCarry(md)).toBe(false);
    expect(liveSnapshotRefusal(md, "rich")).toBeNull();
  });

  it.each(PICTURES)("is kept by the HTML and PDF export and the original export as %s", async (_type, src) => {
    const md = doc(src);
    expect(renderMarkdownHTML(md)).toContain(`<img src="${src}" alt="Bottles opened per month">`);
    expect(new TextDecoder().decode(await convertForExport(md, "markdown", "md"))).toBe(md);
  });
});

describe("what stays refused", () => {
  it("never makes a data: address a link, picture type or not", () => {
    for (const src of [
      `data:image/svg+xml;base64,${btoa(SVG)}`,
      "data:image/png;base64,iVBORw0KGgo=",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    ]) {
      const html = rich(`[open me](${src})\n`).html;
      expect(html).not.toContain('href="data:');
      expect(html).not.toContain("<img");
    }
  });

  it("does not take a non-picture data: address or a script address as a picture", () => {
    for (const src of [
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "data:application/javascript;base64,YWxlcnQoMSk=",
      "javascript:alert(1)",
      "vbscript:msgbox(1)",
    ]) {
      expect(rich(`![x](${src})\n`).html).not.toContain("<img");
    }
  });

  it("leaves a link to a picture data: URI in alt text as plain alt text", () => {
    const src = `data:image/svg+xml;base64,${btoa(SVG)}`;
    const html = rich(`![see [this](${src})](${src})\n`).html;
    expect(html).not.toContain("<a ");
    expect(html).not.toContain('href="');
  });

  it("names exactly the picture addresses the editor turns into text", () => {
    expect(isImageDataUri("DATA:Image/SVG+XML;base64,AAAA")).toBe(true);
    expect(isImageDataUri("data:image/svg+xml,%3Csvg%2F%3E")).toBe(true);
    expect(isImageDataUri("data:image/svgxml;base64,AAAA")).toBe(false);
    expect(isImageDataUri("data:text/html,hi")).toBe(false);
    expect(editorRefusesImageSrc("data:text/html,hi")).toBe(true);
    expect(editorRefusesImageSrc("javascript:alert(1)")).toBe(true);
    expect(editorRefusesImageSrc("file:///tmp/a.png")).toBe(true);
    expect(editorRefusesImageSrc("data:image/avif;base64,AAAA")).toBe(false);
    expect(editorRefusesImageSrc("https://example.com/a.png")).toBe(false);
    expect(editorRefusesImageSrc("shots/a.png")).toBe(false);
    // Code is text in the editor too, so a picture written in code is kept.
    expect(hasRefusedImage("```md\n![x](javascript:alert(1))\n```\n")).toBe(false);
    expect(hasRefusedImage("Write `![x](file:///a.png)` like this.\n")).toBe(false);
    expect(hasRefusedImage("![x](<file:///a b.png>)\n")).toBe(true);
  });

  it.each([
    ["a non-picture data: address", "data:text/html;base64,PHA+aGk8L3A+"],
    ["a file: address", "file:///Users/me/chart.png"],
  ])("refuses a live write over a picture with %s, which the room would save escaped", (_label, src) => {
    const md = doc(src);
    // The loss the rule exists for: the room writes the picture as text.
    expect(roomRendering(md)).not.toBe(md.trimEnd());
    expect(richRoomCannotCarry(md)).toBe(true);
    expect(liveSnapshotRefusal(md, "rich")).toBe("held-constructs");
  });
});
