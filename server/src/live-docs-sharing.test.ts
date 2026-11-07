// Hosted Live Docs, H2: shared and public levels, and revocation that reaches
// a tab already open. The design's bar (markie-darkmown-sites-design, "Build
// order", H2): a stranger is refused, a removed person loses an open tab, and
// a rotated link kills the old one.
//
// Requests carry the Host header a browser would send. An open tab is a read
// of the page's event stream (`/__markie/live`), the same one the page script
// keeps open.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

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
const { takeDownLiveDoc, restoreLiveDoc, liveDocLabel } = await import("./live-docs-store.ts");
const { openLiveDocChannels, recheckLiveDocChannels } = await import("./live-docs-channels.ts");
const { liveDocClientKey } = await import("./live-docs.ts");
const Database = (await import("better-sqlite3")).default;
const db = new Database(process.env.DB_PATH);
after(() => db.close());

assert.ok(liveDocs, "LIVE_DOCS_DOMAIN is set, so Live Docs are on");

const APP_HOST = "127.0.0.1:8787";
const APP_ORIGIN = `http://${APP_HOST}`;
const liveHost = (label: string) => `${label}.live.localhost:8787`;
const liveOrigin = (label: string) => `http://${liveHost(label)}`;
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

interface Address { url: string; access: string; publicUrl?: string; publishedAs?: string }
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

// ── shared ───────────────────────────────────────────────────────────────────

test("a viewer opens a shared Live Doc through the pass; a stranger is refused everywhere", async () => {
  const id = `h2-shared-${stamp}`;
  await putDoc(owner.token, id, "Shared.wd", COUNTER);
  await share(id, viewer.email, "viewer");

  const ownerView = await addressFor(id, owner.token);
  assert.equal(ownerView.access, "shared", "the owner sees it is shared");
  assert.equal(ownerView.publicUrl, undefined, "no public address while the public link is off");
  const label = labelOf(ownerView.url);
  assert.deepEqual(await addressFor(id, viewer.token), { url: ownerView.url, access: "shared" });

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

// ── public ───────────────────────────────────────────────────────────────────

test("a public Live Doc opens for anyone at its own address, with no cookie and no pass", async () => {
  const id = `h2-public-${stamp}`;
  await putDoc(owner.token, id, "Public.wd", COUNTER);
  const token = await makePublic(id);
  const view = await addressFor(id, owner.token);
  assert.equal(view.access, "public");
  assert.ok(view.publicUrl);
  const publicLabel = labelOf(view.publicUrl);
  const privateLabel = labelOf(view.url);
  assert.notEqual(publicLabel, privateLabel, "the public address is not the private one");
  assert.equal(liveDocLabel(id), privateLabel);

  const page = await ask(liveHost(publicLabel), "/");
  assert.equal(page.status, 200);
  assert.deepEqual(page.headers.getSetCookie(), [], "no cookie of any kind");
  assert.equal(page.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(page.headers.get("cache-control"), "private, no-store");
  const html = await page.text();
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, /<footer class="markie-live-footer">A public Live Doc published with Markie by Olive Owner\.<\/footer>/);
  assert.ok(!html.includes(owner.email), "the footer never shows the owner's email");
  assert.match(html, /Counter/);

  // The private address of a public document still needs the pass.
  assert.equal((await ask(liveHost(privateLabel), "/")).status, 302);

  // The public link everyone already shares forwards to the public address.
  const link = await ask(APP_HOST, `/s/${token}`);
  assert.equal(link.status, 302);
  assert.equal(link.headers.get("location"), view.publicUrl);
  assert.match(link.headers.get("cache-control") ?? "", /no-store/);

  const tab = await tabOn(publicLabel);
  await expectReady(tab);
  await tab.close();
});

test("members never see the public address; a viewer cannot make one", async () => {
  const id = `h2-public-members-${stamp}`;
  await putDoc(owner.token, id, "Members.wd", COUNTER);
  await share(id, viewer.email, "viewer");
  await makePublic(id);
  assert.deepEqual(Object.keys(await addressFor(id, viewer.token)).sort(), ["access", "url"]);
  assert.equal((await addressFor(id, viewer.token)).access, "shared");
  assert.equal((await ask(APP_HOST, `/api/docs/${id}/public-link`, { method: "POST", bearer: viewer.token })).status, 403);
});

test("a rotated public link kills the old address and closes its open tabs", async () => {
  const id = `h2-rotate-${stamp}`;
  await putDoc(owner.token, id, "Rotate.wd", COUNTER);
  await share(id, viewer.email, "viewer");
  const oldToken = await makePublic(id);
  const oldLabel = labelOf((await addressFor(id, owner.token)).publicUrl!);
  const tab = await tabOn(oldLabel);
  await expectReady(tab);

  // Removing a member rotates the public link (shares.ts), because they may
  // have kept the URL.
  const removed = await unshare(id, viewer.id);
  assert.equal(removed.publicLinkRotated, true);
  await expectRevoked(tab, "link", 500);

  // The old address now answers exactly like an address that never existed.
  const dead = await ask(liveHost(oldLabel), "/");
  const never = await ask(liveHost("aaaaaaaaaaaaaaaa"), "/");
  assert.equal(dead.status, 302);
  assert.ok(dead.headers.get("location")!.startsWith(`${APP_ORIGIN}/live-docs/pass/${oldLabel}?state=`));
  assert.ok(never.headers.get("location")!.startsWith(`${APP_ORIGIN}/live-docs/pass/aaaaaaaaaaaaaaaa?state=`));
  assert.equal((await ask(APP_HOST, `/s/${oldToken}`)).headers.get("location"), null, "the old link forwards nowhere");

  // The new link gets a new address.
  const fresh = await addressFor(id, owner.token);
  const newLabel = labelOf(fresh.publicUrl!);
  assert.notEqual(newLabel, oldLabel);
  assert.equal((await ask(liveHost(newLabel), "/")).status, 200);
  const newToken = new URL(removed.url!).pathname.split("/").pop()!;
  assert.equal((await ask(APP_HOST, `/s/${newToken}`)).headers.get("location"), fresh.publicUrl);
});

test("turning the public link off closes the public tabs and leaves the private address working", async () => {
  const id = `h2-revoke-${stamp}`;
  await putDoc(owner.token, id, "Revoke.wd", COUNTER);
  await makePublic(id);
  const view = await addressFor(id, owner.token);
  const publicLabel = labelOf(view.publicUrl!);
  const tab = await tabOn(publicLabel);
  await expectReady(tab);
  assert.equal((await ask(APP_HOST, `/api/docs/${id}/public-link`, { method: "DELETE", bearer: owner.token })).status, 200);
  await expectRevoked(tab, "link", 500);
  assert.equal((await ask(liveHost(publicLabel), "/")).status, 302);
  const after = await addressFor(id, owner.token);
  assert.equal(after.access, "private");
  assert.equal(after.publicUrl, undefined);
  assert.equal(after.url, view.url);
  await openPrivate(labelOf(view.url), ownerCookie);
});

test("a public link to a document that is not a Live Doc keeps its usual page", async () => {
  const id = `h2-md-${stamp}`;
  await putDoc(owner.token, id, "Notes.md", "# Notes\n");
  const token = await makePublic(id);
  const res = await ask(APP_HOST, `/s/${token}`);
  assert.notEqual(res.status, 302);
  assert.equal(res.headers.get("location"), null);
});

// ── takedown ─────────────────────────────────────────────────────────────────

test("a taken-down Live Doc is hosted at no level, and comes back when restored", async () => {
  const id = `h2-takedown-${stamp}`;
  await putDoc(owner.token, id, "Takedown.wd", COUNTER);
  const token = await makePublic(id);
  const view = await addressFor(id, owner.token);
  const privateLabel = labelOf(view.url);
  const publicLabel = labelOf(view.publicUrl!);
  const cookie = await openPrivate(privateLabel, ownerCookie);
  const fast = createLiveDocs({ config: liveDocsConfig()!, appOrigin: APP_ORIGIN, siteUrl: "https://markie.test", recheckMs: 50 });
  const [url, init] = requestFor(liveHost(publicLabel), "/__markie/live");
  const tab = await openTab(fast.dispatch(new Request(url, init))!);
  await expectReady(tab);

  takeDownLiveDoc(id, "test");
  await expectRevoked(tab, "gone", 1_000);
  for (const [label, sent] of [[privateLabel, cookie], [publicLabel, undefined]] as const) {
    const res = await ask(liveHost(label), "/", sent ? { cookie: sent } : {});
    assert.equal(res.status, 410, label);
    assert.match(await res.text(), /taken down/);
  }
  assert.equal((await ask(APP_HOST, `/s/${token}`)).status, 410, "the public link does not fall back to the source page");
  assert.equal((await ask(APP_HOST, `/api/docs/${id}/live-doc`, { bearer: owner.token })).status, 410);
  assert.equal((await ask(APP_HOST, `/live-docs/pass/${privateLabel}`, { cookie: ownerCookie })).status, 404);

  assert.equal(restoreLiveDoc(id), true);
  assert.equal((await ask(liveHost(publicLabel), "/")).status, 200, "the same public address works again");
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
  await makePublic(id);
  const tab = await tabOn(labelOf((await addressFor(id, owner.token)).publicUrl!), { headers: { origin: "https://evil.test" } });
  await expectReady(tab);
  assert.equal(tab.res.headers.get("cache-control"), "private, no-store");
  assert.equal(tab.res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(tab.res.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(tab.res.headers.getSetCookie(), []);
  await tab.close();
});

test("one address cannot hold more than its share of open streams, and closing one frees it", async () => {
  const id = `h2-cap-${stamp}`;
  await putDoc(owner.token, id, "Cap.wd", COUNTER);
  await makePublic(id);
  const label = labelOf((await addressFor(id, owner.token)).publicUrl!);
  const before = openLiveDocChannels();
  const from = { headers: { "x-forwarded-for": "203.0.113.9" } };
  const tabs: Tab[] = [];
  for (let index = 0; index < LIVE_DOC_CHANNELS_PER_KEY; index++) {
    const tab = await tabOn(label, from);
    await expectReady(tab);
    tabs.push(tab);
  }
  assert.equal(openLiveDocChannels(), before + LIVE_DOC_CHANNELS_PER_KEY);
  const refused = await ask(liveHost(label), "/__markie/live", from);
  assert.equal(refused.status, 429, "busy, not revoked: the page backs off and retries");
  const other = await tabOn(label, { headers: { "x-forwarded-for": "203.0.113.10" } });
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
  const id = `h2-heavy-${stamp}`;
  await putDoc(owner.token, id, "Heavy.wd", COUNTER);
  await makePublic(id);
  const label = labelOf((await addressFor(id, owner.token)).publicUrl!);
  // 40 MB, written straight to the database: past every size the page will read.
  db.prepare("UPDATE docs SET content = ? WHERE id = ?").run(`# Heavy\n\n${"x".repeat(40 * 1024 * 1024)}`, id);
  let started = performance.now();
  const page = await ask(liveHost(label), "/");
  const pageMs = performance.now() - started;
  assert.equal(page.status, 422);
  assert.match(await page.text(), /200,000 characters/);
  const tabs = await Promise.all(Array.from({ length: 10 }, () => tabOn(label)));
  for (const tab of tabs) await expectReady(tab);
  started = performance.now();
  recheckLiveDocChannels(id);
  const checkMs = performance.now() - started;
  for (const tab of tabs) await tab.close();
  assert.ok(pageMs < 50, `the refused page held the event loop ${pageMs.toFixed(0)} ms`);
  assert.ok(checkMs < 20, `ten tabs' re-check held the event loop ${checkMs.toFixed(0)} ms`);
});

test("one IPv6 /64 is one client for public streams", async () => {
  assert.equal(liveDocClientKey("2001:db8:1:2::5"), liveDocClientKey("2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd"));
  assert.notEqual(liveDocClientKey("2001:db8:1:2::5"), liveDocClientKey("2001:db8:1:3::5"));
  assert.equal(liveDocClientKey("::ffff:203.0.113.9"), liveDocClientKey("203.0.113.9"));
  assert.equal(liveDocClientKey("[2001:db8:1:2::9]:443"), liveDocClientKey("2001:db8:1:2::1"));
  const id = `h2-v6-${stamp}`;
  await putDoc(owner.token, id, "V6.wd", COUNTER);
  await makePublic(id);
  const label = labelOf((await addressFor(id, owner.token)).publicUrl!);
  const tabs: Tab[] = [];
  for (let index = 1; index <= LIVE_DOC_CHANNELS_PER_KEY; index++) {
    const tab = await tabOn(label, { headers: { "x-forwarded-for": `2001:db8:1:2::${index.toString(16)}` } });
    await expectReady(tab);
    tabs.push(tab);
  }
  const extra = await ask(liveHost(label), "/__markie/live", { headers: { "x-forwarded-for": "2001:db8:1:2::ffff" } });
  assert.equal(extra.status, 429, "another address in the same /64 is the same client");
  for (const tab of tabs) await tab.close();
});

test("strangers on public pages cannot use up the streams members need", async () => {
  const { LIVE_DOC_PUBLIC_CHANNELS_PER_OWNER } = await import("./live-docs.ts");
  const id = `h2-pool-${stamp}`;
  await putDoc(owner.token, id, "Pool.wd", COUNTER);
  await share(id, viewer.email, "viewer");
  await makePublic(id);
  const view = await addressFor(id, owner.token);
  const publicLabel = labelOf(view.publicUrl!);
  // Fill the owner's public allowance from many clients.
  const tabs: Tab[] = [];
  for (let index = 0; index < LIVE_DOC_PUBLIC_CHANNELS_PER_OWNER; index++) {
    const tab = await tabOn(publicLabel, { headers: { "x-forwarded-for": `198.51.${Math.floor(index / 200)}.${index % 200}` } });
    assert.equal(tab.res.status, 200);
    tabs.push(tab);
  }
  assert.equal((await ask(liveHost(publicLabel), "/__markie/live", { headers: { "x-forwarded-for": "192.0.2.77" } })).status, 429, "one owner's public pages hold at most their share");
  // A member's own tab still gets its stream.
  const member = await tabOn(labelOf(view.url), { cookie: await openPrivate(labelOf(view.url), viewerCookie) });
  await expectReady(member);
  await member.close();
  for (const tab of tabs) await tab.close();
});

test("a taken-down Live Doc's public link serves none of its source or assets", async () => {
  const id = `h2-tdraw-${stamp}`;
  await putDoc(owner.token, id, "Abuse.wd", COUNTER);
  const token = await makePublic(id);
  takeDownLiveDoc(id, "review");
  try {
    for (const path of [`/s/${token}/raw`, `/s/${token}/assets`, `/s/${token}?view=1`]) {
      const res = await ask(APP_HOST, path);
      assert.notEqual(res.status, 200, path);
      assert.ok(!(await res.text()).includes("Counter"), path);
    }
  } finally {
    restoreLiveDoc(id);
  }
  assert.equal((await ask(APP_HOST, `/s/${token}/raw`)).status, 200, "restoring brings the link's source back");
});

test("a public page does not show a name that is just the owner's email address", async () => {
  const plain = await signUpVerified(app, { name: `h2-plain-${stamp}`, email: `h2-plain-${stamp}@example.com` });
  const id = `h2-name-${stamp}`;
  await putDoc(plain.token, id, "Name.wd", COUNTER);
  const made = await ask(APP_HOST, `/api/docs/${id}/public-link`, { method: "POST", bearer: plain.token });
  assert.equal(made.status, 200);
  const view = await addressFor(id, plain.token);
  assert.equal(view.publishedAs, "a Markie account", "the owner is told which name the page shows");
  const html = await (await ask(liveHost(labelOf(view.publicUrl!)), "/")).text();
  assert.match(html, /published with Markie by a Markie account\./);
  assert.ok(!html.includes(`h2-plain-${stamp}`));
});
