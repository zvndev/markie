// The TipTap half of the Markie RS live interop check. Started by
// rust/crates/markie-editor/tests/live_interop.rs, which signs the two
// accounts up on a local server and hands this process Bob's session in a
// scratch file (MARKIE_LIVE_HANDOFF). Bob edits with the web app's own rich
// extensions, TipTap's Collaboration and CollaborationCaret, y-websocket and
// y-tiptap's position mapping: exactly what RichView runs.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { Editor } from "@tiptap/core";
import { Collaboration } from "@tiptap/extension-collaboration";
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "@tiptap/y-tiptap";
import { richBaseExtensions } from "@/lib/rich-extensions";
import { formatMarkdownTables } from "@/lib/format-tables";

const HANDOFF = process.env.MARKIE_LIVE_HANDOFF;
const run = HANDOFF ? it : it.skip;

type Room = Array<
  | { name: string; attrs: Record<string, unknown>; children: Room }
  | { text: Array<{ insert: string; attributes: Record<string, unknown> }> }
>;

function sortKeys<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))) as T;
}

// The same shape as markie_rich::room::to_json.
function roomJson(parent: Y.XmlFragment | Y.XmlElement): Room {
  const out: Room = [];
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlText) {
      const runs: Array<{ insert: string; attributes: Record<string, unknown> }> = [];
      for (const d of child.toDelta() as Array<{ insert: string; attributes?: Record<string, unknown> }>) {
        const attributes = sortKeys(Object.fromEntries(Object.entries(d.attributes ?? {}).filter(([, v]) => v !== null)));
        const last = runs[runs.length - 1];
        if (last && JSON.stringify(last.attributes) === JSON.stringify(attributes)) last.insert += d.insert;
        else runs.push({ insert: d.insert, attributes });
      }
      out.push({ text: runs });
    } else if (child instanceof Y.XmlElement) {
      const attrs = Object.fromEntries(Object.entries(child.getAttributes()).filter(([, v]) => v !== null && v !== undefined));
      out.push({ name: child.nodeName, attrs: sortKeys(attrs), children: roomJson(child) });
    }
  }
  return out;
}

async function until(what: string, ok: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function rangeOf(editor: Editor, needle: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found || !node.isText) return;
    const i = node.text!.indexOf(needle);
    if (i >= 0) found = { from: pos + i, to: pos + i + needle.length };
  });
  if (!found) throw new Error(`${needle} not in the document`);
  return found;
}

run("TipTap shares a live room with Markie RS", async () => {
  const h = JSON.parse(readFileSync(HANDOFF!, "utf-8")) as {
    base: string;
    docId: string;
    token: string;
    rustThreadId: string;
    dir: string;
  };
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${h.base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${h.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(res.ok, `${method} ${path} answered ${res.status}`).toBe(true);
    return res.json();
  };

  const { ticket } = (await api("POST", `/api/docs/${encodeURIComponent(h.docId)}/collab-ticket`, { schema: 2 })) as { ticket: string };
  const ydoc = new Y.Doc();
  const wsBase = h.base.replace(/^http/, "ws") + "/collab";
  const provider = new WebsocketProvider(wsBase, h.docId, ydoc, {
    params: { ticket },
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  });
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...richBaseExtensions({ collab: true }),
      Collaboration.configure({ document: ydoc }),
      CollaborationCaret.configure({ provider, user: { name: "Bob Tiptap", color: "#ec4899" } }),
    ],
  });
  const fragment = ydoc.getXmlFragment("default");
  const mapping = () => (ySyncPluginKey.getState(editor.state) as { binding: { mapping: Map<unknown, unknown> } }).binding.mapping;
  await until("the room", () => provider.synced && fragment.length > 0);

  // Alice's caret, as y-tiptap's cursor plugin draws it.
  await until("Alice's cursor", () =>
    [...provider.awareness.getStates().values()].some((s) => (s as { user?: { name?: string }; cursor?: unknown }).user?.name === "Alice Rust" && (s as { cursor?: unknown }).cursor),
  );
  const alice = [...provider.awareness.getStates().values()].find((s) => (s as { user?: { name?: string } }).user?.name === "Alice Rust") as {
    cursor: { anchor: unknown; head: unknown };
  };
  const ca = relativePositionToAbsolutePosition(ydoc, fragment, Y.createRelativePositionFromJSON(alice.cursor.anchor), mapping() as never);
  const ch = relativePositionToAbsolutePosition(ydoc, fragment, Y.createRelativePositionFromJSON(alice.cursor.head), mapping() as never);
  expect(ca).not.toBeNull();
  const rustCursorText = editor.state.doc.textBetween(Math.min(ca!, ch!), Math.max(ca!, ch!));

  // Alice's comment, as comments.tsx anchors it (anchorToAbsolute).
  const { threads } = (await api("GET", `/api/docs/${encodeURIComponent(h.docId)}/threads`)) as {
    threads: Array<{ id: string; anchor: { from: unknown; to: unknown } }>;
  };
  const rust = threads.find((t) => t.id === h.rustThreadId)!;
  const af = relativePositionToAbsolutePosition(ydoc, fragment, Y.createRelativePositionFromJSON(rust.anchor.from), mapping() as never);
  const at = relativePositionToAbsolutePosition(ydoc, fragment, Y.createRelativePositionFromJSON(rust.anchor.to), mapping() as never);
  const rustAnchorText = editor.state.doc.textBetween(af!, at!);
  writeFileSync(join(h.dir, "tiptap-seen.json"), JSON.stringify({ rustCursorText, rustAnchorText, roomText: editor.getText() }, null, 2));

  // Bob types in the same paragraph Alice is typing in.
  const jumps = rangeOf(editor, "jumps");
  editor.commands.insertContentAt(jumps.to, " TIPTAP");
  // Bob's caret on "dog". The cursor plugin publishes while the editor has
  // focus; jsdom has no real focus, so publish what the plugin would.
  const dog = rangeOf(editor, "dog");
  editor.commands.setTextSelection(dog);
  const binding = mapping();
  provider.awareness.setLocalStateField("cursor", {
    anchor: absolutePositionToRelativePosition(dog.from, fragment, binding as never),
    head: absolutePositionToRelativePosition(dog.to, fragment, binding as never),
  });
  // Bob comments on "fox", as comments.tsx does (selectionToAnchor).
  const fox = rangeOf(editor, "fox");
  await api("POST", `/api/docs/${encodeURIComponent(h.docId)}/threads`, {
    anchor: {
      from: Y.relativePositionToJSON(absolutePositionToRelativePosition(fox.from, fragment, binding as never)),
      to: Y.relativePositionToJSON(absolutePositionToRelativePosition(fox.to, fragment, binding as never)),
    },
    body: "TipTap says: which fox?",
  });

  // Alice's concurrent edit arrives; both sides hold the same document.
  await until("Alice's edit", () => editor.getText().includes("RUSTEDIT"));
  await new Promise((r) => setTimeout(r, 300));
  const md = formatMarkdownTables((editor.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown());
  expect(md).toContain("jumps TIPTAP over the lazy dog RUSTEDIT.");
  writeFileSync(join(h.dir, "tiptap-done.json"), JSON.stringify({ markdown: md, room: roomJson(fragment) }, null, 2));
  expect(rustCursorText).toBe("lazy");
  expect(rustAnchorText).toBe("quick brown");
  // Stay until Alice has read Bob's cursor and comment, then leave.
  await until("Alice's checks", () => {
    try {
      readFileSync(join(h.dir, "rust-checked.json"), "utf-8");
      return true;
    } catch {
      return false;
    }
  }, 60_000);
  provider.destroy();
  editor.destroy();
});
