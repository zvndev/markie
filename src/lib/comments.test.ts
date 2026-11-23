// @vitest-environment jsdom
// Anchors are the whole reason a comment stays on its sentence while other
// people edit around it. These exercise the real Yjs binding, not a stub.
import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import StarterKit from "@tiptap/starter-kit";
import * as Y from "yjs";
import { afterEach, describe, expect, it } from "vitest";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "@tiptap/y-tiptap";
import { anchorToAbsolute, quoteAt, selectionToAnchor } from "./comment-anchors";
import { quoteAnchor, quoteOf, type Quote } from "./quote-anchor";

let editor: Editor | null = null;
let ydoc: Y.Doc | null = null;

function makeEditor(text: string, html?: string) {
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
  editor.commands.setContent(html ?? `<p>${text}</p>`);
  return { editor, ydoc };
}

// Exactly what Markie 0.9.7 and the phone app 0.3.0 run on any anchor
// (anchorToAbsolute before quote anchors existed): `from` and `to`, nothing else.
function releasedAnchorToAbsolute(
  ed: Editor,
  doc: Y.Doc,
  anchor: { from: unknown; to: unknown }
): { from: number; to: number } | null {
  const ystate = ySyncPluginKey.getState(ed.state) as {
    type: Y.XmlFragment;
    binding?: { mapping: Parameters<typeof absolutePositionToRelativePosition>[2] } | null;
  } | null;
  if (!ystate?.binding) return null;
  try {
    const from = relativePositionToAbsolutePosition(
      doc,
      ystate.type,
      Y.createRelativePositionFromJSON(anchor.from),
      ystate.binding.mapping
    );
    const to = relativePositionToAbsolutePosition(
      doc,
      ystate.type,
      Y.createRelativePositionFromJSON(anchor.to),
      ystate.binding.mapping
    );
    if (from == null || to == null) return null;
    return { from, to };
  } catch {
    return null;
  }
}

const PLAN = [
  "<h1>Launch plan</h1>",
  "<p>We ship the <strong>beta</strong> on Friday. The budget is tight.</p>",
  "<ul><li><p>Hosting doubled.</p></li><li><p>The budget is tight because of it.</p></li></ul>",
].join("");

/** The anchor the phone's reading screen makes for `words`, from the text a reader sees. */
function phoneAnchor(words: string, nth = 0) {
  // The reading screen's text: blocks one after another.
  const text = "Launch plan\nWe ship the beta on Friday. The budget is tight.\nHosting doubled.\nThe budget is tight because of it.";
  let at = -1;
  for (let i = 0; i <= nth; i++) at = text.indexOf(words, at + 1);
  const end = at + words.length;
  const squeezed = (s: string) => s.replace(/\s+/g, "");
  const quote: Quote = {
    exact: words,
    prefix: text.slice(Math.max(0, at - 48), at),
    suffix: text.slice(end, end + 48),
    approxIndex: squeezed(text.slice(0, at)).length,
  };
  return JSON.parse(JSON.stringify(quoteAnchor(quote)));
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

describe("quote anchors, made where there is no live room", () => {
  it("lands on the words the phone quoted", () => {
    const { editor: ed, ydoc: doc } = makeEditor("", PLAN);
    const placed = anchorToAbsolute(ed, doc, phoneAnchor("beta on Friday"))!;
    expect(ed.state.doc.textBetween(placed.from, placed.to)).toBe("beta on Friday");
  });

  it("lands on the right repeat of a phrase", () => {
    const { editor: ed, ydoc: doc } = makeEditor("", PLAN);
    const first = anchorToAbsolute(ed, doc, phoneAnchor("The budget is tight", 0))!;
    const second = anchorToAbsolute(ed, doc, phoneAnchor("The budget is tight", 1))!;
    expect(ed.state.doc.textBetween(first.from, first.to)).toBe("The budget is tight");
    expect(ed.state.doc.textBetween(second.from, second.to)).toBe("The budget is tight");
    expect(second.from).toBeGreaterThan(first.to);
    expect(ed.state.doc.textBetween(second.to, second.to + 8)).toBe(" because");
  });

  it("covers a quote that runs from one block into the next", () => {
    const { editor: ed, ydoc: doc } = makeEditor("", PLAN);
    const placed = anchorToAbsolute(ed, doc, phoneAnchor("is tight.\nHosting doubled."))!;
    expect(ed.state.doc.textBetween(placed.from, placed.to, " ")).toBe("is tight. Hosting doubled.");
  });

  it("follows the words through edits before and beside them", () => {
    const { editor: ed, ydoc: doc } = makeEditor("", PLAN);
    const anchor = phoneAnchor("Hosting doubled");
    ed.commands.insertContentAt(1, "Second draft: ");
    ed.commands.insertContentAt(ed.state.doc.content.size - 3, " Really.");
    const placed = anchorToAbsolute(ed, doc, anchor)!;
    expect(ed.state.doc.textBetween(placed.from, placed.to)).toBe("Hosting doubled");
  });

  it("stays on its words while they are edited, once it has been placed", () => {
    const { editor: ed, ydoc: doc } = makeEditor("", PLAN);
    const anchor = phoneAnchor("beta on Friday");
    const before = anchorToAbsolute(ed, doc, anchor)!;
    // "beta on Friday" becomes "beta on a Friday": the quote no longer matches.
    ed.commands.insertContentAt(before.from + 8, "a ");
    const after = anchorToAbsolute(ed, doc, anchor)!;
    expect(ed.state.doc.textBetween(after.from, after.to)).toBe("beta on a Friday");
  });

  it("is unplaced when the words are gone, not put somewhere else", () => {
    const { editor: ed, ydoc: doc } = makeEditor("", PLAN);
    const anchor = phoneAnchor("Hosting doubled");
    const placed = anchorToAbsolute(ed, doc, anchor)!;
    ed.commands.deleteRange({ from: placed.from, to: placed.to });
    expect(anchorToAbsolute(ed, doc, anchor)).toBeNull();
  });

  it("is unplaced in a document that never had the words", () => {
    const { editor: ed, ydoc: doc } = makeEditor("Something else entirely");
    expect(anchorToAbsolute(ed, doc, phoneAnchor("Hosting doubled"))).toBeNull();
  });

  it("finds its words again after they are cut and pasted elsewhere", () => {
    const { editor: ed, ydoc: doc } = makeEditor("", PLAN);
    const anchor = phoneAnchor("Hosting doubled");
    const placed = anchorToAbsolute(ed, doc, anchor)!;
    ed.commands.deleteRange({ from: placed.from, to: placed.to });
    ed.commands.insertContentAt(1, "Hosting doubled. ");
    const moved = anchorToAbsolute(ed, doc, anchor)!;
    expect(moved.from).toBe(1);
    expect(ed.state.doc.textBetween(moved.from, moved.to)).toBe("Hosting doubled");
  });

  it("places a quote in an editor with no Yjs binding too", () => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    const plain = new Editor({ element, extensions: [StarterKit], content: PLAN });
    const placed = anchorToAbsolute(plain, new Y.Doc(), phoneAnchor("beta on Friday"))!;
    expect(plain.state.doc.textBetween(placed.from, placed.to)).toBe("beta on Friday");
    plain.destroy();
  });

  it("returns null for a quote anchor with nothing usable in it", () => {
    const { editor: ed, ydoc: doc } = makeEditor("", PLAN);
    expect(anchorToAbsolute(ed, doc, { kind: "quote", exact: "", from: null, to: null } as never)).toBeNull();
    expect(anchorToAbsolute(ed, doc, { kind: "quote" } as never)).toBeNull();
  });
});

describe("released clients, which read only from and to", () => {
  it("show a quote thread at the top of the document instead of losing it", () => {
    const { editor: ed, ydoc: doc } = makeEditor("", PLAN);
    const anchor = phoneAnchor("beta on Friday");
    expect(releasedAnchorToAbsolute(ed, doc, anchor)).toEqual({ from: 0, to: 0 });
    // The jump a click on that bubble makes does not throw either.
    expect(ed.chain().focus().setTextSelection({ from: 0, to: 0 }).scrollIntoView().run()).toBe(true);
  });

  it("would have hidden the thread had the anchor carried no positions", () => {
    const { editor: ed, ydoc: doc } = makeEditor("", PLAN);
    const bare = phoneAnchor("beta on Friday");
    delete bare.from;
    delete bare.to;
    expect(releasedAnchorToAbsolute(ed, doc, bare)).toBeNull();
  });

  it("place a live-room anchor exactly as before, words and all", () => {
    const { editor: ed, ydoc: doc } = makeEditor("Hello brave new world");
    const wire = JSON.parse(JSON.stringify(selectionToAnchor(ed, 7, 12)));
    expect(releasedAnchorToAbsolute(ed, doc, wire)).toEqual({ from: 7, to: 12 });
  });
});

describe("a live-room anchor carries its words", () => {
  it("so a reader outside the room can place it", () => {
    const { editor: ed } = makeEditor("", PLAN);
    const from = 1 + "Launch plan".length + 2 + "We ship the ".length;
    expect(ed.state.doc.textBetween(from, from + 4)).toBe("beta");
    const anchor = selectionToAnchor(ed, from, from + 4)!;
    const quote = quoteOf(JSON.parse(JSON.stringify(anchor)))!;
    expect(quote.exact).toBe("beta");
    expect(quote.prefix.endsWith("We ship the")).toBe(true);
    expect(quote.suffix.startsWith("on Friday.")).toBe(true);
    // Its positions are still the anchor: it is not a quote anchor.
    expect((anchor as { kind?: string }).kind).toBeUndefined();
  });

  it("reads a selection across blocks as the words in both", () => {
    const { editor: ed } = makeEditor("", "<p>One two</p><p>three four</p>");
    expect(quoteAt(ed, 5, 16)!.exact).toBe("two three");
  });

  it("carries no words for a collapsed selection, and still anchors it", () => {
    const { editor: ed, ydoc: doc } = makeEditor("Hello world");
    const anchor = selectionToAnchor(ed, 3, 3)!;
    expect(quoteOf(anchor)).toBeNull();
    expect(anchorToAbsolute(ed, doc, anchor)).toEqual({ from: 3, to: 3 });
  });
});
