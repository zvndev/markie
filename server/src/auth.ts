import { betterAuth } from "better-auth";
import { randomUUID } from "node:crypto";
import { bearer, emailOTP } from "better-auth/plugins";
import { createAuthMiddleware } from "better-auth/api";
import { openDatabase } from "./db.ts";
import { sendEmail } from "./email.ts";
import { claimPendingInvites } from "./pending.ts";
import { resolveAuthSecret } from "./auth-secret.ts";
import { otpEmail } from "./otp-email.ts";
import { applicationOrigins } from "./application-origins.ts";
import { accountContext, accountIdentitiesEnabled, assertNewAccountEmail } from "./account-context.ts";
import { assertSignupAllowed } from "./signup.ts";

const googleConfigured =
  !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;

const authDatabase = openDatabase();

export const auth = betterAuth({
  database: authDatabase,
  hooks: {
    // The create-user hook below is the gate for every path. Email sign-up
    // also needs the refusal said out loud: better-auth answers a 403 from a
    // create hook on that route with a fake success (so a sign-up never shows
    // which addresses exist), which would leave someone waiting for a code
    // that never comes. Checked before the route reads the database, so an
    // existing address and a new one are refused alike.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-up/email") return;
      const email = (ctx.body as { email?: unknown } | undefined)?.email;
      assertSignupAllowed(authDatabase, typeof email === "string" ? email : "");
    }),
  },
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:8787",
  secret: resolveAuthSecret(process.env),
  trustedOrigins: [
    ...applicationOrigins(),
    "markie://", // desktop deep-link auth bridge target
  ],
  rateLimit: {
    enabled: true, // better-auth defaults to prod-only; turn it on everywhere
    window: 10,
    max: 100,
    customRules: {
      // Tighter limits on the abuse-prone unauthenticated endpoints; the OTP
      // send is an email trigger (spam/cost vector).
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-up/email": { window: 60, max: 10 },
      "/email-otp/send-verification-otp": { window: 60, max: 5 },
      // Password reset is the same shape of vector: an unauthenticated route
      // that makes us send mail to an address the caller chose.
      "/forget-password/email-otp": { window: 60, max: 5 },
      "/email-otp/reset-password": { window: 60, max: 10 },
    },
  },
  emailAndPassword: {
    enabled: true,
    // Typing an address is not owning it. Until the address is proven, the
    // account cannot sign in and cannot inherit anything addressed to it:
    // documents shared to alice@corp.com before Alice signs up used to land in
    // whoever registered that address first. See GHSA-qq9h-g4jm-xgf3 for the
    // same class of flaw upstream.
    requireEmailVerification: true,
  },
  account: {
    // Google access and refresh tokens are written to the account table
    // encrypted with BETTER_AUTH_SECRET instead of in the clear, so a copy of
    // the database (a Litestream replica, a volume snapshot) is not also a set
    // of live Google credentials. Rows written before this stay plaintext and
    // still read: better-auth only decrypts values that look like its own
    // hex ciphertext, which Google's `ya29.` / `1//` tokens never do.
    // Rotating BETTER_AUTH_SECRET makes encrypted tokens unreadable; Markie
    // never reads them back (sign-in needs only the identity), and the next
    // Google sign-in overwrites them.
    encryptOAuthTokens: true,
    ...(accountIdentitiesEnabled ? { accountLinking: {
      enabled: true, disableImplicitLinking: true, requireLocalEmailVerified: true,
      allowDifferentEmails: true, updateUserInfoOnLink: false, trustedProviders: [],
    } } : {}),
  },
  emailVerification: {
    // Proving your own address is not the same event as signing in by code,
    // and the difference is whether the password survives. The email-OTP
    // SIGN-IN route revokes every credential an account accrued while its
    // address was unproven (revokeUnprovenAccountAccess): correct when the
    // real owner of an address is taking back an account a squatter
    // registered, and wrong when someone is finishing their own signup.
    // Signup verification therefore goes through /email-otp/verify-email,
    // which only flips the flag. This option is what makes that route hand
    // back a session, so proving the address still lands the user signed in
    // rather than dropping them back at a form to type a password they
    // already typed.
    autoSignInAfterVerification: true,
  },
  databaseHooks: {
    user: {
      create: {
        // MARKIE_SIGNUP (signup.ts). Every way an account comes into being
        // passes through here: email sign-up, a first email-code sign-in and
        // a first Google sign-in, so this is the one place it is decided.
        before: async (user) => {
          assertSignupAllowed(authDatabase, user.email ?? "");
          if (user.email) assertNewAccountEmail(user.email);
        },
        // Claiming moved out of "an account exists" and into "the address is
        // proven". A Google account, or a first email-OTP sign-in, arrives
        // already verified because the provider or the mailbox proved it, so
        // those still sweep at creation. A password signup does not.
        after: async (user: {
          id: string;
          email?: string;
          emailVerified?: boolean;
        }) => {
          accountContext()?.google?.noteCreatedUser(user.id);
          try {
            if (user.emailVerified && user.email) {
              claimPendingInvites(user.email, user.id);
            }
          } catch (err) {
            console.error("claim-on-signup failed:", err);
          }
        },
      },
      update: {
        // The claim trigger for everyone else: whenever a row comes back
        // verified, sweep. That covers entering the emailed code, resetting a
        // password by code, and any future flow that proves the address.
        // claimPendingInvites is idempotent, so firing on unrelated updates
        // costs one indexed SELECT and changes nothing.
        after: async (user: {
          id: string;
          email?: string;
          emailVerified?: boolean;
        }) => {
          try {
            if (user?.emailVerified && user.email) {
              claimPendingInvites(user.email, user.id);
            }
          } catch (err) {
            console.error("claim-on-verify failed:", err);
          }
        },
      },
    },
    account: {
      create: {
        before: async (account) => {
          const google = accountContext()?.google;
          if (account.providerId === "google" && google) {
            // Upstream assigns an ID after its awaited before hook unless we
            // supply one. Fence this exact future INSERT, not merely the request.
            const id = randomUUID();
            google.authorizeGoogleAccountCreation(account.userId, id);
            return { data: { ...account, id } };
          }
        },
        after: async (account) => {
          if (account.providerId === "google") accountContext()?.google?.noteGoogleAccountCreated(account.userId, account.id);
        },
      },
      update: {
        before: async (account) => {
          // A known link callback must still hold its initiating session at
          // the provider-write boundary, even when upstream supplies a patch.
          accountContext()?.google?.assertGoogleAccountMutation(typeof account.userId === "string" ? account.userId : "");
        },
      },
    },
  },
  socialProviders: googleConfigured
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        },
      }
    : undefined,
  plugins: [
    // Desktop clients authenticate with a bearer token (set-auth-token
    // response header) — cross-origin cookies are unreliable from app://
    bearer(),
    emailOTP({
      // Pinned to the plugin's defaults on purpose: the email copy promises
      // "expires in 5 minutes" (otp-email.ts) and the reset rate limit was
      // sized around 3 attempts — an upgraded default must not silently
      // loosen either.
      expiresIn: 300,
      allowedAttempts: 3,
      // Signing up mails the code straight away: with verification required,
      // an account that never receives one is an account nobody can use.
      sendVerificationOnSignUp: true,
      async sendVerificationOTP({ email, otp, type }) {
        // Forgotten passwords are recovered with a code rather than a reset
        // link: a link needs a hosted page plus a second deep-link hop back
        // into the desktop app, and this plugin already does it in two
        // requests without the user leaving Markie.
        await sendEmail({ to: email, ...otpEmail(type, otp), secret: true });
      },
    }),
  ],
});
