// Email delivery: Resend in production (RESEND_API_KEY set), console locally.
// RESEND_BASE_URL points the same call at a Resend-compatible API, such as JustEmail's /compat/resend.

const FROM = process.env.EMAIL_FROM ?? "Markie <noreply@markie.local>";
const BASE_URL = (process.env.RESEND_BASE_URL || "https://api.resend.com").replace(/\/+$/, "");

export async function sendEmail(args: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(
      `\n[email→console] to=${args.to} subject="${args.subject}"\n${args.text}\n`
    );
    return;
  }
  const res = await fetch(`${BASE_URL}/emails`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      to: [args.to],
      subject: args.subject,
      text: args.text,
      ...(args.html ? { html: args.html } : {}),
    }),
  });
  if (!res.ok) {
    console.error("resend error:", res.status, await res.text());
  }
}
