// Two promises the phone app leans on (mobile plan 8.5 and 8.11): a session's
// lifetime is the one written in auth.ts and nobody else's default, and a
// sign-in that was rate limited says how long to wait.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getMigrations } from "better-auth/db/migration";
import { DEFAULT_RETRY_AFTER_SECONDS, withRetryAfter } from "./retry-after.ts";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-auth-session-")), "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-auth-session-test-secret-32-plus-characters";

const { auth, SESSION_EXPIRES_IN_SECONDS, SESSION_UPDATE_AGE_SECONDS } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();

// The same wrapping index.ts gives /api/auth/*.
const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", async (c) => withRetryAfter(await auth.handler(c.req.raw)));

test("a session lasts seven days and is renewed at most once a day", async () => {
  // The values every session had before they were written down. Changing
  // either is a decision: shorter signs people out early.
  assert.equal(SESSION_EXPIRES_IN_SECONDS, 604_800);
  assert.equal(SESSION_UPDATE_AGE_SECONDS, 86_400);
  assert.equal(auth.options.session?.expiresIn, 604_800);
  assert.equal(auth.options.session?.updateAge, 86_400);
  // And they are what better-auth actually runs with.
  const context = await auth.$context;
  assert.equal(context.sessionConfig.expiresIn, 604_800);
  assert.equal(context.sessionConfig.updateAge, 86_400);
});

test("a new session expires seven days out", async () => {
  const email = `session-${Date.now()}@example.com`;
  const context = await auth.$context;
  const user = await context.internalAdapter.createUser({ email, name: "Session", emailVerified: true });
  const before = Date.now();
  const session = await context.internalAdapter.createSession(user.id);
  const life = new Date(session.expiresAt).getTime() - before;
  assert.ok(Math.abs(life - 604_800_000) < 60_000, `expected about seven days, got ${life} ms`);
});

test("a rate-limited emailed code answers 429 with Retry-After", async () => {
  const send = () => app.request("/api/auth/email-otp/send-verification-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "10.9.9.9", Origin: "http://localhost:3000" },
    body: JSON.stringify({ email: "limited@example.com", type: "sign-in" }),
  });
  // auth.ts allows five sends a minute from one address.
  let limited: Response | null = null;
  for (let i = 0; i < 8 && !limited; i += 1) {
    const response = await send();
    if (response.status === 429) limited = response;
  }
  assert.ok(limited, "the sixth send from one address is refused");
  const wait = Number(limited.headers.get("Retry-After"));
  assert.ok(Number.isInteger(wait) && wait >= 1 && wait <= 60, `Retry-After is whole seconds within the window, got ${limited.headers.get("Retry-After")}`);
});

test("a rate-limited password sign-in answers 429 with Retry-After", async () => {
  const signIn = () => app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "10.9.9.10", Origin: "http://localhost:3000" },
    body: JSON.stringify({ email: "nobody@example.com", password: "wrong-password-1" }),
  });
  let limited: Response | null = null;
  for (let i = 0; i < 14 && !limited; i += 1) {
    const response = await signIn();
    if (response.status === 429) limited = response;
  }
  assert.ok(limited, "the eleventh attempt from one address is refused");
  assert.match(limited.headers.get("Retry-After") ?? "", /^[1-9]\d*$/);
});

test("withRetryAfter leaves every other answer alone", () => {
  const ok = new Response("{}", { status: 200 });
  assert.equal(withRetryAfter(ok), ok);
  assert.equal(ok.headers.has("Retry-After"), false);
  const already = new Response("", { status: 429, headers: { "Retry-After": "7" } });
  assert.equal(withRetryAfter(already).headers.get("Retry-After"), "7");
});

test("withRetryAfter reads X-Retry-After, and falls back to a minute", () => {
  assert.equal(withRetryAfter(new Response("", { status: 429, headers: { "X-Retry-After": "12" } })).headers.get("Retry-After"), "12");
  assert.equal(withRetryAfter(new Response("", { status: 429, headers: { "X-Retry-After": "2.2" } })).headers.get("Retry-After"), "3");
  for (const bad of ["", "soon", "-4", "0"]) {
    const headers: Record<string, string> = bad ? { "X-Retry-After": bad } : {};
    assert.equal(withRetryAfter(new Response("", { status: 429, headers })).headers.get("Retry-After"), String(DEFAULT_RETRY_AFTER_SECONDS));
  }
  assert.equal(withRetryAfter(new Response("", { status: 429, headers: { "X-Retry-After": "999999" } })).headers.get("Retry-After"), "3600");
});
