#!/usr/bin/env node
// Regenerates server/src/generated/darkmown/ from the Mac app's pinned
// Darkmown pipeline, for hosted Live Docs (src/live-docs*.ts).
//
// The server's Docker build context is server/ alone, so it cannot import
// src/lib/darkmown/ or mcp/. It compiles with these copies instead, and
// src/live-docs-parity.test.ts fails whenever a copy and its source differ.
// Run after any change to the vendored compiler, the runtime, the bootstrap,
// the sanitizer or the preview limits:
//
//   (cd server && npm run darkmown:sync)
//
// Every file is copied byte for byte, with two exceptions. The sanitizer's
// imports are extensionless app imports Node cannot resolve: its import of
// the limits goes through compiler-types.ts, so the copy imports the same
// limits file directly, and its import of the link and picture rules is
// replaced by links.ts itself, inlined, so the copy stays one file the app's
// typecheck can also read (hosted-parity.test.ts imports it). The sync
// refuses to run unless each of those lines is there exactly once. And the
// preview's page style is lifted out of preview.ts as plain CSS.
//
// Hosted pages call the sanitizer without its link and picture options, so a
// hosted Live Doc keeps neither; live-docs.test.ts checks that.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../../", import.meta.url);
export const COPY_DIR = fileURLToPath(new URL("../src/generated/darkmown/", import.meta.url));

const LIMITS_IMPORT = 'import { DARKMOWN_MAX_COMPUTED_GROWTH } from "./compiler-types";';
const LIMITS_IMPORT_COPY = 'import { DARKMOWN_MAX_COMPUTED_GROWTH } from "./darkmown-limits.mjs";';
const LINKS_IMPORT = 'import { darkmownLinkTarget, darkmownPictureRef, darkmownPictureUrl, isDarkmownPictureBase } from "./links";';
const LINKS_SOURCE = "src/lib/darkmown/links.ts";
const linksInline = () =>
  `// ---- inlined from ${LINKS_SOURCE} by the sync ----\n${readFileSync(fileURLToPath(new URL(LINKS_SOURCE, ROOT)), "utf8")}// ---- end of ${LINKS_SOURCE} ----\n`;
const SECURITY_HEADER =
  "// GENERATED from src/lib/darkmown/security.ts by server/scripts/sync-darkmown.mjs.\n" +
  "// Do not edit. Change the source, then run: (cd server && npm run darkmown:sync)\n";

function rewriteSecurity(source) {
  let out = source;
  for (const [line, copy] of [[LIMITS_IMPORT, () => LIMITS_IMPORT_COPY], [LINKS_IMPORT, linksInline]]) {
    const count = out.split(line).length - 1;
    if (count !== 1) {
      throw new Error(`src/lib/darkmown/security.ts must have this import exactly once:\n  ${line}\nfound ${count}. Update sync-darkmown.mjs to match.`);
    }
    out = out.replace(line, () => copy());
  }
  return SECURITY_HEADER + out;
}

// The preview's page style, so a hosted Live Doc looks like the Mac preview.
// Lifted out of preview.ts's one STYLE constant, which holds no interpolation.
function extractStyle(source) {
  const matches = [...source.matchAll(/^const STYLE = `([^`$\\]*)`;$/gm)];
  if (matches.length !== 1) throw new Error("src/lib/darkmown/preview.ts must declare exactly one plain `const STYLE = `...`;` line.");
  return matches[0][1];
}

/** Every generated file: its name in the copy, its source, and how it is derived. */
export const FILES = [
  { name: "compiler-browser.mjs", source: "src/lib/darkmown/vendor/compiler-browser.mjs" },
  { name: "runtime.js.txt", source: "src/lib/darkmown/vendor/runtime.js.txt" },
  { name: "PROVENANCE.json", source: "src/lib/darkmown/vendor/PROVENANCE.json" },
  { name: "THIRD-PARTY-NOTICES.txt", source: "src/lib/darkmown/vendor/THIRD-PARTY-NOTICES.txt" },
  { name: "local-form-bootstrap.js.txt", source: "src/lib/darkmown/local-form-bootstrap.js.txt" },
  { name: "runtime-policy.json", source: "electron/darkmown-runtime-policy.json" },
  { name: "darkmown-limits.mjs", source: "mcp/darkmown-limits.mjs" },
  { name: "security.ts", source: "src/lib/darkmown/security.ts", transform: rewriteSecurity },
  { name: "preview-style.css", source: "src/lib/darkmown/preview.ts", transform: extractStyle },
];

export function sourcePath(file) {
  return fileURLToPath(new URL(file.source, ROOT));
}

export function expectedCopy(file) {
  const bytes = readFileSync(sourcePath(file), "utf8");
  return file.transform ? file.transform(bytes) : bytes;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(COPY_DIR, { recursive: true });
  for (const file of FILES) {
    writeFileSync(join(COPY_DIR, file.name), expectedCopy(file));
    console.log(`wrote ${file.name}`);
  }
}
