// Comments on local documents: the renderer's half (super-nightly only).
//
// Main keeps the threads (electron/local-comments.js); this file holds the
// shapes the IPC bridge returns, and the arithmetic that puts a thread on
// screen. A thread is anchored by quoted markdown (electron/text-anchor.mjs),
// and the two panes show that markdown differently:
//   - Source view shows the markdown itself, so a resolved range is already a
//     CodeMirror range.
//   - Rich view shows what the markdown renders to: no `**`, no link targets,
//     no heading hashes. A range there is found by projecting the markdown to
//     its visible text, finding the quoted passage's visible form in the
//     editor's own text, and taking the same occurrence. The reverse, a
//     selection in Rich view, goes back the same way.
// All of it is pure and tested in local-comments.test.ts.
import { makeAnchor, resolveAnchor, type TextAnchor } from "../../electron/text-anchor.mjs";

export type { TextAnchor };

export type CommentAuthor = { kind: "user" } | { kind: "agent"; name: string };

export interface LocalComment {
  id: string;
  author: CommentAuthor;
  body: string;
  createdAt: string;
}

export interface LocalCommentThread {
  id: string;
  anchor: TextAnchor;
  status: "open" | "resolved";
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: CommentAuthor;
  comments: LocalComment[];
}

export type LocalCommentsResult =
  | { ok: true; path: string; threads: LocalCommentThread[] }
  | { ok: false; error: string };

export interface LocalCommentsBridge {
  list(path: string): Promise<LocalCommentsResult>;
  add(args: { path: string; anchor: TextAnchor; body: string }): Promise<LocalCommentsResult>;
  reply(args: { path: string; threadId: string; body: string }): Promise<LocalCommentsResult>;
  setStatus(args: { path: string; threadId: string; status: "open" | "resolved" }): Promise<LocalCommentsResult>;
  remove(args: { path: string; threadId: string; commentId: string }): Promise<LocalCommentsResult>;
  onChanged(cb: (info: { path: string }) => void): () => void;
}

/** "You" for the person at the keyboard, the agent's own name otherwise. */
export function authorName(author: CommentAuthor | undefined): string {
  if (author && author.kind === "agent") return author.name || "Agent";
  return "You";
}

export function isCommentableDoc(path: string | null | undefined): boolean {
  return !!path && /\.(md|markdown|mdx)$/i.test(path);
}

export interface Range {
  from: number;
  to: number;
}

export interface PlacedThread {
  thread: LocalCommentThread;
  /** Where the quote is in the markdown now, or null when it is detached. */
  range: Range | null;
}

/** Every thread with where its quote is in `markdown` now. */
export function placeThreads(markdown: string, threads: LocalCommentThread[]): PlacedThread[] {
  return threads.map((thread) => {
    const hit = resolveAnchor(markdown, thread.anchor);
    return { thread, range: hit ? { from: hit.start, to: hit.end } : null };
  });
}

export function anchorFor(markdown: string, range: Range): TextAnchor | null {
  return makeAnchor(markdown, range.from, range.to);
}

// ── Markdown to visible text ──

interface Projection {
  /** What a reader sees, roughly: the markdown with its syntax removed. */
  text: string;
  /** For each character of `text`, its index in the markdown. */
  map: number[];
}

const BLOCK_PREFIX = /^(\s{0,3}(?:>\s?)*)(#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,9}[.)]\s+(?:\[[ xX]\]\s+)?)?/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const TAG = /^<\/?[A-Za-z][^<>]*>/;

/**
 * Strip markdown down to roughly what the rich pane shows, keeping a map back
 * to the source. Not a renderer: it only has to agree with the editor's text
 * well enough that a quoted passage reads the same in both.
 */
export function projectMarkdown(markdown: string): Projection {
  let text = "";
  const map: number[] = [];
  const emit = (ch: string, at: number) => {
    text += ch;
    map.push(at);
  };
  let i = 0;
  // Front matter is held aside by the rich pane and never shown.
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(markdown);
  if (fm) i = fm[0].length;
  let inFence = false;
  while (i < markdown.length) {
    let lineEnd = markdown.indexOf("\n", i);
    if (lineEnd === -1) lineEnd = markdown.length;
    const line = markdown.slice(i, lineEnd);
    if (FENCE.test(line)) {
      inFence = !inFence;
    } else if (inFence) {
      for (let k = 0; k < line.length; k++) emit(line[k], i + k);
    } else if (!TABLE_RULE.test(line)) {
      const prefix = BLOCK_PREFIX.exec(line);
      let k = prefix ? prefix[0].length : 0;
      while (k < line.length) {
        const at = i + k;
        const ch = line[k];
        const rest = line.slice(k);
        if (rest.startsWith("<!--")) {
          // A comment can run past this line; skip to its end wherever it is.
          const close = markdown.indexOf("-->", at + 4);
          const stop = close === -1 ? markdown.length : close + 3;
          if (stop > lineEnd) {
            i = stop;
            k = -1;
            break;
          }
          k = stop - i;
          continue;
        }
        if (ch === "\\" && k + 1 < line.length) {
          emit(line[k + 1], at + 1);
          k += 2;
          continue;
        }
        if (ch === "]" && line[k + 1] === "(") {
          const close = line.indexOf(")", k + 2);
          k = close === -1 ? line.length : close + 1;
          continue;
        }
        if (ch === "<") {
          const tag = TAG.exec(rest);
          if (tag) {
            k += tag[0].length;
            continue;
          }
        }
        if (ch === "*" || ch === "`" || ch === "~" || ch === "[" || (ch === "!" && line[k + 1] === "[")) {
          k += 1;
          continue;
        }
        if (ch === "_") {
          const before = k > 0 ? line[k - 1] : " ";
          const after = k + 1 < line.length ? line[k + 1] : " ";
          // Inside a word (snake_case) an underscore is text; at an edge it is emphasis.
          if (!(/\w/.test(before) && /\w/.test(after))) {
            k += 1;
            continue;
          }
        }
        if (ch === "|") {
          emit(" ", at);
          k += 1;
          continue;
        }
        emit(ch, at);
        k += 1;
      }
      if (k === -1) continue; // jumped past a multi-line comment
    }
    if (lineEnd < markdown.length) emit("\n", lineEnd);
    i = lineEnd + 1;
  }
  return { text, map };
}

// Whitespace collapsed to one space, with a map back. The rich pane joins
// blocks with one newline and markdown separates paragraphs with two, so text
// is compared with every run of whitespace counted as one space.
function squeeze(text: string): { text: string; map: number[] } {
  let out = "";
  const map: number[] = [];
  let inSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!inSpace) {
        out += " ";
        map.push(i);
      }
      inSpace = true;
    } else {
      out += ch;
      map.push(i);
      inSpace = false;
    }
  }
  return { text: out, map };
}

function occurrencesBefore(hay: string, needle: string, before: number): number {
  let n = 0;
  let at = hay.indexOf(needle);
  while (at !== -1 && at < before) {
    n++;
    at = hay.indexOf(needle, at + 1);
  }
  return n;
}

function nthIndex(hay: string, needle: string, n: number): number {
  let at = hay.indexOf(needle);
  let last = at;
  for (let i = 0; at !== -1 && i < n; i++) {
    last = at;
    at = hay.indexOf(needle, at + 1);
  }
  return at !== -1 ? at : last;
}

/**
 * A markdown range as a range in the rich pane's visible text, or null when
 * the passage cannot be found there (for example, it is all syntax).
 */
export function markdownToVisible(markdown: string, range: Range, visible: string): Range | null {
  const proj = projectMarkdown(markdown);
  // The projected characters that came from inside the range.
  let pFrom = -1;
  let pTo = -1;
  for (let p = 0; p < proj.map.length; p++) {
    const src = proj.map[p];
    if (src >= range.from && src < range.to) {
      if (pFrom === -1) pFrom = p;
      pTo = p + 1;
    }
  }
  if (pFrom === -1) return null;
  const sp = squeeze(proj.text);
  const sv = squeeze(visible);
  const toSqueezed = (p: number) => {
    // first squeezed index whose source is at or after p
    for (let s = 0; s < sp.map.length; s++) if (sp.map[s] >= p) return s;
    return sp.map.length;
  };
  const sFrom = toSqueezed(pFrom);
  const sTo = toSqueezed(pTo);
  const needle = sp.text.slice(sFrom, sTo).trim();
  if (!needle) return null;
  const k = occurrencesBefore(sp.text, needle, sFrom);
  const at = nthIndex(sv.text, needle, k);
  if (at === -1) return null;
  const from = sv.map[at];
  const to = sv.map[at + needle.length - 1] + 1;
  return { from, to };
}

/**
 * A selection in the rich pane's visible text as a markdown range, or null
 * when the selected text cannot be found in the markdown.
 */
export function visibleToMarkdown(markdown: string, visible: string, range: Range): Range | null {
  const sv = squeeze(visible);
  const toSqueezed = (p: number) => {
    for (let s = 0; s < sv.map.length; s++) if (sv.map[s] >= p) return s;
    return sv.map.length;
  };
  const vFrom = toSqueezed(range.from);
  const vTo = toSqueezed(range.to);
  const needle = sv.text.slice(vFrom, vTo).trim();
  if (!needle) return null;
  const lead = sv.text.slice(vFrom, vTo).length - sv.text.slice(vFrom, vTo).trimStart().length;
  const k = occurrencesBefore(sv.text, needle, vFrom + lead);
  const proj = projectMarkdown(markdown);
  const sp = squeeze(proj.text);
  const at = nthIndex(sp.text, needle, k);
  if (at === -1) return null;
  const from = proj.map[sp.map[at]];
  const to = proj.map[sp.map[at + needle.length - 1]] + 1;
  return to > from ? { from, to } : null;
}
