// The one list of extensions the rich editor is built from. The editor
// component, the round-trip probe, the block normalizer, and the round-trip
// test suites all import this so none of them can drift from what the real
// editor does.
import { StarterKit } from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { Image } from "@tiptap/extension-image";
import { ResizableNodeView, type NodeViewRendererProps } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  defaultMarkdownSerializer,
  type MarkdownSerializerState,
} from "prosemirror-markdown";
import { mediaKindOf, resolveAssetSrc } from "@/lib/asset-url";
import { normalizeWidth, sizedMediaHtml } from "@/lib/rich-media-html";
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
  //
  // The plain `video[src]` and `audio[src]` rules are for a clip written as
  // HTML in the file itself, which is how a clip with a chosen width is
  // stored (see rich-media-html.ts). The data-markie-src rules come first so
  // the editor's own output, copied and pasted, recovers the original path.
  parseHTML() {
    return [
      { tag: "img[src]" },
      { tag: "video[data-markie-src]" },
      { tag: "audio[data-markie-src]" },
      { tag: "video[src]" },
      { tag: "audio[src]" },
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
      // The width the author chose by dragging, in pixels, or null for "as
      // big as it is". A whole number because that is what an HTML width
      // attribute is.
      width: {
        default: null,
        parseHTML: (element: HTMLElement) => normalizeWidth(element.getAttribute("width")),
        renderHTML: (attributes: Record<string, unknown>) => {
          const width = normalizeWidth(attributes.width);
          return width === null ? {} : { width };
        },
      },
      // Never kept. The browser scales the height from the width, and a
      // stored height goes stale the moment the file behind it changes.
      height: {
        default: null,
        parseHTML: () => null,
        renderHTML: () => ({}),
      },
    };
  },
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        // Unsized media is written by the very serializer tiptap-markdown
        // would have used, so a document nobody resized anything in comes out
        // byte for byte as before. Sized media becomes the HTML tag every
        // renderer accepts; see rich-media-html.ts for why that form.
        serialize(state: MarkdownSerializerState, node: ProseMirrorNode) {
          const html = sizedMediaHtml(node.attrs, mediaKindOf(node.attrs.src));
          if (html === null) defaultMarkdownSerializer.nodes.image(state, node, node, 0);
          else state.write(html);
          // The default serializer is written for an inline image and never
          // closes the block. Ours is a block, and without this the words
          // after a picture were written onto the picture's own line the
          // moment either was edited, and came back as one paragraph.
          if (node.isBlock) state.closeBlock(node);
        },
        parse: {
          // handled by markdown-it, with html enabled
        },
      },
    };
  },
  // The picture with resize handles on its corners. Audio gets none: a player
  // bar has no size worth choosing.
  addNodeView() {
    if (typeof document === "undefined") return null;
    return ({ node, getPos, HTMLAttributes, editor }: NodeViewRendererProps) => {
      const kind = mediaKindOf(node.attrs.src);
      const el = document.createElement(kind === "image" ? "img" : kind);
      for (const [key, value] of Object.entries(HTMLAttributes)) {
        // Size is applied as a style by the resizable view, from the node,
        // so a width attribute here would be a second source of truth.
        if (key === "width" || key === "height" || value == null) continue;
        el.setAttribute(key, String(value));
      }
      if (kind !== "image") {
        el.setAttribute("controls", "true");
        el.setAttribute("preload", "metadata");
      }
      if (kind === "audio") return { dom: el };
      return new ResizableNodeView({
        element: el,
        editor,
        node,
        getPos,
        onCommit: (width) => {
          const pos = getPos();
          if (pos === undefined) return;
          editor
            .chain()
            .setNodeSelection(pos)
            .updateAttributes(node.type.name, { width: Math.round(width), height: null })
            .run();
        },
        // Undo, or a collaborator's change, moves the width in the document
        // without a drag. The element follows the node, never the other way.
        onUpdate: (updated) => {
          if (updated.type !== node.type) return false;
          const width = normalizeWidth(updated.attrs.width);
          el.style.width = width === null ? "" : `${width}px`;
          el.style.height = "";
          return true;
        },
        options: {
          directions: ["bottom-left", "bottom-right", "top-left", "top-right"],
          min: { width: 48, height: 24 },
          // A picture is not a rectangle to be reshaped. Dragging a corner
          // changes how big it is, never what it looks like.
          preserveAspectRatio: true,
          className: {
            container: "markie-media",
            wrapper: "markie-media-frame",
            handle: "markie-media-handle",
            resizing: "is-resizing",
          },
        },
      });
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
