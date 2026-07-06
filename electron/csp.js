const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

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
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://api-production-602f.up.railway.app wss://api-production-602f.up.railway.app",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

module.exports = {
  buildAppCsp,
  collectInlineScriptHashes,
  inlineScriptHashesForHtml,
  scriptSrcDirective,
};
