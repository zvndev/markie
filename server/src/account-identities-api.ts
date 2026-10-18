import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { IdentityError, type IdentityActor, type IdentityDelivery, type IdentityScope, type IdentityStore } from "./account-identities.ts";

export interface IdentityApiOptions {
  store: IdentityStore;
  authenticate(request: Request): Promise<IdentityActor | null> | IdentityActor | null;
  sendCode(input: { email: string; code: string; purpose: "step-up" | "email-add" | "alias-sign-in" }): Promise<void>;
  /** Existing canonical UID only. Must never invoke signup or change the user's email. */
  mintSession(userId: string, identity: { identityId: string; email: string }): Promise<{ token: string; id?: string }>;
  revokeSession?: (sessionId: string, userId: string) => Promise<void> | void;
  onIdentityVerified?: (userId: string, email: string, identityId: string) => Promise<void> | void;
  onSessionsRevoked?: (sessionIds: string[]) => Promise<void> | void;
}
async function payload(request: Request, keys: string[]): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new IdentityError("invalid-request", 400);
  const reader = request.body?.getReader();
  if (!reader) throw new IdentityError("invalid-request", 400);
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > 4096) throw new IdentityError("invalid-request", 400);
      chunks.push(item.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new IdentityError("invalid-request", 400); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).some((key) => !keys.includes(key))) throw new IdentityError("invalid-request", 400);
  return parsed as Record<string, unknown>;
}
function field(input: Record<string, unknown>, key: string, max = 512): string {
  const value = input[key];
  if (typeof value !== "string" || !value || value.length > max) throw new IdentityError("invalid-request", 400);
  return value;
}
/** Mount at /api/account. No public auth, database or mailer imported at module scope. */
export function createAccountIdentitiesApi(options: IdentityApiOptions): Hono {
  const app = new Hono(), store = options.store;
  app.use("*", async (c, next) => { c.header("Cache-Control", "private, no-store"); c.header("Referrer-Policy", "no-referrer"); await next(); });
  app.onError((error, c) => error instanceof IdentityError ? c.json({ error: error.code }, error.status) : c.json({ error: "identity-unavailable" }, 503));
  const actor = async (request: Request) => {
    const result = await options.authenticate(request);
    if (!result || result.emailVerified !== true) throw new IdentityError("identity-authentication-required", 401);
    return result;
  };
  async function deliver(challenge: IdentityDelivery, purpose: "step-up" | "email-add" | "alias-sign-in") {
    if (challenge.email && challenge.code) {
      try { await options.sendCode({ email: challenge.email, code: challenge.code, purpose }); }
      catch { store.cancelChallenge(challenge.challengeId); throw new IdentityError("identity-unavailable", 503); }
    }
    return { challengeId: challenge.challengeId, expiresInSeconds: challenge.expiresInSeconds };
  }
  app.get("/identities", async (c) => {
    const who = await actor(c.req.raw);
    return c.json({ identities: store.listIdentities(who.userId), providers: store.listProviders(who.userId) });
  });
  app.post("/identities/step-up/start", async (c) => {
    const who = await actor(c.req.raw), body = await payload(c.req.raw, ["scope"]);
    const scope = body.scope === undefined ? "email-add" : field(body, "scope");
    if (!["email-add", "email-remove", "google-link", "google-remove"].includes(scope)) throw new IdentityError("invalid-request", 400);
    return c.json(await deliver(store.startStepUp(who, scope as IdentityScope), "step-up"));
  });
  app.post("/identities/step-up/verify", async (c) => {
    const who = await actor(c.req.raw), body = await payload(c.req.raw, ["challengeId", "code"]);
    return c.json(store.verifyStepUp(who, field(body, "challengeId"), field(body, "code", 6)));
  });
  app.post("/identities/email/start", async (c) => {
    const who = await actor(c.req.raw), body = await payload(c.req.raw, ["email", "proofId"]);
    return c.json(await deliver(store.startEmail(who, field(body, "email", 254), field(body, "proofId")), "email-add"));
  });
  app.post("/identities/email/verify", async (c) => {
    const who = await actor(c.req.raw), body = await payload(c.req.raw, ["challengeId", "code"]);
    const identity = store.verifyEmail(who, field(body, "challengeId"), field(body, "code", 6));
    await options.onIdentityVerified?.(who.userId, identity.email, identity.id);
    return c.json({ identity });
  });
  app.delete("/identities/:id", async (c) => {
    const who = await actor(c.req.raw), body = await payload(c.req.raw, ["proofId"]);
    const { revokedSessionIds } = store.removeIdentity(who, c.req.param("id"), field(body, "proofId"));
    await options.onSessionsRevoked?.(revokedSessionIds);
    return c.json({ ok: true });
  });
  app.post("/identities/sign-in/start", async (c) => {
    const body = await payload(c.req.raw, ["email"]), flowId = randomBytes(32).toString("base64url");
    const challenge = store.startAliasSignIn(field(body, "email", 254), flowId);
    return c.json({ ...await deliver(challenge, "alias-sign-in"), flowId });
  });
  app.post("/identities/sign-in/verify", async (c) => {
    const body = await payload(c.req.raw, ["challengeId", "flowId", "code"]);
    const identity = store.verifyAliasSignIn(field(body, "challengeId"), field(body, "code", 6), field(body, "flowId", 43));
    const session = await options.mintSession(identity.userId, { identityId: identity.identityId, email: identity.email });
    let finalized = false;
    try { finalized = typeof session.token === "string" && !!session.token && !!session.id && store.finalizeAliasSession(identity.userId, identity.identityId, identity.email, session.id); }
    finally {
      if (!finalized && session.id) {
        store.discardAliasSession(identity.userId, session.id);
        await options.revokeSession?.(session.id, identity.userId);
      }
    }
    if (!finalized || !session.token) throw new IdentityError("invalid-verification", 400);
    return c.json({ token: session.token });
  });
  return app;
}
