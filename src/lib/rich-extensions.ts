// The one list of extensions the rich editor is built from. The editor
// component, the round-trip probe, the block normalizer, and the round-trip
// test suites all import this so none of them can drift from what the real
// editor does.
import { StarterKit } from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { Image } from "@tiptap/extension-image";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Highlight } from "@tiptap/extension-highlight";
import { MarkieKeymap } from "@/lib/rich-keymap";
import { TextAlign } from "@tiptap/extension-text-align";
import {
  Color,
  FontFamily,
  FontSize,
  TextStyle,
} from "@tiptap/extension-text-style";
import { Markdown } from "tiptap-markdown";
import type { AnyExtension } from "@tiptap/react";

export function richBaseExtensions(
  opts: { collab?: boolean } = {}
): AnyExtension[] {
  return [
    // Collaboration replaces local undo history with the shared Yjs one
    StarterKit.configure(opts.collab ? { undoRedo: false } : {}),
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Image,
    Placeholder.configure({ placeholder: "Start typing or open a file" }),
    MarkieKeymap,
    // Formatting markdown has no syntax for. These serialize as inline HTML,
    // which is a deliberate trade: a document that uses underline, colour,
    // highlight or alignment stops round-tripping byte for byte, because the
    // markup has to live somewhere. A document that uses none of them is
    // untouched, which is why they are opt-in per selection rather than a
    // document mode. Underline is not listed: StarterKit already registers
    // it, and registering the same mark twice makes TipTap warn.
    Highlight.configure({ multicolor: true }),
    TextStyle,
    Color,
    FontFamily,
    FontSize,
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    Markdown.configure({
      // Required for the above to survive a save. With html:false the marks
      // render on screen and are silently dropped the moment the file is
      // written, which is worse than not offering them.
      html: true,
      linkify: true,
      breaks: false,
      tightLists: true,
      transformPastedText: true,
    }),
  ];
}
