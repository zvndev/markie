#!/usr/bin/env node
// End-to-end check for the web side of cloud assets: a real server, three
// real accounts, and plain fetch() playing the parts of an owner, a stranger,
// a shared viewer's browser and an anonymous visitor holding a public link.
//
// No Markie window here — sync-down-check.mjs already proves the app draws a
// picture it fetched through the cloud. This proves the server's own gates:
// the bearer route, the signed-in web page, and the public link, including
// what happens the moment that link is revoked.
//
//   node scripts/asset-web-check.mjs
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const serverDir = path.join(root, "server");
const node = process.execPath;
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const artifactDir = path.join(root, ".autoloop", "runs", `asset-web-check-${stamp}`);
const children = [];
const tempPaths = [];

// A different port from sync-down-check.mjs's (8791) and from other things
// this machine already has listening (8792 is someone else's long-running
// process, not this repo's): the two check scripts are never run at the same
// time, but there is no reason to share a socket with anything else either.
const SERVER_PORT = 8793;
const SERVER = `http://localhost:${SERVER_PORT}`;

const baseEnv = {
  ...process.env,
  BETTER_AUTH_SECRET:
    process.env.BETTER_AUTH_SECRET ?? "markie-local-asset-web-verifier-secret-32",
};

await mkdir(artifactDir, { recursive: true });
const logPath = (name) => path.join(artifactDir, `${name}.log`);

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? baseEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  if (options.log) {
    const stream = createWriteStream(options.log, { flags: "a" });
    child.stdout?.pipe(stream, { end: false });
    child.stderr?.pipe(stream, { end: false });
    child.on("exit", () => stream.end());
  }
  return child;
}

async function stopChildren() {
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.killed) return resolve();
          child.once("exit", resolve);
          child.kill();
          setTimeout(resolve, 1500);
        })
    )
  );
}

async function waitFor(label, fn, timeoutMs = 30000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

const checks = [];
function check(name, passed, detail = "") {
  checks.push({ name, passed, detail });
  process.stdout.write(`${passed ? "  ok  " : "  FAIL"} ${name}${detail ? `\n         ${detail}` : ""}\n`);
}

const ORIGIN = { Origin: "http://localhost:3000" };
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// A real, valid 1x1 PNG, the same fixture sync-down-check.mjs draws with a
// real Electron window: every CRC and chunk length here checks out, so a
// server-side content check on the actual bytes (not just a fake header)
// still passes.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
const PNG_HASH = createHash("sha256").update(PNG_BYTES).digest("hex");

async function putDoc(token, docId, name, content, baseVersion) {
  const res = await fetch(`${SERVER}/api/docs/${docId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...ORIGIN,
    },
    body: JSON.stringify({ name, content, hash: sha(content), baseVersion }),
  });
  if (!res.ok) throw new Error(`PUT ${docId}: ${res.status} ${await res.text()}`);
  return (await res.json()).version;
}

// Sign-up no longer hands back a session: the address has to be proven with
// the emailed code first. Locally the server prints that email to its own
// stdout, which this run is already capturing, so read the code back from the
// log the way a person reads it from the inbox, prove the address, and sign
// in. Copied from sync-down-check.mjs rather than shared, since the two
// scripts otherwise have nothing in common worth a module for.
async function signUp(name, email, password) {
  const post = (p, body) =>
    fetch(`${SERVER}${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ORIGIN },
      body: JSON.stringify(body),
    });
  const res = await post("/api/auth/sign-up/email", { name, email, password });
  if (!res.ok) throw new Error(`signup: ${res.status} ${await res.text()}`);
  const otp = await waitFor(
    "verification code in the server log",
    () => {
      const log = readFileSync(logPath("server"), "utf-8");
      const m = log.match(new RegExp(`to=${email.replace(/[.+]/g, "\\$&")} subject="(\\d{6}) is your Markie verification code"`));
      return m ? m[1] : null;
    },
    20000
  );
  const verified = await post("/api/auth/email-otp/verify-email", { email, otp });
  if (!verified.ok) throw new Error(`verify-email: ${verified.status} ${await verified.text()}`);
  const signedIn = await post("/api/auth/sign-in/email", { email, password });
  if (!signedIn.ok) throw new Error(`sign-in: ${signedIn.status} ${await signedIn.text()}`);
  const token = signedIn.headers.get("set-auth-token");
  if (!token) throw new Error("sign-in returned no bearer token");
  return { email, token };
}

// GET one route, bearer-authenticated for whichever account is handed in (or
// anonymous when none is).
async function get(pathname, account) {
  const headers = new Headers(ORIGIN);
  if (account) headers.set("Authorization", `Bearer ${account.token}`);
  return fetch(`${SERVER}${pathname}`, { headers });
}

// The doc-view route (server/src/doc-view.ts) reads whichever it is handed:
// resolveViewer calls auth.api.getSession({ headers }), and the bearer plugin
// (server/src/auth.ts) makes an Authorization header behave exactly like the
// session cookie a signed-in browser would send. This is that header, named
// for the browser's own mechanism rather than the one this script happens to
// use to get the same session.
function cookieFor(account) {
  return { Authorization: `Bearer ${account.token}`, ...ORIGIN };
}

async function main() {
  const dbDir = await mkdtemp(path.join(tmpdir(), "markie-assetweb-db-"));
  tempPaths.push(dbDir);
  const dbPath = path.join(dbDir, "markie.db");
  const assetsDir = path.join(dbDir, "assets");
  const serverEnv = { ...baseEnv, DB_PATH: dbPath, PORT: String(SERVER_PORT), ASSETS_DIR: assetsDir };

  await new Promise((resolve, reject) => {
    const m = spawn(node, ["--experimental-strip-types", "src/migrate.ts"], {
      cwd: serverDir,
      env: serverEnv,
      stdio: "ignore",
    });
    m.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`migrate exited ${code}`))));
  });

  start("npm", ["run", "start"], { cwd: serverDir, env: serverEnv, log: logPath("server") });
  await waitFor("server health", async () => (await fetch(`${SERVER}/health`).catch(() => null))?.ok);

  const owner = await signUp("Owner", `aw.owner.${Date.now()}@test.local`, "password-123");
  const viewer = await signUp("Viewer", `aw.viewer.${Date.now()}@test.local`, "password-123");
  const stranger = await signUp("Stranger", `aw.stranger.${Date.now()}@test.local`, "password-123");

  const id = `asset-web-${Date.now()}`;
  await putDoc(owner.token, id, "asset-web.md", "# Asset web check\n\n![](shot.png)\n", 0);

  const shared = await fetch(`${SERVER}/api/docs/${id}/shares`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${owner.token}`,
      ...ORIGIN,
    },
    body: JSON.stringify({ email: viewer.email, role: "viewer" }),
  });
  if (!shared.ok) throw new Error(`share: ${shared.status} ${await shared.text()}`);

  // Upload, then link: the same two-step handshake asset-sync.js does from
  // inside the app, by hand, with the server's own upload route.
  const uploaded = await fetch(`${SERVER}/api/assets/${PNG_HASH}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${owner.token}`,
      "Content-Type": "image/png",
      "Content-Length": String(PNG_BYTES.length),
      ...ORIGIN,
    },
    body: PNG_BYTES,
  });
  if (!uploaded.ok) throw new Error(`upload asset: ${uploaded.status} ${await uploaded.text()}`);

  const linked = await fetch(`${SERVER}/api/docs/${id}/assets`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}`, ...ORIGIN },
    body: JSON.stringify({ refs: [{ ref: "shot.png", hash: PNG_HASH }] }),
  });
  if (!linked.ok) throw new Error(`link asset: ${linked.status} ${await linked.text()}`);

  const publicLink = await fetch(`${SERVER}/api/docs/${id}/public-link`, {
    method: "POST",
    headers: { Authorization: `Bearer ${owner.token}`, ...ORIGIN },
  });
  if (!publicLink.ok) throw new Error(`public-link: ${publicLink.status} ${await publicLink.text()}`);
  const { url } = await publicLink.json();
  const token = String(url).split("/s/")[1];
  if (!token) throw new Error(`public-link returned no token in url: ${url}`);

  check("owner reads it over the bearer route", (await get(`/api/docs/${id}/assets/file?ref=shot.png`, owner)).status === 200);
  check("a stranger gets 404", (await get(`/api/docs/${id}/assets/file?ref=shot.png`, stranger)).status === 404);
  check("the web page rewrites the src", /\/d\/[^"]+\/assets\?ref=shot\.png/.test(await (await fetch(`${SERVER}/d/${id}`, { headers: cookieFor(viewer) })).text()));
  // And the route that rewritten src actually points at. It is a different
  // gate from the bearer route above: /d/:id/assets goes through the same
  // resolveViewer the page itself does, so asserting only that the page
  // rewrote the src left the reader's side of it unproven. The pending-invite
  // "?k=" form of the same route is covered by server/src/asset-read.test.ts.
  check(
    "a member reads the picture off the page's own asset route",
    (await fetch(`${SERVER}/d/${id}/assets?ref=shot.png`, { headers: cookieFor(viewer) })).status === 200
  );
  check(
    "a stranger gets 404 from the page's asset route",
    (await fetch(`${SERVER}/d/${id}/assets?ref=shot.png`, { headers: cookieFor(stranger) })).status === 404
  );
  check("the public page serves it by token", (await fetch(`${SERVER}/s/${token}/assets?ref=shot.png`)).status === 200);

  const revoked = await fetch(`${SERVER}/api/docs/${id}/public-link`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${owner.token}`, ...ORIGIN },
  });
  if (!revoked.ok) throw new Error(`revoke: ${revoked.status} ${await revoked.text()}`);
  check("revoking the link revokes the picture", (await fetch(`${SERVER}/s/${token}/assets?ref=shot.png`)).status === 404);
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  process.stderr.write(`\nrun failed: ${error.message}\n`);
} finally {
  await stopChildren();
  for (const p of tempPaths) await rm(p, { recursive: true, force: true });
}

const bad = checks.filter((c) => !c.passed);
process.stdout.write(`\n${checks.length - bad.length}/${checks.length} checks passed\n`);
if (bad.length || failed || !checks.length) {
  process.stdout.write(`logs: ${artifactDir}\n`);
  process.exit(1);
}
if (existsSync(artifactDir)) await rm(artifactDir, { recursive: true, force: true });
