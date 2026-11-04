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
// Front matter, only for a pane whose copy has some: its nodes come out when
// they are exactly what that front matter parses to. When they are not (it
// changed since the room was seeded, as agents' `markie:` front matter often
// does), the room's leading block comes out only if it is front-matter
// shaped (a rule, YAML-looking lines, and the closing `---` as the older
// build read it) and everything after it is, byte for byte, the body the
// pane opened on. The stored copy's front matter wins anyway, and nothing
// typed in the room can go. Otherwise (someone typed in the room, or edited
// its front matter there) nothing is changed and the room is refused: this
// pane goes back to the local copy. A pane whose copy has no front matter
// never takes anything out.
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

// A line of YAML as the older build's parse left it: a key and a colon, or a
// list item's `key: value`. "Live note" is not one.
const YAML_KEY = /^\s*["']?[\w.-][\w .\-"']*:(\s|$)/;

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
    // Whether `nodes` is what an older build made of some front matter
    // block: the opening `---` as a rule, YAML lines as paragraphs or lists,
    // and the closing `---` either underlining the last line (a level-2
    // heading) or on its own (a rule). Proved by writing that YAML back and
    // reading it again the way the older build did.
    const frontMatterShaped = (nodes: PMNode[]): boolean => {
      if (nodes.length < 2 || nodes[0].type.name !== "horizontalRule") return false;
      const last = nodes[nodes.length - 1];
      const underlined = last.type.name === "heading" && last.attrs.level === 2;
      if (!underlined && last.type.name !== "horizontalRule") return false;
      const middle = nodes.slice(1, -1);
      const lines = middle.filter((node) => node.isTextblock).map((node) => node.textContent);
      if (underlined) lines.push(last.textContent);
      if (!lines.every((line) => YAML_KEY.test(line))) return false;
      const yaml = middle.length ? serializer.serialize(docOf(middle)) : "";
      const block = underlined
        ? `---\n${yaml ? `${yaml}\n\n` : ""}${last.textContent}\n---\n`
        : `---\n${yaml ? `${yaml}\n\n` : ""}---\n`;
      return serializer.serialize(docOf(blocksOf(parser.parse(block)))) === serializer.serialize(docOf(nodes));
    };
    if (frontMatterEnd === 0 && frontMatter && room[0]?.type.name === "horizontalRule" && !startsWithRule(baselineBody)) {
      // The room starts with front matter other than the stored copy's (it
      // changed since the room was seeded). That block comes out only when
      // it is front-matter shaped and everything after it is, byte for byte,
      // the body this pane opened on: nothing typed in the room is lost.
      // Anything else, the room is refused as it is.
      for (let k = 2; k <= Math.min(MAX_FRONT_MATTER_NODES, room.length); k++) {
        const prefix = room.slice(0, k);
        if (!frontMatterShaped(prefix)) continue;
        if (writes(docOf(room.slice(k))) === baselineBody) frontMatterEnd = sizeOf(prefix);
        break;
      }
      if (frontMatterEnd === 0) return { kind: "refuse" };
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
