export const DARKMOWN_SOURCE_LIMIT = 128_000;
export const DARKMOWN_OUTPUT_LIMIT = 1_000_000;

export interface CompiledDarkmownDocument {
  /** Unsanitized compiler output. It must not be inserted into Markie's DOM. */
  bodyHtml: string;
  title: string;
  warnings: readonly string[];
  requiresRuntime: boolean;
  hasCode: boolean;
}

/** Cheap closed-subset checks, before allocating a compiler worker. */
export function validateDarkmownPreviewSource(source: string): void {
  if (typeof source !== "string" || source.length > DARKMOWN_SOURCE_LIMIT) {
    throw new Error("Interactive preview supports up to 128,000 characters and 5,000 lines. Your source remains available to edit and save.");
  }
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 5_000) throw new Error("Interactive preview supports up to 128,000 characters and 5,000 lines. Your source remains available to edit and save.");
  // A large seed painted many times can allocate large intermediate HTML before
  // the output-size check. This deliberately conservative work budget counts
  // authored braces and derived declarations, including literal examples.
  const expansions = (normalized.match(/\{/g)?.length ?? 0) + (normalized.match(/^:computed(?:\s|$)/gm)?.length ?? 0);
  if (source.length * Math.max(1, expansions) > 1_000_000) {
    throw new Error("This source exceeds the interactive preview complexity budget. Your source remains available to edit and save.");
  }
  // Match parseFrontmatter's exact body boundary before scanning code fences;
  // a fence-like frontmatter value must never hide an active body directive.
  let body = normalized;
  if (normalized.startsWith("---\n")) {
    const end = normalized.indexOf("\n---", 3);
    if (end !== -1) body = normalized.slice(end + 4 + (normalized[end + 4] === "\n" ? 1 : 0));
  }
  // Match compiler/body.js's flush-left fence and expansion dispatch. Literal
  // fenced examples stay literal. The first preview does not expand loops or
  // load includes; the disposable worker still bounds other compiler work.
  let fence: string | null = null;
  const active: string[] = [];
  for (const line of body.split("\n")) {
    const marker = line.match(/^(```+|~~~+)/)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) { fence = marker; continue; }
    if (/^@(?:loop|include)(?:\s|$)/.test(line)) {
      throw new Error("Loops and included files are not available in this interactive preview yet. Your source remains available to edit and save.");
    }
    if (/^:computed(?:\s|$)/.test(line) && line.includes("+")) {
      throw new Error("Computed addition and string concatenation are not available in this interactive preview yet. Your source remains available to edit and save.");
    }
    active.push(line);
  }
  // Formatter pipelines can amplify a seed (for example join with a long
  // separator). The initial closed subset has no formatter pipelines at all.
  if (/\{[^{}]*\|[^{}]*\}/.test(active.join("\n"))) {
    throw new Error("Format pipelines are not available in this interactive preview yet. Your source remains available to edit and save.");
  }
}
