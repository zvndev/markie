// Math stays as written in the rich editor.
//
// The rich editor has no math node: `$e^{i\pi}$` is text in a paragraph. Two
// things used to happen to it on the way through. The parser read TeX's
// escapes as markdown's, so `\,` (a thin space) became a bare comma and
// `\{` a bare brace. The serializer then escaped every backslash, so `\pi`
// was written back as `\\pi`, and KaTeX drew a line break and the letters
// "pi". Block preservation (rich-block-preserve.ts) hid both for blocks
// nobody touched; a paragraph somebody did edit came back broken.
//
// So math is opaque in both directions, by the same rule the read view uses
// (remark-strict-math.ts, Pandoc's): `$…$` opens on a `$` followed by
// something other than whitespace and closes on a `$` that follows something
// other than whitespace and is not followed by a digit, so "$5 and $10" stays
// prices; `$$…$$` is math whatever it holds. The parser keeps a math span's
// source as literal text, and the serializer writes it back without
// escaping. A paragraph that is nothing but `$$…$$` is display math, and is
// written on lines of its own, as display math is written.
//
// The schema is unchanged: this is the ordinary text node with a markdown
// spec of its own (tiptap-markdown's default text spec plus the math rule),
// so rooms and documents written by other builds read exactly as before.
import { Node } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

// The parts of markdown-it (tiptap-markdown's parser) this uses, typed here
// rather than imported: markdown-it is tiptap-markdown's dependency, not ours.
interface StateInline {
  src: string;
  pos: number;
  posMax: number;
  push(type: string, tag: string, nesting: number): { content: string };
}
interface MarkdownIt {
  inline: { ruler: { before(name: string, rule: string, fn: (state: StateInline, silent: boolean) => boolean): void } };
}

const DOLLAR = 0x24;
const BACKSLASH = 0x5c;

const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);
const isDigit = (ch: string | undefined) => ch !== undefined && ch >= "0" && ch <= "9";

/** The end (exclusive) of a math span opening at `from` in `src`, or -1. */
export function mathSpanEnd(src: string, from: number, to = src.length): number {
  if (src.charCodeAt(from) !== DOLLAR) return -1;
  if (from > 0 && src.charCodeAt(from - 1) === BACKSLASH) return -1;
  const display = src.charCodeAt(from + 1) === DOLLAR;
  if (display) {
    // `$$$` and longer runs are not math by any rule this editor knows.
    if (src.charCodeAt(from + 2) === DOLLAR) return -1;
    for (let i = from + 2; i < to - 1; i++) {
      if (src.charCodeAt(i) === BACKSLASH) { i++; continue; }
      if (src.charCodeAt(i) === DOLLAR && src.charCodeAt(i + 1) === DOLLAR) {
        return i > from + 2 && src.slice(from + 2, i).trim() !== "" ? i + 2 : -1;
      }
    }
    return -1;
  }
  if (isSpace(src[from + 1]) || from + 1 >= to) return -1;
  for (let i = from + 1; i < to; i++) {
    const code = src.charCodeAt(i);
    if (code === BACKSLASH) { i++; continue; }
    if (code !== DOLLAR) continue;
    if (!isSpace(src[i - 1]) && !(i + 1 < to && isDigit(src[i + 1])) && src.charCodeAt(i + 1) !== DOLLAR) {
      return i > from + 1 ? i + 1 : -1;
    }
  }
  return -1;
}

/** `text` cut into plain runs and math spans, in order. */
export function splitMath(text: string): Array<{ math: boolean; text: string }> {
  const parts: Array<{ math: boolean; text: string }> = [];
  let plainFrom = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== DOLLAR) continue;
    const end = mathSpanEnd(text, i);
    if (end === -1) {
      // A `$$` that opens nothing is not two chances to open.
      if (text.charCodeAt(i + 1) === DOLLAR) i++;
      continue;
    }
    if (i > plainFrom) parts.push({ math: false, text: text.slice(plainFrom, i) });
    parts.push({ math: true, text: text.slice(i, end) });
    plainFrom = end;
    i = end - 1;
  }
  if (plainFrom < text.length) parts.push({ math: false, text: text.slice(plainFrom) });
  return parts;
}

// markdown-it's own inline rule: a math span becomes one literal text token,
// so neither escapes nor emphasis apply inside it.
function mathRule(state: StateInline, silent: boolean): boolean {
  const end = mathSpanEnd(state.src, state.pos, state.posMax);
  if (end === -1) return false;
  if (!silent) {
    const token = state.push("text", "", 0);
    token.content = state.src.slice(state.pos, end);
  }
  state.pos = end;
  return true;
}

const ready = new WeakSet<MarkdownIt>();

// tiptap-markdown's text serializer escapes `<` and `>` so the HTML parse on
// the way back in reads them as text; markdown escapes are prosemirror's.
const escapeHTML = (value: string) => value.replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface SerializerState {
  text(text: string, escape?: boolean): void;
}

/** The text node, with math kept as written. Replaces StarterKit's `text`. */
export const MathAwareText = Node.create({
  name: "text",
  group: "inline",
  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerState, node: PMNode, parent: PMNode) {
          const text = node.text ?? "";
          const parts = splitMath(text);
          if (parts.length === 1 && parts[0].math && parts[0].text.startsWith("$$") && parent?.type.name === "paragraph" && parent.childCount === 1) {
            // Display math: the paragraph is the formula.
            state.text(`$$\n${parts[0].text.slice(2, -2).trim()}\n$$`, false);
            return;
          }
          for (const part of parts) {
            if (part.math) state.text(part.text, false);
            else state.text(escapeHTML(part.text));
          }
        },
        parse: {
          setup(markdownit: MarkdownIt) {
            if (ready.has(markdownit)) return;
            ready.add(markdownit);
            markdownit.inline.ruler.before("escape", "markie_math", mathRule);
          },
        },
      },
    };
  },
});
