import type Database from "better-sqlite3";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { auth } from "./auth.ts";
import { configureAccountContext } from "./account-context.ts";
import { createIdentityStore, resolveVerifiedUserForEmail, activeVerifiedEmails, type IdentityActor } from "./account-identities.ts";
import { createAccountIdentitiesApi } from "./account-identities-api.ts";
import { createGoogleIdentityLinks } from "./google-identity-links.ts";
import { createCloudAreasApi, type CloudAreasStore } from "./cloud-areas.ts";
import { configureShareIdentities, claimPendingInvitesForUser } from "./pending.ts";
import { accessLevel, canReadLevel } from "./shares.ts";
import { sendEmail } from "./email.ts";
import { disconnectSessions } from "./collab.ts";

/** Opt-in composition only. Default deployments do not initialize this schema. */
export function createAccountPlatform(db: Database.Database, areas: CloudAreasStore, secret: string) {
  const authenticate = async (request: Request): Promise<IdentityActor | null> => {
    const value = await auth.api.getSession({ headers: request.headers });
    return value ? { userId: value.user.id, email: value.user.email, emailVerified: value.user.emailVerified, sessionId: value.session.id } : null;
  };
  const store = createIdentityStore(db, { secret, ensureIdentityArea: (uid, id, email) => areas.ensureIdentityArea(uid, id, email) });
  configureShareIdentities({ verifiedUserForEmail: (email, connection) => resolveVerifiedUserForEmail(connection, email), activeEmailsForUser: (uid, connection) => activeVerifiedEmails(connection, uid) });
  const googleAvailable = !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
  const google = googleAvailable ? createGoogleIdentityLinks({
    db, secret, authOrigin: new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:8787").origin,
    authenticate, consumeStepUp: (actor, proof, scope) => store.consumeStepUp(actor, proof, scope),
    beginOAuthLink: async ({ sessionToken, callbackURL, headers }) => {
      headers.set("authorization", `Bearer ${sessionToken}`);
      const response = await auth.api.linkSocialAccount({ headers, body: { provider: "google", callbackURL, errorCallbackURL: callbackURL, disableRedirect: true }, asResponse: true });
      const data = await response.json() as { url?: string };
      if (!response.ok || !data.url) throw new Error("Google linking unavailable");
      return { url: data.url, stateCookies: response.headers.getSetCookie().filter((value) => /^(?:__Secure-)?better-auth\.(?:state|oauth_state)(?:\.\d+)?=/.test(value)) };
    },
  }) : undefined;
  configureAccountContext({ db, google });
  const app = new Hono();
  app.get("/capabilities", (c) => { c.header("Cache-Control", "private, no-store"); return c.json({ verifiedIdentities: true, cloudAreas: true, googleLinking: googleAvailable }); });
  // Advertise Google only when credentials and guarded linking are installed.
  app.use("/identities", async (c, next) => {
    await next();
    if (c.req.method === "GET" && c.res.ok) {
      const data = await c.res.json(); c.res = new Response(JSON.stringify({ ...data, googleAvailable }), { status: c.res.status, headers: c.res.headers });
    }
  });
  app.route("/", createAccountIdentitiesApi({
    store, authenticate,
    sendCode: async ({ email, code }) => sendEmail({ to: email, subject: "Your Markie verification code", text: `Your Markie verification code is ${code}. It expires in 5 minutes. Only enter it in Markie if you requested it.`, requireDelivery: true }),
    mintSession: async (uid) => {
      const context = await auth.$context, session = await context.internalAdapter.createSession(uid);
      if (!session) throw new Error("Session unavailable");
      return { id: session.id, token: session.token };
    },
    onIdentityVerified: (uid, email) => { if (resolveVerifiedUserForEmail(db, email) === uid) claimPendingInvitesForUser(uid); },
    onSessionsRevoked: disconnectSessions,
  }));
  app.route("/", createCloudAreasApi({
    store: areas,
    authenticate: async (request) => { const who = await authenticate(request); return who ? { id: who.userId } : null; },
    canAccessDocument: (uid, kind, id) => kind === "markdown"
      ? canReadLevel(accessLevel(id, uid)) && !!db.prepare("SELECT 1 FROM docs WHERE id=? AND deleted_at IS NULL").get(id)
      : !!db.prepare("SELECT 1 FROM dp_documents d LEFT JOIN dp_members m ON m.doc_id=d.id AND m.user_id=? WHERE d.id=? AND (d.owner_id=? OR m.user_id=?)").get(uid, id, uid, uid),
  }));
  if (google) app.route("/", google.app);
  app.delete("/identities/google-provider/:id", bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: "invalid-request" }, 413) }), async (c) => {
    c.header("Cache-Control", "private, no-store");
    try {
      const who = await authenticate(c.req.raw);
      if (!who) return c.json({ error: "unauthorized" }, 401);
      const text = await c.req.text(); if (text.length > 1024) return c.json({ error: "invalid-request" }, 400);
      const body = JSON.parse(text) as { proofId?: unknown };
      if (typeof body.proofId !== "string") return c.json({ error: "invalid-request" }, 400);
      const revoked = db.transaction(() => {
        store.consumeStepUp(who, body.proofId as string, "google-remove");
        const removed = db.prepare("DELETE FROM account WHERE id=? AND userId=? AND providerId='google'").run(c.req.param("id"), who.userId);
        if (!removed.changes) throw new Error("Provider not found");
        // Upstream sessions do not retain provider provenance. Revoke all
        // rather than leave an unlinked Google factor's session usable.
        const ids = (db.prepare("SELECT id FROM session WHERE userId=?").all(who.userId) as { id: string }[]).map((row) => row.id);
        db.prepare("DELETE FROM session WHERE userId=?").run(who.userId);
        return ids;
      }).immediate();
      disconnectSessions(revoked);
      return c.json({ ok: true, signedOut: true });
    } catch { return c.json({ error: "invalid-provider-removal" }, 400); }
  });
  return { app, store, google };
}
