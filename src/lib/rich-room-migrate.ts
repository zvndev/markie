// A room written before this build: brought up to date, or refused.
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
// This plans the change; RichView sends it as one update that the server
// accepts from exactly one client (the editor-model claim, collab.ts
// MODEL_KEY), so two clients bringing the same room up to date at once
// cannot both add their copy of every formula.
//
// Math: each `$…$` span held as text becomes a math node, its source taken
// from the document the pane opened on wherever that source folds to the
// same text (so the lines come back). A span that is literal text in that
// document (`\$x\$`, whose escapes the older room lost) stays text. A span
// the document does not have at all was typed in the room, where an older
// build wrote it as math, so it becomes math.
//
// Front matter: its nodes come out when they are exactly what the document's
// front matter parses to. When they are not (the front matter changed since
// the room was seeded, as agents' `markie:` front matter often does), the
// room's leading rule and the nodes after it come out only if what is left
// is, byte for byte, the body the pane opened on: the stored copy's front
// matter wins anyway, and nothing of the body can go. Otherwise the room's
// front matter cannot be told from content (someone edited it there, or the
// room moved on too), nothing is changed, and the room is refused: this pane
// goes back to the local copy rather than write front matter twice or drop
// a rule.
import { Editor } from "@tiptap/core";
import { Fragment, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { richBaseExtensions } from "@/lib/rich-extensions";
import { splitMath } from "@/lib/rich-math";
import { formatMarkdownTables } from "@/lib/format-tables";
import { preserveBlocks } from "@/lib/rich-block-preserve";
import { createBlockNormalizer } from "@/lib/rich-roundtrip";

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

// Old seeding of front matter makes a rule and then a handful of nodes; a
// search past this many leading nodes is not looking at front matter.
const MAX_FRONT_MATTER_NODES = 24;

/**
 * What to do with a room an older build seeded, for a pane that opened on
 * `frontMatter` + `baselineBody`.
 */
export function planLegacyRoom(
  editor: Pick<Editor, "state" | "schema" | "storage">,
  { frontMatter, baselineBody }: { frontMatter: string; baselineBody: string }
): LegacyRoomPlan {
  const { state, schema } = editor;
  const doc = state.doc;
  const serializer = (editor.storage as unknown as { markdown: MarkdownStorage }).markdown.serializer;
  const parser = parserFor(schema);
  const normalizer = createBlockNormalizer();
  // What a live pane writes for `body`: the room's text with every block it
  // only reformatted put back as the opened body's bytes.
  const writes = (body: PMNode) =>
    preserveBlocks(baselineBody, formatMarkdownTables(serializer.serialize(body)), normalizer.normalize);
  try {
    // ── math held as text ──
    // The opened document's formulas, by what the parse that seeded the
    // room would have folded them to (one folded text for two different
    // sources is no help, so it is dropped), and its literal dollar spans.
    const sources = new Map<string, string | null>();
    const literal = new Set<string>();
    if (baselineBody.includes("$")) {
      parser.parse(baselineBody).descendants((node) => {
        if (MATH_TYPES.has(node.type.name)) {
          const source = String(node.attrs.source ?? "");
          const key = fold(source);
          const known = sources.get(key);
          sources.set(key, known === undefined || known === source ? source : null);
          return false;
        }
        if (node.isText) for (const part of splitMath(node.text ?? "")) if (part.math) literal.add(fold(part.text));
        return true;
      });
    }
    // The source a span held as text stands for, or null when it is text.
    const sourceFor = (span: string, asWritten: string): string | null => {
      const recovered = sources.get(fold(span));
      if (recovered) return recovered;
      if (literal.has(fold(span))) return null;
      return asWritten;
    };

    const tr = state.tr;
    let formulas = 0;
    const edits: Array<{ from: number; to: number; content: PMNode | Fragment }> = [];
    doc.descendants((node, pos) => {
      if (node.type.spec.code) return false;
      if (!node.isTextblock) return true;
      // A paragraph that is nothing but one `$$…$$` is display math.
      const only = node.childCount === 1 ? node.firstChild : null;
      if (node.type.name === "paragraph" && only?.isText && !only.marks.length) {
        const parts = splitMath(only.text ?? "");
        if (parts.length === 1 && parts[0].math && parts[0].text.startsWith("$$")) {
          const text = parts[0].text;
          // What an older build wrote for such a paragraph.
          const source = sourceFor(text, `$$\n${text.slice(2, -2).trim()}\n$$`);
          if (source !== null) {
            edits.push({ from: pos, to: pos + node.nodeSize, content: schema.nodes.mathBlock.create({ source }) });
            formulas += 1;
          }
          return false;
        }
      }
      node.forEach((child, offset) => {
        if (!child.isText || child.marks.some((mark) => mark.type.spec.code)) return;
        const parts = splitMath(child.text ?? "");
        if (!parts.some((part) => part.math)) return;
        let changed = false;
        const pieces = parts.map((part) => {
          const source = part.math ? sourceFor(part.text, part.text) : null;
          if (source === null) return schema.text(part.text, child.marks);
          changed = true;
          formulas += 1;
          return schema.nodes.mathInline.create({ source }, null, child.marks);
        });
        if (!changed) return;
        const from = pos + 1 + offset;
        edits.push({ from, to: from + child.nodeSize, content: Fragment.from(pieces) });
      });
      return false;
    });
    // From the end backwards, so no edit moves another's positions.
    for (const edit of [...edits].reverse()) tr.replaceWith(edit.from, edit.to, edit.content);

    // ── the front matter's nodes ──
    const migrated = tr.doc;
    const room: PMNode[] = [];
    migrated.forEach((child) => room.push(child));
    const sizeOf = (nodes: PMNode[]) => nodes.reduce((size, node) => size + node.nodeSize, 0);
    const docOf = (nodes: PMNode[]) =>
      schema.topNodeType.create(null, nodes.length ? nodes : [schema.nodes.paragraph.create()]);
    let frontMatterEnd = 0;
    if (frontMatter) {
      const wanted = blocksOf(parser.parse(frontMatter));
      const leading = room.slice(0, wanted.length);
      if (
        wanted.length > 0 &&
        leading.length === wanted.length &&
        serializer.serialize(docOf(leading)) === serializer.serialize(docOf(wanted))
      ) {
        frontMatterEnd = sizeOf(leading);
      }
    }
    if (frontMatterEnd === 0 && room[0]?.type.name === "horizontalRule" && writes(migrated) !== baselineBody) {
      // Front matter other than the stored copy's, or none in the stored
      // copy any more: the nodes go only if the rest is exactly the body.
      for (let k = 1; k <= Math.min(MAX_FRONT_MATTER_NODES, room.length - 1); k++) {
        if (writes(docOf(room.slice(k))) === baselineBody) {
          frontMatterEnd = sizeOf(room.slice(0, k));
          break;
        }
      }
      // A document without front matter keeps a room that starts with a
      // rule as it is: that rule may be somebody's.
      if (frontMatterEnd === 0 && frontMatter && !startsWithRule(baselineBody)) return { kind: "refuse" };
    }

    if (frontMatterEnd === 0 && edits.length === 0) return { kind: "none" };
    if (frontMatterEnd > 0) {
      if (frontMatterEnd >= tr.doc.content.size) tr.replaceWith(0, tr.doc.content.size, schema.nodes.paragraph.create());
      else tr.delete(0, frontMatterEnd);
    }
    tr.setMeta("addToHistory", false);
    return { kind: "migrate", tr, frontMatterRemoved: frontMatterEnd > 0, formulas };
  } finally {
    normalizer.destroy();
    parser.destroy();
  }
}
