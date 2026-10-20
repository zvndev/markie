const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { runtimeSha256, bootstrapSha256 } = require("./darkmown-runtime-policy.json");

// The scheme the viewer serves a document's own pictures over. Named here
// because the CSP has to allow it and main has to register it, and two string
// literals that must match is one string literal too many.
const ASSET_SCHEME = "markie-asset";

// Where a video card may load its player from, and nowhere else. Kept in step
// with the provider list in src/lib/embeds.ts; electron/csp.test.ts holds the
// two together. Darkmown's separate, opaque srcdoc preview is also permitted.
const EMBED_FRAME_ORIGINS = ["https://www.youtube-nocookie.com", "https://player.vimeo.com"];
const DARKMOWN_RUNTIME_HASH = `'sha256-${runtimeSha256}'`;
const DARKMOWN_BOOTSTRAP_HASH = `'sha256-${bootstrapSha256}'`;

const INLINE_SCRIPT_RE = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

function inlineScriptHashesForHtml(html) {
  const hashes = [];
  for (const match of String(html || "").matchAll(INLINE_SCRIPT_RE)) {
    const script = match[1] ?? "";
    if (script.length === 0) continue;
    const digest = crypto.createHash("sha256").update(script, "utf8").digest("base64");
    hashes.push(`'sha256-${digest}'`);
  }
  return hashes;
}

function listHtmlFiles(rootDir) {
  const files = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".html")) {
        files.push(fullPath);
      }
    }
  };
  walk(rootDir);
  return files.sort();
}

function collectInlineScriptHashes(rootDir) {
  const hashes = new Set();
  for (const file of listHtmlFiles(rootDir)) {
    const html = fs.readFileSync(file, "utf8");
    for (const hash of inlineScriptHashesForHtml(html)) hashes.add(hash);
  }
  return [...hashes].sort();
}

function scriptSrcDirective(hashes = []) {
  return ["script-src 'self'", ...hashes].join(" ");
}

function buildAppCsp(outDir) {
  // srcdoc inherits this policy in addition to its own restrictive policy.
  // Author JavaScript is never permitted: this hash names the pinned interpreter.
  const scriptHashes = [...collectInlineScriptHashes(outDir), DARKMOWN_RUNTIME_HASH, DARKMOWN_BOOTSTRAP_HASH];
  return [
    "default-src 'self'",
    scriptSrcDirective(scriptHashes),
    "style-src 'self' 'unsafe-inline'",
    // Original DOCX image parts are bounded local blobs, never executable
    // documents. This permission is deliberately limited to image requests.
    `img-src 'self' data: blob: https: ${ASSET_SCHEME}:`,
    // Video and audio beside the document, played through the same scheme and
    // the same access rule as the pictures.
    `media-src 'self' data: ${ASSET_SCHEME}:`,
    "font-src 'self' data:",
    "connect-src 'self' https://api-production-602f.up.railway.app wss://api-production-602f.up.railway.app",
    // default-src would otherwise refuse every iframe, which is right for
    // everything but the one player a card opens when it is clicked.
    `frame-src about: ${EMBED_FRAME_ORIGINS.join(" ")}`,
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// The renderer talks to Markie Cloud and to every server the user added
// (electron/servers.js), so connect-src carries each trusted origin too, as
// https and as wss for live collaboration. An origin is written into the
// policy only when it is exactly a plain https origin: anything else could
// smuggle a directive in.
const PLAIN_HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/;

/**
 * @param {string} csp
 * @param {unknown[]} [origins]
 * @returns {string}
 */
function withConnectOrigins(csp, origins = []) {
  const extra = [];
  for (const origin of origins) {
    if (typeof origin !== "string" || !PLAIN_HTTPS_ORIGIN.test(origin)) continue;
    const ws = origin.replace(/^https:/, "wss:");
    if (!csp.includes(` ${origin}`)) extra.push(origin);
    if (!csp.includes(` ${ws}`)) extra.push(ws);
  }
  if (extra.length === 0) return csp;
  return csp
    .split("; ")
    .map((d) => (d.startsWith("connect-src ") ? `${d} ${[...new Set(extra)].join(" ")}` : d))
    .join("; ");
}

module.exports = {
  withConnectOrigins,
  ASSET_SCHEME,
  DARKMOWN_RUNTIME_HASH,
  DARKMOWN_BOOTSTRAP_HASH,
  EMBED_FRAME_ORIGINS,
  buildAppCsp,
  collectInlineScriptHashes,
  inlineScriptHashesForHtml,
  scriptSrcDirective,
};
