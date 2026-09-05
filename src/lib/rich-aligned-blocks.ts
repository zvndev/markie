// A centred paragraph or heading, written to the file as the HTML tag every
// renderer accepts.
//
// Markdown has no alignment. The rich pane can centre a paragraph (TextAlign,
// in rich-extensions.ts), and until now that was all it did: the serializer
// tiptap-markdown gives a paragraph ignores its attributes, so the alignment
// was on screen and gone the moment the file was written, with nothing to say
// so. This writes an aligned block as `<p style="text-align: center">…</p>`
// (or the heading tag), with the inline content as HTML too, because the
// content of an HTML block is not markdown to any renderer and `**bold**` in
// there would show as asterisks on GitHub.
//
// A block nobody aligned is written by the very serializer tiptap-markdown
// would have used, so a document that uses none of this comes out byte for
// byte as before. The hold-aside layer knows this shape (rich-media-html.ts,
// isEditorOwnHtmlBlock) and leaves it to the editor rather than lifting it out
// as raw HTML.
//
// The style comes out as `text-align: center;`, semicolon included: the HTML
// is rendered through a real element, and that is how a browser writes a
// style attribute back. A hand-written tag without the semicolon reads fine
// and is rewritten in this form only if its block is edited.
import { getHTMLFromFragment } from "@tiptap/core";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Heading } from "@tiptap/extension-heading";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { defaultMarkdownSerializer, type MarkdownSerializerState } from "prosemirror-markdown";

// TextAlign's default is "left" for the types it governs, and left is what a
// block is without any attribute at all. An empty block has nothing to align:
// select-all then centre also touches the blank paragraph the editor keeps at
// the end, and that one must stay the nothing it serializes as.
export function isAligned(node: ProseMirrorNode): boolean {
  const align = node.attrs.textAlign;
  return (
    typeof align === "string" && align !== "" && align !== "left" && node.content.size > 0
  );
}

function writeAlignedBlock(state: MarkdownSerializerState, node: ProseMirrorNode): void {
  state.write(getHTMLFromFragment(Fragment.from(node), node.type.schema));
  state.closeBlock(node);
}

export const AlignedParagraph = Paragraph.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize(state: MarkdownSerializerState, node: ProseMirrorNode, parent: ProseMirrorNode, index: number) {
          if (isAligned(node)) writeAlignedBlock(state, node);
          else defaultMarkdownSerializer.nodes.paragraph(state, node, parent, index);
        },
        parse: {
          // handled by markdown-it, with html enabled
        },
      },
    };
  },
});

export const AlignedHeading = Heading.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize(state: MarkdownSerializerState, node: ProseMirrorNode, parent: ProseMirrorNode, index: number) {
          if (isAligned(node)) writeAlignedBlock(state, node);
          else defaultMarkdownSerializer.nodes.heading(state, node, parent, index);
        },
        parse: {
          // handled by markdown-it, with html enabled
        },
      },
    };
  },
});
