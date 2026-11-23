// Comments on the reading screen, where there is no editor and no live room:
// only the rendered document. A thread's place is the words it quotes
// (src/lib/quote-anchor.ts in the shared renderer), so this file does the two
// things that need the DOM: read the document as the text a reader sees, and
// turn offsets in that text back into a highlight or out of a selection.
//
// Nothing here knows about threads, the server or React.

/** One text node, and where its text starts in the flat text. */
interface FlatNode {
  node: Text;
  at: number;
}

export interface FlatDom {
  /** The document's text, block after block, with a newline between blocks. */
  text: string;
  nodes: FlatNode[];
}

// Everything else starts a new line: a paragraph, a list item, a table cell,
// a line break. Matching ignores whitespace, so this only has to keep the
// quoted words readable ("end. Start", not "end.Start").
const INLINE = new Set([
  "A", "ABBR", "B", "BDI", "BDO", "CITE", "CODE", "DEL", "DFN", "EM", "I", "INS", "KBD", "MARK",
  "Q", "S", "SAMP", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TIME", "U", "VAR",
]);
const UNREAD = new Set(["SCRIPT", "STYLE", "TEMPLATE"]);

export function flattenDom(root: Element): FlatDom {
  const parts: string[] = [];
  const nodes: FlatNode[] = [];
  let length = 0;
  let broken = true;
  const breakLine = () => {
    if (broken) return;
    parts.push("\n");
    length += 1;
    broken = true;
  };
  const visit = (parent: Node) => {
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) {
        const text = (child as Text).data;
        if (!text) continue;
        nodes.push({ node: child as Text, at: length });
        parts.push(text);
        length += text.length;
        if (/\S/.test(text)) broken = false;
      } else if (child.nodeType === 1) {
        const tag = (child as Element).tagName.toUpperCase();
        if (UNREAD.has(tag)) continue;
        const block = !INLINE.has(tag);
        if (block) breakLine();
        visit(child);
        if (block) breakLine();
      }
    }
  };
  visit(root);
  return { text: parts.join(""), nodes };
}

/** The index of the node holding the character at `offset`, or -1. */
function nodeAt(flat: FlatDom, offset: number): number {
  let low = 0;
  let high = flat.nodes.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const { node, at } = flat.nodes[middle];
    if (offset < at) high = middle - 1;
    else if (offset >= at + node.length) low = middle + 1;
    else return middle;
  }
  return -1;
}

/**
 * Where a selection's ends fall in the flat text, or null when it holds none
 * of the document's text.
 */
export function rangeOffsets(flat: FlatDom, range: Range): { start: number; end: number } | null {
  let start = -1;
  let end = -1;
  try {
    for (const { node, at } of flat.nodes) {
      // Wholly before the selection.
      if (range.comparePoint(node, node.length) < 0) continue;
      // Wholly after it.
      if (range.comparePoint(node, 0) > 0) break;
      const from = node === range.startContainer ? range.startOffset : 0;
      const to = node === range.endContainer ? range.endOffset : node.length;
      if (start === -1) start = at + from;
      end = at + to;
    }
  } catch {
    return null;
  }
  return start !== -1 && end > start ? { start, end } : null;
}

export const THREAD_MARK_ATTR = "data-comment-thread";
const MARK_CLASS = "m-comment-mark";

export interface Placement {
  id: string;
  start: number;
  end: number;
}

/**
 * Wraps each placement's text in <mark> elements and returns them. Where two
 * threads cover the same words the earlier one in `placements` owns them.
 * Whitespace between blocks is left alone: a <mark> has no business as the
 * child of a list or a table row.
 */
export function applyMarks(flat: FlatDom, placements: readonly Placement[]): HTMLElement[] {
  // node index → the pieces of it to wrap, as local offsets.
  const perNode = new Map<number, Array<{ id: string; from: number; to: number }>>();
  for (const placement of placements) {
    if (placement.end <= placement.start) continue;
    let index = nodeAt(flat, placement.start);
    if (index === -1) continue;
    for (; index < flat.nodes.length; index++) {
      const { node, at } = flat.nodes[index];
      if (at >= placement.end) break;
      const from = Math.max(0, placement.start - at);
      const to = Math.min(node.length, placement.end - at);
      if (to <= from) continue;
      const list = perNode.get(index) ?? [];
      list.push({ id: placement.id, from, to });
      perNode.set(index, list);
    }
  }

  const marks: HTMLElement[] = [];
  for (const [index, wanted] of perNode) {
    const { node } = flat.nodes[index];
    const doc = node.ownerDocument;
    if (!doc || !node.parentNode) continue;
    // Cut the node at every edge, and give each piece to the first thread on it.
    const cuts = Array.from(new Set(wanted.flatMap((piece) => [piece.from, piece.to]))).sort((a, b) => a - b);
    const pieces: Array<{ id: string; from: number; to: number }> = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const owner = wanted.find((piece) => piece.from <= cuts[i] && piece.to >= cuts[i + 1]);
      if (owner && /\S/.test(node.data.slice(cuts[i], cuts[i + 1]))) pieces.push({ id: owner.id, from: cuts[i], to: cuts[i + 1] });
    }
    // From the end, so earlier offsets stay true as the node is split.
    const made: HTMLElement[] = [];
    for (let i = pieces.length - 1; i >= 0; i--) {
      const piece = pieces[i];
      if (piece.to < node.length) node.splitText(piece.to);
      const middle = piece.from > 0 ? node.splitText(piece.from) : node;
      const mark = doc.createElement("mark");
      mark.className = MARK_CLASS;
      mark.setAttribute(THREAD_MARK_ATTR, piece.id);
      middle.parentNode!.insertBefore(mark, middle);
      mark.appendChild(middle);
      made.push(mark);
    }
    // Back in reading order.
    marks.push(...made.reverse());
  }
  return marks;
}

/** Takes the marks back out, leaving the document's own text as it was. */
export function clearMarks(marks: readonly HTMLElement[]): void {
  const parents = new Set<Node>();
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parents.add(parent);
  }
  for (const parent of parents) parent.normalize();
}

/** The thread whose highlight was tapped, if `target` is inside one of ours. */
export function threadAt(target: EventTarget | null, marks: readonly HTMLElement[]): string | null {
  const mark = (target as Element | null)?.closest?.(`mark[${THREAD_MARK_ATTR}]`) as HTMLElement | null;
  return mark && marks.includes(mark) ? mark.getAttribute(THREAD_MARK_ATTR) : null;
}
