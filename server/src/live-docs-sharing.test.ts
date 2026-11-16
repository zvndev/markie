// Hosted Live Docs, H2: the shared level, and revocation that reaches a tab
// already open. The design's bar (markie-darkmown-sites-design, "Build
// order", H2): a stranger is refused and a removed person loses an open tab.
//
// A Live Doc is never public (2026-11-15). H2 once added a public address;
// it is gone, and the tests under "never public" hold that it stays gone: no
// public link for a .wd through any route, a document that becomes a .wd
// loses its link, old links are cleared at start, and `/s/<token>` for a Live
// Doc answers like a token that never existed.
//
// Requests carry the Host header a browser would send. An open tab is a read
// of the page's event stream (`/__markie/live`), the same one the page script
// keeps open.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMigrations } from "better-auth/db/migration";
import { acceptSender, signUpVerified } from "./test-users.ts";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-live-docs-h2-")), "t.db");
process.env.BETTER_AUTH_URL = "http://127.0.0.1:8787";
process.env.BETTER_AUTH_SECRET = "markie-live-docs-h2-test-secret-32-plus-chars";
process.env.MARKIE_SITE_URL = "https://markie.test";
process.env.LIVE_DOCS_DOMAIN = "live.localhost:8787";
process.env.MARKIE_NO_LISTEN = "1";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();

const { app, liveDocs } = await import("./index.ts");
const { createLiveDocs, LIVE_DOC_CHANNELS_PER_KEY } = await import("./live-docs.ts");
const { liveDocsConfig } = await import("./live-docs-config.ts");
const { takeDownLiveDoc, restoreLiveDoc } = await import("./live-docs-store.ts");
const { openLiveDocChannels, recheckLiveDocChannels } = await import("./live-docs-channels.ts");
const liveDocsModule = await import("./live-docs.ts");
const liveDocsPage = await import("./live-docs-page.ts");
const { guardLiveDocsPrivate, LIVE_DOC_PRIVATE } = await import("./public-links.ts");
const Database = (await import("better-sqlite3")).default;
const db = new Database(process.env.DB_PATH);
after(() => db.close());

assert.ok(liveDocs, "LIVE_DOCS_DOMAIN is set, so Live Docs are on");

const APP_HOST = "127.0.0.1:8787";
const APP_ORIGIN = `http://${APP_HOST}`;
const liveHost = (label: string) => `${label}.live.localhost:8787`;
const COOKIE = "__Host-markie-live";
const STATE_COOKIE = "__Host-markie-live-state";

let callers = 0;
interface Ask {
  cookie?: string;
  bearer?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}
function requestFor(host: string, path: string, init: Ask = {}): [string, RequestInit] {
  callers += 1;
  const headers = new Headers(init.headers);
  headers.set("host", host);
  if (!headers.has("x-forwarded-for")) headers.set("x-forwarded-for", `10.77.${Math.floor(callers / 250) % 250}.${callers % 250}`);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return [`http://${host}${path}`, { method: init.method ?? "GET", headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }];
}
async function ask(host: string, path: string, init: Ask = {}): Promise<Response> {
  const [url, request] = requestFor(host, path, init);
  return app.request(url, request);
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function putDoc(token: string, id: string, name: string, content: string) {
  const res = await ask(APP_HOST, `/api/docs/${id}`, { method: "PUT", bearer: token, body: { name, content, hash: sha(content), baseVersion: 0 } });
  assert.equal(res.status, 200, `PUT ${name}: ${await res.clone().text()}`);
}

async function browserSignIn(email: string): Promise<string> {
  const res = await ask(APP_HOST, "/api/auth/sign-in/email", { method: "POST", headers: { origin: "http://localhost:3000" }, body: { email, password: "password-123" } });
  assert.equal(res.status, 200);
  const session = res.headers.getSetCookie().map((line) => line.split(";")[0]).find((value) => value.startsWith("better-auth.session_token="));
  assert.ok(session);
  return session;
}

interface Address { url: string; access: string; network?: string[] }
async function addressFor(docId: string, token: string): Promise<Address> {
  const res = await ask(APP_HOST, `/api/docs/${docId}/live-doc`, { bearer: token });
  assert.equal(res.status, 200, `address: ${await res.clone().text()}`);
  return (await res.json()) as Address;
}
const labelOf = (url: string) => {
  const match = /^http:\/\/([a-z2-7]{16})\.live\.localhost:8787\/$/.exec(url);
  assert.ok(match, `a Live Doc address: ${url}`);
  return match[1];
};

/** The pass flow a browser takes; the Live Doc cookie it ends with. */
async function openPrivate(label: string, appCookie: string): Promise<string> {
  const start = await ask(liveHost(label), "/");
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  const stateCookie = start.headers.getSetCookie().find((line) => line.startsWith(`${STATE_COOKIE}-${state!.slice(0, 16)}=`))!.split(";")[0];
  const pass = await ask(APP_HOST, `/live-docs/pass/${label}?state=${state}`, { cookie: appCookie });
  assert.equal(pass.status, 302, "a pass");
  const redeem = new URL(pass.headers.get("location")!);
  assert.equal(redeem.pathname, "/__markie/pass");
  const redeemed = await ask(liveHost(label), `${redeem.pathname}${redeem.search}`, { cookie: stateCookie });
  assert.equal(redeemed.status, 303);
  const line = redeemed.headers.getSetCookie().find((value) => value.startsWith(`${COOKIE}=`) && !value.startsWith(`${COOKIE}=;`));
  assert.ok(line);
  const cookie = line.split(";")[0];
  assert.equal((await ask(liveHost(label), "/", { cookie })).status, 200, "the page opens");
  return cookie;
}

/** An open tab: the page's event stream, read one event at a time. */
interface Tab {
  res: Response;
  next(timeoutMs?: number): Promise<{ event: string; data: string } | "closed" | "timeout">;
  close(): Promise<void>;
}
async function openTab(response: Response | Promise<Response>): Promise<Tab> {
  const res = await response;
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  return {
    res,
    async next(timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const cut = buffer.indexOf("\n\n");
        if (cut !== -1) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const lines = block.split("\n").filter((line) => !line.startsWith(":"));
          if (lines.length === 0) continue;
          const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
          const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          return { event, data };
        }
        if (ended) return "closed";
        const left = deadline - Date.now();
        if (left <= 0) return "timeout";
        const read = await Promise.race([
          reader.read(),
          new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), left)),
        ]);
        if (read === "timeout") return "timeout";
        if (read.done) ended = true;
        else buffer += decoder.decode(read.value, { stream: true });
      }
    },
    async close() {
      await reader.cancel().catch(() => {});
    },
  };
}
const tabOn = (label: string, init: Ask = {}) => openTab(ask(liveHost(label), "/__markie/live", init));

async function expectReady(tab: Tab) {
  assert.equal(tab.res.status, 200);
  assert.match(tab.res.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.deepEqual(await tab.next(), { event: "ready", data: "{}" });
}
async function expectRevoked(tab: Tab, reason: string, timeoutMs = 2_000) {
  const event = await tab.next(timeoutMs);
  assert.deepEqual(event, { event: "revoked", data: JSON.stringify({ reason }) });
  assert.equal(await tab.next(500), "closed", "the stream ends after revoked");
}

const COUNTER = ':state count = 0\n\n# Counter\n\nCount: { count }.\n\n:button "Add one" -> count++\n';

const stamp = Date.now();
const owner = await signUpVerified(app, { name: "Olive Owner", email: `h2-owner-${stamp}@example.com` });
const viewer = await signUpVerified(app, { name: "Vic Viewer", email: `h2-viewer-${stamp}@example.com` });
const stranger = await signUpVerified(app, { name: "Stan Stranger", email: `h2-stranger-${stamp}@example.com` });
// Vic accepted Olive (share-people.ts), so her shares land as documents.
acceptSender(viewer.id, owner.id);
const ownerCookie = await browserSignIn(owner.email);
const viewerCookie = await browserSignIn(viewer.email);
const strangerCookie = await browserSignIn(stranger.email);

async function share(docId: string, email: string, role: "viewer" | "editor") {
  const res = await ask(APP_HOST, `/api/docs/${docId}/shares`, { method: "POST", bearer: owner.token, body: { email, role } });
  assert.equal(res.status, 200, await res.clone().text());
}
async function unshare(docId: string, userId: string) {
  const res = await ask(APP_HOST, `/api/docs/${docId}/shares/${encodeURIComponent(userId)}`, { method: "DELETE", bearer: owner.token });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as { publicLinkRotated: boolean; url?: string };
}
async function makePublic(docId: string): Promise<string> {
  const res = await ask(APP_HOST, `/api/docs/${docId}/public-link`, { method: "POST", bearer: owner.token });
  assert.equal(res.status, 200);
  const { url } = (await res.json()) as { url: string };
  return new URL(url).pathname.split("/").pop()!;
}
async function putVersion(token: string, id: string, name: string, content: string, baseVersion: number) {
  const res = await ask(APP_HOST, `/api/docs/${id}`, { method: "PUT", bearer: token, body: { name, content, hash: sha(content), baseVersion } });
  assert.equal(res.status, 200, `PUT ${name}: ${await res.clone().text()}`);
}
const linkRows = (docId: string) => (db.prepare("SELECT COUNT(*) AS n FROM public_links WHERE doc_id = ?").get(docId) as { n: number }).n;
/** What a token that never existed gets back, route by route, to compare against. */
const PUBLIC_PATHS = (token: string) => [`/s/${token}`, `/s/${token}?view=1`, `/s/${token}/raw`, `/s/${token}/links`, `/s/${token}/assets?ref=x`, `/api/public-links/${token}/editor`];
async function answers(token: string) {
  return Promise.all(PUBLIC_PATHS(token).map(async (path) => {
    const res = await ask(APP_HOST, path);
    return { status: res.status, location: res.headers.get("location"), body: await res.text() };
  }));
}
/** A link row written the way an old server (H2) could have: past the guards. */
function plantLegacyLink(docId: string, token: string) {
  db.exec("DROP TRIGGER IF EXISTS public_links_never_live_doc");
  db.prepare("INSERT INTO public_links (doc_id, token, created_by, created_at) VALUES (?, ?, ?, ?)").run(docId, token, owner.id, new Date().toISOString());
}

// ── shared ───────────────────────────────────────────────────────────────────

test("a viewer opens a shared Live Doc through the pass; a stranger is refused everywhere", async () => {
  const id = `h2-shared-${stamp}`;
  await putDoc(owner.token, id, "Shared.wd", COUNTER);
  await share(id, viewer.email, "viewer");

  const ownerView = await addressFor(id, owner.token);
  assert.equal(ownerView.access, "shared", "the owner sees it is shared");
  assert.deepEqual(Object.keys(ownerView).sort(), ["access", "network", "url"], "no public address, ever");
  const label = labelOf(ownerView.url);
  assert.deepEqual(await addressFor(id, viewer.token), { url: ownerView.url, access: "shared", network: [] });

  const cookie = await openPrivate(label, viewerCookie);
  const page = await ask(liveHost(label), "/", { cookie });
  assert.match(await page.text(), /Counter/);

  // The stranger: no address, no pass, and the live host only ever points
  // them at the pass, which refuses.
  assert.equal((await ask(APP_HOST, `/api/docs/${id}/live-doc`, { bearer: stranger.token })).status, 404);
  const pass = await ask(APP_HOST, `/live-docs/pass/${label}`, { cookie: strangerCookie });
  assert.equal(pass.status, 404);
  assert.match(await pass.text(), /shared with you, sign in with that account/);
  const bare = await ask(liveHost(label), "/");
  assert.equal(bare.status, 302);
  assert.ok(bare.headers.get("location")!.startsWith(`${APP_ORIGIN}/live-docs/pass/${label}?state=`));
  // The viewer's cookie is no key for the stranger's browser, and a stream
  // with no cookie is refused like any other.
  const tab = await tabOn(label);
  await expectRevoked(tab, "access");
});

test("a pending invite opens nothing until a verified account claims it", async () => {
  const id = `h2-invite-${stamp}`;
  await putDoc(owner.token, id, "Invite.wd", COUNTER);
  await share(id, `h2-nobody-${stamp}@example.com`, "viewer");
  const { url } = await addressFor(id, owner.token);
  const pass = await ask(APP_HOST, `/live-docs/pass/${labelOf(url)}`, { cookie: strangerCookie });
  assert.equal(pass.status, 404);
});

test("a removed viewer loses the tab they have open, at once, and cannot get back in", async () => {
  const id = `h2-remove-${stamp}`;
  await putDoc(owner.token, id, "Remove.wd", COUNTER);
  await share(id, viewer.email, "viewer");
  const label = labelOf((await addressFor(id, owner.token)).url);
  const cookie = await openPrivate(label, viewerCookie);
  const tab = await tabOn(label, { cookie });
  await expectReady(tab);
  const ownerTab = await tabOn(label, { cookie: await openPrivate(label, ownerCookie) });
  await expectReady(ownerTab);

  await unshare(id, viewer.id);
  // Removing the share calls the recheck itself, so this does not wait for
  // the 5-second timer.
  await expectRevoked(tab, "access", 500);
  assert.equal(await ownerTab.next(300), "timeout", "the owner's tab stays open");
  await ownerTab.close();

  const reload = await ask(liveHost(label), "/", { cookie });
  assert.equal(reload.status, 302, "the next load goes back to the pass");
  assert.ok(reload.headers.getSetCookie().some((line) => line.startsWith(`${COOKIE}=;`)), "and clears the cookie");
  assert.equal((await ask(APP_HOST, `/live-docs/pass/${label}`, { cookie: viewerCookie })).status, 404);
  const again = await tabOn(label, { cookie });
  await expectRevoked(again, "access");
});

test("signing out of Markie closes an open tab on the next check", async () => {
  // A second instance with a short timer: signing out has no hook into Live
  // Docs, so the timer is what finds it.
  const fast = createLiveDocs({ config: liveDocsConfig()!, appOrigin: APP_ORIGIN, siteUrl: "https://markie.test", recheckMs: 50 });
  const id = `h2-signout-${stamp}`;
  await putDoc(owner.token, id, "Signout.wd", COUNTER);
  await share(id, viewer.email, "viewer");
  const label = labelOf((await addressFor(id, owner.token)).url);
  const session = await browserSignIn(viewer.email);
  const cookie = await openPrivate(label, session);
  const [url, init] = requestFor(liveHost(label), "/__markie/live", { cookie });
  const tab = await openTab(fast.dispatch(new Request(url, init))!);
  await expectReady(tab);
  const out = await ask(APP_HOST, "/api/auth/sign-out", { method: "POST", cookie: session, headers: { origin: "http://localhost:3000" } });
  assert.equal(out.status, 200);
  await expectRevoked(tab, "access", 1_000);
});

test("deleting the document closes its open tabs as gone", async () => {
  const id = `h2-delete-${stamp}`;
  await putDoc(owner.token, id, "Delete.wd", COUNTER);
  const label = labelOf((await addressFor(id, owner.token)).url);
  const tab = await tabOn(label, { cookie: await openPrivate(label, ownerCookie) });
  await expectReady(tab);
  assert.equal((await ask(APP_HOST, `/api/docs/${id}`, { method: "DELETE", bearer: owner.token })).status, 200);
  await expectRevoked(tab, "gone", 500);
});

// ── never public ─────────────────────────────────────────────────────────────

test("a Live Doc can't be made public: the owner is refused, a viewer too, and nothing is stored", async () => {
  const id = `h2-never-${stamp}`;
  await putDoc(owner.token, id, "Never.wd", COUNTER);
  await share(id, viewer.email, "viewer");
  const refused = await ask(APP_HOST, `/api/docs/${id}/public-link`, { method: "POST", bearer: owner.token });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: "live-doc-private", message: "Live Docs can't be public. Share it with people instead." });
  assert.deepEqual(LIVE_DOC_PRIVATE, { error: "live-doc-private", message: "Live Docs can't be public. Share it with people instead." });
  assert.equal((await ask(APP_HOST, `/api/docs/${id}/public-link`, { method: "POST", bearer: viewer.token })).status, 403);
  assert.equal(linkRows(id), 0);
  const current = await ask(APP_HOST, `/api/docs/${id}/public-link`, { bearer: owner.token });
  assert.deepEqual(await current.json(), { url: null });
  for (const who of [owner.token, viewer.token]) {
    assert.deepEqual(Object.keys(await addressFor(id, who)).sort(), ["access", "network", "url"]);
  }
  assert.equal((await addressFor(id, owner.token)).access, "shared");
});

test("the database itself refuses a public link row for a Live Doc", async () => {
  const id = `h2-never-db-${stamp}`;
  await putDoc(owner.token, id, "NeverDb.wd", COUNTER);
  assert.throws(
    () => db.prepare("INSERT INTO public_links (doc_id, token, created_by, created_at) VALUES (?, ?, ?, ?)").run(id, `t-${stamp}-db`, owner.id, new Date().toISOString()),
    /live-doc-private/,
  );
  assert.equal(linkRows(id), 0);
});

test("a public Markdown document renamed to .wd loses its link in the same write", async () => {
  const id = `h2-rename-${stamp}`;
  await putDoc(owner.token, id, "Plan.md", "# Plan\n");
  const token = await makePublic(id);
  assert.equal((await ask(APP_HOST, `/s/${token}/raw`)).status, 200, "a Markdown public link works as before");
  await putVersion(owner.token, id, "Plan.wd", COUNTER, 1);
  assert.equal(linkRows(id), 0, "the rename took the link with it");
  assert.deepEqual(await answers(token), await answers(`never-${stamp}-x`), "the old link answers like one that never existed");
  // Back to Markdown: the link does not come back by itself, and can be made again.
  await putVersion(owner.token, id, "Plan.md", "# Plan\n", 2);
  assert.equal(linkRows(id), 0);
  const fresh = await makePublic(id);
  assert.notEqual(fresh, token);
  assert.equal((await ask(APP_HOST, `/s/${fresh}/raw`)).status, 200);
});

test("/s/<token> for a Live Doc serves nothing, exactly like a token that never existed", async () => {
  const id = `h2-legacy-${stamp}`;
  await putDoc(owner.token, id, "Legacy.wd", COUNTER);
  const token = `legacy${stamp}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`.slice(0, 64);
  plantLegacyLink(id, token);
  try {
    const got = await answers(token);
    assert.deepEqual(got, await answers(`never-${stamp}-y`));
    for (const answer of got) {
      assert.equal(answer.status, 404);
      assert.ok(!answer.body.includes("Counter"), "no source");
      assert.equal(answer.location, null, "no forward to a page");
    }
  } finally {
    guardLiveDocsPrivate(db);
  }
});

test("starting up clears every public link a Live Doc kept from before, once, and leaves Markdown links alone", async () => {
  const live = `h2-sweep-${stamp}`;
  const md = `h2-sweep-md-${stamp}`;
  await putDoc(owner.token, live, "Sweep.wd", COUNTER);
  await putDoc(owner.token, md, "Sweep.md", "# Sweep\n");
  const mdToken = await makePublic(md);
  plantLegacyLink(live, `sweep${stamp}`);
  assert.equal(linkRows(live), 1);
  assert.equal(guardLiveDocsPrivate(db), 1, "the one Live Doc link");
  assert.equal(linkRows(live), 0);
  assert.equal(guardLiveDocsPrivate(db), 0, "idempotent: nothing left the second time");
  assert.equal(linkRows(md), 1, "a Markdown document keeps its public link");
  assert.equal((await ask(APP_HOST, `/s/${mdToken}/raw`)).status, 200);
  // The guard is back in place after the sweep.
  assert.throws(() => db.prepare("INSERT INTO public_links (doc_id, token, created_by, created_at) VALUES (?, ?, ?, ?)").run(live, `again-${stamp}`, owner.id, ""), /live-doc-private/);
});

test("the Live Doc host has no public path left", async () => {
  // Nothing public is exported any more.
  for (const name of ["liveDocClientKey", "LIVE_DOC_PUBLIC_CHANNELS_MAX", "LIVE_DOC_PUBLIC_CHANNELS_PER_OWNER"]) {
    assert.equal(name in liveDocsModule, false, name);
  }
  assert.equal("publicAddressFor" in liveDocs!, false);
  const store = await import("./live-docs-store.ts");
  for (const name of ["ensurePublicLiveDocLabel", "publicLiveDocFor", "liveDocPublisherName", "docIdForAnyLabel"]) {
    assert.equal(name in store, false, name);
  }
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'live_doc_public_addresses'").get(), undefined, "the public address table is dropped");
  // No publisher footer, no "link" revoke reason in the page.
  assert.ok(!liveDocsPage.LIVE_DOC_CHANNEL_SCRIPT.includes('"link"'));
  assert.ok(!liveDocsPage.LIVE_DOC_CHANNEL_SCRIPT.includes("public link"));
  assert.ok(!liveDocsPage.renderLiveDocPage({ bodyHtml: "<p>x</p>", seeds: [], title: "x" }).includes("markie-live-footer"));

  // Even with an old public link row in place, the Live Doc's address opens
  // only through the pass, its stream refuses a visitor with no cookie, and
  // its `/s/` link forwards nowhere.
  const id = `h2-nopublic-${stamp}`;
  await putDoc(owner.token, id, "NoPublic.wd", COUNTER);
  const token = `nopublic${stamp}`;
  plantLegacyLink(id, token);
  try {
    const label = labelOf((await addressFor(id, owner.token)).url);
    const bare = await ask(liveHost(label), "/");
    assert.equal(bare.status, 302);
    assert.ok(bare.headers.get("location")!.startsWith(`${APP_ORIGIN}/live-docs/pass/${label}?state=`));
    assert.ok(!(await bare.text()).includes("Counter"));
    await expectRevoked(await tabOn(label), "access");
    const link = await ask(APP_HOST, `/s/${token}`);
    assert.equal(link.status, 404);
    assert.equal(link.headers.get("location"), null);
  } finally {
    guardLiveDocsPrivate(db);
  }
});

test("a public link to a document that is not a Live Doc keeps its usual page", async () => {
  const id = `h2-md-${stamp}`;
  await putDoc(owner.token, id, "Notes.md", "# Notes\n");
  const token = await makePublic(id);
  const res = await ask(APP_HOST, `/s/${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("location"), null);
  assert.equal((await ask(APP_HOST, `/s/${token}/raw`)).status, 200);
});

// ── takedown ─────────────────────────────────────────────────────────────────

test("a taken-down Live Doc is hosted at no level, and comes back when restored", async () => {
  const id = `h2-takedown-${stamp}`;
  await putDoc(owner.token, id, "Takedown.wd", COUNTER);
  const view = await addressFor(id, owner.token);
  const privateLabel = labelOf(view.url);
  const cookie = await openPrivate(privateLabel, ownerCookie);
  const fast = createLiveDocs({ config: liveDocsConfig()!, appOrigin: APP_ORIGIN, siteUrl: "https://markie.test", recheckMs: 50 });
  const [url, init] = requestFor(liveHost(privateLabel), "/__markie/live", { cookie });
  const tab = await openTab(fast.dispatch(new Request(url, init))!);
  await expectReady(tab);

  takeDownLiveDoc(id, "test");
  await expectRevoked(tab, "gone", 1_000);
  for (const sent of [cookie, undefined]) {
    const res = await ask(liveHost(privateLabel), "/", sent ? { cookie: sent } : {});
    assert.equal(res.status, 410);
    assert.match(await res.text(), /taken down/);
  }
  assert.equal((await ask(APP_HOST, `/api/docs/${id}/live-doc`, { bearer: owner.token })).status, 410);
  assert.equal((await ask(APP_HOST, `/live-docs/pass/${privateLabel}`, { cookie: ownerCookie })).status, 404);

  assert.equal(restoreLiveDoc(id), true);
  await openPrivate(privateLabel, ownerCookie);
});

// ── the stream itself ────────────────────────────────────────────────────────

test("a stream for an address that does not exist is refused like any other, with a 200", async () => {
  const tab = await tabOn("aaaaaaaaaaaaaaaa");
  assert.equal(tab.res.status, 200);
  await expectRevoked(tab, "access");
  const made = await tabOn("aaaaaaaaaaaaaaaa", { cookie: `${COOKIE}=made-up` });
  await expectRevoked(made, "access");
});

test("the stream carries the live-host headers and no app CORS", async () => {
  const id = `h2-headers-${stamp}`;
  await putDoc(owner.token, id, "Headers.wd", COUNTER);
  const label = labelOf((await addressFor(id, owner.token)).url);
  const tab = await tabOn(label, { cookie: await openPrivate(label, ownerCookie), headers: { origin: "https://evil.test" } });
  await expectReady(tab);
  assert.equal(tab.res.headers.get("cache-control"), "private, no-store");
  assert.equal(tab.res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(tab.res.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(tab.res.headers.getSetCookie(), []);
  await tab.close();
});

test("one person cannot hold more than their share of open streams, and closing one frees it", async () => {
  const id = `h2-cap-${stamp}`;
  await putDoc(owner.token, id, "Cap.wd", COUNTER);
  await share(id, viewer.email, "viewer");
  const label = labelOf((await addressFor(id, owner.token)).url);
  const before = openLiveDocChannels();
  const from = { cookie: await openPrivate(label, ownerCookie) };
  const tabs: Tab[] = [];
  for (let index = 0; index < LIVE_DOC_CHANNELS_PER_KEY; index++) {
    const tab = await tabOn(label, from);
    await expectReady(tab);
    tabs.push(tab);
  }
  assert.equal(openLiveDocChannels(), before + LIVE_DOC_CHANNELS_PER_KEY);
  const refused = await ask(liveHost(label), "/__markie/live", from);
  assert.equal(refused.status, 429, "busy, not revoked: the page backs off and retries");
  const other = await tabOn(label, { cookie: await openPrivate(label, viewerCookie) });
  await expectReady(other);
  await other.close();

  await tabs.pop()!.close();
  // The abort reaches the stream on the next tick.
  for (let wait = 0; wait < 20 && openLiveDocChannels() > before + LIVE_DOC_CHANNELS_PER_KEY - 1; wait++) await new Promise((resolve) => setTimeout(resolve, 25));
  const room = await tabOn(label, from);
  await expectReady(room);
  tabs.push(room);
  for (const tab of tabs) await tab.close();
});

// ── review findings ──────────────────────────────────────────────────────────

test("access checks never read the document's text, however large it is", async () => {
  // What it means, without a wall clock: every statement on the access path
  // (liveDocMeta, which every page load and stream re-check runs, and
  // shares.ts isOwner) answers from the covering index alone, so SQLite never
  // opens the row or walks the text's overflow pages, whatever its size.
  const sources = ["live-docs-store.ts", "shares.ts"].map((name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8")).join("\n");
  const statements = [...sources.matchAll(/"(SELECT [^"]*FROM docs INDEXED BY idx_docs_access[^"]*)"/g)].map((match) => match[1]!);
  assert.ok(statements.length >= 2, `found the access statements: ${statements.join(" | ")}`);
  for (const sql of statements) {
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array.from(sql.matchAll(/\?/g), () => "x")) as Array<{ detail: string }>).map((row) => row.detail).join("; ");
    assert.match(plan, /USING COVERING INDEX idx_docs_access/, `${sql}\n  planned as: ${plan}`);
  }

  // And the behaviour on a 40 MB document: the page is refused by size, and
  // ten open tabs connect and are re-checked.
  const id = `h2-heavy-${stamp}`;
  await putDoc(owner.token, id, "Heavy.wd", COUNTER);
  const label = labelOf((await addressFor(id, owner.token)).url);
  const cookie = await openPrivate(label, ownerCookie);
  db.prepare("UPDATE docs SET content = ? WHERE id = ?").run(`# Heavy\n\n${"x".repeat(40 * 1024 * 1024)}`, id);
  const page = await ask(liveHost(label), "/", { cookie });
  assert.equal(page.status, 422);
  assert.match(await page.text(), /200,000 characters/);
  const tabs = await Promise.all(Array.from({ length: 10 }, () => tabOn(label, { cookie })));
  for (const tab of tabs) await expectReady(tab);
  recheckLiveDocChannels(id);
  assert.deepEqual(await Promise.all(tabs.map((tab) => tab.next(200))), tabs.map(() => "timeout"), "the owner keeps every tab");
  for (const tab of tabs) await tab.close();
});
