#!/usr/bin/env node
// Regenerates src/lib/katex-css.generated.ts from the installed KaTeX package.
//
// PDF/HTML export runs in a standalone document that has no bundler and no
// network, so the KaTeX stylesheet has to be inlined as a string constant and
// its fonts embedded as data: URIs. Embedding all 20 woff2 faces would add
// ~350KB of base64 to every exported document, so only the faces that ordinary
// math actually reaches are embedded; the rest keep their CSS rules but fall
// back to the system font (rare scripts render with the wrong glyphs rather
// than not at all).
//
// Run: node scripts/generate-katex-css.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "node_modules", "katex", "dist");
const outFile = path.join(root, "src", "lib", "katex-css.generated.ts");

// Faces embedded as data: URIs. Everything else (Fraktur, SansSerif, Script,
// Math-BoldItalic) is left to the system fallback to keep the payload small.
const EMBEDDED = new Set([
  "KaTeX_AMS-Regular",
  "KaTeX_Caligraphic-Regular",
  "KaTeX_Main-Regular",
  "KaTeX_Main-Bold",
  "KaTeX_Main-Italic",
  "KaTeX_Main-BoldItalic",
  "KaTeX_Math-Italic",
  "KaTeX_Size1-Regular",
  "KaTeX_Size2-Regular",
  "KaTeX_Size3-Regular",
  "KaTeX_Size4-Regular",
  "KaTeX_Typewriter-Regular",
]);

const css = readFileSync(path.join(distDir, "katex.min.css"), "utf8");

let embedded = 0;
let dropped = 0;

// Each @font-face src lists woff2, woff and ttf. Replace the whole src list
// with a single embedded woff2, or strip the block entirely when not embedded.
const out = css.replace(/@font-face\{[^}]*\}/g, (block) => {
  const match = /url\(fonts\/(KaTeX_[A-Za-z0-9-]+)\.woff2\)/.exec(block);
  if (!match) return block;
  const face = match[1];
  if (!EMBEDDED.has(face)) {
    dropped++;
    return "";
  }
  const b64 = readFileSync(path.join(distDir, "fonts", `${face}.woff2`)).toString("base64");
  embedded++;
  return block.replace(
    /src:[^};]*(?=[};])/,
    `src:url(data:font/woff2;base64,${b64}) format("woff2")`
  );
});

const banner = `// GENERATED FILE — do not edit by hand.
// Run \`node scripts/generate-katex-css.mjs\` to regenerate from node_modules/katex.
//
// KaTeX ${JSON.parse(readFileSync(path.join(root, "node_modules", "katex", "package.json"), "utf8")).version} stylesheet with ${embedded} woff2 faces inlined as data: URIs
// (${dropped} rarely used faces fall back to the system font). Used by the export
// pipeline, which renders in a standalone document with no bundler and no network.
`;

writeFileSync(
  outFile,
  `${banner}\nexport const KATEX_CSS = ${JSON.stringify(out)};\n`
);

const size = Buffer.byteLength(readFileSync(outFile));
console.log(
  `wrote ${path.relative(root, outFile)} — ${(size / 1024).toFixed(0)}KB, ${embedded} faces embedded, ${dropped} dropped`
);
