// Regenerates Markie RS's copy of Electron's export KaTeX stylesheet and the
// math goldens, from Electron Markie's own TypeScript.
// Run from the worktree root (needs the repo's node_modules, symlinked):
//   node --import ./rust/scripts/ts-run/register.mjs rust/crates/markie-export/scripts/katex-goldens.mjs
//
// Writes:
// - src/assets/katex.css: KATEX_CSS from src/lib/katex-css.generated.ts, the
//   KaTeX stylesheet with its fonts as data: URIs that every Electron export
//   page carries, byte for byte.
// - tests/goldens/math/katex.render.html: renderMarkdownHTML of the math
//   fixture (KaTeX's HTML after Electron's sanitizer).
// - tests/goldens/math/page.light.html and page.dark.html: buildPDFHTML's page
//   around a body of {BODY}, with the stylesheet written as {KATEX_CSS} so the
//   240 KB of fonts are kept once, in the asset. Export HTML saves the light one.
// - With KATEX_LOOK_PAGES=<dir>: Electron's whole Export HTML page for the math
//   fixture, light and dark (inlineLocalImages(buildPDFHTML(...)) as main.js's
//   export-html handler writes it), for the headless Chromium comparison.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const fixtures = resolve(here, "../tests/fixtures/math");
const goldens = resolve(here, "../tests/goldens/math");
const { renderMarkdownHTML } = await import(resolve(repo, "src/lib/markdown-html.ts"));
const { buildPDFHTML } = await import(resolve(repo, "src/lib/pdf-styles.ts"));
const { KATEX_CSS } = await import(resolve(repo, "src/lib/katex-css.generated.ts"));

writeFileSync(resolve(here, "../src/assets/katex.css"), KATEX_CSS);
const html = renderMarkdownHTML(readFileSync(resolve(fixtures, "katex.md"), "utf8"));
writeFileSync(resolve(goldens, "katex.render.html"), html);
for (const theme of ["light", "dark"]) {
  const page = await buildPDFHTML("{BODY}", theme);
  if (!page.includes(KATEX_CSS)) throw new Error("the export page does not carry KATEX_CSS");
  writeFileSync(resolve(goldens, `page.${theme}.html`), page.replace(KATEX_CSS, "{KATEX_CSS}"));
}
const pages = process.env.KATEX_LOOK_PAGES;
if (pages) {
  const { inlineLocalImages } = await import(resolve(repo, "electron/inline-images.js"));
  mkdirSync(pages, { recursive: true });
  for (const theme of ["light", "dark"]) {
    writeFileSync(resolve(pages, `katex.${theme}.electron.html`), inlineLocalImages(await buildPDFHTML(html, theme), fixtures));
  }
}
console.log("katex.css and math goldens written");
