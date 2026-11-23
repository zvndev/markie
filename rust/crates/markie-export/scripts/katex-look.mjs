// Opens both apps' Export HTML pages in headless Chromium, never on screen,
// and captures each at 2x: the whole page, plus every formula's box.
//   PLAYWRIGHT_CORE=<a playwright-core folder> node katex-look.mjs <pages dir> <out dir>
// <pages dir> holds katex.<theme>.electron.html and katex.<theme>.rs.html
// (scripts/katex-goldens.mjs with KATEX_LOOK_PAGES, and the ignored
// write_math_pages test). Compare the result with katex-look.py.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const [pages, out] = process.argv.slice(2);
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE);
const cache = path.join(process.env.HOME, "Library/Caches/ms-playwright");
const shell = process.env.SCENE_CHROMIUM ?? fs.readdirSync(cache)
  .filter((d) => d.startsWith("chromium_headless_shell-"))
  .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
  .map((d) => path.join(cache, d, "chrome-headless-shell-mac-arm64/chrome-headless-shell"))
  .find((p) => fs.existsSync(p));
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: shell });
const report = { chromium: browser.version(), pages: {} };
try {
  for (const theme of ["light", "dark"]) {
    for (const app of ["electron", "rs"]) {
      const name = `katex.${theme}.${app}`;
      const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 });
      const page = await context.newPage();
      await page.goto("file://" + path.resolve(pages, `${name}.html`), { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      const facts = await page.evaluate(() => {
        const box = (e) => {
          const r = e.getBoundingClientRect();
          return { x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height };
        };
        const formulas = [...document.querySelectorAll(".katex-display, .katex-error, .katex")]
          .filter((e) => !e.parentElement.closest(".katex-display, .katex"))
          .map((e) => ({ kind: e.className, tex: e.querySelector("annotation")?.textContent ?? e.textContent, ...box(e) }));
        const fonts = [...document.fonts].filter((f) => f.status === "loaded").map((f) => `${f.family} ${f.weight} ${f.style}`);
        return { height: document.documentElement.scrollHeight, formulas, fonts };
      });
      await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
      report.pages[name] = facts;
      await context.close();
    }
  }
} finally {
  await browser.close();
}
fs.writeFileSync(path.join(out, "boxes.json"), JSON.stringify(report, null, 1));
console.log(`captured with ${report.chromium} into ${out}`);
