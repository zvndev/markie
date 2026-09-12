// The read side of cloud assets: one asset, served through whichever of the
// three existing gates the request comes through (bearer session, the /d/
// personal-link viewer, or a revocable public token). No fourth path exists.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

const dir = mkdtempSync(join(tmpdir(), "markie-asset-read-"));
process.env.DB_PATH = join(dir, "t.db");
process.env.ASSETS_DIR = join(dir, "store");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-asset-read-test-secret-32-plus-chars";
process.env.MARKIE_SITE_URL = "https://markie.test";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();
const { docs } = await import("./docs.ts");
const { shares } = await import("./shares.ts");
const { assetsApi } = await import("./assets.ts");
const { docView } = await import("./doc-view.ts");
const { publicShare } = await import("./public.ts");

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/docs", docs);
app.route("/api/docs", shares);
app.route("/api", assetsApi);
app.route("/", docView);
app.route("/", publicShare);

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const PNG = Buffer.from("0123456789");
const H = (token?: string) => ({ Origin: "http://localhost:3000", "x-forwarded-for": "127.0.0.1", ...(token ? { Authorization: `Bearer ${token}` } : {}) });

let owner: { token: string; id: string }, viewer: { token: string; id: string }, stranger: { token: string; id: string };
let docId: string;
before(async () => {
  owner = await signUpVerified(app, { name: "Owner", email: "o@markie.test" });
  viewer = await signUpVerified(app, { name: "Viewer", email: "v@markie.test" });
  stranger = await signUpVerified(app, { name: "Stranger", email: "s@markie.test" });
  docId = crypto.randomUUID();
  const content = "![](a.png)\n";
  await app.request(`/api/docs/${docId}`, { method: "PUT", headers: { ...H(owner.token), "Content-Type": "application/json" }, body: JSON.stringify({ name: "t.md", content, hash: sha(Buffer.from(content)), baseVersion: 0 }) });
  await app.request(`/api/assets/${sha(PNG)}`, { method: "PUT", headers: { ...H(owner.token), "Content-Type": "image/png", "Content-Length": "10" }, body: new Blob([PNG]) });
  await app.request(`/api/docs/${docId}/assets`, { method: "PUT", headers: { ...H(owner.token), "Content-Type": "application/json" }, body: JSON.stringify({ refs: [{ ref: "a.png", hash: sha(PNG) }] }) });
  await app.request(`/api/docs/${docId}/shares`, { method: "POST", headers: { ...H(owner.token), "Content-Type": "application/json" }, body: JSON.stringify({ email: "v@markie.test", role: "viewer" }) });
});

test("the bearer route serves members, ranges included, and hides from everyone else", async () => {
  const path = `/api/docs/${docId}/assets/file?ref=a.png`;
  let res = await app.request(path, { headers: H(owner.token) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(res.headers.get("etag"), `"${sha(PNG)}"`);
  assert.equal(await res.text(), "0123456789");
  res = await app.request(path, { headers: { ...H(viewer.token), Range: "bytes=2-4" } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 2-4/10");
  assert.equal(await res.text(), "234");
  assert.equal((await app.request(path, { headers: H(stranger.token) })).status, 404);
  assert.equal((await app.request(path, { headers: H() })).status, 401);
  assert.equal((await app.request(`/api/docs/${docId}/assets/file?ref=nope.png`, { headers: H(owner.token) })).status, 404);
});

test("a range with both sides empty is refused, not silently served in full", async () => {
  const path = `/api/docs/${docId}/assets/file?ref=a.png`;
  const res = await app.request(path, { headers: { ...H(owner.token), Range: "bytes=-" } });
  assert.equal(res.status, 416);
});

test("a matching If-None-Match answers 304 with no body, weak prefix tolerated", async () => {
  const path = `/api/docs/${docId}/assets/file?ref=a.png`;
  const etag = `"${sha(PNG)}"`;
  const res = await app.request(path, { headers: { ...H(owner.token), "If-None-Match": etag } });
  assert.equal(res.status, 304);
  assert.equal(res.headers.get("etag"), etag);
  assert.equal(res.headers.get("cache-control"), "private, max-age=3600");
  // A 304 still confirms nothing sniffs, frames or ranges past the gate,
  // same as any other response about this asset.
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(await res.text(), "");
  const weak = await app.request(path, { headers: { ...H(owner.token), "If-None-Match": `W/${etag}` } });
  assert.equal(weak.status, 304);
  assert.equal(weak.headers.get("etag"), etag);
});

test("the /d/ route follows resolveViewer: personal token or session, nothing else", async () => {
  assert.equal((await app.request(`/d/${docId}/assets?ref=a.png`, { headers: H() })).status, 404);
  // The viewer's personal ?k= token, minted on the share row the way the
  // invite email mints it.
  const { ensureShareToken } = await import("./shares.ts");
  const k = ensureShareToken(docId, viewer.id);
  const withToken = await app.request(`/d/${docId}/assets?ref=a.png&k=${encodeURIComponent(k)}`, { headers: H() });
  assert.equal(withToken.status, 200);
  assert.equal(await withToken.text(), "0123456789");
  assert.equal((await app.request(`/d/${docId}/assets?ref=a.png&k=not-a-token`, { headers: H() })).status, 404);
  // Removing the member kills the token with the share row.
  await app.request(`/api/docs/${docId}/shares/${viewer.id}`, { method: "DELETE", headers: H(owner.token) });
  assert.equal((await app.request(`/d/${docId}/assets?ref=a.png&k=${encodeURIComponent(k)}`, { headers: H() })).status, 404);
});

test("the /s/ route follows the public token and revocation", async () => {
  const made = await app.request(`/api/docs/${docId}/public-link`, { method: "POST", headers: { ...H(owner.token), "Content-Type": "application/json" } });
  // The route answers { url: "<site>/s/<token>" }; the token is its last segment.
  const { url } = (await made.json()) as { url: string };
  const token = url.split("/s/")[1];
  let res = await app.request(`/s/${token}/assets?ref=a.png`, { headers: H() });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "0123456789");
  assert.equal((await app.request(`/s/${token}/assets?ref=b.png`, { headers: H() })).status, 404);
  await app.request(`/api/docs/${docId}/public-link`, { method: "DELETE", headers: H(owner.token) });
  res = await app.request(`/s/${token}/assets?ref=a.png`, { headers: H() });
  assert.equal(res.status, 404);
});

// A ref can be relinked to different bytes while a client holds a partial
// copy of the old ones. If the resume is answered with a slice of the new
// object, the client stitches two different files together.
test("a Range with a stale If-Range is ignored and the whole asset is served", async () => {
  const path = `/api/docs/${docId}/assets/file?ref=a.png`;
  const etag = `"${sha(PNG)}"`;
  const range = { ...H(owner.token), Range: "bytes=2-4" };

  let res = await app.request(path, { headers: { ...range, "If-Range": `"${"0".repeat(64)}"` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-range"), null);
  assert.equal(res.headers.get("content-length"), "10");
  assert.equal(await res.text(), "0123456789");

  // A date-form If-Range names a validator this route never issues, so it
  // cannot match either.
  res = await app.request(path, { headers: { ...range, "If-Range": "Wed, 21 Oct 2026 07:28:00 GMT" } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "0123456789");

  // The asset the client actually has: the slice it asked for.
  res = await app.request(path, { headers: { ...range, "If-Range": etag } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 2-4/10");
  assert.equal(await res.text(), "234");
  // RFC 9110 13.1.5: If-Range takes a strong validator only, so the weak form
  // of this very ETag is not a match and the answer is the whole asset. That
  // is the opposite of If-None-Match, which tolerates the weak prefix.
  res = await app.request(path, { headers: { ...range, "If-Range": `W/${etag}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-range"), null);
  assert.equal(await res.text(), "0123456789");
});
