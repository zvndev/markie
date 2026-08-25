import { test } from "node:test";
import assert from "node:assert/strict";
import { otpEmail } from "./otp-email.ts";

test("a sign-in code says it is for signing in", () => {
  const mail = otpEmail("sign-in", "123456");
  assert.match(mail.subject, /sign-in code/);
  assert.match(mail.subject, /123456/);
});

test("a password reset says it is for a password reset", () => {
  // This used to fall through to the generic "verification code" copy, so the
  // one email a locked-out user is actively waiting for did not say what it
  // was for and read like a phishing attempt.
  const mail = otpEmail("forget-password", "654321");
  assert.match(mail.subject, /password/i);
  assert.match(mail.subject, /654321/);
});

test("a password reset tells the reader what happens if they ignore it", () => {
  // Someone who did not request this needs to know that doing nothing is safe,
  // and that the mail alone does not change their account.
  const mail = otpEmail("forget-password", "654321");
  assert.match(mail.text, /didn't|did not/i);
  assert.match(mail.text, /unchanged|still work|nothing/i);
});

test("an unrecognised type still produces a usable verification mail", () => {
  const mail = otpEmail("email-verification", "111111");
  assert.match(mail.subject, /verification code/);
  assert.match(mail.text, /111111/);
});

test("every type states the expiry, so a stale code is explicable", () => {
  for (const type of ["sign-in", "forget-password", "email-verification"]) {
    assert.match(otpEmail(type, "999999").text, /5 minutes/, `missing expiry for ${type}`);
  }
});

test("the code appears in the body, not only the subject", () => {
  for (const type of ["sign-in", "forget-password", "email-verification"]) {
    assert.match(otpEmail(type, "424242").text, /424242/, `missing code for ${type}`);
  }
});
