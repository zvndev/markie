// A TipTap peer for looking at Markie RS on screen (interop/scenario.sh):
// Bob joins the room Markie RS seeds, puts his caret on a word, comments on
// a phrase, types, and stays until the "stop" file appears. Everything is
// the web app's own: rich extensions, Collaboration, CollaborationCaret.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { Editor } from "@tiptap/core";
import { Collaboration } from "@tiptap/extension-collaboration";
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret";
import { absolutePositionToRelativePosition, ySyncPluginKey } from "@tiptap/y-tiptap";
import { richBaseExtensions } from "@/lib/rich-extensions";

const BOB = process.env.MARKIE_LIVE_PEER;
const run = BOB ? it : it.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rangeOf(editor: Editor, needle: string): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found || !node.isText) return;
    const i = node.text!.indexOf(needle);
    if (i >= 0) found = { from: pos + i, to: pos + i + needle.length };
  });
  return found;
}

run("Bob, a TipTap peer", { timeout: 20 * 60_000 }, async () => {
  const h = JSON.parse(readFileSync(BOB!, "utf-8")) as { base: string; docId: string; token: string; dir: string };
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${h.base}${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${h.token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return res.json();
  };
  const { ticket } = (await api("POST", `/api/docs/${encodeURIComponent(h.docId)}/collab-ticket`, { schema: 2 })) as { ticket: string };
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(h.base.replace(/^http/, "ws") + "/collab", h.docId, ydoc, { params: { ticket }, WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket, disableBc: true });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const editor = new Editor({ element: host, extensions: [...richBaseExtensions({ collab: true }), Collaboration.configure({ document: ydoc }), CollaborationCaret.configure({ provider, user: { name: "Bob Tiptap", color: "#ec4899" } })] });
  const fragment = ydoc.getXmlFragment("default");
  const stop = join(h.dir, "stop");
  writeFileSync(join(h.dir, "peer.log"), "joining\n");
  while (!(provider.synced && fragment.length > 0) && !existsSync(stop)) await sleep(200);
  writeFileSync(join(h.dir, "peer.log"), "in the room\n", { flag: "a" });
  await sleep(1500);
  const mapping = (ySyncPluginKey.getState(editor.state) as { binding: { mapping: Map<unknown, unknown> } }).binding.mapping;
  const phrase = rangeOf(editor, "shared document");
  if (phrase) {
    await api("POST", `/api/docs/${encodeURIComponent(h.docId)}/threads`, {
      anchor: {
        from: Y.relativePositionToJSON(absolutePositionToRelativePosition(phrase.from, fragment, mapping as never)),
        to: Y.relativePositionToJSON(absolutePositionToRelativePosition(phrase.to, fragment, mapping as never)),
      },
      body: "Should this say who it is shared with?",
    });
  }
  const end = rangeOf(editor, "edits it together.");
  if (end) editor.commands.insertContentAt(end.to, " Bob is typing here too.");
  editor.view.dom.setAttribute("tabindex", "0");
  editor.view.focus();
  const word = rangeOf(editor, "together");
  if (word) editor.commands.setTextSelection(word);
  writeFileSync(join(h.dir, "peer.log"), "edited, cursor set, comment posted\n", { flag: "a" });
  // Move the caret now and then so the name tag shows again.
  let n = 0;
  while (!existsSync(stop) && n < 20 * 60) {
    await sleep(1000);
    n++;
    if (n % 20 === 0) {
      const w = rangeOf(editor, n % 40 === 0 ? "together" : "Markie RS");
      if (w) editor.commands.setTextSelection(w);
    }
  }
  provider.destroy();
  editor.destroy();
});
