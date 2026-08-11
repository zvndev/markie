// Tokens for per-recipient document links.
//
// A token in an invite email is an identifier, not authority. It says who was
// invited to which document; whether that person may still read it is derived
// from the share tables on every single request. Removing someone kills their
// link in the same instant, with nothing to revoke separately. That is the
// whole difference between this and a public link, which keeps working for
// anyone who has the URL until somebody remembers to revoke it.
import crypto from "node:crypto";

// 32 bytes of randomness, base64url so it survives an email client, a copy and
// paste, and a query string without escaping.
export function newLinkToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}
