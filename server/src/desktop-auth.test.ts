import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopAuthApp, desktopAuthAppName, desktopAuthDeepLink, desktopAuthIssuer, desktopAuthState } from "./desktop-auth.ts";

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

test("desktopAuthDeepLink names the server that issued the token", () => {
  assert.equal(
    desktopAuthDeepLink("abc", NONCE, "https://docs.example.com"),
    `markie://auth?token=abc&state=${NONCE}&iss=https%3A%2F%2Fdocs.example.com`,
  );
  const u = new URL(desktopAuthDeepLink("abc", NONCE, "https://docs.example.com"));
  assert.equal(u.searchParams.get("iss"), "https://docs.example.com");
});

test("desktopAuthIssuer is the origin of BETTER_AUTH_URL and nothing else", () => {
  assert.equal(desktopAuthIssuer("https://Docs.Example.com/base/?x=1"), "https://docs.example.com");
  assert.equal(desktopAuthIssuer("http://localhost:8787"), "http://localhost:8787");
  assert.equal(desktopAuthIssuer(""), null);
  assert.equal(desktopAuthIssuer(undefined), null);
  assert.equal(desktopAuthIssuer("not a url"), null);
});

test("desktopAuthApp names Markie RS only when asked, and Markie otherwise", () => {
  assert.equal(desktopAuthApp("markie-rs"), "markie-rs");
  for (const other of [null, undefined, "", "markie", "MARKIE-RS", "markie-rs ", "javascript", "https", "markie-rs://x"]) {
    assert.equal(desktopAuthApp(other), "markie", `should fall back for ${String(other)}`);
  }
});

test("desktopAuthApp names Markie Nightly only for its exact name", () => {
  assert.equal(desktopAuthApp("markie-nightly"), "markie-nightly");
  for (const other of ["MARKIE-NIGHTLY", "markie-nightly ", " markie-nightly", "markie-nightly://x", "markie_nightly", "nightly", "markie-nightly\n", "markie-super-nightly"]) {
    assert.equal(desktopAuthApp(other), "markie", `should fall back for ${JSON.stringify(other)}`);
  }
  assert.equal(desktopAuthAppName("markie"), "Markie");
  assert.equal(desktopAuthAppName("markie-rs"), "Markie RS");
  assert.equal(desktopAuthAppName("markie-nightly"), "Markie Nightly");
});

test("desktopAuthDeepLink sends Markie Nightly its own scheme, never Markie's or Markie RS's", () => {
  assert.equal(
    desktopAuthDeepLink("abc", NONCE, "https://docs.example.com", "markie-nightly"),
    `markie-nightly://auth?token=abc&state=${NONCE}&iss=https%3A%2F%2Fdocs.example.com`,
  );
  const u = new URL(desktopAuthDeepLink("a b&c", NONCE, null, "markie-nightly"));
  assert.equal(u.protocol, "markie-nightly:");
  assert.equal(u.host, "auth");
  assert.equal(u.searchParams.get("token"), "a b&c");
});

test("desktopAuthDeepLink sends Markie RS its own scheme and leaves Markie's unchanged", () => {
  assert.equal(
    desktopAuthDeepLink("abc", NONCE, "https://docs.example.com", "markie-rs"),
    `markie-rs://auth?token=abc&state=${NONCE}&iss=https%3A%2F%2Fdocs.example.com`,
  );
  assert.equal(desktopAuthDeepLink("abc", NONCE, null, "markie"), `markie://auth?token=abc&state=${NONCE}`);
  const u = new URL(desktopAuthDeepLink("abc", NONCE, null, "markie-rs"));
  assert.equal(u.protocol, "markie-rs:");
  assert.equal(u.host, "auth");
});
