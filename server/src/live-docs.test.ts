// Hosted Live Docs, end to end through the real app: the owner opens their
// private Live Doc through the pass, and every way around it is refused.
// Requests carry the Host header a browser would send, because which host a
// request is for is the whole feature.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-live-docs-")), "t.db");
// The app on 127.0.0.1 and Live Docs under live.localhost, so no app cookie
// could ever be scoped to a Live Doc's host (live-docs-config.ts).
process.env.BETTER_AUTH_URL = "http://127.0.0.1:8787";
process.env.BETTER_AUTH_SECRET = "markie-live-docs-test-secret-32-plus-chars";
process.env.MARKIE_SITE_URL = "https://markie.test";
process.env.LIVE_DOCS_DOMAIN = "live.localhost:8787";
process.env.MARKIE_NO_LISTEN = "1";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();

const { app, liveDocs } = await import("./index.ts");
const { issueLiveDocTicket, liveDocLabel, LIVE_DOC_TICKET_TTL_MS } = await import("./live-docs-store.ts");
const Database = (await import("better-sqlite3")).default;
const db = new Database(process.env.DB_PATH);
after(() => db.close());

assert.ok(liveDocs, "LIVE_DOCS_DOMAIN is set, so Live Docs are on");

const APP_HOST = "127.0.0.1:8787";
const APP_ORIGIN = `http://${APP_HOST}`;
const liveHost = (label: string) => `${label}.live.localhost:8787`;
const liveOrigin = (label: string) => `http://${liveHost(label)}`;
const COOKIE = "__Host-markie-live";

let callers = 0;
interface Ask {
  cookie?: string;
  bearer?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}
async function ask(host: string, path: string, init: Ask = {}): Promise<Response> {
  callers += 1;
  const headers = new Headers(init.headers);
  headers.set("host", host);
  headers.set("x-forwarded-for", `10.66.${Math.floor(callers / 250) % 250}.${callers % 250}`);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return app.request(`http://${host}${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const b64sha = (text: string) => createHash("sha256").update(text, "utf8").digest("base64");

async function putDoc(token: string, id: string, name: string, content: string, baseVersion = 0) {
  const res = await ask(APP_HOST, `/api/docs/${id}`, { method: "PUT", bearer: token, body: { name, content, hash: sha(content), baseVersion } });
  assert.equal(res.status, 200, `PUT ${name}: ${await res.clone().text()}`);
}

/** A browser session on the app host: the cookie better-auth sets on sign-in. */
async function browserSignIn(email: string): Promise<string> {
  const res = await ask(APP_HOST, "/api/auth/sign-in/email", {
    method: "POST",
    headers: { origin: "http://localhost:3000" },
    body: { email, password: "password-123" },
  });
  assert.equal(res.status, 200);
  const cookies = res.headers.getSetCookie().map((line) => line.split(";")[0]);
  const session = cookies.find((value) => value.startsWith("better-auth.session_token="));
  assert.ok(session, "sign-in sets the session cookie");
  return session;
}

async function addressOf(docId: string, token: string): Promise<{ url: string; label: string }> {
  const res = await ask(APP_HOST, `/api/docs/${docId}/live-doc`, { bearer: token });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { url: string };
  const match = /^http:\/\/([a-z2-7]{16})\.live\.localhost:8787\/$/.exec(body.url);
  assert.ok(match, `a Live Doc address: ${body.url}`);
  return { url: body.url, label: match[1] };
}

/** The pass the app host hands a signed-in browser for `label`. */
async function passFor(label: string, appCookie: string): Promise<string> {
  const res = await ask(APP_HOST, `/live-docs/pass/${label}`, { cookie: appCookie });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location")!);
  assert.equal(location.origin, liveOrigin(label));
  assert.equal(location.pathname, "/__markie/pass");
  const ticket = location.searchParams.get("ticket");
  assert.ok(ticket);
  return ticket;
}

/** Redeem a pass on `label`'s host; the Live Doc cookie, or null when refused. */
async function redeem(label: string, ticket: string): Promise<{ res: Response; cookie: string | null }> {
  const res = await ask(liveHost(label), `/__markie/pass?ticket=${encodeURIComponent(ticket)}`);
  const line = res.headers.getSetCookie().find((value) => value.startsWith(`${COOKIE}=`) && !value.startsWith(`${COOKIE}=;`));
  return { res, cookie: line ? line.split(";")[0] : null };
}

async function openLiveDoc(label: string, appCookie: string): Promise<string> {
  const { res, cookie } = await redeem(label, await passFor(label, appCookie));
  assert.equal(res.status, 303);
  assert.ok(cookie);
  return cookie;
}

const COUNTER = ':state count = 0\n\n# Counter\n\nCount: { count }.\n\n:button "Add one" -> count++\n';

const stamp = Date.now();
const owner = await signUpVerified(app, { name: "Owner", email: `live-owner-${stamp}@example.com` });
const stranger = await signUpVerified(app, { name: "Stranger", email: `live-stranger-${stamp}@example.com` });
const ownerCookie = await browserSignIn(owner.email);
const strangerCookie = await browserSignIn(stranger.email);

const docA = `live-a-${stamp}`;
const docB = `live-b-${stamp}`;
await putDoc(owner.token, docA, "Counter.wd", COUNTER);
await putDoc(owner.token, docB, "Other.wd", ":state n = 7\n\nOther doc { n }\n");
const { label: labelA } = await addressOf(docA, owner.token);
const { label: labelB } = await addressOf(docB, owner.token);

// ── the address ──────────────────────────────────────────────────────────────

test("a Live Doc's address is a stable random label, not derived from the doc id", async () => {
  assert.notEqual(labelA, labelB);
  assert.match(labelA, /^[a-z2-7]{16}$/, "16 base32 characters is 80 bits");
  assert.ok(!labelA.includes(docA) && !docA.includes(labelA));
  assert.equal((await addressOf(docA, owner.token)).label, labelA, "the same address every time");
  assert.equal(liveDocLabel(docA), labelA);
});

test("only the owner gets the address, and only for a .wd", async () => {
  assert.equal((await ask(APP_HOST, `/api/docs/${docA}/live-doc`)).status, 401);
  const stranger404 = await ask(APP_HOST, `/api/docs/${docA}/live-doc`, { bearer: stranger.token });
  assert.equal(stranger404.status, 404);
  assert.deepEqual(await stranger404.json(), { error: "not_found" });
  const missing = await ask(APP_HOST, `/api/docs/no-such-doc-${stamp}/live-doc`, { bearer: stranger.token });
  assert.deepEqual(await missing.json(), { error: "not_found" }, "the same answer as a doc that exists");
  const markdown = `live-md-${stamp}`;
  await putDoc(owner.token, markdown, "Notes.md", "# Notes\n");
  const res = await ask(APP_HOST, `/api/docs/${markdown}/live-doc`, { bearer: owner.token });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_a_live_doc" });
  assert.equal(liveDocLabel(markdown), null, "no address is handed out for a document that is not a Live Doc");
});

test("a shared editor is not the owner, so H1 gives them no address and no pass", async () => {
  const shared = `live-shared-${stamp}`;
  await putDoc(owner.token, shared, "Shared.wd", COUNTER);
  const res = await ask(APP_HOST, `/api/docs/${shared}/shares`, { method: "POST", bearer: owner.token, body: { email: stranger.email, role: "editor" } });
  assert.equal(res.status, 200);
  assert.equal((await ask(APP_HOST, `/api/docs/${shared}/live-doc`, { bearer: stranger.token })).status, 404);
  const { label } = await addressOf(shared, owner.token);
  assert.equal((await ask(APP_HOST, `/live-docs/pass/${label}`, { cookie: strangerCookie })).status, 404);
});

// ── the pass flow ────────────────────────────────────────────────────────────

test("the owner opens their private Live Doc through the pass", async () => {
  // 1. No cookie on the live host: to the app host, carrying only the label.
  const first = await ask(liveHost(labelA), "/");
  assert.equal(first.status, 302);
  assert.equal(first.headers.get("location"), `${APP_ORIGIN}/live-docs/pass/${labelA}`);

  // 2. Signed in on the app host: a pass, sent to the label stored for the doc.
  const pass = await ask(APP_HOST, `/live-docs/pass/${labelA}`, { cookie: ownerCookie });
  assert.equal(pass.status, 302);
  assert.match(pass.headers.get("cache-control") ?? "", /no-store/);
  const target = new URL(pass.headers.get("location")!);
  assert.equal(`${target.origin}${target.pathname}`, `${liveOrigin(labelA)}/__markie/pass`);
  assert.deepEqual([...target.searchParams.keys()], ["ticket"]);
  const ticket = target.searchParams.get("ticket")!;
  assert.ok(ticket.length >= 43, "32 random bytes");
  const stored = db.prepare("SELECT ticket_hash, doc_id, user_id, label, expires_at - issued_at AS ttl FROM live_doc_tickets WHERE doc_id = ?").all(docA) as Array<{ ticket_hash: string; doc_id: string; user_id: string; label: string; ttl: number }>;
  assert.ok(stored.some((row) => row.ticket_hash === sha(ticket) && row.user_id === owner.id && row.label === labelA && row.ttl === 60_000));
  assert.ok(!stored.some((row) => row.ticket_hash === ticket), "only the hash is stored");

  // 3. The live host spends it: a host-only __Host- cookie, then `/`.
  const redeemed = await ask(liveHost(labelA), `/__markie/pass?ticket=${encodeURIComponent(ticket)}`);
  assert.equal(redeemed.status, 303);
  assert.equal(redeemed.headers.get("location"), "/");
  const setCookie = redeemed.headers.getSetCookie();
  assert.equal(setCookie.length, 1);
  const [pair, ...attributes] = setCookie[0].split(";").map((part) => part.trim());
  assert.match(pair, /^__Host-markie-live=[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(attributes.sort(), ["HttpOnly", "Max-Age=43200", "Path=/", "SameSite=Lax", "Secure"].sort());
  assert.ok(!/domain=/i.test(setCookie[0]), "no Domain attribute: host-only");
  const cookieValue = pair.slice(`${COOKIE}=`.length);
  const session = db.prepare("SELECT doc_id, user_id, label FROM live_doc_sessions WHERE session_hash = ?").get(sha(cookieValue));
  assert.deepEqual(session, { doc_id: docA, user_id: owner.id, label: labelA });

  // 4. The page.
  const page = await ask(liveHost(labelA), "/", { cookie: pair });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
  const html = await page.text();
  assert.match(html, /<h1>Counter<\/h1>/);
  assert.match(html, /data-wd-bind="count"/);
  assert.match(html, /<script type="application\/json" data-wd-state>\{"count":0\}<\/script>/);
  assert.ok(!html.includes(owner.email), "the page names no account");
});

test("a signed-out visitor is sent to the Markie sign-in, and back to the pass after it", async () => {
  const res = await ask(APP_HOST, `/live-docs/pass/${labelA}`);
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location")!);
  assert.equal(location.origin, APP_ORIGIN);
  assert.equal(location.pathname, "/auth/web-signin");
  assert.equal(location.searchParams.get("next"), `/live-docs/pass/${labelA}`);
  // The sign-in page itself, which keeps that next.
  const page = await ask(APP_HOST, `${location.pathname}${location.search}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), new RegExp(`"/live-docs/pass/${labelA}"`));
  // A label that does not exist gets the same answer, so a visitor learns nothing.
  const unknown = await ask(APP_HOST, "/live-docs/pass/aaaaaaaaaaaaaaaa");
  assert.equal(unknown.status, 302);
  assert.match(unknown.headers.get("location")!, /\/auth\/web-signin\?next=%2Flive-docs%2Fpass%2Faaaaaaaaaaaaaaaa$/);
  // Signed in already: the sign-in page goes straight back to the pass.
  const again = await ask(APP_HOST, `${location.pathname}${location.search}`, { cookie: ownerCookie });
  assert.equal(again.status, 302);
  assert.equal(again.headers.get("location"), `/live-docs/pass/${labelA}`);
});

test("a signed-in stranger is refused, and never gets a pass", async () => {
  const res = await ask(APP_HOST, `/live-docs/pass/${labelA}`, { cookie: strangerCookie });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("location"), null);
  const body = await res.text();
  assert.match(body, /This account can&#39;t open this Live Doc/);
  assert.match(body, /switch=1/, "offers a different account");
  assert.ok(!body.includes("Counter"), "names nothing about the document");
  const tickets = db.prepare("SELECT COUNT(*) AS n FROM live_doc_tickets WHERE user_id = ?").get(stranger.id) as { n: number };
  assert.equal(tickets.n, 0);
  // A Bearer token is the same person as the cookie.
  assert.equal((await ask(APP_HOST, `/live-docs/pass/${labelA}`, { bearer: stranger.token })).status, 404);
  // An unknown label answers the same as someone else's.
  const unknown = await ask(APP_HOST, "/live-docs/pass/aaaaaaaaaaaaaaaa", { cookie: strangerCookie });
  assert.equal(unknown.status, 404);
  assert.equal(await unknown.text(), body.replace(new RegExp(labelA, "g"), "aaaaaaaaaaaaaaaa"));
});

test("a ticket works once: replay fails", async () => {
  const ticket = await passFor(labelA, ownerCookie);
  assert.ok((await redeem(labelA, ticket)).cookie);
  const replay = await redeem(labelA, ticket);
  assert.equal(replay.res.status, 403);
  assert.equal(replay.cookie, null);
  assert.equal(replay.res.headers.getSetCookie().length, 0);
});

test("two redeems racing with one ticket: exactly one wins", async () => {
  const ticket = await passFor(labelA, ownerCookie);
  const results = await Promise.all([redeem(labelA, ticket), redeem(labelA, ticket), redeem(labelA, ticket)]);
  assert.equal(results.filter((r) => r.cookie).length, 1);
});

test("an expired ticket fails", async () => {
  const sessionId = (await auth.api.getSession({ headers: new Headers({ cookie: ownerCookie }) }))!.session.id;
  const binding = { docId: docA, userId: owner.id, authSessionId: sessionId, label: labelA };
  const stale = issueLiveDocTicket(binding, Date.now() - LIVE_DOC_TICKET_TTL_MS - 1000)!;
  const res = await redeem(labelA, stale.ticket);
  assert.equal(res.res.status, 403);
  assert.equal(res.cookie, null);
  // And one still inside its minute works, so the refusal above was the clock.
  const fresh = issueLiveDocTicket(binding, Date.now() - LIVE_DOC_TICKET_TTL_MS + 5000)!;
  assert.ok((await redeem(labelA, fresh.ticket)).cookie);
});

test("a ticket for doc A cannot open doc B, and is burned by trying", async () => {
  const ticket = await passFor(labelA, ownerCookie);
  const wrongHost = await redeem(labelB, ticket);
  assert.equal(wrongHost.res.status, 403);
  assert.equal(wrongHost.cookie, null);
  assert.equal((await redeem(labelA, ticket)).cookie, null, "shown to the wrong host, it opens nothing afterwards");
});

test("a ticket stops working when the Markie sign-in behind it ends", async () => {
  const cookie = await browserSignIn(owner.email);
  const ticket = await passFor(labelA, cookie);
  const out = await ask(APP_HOST, "/api/auth/sign-out", { method: "POST", cookie, headers: { origin: "http://localhost:3000" }, body: {} });
  assert.equal(out.status, 200);
  assert.equal((await redeem(labelA, ticket)).cookie, null);
});

test("a cookie minted for A's host does not open B", async () => {
  const cookieA = await openLiveDoc(labelA, ownerCookie);
  assert.equal((await ask(liveHost(labelA), "/", { cookie: cookieA })).status, 200);
  const onB = await ask(liveHost(labelB), "/", { cookie: cookieA });
  assert.equal(onB.status, 302);
  assert.equal(onB.headers.get("location"), `${APP_ORIGIN}/live-docs/pass/${labelB}`);
  assert.ok(!(await onB.text()).includes("Other doc"));
});

test("a made-up cookie value opens nothing", async () => {
  const res = await ask(liveHost(labelA), "/", { cookie: `${COOKIE}=${"A".repeat(43)}` });
  assert.equal(res.status, 302);
  assert.match(res.headers.getSetCookie()[0] ?? "", /^__Host-markie-live=; Path=\/; Max-Age=0/);
});

test("the Live Doc cookie is not a Markie session, and the Markie session is not a Live Doc cookie", async () => {
  const cookieA = await openLiveDoc(labelA, ownerCookie);
  const me = await ask(APP_HOST, "/api/me", { cookie: cookieA });
  assert.deepEqual(await me.json(), { user: null });
  const page = await ask(liveHost(labelA), "/", { cookie: ownerCookie });
  assert.equal(page.status, 302, "the app's session cookie opens no Live Doc");
});

// ── host separation ──────────────────────────────────────────────────────────

test("app, API and auth routes are a 404 on a live host", async () => {
  const cookieA = await openLiveDoc(labelA, ownerCookie);
  for (const [method, path] of [
    ["GET", "/api/me"], ["GET", "/api/docs"], ["GET", `/api/docs/${docA}`], ["GET", `/api/docs/${docA}/live-doc`],
    ["GET", "/health"], ["GET", "/api/server-info"], ["GET", `/d/${docA}`], ["GET", "/auth/web-signin"],
    ["GET", `/live-docs/pass/${labelA}`], ["GET", "/download"], ["GET", "/.well-known/apple-app-site-association"],
    ["POST", "/api/auth/sign-in/email"], ["GET", "/api/auth/get-session"], ["POST", "/"], ["GET", "/index.html"],
  ] as const) {
    const res = await ask(liveHost(labelA), path, { method, cookie: `${cookieA}; ${ownerCookie}`, bearer: owner.token, headers: { origin: "http://localhost:3000" }, ...(method === "POST" ? { body: { email: owner.email, password: "password-123" } } : {}) });
    assert.equal(res.status, 404, `${method} ${path} on a live host`);
    assert.equal(res.headers.get("access-control-allow-origin"), null, `${path}: no CORS grant`);
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
    assert.equal(res.headers.getSetCookie().length, 0, `${path}: no cookie`);
    assert.ok(!(await res.text()).includes(owner.email));
  }
});

test("Live Doc routes are a 404 on the app host, and it never serves a Live Doc page", async () => {
  const ticket = await passFor(labelA, ownerCookie);
  const res = await ask(APP_HOST, `/__markie/pass?ticket=${encodeURIComponent(ticket)}`);
  assert.equal(res.status, 404);
  assert.equal(res.headers.getSetCookie().length, 0);
  assert.ok((await redeem(labelA, ticket)).cookie, "the app host did not spend the pass");
  const cookieA = await openLiveDoc(labelA, ownerCookie);
  const root = await ask(APP_HOST, "/", { cookie: cookieA });
  const { LIVE_DOC_CSP } = await import("./live-docs-page.ts");
  assert.notEqual(root.headers.get("content-security-policy"), LIVE_DOC_CSP);
  assert.ok(!(await root.text()).includes("data-wd-bind"));
});

test("a request whose Host and X-Forwarded-Host disagree is refused", async () => {
  const cookieA = await openLiveDoc(labelA, ownerCookie);
  const crossed = await ask(liveHost(labelA), "/", { cookie: cookieA, headers: { "x-forwarded-host": APP_HOST } });
  assert.equal(crossed.status, 404);
  const other = await ask(APP_HOST, "/api/me", { cookie: ownerCookie, headers: { "x-forwarded-host": liveHost(labelA) } });
  assert.equal(other.status, 404, "the app is not reachable by naming a live host in either header");
  const twoLabels = await ask(liveHost(labelA), "/", { cookie: cookieA, headers: { "x-forwarded-host": liveHost(labelB) } });
  assert.equal(twoLabels.status, 404);
  const agreeing = await ask(liveHost(labelA), "/", { cookie: cookieA, headers: { "x-forwarded-host": liveHost(labelA) } });
  assert.equal(agreeing.status, 200);
});

test("other names under the live domain are a 404, never the app", async () => {
  for (const host of ["www.live.localhost:8787", "api.live.localhost:8787", "short.live.localhost:8787", `x.${liveHost(labelA)}`, `${labelA}.live.localhost:9999`, `${labelA}.live.localhost`]) {
    const res = await ask(host, "/api/me", { cookie: ownerCookie });
    assert.equal(res.status, 404, host);
    assert.equal(res.headers.getSetCookie().length, 0);
  }
});

test("the bare live domain redirects to Markie and sets no cookie", async () => {
  const res = await ask("live.localhost:8787", "/", { cookie: ownerCookie });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "https://markie.test");
  assert.equal(res.headers.getSetCookie().length, 0);
  assert.equal((await ask("live.localhost:8787", "/api/me")).status, 404);
});

test("the redirect to the live host cannot be pointed anywhere else", async () => {
  for (const extra of ["?next=https://evil.test/", "?label=bbbbbbbbbbbbbbbb", "?host=evil.test"]) {
    const res = await ask(APP_HOST, `/live-docs/pass/${labelA}${extra}`, { cookie: ownerCookie, headers: { "x-forwarded-host": "evil.test" } });
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.get("location")!).origin, liveOrigin(labelA), extra);
  }
  for (const bad of ["evil.test", `${labelA}.evil.test`, `${labelA}%2F..%2F..`, "AAAAAAAAAAAAAAAA", `${labelA}a`, "a".repeat(15)]) {
    const res = await ask(APP_HOST, `/live-docs/pass/${bad}`, { cookie: ownerCookie });
    assert.equal(res.status, 404, bad);
    assert.equal(res.headers.get("location"), null);
  }
  // The live host sends a visitor only to the configured app origin.
  const res = await ask(liveHost(labelA), "/", { headers: { referer: "https://evil.test/", origin: "https://evil.test" } });
  assert.equal(res.headers.get("location"), `${APP_ORIGIN}/live-docs/pass/${labelA}`);
  // The web sign-in's next accepts the pass path and nothing shaped like it.
  const { safeNext } = await import("./web-signin.ts");
  assert.equal(safeNext(`/live-docs/pass/${labelA}`), `/live-docs/pass/${labelA}`);
  for (const bad of [`//evil.test/live-docs/pass/${labelA}`, `/live-docs/pass/${labelA}/../x`, `/live-docs/pass/${labelA}?x`, "/live-docs/pass/", `https://evil.test/live-docs/pass/${labelA}`]) {
    assert.equal(safeNext(bad), "/", bad);
  }
});

// ── every load re-checks ─────────────────────────────────────────────────────

test("deleting the doc refuses an existing cookie on the next load", async () => {
  const id = `live-del-${stamp}`;
  await putDoc(owner.token, id, "Gone.wd", COUNTER);
  const { label } = await addressOf(id, owner.token);
  const cookie = await openLiveDoc(label, ownerCookie);
  assert.equal((await ask(liveHost(label), "/", { cookie })).status, 200);
  assert.equal((await ask(APP_HOST, `/api/docs/${id}`, { method: "DELETE", bearer: owner.token })).status, 200);
  const res = await ask(liveHost(label), "/", { cookie });
  assert.equal(res.status, 302);
  assert.match(res.headers.getSetCookie()[0] ?? "", /^__Host-markie-live=; /, "the dead cookie is cleared");
  assert.ok(!(await res.text()).includes("Counter"));
  assert.equal((await ask(APP_HOST, `/live-docs/pass/${label}`, { cookie: ownerCookie })).status, 404);
  for (const table of ["live_doc_addresses", "live_doc_tickets", "live_doc_sessions"]) {
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE doc_id = ?`).get(id) as { n: number }).n, 0, table);
  }
});

test("a deleted doc refuses on the next load even with its cookie row still in place", async () => {
  // The per-load check alone, without the delete route's cleanup.
  const id = `live-tomb-${stamp}`;
  await putDoc(owner.token, id, "Tomb.wd", COUNTER);
  const { label } = await addressOf(id, owner.token);
  const cookie = await openLiveDoc(label, ownerCookie);
  db.prepare("UPDATE docs SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  assert.equal((await ask(liveHost(label), "/", { cookie })).status, 302);
});

test("a doc renamed away from .wd stops being a Live Doc on the next load", async () => {
  const id = `live-rename-${stamp}`;
  await putDoc(owner.token, id, "Page.wd", COUNTER);
  const { label } = await addressOf(id, owner.token);
  const cookie = await openLiveDoc(label, ownerCookie);
  await putDoc(owner.token, id, "Page.md", COUNTER, 1);
  assert.equal((await ask(liveHost(label), "/", { cookie })).status, 302);
});

test("signing out of Markie refuses the Live Doc cookie on the next load", async () => {
  const appCookie = await browserSignIn(owner.email);
  const cookie = await openLiveDoc(labelA, appCookie);
  assert.equal((await ask(liveHost(labelA), "/", { cookie })).status, 200);
  await ask(APP_HOST, "/api/auth/sign-out", { method: "POST", cookie: appCookie, headers: { origin: "http://localhost:3000" }, body: {} });
  assert.equal((await ask(liveHost(labelA), "/", { cookie })).status, 302);
});

test("an edit shows on the next load, compiled once per version", async () => {
  const id = `live-edit-${stamp}`;
  await putDoc(owner.token, id, "Edit.wd", "# First\n");
  const { label } = await addressOf(id, owner.token);
  const cookie = await openLiveDoc(label, ownerCookie);
  const before = liveDocs!.compiler.workersStarted();
  assert.match(await (await ask(liveHost(label), "/", { cookie })).text(), /<h1>First<\/h1>/);
  assert.match(await (await ask(liveHost(label), "/", { cookie })).text(), /<h1>First<\/h1>/);
  assert.equal(liveDocs!.compiler.workersStarted() - before, 1, "the second load came from the cache");
  await putDoc(owner.token, id, "Edit.wd", "# Second\n", 1);
  assert.match(await (await ask(liveHost(label), "/", { cookie })).text(), /<h1>Second<\/h1>/);
});

test("a source the host refuses shows a plain notice, never the source", async () => {
  const id = `live-include-${stamp}`;
  await putDoc(owner.token, id, "Inc.wd", "@include /other.wd\n");
  const { label } = await addressOf(id, owner.token);
  const cookie = await openLiveDoc(label, ownerCookie);
  const res = await ask(liveHost(label), "/", { cookie });
  assert.equal(res.status, 422);
  const html = await res.text();
  assert.match(html, /Included files are not available/);
  assert.ok(!html.includes("<script"), "a notice runs no script");
});

test("authored script, style, links and network never survive into the hosted page", async () => {
  const id = `live-hostile-${stamp}`;
  const source = [
    "# Hostile",
    "",
    "<script>alert(1)</script>",
    '<img src="https://evil.test/x.png" onerror="alert(1)">',
    '<a href="javascript:alert(1)">x</a>',
    "<style>body{background:url(https://evil.test/)}</style>",
    '<iframe src="https://evil.test"></iframe>',
    ':fetch roster from "https://evil.test/r"',
    ":state n = 0 persist",
    "",
    "{ n }",
    "",
  ].join("\n");
  await putDoc(owner.token, id, "Hostile.wd", source);
  const { label } = await addressOf(id, owner.token);
  const cookie = await openLiveDoc(label, ownerCookie);
  const res = await ask(liveHost(label), "/", { cookie });
  assert.equal(res.status, 200);
  const html = await res.text();
  const scripts = [...html.matchAll(/<script(?: [^>]*)?>/g)].map((match) => match[0]);
  assert.deepEqual(scripts.filter((tag) => tag !== '<script type="application/json" data-wd-state>'), ["<script>", "<script>"], "only the runtime and its bootstrap");
  // Darkmown escapes authored HTML into text, so what is left to check is the
  // markup itself: which elements exist and which attributes they carry.
  const tags = [...html.matchAll(/<([a-zA-Z][\w-]*)([^>]*)>/g)];
  const names = new Set(tags.map((match) => match[1].toLowerCase()));
  for (const banned of ["img", "iframe", "a", "object", "embed", "link", "base", "form", "svg", "math", "video", "audio"]) {
    assert.ok(!names.has(banned), `<${banned}> survived`);
  }
  assert.equal(tags.filter((match) => match[1] === "style").length, 1, "only the page's own style block");
  for (const [tag] of tags) assert.ok(!/\s(on\w+|href|src|style|action|formaction|srcdoc)=/i.test(tag), tag);
  assert.match(html, /&#x3C;script>alert\(1\)&#x3C;\/script>/, "the authored script is shown as text, not run");
});

// ── headers ──────────────────────────────────────────────────────────────────

const generated = (name: string) => readFileSync(new URL(`./generated/darkmown/${name}`, import.meta.url), "utf8");
const policy = JSON.parse(generated("runtime-policy.json")) as { runtimeSha256: string; bootstrapSha256: string };
const PAGE_STYLE = `:root{color-scheme:light dark}${generated("preview-style.css")}`;
const EXPECTED_CSP =
  "default-src 'none'; " +
  `script-src 'sha256-${policy.runtimeSha256}' 'sha256-${policy.bootstrapSha256}'; ` +
  "script-src-attr 'none'; " +
  `style-src 'sha256-${b64sha(PAGE_STYLE)}'; ` +
  "img-src 'none'; media-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; worker-src 'none'; " +
  "manifest-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const EXPECTED_HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "x-robots-tag": "noindex, nofollow",
  "cache-control": "private, no-store",
};

function assertLiveHeaders(res: Response, what: string) {
  for (const [name, value] of Object.entries(EXPECTED_HEADERS)) assert.equal(res.headers.get(name), value, `${what}: ${name}`);
  const csp = res.headers.get("content-security-policy") ?? "";
  for (const directive of ["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]) {
    assert.ok(csp.split("; ").includes(directive), `${what}: ${directive}`);
  }
  assert.ok(!/unsafe-inline|unsafe-eval|'self'|\*|https?:/.test(csp), `${what}: nothing loose in ${csp}`);
}

test("the hosted page carries exactly this CSP and header set", async () => {
  assert.equal(b64sha(generated("runtime.js.txt")), policy.runtimeSha256, "the runtime is the one the policy pins");
  assert.equal(b64sha(generated("local-form-bootstrap.js.txt")), policy.bootstrapSha256);
  const cookie = await openLiveDoc(labelA, ownerCookie);
  const res = await ask(liveHost(labelA), "/", { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-security-policy"), EXPECTED_CSP);
  assertLiveHeaders(res, "page");
  const html = await res.text();
  // Each inline script and the style block is exactly what its hash names.
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => b64sha(match[1]));
  assert.deepEqual(inline, [policy.runtimeSha256, policy.bootstrapSha256]);
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
  assert.equal(style, PAGE_STYLE);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("every other live-host response carries the same headers and a script-free CSP", async () => {
  const ticket = await passFor(labelA, ownerCookie);
  const responses: Array<[string, Response]> = [
    ["redirect to pass", await ask(liveHost(labelA), "/")],
    ["redeem", await ask(liveHost(labelA), `/__markie/pass?ticket=${encodeURIComponent(ticket)}`)],
    ["refused redeem", await ask(liveHost(labelA), "/__markie/pass?ticket=nope")],
    ["404", await ask(liveHost(labelA), "/api/me")],
    ["apex", await ask("live.localhost:8787", "/")],
    ["other name", await ask("www.live.localhost:8787", "/")],
  ];
  for (const [what, res] of responses) {
    assertLiveHeaders(res, what);
    assert.ok(!(res.headers.get("content-security-policy") ?? "").includes("script-src"), `${what}: no script allowed`);
  }
});
