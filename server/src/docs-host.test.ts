// Hosted documents on their own host (MARKIE_DOCS_ORIGIN). Links the server
// hands out are built on it when it is set and are unchanged when it is not,
// and a link already sent on an old host is redirected there, by config only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
  // It becomes a credentialed CORS origin, so production takes https only.
  const prod = { NODE_ENV: "production", MARKIE_OFFICIAL: "0", BETTER_AUTH_URL: "https://api.example" };
  for (const bad of ["http://localhost:8799", "http://docs.example", "https://docs.example/path", "https://u:p@docs.example"]) {
    assert.throws(() => resolveDeployment({ ...prod, MARKIE_DOCS_ORIGIN: bad }), /MARKIE_DOCS_ORIGIN/, bad);
  }
  assert.equal(resolveDeployment({ ...prod, MARKIE_DOCS_ORIGIN: "https://docs.example" }).docsOrigin, "https://docs.example");
  // Plain http on a loopback name is for development only.
  assert.equal(resolveDeployment({ BETTER_AUTH_URL: "http://localhost:8787", MARKIE_DOCS_ORIGIN: "http://localhost:8799" }).docsOrigin, "http://localhost:8799");
  assert.throws(() => resolveDeployment({ BETTER_AUTH_URL: "http://localhost:8787", MARKIE_DOCS_ORIGIN: "http://docs.example" }), /MARKIE_DOCS_ORIGIN/);
  // The reserved .test and .localhost names count as development names, in development only.
  assert.equal(resolveDeployment({ BETTER_AUTH_URL: "http://localhost:8787", MARKIE_DOCS_ORIGIN: "http://markie.localhost:8798" }).docsOrigin, "http://markie.localhost:8798");
  assert.throws(() => resolveDeployment({ ...prod, MARKIE_DOCS_ORIGIN: "http://markie.test" }), /MARKIE_DOCS_ORIGIN/);
});

test("the docs host is trusted for signed-in requests, exactly and only when set", async () => {
  const { applicationOrigins } = await import("./application-origins.ts");
  const base = { MARKIE_OFFICIAL: "0", BETTER_AUTH_URL: "https://api.example", NODE_ENV: "production" };
  assert.ok(applicationOrigins({ ...base, MARKIE_DOCS_ORIGIN: "https://docs.example" }).includes("https://docs.example"));
  assert.ok(!applicationOrigins(base).includes("https://docs.example"));
  assert.ok(!applicationOrigins({ ...base, MARKIE_DOCS_ORIGIN: "https://docs.example" }).includes("https://example"), "never a parent domain");
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
// A browser opening a page sends Sec-Fetch-Mode: navigate; the phone app's
// and the desktop's own fetches send no such header.
const NAV = { "sec-fetch-mode": "navigate" };

test("a public page opened in a browser on an API host goes to the same path and query on the docs origin", () => {
  for (const host of ["api.markiedocs.com", "api-production-602f.up.railway.app"]) {
    for (const path of ["/s/tok", "/s/tok?x=1", "/s/tok/"]) {
      assert.equal(docsHostRedirect(req(path, host, NAV), PROD), `https://markiedocs.com${path}`, `${host}${path}`);
    }
  }
  // Accept: text/html counts as a page load for a browser without Sec-Fetch-Mode.
  assert.equal(docsHostRedirect(req("/s/tok", "api.markiedocs.com", { accept: "text/html,*/*" }), PROD), "https://markiedocs.com/s/tok");
  // kamal-proxy names the API host in X-Forwarded-Host on a direct request.
  assert.equal(
    docsHostRedirect(req("/s/tok", "api.markiedocs.com", { ...NAV, "x-forwarded-host": "api.markiedocs.com" }), PROD),
    "https://markiedocs.com/s/tok"
  );
  assert.equal(docsHostRedirect(req("/s/tok", "api.markiedocs.com", NAV, "HEAD"), PROD), "https://markiedocs.com/s/tok");
});

test("code fetching a public document is never redirected, so the phone app and desktop keep working", () => {
  // apps/mobile refuses redirects (native-http.ts disableRedirects, http.ts
  // redirect: "error"), and so does the desktop's anonymous open.
  for (const path of ["/s/tok/raw", "/s/tok/assets?ref=a.png&v=1"]) {
    for (const headers of [{}, NAV, { "sec-fetch-mode": "cors" }, { accept: "*/*" }]) {
      assert.equal(docsHostRedirect(req(path, "api.markiedocs.com", headers), PROD), null, `${path} ${JSON.stringify(headers)}`);
    }
  }
  // The page itself, fetched by code rather than opened, is served too.
  assert.equal(docsHostRedirect(req("/s/tok", "api.markiedocs.com", { "sec-fetch-mode": "cors" }), PROD), null);
  assert.equal(docsHostRedirect(req("/s/tok", "api.markiedocs.com"), PROD), null);
});

test("/d/ is never redirected here: its sign-in and session are on the API host", () => {
  for (const path of ["/d/abc", "/d/abc?k=tok", "/d/abc/raw?k=tok", "/d/abc/assets?ref=a.png", "/d/abc?view=1"]) {
    assert.equal(docsHostRedirect(req(path, "api.markiedocs.com", NAV), PROD), null, path);
  }
});

test("a request through the website's proxy is served, never sent round again", () => {
  // Vercel reaches the API host and names the browser's host in X-Forwarded-Host.
  assert.equal(docsHostRedirect(req("/s/tok", "api.markiedocs.com", { ...NAV, "x-forwarded-host": "markiedocs.com" }), PROD), null);
  // Even if it ever stopped sending that, its own request id marks it.
  assert.equal(docsHostRedirect(req("/s/tok", "api.markiedocs.com", { ...NAV, "x-vercel-id": "iad1::abc" }), PROD), null);
});

test("only a positive API-host match redirects: other hosts, the API, writes and an unset origin are served", () => {
  for (const host of ["markiedocs.com", "www.markiedocs.com", "evil.test", "localhost:8787"]) {
    assert.equal(docsHostRedirect(req("/s/tok", host, NAV), PROD), null, host);
  }
  assert.equal(docsHostRedirect(req("/s/tok", "api.markiedocs.com", { ...NAV, "x-forwarded-host": "evil.test" }), PROD), null);
  for (const path of ["/api/docs/abc", "/mcp", "/download", "/auth/web-signin", "/app/d/abc", "/s/tok/raw/extra", "/"]) {
    assert.equal(docsHostRedirect(req(path, "api.markiedocs.com", NAV), PROD), null, path);
  }
  assert.equal(docsHostRedirect(req("/s/tok", "api.markiedocs.com", NAV, "POST"), PROD), null);
  assert.equal(docsHostRedirect(req("/s/tok", "api.markiedocs.com", NAV), { ...PROD, docsOrigin: null }), null);
  // A docs origin that is the API host itself never redirects to itself.
  assert.equal(docsHostRedirect(req("/s/tok", "api.markiedocs.com", NAV), { ...PROD, docsOrigin: "https://api.markiedocs.com" }), null);
});

test("the target comes from config, never from the request's host", () => {
  const to = docsHostRedirect(req("//evil.test/s/tok", "api.markiedocs.com", NAV), PROD);
  assert.ok(to === null || to.startsWith("https://markiedocs.com/"), String(to));
});

test("the routes: a public page moves to the docs host, its raw text does not, and /d/ signs in here", async () => {
  // This suite's API host is BETTER_AUTH_URL's, localhost:8787.
  const pub = await app.request(req("/s/sometoken", "localhost:8787", NAV));
  assert.equal(pub.status, 302);
  assert.equal(pub.headers.get("location"), `${DOCS}/s/sometoken`);
  assert.equal(pub.headers.get("cache-control"), "private, no-store");
  assert.equal(pub.headers.get("referrer-policy"), "no-referrer");
  const raw = await app.request(req("/s/sometoken/raw", "localhost:8787"));
  assert.equal(raw.status, 404, "answered here, not redirected");
  // /d/ answers as itself on either host. A stranger with no web app here
  // gets the access page, whose sign-in is on this server's own origin, where
  // the session cookie lands.
  for (const extra of [NAV, { ...NAV, "x-forwarded-host": "private.markiedocs.test" }]) {
    const res = await app.request(req("/d/whatever", "localhost:8787", extra));
    assert.equal(res.status, 403);
    assert.match(await res.text(), /href="http:\/\/localhost:8787\/auth\/web-signin\?next=%2Fd%2Fwhatever"/);
  }
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

test("with the web app, /d/ answers with the read view on the docs host, after the API host decides who is asking", async () => {
  const webDist = join(dir, "web-dist");
  mkdirSync(webDist, { recursive: true });
  writeFileSync(join(webDist, "app.html"), '<!doctype html><html><head><title>Markie</title></head><body><div id="root"></div></body></html>');
  const before = process.env.MARKIE_WEB_DIST;
  process.env.MARKIE_WEB_DIST = webDist;
  try {
    const owner = await signUpVerified(app, { name: "Owner", email: `dh.view.${stamp}@test.local` });
    const docId = `dh-view-${stamp}`;
    const content = "# Read view\n";
    const hash = createHash("sha256").update(content, "utf8").digest("hex");
    const put = await app.request(`http://localhost:8787/api/docs/${docId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", "x-forwarded-for": "127.0.0.1", Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ name: "view.md", content, hash, baseVersion: 0 }),
    });
    assert.equal(put.status, 200);
    const signedIn = { ...NAV, authorization: `Bearer ${owner.token}` };

    // Back from the sign-in on the API host: on to the same view on the docs
    // host, with the ?k= dropped.
    for (const path of [`/d/${docId}`, `/d/${docId}?k=sometoken`]) {
      const res = await app.request(req(path, "localhost:8787", signedIn));
      assert.equal(res.status, 302, path);
      assert.equal(res.headers.get("location"), `${DOCS}/d/${docId}`);
      assert.equal(res.headers.get("cache-control"), "private, no-store");
    }
    // A browser with no session on the API host goes the same way.
    const anon = await app.request(req(`/d/${docId}`, "localhost:8787", NAV));
    assert.equal(anon.headers.get("location"), `${DOCS}/d/${docId}`);
    // Through the docs host's proxy it is the view itself, never sent round.
    for (const extra of [{ "x-forwarded-host": "private.markiedocs.test" }, { "x-vercel-id": "iad1::x" }]) {
      const res = await app.request(req(`/d/${docId}`, "localhost:8787", { ...NAV, ...extra }));
      assert.equal(res.status, 200);
      assert.match(await res.text(), /<div id="root">/);
    }
    // ?view=1 on the API host keeps the static page for a signed-in reader.
    const quick = await app.request(req(`/d/${docId}?view=1`, "localhost:8787", signedIn));
    assert.equal(quick.status, 200);
    assert.match(await quick.text(), /Read view/);
    // The refusals stay server pages: another account here gets its 403.
    const other = await signUpVerified(app, { name: "Other", email: `dh.other.${stamp}@test.local` });
    const wrong = await app.request(req(`/d/${docId}`, "localhost:8787", { ...NAV, authorization: `Bearer ${other.token}` }));
    assert.equal(wrong.status, 403);
    assert.equal(wrong.headers.get("location"), null);
  } finally {
    if (before === undefined) delete process.env.MARKIE_WEB_DIST;
    else process.env.MARKIE_WEB_DIST = before;
  }
});
