import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import Database from "better-sqlite3";
import { sendEmail } from "./email.ts";

const googleConfigured =
  !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;

export const auth = betterAuth({
  database: new Database(process.env.DB_PATH ?? "./markie.db"),
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:8787",
  secret: process.env.BETTER_AUTH_SECRET ?? "markie-dev-secret-not-for-prod",
  trustedOrigins: [
    "app://markie", // packaged desktop app
    "http://localhost:3000", // dev renderer
  ],
  emailAndPassword: {
    enabled: true,
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
    emailOTP({
      async sendVerificationOTP({ email, otp, type }) {
        await sendEmail({
          to: email,
          subject:
            type === "sign-in"
              ? `${otp} is your Markie sign-in code`
              : `${otp} is your Markie verification code`,
          text: `Your code is ${otp}. It expires in 5 minutes.`,
        });
      },
    }),
  ],
});
