#!/usr/bin/env node
// Regenerates server/src/generated/markdown-style-schema.ts from the app's
// src/lib/markdown-style-schema.ts: what a stored Markdown style may contain
// and the function that cleans one.
//
// The server's Docker build context is server/ alone, so it cannot import the
// app's file. It validates with this copy instead, byte for byte under a
// header, and src/lib/markdown-style-schema.test.ts fails whenever the two
// differ. Run after any change to the source:
//
//   (cd server && npm run markdown-style:sync)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE = fileURLToPath(new URL("../../src/lib/markdown-style-schema.ts", import.meta.url));
export const COPY = fileURLToPath(new URL("../src/generated/markdown-style-schema.ts", import.meta.url));
export const HEADER =
  "// GENERATED from src/lib/markdown-style-schema.ts by server/scripts/sync-markdown-style.mjs.\n" +
  "// Do not edit. Change the source, then run: (cd server && npm run markdown-style:sync)\n";

export function generated() {
  return HEADER + readFileSync(SOURCE, "utf8");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(dirname(COPY), { recursive: true });
  writeFileSync(COPY, generated());
  console.log(`wrote ${COPY}`);
}
