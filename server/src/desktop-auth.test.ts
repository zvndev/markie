import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopAuthDeepLink, desktopAuthState } from "./desktop-auth.ts";

const NONCE = "0123456789abcdef0123456789abcdef";

test("desktopAuthState accepts the nonce shape the app mints", () => {
  assert.equal(desktopAuthState(NONCE), NONCE);
  assert.equal(desktopAuthState("abcdef01"), "abcdef01");
});

test("desktopAuthState drops anything missing", () => {
  assert.equal(desktopAuthState(null), null);
  assert.equal(desktopAuthState(undefined), null);
  assert.equal(desktopAuthState(""), null);
});

test("desktopAuthState drops out-of-range lengths", () => {
  assert.equal(desktopAuthState("abcdef0"), null, "7 chars is below the floor");
  assert.equal(desktopAuthState("a".repeat(129)), null, "129 chars is above the ceiling");
});

// The value is echoed into a URL handed to the browser, so a non-hex nonce must
// never survive to be reflected.
test("desktopAuthState drops anything outside lowercase hex", () => {
  for (const bad of [
    "ABCDEF0123456789",
    "abcdef01\"><script>alert(1)</script>",
    "abcdef01&token=stolen",
    "abcdef01 with spaces",
    "../../etc/passwd",
    "abcdef01%26x",
  ]) {
    assert.equal(desktopAuthState(bad), null, `should reject ${bad}`);
  }
});

test("desktopAuthDeepLink carries the nonce back to the app", () => {
  assert.equal(
    desktopAuthDeepLink("tok en/+", NONCE),
    `markie://auth?token=tok%20en%2F%2B&state=${NONCE}`,
  );
});

test("desktopAuthDeepLink omits state when there is none to carry", () => {
  assert.equal(desktopAuthDeepLink("abc", null), "markie://auth?token=abc");
});
