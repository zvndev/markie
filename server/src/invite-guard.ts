// Two guards on the share-invite route, which makes the server send an email
// to an address the caller typed, carrying words the caller chose.
//
// 1. How often. Without a limit any account could use Markie's sending domain
//    to mail anyone, as often as it liked. Limits are per inviter (a burst
//    window and a day) and per recipient address (a day, counted across every
//    inviter, so a victim is protected from many accounts at once). They are
//    held in memory, like better-auth's own rate limiter here: the API runs as
//    one process, and a redeploy forgetting the counts is acceptable for a
//    spam bound.
//
// 2. What it says. The document name and the inviter's display name are
//    whatever the caller typed. Escaping them stops markup from rendering, but
//    a mail client still turns "claim your prize at evil.com" into a link, in
//    a message that arrives from Markie. So links and markup are removed from
//    both before they reach the subject or the body.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Sized so that heavy honest use never meets them. The share dialog invites
// one person to one document at a time, so an owner sharing a folder's worth
// of documents with two colleagues sends dozens in an hour, and one colleague
// can legitimately receive a few dozen in a day. Spam needs far more than that.
export const INVITE_LIMITS = {
  perInviterPerHour: 60,
  perInviterPerDay: 200,
  perRecipientPerDay: 30,
} as const;

interface Rule {
  key: string;
  max: number;
  windowMs: number;
}

export interface InviteLimiter {
  /**
   * Records one invite from `inviterId` to `recipientEmail` if every limit
   * allows it. Synchronous, so a check and its record cannot interleave with
   * another request. Returns how long to wait when refused.
   */
  take(inviterId: string, recipientEmail: string): { ok: true } | { ok: false; retryAfterSeconds: number };
  reset(): void;
}

// One mailbox, however it is spelled: case, a +tag, and Gmail's ignored dots
// all reach the same person, so they share one per-recipient count.
export function mailboxKey(email: string): string {
  const clean = email.trim().toLowerCase();
  const at = clean.lastIndexOf("@");
  if (at < 1) return clean;
  let local = clean.slice(0, at).split("+")[0];
  let domain = clean.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

export function createInviteLimiter(now: () => number = Date.now): InviteLimiter {
  const hits = new Map<string, number[]>();
  let calls = 0;

  const recent = (key: string, windowMs: number, at: number): number[] => {
    const list = (hits.get(key) ?? []).filter((t) => at - t < windowMs);
    if (list.length) hits.set(key, list);
    else hits.delete(key);
    return list;
  };

  // Keys for addresses nobody invites again would otherwise stay forever.
  const sweep = (at: number) => {
    for (const [key, list] of hits) {
      const live = list.filter((t) => at - t < DAY_MS);
      if (live.length) hits.set(key, live);
      else hits.delete(key);
    }
  };

  return {
    take(inviterId, recipientEmail) {
      const at = now();
      calls += 1;
      if (calls % 1000 === 0) sweep(at);
      const rules: Rule[] = [
        { key: `inviter-hour:${inviterId}`, max: INVITE_LIMITS.perInviterPerHour, windowMs: HOUR_MS },
        { key: `inviter-day:${inviterId}`, max: INVITE_LIMITS.perInviterPerDay, windowMs: DAY_MS },
        { key: `recipient-day:${mailboxKey(recipientEmail)}`, max: INVITE_LIMITS.perRecipientPerDay, windowMs: DAY_MS },
      ];
      let wait = 0;
      for (const rule of rules) {
        const list = recent(rule.key, rule.windowMs, at);
        if (list.length >= rule.max) wait = Math.max(wait, list[list.length - rule.max] + rule.windowMs - at);
      }
      if (wait > 0) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)) };
      for (const rule of rules) hits.set(rule.key, [...(hits.get(rule.key) ?? []), at]);
      return { ok: true };
    },
    reset() {
      hits.clear();
    },
  };
}

// File extensions a document name legitimately ends in. "notes.md" is a file
// name; "evil.com" is a host. Without this list the two look the same.
const DOC_EXTENSIONS = new Set([
  "md", "markdown", "mdx", "txt", "text", "rtf", "doc", "docx", "odt", "org", "rst", "adoc", "tex",
  "csv", "tsv", "json", "yaml", "yml", "toml", "xml", "html", "htm", "env", "log", "ini", "conf", "pdf",
]);
// Dotted labels ending in an alphabetic top-level label: what a mail client
// will turn into a link. Unicode-aware, so a Cyrillic look-alike host counts.
const HOST = /^(?:[\p{L}\p{N}_-]+\.)+\p{L}[\p{L}\p{N}-]*\p{L}$/u;
const SCHEME = /^(?:https?|ftp|mailto|javascript|data|vbscript|file|tel|sms|markie):/i;

function looksLikeLink(token: string): boolean {
  const t = token.replace(/^[("'[<{]+|[)"'\]>},.;:!?]+$/g, "");
  if (!t) return false;
  if (t.includes("://") || SCHEME.test(t) || /^www\./i.test(t)) return true;
  if (/@[^@]+\.[^@]+/.test(t)) return true;
  const host = t.split(/[/:?#]/)[0];
  if (!HOST.test(host)) return false;
  if (host !== t) return true; // a host with a path, port or query
  const dot = host.lastIndexOf(".");
  const ext = host.slice(dot + 1).toLowerCase();
  // "notes.md" stays; "evil.com.md" is still a host once the extension goes.
  return !DOC_EXTENSIONS.has(ext) || HOST.test(host.slice(0, dot));
}

/**
 * Caller-chosen text made safe to put in an email: no markup, no links, no
 * invisible or direction-changing characters, one line, bounded. Returns ""
 * when nothing is left, so the caller can substitute its own wording.
 */
export function plainEmailText(value: string, maxLength: number): string {
  let s = value.normalize("NFKC");
  // Ideographic and halfwidth full stops act as dots in a hostname.
  s = s.replace(/[。．｡]/g, ".");
  // Control, zero-width, and bidirectional override characters.
  s = s.replace(/[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, " ");
  s = s.replace(/<[^>]*>/g, " "); // HTML tags
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1"); // markdown links and images keep their text
  s = s.replace(/[<>]/g, " ");
  s = s
    .split(/\s+/)
    .filter((token) => token && !looksLikeLink(token))
    .join(" ")
    .trim();
  const chars = Array.from(s); // by code point, so an emoji is never cut in half
  if (chars.length > maxLength) s = `${chars.slice(0, maxLength - 1).join("").trimEnd()}…`;
  return s;
}
