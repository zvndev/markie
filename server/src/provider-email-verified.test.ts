// The user create hook's check that a Google or Apple sign-up arrives with an
// address its provider verified (signup.ts). The end-to-end refusal is in
// identity-apple-signin.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_EMAIL_UNVERIFIED, assertProviderEmailVerified, isProviderSignUpPath } from "./signup.ts";

test("only a provider's callback or an ID-token sign-in counts as a provider sign-up", () => {
  for (const path of ["/callback/:id", "/callback/apple", "/callback/google", "/sign-in/social"]) assert.equal(isProviderSignUpPath(path), true, path);
  for (const path of ["/sign-up/email", "/sign-in/email-otp", "/email-otp/verify-email", "/sign-in/email", "/link-social", "", undefined, null, 7]) assert.equal(isProviderSignUpPath(path), false, String(path));
});

test("a provider sign-up without a verified address is refused with its own code; everything else passes", () => {
  for (const emailVerified of [false, undefined, "true", 1]) {
    assert.throws(() => assertProviderEmailVerified({ emailVerified }, "/callback/:id"), (error: { body?: { code?: string }; statusCode?: number }) => error.body?.code === PROVIDER_EMAIL_UNVERIFIED && error.statusCode === 403);
  }
  assert.doesNotThrow(() => assertProviderEmailVerified({ emailVerified: true }, "/callback/:id"));
  // Password and email-code sign-ups prove the address their own way.
  assert.doesNotThrow(() => assertProviderEmailVerified({ emailVerified: false }, "/sign-up/email"));
  assert.doesNotThrow(() => assertProviderEmailVerified({ emailVerified: false }, undefined));
});
