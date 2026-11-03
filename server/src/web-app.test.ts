// The web app's routes (web-app.ts): served only when the build is present,
// only to a signed-in browser, with a policy that names exactly what the app
// runs, and with the sign-in bringing a visitor back to the page they asked for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createWebApp, isWebAppPath, webAppAvailable, webAppCsp, webAppReturnPath } from "./web-app.ts";

const HASH = "sha256-Kfrvxr0ZnoWoSVm3flacWBbqBafJPnMU0A7TB0PB8N4=";

function build(): string {
  const dir = mkdtempSync(join(tmpdir(), "markie-web-dist-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "app.html"), '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/app/assets/app-abc.js"></script>');
  writeFileSync(join(dir, "assets", "app-abc.js"), "console.log('app')");
  writeFileSync(join(dir, "web-app.json"), JSON.stringify({ scriptHashes: [HASH, "sha256-bad'; script-src *"] }));
  return dir;
}

function server(dir: string, signedIn: boolean) {
  const app = new Hono();
  app.route("/", createWebApp({ dir, collabOrigin: "https://api.example.test", sessionUser: async () => (signedIn ? { id: "u1" } : null) }));
  return app;
}

test("without a build every /app page is a plain 404 and the app reports itself absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "markie-web-empty-"));
  assert.equal(webAppAvailable(dir), false);
  for (const path of ["/app", "/app/new", "/app/d/doc-1", "/app/assets/app-abc.js"]) {
    const res = await server(dir, true).request(path);
    assert.equal(res.status, 404, path);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await res.text(), /not on this server/);
  }
});

test("with a build, a signed-in browser gets the app shell on every app route", async () => {
  const dir = build();
  assert.equal(webAppAvailable(dir), true);
  for (const path of ["/app", "/app/", "/app/new", "/app/d/doc-1", "/app/anything/else"]) {
    const res = await server(dir, true).request(path);
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /<div id="root">/);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
  }
});

test("a signed-out visitor goes to the web sign-in and comes back to the same page", async () => {
  const app = server(build(), false);
  const cases: Array<[string, string]> = [
    ["/app", "/app"],
    ["/app/new", "/app/new"],
    ["/app/d/doc-1", "/app/d/doc-1"],
    ["/app/d/a%20b", "/app"],
    ["/app/elsewhere", "/app"],
  ];
  for (const [path, next] of cases) {
    const res = await app.request(path);
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get("location"), `/auth/web-signin?next=${encodeURIComponent(next)}`, path);
  }
});

test("assets are served from the build only, by exact built name", async () => {
  const app = server(build(), false);
  const ok = await app.request("/app/assets/app-abc.js");
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type") ?? "", /text\/javascript/);
  assert.match(ok.headers.get("cache-control") ?? "", /immutable/);
  for (const path of ["/app/assets/missing.js", "/app/assets/..%2fapp.html", "/app/assets/.hidden", "/app/assets/a\\..\\app.html"]) {
    const res = await app.request(path);
    assert.equal(res.status, 404, path);
  }
  // A dot-dot path is normalised before routing, so it lands on the page
  // route (which wants a session) and never on a file outside assets/.
  for (const path of ["/app/assets/../app.html", "/app/assets/%2e%2e/app.html"]) {
    const res = await app.request(path);
    assert.notEqual(res.status, 200, path);
  }
});

test("the page policy runs only this origin's scripts and the hashes the build named", async () => {
  const res = await server(build(), true).request("/app");
  const csp = res.headers.get("content-security-policy") ?? "";
  assert.match(csp, new RegExp(`script-src 'self' '${HASH.replace(/[+/=]/g, "\\$&")}'(;|$)`));
  assert.ok(!csp.includes("sha256-bad"), "a malformed hash never reaches the header");
  assert.ok(!csp.includes("unsafe-eval"));
  assert.match(csp, /connect-src 'self' wss:\/\/api\.example\.test/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(webAppCsp([], "http://localhost:8787").includes("connect-src 'self' ws://localhost:8787"), true);
});

test("the page names the server's own socket, since a proxying website cannot carry one", async () => {
  const res = await server(build(), true).request("https://docs.example.test/app");
  const html = await res.text();
  assert.match(html, /<meta name="markie-collab" content="wss:\/\/api\.example\.test\/collab" \/>/);
  // Nothing about the session is ever put in the page.
  assert.ok(!/token/i.test(html.replace(/markie-collab/g, "")));
});

test("only /app paths are the web app's", () => {
  assert.equal(isWebAppPath("/app"), true);
  assert.equal(isWebAppPath("/app/d/x"), true);
  assert.equal(isWebAppPath("/apples"), false);
  assert.equal(isWebAppPath("/d/x"), false);
  assert.equal(webAppReturnPath("/app/d/x/y"), "/app");
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

test("with a separate docs host, /app and its sign-in are sent there and nowhere else", async () => {
  const { docsHostRedirect } = await import("./web-app.ts");
  const split = { origin: "https://api.example.test", docsOrigin: "https://docs.example.test" };
  const get = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });
  assert.equal(docsHostRedirect(get("https://api.example.test/app/d/doc-1?x=1"), split), "https://docs.example.test/app/d/doc-1?x=1");
  assert.equal(docsHostRedirect(get("https://api.example.test/auth/web-signin?next=%2Fapp%2Fnew"), split), "https://docs.example.test/auth/web-signin?next=%2Fapp%2Fnew");
  // Already on the docs host, by Host or by the proxy's forwarded host.
  assert.equal(docsHostRedirect(get("https://docs.example.test/app"), split), null);
  assert.equal(docsHostRedirect(get("http://10.0.0.5:8787/app", { "x-forwarded-host": "docs.example.test" }), split), null);
  // The target comes from configuration, never from the request's host.
  assert.equal(docsHostRedirect(get("https://evil.test/app", { host: "evil.test" }), split), "https://docs.example.test/app");
  // Not the web app's: the API, /d/ pages and sign-in for a /d/ page stay put.
  for (const url of ["https://api.example.test/api/docs", "https://api.example.test/d/doc-1", "https://api.example.test/auth/web-signin?next=%2Fd%2Fx", "https://api.example.test/apples"]) {
    assert.equal(docsHostRedirect(get(url), split), null, url);
  }
  assert.equal(docsHostRedirect(new Request("https://api.example.test/app", { method: "POST" }), split), null);
  // One host (self-hosted, local, or no MARKIE_DOCS_ORIGIN): never redirected.
  assert.equal(docsHostRedirect(get("https://other.test/app"), { origin: "https://api.example.test", docsOrigin: "https://api.example.test" }), null);
});

test("MARKIE_DOCS_ORIGIN is an exact https origin, defaults to the server's own, and is trusted exactly", async () => {
  const { resolveDeployment, docsOriginFrom } = await import("./deployment.ts");
  const { applicationOrigins } = await import("./application-origins.ts");
  assert.equal(resolveDeployment({ MARKIE_OFFICIAL: "0", BETTER_AUTH_URL: "https://m.example" }).docsOrigin, "https://m.example");
  assert.equal(resolveDeployment({ MARKIE_OFFICIAL: "0", BETTER_AUTH_URL: "https://m.example", MARKIE_DOCS_ORIGIN: "https://docs.m.example/" }).docsOrigin, "https://docs.m.example");
  assert.equal(docsOriginFrom(undefined), null);
  assert.equal(docsOriginFrom("http://localhost:8799"), "http://localhost:8799");
  for (const bad of ["http://docs.example", "https://docs.example/app", "https://u:p@docs.example", "https://docs.example/?x", "not a url"]) {
    assert.throws(() => docsOriginFrom(bad), /MARKIE_DOCS_ORIGIN/, bad);
  }
  const origins = applicationOrigins({ MARKIE_OFFICIAL: "0", BETTER_AUTH_URL: "https://api.example.test", MARKIE_DOCS_ORIGIN: "https://docs.example.test" });
  assert.ok(origins.includes("https://docs.example.test"));
  assert.ok(!origins.some((origin) => origin.includes("*") || origin === "https://example.test"));
});

test("on a separate docs host the web sign-in offers the emailed code only", async () => {
  const { createWebSignIn } = await import("./web-signin.ts");
  const app = new Hono();
  app.route("/", createWebSignIn({ authBase: "https://api.example.test", google: true, emailOnlyHost: "docs.example.test" }));
  const onDocs = await (await app.request("https://docs.example.test/auth/web-signin?next=%2Fapp")).text();
  assert.ok(!onDocs.includes("Continue with Google"));
  const onApi = await (await app.request("https://api.example.test/auth/web-signin?next=%2Fd%2Fx")).text();
  assert.ok(onApi.includes("Continue with Google"));
  const google = await app.request("https://docs.example.test/auth/web-google?next=%2Fapp");
  assert.equal(google.status, 302);
  assert.equal(google.headers.get("location"), "/auth/web-signin?next=%2Fapp");
});
