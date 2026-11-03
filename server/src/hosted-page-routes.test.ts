// Who gets the read view at /d/:id and /s/:token, who keeps the static page,
// and what the bar links to, with the web app present and absent. The access
// rules themselves are doc-view.test.ts's; this file asserts only that the
// web app changes nothing about who reads, and where a reader lands. The read
// view is the app's shell: it holds nothing of any document, and the browser
// reads the document from the API with its own session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

const dir = mkdtempSync(join(tmpdir(), "markie-hosted-routes-"));
const webDist = join(dir, "web-dist");
process.env.DB_PATH = join(dir, "t.db");
process.env.ASSETS_DIR = join(dir, "store");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-hosted-routes-test-secret-32-plus";
process.env.MARKIE_SITE_URL = "https://markie.test";
process.env.MARKIE_WEB_DIST = webDist;

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();

const { docs } = await import("./docs.ts");
const { shares, ensureShareToken } = await import("./shares.ts");
const { docView } = await import("./doc-view.ts");
const { publicShare } = await import("./public.ts");
const { webAppAvailable } = await import("./web-app.ts");

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/docs", docs);
app.route("/api/docs", shares);
app.route("/", docView);
app.route("/", publicShare);
// Word, RTF and ODT files live in the document platform's store, wired as
// index.ts wires it, on the same database.
const { createDocumentPlatform } = await import("./document-platform.ts");
const { createSqliteDocumentPlatformStore } = await import("./document-platform-store.ts");
const { openDatabase } = await import("./db.ts");
app.route("/api/document-platform", createDocumentPlatform({
  store: createSqliteDocumentPlatformStore(openDatabase()),
  resolveUser: async (request) => (await auth.api.getSession({ headers: request.headers }))?.user ?? null,
}));

// No MARKIE_DOCS_ORIGIN here, so the web app and the sign-in are both on
// this server's own origin.
const APP = "http://localhost:8787";
const ORIGIN = { Origin: "http://localhost:3000", "x-forwarded-for": "127.0.0.1" };
const stamp = Date.now();
const BODY = "hosted-routes-secret-line";

const SHELL = '<!doctype html><html><head><title>Markie</title></head><body><div id="root"></div></body></html>';

// The read view: the shell, with the app's own page policy, kept private.
function assertReadView(res: { status: number; body: string; location: string | null; headers: Headers }, label = "") {
  assert.equal(res.status, 200, label);
  assert.equal(res.location, null, `${label} never a redirect into the editor`);
  assert.match(res.body, /<div id="root">/, label);
  assert.ok(!res.body.includes(BODY), `${label} the shell carries no document text`);
  assert.equal(res.headers.get("cache-control"), "private, no-store", label);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer", label);
  const csp = res.headers.get("content-security-policy") ?? "";
  assert.match(csp, /script-src 'self'/, label);
  assert.doesNotMatch(/script-src ([^;]*)/.exec(csp)?.[1] ?? "", /unsafe-inline|https:/, label);
  assert.match(csp, /frame-ancestors 'none'/, label);
}

function webApp(on: boolean) {
  if (on) {
    mkdirSync(webDist, { recursive: true });
    writeFileSync(join(webDist, "app.html"), SHELL);
  } else {
    rmSync(join(webDist, "app.html"), { force: true });
  }
  assert.equal(webAppAvailable(), on);
}

async function json<T>(method: string, path: string, token?: string, body?: unknown) {
  const headers = new Headers({ "Content-Type": "application/json", ...ORIGIN });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => null)) as T | null };
}

async function page(path: string, bearer?: string) {
  const headers = new Headers(ORIGIN);
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  const res = await app.request(path, { headers });
  return { status: res.status, body: await res.text(), location: res.headers.get("location"), headers: res.headers };
}

async function makeDoc(token: string, docId: string) {
  const content = `# Hosted\n\n${BODY}\n`;
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  const res = await json("PUT", `/api/docs/${docId}`, token, { name: "hosted.md", content, hash, baseVersion: 0 });
  assert.equal(res.status, 200);
}

async function share(ownerToken: string, docId: string, email: string, role: "viewer" | "editor") {
  const res = await json<{ userId?: string; status: string }>("POST", `/api/docs/${docId}/shares`, ownerToken, { email, role });
  assert.equal(res.status, 200);
  return res.data;
}

const appHrefs = (body: string) =>
  [...body.matchAll(/href="([^"]*)"/g)].map((m) => m[1]).filter((h) => h === "/app" || h.startsWith("/app/"));

const owner = await signUpVerified(app, { name: "Owner", email: `hr.owner.${stamp}@test.local` });
const viewer = await signUpVerified(app, { name: "Viewer", email: `hr.viewer.${stamp}@test.local` });
const stranger = await signUpVerified(app, { name: "Stranger", email: `hr.stranger.${stamp}@test.local` });
const docId = `hr-doc-${stamp}`;
await makeDoc(owner.token, docId);
const viewerShare = await share(owner.token, docId, viewer.email, "viewer");

test("a signed-in reader gets the read view, never the editor", async () => {
  webApp(true);
  for (const who of [owner, viewer]) {
    assertReadView(await page(`/d/${docId}`, who.token), who.email);
  }
});

test("a member's ?k= token goes nowhere from the read view", async () => {
  webApp(true);
  const token = ensureShareToken(docId, viewerShare?.userId as string) as string;
  const res = await page(`/d/${docId}?k=${encodeURIComponent(token)}`, viewer.token);
  assertReadView(res);
  assert.ok(!res.body.includes(token));
});

test("?view=1 keeps the static page, with the editor link for an editor only", async () => {
  webApp(true);
  const mine = await page(`/d/${docId}?view=1`, owner.token);
  assert.equal(mine.status, 200);
  assert.ok(mine.body.includes(BODY));
  assert.deepEqual(appHrefs(mine.body), ["/app", "/app/new", `/app/d/${docId}`]);
  assert.match(mine.body, new RegExp(`Signed in as </span>hr\\.owner\\.${stamp}@test\\.local`));

  const theirs = await page(`/d/${docId}?view=1`, viewer.token);
  assert.equal(theirs.status, 200);
  assert.deepEqual(appHrefs(theirs.body), ["/app", "/app/new"]);
});

test("a browser with no session here gets the same read view for every id", async () => {
  webApp(true);
  // Through the docs host's proxy no request carries the session cookie, so
  // the view decides: it asks the API for the session and reads only what
  // the account may read. The same shell answers for every id, existing or
  // not, byte for byte, and never carries the ?k= token.
  const anon = await page(`/d/${docId}`);
  const token = ensureShareToken(docId, viewerShare?.userId as string) as string;
  const forwarded = await page(`/d/${docId}?k=${encodeURIComponent(token)}`);
  const missing = await page(`/d/hr-missing-${stamp}`);
  for (const res of [anon, forwarded, missing]) {
    assertReadView(res);
    assert.ok(!res.body.includes(token));
    assert.equal(res.body, anon.body, "nothing tells one id from another");
  }
  // ?view=1 is the server's own pages throughout: the old refusal, no shell.
  const scriptless = await page(`/d/${docId}?view=1`);
  assert.equal(scriptless.status, 403);
  assert.doesNotMatch(scriptless.body, /<div id="root">/);
});

test("a signed-in account that cannot read keeps its refusal", async () => {
  webApp(true);
  // Signed in as someone it was not shared with.
  const wrong = await page(`/d/${docId}`, stranger.token);
  assert.equal(wrong.status, 403);
  // Signed in, document does not exist: the same refusal.
  const missing = await page(`/d/hr-missing-${stamp}`, owner.token);
  assert.equal(missing.status, 403);
  for (const res of [wrong, missing]) {
    assert.equal(res.location, null, "never toward the web app");
    assert.ok(!res.body.includes(BODY));
  }
});

test("without the web app a browser with no session gets the old refusals", async () => {
  webApp(false);
  const anon = await page(`/d/${docId}`);
  assert.equal(anon.status, 403);
  const token = ensureShareToken(docId, viewerShare?.userId as string) as string;
  const forwarded = await page(`/d/${docId}?k=${encodeURIComponent(token)}`);
  assert.equal(forwarded.status, 302);
  assert.equal(forwarded.location, `${APP}/auth/web-signin?next=${encodeURIComponent(`/d/${docId}`)}`);
});

test("an invite holder keeps the invite page", async () => {
  webApp(true);
  const docId2 = `hr-invite-${stamp}`;
  await makeDoc(owner.token, docId2);
  await share(owner.token, docId2, `hr.pending.${stamp}@test.local`, "editor");
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(process.env.DB_PATH as string);
  const row = db.prepare("SELECT token FROM pending_shares WHERE doc_id = ?").get(docId2) as { token: string };
  db.close();
  const res = await page(`/d/${docId2}?k=${encodeURIComponent(row.token)}`);
  assert.equal(res.status, 401);
  assert.match(res.body, /Sign in to open this document/);
  assert.equal(res.location, null);
});

test("without the web app a reader gets the static page and no /app links", async () => {
  webApp(false);
  const res = await page(`/d/${docId}`, owner.token);
  assert.equal(res.status, 200);
  assert.ok(res.body.includes(BODY));
  assert.deepEqual(appHrefs(res.body), []);
  assert.match(res.body, />Open in Markie</);
});

async function publicToken() {
  const made = await json<{ url: string }>("POST", `/api/docs/${docId}/public-link`, owner.token);
  assert.equal(made.status, 200);
  const token = (made.data?.url ?? "").split("/s/")[1];
  assert.ok(token);
  return token;
}

test("a public link opens the read view, naming only what the static page shows", async () => {
  const token = await publicToken();
  webApp(true);
  for (const who of [undefined, owner.token, stranger.token]) {
    const res = await page(`/s/${token}`, who);
    assertReadView(res);
    assert.match(res.body, /<title>hosted\.md · Markie<\/title>/);
    assert.match(res.body, /<meta name="markie-doc-name" content="hosted\.md" \/>/);
    assert.match(res.body, /<meta name="markie-doc-format" content="markdown" \/>/);
    assert.ok(!res.body.includes(docId), "the shell never names the document's id");
  }
  // An unknown token is still the server's own not-found page.
  const gone = await page(`/s/not-a-token-${stamp}`);
  assert.equal(gone.status, 404);
  assert.doesNotMatch(gone.body, /<div id="root">/);
});

test("the public view's Edit asks for the document's id, which only an editor gets", async () => {
  const token = await publicToken();
  const editor = await json<{ docId: string | null }>("GET", `/api/public-links/${token}/editor`, owner.token);
  assert.equal(editor.status, 200);
  assert.equal(editor.data?.docId, docId);
  for (const who of [viewer, stranger]) {
    const res = await json<{ docId: string | null }>("GET", `/api/public-links/${token}/editor`, who.token);
    assert.equal(res.status, 200);
    assert.equal(res.data?.docId, null, `${who.email} is not named the id`);
  }
  const anon = await json("GET", `/api/public-links/${token}/editor`);
  assert.equal(anon.status, 401);
  const unknown = await json("GET", `/api/public-links/nope-${stamp}/editor`, owner.token);
  assert.equal(unknown.status, 404);
});

test("?view=1 keeps the static public page, whose bar follows the reader's account", async () => {
  const token = await publicToken();

  webApp(true);
  const anon = await page(`/s/${token}?view=1`);
  assert.equal(anon.status, 200, "a public link never redirects to the web app");
  // The bar can name the reader, so no cache may keep the page.
  assert.equal(anon.headers.get("cache-control"), "private, no-store");
  assert.ok(anon.body.includes(BODY));
  assert.deepEqual(appHrefs(anon.body), ["/app"]);
  assert.match(anon.body, />Sign in</);

  const asOwner = await page(`/s/${token}?view=1`, owner.token);
  assert.equal(asOwner.status, 200);
  assert.deepEqual(appHrefs(asOwner.body), ["/app", "/app/new", `/app/d/${docId}`]);

  const asViewer = await page(`/s/${token}?view=1`, viewer.token);
  assert.deepEqual(appHrefs(asViewer.body), ["/app", "/app/new"], "a viewer is not offered the editor");

  const asStranger = await page(`/s/${token}?view=1`, stranger.token);
  assert.deepEqual(appHrefs(asStranger.body), ["/app", "/app/new"]);
  assert.ok(!asStranger.body.includes(docId), "the id is never named to an account that cannot edit it");

  webApp(false);
  const plain = await page(`/s/${token}`, owner.token);
  assert.deepEqual(appHrefs(plain.body), []);
  assert.match(plain.body, />Open in Markie</);
});

// ── Word, RTF and ODT: the document platform's store ─────────────────────
// A fresh /d/<id> load of an Office file used to answer its own owner with
// "No access", because the route only looked in the text store.
const OFFICE_NAME = `Office-${stamp}.rtf`;
const OFFICE_LINE = "office-secret-cell";
const office = await (async () => {
  const bytes = Buffer.from(String.raw`{\rtf1\ansi ` + OFFICE_LINE + String.raw`\par}`, "utf8");
  const created = await json<{ document: { id: string } }>("POST", "/api/document-platform/documents", owner.token, {
    schemaVersion: 2, name: OFFICE_NAME, format: "rtf", encoding: "base64", data: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"), baseVersion: 0,
  });
  assert.equal(created.status, 201, `create an Office document: ${JSON.stringify(created.data)}`);
  return created.data!.document.id;
})();
const officeEditor = await signUpVerified(app, { name: "Office editor", email: `hr.office-editor.${stamp}@test.local` });
const officeViewer = await signUpVerified(app, { name: "Office viewer", email: `hr.office-viewer.${stamp}@test.local` });
for (const [member, role] of [[officeEditor, "editor"], [officeViewer, "viewer"]] as const) {
  const added = await json("POST", `/api/document-platform/documents/${office}/members`, owner.token, { userId: member.id, role });
  assert.ok(added.status === 200 || added.status === 201 || added.status === 204, `add ${role}: ${added.status} ${JSON.stringify(added.data)}`);
}
const MISSING_OFFICE = "00000000-0000-4000-8000-000000000000";

test("an Office document's owner, editors and viewers get the read view on a fresh load", async () => {
  webApp(true);
  for (const who of [owner, officeEditor, officeViewer]) {
    const res = await page(`/d/${office}`, who.token);
    assertReadView(res, who.email);
    assert.ok(!res.body.includes(OFFICE_LINE) && !res.body.includes(OFFICE_NAME), `${who.email}: the shell names nothing of the file`);
  }
});

test("an Office document refuses a non-member exactly as it refuses a missing id", async () => {
  webApp(true);
  const wrong = await page(`/d/${office}`, stranger.token);
  const missing = await page(`/d/${MISSING_OFFICE}`, stranger.token);
  assert.equal(wrong.status, 403);
  assert.equal(missing.status, 403);
  // The page names only the id the browser asked for (in its sign-in link).
  assert.equal(wrong.body.replaceAll(office, "ID"), missing.body.replaceAll(MISSING_OFFICE, "ID"), "nothing tells a real Office id from a made-up one");
  assert.equal(wrong.location, null);
  assert.ok(!wrong.body.includes(OFFICE_NAME) && !wrong.body.includes(OFFICE_LINE));
  assert.doesNotMatch(wrong.body, /<div id="root">/);
  // The text store's members get nothing from it either.
  const textViewer = await page(`/d/${office}`, viewer.token);
  assert.equal(textViewer.status, 403);
  // With no session, the same shell as any other id, existing or not.
  const anon = await page(`/d/${office}`);
  const anonMissing = await page(`/d/${MISSING_OFFICE}`);
  assertReadView(anon);
  assert.equal(anon.body, anonMissing.body);
});

test("an Office document has no scriptless page, and says where it opens", async () => {
  webApp(true);
  const scriptless = await page(`/d/${office}?view=1`, owner.token);
  assert.equal(scriptless.status, 200);
  assert.doesNotMatch(scriptless.body, /<div id="root">/);
  assert.ok(scriptless.body.includes(OFFICE_NAME), "a reader may see the name of a file they can read");
  assert.ok(!scriptless.body.includes(OFFICE_LINE));
  assert.ok(scriptless.body.includes(`href="/app/d/${office}"`));
  const stranger403 = await page(`/d/${office}?view=1`, stranger.token);
  assert.equal(stranger403.status, 403);

  webApp(false);
  const plain = await page(`/d/${office}`, officeViewer.token);
  assert.equal(plain.status, 200);
  assert.deepEqual(appHrefs(plain.body), [], "no web app, no link into it");
  webApp(true);
});

test("an Office document's raw text and assets stay behind the text store's routes", async () => {
  // /d/<id>/raw serves a text document's markdown; an Office file is read
  // through the platform API with the reader's session, never here.
  const raw = await page(`/d/${office}/raw`, owner.token);
  assert.equal(raw.status, 403);
  assert.ok(!raw.body.includes(OFFICE_LINE));
});
