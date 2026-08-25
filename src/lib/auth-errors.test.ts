import { describe, expect, it } from "vitest";
import { authErrorMessage, signInReasonCopy } from "./auth-errors";

describe("authErrorMessage", () => {
  it("names the network as the problem when nothing answered", () => {
    // status 0 is auth-client's "fetch threw", not a server reply.
    expect(authErrorMessage(0, "password-signin")).toMatch(/can't reach/i);
  });

  it("explains a rejected password instead of saying 401", () => {
    const msg = authErrorMessage(401, "password-signin");
    expect(msg).toMatch(/don't match/i);
    expect(msg).not.toMatch(/401/);
  });

  it("tells a returning user their email already has an account", () => {
    // The old copy said "Request failed (409)." — a number where the fix
    // belonged, on the one screen where the user is most likely to give up.
    const msg = authErrorMessage(409, "password-signup");
    expect(msg).toMatch(/already has an account/i);
    expect(msg).toMatch(/sign in/i);
  });

  it("treats a 422 on sign-up as a weak or malformed password", () => {
    expect(authErrorMessage(422, "password-signup")).toMatch(/password/i);
  });

  it("says to wait when rate limited", () => {
    expect(authErrorMessage(429, "otp-send")).toMatch(/too many/i);
  });

  it("offers a new code when the entered one is wrong or stale", () => {
    const msg = authErrorMessage(400, "otp-verify");
    expect(msg).toMatch(/code/i);
    expect(msg).toMatch(/expired|new one/i);
  });

  it("does not leak whether an email exists when a reset is requested", () => {
    // Confirming "no account with that email" here turns the reset form into an
    // account-enumeration oracle for anyone with a list of addresses.
    const msg = authErrorMessage(404, "reset-request");
    expect(msg).not.toMatch(/no account|not found|doesn't exist/i);
  });

  it("still gives an actionable message for an unmapped status", () => {
    const msg = authErrorMessage(503, "password-signin");
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).toMatch(/try again/i);
  });

  it("never renders a bare status code to the user", () => {
    const statuses = [0, 400, 401, 403, 404, 409, 422, 429, 500, 503];
    const contexts = [
      "password-signin",
      "password-signup",
      "otp-send",
      "otp-verify",
      "reset-request",
      "reset-verify",
    ] as const;
    for (const status of statuses) {
      for (const context of contexts) {
        expect(authErrorMessage(status, context)).not.toMatch(/\(\d{3}\)/);
      }
    }
  });
});

describe("signInReasonCopy", () => {
  it("says why sign-in is being asked for, per entry point", () => {
    expect(signInReasonCopy("share").title).toMatch(/share/i);
    expect(signInReasonCopy("sync").title).toMatch(/sync/i);
  });

  it("keeps the local-first promise visible wherever it asks", () => {
    // A user is being asked for an account by a local-first app. Every entry
    // point has to answer "what happens to my files" without being asked.
    for (const reason of ["share", "sync", "account"] as const) {
      expect(signInReasonCopy(reason).body).toMatch(/this mac|stay|local/i);
    }
  });
});
