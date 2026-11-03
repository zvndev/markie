// The web app's routes (web-app.ts): served only when the build is present,
// to anyone (the shell holds nothing about an account), naming the API origin
// the app calls directly, with a policy that names exactly what the app runs.
// Sign-in stays on the API origin, and /app on an API name moves to the docs
// host (docs-host.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createWebApp, isReadViewPath, isWebAppPath, webAppAvailable, webAppCsp, withDocMeta, withServerMeta } from "./web-app.ts";
import { docsHostRedirect } from "./docs-host.ts";

const HASH = "sha256-Kfrvxr0ZnoWoSVm3flacWBbqBafJPnMU0A7TB0PB8N4=";
const API = "https://api.example.test";

function build(): string {
  const dir = mkdtempSync(join(tmpdir(), "markie-web-dist-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "app.html"), '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/app/assets/app-abc.js"></script>');
  writeFileSync(join(dir, "assets", "app-abc.js"), "console.log('app')");
  writeFileSync(join(dir, "web-app.json"), JSON.stringify({ scriptHashes: [HASH, "sha256-bad'; script-src *"] }));
  return dir;
}

function server(dir: string) {
  const app = new Hono();
  app.route("/", createWebApp({ dir, apiOrigin: API }));
  return app;
}

test("without a build every /app page is a plain 404 and the app reports itself absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "markie-web-empty-"));
  assert.equal(webAppAvailable(dir), false);
  for (const path of ["/app", "/app/new", "/app/d/doc-1", "/app/assets/app-abc.js"]) {
    const res = await server(dir).request(path);
    assert.equal(res.status, 404, path);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await res.text(), /not on this server/);
  }
});

test("with a build, every app route is the shell, with no session asked for and none cached", async () => {
  const dir = build();
  assert.equal(webAppAvailable(dir), true);
  for (const path of ["/app", "/app/", "/app/new", "/app/d/doc-1", "/app/anything/else"]) {
    // No cookie, no bearer: the shell is the same public bundle for everyone,
    // and the app asks the API for the session itself.
    const res = await server(dir).request(path);
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /<div id="root">/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("location"), null, "never a redirect to sign in, which could loop");
  }
});

test("assets are served from the build only, by exact built name", async () => {
  const app = server(build());
  const ok = await app.request("/app/assets/app-abc.js");
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type") ?? "", /text\/javascript/);
  assert.match(ok.headers.get("cache-control") ?? "", /immutable/);
  for (const path of ["/app/assets/missing.js", "/app/assets/..%2fapp.html", "/app/assets/.hidden", "/app/assets/a\\..\\app.html"]) {
    const res = await app.request(path);
    assert.equal(res.status, 404, path);
  }
  // A dot-dot path is normalised before routing, so it lands on the page
  // route (the shell) and never on a file outside assets/.
  for (const path of ["/app/assets/../app.html", "/app/assets/%2e%2e/app.html"]) {
    const res = await app.request(path);
    const body = await res.text();
    assert.ok(res.status !== 200 || body.includes('<div id="root">'), path);
  }
});

test("the page policy runs only this origin's scripts and the build's hashes, and reaches only the API", async () => {
  const res = await server(build()).request("/app");
  const csp = res.headers.get("content-security-policy") ?? "";
  assert.match(csp, new RegExp(`script-src 'self' '${HASH.replace(/[+/=]/g, "\\$&")}'(;|$)`));
  assert.ok(!csp.includes("sha256-bad"), "a malformed hash never reaches the header");
  assert.ok(!csp.includes("unsafe-eval"));
  assert.match(csp, /connect-src 'self' https:\/\/api\.example\.test wss:\/\/api\.example\.test(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.ok(webAppCsp([], "http://localhost:8787").includes("connect-src 'self' http://localhost:8787 ws://localhost:8787"));
  // An origin that is not http(s) adds nothing.
  assert.ok(webAppCsp([], "javascript:alert(1)").includes("connect-src 'self';"));
});

test("the page names this server's API origin and socket, from config only, and nothing about the session", async () => {
  const res = await server(build()).request("https://docs.example.test/app", { headers: { host: "evil.test" } });
  const html = await res.text();
  assert.match(html, /<meta name="markie-api" content="https:\/\/api\.example\.test" \/>/);
  assert.match(html, /<meta name="markie-collab" content="wss:\/\/api\.example\.test\/collab" \/>/);
  assert.ok(!html.includes("evil.test"));
  assert.ok(!/token/i.test(html));
  // A malformed origin is never written into the page.
  for (const bad of ['https://x" onload="', "javascript:alert(1)", "not an origin"]) {
    assert.equal(withServerMeta("<head></head>", bad), "<head></head>", bad);
  }
});

test("a document's pictures may load from the API origin, and only from there besides https", () => {
  const csp = webAppCsp([], "http://api.markie.localhost:8799");
  assert.match(csp, /img-src 'self' data: blob: https: http:\/\/api\.markie\.localhost:8799(;|$)/);
  assert.match(csp, /media-src 'self' data: blob: https: http:\/\/api\.markie\.localhost:8799(;|$)/);
  assert.match(webAppCsp([], "javascript:alert(1)"), /img-src 'self' data: blob: https:;/);
});

test("a public view's shell names the document's name and format, escaped, and nothing else", () => {
  const shell = "<html><head><title>Markie</title></head><body></body></html>";
  const html = withDocMeta(shell, { title: 'Plan "<b>" & co.md', format: "darkmown" });
  assert.match(html, /<title>Plan &quot;&lt;b&gt;&quot; &amp; co\.md · Markie<\/title>/);
  assert.match(html, /<meta name="markie-doc-name" content="Plan &quot;&lt;b&gt;&quot; &amp; co\.md" \/>/);
  assert.match(html, /<meta name="markie-doc-format" content="darkmown" \/>/);
  assert.match(withDocMeta(shell, { title: "x", format: 'x" onload="1' }), /content="markdown"/, "an odd format is never written");
});

test("read view paths are a document page itself, never its raw text or assets", () => {
  for (const path of ["/d/doc-1", "/d/doc-1/", "/s/tok", "/s/tok/"]) assert.equal(isReadViewPath(path), true, path);
  for (const path of ["/d/doc-1/raw", "/d/doc-1/assets", "/s/tok/raw", "/s/tok/assets", "/d/", "/app/d/x", "/download"]) assert.equal(isReadViewPath(path), false, path);
});

test("only /app paths are the web app's", () => {
  assert.equal(isWebAppPath("/app"), true);
  assert.equal(isWebAppPath("/app/d/x"), true);
  assert.equal(isWebAppPath("/apples"), false);
  assert.equal(isWebAppPath("/d/x"), false);
});

test("with a separate docs host, a browser opening /app on an API name is sent there, and nothing else moves", () => {
  const split = { docsOrigin: "https://docs.example.test", apiOrigins: [API] };
  const nav = (url: string, headers: Record<string, string> = {}) =>
    new Request(url, { headers: { "sec-fetch-mode": "navigate", host: new URL(url).host, ...headers } });
  const toApp = (url: string, headers?: Record<string, string>) => docsHostRedirect(nav(url, headers), split, isWebAppPath);
  assert.equal(toApp(`${API}/app/d/doc-1?x=1`), "https://docs.example.test/app/d/doc-1?x=1");
  assert.equal(toApp(`${API}/app`), "https://docs.example.test/app");
  // Already on the docs host, by Host, by the proxy's forwarded host, or by Vercel's own id.
  assert.equal(toApp("https://docs.example.test/app"), null);
  assert.equal(toApp(`${API}/app`, { "x-forwarded-host": "docs.example.test" }), null);
  assert.equal(toApp(`${API}/app`, { "x-vercel-id": "iad1::abc" }), null);
  // Only a positive API-host match moves; any other host is served.
  assert.equal(toApp("https://evil.test/app"), null);
  // Sign-in stays on the API host, whatever page it returns to.
  for (const url of [`${API}/auth/web-signin?next=%2Fapp%2Fnew`, `${API}/auth/web-google?next=%2Fapp`, `${API}/api/docs`, `${API}/d/doc-1`, `${API}/apples`]) {
    assert.equal(toApp(url), null, url);
  }
  // Assets are fetched, not navigated to, and are served where asked.
  assert.equal(docsHostRedirect(new Request(`${API}/app/assets/app-abc.js`, { headers: { host: "api.example.test" } }), split, isWebAppPath), null);
  assert.equal(docsHostRedirect(new Request(`${API}/app`, { method: "POST", headers: { "sec-fetch-mode": "navigate", host: "api.example.test" } }), split, isWebAppPath), null);
  // One host (self-hosted, local, or no MARKIE_DOCS_ORIGIN): never redirected.
  assert.equal(docsHostRedirect(nav(`${API}/app`), { docsOrigin: null, apiOrigins: [API] }, isWebAppPath), null);
});

test("the web sign-in accepts the web app's pages as where to return, and nothing near them", async () => {
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-web-signin-")), "t.db");
  process.env.BETTER_AUTH_URL ??= "http://localhost:8787";
  process.env.BETTER_AUTH_SECRET ??= "markie-web-app-test-secret-32-plus-chars";
  const { safeNext, renderWebSignInPage } = await import("./web-signin.ts");
  for (const good of ["/app", "/app/", "/app/new", "/app/d/doc-1"]) assert.equal(safeNext(good), good);
  for (const bad of ["/app/new/x", "/app/d/", "/app/d/a b", "/apps", "//evil.test/app", "https://evil.test/app", "/app/d/x/../../admin"]) {
    assert.equal(safeNext(bad), "/", bad);
  }
  assert.ok(renderWebSignInPage({ next: "/app", google: false, failed: false }).includes("Sign in to open your documents."));
  assert.ok(renderWebSignInPage({ next: "/d/x", google: false, failed: false }).includes("Use the account this document belongs to."));
});

test("Google sign-in for the web app returns to the app page on this server's own origin", async () => {
  process.env.BETTER_AUTH_URL ??= "http://localhost:8787";
  process.env.BETTER_AUTH_SECRET ??= "markie-web-app-test-secret-32-plus-chars";
  const { createWebSignIn, renderWebSignInPage } = await import("./web-signin.ts");
  // The page offers Google for the web app: its callback and the session it
  // sets are both on this origin, where the app asks for the session.
  const page = renderWebSignInPage({ next: "/app/d/doc-1", google: true, failed: false });
  assert.ok(page.includes("Continue with Google"));
  assert.ok(page.includes("/auth/web-google?next=%2Fapp%2Fd%2Fdoc-1"));
  // Without Google configured, its route sends the browser back to the code.
  const app = new Hono();
  app.route("/", createWebSignIn({ authBase: API, google: false }));
  const res = await app.request(`${API}/auth/web-google?next=%2Fapp`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/auth/web-signin");
});
