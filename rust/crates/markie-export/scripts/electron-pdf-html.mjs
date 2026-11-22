// Writes the exact HTML Electron Markie prints for PDF export (buildPDFHTML
// with KaTeX's stylesheet, local pictures inlined) for every fixture, in both
// themes, into .autoloop/runs/web-export/electron-html. Printing those with
// Chromium gives the reference PDFs (scripts/electron-pdf.sh).
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const fixtures = resolve(here, "../tests/fixtures");
const out = resolve(repo, ".autoloop/runs/web-export/electron-html");
mkdirSync(out, { recursive: true });
const { renderMarkdownHTML } = await import(resolve(repo, "src/lib/markdown-html.ts"));
const { buildPDFHTML } = await import(resolve(repo, "src/lib/pdf-styles.ts"));
const { inlineLocalImages } = await import(resolve(repo, "electron/inline-images.js"));
for (const name of readdirSync(fixtures).sort()) {
  if (!/\.(md|txt)$/.test(name)) continue;
  const html = renderMarkdownHTML(readFileSync(resolve(fixtures, name), "utf8"));
  for (const theme of ["light", "dark"]) {
    writeFileSync(resolve(out, `${name}.${theme}.html`), inlineLocalImages(await buildPDFHTML(html, theme), fixtures));
  }
}
console.log(out);
