// The app shell: health, session, CORS, and the JSON error contract. The
// desktop sync client parses the body of every non-2xx API response, so a
// text/plain 404 from Hono's default handler reads to it as an unexplained
// failure. These pin the shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-index-")), "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-index-test-secret-32-plus-characters";
process.env.MARKIE_SITE_URL = "https://markie.test";
// Importing the app must not bind :8787 or open the collab websocket server.
process.env.MARKIE_NO_LISTEN = "1";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) {
  await runMigrations();
}

const { app } = await import("./index.ts");
const { HTTPException } = await import("hono/http-exception");

// A route that answers with a deliberate status. Registered here rather than in
// index.ts because the point is the error handler, not the route.
app.get("/__test/http-exception", () => {
  throw new HTTPException(429, { message: "slow down" });
});

const APP_ORIGIN = "app://markie";
const stamp = Date.now();

function request(path: string, init: RequestInit = {}, origin = "http://localhost:3000") {
  const headers = new Headers(init.headers);
  headers.set("x-forwarded-for", "127.0.0.1");
  headers.set("Origin", origin);
  return app.request(path, { ...init, headers });
}

test("/health answers with the service identity", async () => {
  const res = await request("/health");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(await res.json(), {
    ok: true,
    service: "markie-api",
    version: "0.1.0",
  });
});

test("/api/me reports no user without a session, rather than failing", async () => {
  const res = await request("/api/me");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { user: null });
});

test("/api/me ignores a bogus bearer token", async () => {
  const res = await request("/api/me", {
    headers: { Authorization: "Bearer not-a-real-token" },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { user: null });
});

test("/api/me returns the signed-in account", async () => {
  const email = `me-${stamp}@markie.test`;
  // Signing up no longer hands out a session: the address has to be proven
  // first. signUpVerified does both and returns the bearer token.
  const { token } = await signUpVerified(app, { name: "Ada Lovelace", email });

  const res = await request("/api/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { user: { email: string; name: string; id: string } };
  assert.equal(body.user.email, email);
  assert.equal(body.user.name, "Ada Lovelace");
  assert.ok(body.user.id);
  // only the three fields the renderer needs — no session token, no password hash
  assert.deepEqual(Object.keys(body.user).sort(), ["email", "id", "name"]);
});

test("CORS allows the packaged desktop app", async () => {
  const res = await request("/health", {}, APP_ORIGIN);
  assert.equal(res.headers.get("access-control-allow-origin"), APP_ORIGIN);
  assert.equal(res.headers.get("access-control-allow-credentials"), "true");
  assert.match(res.headers.get("access-control-expose-headers") ?? "", /set-auth-token/i);
});

test("CORS allows the dev renderer", async () => {
  const res = await request("/health", {}, "http://localhost:3000");
  assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
});

test("CORS refuses an arbitrary origin", async () => {
  const res = await request("/health", {}, "https://evil.example");
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("a CORS preflight from the app is answered; one from a stranger is not", async () => {
  const allowed = await request(
    "/api/me",
    {
      method: "OPTIONS",
      headers: {
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    },
    APP_ORIGIN
  );
  assert.equal(allowed.headers.get("access-control-allow-origin"), APP_ORIGIN);

  const refused = await request(
    "/api/me",
    { method: "OPTIONS", headers: { "Access-Control-Request-Method": "GET" } },
    "https://evil.example"
  );
  assert.equal(refused.headers.get("access-control-allow-origin"), null);
});

test("an unknown API route answers JSON, not text/plain", async () => {
  const res = await request("/api/nope");
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(await res.json(), { error: "not found" });
});

test("an unknown path of any shape answers the same JSON 404", async () => {
  for (const path of ["/", "/nope", "/api/does-not-exist", "/api/me/themes/extra"]) {
    const res = await request(path);
    assert.equal(res.status, 404, path);
    assert.deepEqual(await res.json(), { error: "not found" }, path);
  }
});

test("an unhandled error answers JSON 500, with no stack in production", async () => {
  const email = `boom-${stamp}@markie.test`;
  const { token } = await signUpVerified(app, { name: "Boom", email });

  // Malformed JSON on a route that parses a body: the handler throws, and
  // without app.onError Hono answers text/plain.
  const send = () =>
    request("/api/me/themes", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{ not json",
    });

  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    const res = await send();
    assert.equal(res.status, 500);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await res.json(), { error: "internal error" });

    process.env.NODE_ENV = "development";
    const dev = (await (await send()).json()) as { error: string; detail?: string };
    assert.equal(dev.error, "internal error");
    assert.ok(dev.detail, "development responses should carry the reason");
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("the HTML routes still answer in HTML, not the JSON 404", async () => {
  // /s/:token and /d/:id own their own not-found pages; the JSON notFound
  // handler must not have taken them over.
  const share = await request("/s/definitely-not-a-real-token");
  assert.equal(share.status, 404);
  assert.match(share.headers.get("content-type") ?? "", /text\/html/);

  const doc = await request("/d/00000000-0000-0000-0000-000000000000");
  assert.ok(doc.status === 403 || doc.status === 404, `unexpected ${doc.status}`);
  assert.match(doc.headers.get("content-type") ?? "", /text\/html/);
});

test("a deliberate HTTPException keeps its own status and body", async () => {
  // Before this, onError flattened every throw into a 500, so a rate limit or
  // an auth refusal reached the desktop client as an unexplained server error.
  const res = await request("/__test/http-exception");
  assert.equal(res.status, 429);
  assert.equal(await res.text(), "slow down");
});
