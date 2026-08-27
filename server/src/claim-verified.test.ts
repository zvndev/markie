// The 0.4.x share-takeover flaw, pinned.
//
// A document shared to alice@corp.com before Alice has an account becomes a
// `pending_shares` row. Anyone could then register that address (nothing
// proved they owned it) and the signup hook, plus the docs-listing sweep,
// converted the invite into a real share on the attacker's account. These
// cases are that attack, run against the server, plus the legitimate flow it
// must not break: the person who actually receives mail at the address proves
// it with the emailed code and gets the document.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getMigrations } from "better-auth/db/migration";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-claim-")), "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-claim-test-secret-32-plus-chars!!";
process.env.MARKIE_SITE_URL = "https://markie.test";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) {
  await runMigrations();
}

const { docs } = await import("./docs.ts");
const { shares } = await import("./shares.ts");
const Database = (await import("better-sqlite3")).default;
const db = new Database(process.env.DB_PATH as string);

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/docs", docs);
app.route("/api/docs", shares);

const ORIGIN = { Origin: "http://localhost:3000" };
const stamp = Date.now();

// Every request comes from its own address: these cases need more signups and
// OTP sends than the rate limiter allows from one caller, and throttling is
// tested elsewhere.
let callCount = 0;
function headers(token?: string) {
  callCount += 1;
  const h = new Headers({
    "Content-Type": "application/json",
    "x-forwarded-for": `10.1.${Math.floor(callCount / 250)}.${callCount % 250}`,
    ...ORIGIN,
  });
  if (token) h.set("Authorization", `Bearer ${token}`);
  return h;
}

async function post<T>(path: string, body: unknown, token?: string) {
  const res = await app.request(path, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    authToken: res.headers.get("set-auth-token"),
    data: (await res.json().catch(() => null)) as T | null,
  };
}

async function get<T>(path: string, token?: string) {
  const res = await app.request(path, { headers: headers(token) });
  return {
    status: res.status,
    data: (await res.json().catch(() => null)) as T | null,
  };
}

async function signUp(name: string, email: string) {
  const res = await post<{ user?: { id: string } }>("/api/auth/sign-up/email", {
    name,
    email,
    password: "password-123456",
  });
  return res;
}

function userIdFor(email: string): string | undefined {
  const row = db
    .prepare("SELECT id FROM user WHERE email = ?")
    .get(email.toLowerCase()) as { id: string } | undefined;
  return row?.id;
}

function sharesFor(email: string) {
  return db
    .prepare(
      `SELECT s.doc_id, s.role FROM shares s
       JOIN user u ON u.id = s.user_id
       WHERE u.email = ?`
    )
    .all(email.toLowerCase()) as Array<{ doc_id: string; role: string }>;
}

function pendingFor(email: string) {
  return db
    .prepare("SELECT doc_id, role FROM pending_shares WHERE email = ?")
    .all(email.toLowerCase()) as Array<{ doc_id: string; role: string }>;
}

// A live session for a user, minted directly. Signup stops handing out a
// session once verification is required, but an unverified session is still
// reachable in production (changing your email clears the flag under a session
// that is already open), so the listing sweep has to be gated in its own
// right rather than relying on "unverified users never hold a session".
function mintSession(userId: string): string {
  const token = `sess-${userId}-${callCount}-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId)
     VALUES (?, ?, ?, ?, ?, '127.0.0.1', '', ?)`
  ).run(
    `sid-${token}`,
    new Date(Date.now() + 86_400_000).toISOString(),
    token,
    now,
    now,
    userId
  );
  return token;
}

// The one-time code better-auth just emailed, read back out of its own
// verification store so the test uses the real code rather than a stub.
function latestOTP(type: string, email: string): string {
  const row = db
    .prepare(
      "SELECT value FROM verification WHERE identifier = ? ORDER BY createdAt DESC LIMIT 1"
    )
    .get(`${type}-otp-${email.toLowerCase()}`) as { value: string } | undefined;
  assert.ok(row, `no ${type} OTP was issued for ${email}`);
  return row.value.slice(0, row.value.lastIndexOf(":"));
}

async function ownerWithDoc(slug: string) {
  const email = `cv.owner.${slug}.${stamp}@test.local`;
  const res = await signUp("Owner", email);
  assert.equal(res.status, 200);
  // The owner has to be able to act, and after the fix a fresh signup holds no
  // session, so the owner is verified the same way any real owner would be.
  db.prepare("UPDATE user SET emailVerified = 1 WHERE email = ?").run(email);
  const ownerId = userIdFor(email) as string;
  const token = mintSession(ownerId);
  const docId = `cv-${slug}-${stamp}`;
  const content = `# ${slug}\n\nbody\n`;
  const put = await app.request(`/api/docs/${docId}`, {
    method: "PUT",
    headers: headers(token),
    body: JSON.stringify({
      name: `${slug}.md`,
      content,
      hash: createHash("sha256").update(content, "utf8").digest("hex"),
      baseVersion: 0,
    }),
  });
  assert.equal(put.status, 200);
  return { token, docId };
}

async function invite(ownerToken: string, docId: string, email: string) {
  const res = await post<{ status: string }>(
    `/api/docs/${docId}/shares`,
    { email, role: "editor" },
    ownerToken
  );
  assert.equal(res.status, 200);
  assert.equal(res.data?.status, "invited", "the invite must land as pending");
}

// ---------------------------------------------------------------------------
// The attack.
// ---------------------------------------------------------------------------

test("registering the victim's address does not hand over their pending share", async () => {
  const victim = `cv.victim.${stamp}@corp.test`;
  const { token: ownerToken, docId } = await ownerWithDoc("signup");
  await invite(ownerToken, docId, victim);

  // The attacker types an address they do not own and sets a password.
  const attacker = await signUp("Attacker", victim);
  assert.equal(attacker.status, 200);

  assert.deepEqual(
    sharesFor(victim),
    [],
    "signing up must not convert a pending invite into a share"
  );
  assert.equal(
    pendingFor(victim).length,
    1,
    "the invite must still be waiting for whoever proves the address"
  );
});

test("an unverified session cannot harvest the invite by listing documents", async () => {
  const victim = `cv.list.${stamp}@corp.test`;
  const { token: ownerToken, docId } = await ownerWithDoc("list");
  await invite(ownerToken, docId, victim);

  const attacker = await signUp("Attacker", victim);
  assert.equal(attacker.status, 200);
  const attackerId = userIdFor(victim) as string;
  assert.ok(attackerId);

  // Whatever session an unverified account ends up holding, the listing sweep
  // must refuse it. This was a second, independent takeover path: even with the
  // signup hook gated, GET /api/docs claimed on every call.
  const listed = await get<{ docs: Array<{ id: string }> }>(
    "/api/docs",
    mintSession(attackerId)
  );
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.data?.docs ?? [],
    [],
    "an unverified caller must not receive the invited document"
  );
  assert.deepEqual(sharesFor(victim), [], "listing must not mint a share");
  assert.equal(pendingFor(victim).length, 1, "the invite must still be pending");
});

// ---------------------------------------------------------------------------
// The legitimate flow the fix must not break.
// ---------------------------------------------------------------------------

test("proving the address with the emailed code delivers the share", async () => {
  const victim = `cv.proves.${stamp}@corp.test`;
  const { token: ownerToken, docId } = await ownerWithDoc("proves");
  await invite(ownerToken, docId, victim);

  const signup = await signUp("Real Alice", victim);
  assert.equal(signup.status, 200);
  assert.deepEqual(sharesFor(victim), [], "still nothing before the proof");

  // The real owner of the mailbox asks for a code and enters it.
  const sent = await post("/api/auth/email-otp/send-verification-otp", {
    email: victim,
    type: "email-verification",
  });
  assert.equal(sent.status, 200);
  const verified = await post("/api/auth/email-otp/verify-email", {
    email: victim,
    otp: latestOTP("email-verification", victim),
  });
  assert.equal(verified.status, 200);

  const row = db
    .prepare("SELECT emailVerified FROM user WHERE email = ?")
    .get(victim) as { emailVerified: number };
  assert.equal(row.emailVerified, 1, "the code must mark the address proven");

  assert.deepEqual(
    sharesFor(victim).map((s) => s.doc_id),
    [docId],
    "the proven owner of the address receives the document"
  );
  assert.equal(pendingFor(victim).length, 0, "the invite is consumed exactly once");
});

test("an account that arrives already proven claims at creation", async () => {
  // Google OAuth users arrive with emailVerified already true, and so does a
  // first-time email-OTP sign-in: the code went to that mailbox. Neither should
  // have to wait for a second proof, so the create hook still claims when the
  // account is born verified.
  const invitee = `cv.otpnew.${stamp}@corp.test`;
  const { token: ownerToken, docId } = await ownerWithDoc("otpnew");
  await invite(ownerToken, docId, invitee);
  assert.equal(userIdFor(invitee), undefined, "no account yet");

  const sent = await post("/api/auth/email-otp/send-verification-otp", {
    email: invitee,
    type: "sign-in",
  });
  assert.equal(sent.status, 200);
  const signedIn = await post("/api/auth/sign-in/email-otp", {
    email: invitee,
    otp: latestOTP("sign-in", invitee),
  });
  assert.equal(signedIn.status, 200);

  assert.deepEqual(
    sharesFor(invitee).map((s) => s.doc_id),
    [docId],
    "an account created already verified gets its invites at once"
  );
});

test("claiming is idempotent: a verified listing does not duplicate the share", async () => {
  const invitee = `cv.twice.${stamp}@corp.test`;
  const { token: ownerToken, docId } = await ownerWithDoc("twice");
  await invite(ownerToken, docId, invitee);

  await signUp("Twice", invitee);
  const inviteeId = userIdFor(invitee) as string;
  db.prepare("UPDATE user SET emailVerified = 1 WHERE id = ?").run(inviteeId);
  const token = mintSession(inviteeId);

  const first = await get<{ docs: unknown[] }>("/api/docs", token);
  assert.equal(first.status, 200);
  const second = await get<{ docs: unknown[] }>("/api/docs", token);
  assert.equal(second.status, 200);

  const rows = sharesFor(invitee);
  assert.equal(rows.length, 1, "sweeping twice must leave exactly one share");
  assert.equal(rows[0].doc_id, docId);
});

// ---------------------------------------------------------------------------
// Proving your own address and signing in by code are different events.
//
// better-auth's email-OTP SIGN-IN route revokes every credential an unverified
// account accrued before the proof (revokeUnprovenAccountAccess). That is how
// the real owner of an address takes back an account a squatter registered
// first: the squatter's password goes with it. Run the same route against a
// person finishing their own signup and it deletes the password they just
// chose, which is what 0.4.x did to every new account. So signup verification
// goes through /email-otp/verify-email, which proves the address and touches
// nothing else.
//
// Both behaviors are pinned here, in one suite, on purpose. Each one looks like
// a bug from the other's side, and a change that "fixes" either by breaking the
// other is not a fix.
// ---------------------------------------------------------------------------

const PASSWORD = "password-123456";

async function signInWithPassword(email: string, password: string = PASSWORD) {
  return post<{ user?: { id: string } }>("/api/auth/sign-in/email", {
    email,
    password,
  });
}

test("verifying a new signup keeps the password it was created with", async () => {
  const email = `cv.keeps.${stamp}@corp.test`;
  const signup = await signUp("Keeps Password", email);
  assert.equal(signup.status, 200);

  // The code signup mailed, entered on the verification route.
  const verified = await post("/api/auth/email-otp/verify-email", {
    email,
    otp: latestOTP("email-verification", email),
  });
  assert.equal(verified.status, 200);
  assert.ok(
    verified.authToken,
    "proving the address should finish the job and sign the new user in"
  );

  const signedIn = await signInWithPassword(email);
  assert.equal(
    signedIn.status,
    200,
    "the password chosen at signup must still work after verification"
  );
  assert.ok(signedIn.authToken, "and it must hand back a session");
});

test("signing in by code against an unverified account still revokes what it had", async () => {
  const email = `cv.reclaim.${stamp}@corp.test`;
  const squatted = await signUp("Squatter", email);
  assert.equal(squatted.status, 200);

  // The reclaim path: whoever actually receives mail at the address asks for a
  // sign-in code. The account was never proven, so nothing it accrued survives.
  const sent = await post("/api/auth/email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  });
  assert.equal(sent.status, 200);
  const byCode = await post("/api/auth/sign-in/email-otp", {
    email,
    otp: latestOTP("sign-in", email),
  });
  assert.equal(byCode.status, 200);
  assert.ok(byCode.authToken, "the owner of the mailbox gets the session");

  const withPassword = await signInWithPassword(email);
  assert.equal(
    withPassword.status,
    401,
    "a password nobody had proven must not survive the reclaim"
  );
});

test("an account left without a password can set one with a reset code", async () => {
  // The way back for anyone whose credentials the reclaim path revoked, on
  // 0.4.x or otherwise: the reset route creates a credential where there is
  // none, so "forgot password" also means "never had one".
  const email = `cv.setsagain.${stamp}@corp.test`;
  await signUp("Reclaimed", email);
  await post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
  await post("/api/auth/sign-in/email-otp", {
    email,
    otp: latestOTP("sign-in", email),
  });
  assert.equal((await signInWithPassword(email)).status, 401, "no password to start");

  const asked = await post("/api/auth/forget-password/email-otp", { email });
  assert.equal(asked.status, 200);
  const reset = await post("/api/auth/email-otp/reset-password", {
    email,
    otp: latestOTP("forget-password", email),
    password: "brand-new-password-1",
  });
  assert.equal(reset.status, 200);

  const signedIn = await signInWithPassword(email, "brand-new-password-1");
  assert.equal(signedIn.status, 200, "the new password works");
  assert.ok(signedIn.authToken);
});
