#!/usr/bin/env node
// Local light-mode visual audit for Markie. It drives the Electron renderer
// through CDP, captures screenshots, and writes computed contrast evidence.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");
const runDir = path.join(root, ".autoloop", "runs");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const artifactDir = path.join(runDir, `light-mode-audit-${stamp}`);
const screenshotsDir = path.join(artifactDir, "screenshots");
const baseEnv = { ...process.env };
const regressionGuardEnabled = process.argv.includes("--regression-guard");
const children = [];
const tempPaths = [];

const guardCategories = {
  shell: [
    "toolbar",
    "toolbar file control",
    "toolbar PDF menu dark option",
    "toolbar PDF menu light option",
    "left rail library button",
    "left rail sign-in button",
  ],
  content: [
    "editor rich article",
    "editor heading",
    "editor strong text",
    "editor link",
    "editor inline code",
    "editor code block",
    "editor blockquote",
    "editor table heading",
    "editor table cell",
    "editor task checkbox",
    "editor math text",
  ],
  overlayOrPanel: [
    "library heading",
    "library body",
    "browse row",
    "files row",
    "shared active tab",
    "skills row",
    "command palette input",
    "command palette row",
    "settings heading",
    "settings email input",
    "stats heading",
    "theme settings heading",
    "agents heading",
    "share dialog heading",
    "comments body",
    "comments composer",
  ],
};

await mkdir(screenshotsDir, { recursive: true });

function logPath(name) {
  return path.join(artifactDir, `${name}.log`);
}

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? baseEnv,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  if (options.log) {
    const stream = createWriteStream(options.log, { flags: "a" });
    child.stdout?.pipe(stream, { end: false });
    child.stderr?.pipe(stream, { end: false });
    child.on("exit", () => stream.end());
  }
  return child;
}

async function stopChildren() {
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.killed) {
            resolve();
            return;
          }
          child.once("exit", resolve);
          child.kill();
          setTimeout(resolve, 1500);
        })
    )
  );
}

async function waitFor(label, fn, timeoutMs = 30000) {
  const startMs = Date.now();
  let lastError;
  while (Date.now() - startMs < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function cdpConnect() {
  const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
  const page = targets.find(
    (target) =>
      target.type === "page" &&
      !target.url.startsWith("devtools://") &&
      (target.url.startsWith("app://") ||
        target.url.startsWith("http://localhost:3000") ||
        target.url.startsWith("http://127.0.0.1:3000"))
  );
  if (!page) return null;

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  let nextId = 1;
  const pending = new Map();
  ws.on("message", (message) => {
    const msg = JSON.parse(message);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (msg) => {
        if (msg.error) {
          reject(new Error(JSON.stringify(msg.error)));
        } else if (msg.result?.exceptionDetails) {
          reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
        } else {
          resolve(msg.result);
        }
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const ev = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result?.result?.value;
  };

  return { send, ev, close: () => ws.close() };
}

async function capture(cdp, name) {
  await cdp.send("Page.bringToFront");
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const file = path.join(screenshotsDir, `${name}.png`);
  await writeFile(file, Buffer.from(shot.data, "base64"));
  return file;
}

function buildRegressionGuard(audit) {
  const samplesByLabel = new Map(audit.samples.map((sample) => [sample.label, sample]));
  const findingsByLabel = new Map(audit.findings.map((finding) => [finding.surface, finding]));
  const categories = Object.fromEntries(
    Object.entries(guardCategories).map(([name, labels]) => {
      const samples = labels.map((label) => samplesByLabel.get(label)).filter(Boolean);
      const missingSamples = labels
        .filter((label) => !samplesByLabel.has(label))
        .map((label) => ({
          surface: label,
          issue: "missing regression guard sample",
          checklist: "Restore this label to the light-mode visual audit samples.",
        }));
      const failures = [
        ...missingSamples,
        ...labels.map((label) => findingsByLabel.get(label)).filter(Boolean),
      ];
      return [
        name,
        {
          requiredSamples: labels,
          sampled: samples.length,
          failures,
          passes: samples.length === labels.length && failures.length === 0,
        },
      ];
    })
  );

  return {
    enabled: regressionGuardEnabled,
    threshold: audit.threshold,
    requiredCategories: Object.keys(guardCategories),
    categories,
    passes: Object.values(categories).every((category) => category.passes),
  };
}

async function main() {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "markie-light-audit-"));
  tempPaths.push(userDataDir);

  start("npm", ["run", "dev"], { log: logPath("next") });
  await waitFor("Next dev renderer", async () => {
    const res = await fetch("http://localhost:3000").catch(() => null);
    return !!res;
  }, 60000);

  const electronBin = path.join(root, "node_modules", ".bin", "electron");
  start(
    electronBin,
    [".", "--remote-debugging-port=9222", `--user-data-dir=${userDataDir}`],
    {
      env: { ...baseEnv, NODE_ENV: "development", MARKIE_E2E: "1" },
      log: logPath("electron"),
    }
  );

  const cdp = await waitFor("Electron CDP app target", cdpConnect, 30000);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: "http://localhost:3000" });
  await waitFor(
    "renderer boot",
    () => cdp.ev("document.location.href.startsWith('http://localhost:3000') && document.readyState === 'complete' && !!document.body"),
    30000
  );

  await cdp.ev(`(() => {
    localStorage.setItem("markie.colormode.v1", "light");
    localStorage.setItem("markie.themes.v1", JSON.stringify({ activeId: "markie-light", custom: [] }));
    const tokens = {
      "--background": "#fafafa",
      "--surface": "#f1f1f3",
      "--surface-2": "#e9e9ec",
      "--foreground": "#18181b",
      "--muted": "#52525b",
      "--border": "#d4d4d8",
      "--accent": "#d4d4d8",
      "--blue": "#2563eb",
      "--status-green": "#166534",
      "--status-yellow": "#92400e",
      "--status-red": "#991b1b",
      "--status-blue": "#1d4ed8",
      "--status-purple": "#6b21a8",
      "--doc-font-size": "16px",
      "--doc-width": "768px"
    };
    for (const [name, value] of Object.entries(tokens)) {
      document.documentElement.style.setProperty(name, value);
    }
  })()`);
  await cdp.ev("location.reload()");
  await waitFor("light theme tokens", () =>
    cdp.ev("document.documentElement && getComputedStyle(document.documentElement).getPropertyValue('--background').trim() === '#fafafa'"),
    30000
  );
  await waitFor("toolbar ready", () => cdp.ev("[...document.querySelectorAll('button')].some((b) => b.textContent.includes('PDF'))"));

  const screenshots = {};
  screenshots.shell = await capture(cdp, "01-shell-light");

  await cdp.ev("[...document.querySelectorAll('button')].find((b) => b.textContent.includes('PDF'))?.click()");
  await waitFor("PDF menu", () => cdp.ev("document.body.innerText.includes('Export Dark')"));
  screenshots.toolbarPdfMenu = await capture(cdp, "02-toolbar-pdf-menu");

  await cdp.ev(`(() => {
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.querySelectorAll('[data-audit-surface="library-probe"], [data-audit-surface="side-panel-probes"]').forEach((node) => node.remove());
    const panel = document.createElement('aside');
    panel.setAttribute('data-audit-surface', 'library-probe');
    panel.className = 'fixed top-11 bottom-0 left-[52px] z-[90] w-[260px] shrink-0 flex flex-col border-r border-border bg-surface';
    panel.innerHTML = \`
      <div class="flex items-center justify-between px-3 h-9 shrink-0">
        <span data-audit-sample="library-heading" class="text-[11px] uppercase tracking-wide text-muted font-medium">Library</span>
        <button title="Collapse" aria-label="Collapse library" class="text-muted hover:text-foreground w-6 h-6 flex items-center justify-center rounded hover:bg-accent/40">x</button>
      </div>
      <div class="flex items-center gap-0.5 px-2 pb-1.5 shrink-0">
        <button class="flex-1 text-[11px] py-1 rounded-md capitalize bg-accent text-foreground">recent</button>
        <button class="flex-1 text-[11px] py-1 rounded-md capitalize text-muted hover:text-foreground hover:bg-accent/40">files</button>
      </div>
      <div class="flex-1 overflow-y-auto px-1.5 pb-2">
        <div data-audit-sample="library-empty" class="px-2 py-4 text-[12px] text-muted leading-relaxed">
          No files yet. Open one or drag <code>.md</code> files here.
        </div>
        <div class="rounded-md px-2 py-1.5 cursor-pointer hover:bg-accent/40">
          <div class="flex items-center gap-1.5">
            <span class="text-[12.5px] text-foreground truncate flex-1">launch-notes.md</span>
            <span data-audit-sample="library-synced-badge" class="text-[9px] px-1 py-px rounded border shrink-0 text-[var(--status-green)] border-[color:var(--status-green)]">Synced</span>
          </div>
        </div>
        <div class="rounded-md px-2 py-1.5 cursor-pointer hover:bg-accent/40">
          <div class="flex items-center gap-1.5">
            <span class="text-[12.5px] text-foreground truncate flex-1">shared-plan.md</span>
            <span data-audit-sample="library-shared-badge" class="text-[9px] px-1 py-px rounded border shrink-0 text-[var(--status-purple)] border-[color:var(--status-purple)]">Shared</span>
          </div>
        </div>
        <div class="flex flex-wrap gap-x-3 gap-y-1 px-2 pt-1.5 text-[11px]">
          <button data-audit-sample="library-download-action" class="text-[var(--status-blue)] hover:underline">Download...</button>
          <button data-audit-sample="library-trash-action" class="text-[var(--status-red)] hover:underline">Trash</button>
        </div>
      </div>
      <button data-audit-sample="library-sign-in-prompt" class="m-2 text-[11px] text-muted hover:text-foreground border border-border rounded-md py-1.5 px-2 text-left leading-snug">
        <span class="text-foreground/90">Sign in</span> to sync these files across your devices and share them.
      </button>\`;
    document.body.appendChild(panel);
    const sidePanels = document.createElement('section');
    sidePanels.setAttribute('data-audit-surface', 'side-panel-probes');
    sidePanels.className = 'fixed top-[58px] left-[330px] z-[90] grid grid-cols-4 gap-2 text-[12px]';
    sidePanels.innerHTML = \`
      <div class="w-[215px] rounded-lg border border-border bg-surface shadow-xl overflow-hidden">
        <div data-audit-sample="browse-heading" class="text-[9px] uppercase tracking-wide text-muted px-2 pt-2 pb-1">Browse</div>
        <div class="px-2 py-1.5 border-b border-border">
          <input value="roadmap" class="w-full text-[12px] bg-background border border-border rounded-md px-2 py-1 text-foreground outline-none" />
        </div>
        <div class="group flex items-center gap-1 px-2 py-1 hover:bg-accent/30">
          <span class="text-muted">▾</span>
          <span data-audit-sample="browse-row" class="truncate flex-1 text-foreground/90">~/Documents/Markie</span>
          <span data-audit-sample="browse-count" class="text-[9px] text-muted">12</span>
          <button data-audit-sample="browse-star" class="shrink-0 px-1 text-[12px] text-[var(--status-yellow)]">★</button>
        </div>
      </div>
      <div class="w-[215px] rounded-lg border border-border bg-surface shadow-xl overflow-hidden">
        <div data-audit-sample="files-heading" class="text-[9px] uppercase tracking-wide text-muted px-2 pt-2 pb-1">Files</div>
        <div class="group flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-accent/40">
          <span class="text-muted">▸</span>
          <span data-audit-sample="files-row" class="text-[12.5px] text-foreground truncate flex-1">Drafts</span>
          <button class="text-muted hover:text-foreground">...</button>
        </div>
        <div data-audit-sample="files-empty" class="pl-8 text-[10.5px] text-muted py-0.5">empty</div>
        <div class="flex flex-wrap gap-x-3 gap-y-1 pl-8 pb-1 text-[11px]">
          <button data-audit-sample="files-trash-action" class="text-[var(--status-red)] hover:underline">Trash</button>
        </div>
      </div>
      <div class="w-[215px] rounded-lg border border-border bg-surface shadow-xl overflow-hidden">
        <div class="flex items-center gap-0.5 px-1 py-1.5">
          <button data-audit-sample="shared-tab-active" class="flex-1 text-[11px] py-1 rounded-md bg-accent text-foreground">Shared with me</button>
          <button data-audit-sample="shared-tab-idle" class="flex-1 text-[11px] py-1 rounded-md text-muted hover:text-foreground hover:bg-accent/40">By me</button>
        </div>
        <div data-audit-sample="shared-empty" class="px-2 py-4 text-[12px] text-muted leading-relaxed">Nothing shared with you yet.</div>
      </div>
      <div class="w-[215px] rounded-lg border border-border bg-surface shadow-xl overflow-hidden">
        <div class="px-2 py-1.5 flex items-center gap-1.5 border-b border-border">
          <input value="agent" class="flex-1 text-[12px] bg-background border border-border rounded-md px-2 py-1 text-foreground outline-none" />
          <button data-audit-sample="skills-path-toggle" class="px-1.5 py-0.5 rounded text-[11px] bg-accent text-foreground">~/</button>
        </div>
        <div data-audit-sample="skills-heading" class="text-[9px] uppercase tracking-wide text-muted px-2 pt-3 pb-1">Codex <span class="ml-1 text-muted">3</span></div>
        <div class="flex items-center gap-1 px-2 py-1 hover:bg-accent/30">
          <div class="min-w-0 flex-1">
            <div data-audit-sample="skills-row" class="truncate text-[12px] text-foreground/90">AGENTS.md</div>
            <div data-audit-sample="skills-path" class="truncate text-[10px] text-muted">~/project</div>
          </div>
          <button data-audit-sample="skills-star" class="shrink-0 px-1 text-[12px] text-[var(--status-yellow)]">★</button>
        </div>
      </div>\`;
    document.body.appendChild(sidePanels);
    const pdfMenu = document.createElement('div');
    pdfMenu.setAttribute('data-audit-surface', 'pdf-menu-probe');
    pdfMenu.className = 'fixed top-[58px] left-[390px] z-[90] bg-surface-2 border border-border rounded-lg shadow-xl py-1 min-w-[140px]';
    pdfMenu.innerHTML = \`
      <button class="w-full text-left px-3 py-1.5 text-[12px] text-muted hover:text-foreground hover:bg-accent/50 flex items-center gap-2">
        <span class="w-3 h-3 rounded-sm bg-zinc-800 border border-zinc-600 shrink-0"></span>
        Export Dark
      </button>
      <button class="w-full text-left px-3 py-1.5 text-[12px] text-muted hover:text-foreground hover:bg-accent/50 flex items-center gap-2">
        <span class="w-3 h-3 rounded-sm bg-white border border-zinc-300 shrink-0"></span>
        Export Light
      </button>\`;
    document.body.appendChild(pdfMenu);
  })()`);
  screenshots.library = await capture(cdp, "03-library");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 760,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  screenshots.sidePanelsNarrow = await capture(cdp, "03b-side-panels-narrow");
  await cdp.send("Emulation.clearDeviceMetricsOverride");

  await cdp.ev("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))");
  await waitFor("command palette", () => cdp.ev("!!document.querySelector('input[placeholder^=\"Type a command\"]')"));
  screenshots.commandPalette = await capture(cdp, "04-command-palette");
  await cdp.ev("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");

  await cdp.ev(`(() => {
    const existing = document.querySelector('[data-audit-surface="settings-probe"]');
    if (existing) existing.remove();
    const modal = document.createElement('section');
    modal.setAttribute('data-audit-surface', 'settings-probe');
    modal.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/40';
    modal.innerHTML = \`
      <div class="w-[440px] max-w-[92vw] max-h-[84vh] overflow-y-auto rounded-xl border border-border shadow-2xl p-5" style="background: var(--surface-2)">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-[14px] font-semibold text-foreground">Settings</h2>
          <button aria-label="Close settings" class="text-muted hover:text-foreground">x</button>
        </div>
        <div class="text-[10px] uppercase tracking-wide text-muted mb-2">Account</div>
        <div class="mb-5 space-y-2">
          <input class="w-full text-[13px] bg-background border border-border rounded-md px-3 py-2 text-foreground outline-none focus:border-foreground/30" placeholder="Email" type="email" value="person@example.com" />
          <input class="w-full text-[13px] bg-background border border-border rounded-md px-3 py-2 text-foreground outline-none focus:border-foreground/30" placeholder="Password" type="password" value="password" />
          <button class="w-full text-[13px] py-2 rounded-md bg-accent text-foreground">Sign in</button>
          <button class="w-full text-[13px] py-2 rounded-md border border-border text-foreground/90 hover:bg-accent/40">Continue with Google</button>
        </div>
        <button class="text-[11px] text-muted hover:text-foreground">Advanced...</button>
      </div>\`;
    document.body.appendChild(modal);
  })()`);
  screenshots.settings = await capture(cdp, "05-settings");

  await cdp.ev(`(() => {
    const existing = document.querySelector('[data-light-audit-probes]');
    if (existing) existing.remove();
    const host = document.createElement('div');
    host.setAttribute('data-light-audit-probes', 'true');
    host.className = 'fixed inset-0 z-[120] grid grid-cols-3 content-start gap-4 overflow-auto bg-black/20 p-5';
    host.innerHTML = \`
      <section data-audit-surface="stats-panel-probe" class="w-[240px] rounded-lg border border-border shadow-xl py-2" style="background: var(--surface-2)">
        <div class="flex items-center justify-between px-3 pb-1.5 border-b border-border">
          <span class="text-[11px] font-semibold uppercase tracking-wide text-muted">Statistics</span>
          <button aria-label="Close statistics" class="text-muted hover:text-foreground text-[13px] leading-none">x</button>
        </div>
        <div class="flex items-center justify-between px-3 py-1">
          <span data-audit-sample="stats-label" class="text-[12px] text-muted">Words</span>
          <span data-audit-sample="stats-value" class="text-[12px] text-foreground tabular-nums">1,248</span>
        </div>
      </section>
      <section data-audit-surface="theme-settings-probe" class="w-[340px] rounded-xl border border-border shadow-2xl p-5" style="background: var(--surface-2)">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-[14px] font-semibold text-foreground">Theme</h2>
          <button aria-label="Close theme settings" class="text-muted hover:text-foreground">x</button>
        </div>
        <div class="flex flex-wrap gap-2 mb-5">
          <button data-audit-sample="theme-active-preset" class="px-3 py-1.5 rounded-md text-[12px] border border-foreground/40 text-foreground bg-accent">Markie Light</button>
          <button data-audit-sample="theme-idle-preset" class="px-3 py-1.5 rounded-md text-[12px] border border-border text-muted hover:text-foreground">Markie Dark</button>
        </div>
        <label class="flex items-center justify-between text-[12px] text-muted">
          Text
          <input type="color" value="#18181b" class="w-8 h-6 rounded border border-border bg-transparent cursor-pointer" />
        </label>
        <label class="flex items-center justify-between text-[12px] text-muted mt-3">
          Font size - 16px
          <input type="range" min="13" max="22" value="16" class="w-36" />
        </label>
      </section>
      <section data-audit-surface="agents-dialog-probe" class="w-[360px] rounded-xl border border-border shadow-2xl p-5" style="background: var(--surface-2)">
        <div class="flex items-center justify-between mb-1">
          <h2 class="text-[14px] font-semibold text-foreground">Connect an agent to Markie</h2>
          <button aria-label="Close" class="text-muted hover:text-foreground">x</button>
        </div>
        <p class="text-[12px] text-muted leading-relaxed mb-4">Markie ships a local <strong>MCP server</strong> that gives an agent markdown-aware access.</p>
        <div class="text-[10px] uppercase tracking-wide text-muted mb-1.5">Tools it gives your agent</div>
        <div class="flex gap-2 text-[12px]">
          <code data-audit-sample="agents-tool-name" class="text-foreground/90 shrink-0">markie_read_md</code>
          <span data-audit-sample="agents-tool-description" class="text-muted truncate">- read a markdown file</span>
        </div>
        <div class="mt-3">
          <span class="text-[10px] uppercase tracking-wide text-muted">Claude Code - run this in your terminal</span>
          <button data-audit-sample="agents-copy-button" class="float-right text-[11px] px-2 py-0.5 rounded-md bg-accent text-foreground">Copy</button>
          <pre data-audit-sample="agents-copy-block" class="mt-2 text-[11.5px] leading-relaxed bg-background border border-border rounded-md p-2.5 overflow-x-auto text-foreground/90 whitespace-pre-wrap break-all">claude mcp add markie -- node /Applications/Markie.app/server.mjs</pre>
        </div>
        <p data-audit-sample="agents-warning" class="text-[11px] text-[var(--status-yellow)] leading-relaxed mt-3">Open this from the Markie desktop app to auto-fill the exact server path.</p>
      </section>
      <section data-audit-surface="share-dialog-probe" class="w-[440px] max-w-[92vw] rounded-xl border border-border shadow-2xl p-5" style="background: var(--surface-2)">
        <div class="flex items-center justify-between mb-1">
          <h2 class="text-[14px] font-semibold text-foreground">Share</h2>
          <button aria-label="Close share dialog" class="text-muted hover:text-foreground">x</button>
        </div>
        <div class="text-[11px] text-muted mb-4 truncate">audit-fixture.md</div>
        <div class="flex gap-2">
          <input value="person@example.com" class="flex-1 text-[13px] bg-background border border-border rounded-md px-2.5 py-1.5 text-foreground outline-none" />
          <button class="text-[13px] px-3 rounded-md bg-accent text-foreground">Invite</button>
        </div>
        <div class="text-[10px] uppercase tracking-wide text-muted mt-4 mb-2">People with access</div>
        <div class="text-[12px] text-muted">Not shared with anyone yet.</div>
        <div data-audit-sample="share-success" class="text-[12px] text-[var(--status-green)] mt-2">Shared with person@example.com.</div>
        <div data-audit-sample="share-error" class="text-[12px] text-[var(--status-red)] mt-2">Couldn't create a public link.</div>
        <button data-audit-sample="share-revoke" class="mt-2 text-[11px] text-[var(--status-red)]">Revoke</button>
      </section>
      <section data-audit-surface="comments-probe" class="w-[300px] rounded-lg border border-border shadow-xl p-2.5 flex flex-col gap-2" style="background: var(--surface-2)">
        <div class="flex items-center justify-between">
          <span class="text-[10px] uppercase tracking-wide text-muted">Open</span>
          <button class="text-[11px] text-muted hover:text-foreground">Resolve</button>
        </div>
        <div class="flex gap-2">
          <span class="w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-semibold text-black/80 shrink-0 mt-0.5" style="background:#93c5fd">AL</span>
          <div class="flex-1 min-w-0">
            <div class="text-[11px] font-medium text-foreground truncate">Alice</div>
            <div class="text-[12px] text-foreground/90 whitespace-pre-wrap break-words">Can we tighten this intro?</div>
          </div>
        </div>
        <div class="flex items-center justify-between">
          <span data-audit-sample="comments-resolved" class="text-[10px] uppercase tracking-wide text-[var(--status-green)]">Resolved</span>
          <button data-audit-sample="comments-delete" class="text-[11px] text-[var(--status-red)]">Delete</button>
        </div>
        <textarea rows="2" class="text-[12px] bg-background border border-border rounded-md px-2 py-1.5 text-foreground outline-none resize-none">Reply...</textarea>
        <button class="self-end text-[11px] px-2.5 py-1 rounded-md bg-accent text-foreground">Send</button>
      </section>\`;
    document.body.appendChild(host);
  })()`);
  screenshots.gatedSurfaceProbes = await capture(cdp, "06-share-comments-probes");

  const audit = await cdp.ev(`(() => {
    const rgba = (value) => {
      const raw = String(value).trim();
      const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
      const gamma = (n) => {
        const v = Math.max(0, Math.min(1, n));
        return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
      };
      if (raw === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
      const hex = raw.match(/^#([0-9a-f]{6})$/i);
      if (hex) {
        return {
          r: Number.parseInt(hex[1].slice(0, 2), 16),
          g: Number.parseInt(hex[1].slice(2, 4), 16),
          b: Number.parseInt(hex[1].slice(4, 6), 16),
          a: 1
        };
      }
      const srgb = raw.match(/^color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*([\\d.]+))?\\)$/);
      if (srgb) {
        return {
          r: Math.round(Number.parseFloat(srgb[1]) * 255),
          g: Math.round(Number.parseFloat(srgb[2]) * 255),
          b: Math.round(Number.parseFloat(srgb[3]) * 255),
          a: srgb[4] ? Number.parseFloat(srgb[4]) : 1
        };
      }
      const oklab = raw.match(/^oklab\\(([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)(?:\\s*\\/\\s*([\\d.]+))?\\)$/);
      if (oklab) {
        const L = Number.parseFloat(oklab[1]);
        const A = Number.parseFloat(oklab[2]);
        const B = Number.parseFloat(oklab[3]);
        const lPrime = L + 0.3963377774 * A + 0.2158037573 * B;
        const mPrime = L - 0.1055613458 * A - 0.0638541728 * B;
        const sPrime = L - 0.0894841775 * A - 1.2914855480 * B;
        const l = lPrime ** 3;
        const m = mPrime ** 3;
        const s = sPrime ** 3;
        const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
        const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
        const b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
        return {
          r: clamp(gamma(r) * 255),
          g: clamp(gamma(g) * 255),
          b: clamp(gamma(b) * 255),
          a: oklab[4] ? Number.parseFloat(oklab[4]) : 1
        };
      }
      const lab = raw.match(/^lab\\(([-\\d.]+)%?\\s+([-\\d.]+)\\s+([-\\d.]+)(?:\\s*\\/\\s*([\\d.]+))?\\)$/);
      if (lab) {
        const L = Number.parseFloat(lab[1]);
        const A = Number.parseFloat(lab[2]);
        const B = Number.parseFloat(lab[3]);
        const fInv = (t) => {
          const delta = 6 / 29;
          return t > delta ? t ** 3 : 3 * delta ** 2 * (t - 4 / 29);
        };
        const fy = (L + 16) / 116;
        const fx = fy + A / 500;
        const fz = fy - B / 200;
        const x50 = 0.96422 * fInv(fx);
        const y50 = fInv(fy);
        const z50 = 0.82521 * fInv(fz);
        const x = 0.9555766 * x50 - 0.0230393 * y50 + 0.0631636 * z50;
        const y = -0.0282895 * x50 + 1.0099416 * y50 + 0.0210077 * z50;
        const z = 0.0122982 * x50 - 0.0204830 * y50 + 1.3299098 * z50;
        const r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
        const g = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z;
        const b = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
        return {
          r: clamp(gamma(r) * 255),
          g: clamp(gamma(g) * 255),
          b: clamp(gamma(b) * 255),
          a: lab[4] ? Number.parseFloat(lab[4]) : 1
        };
      }
      const match = raw.match(/rgba?\\(([^)]+)\\)/);
      if (!match) return null;
      const parts = match[1].split(',').map((p) => Number.parseFloat(p.trim()));
      return {
        r: parts[0],
        g: parts[1],
        b: parts[2],
        a: parts.length > 3 ? parts[3] : 1
      };
    };
    const blend = (fg, bg) => {
      const alpha = fg.a ?? 1;
      return {
        r: Math.round(fg.r * alpha + bg.r * (1 - alpha)),
        g: Math.round(fg.g * alpha + bg.g * (1 - alpha)),
        b: Math.round(fg.b * alpha + bg.b * (1 - alpha)),
        a: 1
      };
    };
    const luminance = ({ r, g, b }) => {
      const chan = [r, g, b].map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
    };
    const ratio = (fg, bg) => {
      const l1 = luminance(fg);
      const l2 = luminance(bg);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    const effectiveBackground = (el) => {
      let node = el;
      while (node && node.nodeType === 1) {
        const bg = rgba(getComputedStyle(node).backgroundColor);
        if (bg && bg.a > 0) return bg.a < 1 ? blend(bg, { r: 250, g: 250, b: 250, a: 1 }) : bg;
        node = node.parentElement;
      }
      return { r: 250, g: 250, b: 250, a: 1 };
    };
    const cssPath = (el) => {
      const bits = [];
      let node = el;
      while (node && node.nodeType === 1 && bits.length < 5) {
        let bit = node.tagName.toLowerCase();
        const label = node.getAttribute('aria-label') || node.getAttribute('title');
        if (label) bit += '[' + label.replace(/\\s+/g, ' ').slice(0, 40) + ']';
        else if (node.id) bit += '#' + node.id;
        else if (node.className && typeof node.className === 'string') {
          bit += '.' + node.className.split(/\\s+/).slice(0, 2).join('.');
        }
        bits.unshift(bit);
        node = node.parentElement;
      }
      return bits.join(' > ');
    };
    const text = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const findText = (needle) => [...document.querySelectorAll('button,input,textarea,h1,h2,h3,span,div,p,code,article')]
      .find((el) => text(el).includes(needle));
    const samples = [
      ['toolbar', [...document.querySelectorAll('span')].find((el) => text(el) === 'Markie')],
      ['toolbar file control', [...document.querySelectorAll('button')].find((el) => text(el).includes('Open file'))],
      ['toolbar PDF menu dark option', [...document.querySelectorAll('[data-audit-surface="pdf-menu-probe"] button')].find((el) => text(el).includes('Export Dark'))],
      ['toolbar PDF menu light option', [...document.querySelectorAll('[data-audit-surface="pdf-menu-probe"] button')].find((el) => text(el).includes('Export Light'))],
      ['left rail library button', document.querySelector('button[aria-label^="Library"]')],
      ['left rail sign-in button', document.querySelector('button[aria-label="Sign in"]')],
      ['library heading', document.querySelector('[data-audit-sample="library-heading"]')],
      ['library body', document.querySelector('[data-audit-sample="library-empty"]')],
      ['library synced badge', document.querySelector('[data-audit-sample="library-synced-badge"]')],
      ['library shared badge', document.querySelector('[data-audit-sample="library-shared-badge"]')],
      ['library download action', document.querySelector('[data-audit-sample="library-download-action"]')],
      ['library trash action', document.querySelector('[data-audit-sample="library-trash-action"]')],
      ['library sign-in prompt', document.querySelector('[data-audit-sample="library-sign-in-prompt"]')],
      ['browse heading', document.querySelector('[data-audit-sample="browse-heading"]')],
      ['browse row', document.querySelector('[data-audit-sample="browse-row"]')],
      ['browse count', document.querySelector('[data-audit-sample="browse-count"]')],
      ['browse starred state', document.querySelector('[data-audit-sample="browse-star"]')],
      ['files heading', document.querySelector('[data-audit-sample="files-heading"]')],
      ['files row', document.querySelector('[data-audit-sample="files-row"]')],
      ['files empty state', document.querySelector('[data-audit-sample="files-empty"]')],
      ['files trash action', document.querySelector('[data-audit-sample="files-trash-action"]')],
      ['shared active tab', document.querySelector('[data-audit-sample="shared-tab-active"]')],
      ['shared idle tab', document.querySelector('[data-audit-sample="shared-tab-idle"]')],
      ['shared empty state', document.querySelector('[data-audit-sample="shared-empty"]')],
      ['skills path toggle', document.querySelector('[data-audit-sample="skills-path-toggle"]')],
      ['skills heading', document.querySelector('[data-audit-sample="skills-heading"]')],
      ['skills row', document.querySelector('[data-audit-sample="skills-row"]')],
      ['skills path', document.querySelector('[data-audit-sample="skills-path"]')],
      ['skills starred state', document.querySelector('[data-audit-sample="skills-star"]')],
      ['editor rich article', document.querySelector('.markdown-body')],
      ['editor heading', document.querySelector('.markdown-body h1')],
      ['editor strong text', document.querySelector('.markdown-body strong')],
      ['editor link', document.querySelector('.markdown-body a')],
      ['editor inline code', [...document.querySelectorAll('.markdown-body code')].find((el) => !el.closest('pre'))],
      ['editor code block', document.querySelector('.markdown-body pre code')],
      ['editor blockquote', document.querySelector('.markdown-body blockquote')],
      ['editor table heading', document.querySelector('.markdown-body th')],
      ['editor table cell', document.querySelector('.markdown-body td')],
      ['editor task checkbox', document.querySelector('.markdown-body input[type="checkbox"]')],
      ['editor math text', findText('E = mc')],
      ['command palette input', document.querySelector('input[placeholder^="Type a command"]')],
      ['command palette row', findText('Open File')],
      ['settings heading', [...document.querySelectorAll('h2')].find((el) => text(el) === 'Settings')],
      ['settings email input', document.querySelector('input[type="email"]')],
      ['settings google button', findText('Continue with Google')],
      ['stats heading', document.querySelector('[data-audit-surface="stats-panel-probe"] span')],
      ['stats value', document.querySelector('[data-audit-sample="stats-value"]')],
      ['theme settings heading', document.querySelector('[data-audit-surface="theme-settings-probe"] h2')],
      ['theme settings active preset', document.querySelector('[data-audit-sample="theme-active-preset"]')],
      ['theme settings idle preset', document.querySelector('[data-audit-sample="theme-idle-preset"]')],
      ['theme settings field label', [...document.querySelectorAll('[data-audit-surface="theme-settings-probe"] label')].find((el) => text(el).includes('Text'))],
      ['agents heading', document.querySelector('[data-audit-surface="agents-dialog-probe"] h2')],
      ['agents description', document.querySelector('[data-audit-sample="agents-tool-description"]')],
      ['agents copy button', document.querySelector('[data-audit-sample="agents-copy-button"]')],
      ['agents copy block', document.querySelector('[data-audit-sample="agents-copy-block"]')],
      ['agents warning', document.querySelector('[data-audit-sample="agents-warning"]')],
      ['share dialog heading', document.querySelector('[data-audit-surface="share-dialog-probe"] h2')],
      ['share dialog filename', document.querySelector('[data-audit-surface="share-dialog-probe"] .text-muted')],
      ['share dialog invite button', [...document.querySelectorAll('[data-audit-surface="share-dialog-probe"] button')].find((el) => text(el) === 'Invite')],
      ['share dialog success', document.querySelector('[data-audit-sample="share-success"]')],
      ['share dialog error', document.querySelector('[data-audit-sample="share-error"]')],
      ['share dialog revoke', document.querySelector('[data-audit-sample="share-revoke"]')],
      ['comments status', document.querySelector('[data-audit-surface="comments-probe"] span.text-muted')],
      ['comments body', findText('Can we tighten')],
      ['comments resolved status', document.querySelector('[data-audit-sample="comments-resolved"]')],
      ['comments delete action', document.querySelector('[data-audit-sample="comments-delete"]')],
      ['comments composer', document.querySelector('[data-audit-surface="comments-probe"] textarea')],
      ['comments send button', [...document.querySelectorAll('[data-audit-surface="comments-probe"] button')].find((el) => text(el) === 'Send')]
    ];
    const results = samples.map(([label, el]) => {
      if (!el) return { label, present: false, issue: 'missing audit target' };
      const style = getComputedStyle(el);
      const fgRaw = rgba(style.color);
      const bgRaw = effectiveBackground(el);
      const fg = fgRaw && fgRaw.a < 1 ? blend(fgRaw, bgRaw) : fgRaw;
      const contrast = fg ? ratio(fg, bgRaw) : 0;
      return {
        label,
        present: true,
        text: text(el),
        selector: cssPath(el),
        color: style.color,
        backgroundColor: getComputedStyle(el).backgroundColor,
        effectiveBackground: 'rgb(' + bgRaw.r + ', ' + bgRaw.g + ', ' + bgRaw.b + ')',
        contrast: Number(contrast.toFixed(2)),
        passesAA: contrast >= 4.5
      };
    });
    const surfaces = ['toolbar', 'editor/rich view', 'left rail', 'library', 'browse', 'files', 'shared', 'skills/agents', 'command palette', 'settings', 'theme settings', 'stats', 'share dialog', 'agents', 'comments'];
    const sidePanelLabels = new Set([
      'library heading',
      'library body',
      'library synced badge',
      'library shared badge',
      'library download action',
      'library trash action',
      'library sign-in prompt',
      'browse heading',
      'browse row',
      'browse count',
      'browse starred state',
      'files heading',
      'files row',
      'files empty state',
      'files trash action',
      'shared active tab',
      'shared idle tab',
      'shared empty state',
      'skills path toggle',
      'skills heading',
      'skills row',
      'skills path',
      'skills starred state'
    ]);
    const contentLabels = new Set([
      'editor rich article',
      'editor heading',
      'editor strong text',
      'editor link',
      'editor inline code',
      'editor code block',
      'editor blockquote',
      'editor table heading',
      'editor table cell',
      'editor task checkbox',
      'editor math text'
    ]);
    const sidePanelFindings = results.filter((item) => sidePanelLabels.has(item.label) && (!item.present || !item.passesAA));
    const contentFindings = results.filter((item) => contentLabels.has(item.label) && (!item.present || !item.passesAA));
    return {
      ok: results.every((item) => item.present),
      mode: 'light',
      threshold: 4.5,
      tokens: Object.fromEntries(['--background', '--surface', '--surface-2', '--foreground', '--muted', '--border', '--accent', '--blue', '--status-green', '--status-yellow', '--status-red', '--status-blue', '--status-purple'].map((name) => [name, getComputedStyle(document.documentElement).getPropertyValue(name).trim()])),
      surfaces,
      sidePanelSamples: results.filter((item) => sidePanelLabels.has(item.label)),
      sidePanelFindings,
      contentSamples: results.filter((item) => contentLabels.has(item.label)),
      contentFindings,
      samples: results,
      findings: results.filter((item) => !item.present || !item.passesAA).map((item) => ({
        surface: item.label,
        issue: item.issue ?? 'contrast below AA threshold',
        text: item.text ?? '',
        contrast: item.contrast ?? null,
        selector: item.selector ?? null,
        checklist: 'Review and fix this surface in the dedicated light-mode style pass.'
      }))
    };
  })()`);

  const regressionGuard = buildRegressionGuard(audit);
  const artifact = {
    ...audit,
    artifactDir,
    screenshots,
    regressionGuard,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(artifactDir, "audit.json"), `${JSON.stringify(artifact, null, 2)}\n`);

  if (!artifact.ok) {
    throw new Error("light-mode audit missed one or more required targets");
  }

  if (regressionGuardEnabled && !artifact.regressionGuard.passes) {
    const failedCategories = Object.entries(artifact.regressionGuard.categories)
      .filter(([, category]) => !category.passes)
      .map(([name, category]) => `${name}: ${category.failures.length} contrast failures`);
    throw new Error(`theme visual regression guard failed (${failedCategories.join("; ")})`);
  }

  console.log(JSON.stringify({
    ok: true,
    regressionGuard: artifact.regressionGuard,
    artifact: path.join(artifactDir, "audit.json"),
    screenshots,
    findings: artifact.findings.length,
  }, null, 2));

  cdp.close();
}

try {
  await main();
} finally {
  await stopChildren();
  await Promise.allSettled(tempPaths.map((p) => rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })));
}
