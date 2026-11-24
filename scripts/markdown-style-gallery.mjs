#!/usr/bin/env node
// Draws the Markdown style gallery and proves Spacious did not move.
//
//   node scripts/markdown-style-gallery.mjs [--baseline=<checkout of main>] [--hosted] [--only=presets,editor,...]
//
// Everything is headless Chromium: no window opens and nothing touches the
// screen. Output goes to .autoloop/runs/markdown-styles/ (gitignored):
//
//   presets/<preset>-<tone>.png   the sample document in every preset, light and dark
//   presets/contact-<tone>.png    all six side by side
//   editor/*.png                  the Settings section and the style editor
//   export/*.png, *.html, *.pdf   the exported page and PDF in a style
//   hosted/*.png                  a real public link, before and after a look is pinned
//   spacious/*.png, report.json   the before/after pixel comparison
//
// The Spacious proof (--baseline) serves scripts/markdown-style-gallery/baseline.tsx
// from two checkouts, main and this one, and compares the screenshots pixel
// for pixel in light and dark. Make the baseline checkout with:
//
//   git worktree add --detach <dir> "$(git merge-base HEAD origin/main)"
//   ln -s "$PWD/node_modules" <dir>/node_modules
//
// The hosted part (--hosted) builds the web app, starts the real server on a
// throwaway database, makes an account, a document and a public link through
// the API, pins a look, and opens the link.
//
// Playwright is not a dependency of this repo. Point MARKIE_PLAYWRIGHT_DIR at
// a directory where `npm i playwright-core` has been run, and
// MARKIE_CHROMIUM at a Chromium or chrome-headless-shell binary if Playwright
// has none of its own.
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const out = path.join(root, ".autoloop", "runs", "markdown-styles");
const args = new Map(process.argv.slice(2).map((arg) => { const [key, value = "1"] = arg.replace(/^--/, "").split("="); return [key, value]; }));
const only = args.has("only") ? new Set(args.get("only").split(",")) : null;
const wants = (part) => !only || only.has(part);
const PRESETS = ["spacious", "compact", "classic", "technical", "editorial", "minimal"];
const TONES = ["light", "dark"];
const HARNESS = "/scripts/markdown-style-gallery";

function playwright() {
  const dir = process.env.MARKIE_PLAYWRIGHT_DIR;
  const require = createRequire(dir ? path.join(dir, "package.json") : import.meta.url);
  try {
    return require("playwright-core");
  } catch {
    throw new Error("playwright-core not found. Run `npm i playwright-core` in a scratch directory and set MARKIE_PLAYWRIGHT_DIR to it.");
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

/** The renderer's dev server for one checkout, on a port of its own. */
async function serve(dir, cacheDir) {
  const port = await freePort();
  const server = await createServer({
    root: dir,
    configFile: path.join(dir, "vite.config.ts"),
    cacheDir,
    logLevel: "error",
    server: { port, strictPort: true, host: "127.0.0.1", hmr: false, watch: null },
  });
  await server.listen();
  return { origin: `http://127.0.0.1:${port}`, close: () => server.close() };
}

async function open(page, url, { width = 1100, height = 900 } = {}) {
  await page.setViewportSize({ width, height });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector('body[data-ready="1"]', { timeout: 120_000 });
  // Pictures decode after layout; a screenshot before that has a hole in it.
  await page.evaluate(() => Promise.all(Array.from(document.images, (img) => img.decode().catch(() => undefined))));
}

/**
 * Compares two PNGs pixel by pixel inside the page (no image library needed).
 * Returns the count of differing pixels and writes a picture of where they are.
 */
async function comparePngs(page, beforeFile, afterFile, diffFile) {
  const [before, after] = await Promise.all([readFile(beforeFile), readFile(afterFile)]);
  const result = await page.evaluate(async ([a, b]) => {
    const load = async (base64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${base64}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(img, 0, 0);
      return { canvas, context, data: context.getImageData(0, 0, canvas.width, canvas.height) };
    };
    const left = await load(a);
    const right = await load(b);
    const sameSize = left.canvas.width === right.canvas.width && left.canvas.height === right.canvas.height;
    const width = Math.max(left.canvas.width, right.canvas.width);
    const height = Math.max(left.canvas.height, right.canvas.height);
    const diff = document.createElement("canvas");
    diff.width = width;
    diff.height = height;
    const dctx = diff.getContext("2d");
    dctx.globalAlpha = 0.25;
    dctx.drawImage(right.canvas, 0, 0);
    dctx.globalAlpha = 1;
    let different = 0;
    let maxDelta = 0;
    if (sameSize) {
      const l = left.data.data;
      const r = right.data.data;
      dctx.fillStyle = "#ff0044";
      for (let i = 0; i < l.length; i += 4) {
        const delta = Math.max(Math.abs(l[i] - r[i]), Math.abs(l[i + 1] - r[i + 1]), Math.abs(l[i + 2] - r[i + 2]), Math.abs(l[i + 3] - r[i + 3]));
        if (delta === 0) continue;
        different += 1;
        if (delta > maxDelta) maxDelta = delta;
        const pixel = i / 4;
        dctx.fillRect(pixel % width, Math.floor(pixel / width), 1, 1);
      }
    }
    return {
      before: { width: left.canvas.width, height: left.canvas.height },
      after: { width: right.canvas.width, height: right.canvas.height },
      sameSize,
      pixels: width * height,
      different: sameSize ? different : width * height,
      maxDelta,
      diffPng: diff.toDataURL("image/png").split(",")[1],
    };
  }, [before.toString("base64"), after.toString("base64")]);
  await writeFile(diffFile, Buffer.from(result.diffPng, "base64"));
  delete result.diffPng;
  return result;
}

async function contactSheet(page, files, target, columns = 3) {
  const images = await Promise.all(files.map(async ({ label, file }) => ({ label, src: `data:image/png;base64,${(await readFile(file)).toString("base64")}` })));
  await page.setViewportSize({ width: 2100, height: 1200 });
  await page.setContent(`<!doctype html><body style="margin:0;padding:24px;background:#777;font:600 22px system-ui;display:grid;grid-template-columns:repeat(${columns},1fr);gap:24px">
    ${images.map(({ label, src }) => `<figure style="margin:0;background:#fff;border-radius:8px;overflow:hidden"><figcaption style="padding:12px 16px;background:#111;color:#fff">${label}</figcaption><div style="height:1500px;overflow:hidden"><img src="${src}" style="width:100%;display:block"></div></figure>`).join("")}
  </body>`);
  await page.evaluate(() => Promise.all(Array.from(document.images, (img) => img.decode())));
  await page.screenshot({ path: target, fullPage: true });
}

// ── Hosted ──────────────────────────────────────────────────────────────────

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(output) : reject(new Error(`${command} ${commandArgs.join(" ")} exited ${code}\n${output.slice(-4000)}`))));
  });
}

/** The real server on a throwaway database, with the web app built from this checkout. */
async function startHostedServer(dir = root) {
  await run("npx", ["vite", "build", "--config", "vite.web.config.ts", "--logLevel", "error"], { cwd: dir });
  const data = await mkdtemp(path.join(tmpdir(), "markie-style-gallery-"));
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(data, "gallery.db"),
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: "markdown-style-gallery-secret-32-plus-characters",
    MARKIE_SITE_URL: origin,
    NODE_ENV: "test",
  };
  const server = path.join(dir, "server");
  // The schema first, the way the server's own tests make it.
  const inServer = async (source) => {
    const file = path.join(server, `.gallery-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
    await writeFile(file, source);
    try {
      return await run("node", ["--experimental-strip-types", file], { cwd: server, env });
    } finally {
      await rm(file, { force: true });
    }
  };
  await inServer(`
    import { getMigrations } from "better-auth/db/migration";
    const { auth } = await import("./src/auth.ts");
    const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
    if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();
    process.exit(0);
  `);
  const child = spawn("node", ["--experimental-strip-types", "src/index.ts"], { cwd: server, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${origin}/api/server-info`);
      if (res.status < 500) break;
    } catch {
      // not up yet
    }
    if (attempt > 150 || child.exitCode !== null) throw new Error(`The server did not start.\n${log.slice(-4000)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // An account that passed email verification, made the way the server's own
  // tests make one (server/src/test-users.ts), against the running server.
  const output = await inServer(`
    const { signUpVerified } = await import("./src/test-users.ts");
    const user = await signUpVerified({ request: (p, init) => fetch(${JSON.stringify(origin)} + p, init) }, { name: "Gallery Owner", email: "owner-" + Date.now() + "@markie.test" });
    console.log("TOKEN=" + user.token);
    process.exit(0);
  `);
  const token = /TOKEN=(\S+)/.exec(output)?.[1];
  if (!token) throw new Error("Could not make the gallery's account.");
  const api = async (method, route, body) => {
    const res = await fetch(`${origin}${route}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Origin: origin },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${route} answered ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
  return { origin, api, stop: async () => { child.kill("SIGTERM"); await rm(data, { recursive: true, force: true }); } };
}

// ── Run ─────────────────────────────────────────────────────────────────────

const report = { generatedAt: new Date().toISOString(), files: [] };
const note = (file) => { report.files.push(path.relative(root, file)); return file; };
const cacheRoot = await mkdtemp(path.join(tmpdir(), "markie-style-vite-"));
const { chromium } = playwright();
const browser = await chromium.launch({ headless: true, ...(process.env.MARKIE_CHROMIUM ? { executablePath: process.env.MARKIE_CHROMIUM } : {}) });
const closers = [() => browser.close(), () => rm(cacheRoot, { recursive: true, force: true })];

try {
  for (const dir of ["presets", "editor", "export", "hosted", "spacious"]) await mkdir(path.join(out, dir), { recursive: true });
  const context = await browser.newContext({ deviceScaleFactor: 2, colorScheme: "light" });
  const page = await context.newPage();
  const here = await serve(root, path.join(cacheRoot, "branch"));
  closers.push(here.close);

  if (wants("presets")) {
    for (const tone of TONES) {
      const sheet = [];
      for (const preset of PRESETS) {
        await open(page, `${here.origin}${HARNESS}/harness.html?view=doc&style=${preset}&tone=${tone}`);
        const file = note(path.join(out, "presets", `${preset}-${tone}.png`));
        await page.screenshot({ path: file, fullPage: true });
        sheet.push({ label: preset[0].toUpperCase() + preset.slice(1), file });
        console.log(`presets/${preset}-${tone}.png`);
      }
      await contactSheet(page, sheet, note(path.join(out, "presets", `contact-${tone}.png`)));
    }
  }

  if (wants("editor")) {
    for (const tone of TONES) {
      await open(page, `${here.origin}${HARNESS}/harness.html?view=settings&style=spacious&tone=${tone}`, { width: 1280, height: 900 });
      await page.screenshot({ path: note(path.join(out, "editor", `settings-section-${tone}.png`)), fullPage: true });
      await page.click("[data-markdown-style-customize]");
      await page.waitForSelector("[data-markdown-style-editor] [data-markdown-style-preview] h1");
      await page.screenshot({ path: note(path.join(out, "editor", `editor-presets-${tone}.png`)) });
      // Change a few elements the way a person would: tables, then headings.
      await page.click('[data-markdown-style-group="tables"] > button');
      await page.click('[data-markdown-style-option="tableStyle:zebra"]');
      await page.click('[data-markdown-style-option="tableHeader:bold"]');
      await page.waitForTimeout(500);
      await page.screenshot({ path: note(path.join(out, "editor", `editor-tables-edited-${tone}.png`)) });
      await page.click('[data-markdown-style-group="headings"] > button');
      await page.click('[data-markdown-style-option="headingRule:short"]');
      await page.waitForTimeout(500);
      await page.screenshot({ path: note(path.join(out, "editor", `editor-headings-edited-${tone}.png`)) });
      await page.click("[data-markdown-style-save-as]");
      await page.fill('input[aria-label="Name for the new style"]', "Field manual");
      await page.screenshot({ path: note(path.join(out, "editor", `editor-save-as-${tone}.png`)) });
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelector("[data-markdown-style-name]")?.textContent?.trim() === "Field manual");
      await page.click('button[aria-label="Close the style editor"]');
      await page.screenshot({ path: note(path.join(out, "editor", `settings-with-saved-profile-${tone}.png`)), fullPage: true });
      console.log(`editor/*-${tone}.png`);
    }
  }

  if (wants("export")) {
    for (const [style, theme] of [["spacious", "light"], ["custom", "light"], ["custom", "dark"], ["classic", "light"]]) {
      await open(page, `${here.origin}${HARNESS}/harness.html?view=export&style=${style}&theme=${theme}`, { width: 900, height: 1100 });
      const name = `export-${style}-${theme}`;
      await writeFile(note(path.join(out, "export", `${name}.html`)), await page.content());
      await page.screenshot({ path: note(path.join(out, "export", `${name}.png`)), fullPage: true });
      await page.pdf({ path: note(path.join(out, "export", `${name}.pdf`)), format: "A4", printBackground: true });
      console.log(`export/${name}.{html,png,pdf}`);
    }
  }

  if (args.has("baseline") && wants("spacious")) {
    const baseDir = path.resolve(args.get("baseline"));
    // The baseline checkout gets the same page and the same words, nothing else.
    const target = path.join(baseDir, "scripts", "markdown-style-gallery");
    await mkdir(target, { recursive: true });
    for (const file of ["baseline.html", "baseline.tsx"]) await cp(path.join(root, "scripts", "markdown-style-gallery", file), path.join(target, file));
    const sample = await readFile(path.join(root, "src", "lib", "markdown-style-sample.ts"), "utf8");
    await writeFile(path.join(target, "sample.ts"), sample);
    const base = await serve(baseDir, path.join(cacheRoot, "baseline"));
    closers.push(base.close);
    report.spacious = {};
    for (const tone of TONES) {
      for (const width of [1100, 620]) {
        const key = `${tone}-${width}`;
        const before = note(path.join(out, "spacious", `before-main-${key}.png`));
        const after = note(path.join(out, "spacious", `after-branch-${key}.png`));
        await open(page, `${base.origin}${HARNESS}/baseline.html?tone=${tone}`, { width });
        await page.screenshot({ path: before, fullPage: true });
        await open(page, `${here.origin}${HARNESS}/baseline.html?tone=${tone}`, { width });
        await page.screenshot({ path: after, fullPage: true });
        // And the path a person on this branch takes: Spacious chosen in Settings.
        const chosen = note(path.join(out, "spacious", `after-branch-chosen-${key}.png`));
        await open(page, `${here.origin}${HARNESS}/harness.html?view=doc&style=spacious&tone=${tone}`, { width });
        await page.screenshot({ path: chosen, fullPage: true });
        await page.goto("about:blank");
        // The comparison has to be able to fail: another preset must differ.
        const control = path.join(out, "spacious", `control-compact-${key}.png`);
        await open(page, `${here.origin}${HARNESS}/harness.html?view=doc&style=compact&tone=${tone}`, { width });
        await page.screenshot({ path: control, fullPage: true });
        await page.goto("about:blank");
        const controlResult = await comparePngs(page, before, control, path.join(out, "spacious", `control-diff-${key}.png`));
        report.spacious[key] = {
          controlCompactDiffers: controlResult.different > 0,
          baselineVsBranch: await comparePngs(page, before, after, note(path.join(out, "spacious", `diff-${key}.png`))),
          baselineVsChosen: await comparePngs(page, before, chosen, note(path.join(out, "spacious", `diff-chosen-${key}.png`))),
        };
        console.log(`spacious ${key}: ${report.spacious[key].baselineVsBranch.different} of ${report.spacious[key].baselineVsBranch.pixels} pixels differ (boot path), ${report.spacious[key].baselineVsChosen.different} (chosen in Settings)`);
      }
    }
  }

  if (args.has("hosted") && wants("hosted")) {
    const hosted = await startHostedServer();
    closers.push(hosted.stop);
    // The sample's Markdown, read out of its module as text.
    const sampleSource = await readFile(path.join(root, "src", "lib", "markdown-style-sample.ts"), "utf8");
    const picture = /"(data:image\/svg\+xml;base64,[^"]+)"/.exec(sampleSource)[1];
    const MARKDOWN_STYLE_SAMPLE = /export const MARKDOWN_STYLE_SAMPLE = `([\s\S]*)`;\s*$/.exec(sampleSource)[1].replaceAll("\\`", "`").replace("${PICTURE}", picture);
    const { createHash, randomUUID } = await import("node:crypto");
    // A document with a public link, made through the API as a client makes one.
    const publish = async (server) => {
      const id = randomUUID();
      await server.api("PUT", `/api/docs/${id}`, {
        name: "Lighthouse handbook.md",
        content: MARKDOWN_STYLE_SAMPLE,
        hash: createHash("sha256").update(MARKDOWN_STYLE_SAMPLE, "utf8").digest("hex"),
        baseVersion: 0,
      });
      const link = await server.api("POST", `/api/docs/${id}/public-link`, {});
      return { id, url: String(link.url).replace(/^https?:\/\/[^/]+/, server.origin) };
    };
    const capture = async (target, file) => {
      await page.setViewportSize({ width: 1180, height: 900 });
      await page.goto(target, { waitUntil: "networkidle" });
      await page.waitForSelector("[data-web-view-content] h1", { timeout: 60_000 });
      await page.evaluate(() => Promise.all(Array.from(document.images, (img) => img.decode().catch(() => undefined))));
      await page.screenshot({ path: note(path.join(out, "hosted", file)), fullPage: false });
      await page.evaluate(() => { document.querySelector("[data-web-view-scroll]").style.overflow = "visible"; document.querySelector(".markie-view").style.height = "auto"; });
      await page.screenshot({ path: note(path.join(out, "hosted", file.replace(".png", "-full.png"))), fullPage: true });
      console.log(`hosted/${file}`);
    };
    const { id: docId, url } = await publish(hosted);
    const shot = (name) => capture(url, name);
    await shot("public-link-no-pin.png");

    // The owner's look: a theme template's tokens and their own style, as the
    // Share dialog's "Readers see my look" sends them.
    const themeModule = await readFile(path.join(root, "scripts", "markdown-style-gallery", "custom-style.ts"), "utf8");
    const style = { ...new Function(`return (${/GALLERY_CUSTOM_STYLE: MarkdownStyle = (\{[\s\S]*\});/.exec(themeModule)[1]})`)(), name: "Field manual" };
    const PAPER_LIGHT = { background: "#fbf8f1", surface: "#f2ede2", surface2: "#e9e2d3", foreground: "#2b2620", muted: "#5f564a", border: "#d9cfbc", docRule: "#e2d9c7", accent: "#efe1c4", link: "#9a3b12", statusGreen: "#3f6212", statusYellow: "#7c4f00", statusRed: "#9f1d1d", statusBlue: "#1e4f8a", statusPurple: "#6b2f8a", bodyFont: "charter", headingFont: "iowan", lineHeight: 1.8, paragraphGap: 1, fontSize: 17, contentWidth: 720 };
    const STUDIO_DARK = { background: "#0d1117", surface: "#161b22", surface2: "#1c2230", foreground: "#e6edf3", muted: "#9da7b3", border: "#30363d", docRule: "#21262d", accent: "#1f3a5f", link: "#58a6ff", statusGreen: "#56d364", statusYellow: "#e3b341", statusRed: "#ff7b72", statusBlue: "#79c0ff", statusPurple: "#d2a8ff", bodyFont: "system", headingFont: "mono", lineHeight: 1.6, paragraphGap: 0.6, fontSize: 15, contentWidth: 880 };
    await hosted.api("PUT", `/api/docs/${docId}/theme`, { tokens: PAPER_LIGHT, style });
    report.hostedLook = await (await fetch(url.replace(/\/?$/, "/theme"))).json();
    await shot("public-link-pinned-custom-style-paper-light.png");
    await hosted.api("PUT", `/api/docs/${docId}/theme`, { tokens: STUDIO_DARK, style });
    await shot("public-link-pinned-custom-style-studio-dark.png");
    await hosted.api("PUT", `/api/docs/${docId}/theme`, { tokens: PAPER_LIGHT, style: { base: "editorial" } });
    await shot("public-link-pinned-editorial-paper-light.png");
    // Unpinning gives the hosted page its own look back.
    await hosted.api("PUT", `/api/docs/${docId}/theme`, { tokens: null, style: null });
    await shot("public-link-unpinned-again.png");

    // A public link nobody pinned a look to must read exactly as it did before
    // this work: the same link, served by a checkout of main, pixel for pixel.
    if (args.has("baseline")) {
      const before = await startHostedServer(path.resolve(args.get("baseline")));
      closers.push(before.stop);
      await capture((await publish(before)).url, "public-link-no-pin-main.png");
      await page.goto("about:blank");
      const file = (name) => path.join(out, "hosted", name);
      report.hostedUnpinned = {
        mainVsBranch: await comparePngs(page, file("public-link-no-pin-main-full.png"), file("public-link-no-pin-full.png"), note(file("diff-no-pin.png"))),
        mainVsUnpinnedAgain: await comparePngs(page, file("public-link-no-pin-main-full.png"), file("public-link-unpinned-again-full.png"), note(file("diff-unpinned-again.png"))),
        // The comparison has to be able to fail: a pinned page must differ.
        controlPinnedDiffers: (await comparePngs(page, file("public-link-no-pin-main-full.png"), file("public-link-pinned-editorial-paper-light-full.png"), note(file("diff-control.png")))).different > 0,
      };
      console.log(`hosted, no look pinned: ${report.hostedUnpinned.mainVsBranch.different} pixels differ from main; ${report.hostedUnpinned.mainVsUnpinnedAgain.different} after pinning and unpinning`);
    }
  }

  await writeFile(path.join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${report.files.length} files under ${path.relative(root, out)}/`);
  if (report.hostedUnpinned && (report.hostedUnpinned.mainVsBranch.different > 0 || report.hostedUnpinned.mainVsUnpinnedAgain.different > 0 || !report.hostedUnpinned.controlPinnedDiffers)) {
    console.error("The hosted page with no look pinned changed.");
    process.exitCode = 1;
  }
  if (report.spacious) {
    const blind = Object.entries(report.spacious).filter(([, result]) => !result.controlCompactDiffers);
    if (blind.length > 0) throw new Error("The comparison did not tell Compact from Spacious, so it proves nothing.");
    const moved = Object.entries(report.spacious).filter(([, result]) => result.baselineVsBranch.different > 0 || result.baselineVsChosen.different > 0);
    if (moved.length > 0) {
      console.error(`Spacious changed: ${moved.map(([key]) => key).join(", ")}`);
      process.exitCode = 1;
    } else {
      console.log("Spacious is pixel-identical to the baseline in every comparison.");
    }
  }
} finally {
  for (const close of closers.reverse()) await Promise.resolve().then(close).catch(() => undefined);
}
