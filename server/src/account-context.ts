import type Database from "better-sqlite3";
import { APIError } from "better-auth/api";
import { normalizeIdentityEmail, resolveVerifiedUserForEmail } from "./account-identities.ts";
import type { createGoogleIdentityLinks } from "./google-identity-links.ts";

export const accountIdentitiesEnabled = process.env.MARKIE_ACCOUNT_IDENTITIES === "1";
type GoogleLinks = ReturnType<typeof createGoogleIdentityLinks>;
let context: { db: Database.Database; google?: GoogleLinks } | undefined;

/** Installed once by the server composition root; importing auth never migrates identity tables. */
export function configureAccountContext(value: typeof context): void {
  if (value) value.db.exec(`
    CREATE TRIGGER IF NOT EXISTS account_identity_user_insert_guard BEFORE INSERT ON "user"
    WHEN EXISTS(SELECT 1 FROM account_emails WHERE email_norm=lower(trim(NEW.email)) AND revoked_at IS NULL AND user_id<>NEW.id)
    BEGIN SELECT RAISE(ABORT,'identity-conflict'); END;
    CREATE TRIGGER IF NOT EXISTS account_identity_user_update_guard BEFORE UPDATE OF email ON "user"
    WHEN EXISTS(SELECT 1 FROM account_emails WHERE email_norm=lower(trim(NEW.email)) AND revoked_at IS NULL AND user_id<>NEW.id)
    BEGIN SELECT RAISE(ABORT,'identity-conflict'); END;
  `);
  context = value;
}
export function accountContext() { return context; }
export function assertNewAccountEmail(email: string): void {
  if (context && resolveVerifiedUserForEmail(context.db, email)) {
    throw new APIError("CONFLICT", { message: "Use the existing verified account sign-in flow." });
  }
}

/** Prevent generic auth endpoints from bypassing the purpose-bound identity protocol. */
export async function guardAccountAuthRequest(request: Request): Promise<Response | null> {
  if (!context) return null;
  const path = new URL(request.url).pathname.replace(/\/$/, "");
  const denied = /\/(?:link-social|unlink-account|change-email)$/.test(path);
  if (denied) return Response.json({ error: "use-verified-identity-flow" }, { status: 403, headers: { "cache-control": "private, no-store" } });
  if (request.method !== "POST" || !/\/(?:sign-up\/email|sign-in\/email-otp|email-otp\/(?:send-verification-otp|verify-email|reset-password)|forget-password\/email-otp)$/.test(path)) return null;
  // Auth bodies are small. Do not buffer an attacker-controlled, unbounded clone.
  const reader = request.clone().body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 4096) return Response.json({ error: "invalid-request" }, { status: 413 }); chunks.push(part.value); }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  let body: { email?: unknown }; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return null; }
  const email = normalizeIdentityEmail(body?.email);
  if (!email) return null;
  const uid = resolveVerifiedUserForEmail(context.db, email);
  if (!uid) return null;
  const primary = context.db.prepare('SELECT email FROM "user" WHERE id=?').get(uid) as { email: string } | undefined;
  // Primary verification/password flows retain their existing semantics. Alias
  // authentication must mint the canonical UID and record its revocable factor.
  if (normalizeIdentityEmail(primary?.email) === email) return null;
  return Response.json({ error: "use-verified-identity-flow" }, { status: 403, headers: { "cache-control": "private, no-store" } });
}
