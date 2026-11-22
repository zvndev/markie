// Regenerates tests/goldens from Electron Markie's own TypeScript export code.
// Run from the worktree root (needs the repo's node_modules, symlinked):
//   node --import ./rust/scripts/ts-run/register.mjs rust/crates/markie-export/scripts/goldens.mjs
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const fixtures = resolve(here, "../tests/fixtures");
const goldens = resolve(here, "../tests/goldens");
const { renderMarkdownHTML } = await import(resolve(repo, "src/lib/markdown-html.ts"));
const { buildPDFHTMLSync } = await import(resolve(repo, "src/lib/pdf-styles.ts"));
const { convertForExport, markdownBlocks } = await import(resolve(repo, "src/lib/export-formats.ts"));
const { inlineLocalImages } = await import(resolve(repo, "electron/inline-images.js"));

for (const name of readdirSync(fixtures).sort()) {
  const kind = name.endsWith(".md") ? "markdown" : name.endsWith(".txt") ? "text" : null;
  if (!kind) continue;
  const text = readFileSync(resolve(fixtures, name), "utf8");
  const stem = name.replace(/\.[^.]+$/, "");
  const html = renderMarkdownHTML(text);
  writeFileSync(resolve(goldens, `${stem}.render.html`), html);
  writeFileSync(resolve(goldens, `${stem}.export.html`), inlineLocalImages(buildPDFHTMLSync(html, "light"), fixtures));
  if (kind === "markdown") writeFileSync(resolve(goldens, `${stem}.blocks.json`), JSON.stringify(await markdownBlocks(text.replace(/\r\n?/g, "\n")), null, 1));
  for (const id of ["docx", "rtf", "odt", "txt", "md"]) {
    if ((kind === "markdown" && id === "md") || (kind === "text" && id === "txt")) continue;
    const bytes = await convertForExport(text, kind, id);
    writeFileSync(resolve(goldens, `${stem}.convert.${id}`), bytes);
  }
}
console.log("goldens written to", goldens);
