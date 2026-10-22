// Provider tokens are stored encrypted, and rows written before encryption was
// switched on still read back unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptOAuthToken, setTokenUtil } from "better-auth/oauth2";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-oauth-tokens-")), "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-oauth-token-test-secret-32-plus-chars";

const { auth } = await import("./auth.ts");
// The plugin-facing context is the same object better-auth hands its token
// helpers; only its declared type differs.
const ctx = (await auth.$context) as unknown as Parameters<typeof setTokenUtil>[1];

test("OAuth access and refresh tokens are encrypted at rest", async () => {
  assert.equal(auth.options.account?.encryptOAuthTokens, true);
  const token = "ya29.a0AfH6SMBexample-access-token";
  const stored = await setTokenUtil(token, ctx);
  assert.ok(stored);
  assert.notEqual(stored, token);
  assert.ok(!stored.includes("ya29"));
  assert.equal(await decryptOAuthToken(stored, ctx), token);
});

test("tokens stored in the clear before encryption still read back as they are", async () => {
  for (const legacy of ["ya29.a0AfH6SMBlegacy", "1//0gLegacyRefreshToken-abc_def", "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.sig"]) {
    assert.equal(await decryptOAuthToken(legacy, ctx), legacy);
  }
});
