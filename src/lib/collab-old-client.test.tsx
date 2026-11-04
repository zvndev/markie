// What a build from before math nodes (desktop 0.9.4, an older phone or a
// web tab loaded before the deploy) does in a room this build wrote. This is
// the evidence behind the room schema gate (src/lib/collab.ts,
// server/src/collab-schema.ts): the old editor is this one without the two
// math nodes, bound to the room through the same y-tiptap binding 0.9.4
// ships (3.0.10).
import { afterEach, describe, expect, it } from "vitest";
import { Editor, type AnyExtension } from "@tiptap/core";
import { Collaboration } from "@tiptap/extension-collaboration";
import { prosemirrorJSONToYXmlFragment, ySyncPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { richBaseExtensions } from "@/lib/rich-extensions";

const NEW_NODES = new Set(["mathInline", "mathBlock"]);

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

/** A room as this build seeds it from `markdown`. */
function roomFrom(markdown: string): Y.Doc {
  const scratch = new Editor({ extensions: richBaseExtensions({ collab: true }), content: "" });
  editors.push(scratch);
  scratch.commands.setContent(markdown, { emitUpdate: false });
  const doc = new Y.Doc();
  prosemirrorJSONToYXmlFragment(scratch.schema, scratch.getJSON(), doc.getXmlFragment("default"));
  return doc;
}

/** A client bound to a copy of `room`, with this build's schema or the old one. */
function join(room: Y.Doc, build: "old" | "new") {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(room));
  const base = richBaseExtensions({ collab: true }).filter((ext: AnyExtension) => build === "new" || !NEW_NODES.has(ext.name));
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new Editor({ element, extensions: [...base, Collaboration.configure({ document: doc })] });
  editors.push(editor);
  const binding = () => (ySyncPluginKey.getState(editor.state) as { binding?: { projectionError: Error | null } }).binding;
  const markdown = () => (editor.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown();
  return { doc, editor, binding, markdown };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("a build from before math nodes, in a room this build wrote", () => {
  it("cannot draw a room holding a formula: an empty, locked page that would serialize as nothing", async () => {
    const room = roomFrom("# Notes\n\nEuler $e^{i\\pi} + 1 = 0$.\n\n$$\na\n$$\n\nThe rest of the document.\n");
    const old = join(room, "old");
    await settle();
    expect(old.binding()?.projectionError).toBeInstanceOf(Error);
    expect(old.editor.isEditable).toBe(false);
    // What its writer would report as the room's text, and push over the
    // stored copy on a room it reads as "ahead": the document, gone. This is
    // why the server keeps such a build out of the room.
    expect(old.markdown()).toBe("");
    expect(old.editor.getText()).not.toContain("The rest of the document.");
    // It does not destroy the room itself: the binding writes nothing while
    // it cannot draw it.
    expect(old.doc.getXmlFragment("default").length).toBe(room.getXmlFragment("default").length);
  });

  it("this build draws and edits the same room", async () => {
    const room = roomFrom("Euler $e^{i\\pi} + 1 = 0$.\n");
    const fresh = join(room, "new");
    await settle();
    expect(fresh.binding()?.projectionError).toBeNull();
    expect(fresh.markdown()).toBe("Euler $e^{i\\pi} + 1 = 0$.");
  });

  it("a room without formulas stays open to it: drawn, editable, nothing lost", async () => {
    const room = roomFrom("# Plain\n\nNothing new in here.\n");
    const old = join(room, "old");
    await settle();
    expect(old.binding()?.projectionError).toBeNull();
    expect(old.editor.isEditable).toBe(true);
    expect(old.markdown()).toBe("# Plain\n\nNothing new in here.");
  });

  it("keeps a table's alignment when it edits one: its schema has had the attribute all along", async () => {
    const room = roomFrom("| Item | Price |\n| :--- | ---: |\n| Tea | 3 |\n");
    const old = join(room, "old");
    await settle();
    let at = -1;
    old.editor.state.doc.descendants((node, pos) => {
      if (at === -1 && node.isText && node.text === "Tea") at = pos + node.nodeSize;
    });
    old.editor.commands.insertContentAt(at, " (green)");
    await settle();
    // Read the room back with this build: every cell still carries its alignment.
    const back = join(old.doc, "new");
    await settle();
    expect(back.markdown()).toContain("| :--- | ---: |");
    expect(back.markdown()).toContain("Tea (green)");
  });
});
