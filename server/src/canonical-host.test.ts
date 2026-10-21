import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalHostRedirect } from "./canonical-host.ts";

const CLOUD = "https://api.markiedocs.com";
const RAILWAY = "https://api-production-602f.up.railway.app";
const after = { origin: CLOUD, apiAliases: [RAILWAY] };
const before = { origin: RAILWAY, apiAliases: [CLOUD] };

// What @hono/node-server hands the app: an http URL built from Host, since
// TLS ends at Railway's edge.
const request = (host: string, path: string, init: RequestInit & { forwardedHost?: string } = {}) => {
  const headers = new Headers(init.headers);
  headers.set("host", host);
  if (init.forwardedHost) headers.set("x-forwarded-host", init.forwardedHost);
  return new Request(`http://${host}${path}`, { method: init.method ?? "GET", headers });
};

test("a browser page on the old name goes to the same path and query on the new one", () => {
  const railway = "api-production-602f.up.railway.app";
  assert.equal(canonicalHostRedirect(request(railway, "/auth/google-start?state=0123456789abcdef"), after), `${CLOUD}/auth/google-start?state=0123456789abcdef`);
  assert.equal(canonicalHostRedirect(request(railway, "/auth/desktop-bridge?state=ab&error=x"), after), `${CLOUD}/auth/desktop-bridge?state=ab&error=x`);
  assert.equal(canonicalHostRedirect(request(railway, "/account/link-google"), after), `${CLOUD}/account/link-google`);
  assert.equal(canonicalHostRedirect(request(railway, "/account/google-link/complete?intentId=i"), after), `${CLOUD}/account/google-link/complete?intentId=i`);
  assert.equal(canonicalHostRedirect(request(railway, "/auth/google-start", { method: "HEAD" }), after), `${CLOUD}/auth/google-start`);
});

test("before the move it points the other way, from the new name to Railway", () => {
  assert.equal(canonicalHostRedirect(request("api.markiedocs.com", "/auth/google-start?state=ab"), before), `${RAILWAY}/auth/google-start?state=ab`);
  assert.equal(canonicalHostRedirect(request("api-production-602f.up.railway.app", "/auth/google-start?state=ab"), before), null);
});

test("the API, its auth routes and the proxied share and download pages are served on either name", () => {
  for (const path of ["/api/me", "/api/auth/callback/google?code=c&state=s", "/api/auth/get-session", "/api/server-info", "/s/token", "/d/doc", "/download", "/download/mac", "/health", "/authority", "/accounts"]) {
    assert.equal(canonicalHostRedirect(request("api-production-602f.up.railway.app", path), after), null, path);
  }
  assert.equal(canonicalHostRedirect(request("api-production-602f.up.railway.app", "/auth/google-start", { method: "POST" }), after), null);
});

test("the canonical host, an unknown host and a proxy's own host are served as they are", () => {
  assert.equal(canonicalHostRedirect(request("api.markiedocs.com", "/auth/google-start"), after), null);
  assert.equal(canonicalHostRedirect(request("API.MARKIEDOCS.COM:443", "/auth/google-start"), after), null);
  assert.equal(canonicalHostRedirect(request("api.railway.internal", "/auth/google-start"), after), null);
  assert.equal(canonicalHostRedirect(request("localhost:8787", "/auth/google-start"), after), null);
  // markiedocs.com's proxy reaches Railway by its hostname and says which
  // name the browser used; that name is not one of ours to move.
  assert.equal(
    canonicalHostRedirect(request("api-production-602f.up.railway.app", "/auth/google-start", { forwardedHost: "markiedocs.com" }), after),
    null
  );
  // A proxy that names the old host still means the old host.
  assert.equal(
    canonicalHostRedirect(request("10.0.0.1:8080", "/auth/google-start", { forwardedHost: "api-production-602f.up.railway.app, edge" }), after),
    `${CLOUD}/auth/google-start`
  );
});

test("a server with no other name never redirects", () => {
  const selfHosted = { origin: "https://docs.example.com", apiAliases: [] };
  assert.equal(canonicalHostRedirect(request("other.example.com", "/auth/google-start"), selfHosted), null);
  assert.equal(canonicalHostRedirect(request("api-production-602f.up.railway.app", "/auth/google-start"), selfHosted), null);
});

test("the target is never built from a header", () => {
  const target = canonicalHostRedirect(request("api-production-602f.up.railway.app", "//evil.example/auth/x?next=https://evil.example"), after);
  assert.ok(target === null || target.startsWith(`${CLOUD}/`));
});
