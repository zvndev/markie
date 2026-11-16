import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the module's db at a throwaway file BEFORE importing it.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-pl-")), "t.db");
// The docs table belongs to docs.ts; these tests need only the two columns
// public-links.ts reads from it.
{
  const Database = (await import("better-sqlite3")).default;
  const setup = new Database(process.env.DB_PATH);
  setup.exec("CREATE TABLE docs (id TEXT PRIMARY KEY, format TEXT NOT NULL DEFAULT 'markdown')");
  setup.close();
}
const {
  createOrGetPublicLink,
  getPublicLinkToken,
  resolvePublicToken,
  revokePublicLink,
  rotatePublicLink,
  guardLiveDocsPrivate,
  isLiveDocFormat,
  isLiveDocRefusal,
  LIVE_DOC_PRIVATE,
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

test("rotatePublicLink swaps the token and never creates a link", () => {
  const old = createOrGetPublicLink("doc5", "owner1");
  const fresh = rotatePublicLink("doc5");
  assert.ok(fresh && fresh !== old && fresh.length >= 32);
  assert.equal(resolvePublicToken(old), null);
  assert.deepEqual(resolvePublicToken(fresh), { doc_id: "doc5" });
  assert.equal(getPublicLinkToken("doc5"), fresh);

  assert.equal(rotatePublicLink("doc-without-link"), null);
  assert.equal(getPublicLinkToken("doc-without-link"), null);
});

test("a Live Doc never gets a public link, and becoming one drops the link it had", async () => {
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(process.env.DB_PATH!);
  try {
    db.prepare("INSERT INTO docs (id, format) VALUES (?, ?)").run("live1", "darkmown");
    db.prepare("INSERT INTO docs (id, format) VALUES (?, ?)").run("md1", "markdown");
    assert.equal(isLiveDocFormat("live1"), true);
    assert.equal(isLiveDocFormat("md1"), false);
    assert.equal(createOrGetPublicLink("live1", "owner1"), null);
    assert.equal(getPublicLinkToken("live1"), null);
    assert.equal(LIVE_DOC_PRIVATE.error, "live-doc-private");

    const token = createOrGetPublicLink("md1", "owner1");
    assert.ok(token);
    assert.equal(guardLiveDocsPrivate(db), 0);
    db.prepare("UPDATE docs SET format = 'darkmown' WHERE id = ?").run("md1");
    assert.equal(resolvePublicToken(token!), null, "the format change took the link in the same statement");
    assert.equal(rotatePublicLink("md1"), null, "and there is nothing to rotate back into existence");
  } finally {
    db.close();
  }
});

test("the database's refusal reads as the same live-doc-private answer, not a crash", async () => {
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(process.env.DB_PATH!);
  try {
    guardLiveDocsPrivate(db);
    db.prepare("INSERT INTO docs (id, format) VALUES (?, ?)").run("live-raw", "darkmown");
    let caught: unknown = null;
    try {
      db.prepare("INSERT INTO public_links (doc_id, token, created_by, created_at) VALUES (?, ?, ?, ?)").run("live-raw", "raw-token", "owner1", "");
    } catch (error) {
      caught = error;
    }
    assert.equal(isLiveDocRefusal(caught), true, "the trigger's error is recognised");
    assert.equal(isLiveDocRefusal(new Error("UNIQUE constraint failed: public_links.token")), false);
    assert.equal(isLiveDocRefusal("live-doc-private"), false, "only a real error counts");
  } finally {
    db.close();
  }
});
