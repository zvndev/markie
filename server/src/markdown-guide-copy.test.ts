// The hosted MCP's markie_guide must say exactly what the local MCP's says.
// The server cannot import mcp/ (its Docker build context is server/), so it
// serves a generated copy. This fails the moment the two differ; the fix is
// `(cd server && npm run guide:sync)`, never an edit to the copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COPY, expectedCopy } from "../scripts/sync-markdown-guide.mjs";
import { MARKDOWN_GUIDE as COPIED } from "./generated/markdown-guide.mjs";
import { MARKDOWN_GUIDE as SOURCE } from "../../mcp/markdown-guide.mjs";

test("the generated guide is mcp/markdown-guide.mjs, byte for byte, under its header", () => {
  assert.equal(readFileSync(COPY, "utf8"), expectedCopy(), "run: (cd server && npm run guide:sync)");
});

test("and it exports the same guide text", () => {
  assert.equal(COPIED, SOURCE);
  assert.ok(SOURCE.length > 1000);
});
