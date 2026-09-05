const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// The scheme the viewer serves a document's own pictures over. Named here
// because the CSP has to allow it and main has to register it, and two string
// literals that must match is one string literal too many.
const ASSET_SCHEME = "markie-asset";

// Where a video card may load its player from, and nowhere else. Kept in step
// with the provider list in src/lib/embeds.ts; electron/csp.test.ts holds the
// two together. Nothing else in the app is ever framed.
const EMBED_FRAME_ORIGINS = ["https://www.youtube-nocookie.com", "https://player.vimeo.com"];

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
  const scriptHashes = collectInlineScriptHashes(outDir);
  return [
    "default-src 'self'",
    scriptSrcDirective(scriptHashes),
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: https: ${ASSET_SCHEME}:`,
    // Video and audio beside the document, played through the same scheme and
    // the same access rule as the pictures.
    `media-src 'self' data: ${ASSET_SCHEME}:`,
    "font-src 'self' data:",
    "connect-src 'self' https://api-production-602f.up.railway.app wss://api-production-602f.up.railway.app",
    // default-src would otherwise refuse every iframe, which is right for
    // everything but the one player a card opens when it is clicked.
    `frame-src ${EMBED_FRAME_ORIGINS.join(" ")}`,
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

module.exports = {
  ASSET_SCHEME,
  EMBED_FRAME_ORIGINS,
  buildAppCsp,
  collectInlineScriptHashes,
  inlineScriptHashesForHtml,
  scriptSrcDirective,
};
