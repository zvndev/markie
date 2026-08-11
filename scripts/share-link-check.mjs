// End-to-end check of the link a person actually receives when you share a
// document with them.
//
// The unit tests call the route directly. This one boots a real server, shares
// a real document, and pulls the URL out of the real email body, because the
// thing that broke before was never the route: it was the link. A share email
// whose button 404s is indistinguishable, from the outside, from sharing being
// broken entirely.
//
//   node scripts/share-link-check.mjs
//
// Exits non-zero on the first failed check.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = join(fileURLToPath(import.meta.url), "..");
const serverDir = join(here, "..", "server");
const PORT = 8793;
const SERVER = `http://localhost:${PORT}`;
const SITE = `http://localhost:${PORT}`;

const workDir = mkdtempSync(join(tmpdir(), "markie-share-link-"));
const dbPath = join(workDir, "t.db");

let passed = 0;
const failures = [];
function check(label, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const env = {
  ...process.env,
  NODE_ENV: "development",
  DB_PATH: dbPath,
  PORT: String(PORT),
  BETTER_AUTH_URL: SERVER,
  BETTER_AUTH_SECRET: "markie-share-link-verifier-secret-32-plus",
  MARKIE_SITE_URL: SITE,
  // No RESEND_API_KEY: sendEmail prints to stdout, which is where the link is
  // read back from. That is deliberate — the assertion is about the body a
  // recipient would receive, not about an internal return value.
  RESEND_API_KEY: "",
};

let serverProc = null;
let serverOut = "";

async function waitFor(label, fn, timeoutMs = 30000) {
  const started = Date.now();
  for (;;) {
    let value = null;
    try {
      value = await fn();
    } catch {
      value = null;
    }
    if (value) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

function cleanup() {
  if (serverProc && !serverProc.killed) serverProc.kill("SIGTERM");
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

let signUpCount = 0;
async function api(path, { method = "GET", token, body, headers = {} } = {}) {
  const h = new Headers({
    "Content-Type": "application/json",
    Origin: "http://localhost:3000",
    ...headers,
  });
  if (token) h.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: res.status, data, text, headers: res.headers };
}

async function signUp(name, email) {
  signUpCount += 1;
  const res = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: { name, email, password: "password-123" },
    // Own address per account: the auth rate limiter is not what is under test.
    headers: {
      "x-forwarded-for": `10.1.${Math.floor(signUpCount / 250)}.${signUpCount % 250}`,
    },
  });
  if (res.status !== 200) throw new Error(`sign-up ${email} -> ${res.status}`);
  return { token: res.headers.get("set-auth-token"), email };
}

// Pull the most recent /d/ link out of what the server printed to stdout.
function lastEmailedDocLink() {
  const matches = [...serverOut.matchAll(/http:\/\/localhost:\d+\/d\/[^\s"<)]+/g)];
  const last = matches.at(-1)?.[0] ?? null;
  // The text body and the HTML body both carry it; strip an HTML tail if the
  // HTML copy is what matched.
  return last ? last.replace(/&amp;/g, "&") : null;
}

async function main() {
  console.log(`work dir: ${workDir}\n`);

  const node = process.execPath;
  await new Promise((resolve, reject) => {
    const m = spawn(node, ["--experimental-strip-types", "src/migrate.ts"], {
      cwd: serverDir,
      env,
      stdio: "inherit",
    });
    m.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`migrate exited ${code}`))
    );
  });

  serverProc = spawn(node, ["--experimental-strip-types", "src/index.ts"], {
    cwd: serverDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProc.stdout.on("data", (d) => (serverOut += d.toString()));
  serverProc.stderr.on("data", (d) => (serverOut += d.toString()));

  await waitFor("server health", async () =>
    (await fetch(`${SERVER}/health`).catch(() => null))?.ok
  );
  console.log("server up\n");

  const stamp = Date.now();
  const owner = await signUp("Owner", `owner.${stamp}@test.local`);
  const bob = await signUp("Bob", `bob.${stamp}@test.local`);

  const docId = `share-link-${stamp}`;
  const content = `# Quarterly plan\n\nthe-body-only-members-see\n`;
  const put = await api(`/api/docs/${docId}`, {
    method: "PUT",
    token: owner.token,
    body: {
      name: "quarterly-plan.md",
      content,
      hash: createHash("sha256").update(content, "utf8").digest("hex"),
      baseVersion: 0,
    },
  });
  check("owner can create a document", put.status === 200, `status ${put.status}`);

  // ── existing user ────────────────────────────────────────────────────────
  console.log("\nexisting Markie user:");
  serverOut = "";
  const shared = await api(`/api/docs/${docId}/shares`, {
    method: "POST",
    token: owner.token,
    body: { email: bob.email, role: "editor" },
  });
  check("sharing with an existing user succeeds", shared.status === 200);
  check("they become a member immediately", shared.data?.status === "member");

  const memberLink = lastEmailedDocLink();
  check("the email contains a document link", !!memberLink, memberLink ?? "none found");
  check(
    "the email no longer says \"You're in\" with nowhere to go",
    !/You're in/.test(serverOut)
  );
  check(
    "the email carries an Open in Markie deep link",
    /markie:\/\/doc\?id=/.test(serverOut)
  );
  check(
    "the email does not hand out a public /s/ link",
    !/\/s\/[A-Za-z0-9_-]{10,}/.test(serverOut)
  );

  const opened = await fetch(memberLink);
  const openedBody = await opened.text();
  check("the link opens the document", opened.status === 200, `status ${opened.status}`);
  check(
    "the document body is there",
    openedBody.includes("the-body-only-members-see")
  );
  check(
    "the page is not cached by shared caches",
    /no-store/.test(opened.headers.get("cache-control") ?? "")
  );
  check(
    "the page cannot be framed",
    (opened.headers.get("x-frame-options") ?? "") === "DENY"
  );
  check(
    "the page offers to open in Markie",
    openedBody.includes("markie://doc?id=")
  );

  // The document itself must never be reachable without the link.
  const bare = await fetch(`${SERVER}/d/${docId}`);
  const bareBody = await bare.text();
  check("a bare document URL is refused", bare.status === 403, `status ${bare.status}`);
  check(
    "the refusal leaks neither body nor filename",
    !bareBody.includes("the-body-only-members-see") &&
      !bareBody.includes("quarterly-plan.md")
  );

  // ── revocation ───────────────────────────────────────────────────────────
  console.log("\nafter removing them:");
  const removed = await api(
    `/api/docs/${docId}/shares/${shared.data?.userId}`,
    { method: "DELETE", token: owner.token }
  );
  check("owner can remove the member", removed.status === 200);
  const afterRemoval = await fetch(memberLink);
  const afterBody = await afterRemoval.text();
  check(
    "their emailed link stops working immediately",
    afterRemoval.status === 403,
    `status ${afterRemoval.status}`
  );
  check(
    "and shows them none of the document",
    !afterBody.includes("the-body-only-members-see")
  );

  // ── someone with no account yet ──────────────────────────────────────────
  console.log("\nsomeone with no Markie account:");
  serverOut = "";
  const inviteEmail = `newcomer.${stamp}@test.local`;
  const invited = await api(`/api/docs/${docId}/shares`, {
    method: "POST",
    token: owner.token,
    body: { email: inviteEmail, role: "viewer" },
  });
  check("inviting a stranger succeeds", invited.status === 200);
  check("they are recorded as pending", invited.data?.status === "invited");

  const inviteLink = lastEmailedDocLink();
  check("the invite contains a document link", !!inviteLink);
  check(
    "the invite does not mint a public link",
    !/\/s\/[A-Za-z0-9_-]{10,}/.test(serverOut)
  );

  const inviteOpened = await fetch(inviteLink);
  const inviteBody = await inviteOpened.text();
  check(
    "the invite link reads without an account",
    inviteOpened.status === 200,
    `status ${inviteOpened.status}`
  );
  check("and shows the document", inviteBody.includes("the-body-only-members-see"));

  // ── the link survives them signing up ────────────────────────────────────
  console.log("\nafter they make an account:");
  const newcomer = await signUp("Newcomer", inviteEmail);
  const listed = await api("/api/docs", { token: newcomer.token });
  check("their invite is claimed into the Library", listed.status === 200);
  const afterSignup = await fetch(inviteLink);
  check(
    "the link in the email they already have still works",
    afterSignup.status === 200,
    `status ${afterSignup.status}`
  );

  // ── withdrawing the invite ───────────────────────────────────────────────
  console.log("\nafter revoking the newcomer:");
  const whoami = await api("/api/me", { token: newcomer.token });
  const revoked = await api(
    `/api/docs/${docId}/shares/${whoami.data?.user?.id ?? whoami.data?.id}`,
    { method: "DELETE", token: owner.token }
  );
  check("owner can remove them too", revoked.status === 200, `status ${revoked.status}`);
  const afterRevoke = await fetch(inviteLink);
  check(
    "the claimed link dies with the access",
    afterRevoke.status === 403,
    `status ${afterRevoke.status}`
  );

  console.log(
    `\n${passed}/${passed + failures.length} checks passed` +
      (failures.length ? `\n\nfailures:\n - ${failures.join("\n - ")}` : "")
  );
  if (failures.length) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(`\nfatal: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(cleanup);
