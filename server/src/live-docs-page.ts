// The hosted Live Doc page and every header the live host sends.
//
// The page is the Mac preview's document (src/lib/darkmown/preview.ts) served
// from a real origin: the same page style, the sanitized body, its JSON state
// seeds, and the pinned runtime plus its local-form bootstrap as inline
// scripts. The CSP comes from the server as a header and admits exactly
// those two scripts by hash, the one style block by hash, and nothing else:
// no other script, no eval, no network, no form submission, no framing.
// connect-src and form-action are 'none' in H1; the per-page network list is
// H3 (markie-darkmown-sites-design, "Security model" 3).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const generated = (name: string) => readFileSync(new URL(`./generated/darkmown/${name}`, import.meta.url), "utf8");

export const LIVE_DOC_RUNTIME = generated("runtime.js.txt");
export const LIVE_DOC_BOOTSTRAP = generated("local-form-bootstrap.js.txt");
export const LIVE_DOC_STYLE_BODY = generated("preview-style.css");
const POLICY = JSON.parse(generated("runtime-policy.json")) as { runtimeSha256: string; bootstrapSha256: string };

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("base64");

// Refuse to serve a runtime that is not the one the Mac app pins: a copy that
// drifted, or a file changed on disk, would otherwise run under a policy
// built from its own hash and look perfectly healthy.
if (sha256(LIVE_DOC_RUNTIME) !== POLICY.runtimeSha256 || sha256(LIVE_DOC_BOOTSTRAP) !== POLICY.bootstrapSha256) {
  throw new Error("The hosted Darkmown runtime does not match electron/darkmown-runtime-policy.json. Run: (cd server && npm run darkmown:sync)");
}
if ([LIVE_DOC_RUNTIME, LIVE_DOC_BOOTSTRAP, LIVE_DOC_STYLE_BODY].some((text) => /<\/(script|style)/i.test(text))) {
  throw new Error("The hosted Darkmown runtime cannot be embedded safely.");
}

// A hosted page follows the reader's system appearance. The Mac preview pins
// one scheme per render instead, from the app's theme.
const STYLE = `:root{color-scheme:light dark}${LIVE_DOC_STYLE_BODY}`;

export const LIVE_DOC_CSP = [
  "default-src 'none'",
  `script-src 'sha256-${POLICY.runtimeSha256}' 'sha256-${POLICY.bootstrapSha256}'`,
  "script-src-attr 'none'",
  `style-src 'sha256-${sha256(STYLE)}'`,
  "img-src 'none'",
  "media-src 'none'",
  "font-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

// Small pages the live host shows itself (a refused pass, a compile error).
// No script at all, one hashed style block.
const NOTICE_STYLE = ":root{color-scheme:light dark;font:16px/1.6 system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}main{max-width:420px;text-align:center}p{opacity:.75}";
export const LIVE_NOTICE_CSP = [
  "default-src 'none'",
  `style-src 'sha256-${sha256(NOTICE_STYLE)}'`,
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Every header on every live-host response, pages, redirects and refusals
 * alike. Private pages are never stored anywhere; nothing here is indexed.
 */
export const LIVE_DOC_HEADERS: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-Robots-Tag": "noindex, nofollow",
  "Cache-Control": "private, no-store",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export interface LiveDocPageParts {
  bodyHtml: string;
  seeds: readonly string[];
  title: string;
}

/** The hosted page. `bodyHtml` and `seeds` are the sanitizer's output, never raw compiler output. */
export function renderLiveDocPage(page: LiveDocPageParts): string {
  // The sanitizer already escapes `<` in every seed; this is the second wall
  // between a seed and the end of its script element.
  const seeds = page.seeds.map((seed) => `<script type="application/json" data-wd-state>${seed.replace(/</g, "\\u003c")}</script>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex, nofollow"><title>${escapeHtml(page.title)}</title><style>${STYLE}</style></head><body>${page.bodyHtml}${seeds}<script>${LIVE_DOC_RUNTIME}</script><script>${LIVE_DOC_BOOTSTRAP}</script></body></html>`;
}

/** A plain notice on the live host: a heading, a line, and at most one same-origin link. */
export function renderLiveNotice(heading: string, line: string, link?: { href: string; label: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex, nofollow"><title>${escapeHtml(heading)}</title><style>${NOTICE_STYLE}</style></head><body><main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(line)}</p>${link ? `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>` : ""}</main></body></html>`;
}
