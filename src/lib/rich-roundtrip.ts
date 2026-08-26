// Answers one question exactly: does a raw parse-then-serialize through the
// real extension list reproduce this markdown byte for byte? Layers 1 and 2
// are built on top of this primitive; the user-facing gate (layer 3) uses
// the full-pipeline probeReconstruction, not this.
import { Editor } from "@tiptap/core";
import { richBaseExtensions } from "@/lib/rich-extensions";
import { formatMarkdownTables } from "@/lib/format-tables";

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

export function probeRoundTrip(markdown: string): {
  clean: boolean;
  output: string;
} {
  const editor = new Editor({
    extensions: richBaseExtensions(),
    content: "",
  });
  try {
    editor.commands.setContent(markdown, { emitUpdate: false });
    const output = formatMarkdownTables(readMarkdown(editor));
    const reference = formatMarkdownTables(markdown);
    return { clean: norm(output) === norm(reference), output };
  } catch {
    // A document the editor cannot even parse is by definition not safe to
    // rich-edit.
    return { clean: false, output: "" };
  } finally {
    editor.destroy();
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

// One reused headless editor plus a memo cache. parse+serialize per block is a
// few ms; a long document normalizes each block once and then hits the cache on
// every autosave flush.
export function createBlockNormalizer(): {
  normalize(block: string): string;
  destroy(): void;
} {
  const editor = new Editor({ extensions: richBaseExtensions(), content: "" });
  const cache = new Map<string, string>();
  const normalize = (block: string): string => {
    const hit = cache.get(block);
    if (hit !== undefined) return hit;
    let out: string;
    try {
      editor.commands.setContent(block, { emitUpdate: false });
      out = formatMarkdownTables(readMarkdown(editor)).replace(/\n+$/, "");
    } catch {
      out = "\u0000unparseable"; // never equals any real block
    }
    if (cache.size > 4000) cache.clear();
    cache.set(block, out);
    return out;
  };
  return { normalize, destroy: () => editor.destroy() };
}
