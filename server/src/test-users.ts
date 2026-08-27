// Test-only helper: make an account that can actually do something.
//
// Since the share-takeover fix (auth.ts) the server requires proof of email
// ownership before an account may sign in. Real users prove it with the code
// Markie emails them. Suites here skip the mailbox and mark the address
// verified directly, then sign in through the real route, so every session a
// test holds is one that passed the same gate a production session passes.
//
// This exists so that requiring verification stayed a one-line change per
// suite. Nothing in it relaxes an assertion: a suite that wants to test the
// UNVERIFIED case should sign up and stop there, as claim-verified.test.ts
// does.
import assert from "node:assert/strict";
import Database from "better-sqlite3";

// Hono's app, narrowed to what this file uses. Typed structurally so the
// helper does not drag the server's route wiring into every suite.
export interface TestApp {
  // Hono's own signature: app.request may answer synchronously, so this has to
  // accept both or every suite's `app` fails to match.
  request(path: string, init?: RequestInit): Response | Promise<Response>;
}

// Opened on first use, never at import time: suites set DB_PATH at the top of
// the file, and a static import that connected eagerly would race that.
let handle: Database.Database | null = null;
function db(): Database.Database {
  handle ??= new Database(process.env.DB_PATH ?? "./markie.db");
  return handle;
}

// Auth routes are rate limited per caller. Suites need far more accounts than
// one caller is allowed to create, and the throttling itself is covered
// elsewhere, so each call comes from its own address.
let calls = 0;
function authHeaders(): Headers {
  calls += 1;
  return new Headers({
    "Content-Type": "application/json",
    "x-forwarded-for": `10.9.${Math.floor(calls / 250) % 250}.${calls % 250}`,
    Origin: "http://localhost:3000",
  });
}

// Stand in for "the user entered the code we emailed them".
export function markVerified(email: string): void {
  db()
    .prepare("UPDATE user SET emailVerified = 1 WHERE email = ?")
    .run(email.toLowerCase());
}

export interface TestUser {
  token: string;
  email: string;
  id: string;
}

// Sign up, prove the address, sign in. Returns the bearer token the desktop
// client would hold.
export async function signUpVerified(
  app: TestApp,
  opts: { name: string; email: string; password?: string }
): Promise<TestUser> {
  const password = opts.password ?? "password-123";
  const created = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ name: opts.name, email: opts.email, password }),
  });
  assert.equal(created.status, 200, `sign-up failed for ${opts.email}`);
  const signUpBody = (await created.json().catch(() => null)) as {
    user?: { id: string };
  } | null;

  markVerified(opts.email);

  const signedIn = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ email: opts.email, password }),
  });
  assert.equal(signedIn.status, 200, `sign-in failed for ${opts.email}`);
  const token = signedIn.headers.get("set-auth-token");
  assert.ok(token, `expected a bearer token for ${opts.email}`);
  const signInBody = (await signedIn.json().catch(() => null)) as {
    user?: { id: string; email: string };
  } | null;
  // The account the server handed back has to be the one that was asked for.
  assert.equal(
    signInBody?.user?.email,
    opts.email.toLowerCase(),
    "signed in as a different account than the one created"
  );
  return {
    token,
    email: signInBody?.user?.email ?? opts.email,
    id: signInBody?.user?.id ?? signUpBody?.user?.id ?? "",
  };
}
