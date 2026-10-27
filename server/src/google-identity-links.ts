import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { IdentityError, type IdentityActor } from "./account-identities.ts";
import { reportRouteFault } from "./little-friend.ts";

export interface GoogleIdentityLinkOptions {
  db: Database.Database;
  secret: string;
  authOrigin: string;
  now?: () => number;
  authenticate(request: Request): Promise<IdentityActor | null> | IdentityActor | null;
  consumeStepUp(actor: IdentityActor, proofId: string, scope: "google-link"): unknown;
  /** Server-only adapter. Never return session tokens or primary session cookies. */
  beginOAuthLink(input: { sessionToken: string; callbackURL: string; headers: Headers }): Promise<{ url: string; stateCookies: string[] }>;
}
interface Intent {
  id: string; user_id: string; session_id: string; secret_hash: string; cookie_hash: string | null;
  state_hash: string | null; expires_at: number; created_at: number; started_at: number | null;
  completed_at: number | null; baseline: string; linked_account_id: string | null;
}
interface AuthContext { createdUsers: Set<string>; intentId?: string }
const invalid = (): never => { throw new IdentityError("invalid-google-link", 400); };
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[a-f0-9-]{36}$/;
const TTL = 10 * 60_000;
async function body(request: Request, keys: string[]): Promise<Record<string, string>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) invalid();
  const reader = request.body?.getReader(); if (!reader) invalid();
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader!.read(); if (part.done) break; size += part.value.length; if (size > 2048) invalid(); chunks.push(part.value); } }
  finally { await reader!.cancel().catch(() => {}); reader!.releaseLock(); }
  let value: unknown; try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch { invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => typeof (value as Record<string, unknown>)[key] !== "string" || !(value as Record<string, string>)[key] || (value as Record<string, string>)[key].length > 512)) invalid();
  return value as Record<string, string>;
}
/** Purpose-bound OAuth linking. Importing this module does not boot auth or a database. */
export function createGoogleIdentityLinks(options: GoogleIdentityLinkOptions) {
  const { db } = options, now = options.now ?? Date.now;
  const origin = new URL(options.authOrigin);
  if (origin.origin !== options.authOrigin || origin.username || origin.password || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname))) || Buffer.byteLength(options.secret) < 32) throw new Error("Invalid Google identity configuration");
  const hash = (purpose: string, value: string) => createHmac("sha256", options.secret).update(JSON.stringify([purpose, value])).digest("hex");
  const context = new AsyncLocalStorage<AuthContext>();
  db.exec(`CREATE TABLE IF NOT EXISTS account_google_link_intents (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT NOT NULL, secret_hash TEXT NOT NULL,
    cookie_hash TEXT, state_hash TEXT UNIQUE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
    started_at INTEGER, completed_at INTEGER, baseline TEXT NOT NULL, linked_account_id TEXT
  ); CREATE INDEX IF NOT EXISTS account_google_link_expiry ON account_google_link_intents(expires_at);`);
  // Auth hooks can yield between authorization and the adapter's actual INSERT.
  // Retain failed/expired write markers: deleting one could turn a delayed link
  // into an unmarked signup. Successful INSERTs alone consume their marker.
  db.exec(`CREATE TABLE IF NOT EXISTS account_google_link_writes (
    account_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, intent_id TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS account_google_link_write_fence BEFORE INSERT ON account
  WHEN NEW.providerId='google' AND EXISTS(SELECT 1 FROM account_google_link_writes WHERE account_id=NEW.id)
  BEGIN
    SELECT CASE WHEN NOT EXISTS(
      SELECT 1 FROM account_google_link_writes w
      JOIN account_google_link_intents i ON i.id=w.intent_id
      JOIN session s ON s.id=i.session_id AND s.userId=i.user_id
      JOIN user u ON u.id=i.user_id
      WHERE w.account_id=NEW.id AND w.user_id=NEW.userId AND i.user_id=NEW.userId
        AND i.state_hash IS NOT NULL AND i.started_at IS NOT NULL AND i.completed_at IS NULL
        AND u.emailVerified=1 AND i.expires_at>(julianday('now')-2440587.5)*86400000
        AND (CASE WHEN typeof(s.expiresAt) IN ('integer','real') THEN s.expiresAt
          ELSE CAST(strftime('%s',s.expiresAt) AS INTEGER)*1000 END)>(julianday('now')-2440587.5)*86400000
    ) THEN RAISE(ABORT,'google-link-authorization-expired') END;
  END;
  CREATE TRIGGER IF NOT EXISTS account_google_link_write_consumed AFTER INSERT ON account
  WHEN NEW.providerId='google'
  BEGIN DELETE FROM account_google_link_writes WHERE account_id=NEW.id; END;`);
  const find = (id: string) => db.prepare("SELECT * FROM account_google_link_intents WHERE id=?").get(id) as Intent | undefined;
  function live(intent: Intent | undefined): { token: string } {
    if (!intent || intent.expires_at <= now() || intent.completed_at !== null) invalid();
    const session = db.prepare('SELECT s.token,s.expiresAt,u.emailVerified FROM session s JOIN "user" u ON u.id=s.userId WHERE s.id=? AND s.userId=?').get(intent!.session_id, intent!.user_id) as { token: string; expiresAt: string | number; emailVerified: number } | undefined;
    const expiry = typeof session?.expiresAt === "number" ? session.expiresAt : Date.parse(session?.expiresAt ?? "");
    if (!session || session.emailVerified !== 1 || !Number.isFinite(expiry) || expiry <= now()) invalid();
    return session!;
  }
  const providerIds = (uid: string) => (db.prepare("SELECT id FROM account WHERE userId=? AND providerId='google' ORDER BY id").all(uid) as { id: string }[]).map((row) => row.id);
  const cookieName = (id: string) => `markie_google_link_${id}`;
  const cookie = (id: string, token: string, maxAge = 600) => `${cookieName(id)}=${token}; HttpOnly; SameSite=Lax; Path=/account/google-link; Max-Age=${maxAge}${origin.protocol === "https:" ? "; Secure" : ""}`;
  const failResponse = () => Response.json({ error: "invalid-google-link" }, { status: 400, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" } });
  const app = new Hono();
  app.use("*", async (c, next) => { c.header("Cache-Control", "private, no-store"); c.header("Referrer-Policy", "no-referrer"); await next(); });
  app.onError((error, c) => {
    if (error instanceof IdentityError) return c.json({ error: error.code }, error.status);
    reportRouteFault(error, c);
    return c.json({ error: "identity-unavailable" }, 503);
  });
  async function actor(request: Request) {
    const who = await options.authenticate(request);
    if (!who || who.emailVerified !== true) throw new IdentityError("identity-authentication-required", 401);
    return who;
  }
  app.post("/identities/google/start", async (c) => {
    const who = await actor(c.req.raw), input = await body(c.req.raw, ["proofId"]);
    const id = randomUUID(), secret = randomBytes(32).toString("base64url");
    db.transaction(() => {
      const consumed = options.consumeStepUp(who, input.proofId, "google-link");
      if (consumed && typeof (consumed as { then?: unknown }).then === "function") throw new IdentityError("identity-unavailable", 503);
      // Keep state tombstones a full day after expiry, so stale callbacks cannot become ordinary sign-ins.
      db.prepare("DELETE FROM account_google_link_intents WHERE expires_at<?").run(now() - 86_400_000);
      db.prepare("INSERT INTO account_google_link_intents(id,user_id,session_id,secret_hash,expires_at,created_at,baseline) VALUES(?,?,?,?,?,?,?)").run(id, who.userId, who.sessionId, hash("handoff", secret), now() + TTL, now(), JSON.stringify(providerIds(who.userId)));
      live(find(id));
    }).immediate();
    return c.json({ intentId: id, browserUrl: `${origin.origin}/account/link-google#${id}.${secret}` });
  });
  app.post("/identities/google/browser-start", async (c) => {
    if (c.req.header("origin") !== origin.origin) throw new IdentityError("invalid-google-link", 403);
    const input = await body(c.req.raw, ["intentId", "secret"]);
    if (!ID.test(input.intentId) || !TOKEN.test(input.secret)) invalid();
    const token = db.transaction(() => {
      const intent = find(input.intentId), session = live(intent);
      if (intent!.started_at !== null || intent!.secret_hash !== hash("handoff", input.secret)) invalid();
      if (db.prepare("UPDATE account_google_link_intents SET started_at=? WHERE id=? AND started_at IS NULL").run(now(), input.intentId).changes !== 1) invalid();
      return session.token;
    }).immediate();
    const complete = `${origin.origin}/account/google-link/complete?intentId=${input.intentId}`;
    const result = await options.beginOAuthLink({ sessionToken: token, callbackURL: complete, headers: new Headers({ origin: origin.origin }) });
    let url: URL; try { url = new URL(result.url); } catch { invalid(); }
    if (url!.origin !== "https://accounts.google.com" || url!.username || url!.password || url!.hash || url!.searchParams.getAll("state").length !== 1) invalid();
    const state = url!.searchParams.get("state"); if (!state || state.length > 1024) invalid();
    // Defense in depth: adapters cannot accidentally transplant a primary browser session.
    const cookies = result.stateCookies;
    if (!Array.isArray(cookies) || cookies.length > 8 || cookies.some((value) => typeof value !== "string" || value.length > 16384 || /[\r\n]/.test(value) || !/^(?:__Secure-)?better-auth\.(?:state|oauth_state)(?:\.\d+)?=/.test(value))) invalid();
    const flowSecret = randomBytes(32).toString("base64url");
    db.transaction(() => { live(find(input.intentId)); db.prepare("UPDATE account_google_link_intents SET state_hash=?,cookie_hash=? WHERE id=? AND state_hash IS NULL").run(hash("state", state!), hash("cookie", flowSecret), input.intentId); }).immediate();
    cookies.forEach((value) => c.header("Set-Cookie", value, { append: true }));
    c.header("Set-Cookie", cookie(input.intentId, flowSecret), { append: true });
    return c.json({ url: url!.toString() });
  });
  app.get("/identities/google/:intentId", async (c) => {
    const who = await actor(c.req.raw), intent = find(c.req.param("intentId"));
    if (!intent || intent.user_id !== who.userId || intent.session_id !== who.sessionId) invalid();
    return c.json({ intentId: intent.id, status: intent.completed_at !== null ? "complete" : intent.expires_at <= now() ? "expired" : "pending" });
  });
  const browserPage = () => new Response(`<!doctype html><html><head><meta name="referrer" content="no-referrer"><meta charset="utf-8"><title>Link Google to Markie</title></head><body><main><h1>Link Google to Markie</h1><p id="status">Preparing your secure account link…</p></main><script>
  (async()=>{const fragment=location.hash.slice(1);history.replaceState(null,'',location.pathname);const parts=fragment.split('.');if(parts.length!==2)throw Error();const response=await fetch('/api/account/identities/google/browser-start',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({intentId:parts[0],secret:parts[1]})});if(!response.ok)throw Error();const data=await response.json();const target=new URL(data.url);if(target.origin!=='https://accounts.google.com')throw Error();location.replace(target.href)})().catch(()=>{document.getElementById('status').textContent='This link is invalid or expired. Start again from Markie.'});
  </script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" } });
  function complete(request: Request): Response {
    try {
      const ids = new URL(request.url).searchParams.getAll("intentId"); if (ids.length !== 1 || !ID.test(ids[0])) invalid();
      const intent = find(ids[0]); live(intent);
      const values = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName(ids[0])}=`));
      const value = values.length === 1 ? values[0].slice(cookieName(ids[0]).length + 1) : "";
      if (!TOKEN.test(value) || intent!.cookie_hash !== hash("cookie", value) || !intent!.state_hash) invalid();
      const baseline = JSON.parse(intent!.baseline) as string[];
      if (!intent!.linked_account_id || baseline.includes(intent!.linked_account_id) || !providerIds(intent!.user_id).includes(intent!.linked_account_id)) invalid();
      db.prepare("UPDATE account_google_link_intents SET completed_at=? WHERE id=? AND completed_at IS NULL").run(now(), ids[0]);
      return new Response("Google account linked. You can close this tab and return to Markie.", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store", "referrer-policy": "no-referrer", "set-cookie": cookie(ids[0], "", 0) } });
    } catch { return failResponse(); }
  }
  async function runAuthRequest(request: Request, run: () => Promise<Response>): Promise<Response> {
    const url = new URL(request.url), current: AuthContext = { createdUsers: new Set() };
    if (/\/callback\/google\/?$/.test(url.pathname)) {
      if (url.searchParams.getAll("state").length > 1) return failResponse();
      let state: string | null = url.searchParams.get("state");
      if (request.method === "POST") {
        try { const form = await request.clone().formData(); if (form.getAll("state").length > 1) return failResponse(); const value = form.get("state"); state ||= typeof value === "string" ? value : null; } catch { return failResponse(); }
      }
      if (state && state.length <= 1024) {
        const intent = db.prepare("SELECT * FROM account_google_link_intents WHERE state_hash=?").get(hash("state", state)) as Intent | undefined;
        if (intent) { try { live(intent); } catch { return failResponse(); } current.intentId = intent.id; }
      }
    }
    return context.run(current, run);
  }
  function assertGoogleAccountMutation(uid: string) {
    const current = context.getStore();
    if (current?.intentId) { const intent = find(current.intentId); live(intent); if (intent!.user_id !== uid) invalid(); }
  }
  function assertGoogleAccountCreation(uid: string) {
    const current = context.getStore();
    if (current?.intentId) { assertGoogleAccountMutation(uid); return; }
    if (!current?.createdUsers.has(uid)) invalid();
  }
  function noteGoogleAccountCreated(uid: string, accountId: string) {
    const current = context.getStore();
    if (!current?.intentId) return;
    assertGoogleAccountCreation(uid);
    if (!providerIds(uid).includes(accountId)) invalid();
    db.prepare("UPDATE account_google_link_intents SET linked_account_id=? WHERE id=?").run(accountId, current.intentId);
  }
  function authorizeGoogleAccountCreation(uid: string, accountId: string) {
    assertGoogleAccountCreation(uid);
    if (typeof accountId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(accountId)) invalid();
    const current = context.getStore();
    if (!current?.intentId) return;
    // No replace/upsert: a marker is bound to its original intent until the
    // exact authorized write succeeds, including across process restarts.
    db.prepare("INSERT INTO account_google_link_writes(account_id,user_id,intent_id) VALUES(?,?,?)").run(accountId, uid, current.intentId);
  }
  return { app, browserPage, complete, runAuthRequest, assertGoogleAccountCreation, assertGoogleAccountMutation, authorizeGoogleAccountCreation, noteGoogleAccountCreated,
    noteCreatedUser(uid: string) { context.getStore()?.createdUsers.add(uid); } };
}
