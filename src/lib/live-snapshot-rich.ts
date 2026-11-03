// What a rich room seeded from `markdown` serializes back to: the exact path
// RichView takes (setContent of the markdown into the collab schema, then the
// serializer). live-snapshot.ts compares a room's first text with what this
// writes back, to tell a room that holds the stored copy from one that has
// drifted, and to tell a document a room can write faithfully from one it
// cannot. Loaded on demand, so TipTap stays out of anything that never asks.
import { Editor } from "@tiptap/core";
import { formatMarkdownTables } from "@/lib/format-tables";
import { richBaseExtensions } from "@/lib/rich-extensions";
import { preserveBlocks } from "@/lib/rich-block-preserve";
import { createBlockNormalizer } from "@/lib/rich-roundtrip";
import { richRoomCannotCarry } from "@/lib/live-room-carry";

/** The serializer's whole-document rendering of a room seeded from `markdown`. */
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

/**
 * What a live rich session writes back for a room seeded from `markdown`
 * that nobody has edited: the serializer's rendering with every block it
 * merely reformatted put back as its source bytes, exactly as RichView's
 * serializeMarkdown does in a live session (block preservation against the
 * text the pane was opened on).
 */
export function roomWriteBack(markdown: string): string {
  return preserveBlocks(markdown, roomRendering(markdown), createBlockNormalizer().normalize);
}

/**
 * The generic guard: whether a rich room seeded from `markdown` writes it
 * back byte for byte. Only then may a live session write the room's text over
 * this document (the stored cloud copy, or the desktop's own file). The
 * constructs the room is known to lose (front matter, held-aside HTML,
 * comments and footnotes, a refused picture address) answer without a parse.
 */
export function roomCarries(markdown: string): boolean {
  if (!markdown.trim()) return true;
  if (richRoomCannotCarry(markdown)) return false;
  try {
    return roomWriteBack(markdown) === markdown;
  } catch {
    // A text the editor cannot even parse is not one a room may write.
    return false;
  }
}
