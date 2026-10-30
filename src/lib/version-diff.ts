// "Highlight changes" for version history: what a version added in green, what
// it removed struck through in red, word by word inside a changed line.
//
// The rendered view runs the ordinary markdown renderer once, over a merged
// document: the newer text with the removed text put back. Changes are marked
// in two ways so the markdown still parses:
//   - Inside a changed line, private-use sentinel characters bracket inserted
//     and removed words. They are plain text to the parser, so they survive
//     into the HTML, where markDiffHtml turns them into <ins> and <del>. A
//     line's list, heading or quote prefix stays outside the marks, so a
//     changed list item is still a list item.
//   - A block that only one side has, or one that is not safe to mark word by
//     word (a code fence whose opener changed, math, raw HTML, a table whose
//     shape changed), is wrapped whole in a <div> the stylesheet colours.
//
// The source view (plain text, CSV, Darkmown) uses the same line merge with no
// markdown rules and renders the sentinels as spans.

export const INS_OPEN = "";
export const INS_CLOSE = "";
export const DEL_OPEN = "";
export const DEL_CLOSE = "";
const SENTINELS = /[-]/g;

/** Past this many lines a side, highlighting is skipped: the view still shows the version. */
export const MAX_DIFF_LINES = 6000;
const MAX_WORD_TOKENS = 1500;

// ---- LCS over arbitrary tokens ----

type Op<T> = { kind: "same" | "ins" | "del"; value: T };

function lcsOps<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean = (x, y) => x === y): Op<T>[] {
  // Trim the common head and tail first: most edits touch a small middle.
  let start = 0;
  while (start < a.length && start < b.length && eq(a[start], b[start])) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && eq(a[endA - 1], b[endB - 1])) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  const table: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) table.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = eq(midA[i], midB[j])
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops: Op<T>[] = a.slice(0, start).map((value) => ({ kind: "same", value }));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(midA[i], midB[j])) {
      ops.push({ kind: "same", value: midB[j] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ kind: "del", value: midA[i++] });
    } else {
      ops.push({ kind: "ins", value: midB[j++] });
    }
  }
  while (i < n) ops.push({ kind: "del", value: midA[i++] });
  while (j < m) ops.push({ kind: "ins", value: midB[j++] });
  for (const value of b.slice(endB)) ops.push({ kind: "same", value });
  return ops;
}

// ---- words ----

export interface DiffSpan {
  kind: "same" | "ins" | "del";
  text: string;
}

// Words, runs of whitespace, and single punctuation marks, so "fox." against
// "fox!" changes one character's token rather than the word.
function tokens(text: string): string[] {
  return text.match(/[\p{L}\p{N}_'’]+|\s+|[^\p{L}\p{N}_'’\s]/gu) ?? [];
}

/** Word-level difference between two strings, adjacent spans of a kind merged. */
export function wordDiff(before: string, after: string): DiffSpan[] {
  const a = tokens(before);
  const b = tokens(after);
  const ops: Op<string>[] =
    a.length + b.length > MAX_WORD_TOKENS
      ? [
          ...(before ? [{ kind: "del" as const, value: before }] : []),
          ...(after ? [{ kind: "ins" as const, value: after }] : []),
        ]
      : lcsOps(a, b);
  // One changed region at a time: the removed text, then the added text. A
  // run of whitespace that both sides kept, between two changes, joins the
  // region, so "quick brown" to "slow red" reads as one replaced phrase and
  // not as four alternating fragments.
  const spans: DiffSpan[] = [];
  let del = "";
  let ins = "";
  const flush = () => {
    if (del) spans.push({ kind: "del", text: del });
    if (ins) spans.push({ kind: "ins", text: ins });
    del = "";
    ins = "";
  };
  const pushSame = (text: string) => {
    const last = spans[spans.length - 1];
    if (last && last.kind === "same") last.text += text;
    else spans.push({ kind: "same", text });
  };
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.kind === "del") del += op.value;
    else if (op.kind === "ins") ins += op.value;
    else if ((del || ins) && /^\s+$/.test(op.value) && ops[k + 1] && ops[k + 1].kind !== "same") {
      del += op.value;
      ins += op.value;
    } else {
      flush();
      pushSame(op.value);
    }
  }
  flush();
  return spans;
}

/** How much two strings share, by words, from 0 (nothing) to 1 (the same). */
export function similarity(before: string, after: string): number {
  if (before.trim() === after.trim()) return 1;
  const count = (text: string) => (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  let same = 0;
  let del = 0;
  let ins = 0;
  for (const s of wordDiff(before, after)) {
    if (s.kind === "same") same += count(s.text);
    else if (s.kind === "del") del += count(s.text);
    else ins += count(s.text);
  }
  const total = 2 * same + del + ins;
  return total === 0 ? 0 : (2 * same) / total;
}

function wrap(text: string, open: string, close: string): string {
  // Keep surrounding whitespace outside the marks: a mark that opens on a
  // space draws a coloured gap, and one that ends a line on a space swallows
  // markdown's hard break.
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (!m || !m[2]) return text;
  return `${m[1]}${open}${m[2]}${close}${m[3]}`;
}

function markedWords(before: string, after: string): string {
  return wordDiff(before, after)
    .map((s) =>
      s.kind === "same" ? s.text : s.kind === "ins" ? wrap(s.text, INS_OPEN, INS_CLOSE) : wrap(s.text, DEL_OPEN, DEL_CLOSE)
    )
    .join("");
}

// ---- lines ----

export function strip(text: string): string {
  return text.replace(SENTINELS, "");
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.split("\n");
}

// A line's structural prefix: indentation, list markers, task boxes, heading
// hashes, quote markers. Marks go after it so the line keeps its shape.
const PREFIX = /^(\s*(?:>\s?)*\s*(?:(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+)?)/;

function prefixOf(line: string): string {
  return PREFIX.exec(line)?.[1] ?? "";
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
}

// Lines where words are not safe to mark inside: raw HTML tags (a mark inside
// a tag would break it) and math (a mark inside $…$ is not a symbol).
function unmarkable(line: string): boolean {
  return /<\/?[A-Za-z]/.test(line) || line.includes("$");
}

function wholeLine(line: string, open: string, close: string, structural: boolean): string {
  if (!structural) return wrap(line, open, close);
  if (isTableRow(line)) {
    if (isTableSeparator(line)) return line;
    return `|${cells(line).map((c) => wrap(c, open, close)).join("|")}|`;
  }
  const prefix = prefixOf(line);
  return prefix + wrap(line.slice(prefix.length), open, close);
}

function changedLine(before: string, after: string, structural: boolean): string[] {
  if (!structural) return [markedWords(before, after)];
  if (isTableRow(before) && isTableRow(after)) {
    const a = cells(before);
    const b = cells(after);
    if (a.length === b.length && !isTableSeparator(after)) {
      return [`|${b.map((cell, i) => markedWords(a[i], cell)).join("|")}|`];
    }
    // A row that changed shape cannot share one row: show both rows.
    return [wholeLine(before, DEL_OPEN, DEL_CLOSE, true), wholeLine(after, INS_OPEN, INS_CLOSE, true)];
  }
  const pa = prefixOf(before);
  const pb = prefixOf(after);
  if (pa.trim() !== pb.trim() || unmarkable(before) || unmarkable(after)) {
    return [wholeLine(before, DEL_OPEN, DEL_CLOSE, true), wholeLine(after, INS_OPEN, INS_CLOSE, true)];
  }
  return [pb + markedWords(before.slice(pa.length), after.slice(pb.length))];
}

/**
 * Merge two runs of lines into one, marking what changed. Unmatched lines are
 * paired in order when they are alike enough to read as an edit; the rest are
 * whole removed or added lines.
 */
function mergeLines(before: string[], after: string[], structural: boolean): string[] {
  const out: string[] = [];
  const ops = lcsOps(before, after);
  let dels: string[] = [];
  let ins: string[] = [];
  const flush = () => {
    const pairs = Math.min(dels.length, ins.length);
    let d = 0;
    let i = 0;
    while (d < dels.length || i < ins.length) {
      if (d < dels.length && i < ins.length && d < pairs && similarity(dels[d], ins[i]) >= 0.35) {
        out.push(...changedLine(dels[d++], ins[i++], structural));
      } else if (d < dels.length && (i >= ins.length || d <= i)) {
        out.push(wholeLine(dels[d++], DEL_OPEN, DEL_CLOSE, structural));
      } else {
        out.push(wholeLine(ins[i++], INS_OPEN, INS_CLOSE, structural));
      }
    }
    dels = [];
    ins = [];
  };
  for (const op of ops) {
    if (op.kind === "same") {
      flush();
      out.push(op.value);
    } else if (op.kind === "del") dels.push(op.value);
    else ins.push(op.value);
  }
  flush();
  return out;
}

// ---- markdown blocks ----

type BlockKind = "text" | "fence" | "math" | "html";

interface Block {
  text: string;
  kind: BlockKind;
}

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;

// Blocks separated by blank lines, with a fenced code block or a $$ math block
// kept whole however many blank lines it holds.
function splitBlocks(markdown: string): Block[] {
  const lines = splitLines(markdown);
  const blocks: Block[] = [];
  let cur: string[] = [];
  let kind: BlockKind = "text";
  let fence: string | null = null;
  let math = false;
  const push = () => {
    if (cur.length) blocks.push({ text: cur.join("\n"), kind });
    cur = [];
    kind = "text";
  };
  for (const line of lines) {
    if (fence) {
      cur.push(line);
      if (line.trim().startsWith(fence)) {
        fence = null;
        push();
      }
      continue;
    }
    if (math) {
      cur.push(line);
      if (line.trim().endsWith("$$")) {
        math = false;
        push();
      }
      continue;
    }
    const opener = FENCE_OPEN.exec(line);
    if (opener) {
      push();
      fence = opener[1];
      kind = "fence";
      cur.push(line);
      continue;
    }
    if (line.trim().startsWith("$$")) {
      push();
      kind = "math";
      cur.push(line);
      if (!(line.trim().length > 2 && line.trim().endsWith("$$"))) math = true;
      else push();
      continue;
    }
    if (line.trim() === "") {
      push();
      continue;
    }
    if (!cur.length && /^\s{0,3}<[A-Za-z!/]/.test(line)) kind = "html";
    cur.push(line);
  }
  push();
  return blocks;
}

function wrapBlock(block: Block, cls: "ins" | "del"): string {
  // CommonMark: an HTML block ends at a blank line, so the markdown between
  // the two divs is parsed as markdown and lands inside the div.
  return `<div class="markie-vh-block markie-vh-${cls}">\n\n${block.text}\n\n</div>`;
}

function mergeBlockPair(before: Block, after: Block): string[] {
  if (before.kind !== after.kind || after.kind === "math" || after.kind === "html") {
    return [wrapBlock(before, "del"), wrapBlock(after, "ins")];
  }
  const a = splitLines(before.text);
  const b = splitLines(after.text);
  if (after.kind === "fence") {
    // Inside a fence, lines are verbatim. The fence lines themselves must not
    // be marked, or the fence stops being one.
    if (a[0] !== b[0] || a.length < 2 || b.length < 2) return [wrapBlock(before, "del"), wrapBlock(after, "ins")];
    const closeA = FENCE_OPEN.test(a[a.length - 1]) ? a.length - 1 : a.length;
    const closeB = FENCE_OPEN.test(b[b.length - 1]) ? b.length - 1 : b.length;
    const body = mergeLines(a.slice(1, closeA), b.slice(1, closeB), false);
    return [[b[0], ...body, ...b.slice(closeB)].join("\n")];
  }
  if (similarity(before.text, after.text) < 0.3) return [wrapBlock(before, "del"), wrapBlock(after, "ins")];
  return [mergeLines(a, b, true).join("\n")];
}

export interface MarkedDocument {
  /** The text to render, sentinels and block wrappers included. */
  text: string;
  /** Whether anything differs. */
  changed: boolean;
  /** True when the document was too large to compare; text is then `after` as is. */
  skipped: boolean;
}

/** Merge two markdown documents for the rendered "Highlight changes" view. */
export function markMarkdownChanges(beforeRaw: string, afterRaw: string): MarkedDocument {
  const before = strip(beforeRaw);
  const after = strip(afterRaw);
  if (before === after) return { text: after, changed: false, skipped: false };
  if (splitLines(before).length > MAX_DIFF_LINES || splitLines(after).length > MAX_DIFF_LINES) {
    return { text: after, changed: true, skipped: true };
  }
  const a = splitBlocks(before);
  const b = splitBlocks(after);
  const ops = lcsOps(a, b, (x, y) => x.text === y.text);
  const out: string[] = [];
  let dels: Block[] = [];
  let ins: Block[] = [];
  const flush = () => {
    const pairs = Math.min(dels.length, ins.length);
    for (let k = 0; k < pairs; k++) out.push(...mergeBlockPair(dels[k], ins[k]));
    for (const d of dels.slice(pairs)) out.push(wrapBlock(d, "del"));
    for (const i of ins.slice(pairs)) out.push(wrapBlock(i, "ins"));
    dels = [];
    ins = [];
  };
  for (const op of ops) {
    if (op.kind === "same") {
      flush();
      out.push(op.value.text);
    } else if (op.kind === "del") dels.push(op.value);
    else ins.push(op.value);
  }
  flush();
  return { text: out.join("\n\n") + "\n", changed: true, skipped: false };
}

/** Merge two plain-text documents for the source "Highlight changes" view. */
export function markSourceChanges(beforeRaw: string, afterRaw: string): MarkedDocument {
  const before = strip(beforeRaw);
  const after = strip(afterRaw);
  if (before === after) return { text: after, changed: false, skipped: false };
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return { text: after, changed: true, skipped: true };
  return { text: mergeLines(a, b, false).join("\n"), changed: true, skipped: false };
}

/** Split sentinel-marked text into spans, for the source view. */
export function markedSpans(text: string): DiffSpan[] {
  const spans: DiffSpan[] = [];
  let kind: DiffSpan["kind"] = "same";
  let buf = "";
  const push = () => {
    if (buf) spans.push({ kind, text: buf });
    buf = "";
  };
  for (const ch of text) {
    if (ch === INS_OPEN || ch === DEL_OPEN) {
      push();
      kind = ch === INS_OPEN ? "ins" : "del";
    } else if (ch === INS_CLOSE || ch === DEL_CLOSE) {
      push();
      kind = "same";
    } else buf += ch;
  }
  push();
  return spans;
}

const BLOCKS = "p,li,h1,h2,h3,h4,h5,h6,td,th,pre,blockquote,dt,dd,figcaption";

/**
 * Turn the sentinels in rendered HTML into <ins> and <del>. A mark may open in
 * one text node and close in a later one (a changed phrase that runs into
 * bold text), so the state carries across text nodes in document order.
 * Sentinels that landed in an attribute (a changed link target) are removed.
 */
export function markDiffHtml(html: string, doc: Document = document): string {
  if (!/[-]/.test(html)) return html;
  const tpl = doc.createElement("template");
  tpl.innerHTML = html;
  const root = tpl.content;
  for (const el of Array.from(root.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      if (/[-]/.test(attr.value)) el.setAttribute(attr.name, strip(attr.value));
    }
  }
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
  let state: DiffSpan["kind"] = "same";
  let block: Element | null = null;
  for (const node of texts) {
    // Marks are made per line, so none legitimately spans two blocks. If one
    // was left open (its closing sentinel was eaten by the parser), it stops
    // at the end of its block instead of colouring the rest of the document.
    const owner = node.parentElement?.closest(BLOCKS) ?? null;
    if (owner !== block) {
      block = owner;
      state = "same";
    }
    const value = node.data;
    if (state === "same" && !/[-]/.test(value)) continue;
    const frag = doc.createDocumentFragment();
    let buf = "";
    const push = () => {
      if (!buf) return;
      if (state === "same") frag.appendChild(doc.createTextNode(buf));
      else {
        const el = doc.createElement(state);
        el.className = `markie-vh-${state}`;
        el.textContent = buf;
        frag.appendChild(el);
      }
      buf = "";
    };
    for (const ch of value) {
      if (ch === INS_OPEN || ch === DEL_OPEN) {
        push();
        state = ch === INS_OPEN ? "ins" : "del";
      } else if (ch === INS_CLOSE || ch === DEL_CLOSE) {
        push();
        state = "same";
      } else buf += ch;
    }
    push();
    node.replaceWith(frag);
  }
  return tpl.innerHTML;
}
