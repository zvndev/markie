import { betterAuth } from "better-auth";
import { bearer, emailOTP } from "better-auth/plugins";
import Database from "better-sqlite3";
import { sendEmail } from "./email.ts";
import { claimPendingInvites } from "./pending.ts";
import { resolveAuthSecret } from "./auth-secret.ts";
import { otpEmail } from "./otp-email.ts";

const googleConfigured =
  !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;

export const auth = betterAuth({
  database: new Database(process.env.DB_PATH ?? "./markie.db"),
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:8787",
  secret: resolveAuthSecret(process.env),
  trustedOrigins: [
    "app://markie", // packaged desktop app
    "http://localhost:3000", // dev renderer
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
  },
  databaseHooks: {
    user: {
      create: {
        // The moment someone joins, sweep any docs that were shared with their
        // email before they had an account into their Library.
        after: async (user: { id: string; email: string }) => {
          try {
            claimPendingInvites(user.email, user.id);
          } catch (err) {
            console.error("claim-on-signup failed:", err);
          }
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
      async sendVerificationOTP({ email, otp, type }) {
        // Forgotten passwords are recovered with a code rather than a reset
        // link: a link needs a hosted page plus a second deep-link hop back
        // into the desktop app, and this plugin already does it in two
        // requests without the user leaving Markie.
        await sendEmail({ to: email, ...otpEmail(type, otp) });
      },
    }),
  ],
});
