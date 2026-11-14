// The hosted Live Doc page and every header the live host sends.
//
// The page is the Mac preview's document (src/lib/darkmown/preview.ts) served
// from a real origin: the same page style, the sanitized body, its JSON state
// seeds, and the pinned runtime plus its local-form bootstrap as inline
// scripts. The CSP comes from the server as a header and admits exactly
// those two scripts by hash, the one style block by hash, and nothing else:
// no other script, no eval, no network, no form submission, no framing.
// connect-src is 'self' for Markie's own small script below, which keeps a
// server-sent event stream open to this host: it closes the tab the moment
// access ends and reloads it (or offers to) when the document changes. It
// also names exactly the https origins the page's `:fetch` reaches. The live host answers nothing else a page could use
// (live-docs.ts). form-action stays 'none'; the per-page network list is H3
// (markie-darkmown-sites-design, "Security model" 3).
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


/** Where a page's stream to its own host lives (live-docs.ts). */
export const LIVE_DOC_CHANNEL_PATH = "/__markie/live";

/**
 * Markie's script on every hosted page: one EventSource to its own host.
 * `revoked` (access ended, the public link changed, the document is gone)
 * empties the page and the address's storage, and stops for good. Anything
 * else that drops the stream (a deploy, a network change) retries with
 * backoff and never blanks the page, because the server answers a refusal
 * with a 200 and that event, never with an error status.
 */
export const LIVE_DOC_CHANNEL_SCRIPT = `(()=>{"use strict";if(typeof EventSource!=="function")return;let wait=2e3,done=false,touched=false;const touch=()=>{touched=true};document.addEventListener("input",touch,true);document.addEventListener("change",touch,true);document.addEventListener("click",(event)=>{if(event.target instanceof Element&&event.target.closest("button,input,select,textarea,label"))touched=true},true);const gone=(reason)=>{done=true;try{localStorage.clear();sessionStorage.clear()}catch(e){}const main=document.createElement("main");main.className="markie-live-gone";const h=document.createElement("h1");const p=document.createElement("p");if(reason==="link"){h.textContent="This link no longer works";p.textContent="The Live Doc's public link was changed or turned off. Ask whoever shared it for the current one."}else if(reason==="gone"){h.textContent="This Live Doc isn't available";p.textContent="It was deleted, or it is no longer a Live Doc."}else{h.textContent="You no longer have access";p.textContent="This Live Doc is no longer shared with you, or you signed out of Markie."}main.append(h,p);document.body.replaceChildren(main);document.title=h.textContent};const recently=()=>{try{return Date.now()-Number(sessionStorage.getItem("markie-live-reloaded")||0)<3e4}catch(e){return true}};const updated=()=>{if(done)return;if(!touched&&!recently()){try{sessionStorage.setItem("markie-live-reloaded",String(Date.now()))}catch(e){}setTimeout(()=>location.reload(),Math.floor(Math.random()*1500));return}if(document.querySelector(".markie-live-updated"))return;const bar=document.createElement("div");bar.className="markie-live-updated";bar.setAttribute("role","status");const text=document.createElement("span");text.textContent="This Live Doc was updated.";const button=document.createElement("button");button.type="button";button.textContent="Show the new version";button.addEventListener("click",()=>location.reload());bar.append(text,button);document.body.append(bar)};const open=()=>{if(done)return;const shown=document.querySelector('meta[name="markie-live-version"]');const version=shown&&/^\d{1,15}$/.test(shown.content)?shown.content:"";const source=new EventSource(${JSON.stringify(LIVE_DOC_CHANNEL_PATH)}+(version?"?v="+version:""));source.addEventListener("open",()=>{wait=2e3});source.addEventListener("updated",updated);source.addEventListener("revoked",(event)=>{source.close();let reason="access";try{const data=JSON.parse(event.data);if(data&&typeof data.reason==="string")reason=data.reason}catch(e){}gone(reason)});source.addEventListener("error",()=>{if(source.readyState===2&&!done){setTimeout(open,wait);wait=Math.min(wait*2,6e4)}})};open()})();`;

// A hosted page follows the reader's system appearance. The Mac preview pins
// one scheme per render instead, from the app's theme. The two Markie rules
// at the end style the public footer and the page a closed tab turns into.
const STYLE = `:root{color-scheme:light dark}${LIVE_DOC_STYLE_BODY}.markie-live-footer{margin:48px auto 24px;max-width:720px;padding:0 24px;font:13px/1.5 system-ui,sans-serif;opacity:.6;text-align:center}.markie-live-gone{font:16px/1.6 system-ui,sans-serif;max-width:420px;margin:20vh auto;padding:0 24px;text-align:center}.markie-live-gone p{opacity:.75}.markie-live-updated{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);max-width:calc(100% - 32px);box-sizing:border-box;display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;padding:10px 14px;border-radius:10px;font:14px/1.4 system-ui,sans-serif;background:Canvas;color:CanvasText;border:1px solid GrayText;box-shadow:0 4px 16px rgba(0,0,0,.18);z-index:2147483647}.markie-live-updated button{font:inherit;padding:4px 10px;border-radius:6px;border:1px solid GrayText;background:transparent;color:inherit;cursor:pointer}`;

if ([LIVE_DOC_RUNTIME, LIVE_DOC_BOOTSTRAP, LIVE_DOC_CHANNEL_SCRIPT, STYLE].some((text) => /<\/(script|style)/i.test(text))) {
  throw new Error("The hosted Darkmown runtime cannot be embedded safely.");
}

/**
 * The page's CSP. connect-src is 'self' (the page's own stream) plus exactly
 * the https origins its `:fetch` reaches, which the compile reports and
 * live-docs.ts checks before they get here. A page with no `:fetch` can reach
 * nothing but its own host.
 */
export function liveDocCsp(network: readonly string[] = []): string {
  return [
    "default-src 'none'",
    `script-src 'sha256-${POLICY.runtimeSha256}' 'sha256-${POLICY.bootstrapSha256}' 'sha256-${sha256(LIVE_DOC_CHANNEL_SCRIPT)}'`,
    "script-src-attr 'none'",
    `style-src 'sha256-${sha256(STYLE)}'`,
    "img-src 'none'",
    "media-src 'none'",
    "font-src 'none'",
    `connect-src 'self'${network.map((origin) => ` ${origin}`).join("")}`,
    "frame-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export const LIVE_DOC_CSP = liveDocCsp();

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
  /** Set on a public page only: the publisher the footer names. */
  publishedBy?: string;
  /** The document version this page shows; its stream reports newer ones. */
  version?: number;
}

/** The hosted page. `bodyHtml` and `seeds` are the sanitizer's output, never raw compiler output. */
export function renderLiveDocPage(page: LiveDocPageParts): string {
  // The sanitizer already escapes `<` in every seed; this is the second wall
  // between a seed and the end of its script element.
  const seeds = page.seeds.map((seed) => `<script type="application/json" data-wd-state>${seed.replace(/</g, "\\u003c")}</script>`).join("");
  const footer = page.publishedBy === undefined
    ? ""
    : `<footer class="markie-live-footer">A public Live Doc published with Markie by ${escapeHtml(page.publishedBy)}.</footer>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex, nofollow">${Number.isSafeInteger(page.version) ? `<meta name="markie-live-version" content="${page.version}">` : ""}<title>${escapeHtml(page.title)}</title><style>${STYLE}</style></head><body>${page.bodyHtml}${footer}${seeds}<script>${LIVE_DOC_RUNTIME}</script><script>${LIVE_DOC_BOOTSTRAP}</script><script>${LIVE_DOC_CHANNEL_SCRIPT}</script></body></html>`;
}

/** A plain notice on the live host: a heading, a line, and at most one same-origin link. */
export function renderLiveNotice(heading: string, line: string, link?: { href: string; label: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex, nofollow"><title>${escapeHtml(heading)}</title><style>${NOTICE_STYLE}</style></head><body><main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(line)}</p>${link ? `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>` : ""}</main></body></html>`;
}
