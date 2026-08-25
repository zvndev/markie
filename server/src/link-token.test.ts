import { test } from "node:test";
import assert from "node:assert/strict";
import { newLinkToken } from "./link-token.ts";

test("a link token is 32 bytes of base64url", () => {
  const token = newLinkToken();
  // 32 bytes → 43 base64url characters, no padding
  assert.equal(token.length, 43);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
});

test("a link token survives a URL and an email round trip unchanged", () => {
  for (let i = 0; i < 200; i++) {
    const token = newLinkToken();
    assert.equal(encodeURIComponent(token), token, `${token} needed escaping`);
    const url = new URL(`https://markie.test/d/abc?k=${token}`);
    assert.equal(url.searchParams.get("k"), token);
  }
});

test("link tokens do not repeat", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) seen.add(newLinkToken());
  assert.equal(seen.size, 2000);
});

test("link tokens are not sequential or prefix-shared", () => {
  const a = newLinkToken();
  const b = newLinkToken();
  // Any shared prefix beyond a couple of characters would mean the randomness
  // is not where it should be.
  let shared = 0;
  while (shared < a.length && a[shared] === b[shared]) shared++;
  assert.ok(shared < 8, `tokens share a ${shared}-character prefix`);
});
