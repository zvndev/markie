// Two clients of this build open the same older room in the same moment and
// both bring it up to date. Each builds its migration on its own copy; the
// server takes the first update that claims the room's editor model and
// drops the second (server/src/collab-schema.ts, the very rule imported
// here). Without that rule the room holds every changed line and formula
// twice, which is shown first.
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { Collaboration } from "@tiptap/extension-collaboration";
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { richBaseExtensions } from "@/lib/rich-extensions";
import { planLegacyRoom } from "@/lib/rich-room-migrate";
import { migrationUpdate, syncUpdateMessage, updateFromSyncMessage } from "@/lib/room-migration-update";
import { hasEditorModel, updateClaimsModel } from "../../server/src/collab-schema";

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

const STORED_BODY = "Before $a$ and $$\nb\n$$ after.\n\nLast.\n";

/** A room as 0.9.4 seeded it: math as text, line breaks folded. */
function olderRoom(): Y.Doc {
  const scratch = new Editor({ extensions: richBaseExtensions({ collab: true }), content: "" });
  editors.push(scratch);
  const doc = new Y.Doc();
  prosemirrorJSONToYXmlFragment(scratch.schema, {
    type: "doc",
    content: [
      { type: "paragraph", attrs: { textAlign: null }, content: [{ type: "text", text: "Before $a$ and $$ b $$ after." }] },
      { type: "paragraph", attrs: { textAlign: null }, content: [{ type: "text", text: "Last." }] },
    ],
  }, doc.getXmlFragment("default"));
  doc.getMap("meta").set("schemaVersion", 1);
  return doc;
}

/** A client of this build bound to its own copy of `room`, and the update its migration sends. */
function clientMigrating(room: Y.Doc) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(room));
  const element = document.createElement("div");
  const editor = new Editor({ element, extensions: [...richBaseExtensions({ collab: true }), Collaboration.configure({ document: doc })] });
  editors.push(editor);
  const plan = planLegacyRoom(editor, { frontMatter: "", baselineBody: STORED_BODY });
  if (plan.kind !== "migrate") throw new Error(`expected a migration, got ${plan.kind}`);
  const update = migrationUpdate(doc, plan.tr.doc, { editorModel: 2, schemaVersion: 2 });
  // What travels on the socket, and what the server reads out of it.
  const sent = updateFromSyncMessage(syncUpdateMessage(update))!;
  return { doc, editor, sent };
}

/** The room as this build writes it. */
function markdownOf(room: Y.Doc): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(room));
  const editor = new Editor({ element: document.createElement("div"), extensions: [...richBaseExtensions({ collab: true }), Collaboration.configure({ document: doc })] });
  editors.push(editor);
  return (editor.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown();
}

describe("two clients bringing one older room up to date at once", () => {
  it("without the server's rule, the room would hold every change twice", () => {
    const server = olderRoom();
    const a = clientMigrating(server);
    const b = clientMigrating(server);
    Y.applyUpdate(server, a.sent);
    Y.applyUpdate(server, b.sent);
    const out = markdownOf(server);
    expect(out.match(/\$a\$/g)?.length).toBe(2);
  });

  it("with it, the second update is dropped and both clients end on one copy", () => {
    const server = olderRoom();
    const a = clientMigrating(server);
    const b = clientMigrating(server);
    // The server, in the order the two arrive.
    for (const sent of [a.sent, b.sent]) {
      expect(updateClaimsModel(sent)).toBe(true);
      if (hasEditorModel(server)) continue;
      Y.applyUpdate(server, sent);
    }
    // Neither client applied its own update; each gets the room's.
    for (const client of [a, b]) Y.applyUpdate(client.doc, Y.encodeStateAsUpdate(server));
    const expected = "Before $a$ and $$\nb\n$$ after.\n\nLast.";
    expect(markdownOf(server)).toBe(expected);
    expect(markdownOf(a.doc)).toBe(expected);
    expect(markdownOf(b.doc)).toBe(expected);
    expect(server.getMap("meta").get("editorModel")).toBe(2);
  });

  it("builds the update without touching the room it was built from", () => {
    const room = olderRoom();
    const before = Y.encodeStateVector(room);
    clientMigrating(room);
    expect(Y.encodeStateVector(room)).toEqual(before);
    expect(hasEditorModel(room)).toBe(false);
  });
});
