// Answers one question exactly: does a raw parse-then-serialize through the
// real extension list reproduce this markdown byte for byte? Layers 1 and 2
// are built on top of this primitive; the user-facing gate (layer 3) uses
// the full-pipeline probeReconstruction, not this.
import { Editor } from "@tiptap/core";
import { richBaseExtensions } from "@/lib/rich-extensions";
import { formatMarkdownTables } from "@/lib/format-tables";
import { splitFrontMatter, joinFrontMatter } from "@/lib/front-matter";
import { extractHoldAsides, restoreHoldAsides } from "@/lib/rich-hold-aside";
import { preserveBlocks } from "@/lib/rich-block-preserve";

export type LossRisk =
  | "front-matter"
  | "footnotes"
  | "raw-html"
  | "html-comments"
  | "display-math"
  | "table-alignment"
  | "wrapped-paragraphs"
  | "reference-links";

// A trailing-newline difference is not damage.
const norm = (s: string) => s.replace(/\n+$/, "") + "\n";

function readMarkdown(editor: Editor): string {
  return (
    editor.storage as unknown as { markdown: { getMarkdown(): string } }
  ).markdown.getMarkdown();
}

// One headless editor for every probe and every normalize, for the life of the
// renderer. Two measured reasons, both of which showed up as unbounded growth
// while auditing a real corpus:
//
//   * A TipTap Editor is not fully reclaimed by destroy() in this environment.
//     Creating and destroying one per probe cost about 0.6MB a time, so opening
//     documents leaked hundreds of megabytes over a session.
//   * StarterKit's undo history records every setContent, so a reused editor
//     grows with each document it parses. The scratch editor is built with the
//     collab configuration, which is exactly "no local undo history".
//
// Every user of it does setContent then read, synchronously, so there is no
// state to collide over.
let scratch: Editor | null = null;
function scratchEditor(): Editor {
  if (!scratch || scratch.isDestroyed) {
    scratch = new Editor({
      extensions: richBaseExtensions({ collab: true }),
      content: "",
    });
  }
  return scratch;
}

export function probeRoundTrip(markdown: string): {
  clean: boolean;
  output: string;
} {
  const editor = scratchEditor();
  try {
    editor.commands.setContent(markdown, { emitUpdate: false });
    const output = formatMarkdownTables(readMarkdown(editor));
    const reference = formatMarkdownTables(markdown);
    return { clean: norm(output) === norm(reference), output };
  } catch {
    // A document the editor cannot even parse is by definition not safe to
    // rich-edit.
    return { clean: false, output: "" };
  }
}

// Names the constructs for the banner and the corpus report. Best-effort and
// purely informational: gating decisions use probeReconstruction, never this.
export function describeLossRisks(markdown: string): LossRisk[] {
  const risks: LossRisk[] = [];
  const md = String(markdown ?? "");
  if (/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.test(md)) {
    risks.push("front-matter");
  }
  if (/^\[\^[^\]]+\]:/m.test(md) || /\[\^[^\]]+\]/.test(md)) {
    risks.push("footnotes");
  }
  if (/<!--[\s\S]*?-->/.test(md)) risks.push("html-comments");
  // An HTML tag at line start that is not a comment.
  if (/^<(?!!--)[a-zA-Z][^>]*>/m.test(md)) risks.push("raw-html");
  if (/^\$\$/m.test(md)) risks.push("display-math");
  // A delimiter row cell with alignment colons.
  if (/^\s*\|?\s*:-{2,}|-{2,}:\s*(\||$)/m.test(md)) risks.push("table-alignment");
  // A reference-style link definition (not a footnote definition).
  if (/^\[(?!\^)[^\]]+\]:\s/m.test(md)) risks.push("reference-links");
  // A paragraph line followed directly by another text line (soft wrap).
  if (/^[^\s>#|`\-*\d![<][^\n]*\n[^\s>#|`\-*\d![<]/m.test(md)) {
    risks.push("wrapped-paragraphs");
  }
  return risks;
}

// The shared scratch editor plus a memo cache. parse+serialize per block is a
// few ms; a long document normalizes each block once and then hits the cache on
// every autosave flush. destroy() releases the cache; the editor is shared and
// outlives every caller.
export function createBlockNormalizer(): {
  normalize(block: string): string;
  destroy(): void;
} {
  const cache = new Map<string, string>();
  const normalize = (block: string): string => {
    const hit = cache.get(block);
    if (hit !== undefined) return hit;
    let out: string;
    try {
      const editor = scratchEditor();
      editor.commands.setContent(block, { emitUpdate: false });
      out = formatMarkdownTables(readMarkdown(editor)).replace(/\n+$/, "");
    } catch {
      out = "\u0000unparseable"; // never equals any real block
    }
    if (cache.size > 4000) cache.clear();
    cache.set(block, out);
    return out;
  };
  return { normalize, destroy: () => cache.clear() };
}

// The user-facing gate: can the full pipeline (hold-aside, parse, serialize,
// block preservation, restore) reproduce this document byte for byte with zero
// edits? If yes, editing is safe: untouched blocks are emitted from source
// bytes and only edited blocks change. If no, the document opens read-only in
// Rich, with an explicit override.
export function probeReconstruction(markdown: string): {
  clean: boolean;
  output: string;
} {
  const md = String(markdown ?? "");
  if (!md.trim()) return { clean: true, output: md };
  const { frontMatter, body } = splitFrontMatter(md);
  const { text, holds } = extractHoldAsides(body);
  const raw = probeRoundTrip(text);
  const { normalize, destroy } = createBlockNormalizer();
  try {
    const preserved = preserveBlocks(text, raw.output, normalize);
    const output = joinFrontMatter(
      frontMatter,
      restoreHoldAsides(preserved, holds)
    );
    return { clean: norm(output) === norm(md), output };
  } catch {
    return { clean: false, output: "" };
  } finally {
    destroy();
  }
}
