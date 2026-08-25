import { test } from "node:test";
import assert from "node:assert/strict";

// The origin is publicly reachable, not only the CDN in front of it. These
// assert what the application itself sends, because a header that exists only
// on Vercel is not a header Markie has.
process.env.MARKIE_NO_LISTEN = "1";
const { app } = await import("./index.ts");

const get = (path: string) => app.request(path);

test("every response carries the baseline hardening headers", async () => {
  for (const path of ["/health", "/api/me", "/download/latest.json"]) {
    const res = await get(path);
    const h = res.headers;
    assert.equal(h.get("x-content-type-options"), "nosniff", `${path} nosniff`);
    assert.equal(h.get("x-frame-options"), "DENY", `${path} frame options`);
    assert.equal(
      h.get("referrer-policy"),
      "strict-origin-when-cross-origin",
      `${path} referrer policy`
    );
    assert.match(h.get("strict-transport-security") ?? "", /max-age=\d+/, `${path} hsts`);
  }
});

test("html responses carry a content security policy", async () => {
  const res = await get("/download");
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const csp = res.headers.get("content-security-policy") ?? "";
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
});

test("the policy still allows what a shared document legitimately contains", async () => {
  // A document with a remote image must render. A policy that blanks images is
  // a policy somebody switches off, which is worse than a permissive img-src.
  const csp = (await get("/download")).headers.get("content-security-policy") ?? "";
  assert.match(csp, /img-src [^;]*https:/);
  assert.match(csp, /style-src [^;]*'unsafe-inline'/);
});

test("the page that hands out a session token is never cached", async () => {
  // It carries a live credential in the markup and in the link. Cacheable is
  // the wrong default for that, whether the session resolves or not.
  const res = await get("/auth/desktop-bridge");
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
});

test("the route naming the signed-in user is never cached", async () => {
  const res = await get("/api/me");
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
});

test("an unknown api route answers json without a stack", async () => {
  const res = await get("/api/definitely-not-a-route");
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.deepEqual(body, { error: "not found" });
});
