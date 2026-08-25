// @vitest-environment jsdom
// Anchors are the whole reason a comment stays on its sentence while other
// people edit around it. These exercise the real Yjs binding, not a stub.
import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import StarterKit from "@tiptap/starter-kit";
import * as Y from "yjs";
import { afterEach, describe, expect, it } from "vitest";
import { anchorToAbsolute, selectionToAnchor } from "./comments";

let editor: Editor | null = null;
let ydoc: Y.Doc | null = null;

function makeEditor(text: string) {
  ydoc = new Y.Doc();
  const element = document.createElement("div");
  document.body.appendChild(element);
  editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Collaboration.configure({ document: ydoc }),
    ],
  });
  editor.commands.setContent(`<p>${text}</p>`);
  return { editor, ydoc };
}

afterEach(() => {
  editor?.destroy();
  editor = null;
  ydoc?.destroy();
  ydoc = null;
  document.body.innerHTML = "";
});

describe("comment anchors", () => {
  it("round-trips a selection through JSON back to the same positions", () => {
    const { editor: ed, ydoc: doc } = makeEditor("Hello brave new world");
    const anchor = selectionToAnchor(ed, 7, 12); // "brave"
    expect(anchor).not.toBeNull();
    expect(ed.state.doc.textBetween(7, 12)).toBe("brave");

    // survives serialization the way the server stores it
    const wire = JSON.parse(JSON.stringify(anchor));
    expect(anchorToAbsolute(ed, doc, wire)).toEqual({ from: 7, to: 12 });
  });

  it("follows the text when an earlier edit shifts it", () => {
    const { editor: ed, ydoc: doc } = makeEditor("Hello brave new world");
    const anchor = selectionToAnchor(ed, 7, 12)!;

    ed.commands.insertContentAt(1, "Oh, ");
    expect(ed.state.doc.textBetween(1, 5)).toBe("Oh, ");

    const moved = anchorToAbsolute(ed, doc, anchor)!;
    expect(moved.from).toBeGreaterThan(7);
    expect(ed.state.doc.textBetween(moved.from, moved.to)).toBe("brave");
  });

  it("stays put when a later edit does not move it", () => {
    const { editor: ed, ydoc: doc } = makeEditor("Hello brave new world");
    const anchor = selectionToAnchor(ed, 1, 6)!; // "Hello"
    ed.commands.insertContentAt(ed.state.doc.content.size - 1, "!!!");
    expect(anchorToAbsolute(ed, doc, anchor)).toEqual({ from: 1, to: 6 });
  });

  it("anchors an empty (collapsed) selection", () => {
    const { editor: ed, ydoc: doc } = makeEditor("Hello world");
    const anchor = selectionToAnchor(ed, 3, 3)!;
    expect(anchorToAbsolute(ed, doc, anchor)).toEqual({ from: 3, to: 3 });
  });

  it("anchors the document boundaries", () => {
    const { editor: ed, ydoc: doc } = makeEditor("Hello world");
    const end = ed.state.doc.content.size - 1;
    const anchor = selectionToAnchor(ed, 1, end)!;
    expect(anchorToAbsolute(ed, doc, anchor)).toEqual({ from: 1, to: end });
  });

  it("returns null for a malformed anchor instead of throwing", () => {
    const { editor: ed, ydoc: doc } = makeEditor("Hello world");
    expect(anchorToAbsolute(ed, doc, { from: null, to: null })).toBeNull();
    expect(anchorToAbsolute(ed, doc, { from: { nope: 1 }, to: { nope: 2 } })).toBeNull();
  });

  it("returns null when the editor has no Yjs binding", () => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    const plain = new Editor({ element, extensions: [StarterKit] });
    expect(selectionToAnchor(plain, 1, 2)).toBeNull();
    expect(anchorToAbsolute(plain, new Y.Doc(), { from: {}, to: {} })).toBeNull();
    plain.destroy();
  });
});
