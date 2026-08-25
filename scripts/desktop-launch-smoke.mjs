#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostSmokeMode, verifyPackageLayout } from "./package-smoke.mjs";
import { capturePageScreenshot, selectPageTarget, validateRendererProbe } from "./windows-launch-smoke.mjs";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";

// A real window on a real machine is a deliberate act; see the helper.
requireElectronConsent("desktop-launch-smoke", import.meta.url);


const DEFAULT_PRODUCT_NAME = "Markie";
const DEFAULT_TIMEOUT_MS = 45000;
const SCREENSHOT_FILE_NAME = "screenshot.png";
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readPackageMetadata(baseDir) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(baseDir, "package.json"), "utf8"));
    return {
      name: typeof parsed.name === "string" ? parsed.name : null,
      version: typeof parsed.version === "string" ? parsed.version : null,
    };
  } catch {
    return { name: null, version: null };
  }
}

export function resolveDesktopLaunchApp(
  baseDir,
  {
    platform = process.platform,
    arch = process.arch,
    distDir = "dist",
    productName = DEFAULT_PRODUCT_NAME,
    host,
  } = {}
) {
  const layout = verifyPackageLayout(baseDir, { platform, arch, distDir, productName });
  if (!layout.ok) {
    const failures = [...layout.missing, ...layout.binaryFailures].join(", ");
    throw new Error(`package layout is not launchable for ${layout.profile.id}: ${failures}`);
  }
  if (!layout.executable) {
    throw new Error(`package layout did not resolve an executable for ${layout.profile.id}`);
  }

  const launchMode = host ? hostSmokeMode(layout.profile, host) : layout.host;
  if (launchMode.mode === "structure-only") {
    throw new Error(`package cannot be launched on this host: ${launchMode.reason}`);
  }

  return {
    profile: layout.profile,
    host: launchMode,
    appDir: path.join(baseDir, layout.profile.appDir),
    executable: path.join(baseDir, layout.executable),
  };
}

export function buildDesktopLaunchSmokeArtifact({
  baseDir = rootDir,
  distDir = "dist",
  productName = DEFAULT_PRODUCT_NAME,
  app,
  debugOrigin,
  target,
  probe,
  validation,
  screenshot,
  generatedAt = new Date().toISOString(),
  platform = process.platform,
  arch = process.arch,
  versions = process.versions,
} = {}) {
  if (!app?.executable || !app?.appDir || !app?.profile || !app?.host) {
    throw new Error("desktop launch smoke artifact requires app profile, host mode, app directory, and executable");
  }

  const packageMetadata = readPackageMetadata(baseDir);
  return {
    ok: true,
    generatedAt,
    executable: app.executable,
    host: {
      platform,
      arch,
      node: versions?.node || null,
      electron: versions?.electron || null,
      chrome: versions?.chrome || null,
    },
    package: {
      ...packageMetadata,
      productName,
      distDir,
      profile: app.profile.id,
      layout: app.profile.appDir,
    },
    app: {
      appDir: app.appDir,
      executable: app.executable,
      launchMode: app.host,
    },
    debugOrigin,
    target,
    probe,
    validation: validation || null,
    screenshot: screenshot || null,
  };
}

async function pickPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === "string") {
          reject(new Error("could not allocate a local CDP port"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function waitFor(label, fn, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
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

async function openCdpClient(webSocketDebuggerUrl) {
  if (typeof WebSocket !== "function") {
    throw new Error("Node 22 WebSocket support is required for desktop launch smoke");
  }

  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", (event) => reject(event.error || new Error("CDP WebSocket failed")), {
      once: true,
    });
  });

  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (message) => {
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else if (message.result?.exceptionDetails) reject(new Error(JSON.stringify(message.result.exceptionDetails)));
        else resolve(message.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  return {
    send,
    evaluate: async (expression) => {
      const result = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      return result?.result?.value;
    },
    close: () => ws.close(),
  };
}

async function connectToPackage(debugOrigin, timeoutMs) {
  const target = await waitFor(
    "desktop Electron CDP target",
    async () => {
      const response = await fetch(`${debugOrigin}/json`);
      if (!response.ok) return null;
      return selectPageTarget(await response.json(), [debugOrigin]);
    },
    timeoutMs
  );

  const cdp = await openCdpClient(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  return { cdp, target };
}

async function probeRenderer(cdp, timeoutMs) {
  return waitFor(
    "desktop packaged renderer",
    async () => {
      const probe = await cdp.evaluate(`(() => ({
        title: document.title,
        readyState: document.readyState,
        url: location.href,
        bodyText: (document.body?.innerText || "").slice(0, 500),
        hasEditor: !!document.querySelector('[data-markie-document-area], [data-markie-rich-canvas], .ProseMirror')
      }))()`);
      const validation = validateRendererProbe(probe);
      return validation.ok ? { probe, validation } : null;
    },
    timeoutMs
  );
}

async function waitForExit(child, timeoutMs = 2000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function stopProcessTree(child, platform = process.platform) {
  if (!child?.pid) return;
  if (platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      shell: false,
    });
    return;
  }

  // Signal ONLY this child, never its process group. A negative-pid group kill
  // on macOS once reached session services (a recycled/LaunchServices-detached
  // pid) and took Finder down; see scripts/lib/safe-kill.mjs.
  if (child.exitCode !== null || child.signalCode !== null || child.killed) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  await waitForExit(child);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Best-effort cleanup after the app process already exited.
    }
  }
}

function stamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

async function writeArtifact(baseDir, artifact, screenshotPng) {
  const artifactDir = path.join(baseDir, ".autoloop", "runs", `desktop-launch-smoke-${artifact.package.profile}-${stamp()}`);
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, "launch-smoke.json");
  const persistedArtifact = { ...artifact, artifactPath };
  if (screenshotPng) {
    const screenshotPath = path.join(artifactDir, SCREENSHOT_FILE_NAME);
    await writeFile(screenshotPath, screenshotPng);
    persistedArtifact.screenshot = {
      ...(artifact.screenshot || {}),
      path: screenshotPath,
      bytes: screenshotPng.length,
      contentType: "image/png",
    };
  }
  await writeFile(artifactPath, `${JSON.stringify(persistedArtifact, null, 2)}\n`);
  return persistedArtifact;
}

export async function runDesktopLaunchSmoke({
  baseDir = rootDir,
  platform = process.platform,
  arch = process.arch,
  distDir = "dist",
  productName = DEFAULT_PRODUCT_NAME,
  debugPort,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  userDataDir,
} = {}) {
  const app = resolveDesktopLaunchApp(baseDir, { platform, arch, distDir, productName });
  const resolvedDebugPort = debugPort || (await pickPort());
  const debugOrigin = `http://127.0.0.1:${resolvedDebugPort}`;
  const tempUserDataDir = userDataDir || (await mkdtemp(path.join(tmpdir(), "markie-desktop-launch-")));
  const child = spawn(
    app.executable,
    [`--remote-debugging-port=${resolvedDebugPort}`, `--user-data-dir=${tempUserDataDir}`],
    {
      cwd: app.appDir,
      env: { ...process.env, MARKIE_E2E: "1" },
      stdio: "ignore",
      windowsHide: true,
    }
  );
  let exitInfo = null;
  let spawnError = null;
  child.once("error", (error) => {
    spawnError = error;
  });
  child.once("exit", (code, signal) => {
    exitInfo = { code, signal };
  });

  let cdp;
  try {
    const connected = await waitFor(
      "desktop packaged app process",
      async () => {
        if (spawnError) throw spawnError;
        if (exitInfo) {
          throw new Error(`Markie exited before CDP was available: ${JSON.stringify(exitInfo)}`);
        }
        return connectToPackage(debugOrigin, 1000).catch(() => null);
      },
      timeoutMs
    );
    cdp = connected.cdp;
    const renderer = await probeRenderer(cdp, timeoutMs);
    const screenshotPng = await capturePageScreenshot(cdp);
    const artifact = buildDesktopLaunchSmokeArtifact({
      baseDir,
      distDir,
      productName,
      app,
      debugOrigin,
      target: connected.target,
      probe: renderer.probe,
      validation: renderer.validation,
      screenshot: {
        fileName: SCREENSHOT_FILE_NAME,
        contentType: "image/png",
        bytes: screenshotPng.length,
      },
    });
    return await writeArtifact(baseDir, artifact, screenshotPng);
  } finally {
    cdp?.close();
    await stopProcessTree(child);
    if (!userDataDir) {
      await rm(tempUserDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
  }
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--platform") options.platform = argv[++i];
    else if (arg === "--arch") options.arch = argv[++i];
    else if (arg === "--dist") options.distDir = argv[++i];
    else if (arg === "--product-name") options.productName = argv[++i];
    else if (arg === "--debug-port") options.debugPort = Number(argv[++i]);
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++i]);
    else if (arg === "--user-data-dir") options.userDataDir = argv[++i];
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage: node scripts/desktop-launch-smoke.mjs [--platform mac|linux] [--arch arm64|x64] [--dist dist] [--json]",
    "",
    "Launches a host-compatible unpacked Electron package, connects over CDP,",
    "and verifies the packaged renderer loads enough real Markie UI to be usable.",
  ].join("\n");
}

export async function runDesktopLaunchSmokeCli(
  argv = process.argv.slice(2),
  baseDir = rootDir
) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return { ok: true, help: true };
  }

  const result = await runDesktopLaunchSmoke({ ...options, baseDir });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[desktop:launch-smoke] launched ${path.relative(baseDir, result.executable)}`);
    console.log(`[desktop:launch-smoke] renderer ok: ${result.probe.title} (${result.probe.readyState})`);
    console.log(`[desktop:launch-smoke] evidence: ${path.relative(baseDir, result.artifactPath)}`);
    if (result.screenshot?.path) {
      console.log(`[desktop:launch-smoke] screenshot: ${path.relative(baseDir, result.screenshot.path)}`);
    }
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runDesktopLaunchSmokeCli().catch((error) => {
    console.error(`[desktop:launch-smoke] failed: ${error.message}`);
    process.exitCode = 1;
  });
}
