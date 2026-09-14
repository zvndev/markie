#!/usr/bin/env node
// Prints a real two-page PDF through the real exporter and looks at the pixels.
//
// The dark export used to come out as a dark rectangle floating in a white
// frame, on every page, because the page margin box cannot be painted by the
// document. Nothing in a unit test can see that: the CSS was valid, the HTML
// was correct, and the defect only exists once Chromium has paginated it onto
// paper. So this check prints the document and reads the corners back.
//
// It also proves the margins survive wide content: a stress document (a wide
// table, a long URL, a long code line, a display formula, a tall code block)
// used to run ink into the page margins or shrink the whole document to fit
// its widest box. See STRESS_FIXTURE below.
//
// Run with:  MARKIE_ALLOW_E2E=1 npm run pdf:check
// Needs poppler for rasterising (brew install poppler).
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";

requireElectronConsent("pdf-export-check", import.meta.url);

const root = path.resolve(new URL("..", import.meta.url).pathname);
const checks = [];
const check = (name, passed, detail = "") => {
  checks.push({ name, passed });
  process.stdout.write(
    `${passed ? "  ok  " : "  FAIL"} ${name}${detail ? `\n         ${detail}` : ""}\n`
  );
};

// Long enough to paginate: page two is the whole point, since that is where a
// once-per-document inset stops being applied.
const FIXTURE = `# Exposure summary

**Date:** September 1, 2026 **Scope:** a read-only review, and a working test of
an edge-level fix.

## Summary

A paragraph with \`inline code\` and a [link](https://example.com) in it.

> A headline blockquote, which these reports lead with.

| Metric | Count |
| :-- | --: |
| Published | 174 |
| Sold out | 112 |

\`\`\`js
const exposed = await fetch("/products.json").then((r) => r.json());
\`\`\`

---

${"Body text that has to run long enough to paginate, so that the second page exists and can be looked at. ".repeat(45)}
`;

// Every shape that used to run off the page or shrink the document: a table
// wider than the column, a cell with a long URL and a long unbroken token, a
// long code line, a long URL in prose, a wide display formula, a code block
// taller than a page. See src/lib/pdf-styles.ts (FIT_SCRIPT) for what each
// one needs.
const LONG_TOKEN = "averyveryverylongunbrokenidentifier_".repeat(6);
const COLUMNS = Array.from({ length: 14 }, (_, i) => `Column ${i + 1}`);
const STRESS_FIXTURE = `# Stress export

## Wide table

| ${COLUMNS.join(" | ")} |
| ${COLUMNS.map(() => "---").join(" | ")} |
| ${COLUMNS.map((_, i) => `value ${i} with some words`).join(" | ")} |
| ${COLUMNS.map((_, i) => `${i * 1000}`).join(" | ")} |

## Table with a long URL and a long token

| Name | Link | Token |
| --- | --- | --- |
| first | https://example.com/a/very/long/path/that/keeps/going/and/going/and/going/until/it/passes/the/edge/of/the/page/for/sure | ${LONG_TOKEN} |

## Long code line

\`\`\`js
const result = await fetch("https://example.com/api/v1/resources?include=everything&filter=" + encodeURIComponent(JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 })) + "&page=1&limit=100&sort=desc&fields=id,name,createdAt,updatedAt");
\`\`\`

## Long URL in prose

See https://example.com/a/very/long/path/that/keeps/going/and/going/and/going/until/it/passes/the/edge/of/the/page/for/sure/and/then/some/more for details, and the token ${LONG_TOKEN} too.

## Math

$$
\\sum_{i=1}^{n} x_i^2 + \\int_0^1 f(x)\\,dx = \\frac{a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p+q+r+s+t+u+v+w+x+y+z}{2}
$$

${"Body text that runs long enough to paginate. ".repeat(60)}

## Tall code block

\`\`\`text
${Array.from({ length: 90 }, (_, i) => `line ${i + 1}`).join("\n")}
\`\`\`

Last paragraph.
`;

// Reads a PNG's pixels through Python, which is on every Mac, rather than
// adding an image library to the app's dependencies for one check.
function probe(pngPath) {
  const script = `
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert("RGB")
w, h = im.size
px = im.load()
corners = [px[2, 2], px[w - 3, 2], px[2, h - 3], px[w - 3, h - 3]]
corner = corners[0]

def inked(c):
    return abs(c[0] - corner[0]) + abs(c[1] - corner[1]) + abs(c[2] - corner[2]) > 60

first = None
for y in range(h):
    row = [px[x, y] for x in range(0, w, 7)]
    if any(inked(c) for c in row):
        first = y
        break

# At 70 dpi, 2.2cm is 60px and 2cm is 55px: the same side and bottom insets
# the body's padding produces. Any ink in those bands means content ran off
# the printable column, either past the right edge or off the bottom.
right_margin = 60
bottom_margin = 55
right_ink = sum(
    1 for x in range(max(0, w - right_margin), w)
    if any(inked(px[x, y]) for y in range(0, h, 7))
)
bottom_ink = sum(
    1 for y in range(max(0, h - bottom_margin), h)
    if any(inked(px[x, y]) for x in range(0, w, 7))
)

print(repr({"size": (w, h), "corners": corners, "firstInk": first, "rightInk": right_ink, "bottomInk": bottom_ink}))
`;
  const out = execFileSync("python3", ["-c", script, pngPath], { encoding: "utf-8" });
  return JSON.parse(out.trim().replace(/\(/g, "[").replace(/\)/g, "]").replace(/'/g, '"').replace(/None/g, "null"));
}

const near = (a, b, tolerance = 12) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= tolerance;

async function printOne(dir, name) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      path.join(root, "node_modules", ".bin", "electron"),
      [path.join(root, "scripts", "lib", "print-pdf.cjs"), dir, name],
      { cwd: root, stdio: "ignore" }
    );
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`print ${name} exited ${code}`))));
    child.on("error", reject);
  });
  const errPath = path.join(dir, `${name}.error`);
  if (existsSync(errPath)) throw new Error(await readFile(errPath, "utf-8"));
}

async function main() {
  if (!existsSync("/opt/homebrew/bin/pdftoppm") && !existsSync("/usr/local/bin/pdftoppm")) {
    process.stdout.write("pdftoppm not found; install poppler to run this check (brew install poppler)\n");
    return false;
  }

  const { renderMarkdownHTML } = await import("../src/lib/markdown-html.ts");
  const { buildPDFHTML, buildPDFHTMLSync } = await import("../src/lib/pdf-styles.ts");
  const body = renderMarkdownHTML(FIXTURE);

  const dir = await mkdtemp(path.join(tmpdir(), "markie-pdf-check-"));
  try {
    for (const theme of ["dark", "light"]) {
      await writeFile(path.join(dir, `${theme}.html`), buildPDFHTMLSync(body, theme), "utf-8");
      await printOne(dir, theme);
      execFileSync("pdftoppm", ["-png", "-r", "70", "-f", "1", "-l", "2", path.join(dir, `${theme}.pdf`), path.join(dir, theme)]);
    }

    const paper = { dark: [9, 9, 11], light: [255, 255, 255] };
    for (const theme of ["dark", "light"]) {
      const pages = [1, 2].map((n) => probe(path.join(dir, `${theme}-${n}.png`)));
      check(`${theme}: the document paginates onto a second page`, pages.length === 2 && pages[1].size[1] > 0);

      for (const [i, page] of pages.entries()) {
        check(
          `${theme}: page ${i + 1} is ${theme} to all four corners`,
          page.corners.every((c) => near(c, paper[theme])),
          JSON.stringify(page.corners)
        );
      }

      // The inset has to survive pagination. Page two starting at row 0 is the
      // symptom of padding that applies once instead of per page.
      for (const [i, page] of pages.entries()) {
        check(
          `${theme}: page ${i + 1} keeps its top margin`,
          typeof page.firstInk === "number" && page.firstInk >= 30,
          `first ink at row ${page.firstInk}`
        );
      }
    }

    // The stress document needs the KaTeX stylesheet for the display formula,
    // which buildPDFHTMLSync leaves out, so build it with the async variant.
    // Light theme only: this pass is about layout, not color.
    const stressBody = renderMarkdownHTML(STRESS_FIXTURE);
    await writeFile(path.join(dir, "stress.html"), await buildPDFHTML(stressBody, "light"), "utf-8");
    await printOne(dir, "stress");
    execFileSync("pdftoppm", ["-png", "-r", "70", path.join(dir, "stress.pdf"), path.join(dir, "stress")]);

    const stressPages = (await readdir(dir))
      .filter((name) => /^stress-\d+\.png$/.test(name))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
      .map((name) => probe(path.join(dir, name)));

    // A shrunken document comes out shorter: the unfixed stylesheet produced
    // 4 pages of tiny text, the fixed one produces 7.
    check(
      "stress: prints at its natural length (5 pages or more)",
      stressPages.length >= 5,
      `${stressPages.length} pages`
    );
    for (const [i, page] of stressPages.entries()) {
      check(`stress: page ${i + 1} keeps its right margin`, page.rightInk === 0, `rightInk ${page.rightInk}`);
      check(`stress: page ${i + 1} keeps its bottom margin`, page.bottomInk === 0, `bottomInk ${page.bottomInk}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  const failed = checks.filter((c) => !c.passed);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  if (failed.length) process.stdout.write(`failed: ${failed.map((c) => c.name).join(", ")}\n`);
  return failed.length === 0;
}

let ok = false;
try {
  ok = await main();
} catch (err) {
  process.stderr.write(`pdf-export-check failed: ${err.stack ?? err}\n`);
}
process.exit(ok ? 0 : 1);
