// What the renderer loads at launch.
//
// CodeMirror (the source pane) and the live-session stack (yjs, y-websocket,
// the collaboration extensions, comment anchoring) are loaded on first use:
// src/components/source-editor.tsx and src/lib/collab-loader.ts. One static
// import anywhere on the path from src/main.tsx would quietly put a package
// back into the entry chunk, and nothing at build time would say so. This
// walks that path and names the chain when it happens.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..");
const ENTRY = path.join(SRC, "main.tsx");

// Packages that must only ever be reached through a dynamic import.
const LAZY_ONLY = [
  /^@codemirror\//,
  /^@uiw\/react-codemirror/,
  /^yjs$/,
  /^y-websocket$/,
  /^@tiptap\/extension-collaboration/,
  /^@tiptap\/y-tiptap/,
];

// Static `import ... from`, `export ... from` and bare `import "x"`; `import
// type` and `export type` are erased and skipped. Dynamic import() is not an
// edge, which is the whole point.
const EDGE_RE =
  /(?:^|\n)[ \t]*(?:import|export)\s+(?!type\s)[^;'"]*?\bfrom\s+["']([^"']+)["']|(?:^|\n)[ \t]*import\s+["']([^"']+)["']/g;

function edges(file: string): string[] {
  const text = readFileSync(file, "utf-8");
  const out: string[] = [];
  for (const m of text.matchAll(EDGE_RE)) out.push(m[1] ?? m[2]);
  return out;
}

/** A source file for a local specifier, null for a package. */
function resolveLocal(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Could not resolve ${spec} from ${path.relative(SRC, from)}`);
}

function chainTo(file: string, parents: Map<string, string | null>): string {
  const chain: string[] = [];
  for (let cur: string | null = file; cur; cur = parents.get(cur) ?? null) {
    chain.unshift(path.relative(SRC, cur));
  }
  return chain.join(" -> ");
}

describe("the launch import graph", () => {
  it("reaches CodeMirror and the live-session stack only through dynamic imports", () => {
    const parents = new Map<string, string | null>([[ENTRY, null]]);
    const queue = [ENTRY];
    const offenders: string[] = [];
    while (queue.length) {
      const file = queue.shift()!;
      if (!/\.(ts|tsx|js)$/.test(file)) continue;
      for (const spec of edges(file)) {
        const local = resolveLocal(file, spec);
        if (local === null) {
          if (LAZY_ONLY.some((re) => re.test(spec))) {
            offenders.push(`${chainTo(file, parents)} -> ${spec}`);
          }
          continue;
        }
        if (parents.has(local)) continue;
        parents.set(local, file);
        queue.push(local);
      }
    }
    expect(offenders).toEqual([]);
    // Sanity: the walk really covered the app.
    expect(parents.size).toBeGreaterThan(50);
  });
});
