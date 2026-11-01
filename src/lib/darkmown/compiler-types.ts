export const DARKMOWN_SOURCE_LIMIT = 128_000;
export const DARKMOWN_OUTPUT_LIMIT = 1_000_000;
// The compiler folds :computed and paints loops while compiling, so an oversized
// expansion has to be refused from the source, before it can exhaust the worker.
export const DARKMOWN_MAX_COMPUTED_GROWTH = 64;
const LOOP_WORK_BUDGET = 20_000_000;
const PIPE_ARGUMENT_LIMIT = 200;

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
  // fenced examples stay literal. A preview compiles one source, so there is no
  // other file to include; security.ts bounds what loops and `+` can expand into.
  let fence: string | null = null;
  let loops = 0;
  let deepest = 0;
  const growth = new Map<string, number>();
  for (const line of body.split("\n")) {
    const marker = line.match(/^(```+|~~~+)/)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) { fence = marker; continue; }
    if (/^@include(?:\s|$)/.test(line)) {
      throw new Error("Included files are not available in this interactive preview yet. Your source remains available to edit and save.");
    }
    if (/^@loop(?:\s|$)/.test(line)) deepest = Math.max(deepest, ++loops);
    else if (/^@endloop(?:\s|$)/.test(line)) loops = Math.max(0, loops - 1);
    const computed = line.match(/^:computed\s+([\w$]+)\s*=(.*)$/);
    if (computed) {
      // A name read twice across `+` repeats it. Declared-before-use rules out a cycle.
      const reads = (computed[2].replace(/"[^"]*"/g, "").match(/[A-Za-z_$][\w$]*/g) ?? []).map((name) => growth.get(name) ?? 1);
      const total = computed[2].includes("+") ? reads.reduce((sum, read) => sum + read, 0) : Math.max(1, ...reads);
      if (total > DARKMOWN_MAX_COMPUTED_GROWTH) {
        throw new Error("This chain of text concatenation could grow too large for an interactive preview. Your source remains available to edit and save.");
      }
      growth.set(computed[1], total);
    }
    for (const pipe of line.matchAll(/\{[^{}]*\|([^{}]*)\}/g)) {
      if ((pipe[1].match(/"[^"]*"/g) ?? []).some((argument) => argument.length > PIPE_ARGUMENT_LIMIT)) {
        throw new Error("Format pipelines in an interactive preview take arguments up to 200 characters. Your source remains available to edit and save.");
      }
    }
  }
  // A list is one line of source, so its commas bound its length. Nested loops
  // multiply that, and every row repeats up to the whole source.
  const rows = Math.max(...lines.map((line) => (line.match(/,/g)?.length ?? 0) + 1));
  if (source.length * rows ** deepest > LOOP_WORK_BUDGET) {
    throw new Error("These loops could draw too many rows for an interactive preview. Your source remains available to edit and save.");
  }
}
