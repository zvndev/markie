// Everything a live session needs at runtime, in one module behind one
// dynamic import (src/lib/collab-loader.ts). Most documents are never shared,
// and a launch should not pay for yjs, the websocket provider, the two TipTap
// collaboration extensions and the comment anchoring that only a shared
// document uses. Nothing outside this module and src/lib/comment-anchors.ts
// may import those packages as values; src/lib/entry-graph.test.ts holds the
// line.
export * as Y from "yjs";
export { WebsocketProvider } from "y-websocket";
export { Collaboration } from "@tiptap/extension-collaboration";
export { CollaborationCaret } from "@tiptap/extension-collaboration-caret";
export { anchorToAbsolute, selectionToAnchor } from "@/lib/comment-anchors";
