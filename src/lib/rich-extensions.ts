// The one list of extensions the rich editor is built from. The editor
// component, the round-trip probe, the block normalizer, and the round-trip
// test suites all import this so none of them can drift from what the real
// editor does.
import { StarterKit } from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { Image } from "@tiptap/extension-image";
import { mediaKindOf, resolveAssetSrc } from "@/lib/asset-url";
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

// The src that goes into the DOM is not the src that stays in the document.
// `demo/shot.png` has to become an addressable URL to render at all, but the
// node keeps what the author wrote, so serializing back to markdown gives the
// file its own relative path again rather than an absolute one nobody typed.
const LocalImage = Image.extend({
  // A video is still the image node: markdown has one embed syntax, the
  // serializer writes `![alt](src)` from this node, and that is what keeps a
  // document with a clip in it a plain markdown document. Only the rendered
  // element differs.
  parseHTML() {
    return [
      { tag: "img[src]" },
      { tag: "video[data-markie-src]" },
      { tag: "audio[data-markie-src]" },
    ];
  },
  renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) {
    const original =
      typeof HTMLAttributes["data-markie-src"] === "string"
        ? (HTMLAttributes["data-markie-src"] as string)
        : typeof HTMLAttributes.src === "string"
          ? (HTMLAttributes.src as string)
          : "";
    const kind = mediaKindOf(original);
    if (kind === "image") return ["img", HTMLAttributes];
    // `controls` because a clip nobody can pause is a decoration, and
    // `preload="metadata"` so opening a document with five videos in it does
    // not pull five whole files off the disk before you have read a word.
    return [kind, { ...HTMLAttributes, controls: "true", preload: "metadata" }];
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-markie-src") ?? element.getAttribute("src"),
        // Both attributes are emitted: `src` for the browser to load, and the
        // original alongside it so that re-parsing this HTML (a copy, a paste,
        // a round trip through the clipboard) recovers what was written rather
        // than the resolved address.
        renderHTML: (attributes: Record<string, unknown>) => {
          const original = typeof attributes.src === "string" ? attributes.src : null;
          if (!original) return {};
          const resolved = resolveAssetSrc(original);
          return resolved === original
            ? { src: original }
            : { src: resolved, "data-markie-src": original };
        },
      },
    };
  },
});

export function richBaseExtensions(
  opts: { collab?: boolean } = {}
): AnyExtension[] {
  return [
    // Collaboration replaces local undo history with the shared Yjs one
    StarterKit.configure(opts.collab ? { undoRedo: false } : {}),
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    // allowBase64 defaults to false, and when it is false the extension's own
    // parse rule is `img[src]:not([src^="data:"])` — a self-contained document
    // with its pictures inlined lost every one of them on the way into the
    // editor, silently, with an empty paragraph where each had been. That is
    // the format a report arrives in when it has to travel as one file.
    LocalImage.configure({ allowBase64: true }),
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
