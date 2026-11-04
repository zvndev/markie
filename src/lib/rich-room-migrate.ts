// A room written before this build: brought up to date in place, or refused.
//
// Two things changed in what a rich room holds (see src/lib/collab.ts):
//
//   * Front matter stays out of the room. A room seeded by an older build
//     holds the document's front matter as the editor read it, a horizontal
//     rule and a heading (or whatever the YAML looks like as markdown), and
//     every writer now puts the stored copy's front matter back on its own.
//     Left in, it would be shown as a rule and a heading and then written
//     twice.
//   * Math is a node holding its TeX. An older room holds it as text, and
//     the HTML parse that seeded it folded a formula's line breaks into
//     spaces. Left as text, an untouched multi-line formula would no longer
//     match the source it came from (block preservation compares each block
//     with what this build makes of the source, which now keeps the lines),
//     so the first edit anywhere would write it on one line.
//
// So the first editor of this build to open such a room changes it, in one
// transaction, before anyone can type: the front matter's nodes come out when
// they are exactly what the document's front matter parses to, and each
// math span becomes a math node, its source taken from the document the pane
// opened on wherever that source folds to the same text (so the lines come
// back), and from the room otherwise. Everything else, and every comment
// anchored outside a formula, is left exactly where it is.
//
// When the room starts with a rule but not with the front matter (someone
// edited it in the room, or removed it), the room's front matter cannot be
// told from the document's own first rule. Nothing is changed and the room
// is refused: this pane goes back to the local copy rather than risk writing
// the front matter twice or dropping a rule.
import { Editor } from "@tiptap/core";
import { Fragment, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { richBaseExtensions } from "@/lib/rich-extensions";
import { splitMath } from "@/lib/rich-math";

export type LegacyRoomPlan =
  | { kind: "none" }
  | { kind: "migrate"; tr: Transaction; frontMatterRemoved: boolean; formulas: number }
  | { kind: "refuse" };

const MATH_TYPES = new Set(["mathInline", "mathBlock"]);

/** Whether a document holds a math node (and so needs room schema 2). */
export function docHasMath(doc: PMNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (MATH_TYPES.has(node.type.name)) found = true;
    return !found;
  });
  return found;
}

// How the HTML parse folds whitespace in ordinary text (ProseMirror's
// DOMParser): every run of these becomes one space.
const fold = (source: string) => source.replace(/[ \t\r\n\f]+/g, " ");

interface MarkdownStorage {
  serializer: { serialize(doc: PMNode): string };
}

/** Parses markdown with the editor's own extensions, into `schema`. */
function parserFor(schema: Schema) {
  const scratch = new Editor({ extensions: richBaseExtensions({ collab: true }), content: "" });
  return {
    parse(markdown: string): PMNode {
      scratch.commands.setContent(markdown, { emitUpdate: false });
      return schema.nodeFromJSON(scratch.getJSON());
    },
    destroy: () => scratch.destroy(),
  };
}

const isEmptyParagraph = (node: PMNode) => node.type.name === "paragraph" && node.childCount === 0;

/** The top-level nodes of `doc`, without the empty paragraph TipTap adds at the end. */
function blocksOf(doc: PMNode): PMNode[] {
  const blocks: PMNode[] = [];
  doc.forEach((child) => blocks.push(child));
  while (blocks.length > 0 && isEmptyParagraph(blocks[blocks.length - 1])) blocks.pop();
  return blocks;
}

const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

function startsWithRule(body: string): boolean {
  const first = body.split("\n").find((line) => line.trim() !== "");
  return first !== undefined && THEMATIC_BREAK.test(first);
}

/**
 * What to do with a room an older build seeded (or one that has never held
 * math), for a pane that opened on `frontMatter` + `baselineBody`.
 */
export function planLegacyRoom(
  editor: Pick<Editor, "state" | "schema" | "storage">,
  { frontMatter, baselineBody }: { frontMatter: string; baselineBody: string }
): LegacyRoomPlan {
  const { state, schema } = editor;
  const doc = state.doc;
  const serializer = (editor.storage as unknown as { markdown: MarkdownStorage }).markdown.serializer;
  const parser = parserFor(schema);
  try {
    // ── the front matter's nodes ──
    let frontMatterEnd = 0;
    if (frontMatter) {
      const wanted = blocksOf(parser.parse(frontMatter));
      const room: PMNode[] = [];
      doc.forEach((child) => room.push(child));
      const leading = room.slice(0, wanted.length);
      const same =
        wanted.length > 0 &&
        leading.length === wanted.length &&
        serializer.serialize(schema.topNodeType.create(null, leading)) ===
          serializer.serialize(schema.topNodeType.create(null, wanted));
      if (same) {
        frontMatterEnd = leading.reduce((size, node) => size + node.nodeSize, 0);
      } else if (room[0]?.type.name === "horizontalRule" && !startsWithRule(baselineBody)) {
        return { kind: "refuse" };
      }
    }

    // ── math held as text ──
    // The sources this pane's document holds, by what the parse that seeded
    // the room would have folded them to. One folded text that stands for
    // two different sources is no help, so it is dropped.
    const sources = new Map<string, string | null>();
    if (baselineBody.includes("$")) {
      parser.parse(baselineBody).descendants((node) => {
        if (!MATH_TYPES.has(node.type.name)) return true;
        const source = String(node.attrs.source ?? "");
        const key = fold(source);
        const known = sources.get(key);
        sources.set(key, known === undefined || known === source ? source : null);
        return false;
      });
    }
    const recover = (folded: string) => sources.get(fold(folded)) ?? null;

    const tr = state.tr;
    let formulas = 0;
    const edits: Array<{ from: number; to: number; content: PMNode | Fragment }> = [];
    doc.descendants((node, pos) => {
      if (pos < frontMatterEnd) return false;
      if (node.type.spec.code) return false;
      if (!node.isTextblock) return true;
      // A paragraph that is nothing but one `$$…$$` is display math.
      const only = node.childCount === 1 ? node.firstChild : null;
      if (node.type.name === "paragraph" && only?.isText && !only.marks.length) {
        const parts = splitMath(only.text ?? "");
        if (parts.length === 1 && parts[0].math && parts[0].text.startsWith("$$")) {
          const text = parts[0].text;
          // What an older build wrote for this paragraph, when the
          // document has no source that folds to it.
          const source = recover(text) ?? `$$\n${text.slice(2, -2).trim()}\n$$`;
          edits.push({ from: pos, to: pos + node.nodeSize, content: schema.nodes.mathBlock.create({ source }) });
          formulas += 1;
          return false;
        }
      }
      node.forEach((child, offset) => {
        if (!child.isText || child.marks.some((mark) => mark.type.spec.code)) return;
        const parts = splitMath(child.text ?? "");
        if (!parts.some((part) => part.math)) return;
        const pieces = parts.map((part) => {
          if (!part.math) return schema.text(part.text, child.marks);
          formulas += 1;
          return schema.nodes.mathInline.create({ source: recover(part.text) ?? part.text }, null, child.marks);
        });
        const from = pos + 1 + offset;
        edits.push({ from, to: from + child.nodeSize, content: Fragment.from(pieces) });
      });
      return false;
    });

    if (frontMatterEnd === 0 && edits.length === 0) return { kind: "none" };
    // From the end backwards, so no edit moves another's positions.
    for (const edit of edits.reverse()) tr.replaceWith(edit.from, edit.to, edit.content);
    if (frontMatterEnd > 0) {
      if (frontMatterEnd >= tr.doc.content.size) tr.replaceWith(0, tr.doc.content.size, schema.nodes.paragraph.create());
      else tr.delete(0, frontMatterEnd);
    }
    tr.setMeta("addToHistory", false);
    return { kind: "migrate", tr, frontMatterRemoved: frontMatterEnd > 0, formulas };
  } finally {
    parser.destroy();
  }
}
