#!/usr/bin/env node
// Regenerates server/src/generated/markdown-guide.mjs from mcp/markdown-guide.mjs.
//
// The server's Docker build context is server/ alone, so the hosted MCP
// (src/mcp-server.ts) cannot import the guide from mcp/. It serves this
// generated copy instead, and src/markdown-guide-copy.test.ts fails whenever
// the copy and its source differ. Run after any change to the guide:
//
//   (cd server && npm run guide:sync)
//
// The copy is the source byte for byte under a fixed header, so the check is
// a plain comparison and the copy needs no build step of its own.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SOURCE = fileURLToPath(new URL("../../mcp/markdown-guide.mjs", import.meta.url));
export const COPY = fileURLToPath(new URL("../src/generated/markdown-guide.mjs", import.meta.url));
export const HEADER =
  "// GENERATED from mcp/markdown-guide.mjs by server/scripts/sync-markdown-guide.mjs.\n" +
  "// Do not edit. Change the source, then run: (cd server && npm run guide:sync)\n\n";

export function expectedCopy() {
  return HEADER + readFileSync(SOURCE, "utf8");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(COPY, expectedCopy());
  console.log(`wrote ${COPY}`);
}
