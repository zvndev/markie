// Email delivery: Resend in production (RESEND_API_KEY set), console locally.
// RESEND_BASE_URL points the same call at a Resend-compatible API, such as JustEmail's /compat/resend.
//
// A self-hosted server may run with no mail at all. It then has to say so with
// MARKIE_MAIL_LOG=1, which writes every message, sign-in codes included, to the
// server log, and the admin relays codes by hand (docs/SELF-HOSTING.md). Without
// that declaration a production server with no mail refuses to send a code
// rather than quietly printing it where log shippers and screenshots reach.
import { officialFlag } from "./official.ts";

type Env = Record<string, string | undefined>;

export type MailMode = "resend" | "log" | "console" | "off";

export function mailMode(env: Env = process.env): MailMode {
  if (env.RESEND_API_KEY) return "resend";
  if (env.MARKIE_MAIL_LOG === "1") {
    if (officialFlag(env) && env.NODE_ENV === "production") {
      throw new Error("MARKIE_MAIL_LOG=1 writes sign-in codes to the log and is for self-hosted servers only (MARKIE_OFFICIAL=0).");
    }
    return "log";
  }
  return env.NODE_ENV === "production" ? "off" : "console";
}

/** Whether an email sign-up can be completed: a code can reach the person somehow. */
export function emailSignInAvailable(env: Env = process.env): boolean {
  return mailMode(env) !== "off";
}

function fromAddress(env: Env): string {
  if (env.EMAIL_FROM) return env.EMAIL_FROM;
  if (!officialFlag(env) && env.BETTER_AUTH_URL) {
    return `Markie <noreply@${new URL(env.BETTER_AUTH_URL).hostname}>`;
  }
  return "Markie <noreply@markie.local>";
}

export async function sendEmail(args: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Verification secrets must never fall back to logs or acknowledge failed delivery. */
  requireDelivery?: boolean;
  /** Carries a one-time code. A production server with no mail refuses it instead of dropping it. */
  secret?: boolean;
}): Promise<void> {
  const env = process.env;
  const mode = mailMode(env);
  if (mode === "log") {
    console.log(`\n[mail-log] to=${args.to} subject="${args.subject}"\n${args.text}\n`);
    return;
  }
  if (mode === "off") {
    if (args.requireDelivery || args.secret) throw new Error("Email delivery is unavailable");
    console.log(`[email] not sent, no mail configured: "${args.subject}"`);
    return;
  }
  if (mode === "console") {
    if (args.requireDelivery) throw new Error("Email delivery is unavailable");
    console.log(
      `\n[email→console] to=${args.to} subject="${args.subject}"\n${args.text}\n`
    );
    return;
  }
  const key = env.RESEND_API_KEY!;
  const baseUrl = (env.RESEND_BASE_URL || "https://api.resend.com").replace(/\/+$/, "");
  const res = await fetch(`${baseUrl}/emails`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress(env),
      to: [args.to],
      subject: args.subject,
      text: args.text,
      ...(args.html ? { html: args.html } : {}),
    }),
  });
  if (!res.ok) {
    if (args.requireDelivery) throw new Error("Email delivery is unavailable");
    console.error("resend error:", res.status, await res.text());
  }
}
