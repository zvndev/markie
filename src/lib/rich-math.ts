// Math in the rich editor: real nodes that hold their TeX exactly as written.
//
// A math span is found by the read view's rule (remark-strict-math.ts,
// Pandoc's): `$…$` opens on a `$` followed by something other than whitespace
// and closes on a `$` that follows something other than whitespace and is not
// followed by a digit, so "$5 and $10" stays prices; `$$…$$` is math whatever
// it holds.
//
// Two nodes, both atoms whose one attribute is the source, delimiters
// included, byte for byte:
//
//   * mathBlock: display math standing on its own, `$$` at the start of a
//     block through the `$$` that closes it, with nothing after it but the
//     end of the block. Its lines are kept as they are. Before this node
//     display math was a paragraph of text, and the HTML parse on the way
//     into the editor folded its line breaks into spaces, so an edited
//     multi-line formula came back on one line.
//   * mathInline: every other span, in a sentence or not. Being one node,
//     neither markdown's escapes nor emphasis apply inside it, and its
//     line breaks survive too.
//
// Both are written back as their source and nothing else. They render with
// KaTeX the way the read view does (display math centred, inline math in the
// line), loaded the first time a formula is drawn, and a click on one while
// editing opens its source.
//
// The text node keeps a markdown spec of its own as well (MathAwareText): a
// `$x$` typed into a paragraph is text until the document is next read, and a
// room written before these nodes existed holds its math as text. Either way
// that text is written back unescaped, as before.
//
// These nodes are what make a room's schema version 2 (src/lib/collab.ts):
// a build without them cannot draw such a room, so the server keeps it out.
import { Node, mergeAttributes, type NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

// The parts of markdown-it (tiptap-markdown's parser) this uses, typed here
// rather than imported: markdown-it is tiptap-markdown's dependency, not ours.
interface Token {
  content: string;
  map: [number, number] | null;
  block: boolean;
  markup: string;
}
interface StateInline {
  src: string;
  pos: number;
  posMax: number;
  push(type: string, tag: string, nesting: number): Token;
}
interface StateBlock {
  src: string;
  bMarks: number[];
  eMarks: number[];
  tShift: number[];
  sCount: number[];
  blkIndent: number;
  line: number;
  isEmpty(line: number): boolean;
  getLines(begin: number, end: number, indent: number, keepLastLF: boolean): string;
  push(type: string, tag: string, nesting: number): Token;
}
interface MarkdownIt {
  inline: { ruler: { before(name: string, rule: string, fn: (state: StateInline, silent: boolean) => boolean): void } };
  block: {
    ruler: {
      before(name: string, rule: string, fn: (state: StateBlock, startLine: number, endLine: number, silent: boolean) => boolean, options?: { alt: string[] }): void;
    };
  };
  renderer: { rules: Record<string, (tokens: Token[], idx: number) => string> };
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

/** Whether `source` is exactly one math span, start to end. */
export function isMathSource(source: string): boolean {
  return source.length > 2 && mathSpanEnd(source, 0) === source.length;
}

/** The TeX inside a math source and whether it is display math. */
export function texOf(source: string, block: boolean): { tex: string; display: boolean } {
  const trimmed = source.trim();
  const double = trimmed.startsWith("$$") && trimmed.endsWith("$$") && trimmed.length >= 4;
  const tex = double ? trimmed.slice(2, -2) : trimmed.startsWith("$") && trimmed.endsWith("$") ? trimmed.slice(1, -1) : trimmed;
  // The read view (remark-math) draws `$$…$$` in a sentence inline, and on
  // its own as display math.
  return { tex: block ? tex.trim() : tex, display: block };
}

/**
 * The display block opening on `startLine`, as markdown-it sees the
 * document, or null: `$$` at the start of the block, one math span through
 * to the end of a line, and then a blank line or the end of the container.
 * Anything else stays a paragraph, its math inline. A block never interrupts
 * a paragraph, so a document's blocks are the ones it always had.
 */
function displayBlockAt(state: StateBlock, startLine: number, endLine: number): { source: string; nextLine: number } | null {
  if (state.sCount[startLine] - state.blkIndent >= 4) return null;
  const start = state.bMarks[startLine] + state.tShift[startLine];
  if (state.src.charCodeAt(start) !== DOLLAR || state.src.charCodeAt(start + 1) !== DOLLAR) return null;
  // The run of lines up to a blank line, each with its container's indent
  // removed (the opener's own up to three spaces go too, as a fence's do).
  const lineEnds: number[] = [];
  let text = state.src.slice(start, state.eMarks[startLine]);
  lineEnds.push(text.length);
  for (let line = startLine + 1; line < endLine; line++) {
    if (state.isEmpty(line) || state.sCount[line] < state.blkIndent) break;
    text += "\n" + state.getLines(line, line + 1, state.blkIndent, false);
    lineEnds.push(text.length);
  }
  const end = mathSpanEnd(text, 0);
  if (end === -1) return null;
  const lineIndex = lineEnds.findIndex((lineEnd) => end <= lineEnd);
  const lineEnd = lineEnds[lineIndex];
  // Only spaces may follow the closing `$$` on its line, and the block must
  // end there: text on the next line would make this a paragraph.
  if (text.slice(end, lineEnd).trim() !== "") return null;
  const nextLine = startLine + lineIndex + 1;
  if (nextLine < endLine && !state.isEmpty(nextLine) && state.sCount[nextLine] >= state.blkIndent) return null;
  return { source: text.slice(0, lineEnd), nextLine };
}

function mathBlockRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const found = displayBlockAt(state, startLine, endLine);
  if (!found) return false;
  if (silent) return true;
  const token = state.push("markie_math_block", "div", 0);
  token.block = true;
  token.content = found.source;
  token.map = [startLine, found.nextLine];
  state.line = found.nextLine;
  return true;
}

// markdown-it's own inline rule: a math span becomes one math token, so
// neither escapes nor emphasis apply inside it.
function mathInlineRule(state: StateInline, silent: boolean): boolean {
  const end = mathSpanEnd(state.src, state.pos, state.posMax);
  if (end === -1) return false;
  if (!silent) {
    const token = state.push("markie_math_inline", "span", 0);
    token.content = state.src.slice(state.pos, end);
  }
  state.pos = end;
  return true;
}

const escapeAttr = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const ready = new WeakSet<MarkdownIt>();

/** Teaches tiptap-markdown's markdown-it the two math rules, once. */
function setupMath(markdownit: MarkdownIt): void {
  if (ready.has(markdownit)) return;
  ready.add(markdownit);
  markdownit.inline.ruler.before("escape", "markie_math", mathInlineRule);
  markdownit.block.ruler.before("fence", "markie_math_block", mathBlockRule);
  // The source travels in an attribute: an attribute keeps its line breaks,
  // where text inside an element would be folded by the HTML parse.
  markdownit.renderer.rules.markie_math_inline = (tokens, idx) => {
    const source = escapeAttr(tokens[idx].content);
    return `<span data-markie-math="inline" data-source="${source}">${source}</span>`;
  };
  markdownit.renderer.rules.markie_math_block = (tokens, idx) => {
    const source = escapeAttr(tokens[idx].content);
    return `<div data-markie-math="block" data-source="${source}">${source}</div>\n`;
  };
}

// tiptap-markdown's text serializer escapes `<` and `>` so the HTML parse on
// the way back in reads them as text; markdown escapes are prosemirror's.
const escapeHTML = (value: string) => value.replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface SerializerState {
  text(text: string, escape?: boolean): void;
  closeBlock(node: PMNode): void;
  inTable?: boolean;
}

// A bare `|` ends a table cell. Math parsed out of a cell can never hold
// one (it would have split the cell), so this only touches what somebody
// typed into a formula inside a table.
const cellSafe = (source: string, state: SerializerState) =>
  state.inTable ? source.replace(/(^|[^\\])\|/g, "$1\\|") : source;

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
            // Display math held as text (a room from before mathBlock):
            // the paragraph is the formula.
            state.text(`$$\n${parts[0].text.slice(2, -2).trim()}\n$$`, false);
            return;
          }
          for (const part of parts) {
            if (part.math) state.text(part.text, false);
            else state.text(escapeHTML(part.text));
          }
        },
        parse: {
          // The math rules are the math nodes'.
        },
      },
    };
  },
});

// ── Rendering ─────────────────────────────────────────────────────────────

type Katex = typeof import("katex").default;
let katexLoad: Promise<Katex> | null = null;
let katexReady: Katex | null = null;

/** KaTeX, loaded the first time a formula is drawn. */
function loadKatex(): Promise<Katex> {
  katexLoad ??= import("katex").then((mod) => {
    katexReady = (mod as unknown as { default?: Katex }).default ?? (mod as unknown as Katex);
    return katexReady;
  });
  return katexLoad;
}

function drawMath(target: HTMLElement, source: string, block: boolean): void {
  const { tex, display } = texOf(source, block);
  const paint = (katex: Katex) => {
    if (!isMathSource(source.trim())) {
      target.textContent = source;
      target.classList.add("markie-math-source");
      return;
    }
    target.classList.remove("markie-math-source");
    // throwOnError off: a formula KaTeX cannot read is drawn in red, as the
    // read view draws it, never thrown out of the editor.
    target.innerHTML = katex.renderToString(tex, { displayMode: display, throwOnError: false });
  };
  if (katexReady) {
    paint(katexReady);
    return;
  }
  // Until KaTeX arrives the source stands in, so nothing jumps or is blank.
  target.textContent = source;
  target.classList.add("markie-math-source");
  void loadKatex().then(paint).catch(() => {
    // No KaTeX: the source is already showing.
  });
}

interface MathViewProps extends NodeViewRendererProps {
  block: boolean;
}

// The formula as KaTeX draws it, and on a click while editing, its source in
// a field: Enter (Cmd/Ctrl+Enter in a block) or leaving the field keeps the
// change, Escape puts it back. Emptying the field removes the formula.
function mathNodeView({ node: initial, getPos, editor, block }: MathViewProps) {
  let node = initial;
  const dom = document.createElement(block ? "div" : "span");
  dom.className = block ? "markie-math markie-math-block" : "markie-math markie-math-inline";
  dom.setAttribute("data-markie-math", block ? "block" : "inline");
  dom.contentEditable = "false";
  const view = document.createElement(block ? "div" : "span");
  dom.appendChild(view);
  let field: HTMLTextAreaElement | HTMLInputElement | null = null;

  const render = () => {
    dom.setAttribute("data-source", node.attrs.source);
    drawMath(view, String(node.attrs.source ?? ""), block);
  };

  const commit = (value: string | null) => {
    if (!field) return;
    const current = field;
    field = null;
    current.remove();
    view.style.display = "";
    dom.classList.remove("is-editing");
    const pos = typeof getPos === "function" ? getPos() : undefined;
    if (value === null || value === node.attrs.source || pos === undefined) {
      render();
      return;
    }
    const tr = editor.state.tr;
    if (value.trim() === "") tr.delete(pos, pos + node.nodeSize);
    else tr.setNodeMarkup(pos, undefined, { ...node.attrs, source: value });
    editor.view.dispatch(tr);
    editor.commands.focus();
  };

  const open = () => {
    if (field || !editor.isEditable) return;
    const source = String(node.attrs.source ?? "");
    const input = block ? document.createElement("textarea") : document.createElement("input");
    input.className = "markie-math-field";
    input.value = source;
    input.setAttribute("aria-label", block ? "Formula source" : "Inline formula source");
    input.spellcheck = false;
    if (input instanceof HTMLTextAreaElement) input.rows = Math.max(2, source.split("\n").length);
    else input.size = Math.max(4, source.length + 1);
    input.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (key === "Escape") { event.preventDefault(); commit(null); return; }
      if (key === "Enter" && (!block || (event as KeyboardEvent).metaKey || (event as KeyboardEvent).ctrlKey)) {
        event.preventDefault();
        commit(input.value);
      }
    });
    input.addEventListener("input", () => {
      if (input instanceof HTMLInputElement) input.size = Math.max(4, input.value.length + 1);
      else input.rows = Math.max(2, input.value.split("\n").length);
    });
    input.addEventListener("blur", () => commit(input.value));
    field = input;
    view.style.display = "none";
    dom.classList.add("is-editing");
    dom.appendChild(input);
    input.focus();
  };

  dom.addEventListener("mousedown", (event) => {
    if (field || !editor.isEditable) return;
    event.preventDefault();
    open();
  });

  render();
  return {
    dom,
    update(next: PMNode) {
      if (next.type !== node.type) return false;
      node = next;
      if (!field) render();
      return true;
    },
    selectNode() {
      dom.classList.add("ProseMirror-selectednode");
    },
    deselectNode() {
      dom.classList.remove("ProseMirror-selectednode");
    },
    // Typing in the source field is the field's, not the editor's.
    stopEvent(event: Event) {
      return !!field && field.contains(event.target as globalThis.Node);
    },
    ignoreMutation() {
      return true;
    },
    destroy() {
      field = null;
    },
  };
}

const sourceAttr = {
  source: {
    default: "",
    parseHTML: (element: HTMLElement) => element.getAttribute("data-source") ?? element.textContent ?? "",
    // The source is the node's whole meaning; it is rendered as the
    // element's text below, and as data-source so a copy and paste comes
    // back as the same formula.
    renderHTML: (attributes: Record<string, unknown>) => ({ "data-source": String(attributes.source ?? "") }),
  },
};

/** Inline math: `$…$`, or `$$…$$` inside a sentence. */
export const MathInline = Node.create({
  name: "mathInline",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return sourceAttr;
  },
  parseHTML() {
    return [{ tag: 'span[data-markie-math="inline"]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-markie-math": "inline" }), String(node.attrs.source ?? "")];
  },
  renderText({ node }) {
    return String(node.attrs.source ?? "");
  },
  addNodeView() {
    if (typeof document === "undefined") return null;
    return (props: NodeViewRendererProps) => mathNodeView({ ...props, block: false });
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerState, node: PMNode) {
          state.text(cellSafe(String(node.attrs.source ?? ""), state), false);
        },
        parse: { setup: setupMath, updateDOM: keepBreakAfterMath },
      },
    };
  },
});

// tiptap-markdown drops a line break that directly follows any element, to
// take away the "\n" markdown-it writes after each block. Inside a paragraph
// that "\n" is a soft line break, which reads as a space: dropped, the word
// after a formula ending a line was glued to it. A space is what the HTML
// parse would have made of the break anyway.
function keepBreakAfterMath(element: HTMLElement): void {
  for (const span of element.querySelectorAll('span[data-markie-math="inline"]')) {
    const next = span.nextSibling;
    if (next && next.nodeType === 3 && next.textContent?.startsWith("\n")) {
      next.textContent = " " + next.textContent.slice(1);
    }
  }
}

/** Display math on lines of its own, `$$` to `$$`. */
export const MathBlock = Node.create({
  name: "mathBlock",
  group: "block",
  atom: true,
  selectable: true,
  // Never a place the cursor lands inside; arrow keys step over it.
  defining: true,
  addAttributes() {
    return sourceAttr;
  },
  parseHTML() {
    return [{ tag: 'div[data-markie-math="block"]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-markie-math": "block" }), String(node.attrs.source ?? "")];
  },
  renderText({ node }) {
    return String(node.attrs.source ?? "");
  },
  addNodeView() {
    if (typeof document === "undefined") return null;
    return (props: NodeViewRendererProps) => mathNodeView({ ...props, block: true });
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerState, node: PMNode) {
          state.text(String(node.attrs.source ?? ""), false);
          state.closeBlock(node);
        },
        parse: { setup: setupMath },
      },
    };
  },
});
