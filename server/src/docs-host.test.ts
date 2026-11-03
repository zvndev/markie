// Hosted documents on their own host (MARKIE_DOCS_ORIGIN). Links the server
// hands out are built on it when it is set and are unchanged when it is not,
// and a link already sent on an old host is redirected there, by config only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

const DOCS = "https://private.markiedocs.test";
const dir = mkdtempSync(join(tmpdir(), "markie-docs-host-"));
process.env.DB_PATH = join(dir, "t.db");
process.env.ASSETS_DIR = join(dir, "store");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-docs-host-test-secret-32-plus-chars";
process.env.MARKIE_SITE_URL = "https://markie.test";
process.env.MARKIE_DOCS_ORIGIN = `${DOCS}/`;

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();

const { docs } = await import("./docs.ts");
const { shares } = await import("./shares.ts");
const { docView } = await import("./doc-view.ts");
const { publicShare } = await import("./public.ts");
const { docsHostRedirect } = await import("./docs-host.ts");
const { resolveDeployment, docsOrigin, deployment } = await import("./deployment.ts");
const { privateLinkFor, privateLinkOrigin } = await import("./doc-meta.ts");

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/docs", docs);
app.route("/api/docs", shares);
app.route("/", docView);
app.route("/", publicShare);

const stamp = Date.now();
const req = (path: string, host: string, extra: Record<string, string> = {}, method = "GET") =>
  new Request(`http://${host}${path}`, { method, headers: { host, ...extra } });

test("MARKIE_DOCS_ORIGIN is read as an origin, and is null when unset", () => {
  assert.equal(deployment().docsOrigin, DOCS, "trailing slash and path dropped");
  assert.equal(docsOrigin(), DOCS);
  assert.equal(resolveDeployment({ BETTER_AUTH_URL: "https://api.example" }).docsOrigin, null);
  assert.equal(docsOrigin({ docsOrigin: null, origin: "https://api.example" }), "https://api.example");
  assert.throws(() => resolveDeployment({ MARKIE_DOCS_ORIGIN: "not a url" }), /MARKIE_DOCS_ORIGIN/);
  assert.throws(() => resolveDeployment({ MARKIE_DOCS_ORIGIN: "javascript:alert(1)" }), /MARKIE_DOCS_ORIGIN/);
});

test("private links are built on the docs host when it is set, and unchanged when not", () => {
  assert.equal(privateLinkFor("abc"), `${DOCS}/d/abc`);
  assert.equal(
    privateLinkOrigin({ official: true, origin: "https://api.markiedocs.com", docsOrigin: DOCS }),
    DOCS
  );
  // Unset: exactly the old rule.
  assert.equal(privateLinkOrigin({ official: true, origin: "https://api.markiedocs.com", docsOrigin: null }), "https://api.markiedocs.com");
  assert.equal(privateLinkOrigin({ official: false, origin: "https://docs.example.org" }), "https://docs.example.org");
});

// Markie Cloud as Kirby set it up: documents on markiedocs.com (Vercel
// rewrites /d and /s to the API host), the API on api.markiedocs.com and its
// Railway name.
const PROD = {
  docsOrigin: "https://markiedocs.com",
  apiOrigins: ["https://api.markiedocs.com", "https://api-production-602f.up.railway.app"],
};
const PATHS = ["/d/abc", "/d/abc?k=tok", "/d/abc/raw?k=tok", "/d/abc/assets?ref=a.png&v=1", "/s/tok", "/s/tok/raw", "/d/abc?view=1"];

test("a document link opened directly on an API host goes to the same path and query on the docs origin", () => {
  for (const host of ["api.markiedocs.com", "api-production-602f.up.railway.app"]) {
    for (const path of PATHS) {
      assert.equal(docsHostRedirect(req(path, host), PROD), `https://markiedocs.com${path}`, `${host}${path}`);
    }
  }
  // kamal-proxy names the API host in X-Forwarded-Host on a direct request.
  assert.equal(
    docsHostRedirect(req("/d/abc", "api.markiedocs.com", { "x-forwarded-host": "api.markiedocs.com" }), PROD),
    "https://markiedocs.com/d/abc"
  );
  assert.equal(docsHostRedirect(req("/d/abc", "api.markiedocs.com", {}, "HEAD"), PROD), "https://markiedocs.com/d/abc");
});

test("a request through the website's proxy is served, never sent round again", () => {
  for (const path of PATHS) {
    // Vercel reaches the API host and names the browser's host in X-Forwarded-Host.
    assert.equal(docsHostRedirect(req(path, "api.markiedocs.com", { "x-forwarded-host": "markiedocs.com" }), PROD), null, path);
    // Even if it ever stopped sending that, its own request id marks it.
    assert.equal(docsHostRedirect(req(path, "api.markiedocs.com", { "x-vercel-id": "iad1::abc" }), PROD), null, path);
  }
});

test("only a positive API-host match redirects: other hosts, the API, writes and an unset origin are served", () => {
  for (const host of ["markiedocs.com", "www.markiedocs.com", "evil.test", "localhost:8787"]) {
    assert.equal(docsHostRedirect(req("/d/abc", host), PROD), null, host);
  }
  assert.equal(docsHostRedirect(req("/d/abc", "api.markiedocs.com", { "x-forwarded-host": "evil.test" }), PROD), null);
  for (const path of ["/api/docs/abc", "/mcp", "/download", "/auth/web-signin", "/app/d/abc", "/d/abc/raw/extra", "/"]) {
    assert.equal(docsHostRedirect(req(path, "api.markiedocs.com"), PROD), null, path);
  }
  assert.equal(docsHostRedirect(req("/d/abc", "api.markiedocs.com", {}, "POST"), PROD), null);
  assert.equal(docsHostRedirect(req("/d/abc", "api.markiedocs.com"), { ...PROD, docsOrigin: null }), null);
  // A docs origin that is the API host itself never redirects to itself.
  assert.equal(docsHostRedirect(req("/d/abc", "api.markiedocs.com"), { ...PROD, docsOrigin: "https://api.markiedocs.com" }), null);
});

test("the target comes from config, never from the request's host", () => {
  const to = docsHostRedirect(req("//evil.test/d/abc", "api.markiedocs.com"), PROD);
  assert.ok(to === null || to.startsWith("https://markiedocs.com/"), String(to));
});

test("the routes redirect a direct API-host request before deciding anything, and keep it private", async () => {
  // This suite's API host is BETTER_AUTH_URL's, localhost:8787.
  const res = await app.request(req("/d/whatever?k=secret", "localhost:8787"));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `${DOCS}/d/whatever?k=secret`);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  const pub = await app.request(req("/s/sometoken/raw", "localhost:8787"));
  assert.equal(pub.status, 302);
  assert.equal(pub.headers.get("location"), `${DOCS}/s/sometoken/raw`);
  // Through the proxy, the page answers as itself: a stranger gets the access page.
  const proxied = await app.request(req("/d/whatever", "localhost:8787", { "x-forwarded-host": "private.markiedocs.test" }));
  assert.equal(proxied.status, 403);
  // Its sign-in link is on the docs origin, where the session cookie must land.
  assert.match(await proxied.text(), /href="https:\/\/private\.markiedocs\.test\/auth\/web-signin\?next=%2Fd%2Fwhatever"/);
});

test("invite emails and public links name the docs host", async () => {
  const H = (token: string) => ({
    "Content-Type": "application/json",
    Origin: "http://localhost:3000",
    "x-forwarded-for": "127.0.0.1",
    Authorization: `Bearer ${token}`,
    host: "private.markiedocs.test",
  });
  const owner = await signUpVerified(app, { name: "Owner", email: `dh.owner.${stamp}@test.local` });
  const bob = await signUpVerified(app, { name: "Bob", email: `dh.bob.${stamp}@test.local` });
  const docId = `dh-${stamp}`;
  const content = "# Docs host\n";
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  const put = await app.request(`http://private.markiedocs.test/api/docs/${docId}`, {
    method: "PUT",
    headers: H(owner.token),
    body: JSON.stringify({ name: "dh.md", content, hash, baseVersion: 0 }),
  });
  assert.equal(put.status, 200);

  // The email goes to the console outside production; read it there.
  const logged: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    const shared = await app.request(`http://private.markiedocs.test/api/docs/${docId}/shares`, {
      method: "POST",
      headers: H(owner.token),
      body: JSON.stringify({ email: bob.email, role: "viewer" }),
    });
    assert.equal(shared.status, 200);
  } finally {
    console.log = original;
  }
  const mail = logged.join("\n");
  assert.match(mail, new RegExp(`${DOCS.replace(/\./g, "\\.")}/d/${docId}\\?k=`));
  assert.doesNotMatch(mail, /https:\/\/markie\.test\/d\//);

  const made = await app.request(`http://private.markiedocs.test/api/docs/${docId}/public-link`, {
    method: "POST",
    headers: H(owner.token),
  });
  const { url } = (await made.json()) as { url: string };
  assert.match(url, new RegExp(`^${DOCS.replace(/\./g, "\\.")}/s/[0-9a-f]{64}$`));
});
