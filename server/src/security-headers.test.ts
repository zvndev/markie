import { test } from "node:test";
import assert from "node:assert/strict";

// The origin is publicly reachable, not only the CDN in front of it. These
// assert what the application itself sends, because a header that exists only
// on Vercel is not a header Markie has.
process.env.MARKIE_NO_LISTEN = "1";
// A database of its own, migrated, so the document pages answer as pages.
{
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "markie-security-headers-"));
  process.env.DB_PATH = join(dir, "t.db");
  process.env.ASSETS_DIR = join(dir, "store");
  const { auth } = await import("./auth.ts");
  const { getMigrations } = await import("better-auth/db/migration");
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
  if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();
}
const { app } = await import("./index.ts");

const get = (path: string) => app.request(path);

test("every response carries the baseline hardening headers", async () => {
  for (const path of ["/health", "/api/me", "/download/latest.json"]) {
    const res = await get(path);
    const h = res.headers;
    assert.equal(h.get("x-content-type-options"), "nosniff", `${path} nosniff`);
    assert.equal(h.get("x-frame-options"), "DENY", `${path} frame options`);
    assert.equal(
      h.get("referrer-policy"),
      "strict-origin-when-cross-origin",
      `${path} referrer policy`
    );
    assert.match(h.get("strict-transport-security") ?? "", /max-age=\d+/, `${path} hsts`);
  }
});

test("html responses carry a content security policy", async () => {
  const res = await get("/download");
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const csp = res.headers.get("content-security-policy") ?? "";
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
});

test("the policy still allows what a shared document legitimately contains", async () => {
  // A document with a remote image must render. A policy that blanks images is
  // a policy somebody switches off, which is worse than a permissive img-src.
  const csp = (await get("/download")).headers.get("content-security-policy") ?? "";
  assert.match(csp, /img-src [^;]*https:/);
  assert.match(csp, /style-src [^;]*'unsafe-inline'/);
});

test("the policy lets a document page load its code and math styles, and nothing more", async () => {
  // render.ts loads highlight.js and KaTeX stylesheets and fonts from this
  // one CDN. Blocked, code loses its colours and every equation is drawn
  // twice; a script from it stays blocked.
  const csp = (await get("/download")).headers.get("content-security-policy") ?? "";
  assert.match(csp, /style-src [^;]*https:\/\/cdn\.jsdelivr\.net/);
  assert.match(csp, /font-src [^;]*https:\/\/cdn\.jsdelivr\.net/);
  assert.doesNotMatch(/script-src ([^;]*)/.exec(csp)?.[1] ?? "", /jsdelivr|https:/);
});

test("a document page served as the web app's read view keeps the app's strict policy", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const scriptSrc = (csp: string) => /script-src ([^;]*)/.exec(csp)?.[1] ?? "";

  // Without the build, the static page and this server's own policy.
  const plain = (await get("/d/some-doc")).headers.get("content-security-policy") ?? "";
  assert.match(scriptSrc(plain), /'unsafe-inline'/);

  const dist = mkdtempSync(join(tmpdir(), "markie-csp-web-"));
  writeFileSync(join(dist, "app.html"), '<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  const before = process.env.MARKIE_WEB_DIST;
  process.env.MARKIE_WEB_DIST = dist;
  try {
    // /app's own policy is web-app.test.ts's; its build directory is fixed
    // when the server starts, this route's is read per request.
    for (const path of ["/d/some-doc", "/d/another-doc"]) {
      const res = await get(path);
      assert.match(await res.text(), /<div id="root">/, path);
      const csp = res.headers.get("content-security-policy") ?? "";
      assert.equal(scriptSrc(csp).trim(), "'self'", `${path}: no inline script, no remote script`);
      assert.match(csp, /frame-ancestors 'none'/, path);
      assert.match(csp, /object-src 'none'/, path);
      assert.match(csp, /base-uri 'none'/, path);
      // Frames only for the Darkmown sandbox (srcdoc, about:) and the two
      // video players a document may embed.
      assert.equal(/frame-src ([^;]*)/.exec(csp)?.[1], "about: https://www.youtube-nocookie.com https://player.vimeo.com", path);
    }
    // Every other page keeps this server's policy, build or no build.
    const other = (await get("/download")).headers.get("content-security-policy") ?? "";
    assert.match(other, /base-uri 'self'/);
  } finally {
    if (before === undefined) delete process.env.MARKIE_WEB_DIST;
    else process.env.MARKIE_WEB_DIST = before;
  }
});

test("the page that hands out a session token is never cached", async () => {
  // It carries a live credential in the markup and in the link. Cacheable is
  // the wrong default for that, whether the session resolves or not.
  const res = await get("/auth/desktop-bridge");
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
});

test("the route naming the signed-in user is never cached", async () => {
  const res = await get("/api/me");
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
});

test("an unknown api route answers json without a stack", async () => {
  const res = await get("/api/definitely-not-a-route");
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.deepEqual(body, { error: "not found" });
});
