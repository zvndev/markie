// Constructs TipTap destroys at parse time are lifted out of the text before
// setContent and restored verbatim at serialize time. The placeholder is a
// plain alphanumeric token because plain words are the one thing guaranteed
// to survive a markdown round trip unchanged. Scope is block-level only:
// inline HTML and inline footnote references stay in the text (layer 2
// protects them in untouched blocks; an edited block takes the serializer's
// rewrite, confined to that block).

import { isEditorOwnHtmlBlock } from "@/lib/rich-media-html";

export type HoldKind = "html-comment" | "raw-html" | "footnote-def";

export interface HoldAside {
  token: string; // e.g. "markie-hold-0-3fa9c2d1", always its own paragraph
  source: string; // original bytes, verbatim, including line endings
  kind: HoldKind;
}

// djb2; only used to make tokens visually distinct and stable per content.
function hash8(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;
const COMMENT_OPEN = /^\s{0,3}<!--/;
const HTML_OPEN = /^\s{0,3}<[a-zA-Z!/]/;
const FOOTNOTE_DEF = /^\[\^[^\]]+\]:/;
const CONTINUATION = /^(?: {4}|\t)\S/;

export function extractHoldAsides(body: string): {
  text: string;
  holds: HoldAside[];
} {
  const lines = body.split(/(?<=\n)/);
  const holds: HoldAside[] = [];
  const out: string[] = [];
  let fenceClose: RegExp | null = null;
  let i = 0;

  const take = (kind: HoldKind, from: number, to: number) => {
    // [from, to) line range, exclusive of `to`
    const source = lines.slice(from, to).join("");
    const token = `markie-hold-${holds.length}-${hash8(source)}`;
    holds.push({ token, source, kind });
    // The token replaces the block and keeps its position as a paragraph.
    const eol = source.endsWith("\r\n") ? "\r\n" : "\n";
    out.push(token + eol);
    return to;
  };

  while (i < lines.length) {
    const bare = lines[i].replace(/\r?\n$/, "");
    if (fenceClose) {
      out.push(lines[i]);
      if (fenceClose.test(bare)) fenceClose = null;
      i++;
      continue;
    }
    const fence = FENCE_OPEN.exec(bare);
    if (fence) {
      const ch = fence[1][0] === "`" ? "`" : "~";
      fenceClose = new RegExp(`^\\s{0,3}\\${ch}{${fence[1].length},}\\s*$`);
      out.push(lines[i]);
      i++;
      continue;
    }
    if (COMMENT_OPEN.test(bare)) {
      let j = i;
      while (j < lines.length && !lines[j].includes("-->")) j++;
      i = take("html-comment", i, Math.min(j + 1, lines.length));
      continue;
    }
    if (FOOTNOTE_DEF.test(bare)) {
      let j = i + 1;
      while (j < lines.length && CONTINUATION.test(lines[j])) j++;
      i = take("footnote-def", i, j);
      continue;
    }
    if (HTML_OPEN.test(bare)) {
      // CommonMark-style HTML block: runs to the next blank line.
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "") j++;
      // One picture or clip tag on a line of its own, or one aligned
      // paragraph or heading, is the editor's own node written as HTML
      // (rich-media-html.ts). Held aside it would vanish from the rich pane;
      // left in, the extension parses it and writes it back the same way.
      if (j === i + 1 && isEditorOwnHtmlBlock(bare)) {
        out.push(lines[i]);
        i++;
        continue;
      }
      i = take("raw-html", i, j);
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return { text: out.join(""), holds };
}

export function restoreHoldAsides(text: string, holds: HoldAside[]): string {
  let result = text;
  for (const hold of holds) {
    // Match the token as a whole line WITHOUT consuming its newline (the line
    // terminator stays in place so separators survive). Replace every
    // occurrence: a duplicated token duplicates the block, which is the user's
    // visible intent. A missing token means the user deleted the block, so it
    // stays deleted. An indented or otherwise altered token line deliberately
    // does NOT match: restoration fails closed and the reconstruction probe
    // gates the document instead.
    const line = new RegExp(`^${hold.token}$`, "gm");
    const src = hold.source.replace(/\r?\n$/, "");
    // A function replacement so `$` characters in the held source are never
    // treated as replacement patterns.
    result = result.replace(line, () => src);
  }
  return result;
}
