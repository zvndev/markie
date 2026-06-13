import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the module's db at a throwaway file BEFORE importing it.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-pl-")), "t.db");
const {
  createOrGetPublicLink,
  getPublicLinkToken,
  resolvePublicToken,
  revokePublicLink,
} = await import("./public-links.ts");

test("createOrGetPublicLink is stable per doc", () => {
  const a = createOrGetPublicLink("doc1", "owner1");
  const b = createOrGetPublicLink("doc1", "owner1");
  assert.equal(a, b);
  assert.ok(a.length >= 32);
});

test("resolvePublicToken maps token back to doc", () => {
  const token = createOrGetPublicLink("doc2", "owner1");
  assert.deepEqual(resolvePublicToken(token), { doc_id: "doc2" });
  assert.equal(resolvePublicToken("nope"), null);
});

test("getPublicLinkToken returns current or null", () => {
  assert.equal(getPublicLinkToken("doc404"), null);
  const token = createOrGetPublicLink("doc3", "owner1");
  assert.equal(getPublicLinkToken("doc3"), token);
});

test("revokePublicLink removes the link", () => {
  const token = createOrGetPublicLink("doc4", "owner1");
  assert.equal(revokePublicLink("doc4"), true);
  assert.equal(resolvePublicToken(token), null);
  assert.equal(revokePublicLink("doc4"), false);
});
