// Screenshot Electron Markie's own components in headless Chromium. Nothing
// opens on screen and nothing takes focus.
//
//   MARKIE_ELECTRON_SRC=<electron checkout> PLAYWRIGHT_CORE=<dir of playwright-core> \
//   SCENE_CACHE=<scratch>/vite-cache node shoot.mjs <jobs.json>
//
// jobs.json: [{scene, theme, out, args, session?: {primary?: {origin, token,
// user}, servers?: [{origin, name, token?, user?}]}, steps?: [...]}]
// Steps run inside the page, in order: {fill: selector, text}, {press: key},
// {select: selector, value}, {click: text}, {wait: ms}. A job may also set
// `viewport` ({width, height}) and `ready` (the selector that says it drew).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const electron = process.env.MARKIE_ELECTRON_SRC;
const need = createRequire(path.join(electron, "package.json"));
const { createServer } = await import(need.resolve("vite"));
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE);
const jobs = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));

const server = await createServer({ configFile: path.join(here, "vite.config.mjs") });
await server.listen();
// Any installed headless shell will do (SCENE_CHROMIUM names one).
function headlessShell() {
  if (process.env.SCENE_CHROMIUM) return process.env.SCENE_CHROMIUM;
  const cache = path.join(process.env.HOME, "Library/Caches/ms-playwright");
  const found = (fs.existsSync(cache) ? fs.readdirSync(cache) : [])
    .filter((d) => d.startsWith("chromium_headless_shell-"))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    .map((d) => path.join(cache, d, "chrome-headless-shell-mac-arm64/chrome-headless-shell"))
    .find((p) => fs.existsSync(p));
  return found;
}
const browser = await chromium.launch({ headless: true, executablePath: headlessShell() });
try {
  for (const job of jobs) {
    const context = await browser.newContext({
      viewport: job.viewport ?? { width: 1280, height: 820 },
      deviceScaleFactor: 2,
      colorScheme: job.theme === "dark" ? "dark" : "light",
    });
    await context.addInitScript((session) => {
      const s = session ?? {};
      if (s.primary) {
        localStorage.setItem("markie.server.v1", s.primary.origin);
        localStorage.setItem("markie.token.v1", s.primary.token);
        localStorage.setItem("markie.auth.principal.v1", JSON.stringify({ token: s.primary.token, serverURL: s.primary.origin, userId: s.primary.user.id }));
      }
      for (const srv of s.servers ?? []) {
        if (!srv.token) continue;
        localStorage.setItem(`markie.token.v1@${srv.origin}`, srv.token);
        localStorage.setItem(`markie.auth.principal.v1@${srv.origin}`, JSON.stringify({ token: srv.token, serverURL: srv.origin, userId: srv.user.id }));
      }
      if (s.bridge) {
        // Just enough of preload.js for Settings › Advanced › Servers.
        // electron/servers.js list(): Markie Cloud first, then added servers.
        const servers = [
          { origin: "https://api.markiedocs.com", name: "Markie Cloud", isDefault: true, signIn: { email: true, google: true, apple: true, signup: "open" }, version: null },
          ...(s.servers ?? []).map((x) => ({ origin: x.origin, name: x.name, isDefault: false, signIn: { email: true, google: false, signup: "open" }, version: null })),
        ];
        const known = {
          platform: "darwin",
          serversList: async () => servers,
          serversProbe: async () => ({ ok: false, error: "scene" }),
          serversAdd: async () => ({ error: "scene" }),
          syncSession: async () => ({ ok: true }),
          // Main's serverRequest: the call with that server's token.
          serverRequest: async ({ origin, path, method, body, token }) => {
            const res = await fetch(origin + path, { method, body, credentials: "omit", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
            return { ok: res.ok, status: res.status, data: await res.json().catch(() => null), setAuthToken: res.headers.get("set-auth-token") };
          },
        };
        window.electronAPI = new Proxy(known, {
          get(target, key) {
            if (key in target) return target[key];
            if (typeof key !== "string" || key === "then") return undefined;
            if (key.startsWith("on")) return () => () => {};
            return async () => null;
          },
        });
      }
    }, job.session ?? null);
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error(`[${job.scene}] page error: ${e.message}`));
    const q = new URLSearchParams({ scene: job.scene, theme: job.theme ?? "light", args: JSON.stringify(job.args ?? {}) });
    await page.goto(`http://localhost:18990/scene.html?${q}`, { waitUntil: "networkidle" });
    await page.waitForSelector(job.ready ?? "[role=dialog]", { timeout: 20000 });
    for (const step of job.steps ?? []) {
      if (step.fill) await page.fill(step.fill, step.text);
      if (step.press) await page.keyboard.press(step.press);
      if (step.select) await page.selectOption(step.select, step.value);
      if (step.click) await page.getByText(step.click, { exact: true }).first().click();
      if (step.wait) await page.waitForTimeout(step.wait);
    }
    await page.waitForLoadState("networkidle");
    // Bundled faces load when text is first set in them.
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(job.settle ?? 800);
    // No caret blink or hover in the shot. `blur` drops focus too, to match
    // a Markie RS scene, whose window is never the active one.
    await page.mouse.move((job.viewport?.width ?? 1280) - 1, (job.viewport?.height ?? 820) - 1);
    if (job.blur) await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
    await page.screenshot({ path: job.out });
    console.log(`wrote ${job.out}`);
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
