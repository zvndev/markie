// What a rich room seeded from `markdown` serializes back to: the exact path
// RichView takes (setContent of the markdown into the collab schema, then the
// collab serializer, src/components/rich-view.tsx serializeMarkdown with no
// holds or front matter). live-snapshot.ts compares a room's first text with
// this to tell a room that holds the stored copy from one that has drifted.
// Loaded on demand, so TipTap stays out of anything that never asks.
import { Editor } from "@tiptap/core";
import { formatMarkdownTables } from "@/lib/format-tables";
import { richBaseExtensions } from "@/lib/rich-extensions";

export function roomRendering(markdown: string): string {
  const editor = new Editor({ extensions: richBaseExtensions({ collab: true }), content: "" });
  try {
    editor.commands.setContent(markdown, { emitUpdate: false });
    const raw = (editor.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown();
    return formatMarkdownTables(raw);
  } finally {
    editor.destroy();
  }
}
