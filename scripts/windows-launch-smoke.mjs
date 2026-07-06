#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PRODUCT_NAME = "Markie";
const DEFAULT_TIMEOUT_MS = 45000;
const SCREENSHOT_FILE_NAME = "screenshot.png";
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function assertWindowsHost(platform = process.platform) {
  if (platform !== "win32") {
    throw new Error(`Windows launch smoke must run on win32; current platform is ${platform}`);
  }
}

export function windowsExecutablePath(
  baseDir,
  { distDir = "dist", productName = DEFAULT_PRODUCT_NAME } = {}
) {
  return path.join(baseDir, distDir, "win-unpacked", `${productName}.exe`);
}

export function resolveWindowsApp(
  baseDir,
  { distDir = "dist", productName = DEFAULT_PRODUCT_NAME } = {}
) {
  const executable = windowsExecutablePath(baseDir, { distDir, productName });
  if (!existsSync(executable)) {
    throw new Error(`missing Windows executable: ${executable}; run npm run electron:pack:win first`);
  }
  if (!statSync(executable).isFile()) {
    throw new Error(`Windows executable path is not a file: ${executable}`);
  }
  return {
    appDir: path.dirname(executable),
    executable,
  };
}

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

export function buildWindowsLaunchSmokeArtifact({
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
  if (!app?.executable || !app?.appDir) {
    throw new Error("Windows launch smoke artifact requires an app directory and executable");
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
      layout: "win-unpacked",
    },
    app: {
      appDir: app.appDir,
      executable: app.executable,
    },
    debugOrigin,
    target,
    probe,
    validation: validation || null,
    screenshot: screenshot || null,
  };
}

export function selectPageTarget(targets, allowedOrigins = []) {
  const pageTargets = targets.filter(
    (target) =>
      target?.type === "page" &&
      typeof target.webSocketDebuggerUrl === "string" &&
      !String(target.url || "").startsWith("devtools://")
  );
  const markieTarget = pageTargets.find((target) => /markie|markdown viewer/i.test(target.title || ""));
  if (markieTarget) return markieTarget;
  return pageTargets.find((target) => {
    const url = String(target.url || "");
    return (
      url.startsWith("app://") ||
      url.startsWith("file://") ||
      allowedOrigins.some((origin) => url.startsWith(origin))
    );
  }) || null;
}

export function validateRendererProbe(probe) {
  const failures = [];
  if (!probe || typeof probe !== "object") {
    return { ok: false, failures: ["renderer probe did not return an object"] };
  }
  if (!["interactive", "complete"].includes(probe.readyState)) {
    failures.push(`document.readyState is ${probe.readyState || "unknown"}`);
  }
  if (!/markie|markdown viewer/i.test(String(probe.title || ""))) {
    failures.push(`window title is not Markie: ${probe.title || "(empty)"}`);
  }
  if (!probe.hasEditor && !/markie|library|markdown/i.test(String(probe.bodyText || ""))) {
    failures.push("renderer body does not contain expected Markie UI");
  }
  return { ok: failures.length === 0, failures };
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
    throw new Error("Node 22 WebSocket support is required for Windows launch smoke");
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
    "Windows Electron CDP target",
    async () => {
      const response = await fetch(`${debugOrigin}/json`);
      if (!response.ok) return null;
      return selectPageTarget(await response.json());
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
    "Windows packaged renderer",
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

export async function capturePageScreenshot(cdp) {
  await cdp.send("Page.bringToFront").catch(() => null);
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  if (typeof result?.data !== "string" || result.data.length === 0) {
    throw new Error("CDP did not return screenshot data");
  }
  return Buffer.from(result.data, "base64");
}

function killWindowsProcessTree(pid) {
  if (!pid) return;
  const result = spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
    stdio: "ignore",
    shell: false,
  });
  if (result.status !== 0) {
    try {
      process.kill(pid);
    } catch {
      // Best-effort cleanup after taskkill failed.
    }
  }
}

function stamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

async function writeArtifact(baseDir, artifact, screenshotPng) {
  const artifactDir = path.join(baseDir, ".autoloop", "runs", `windows-launch-smoke-${stamp()}`);
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

export async function runWindowsLaunchSmoke({
  baseDir = rootDir,
  distDir = "dist",
  productName = DEFAULT_PRODUCT_NAME,
  debugPort,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  platform = process.platform,
  userDataDir,
} = {}) {
  assertWindowsHost(platform);
  const app = resolveWindowsApp(baseDir, { distDir, productName });
  const resolvedDebugPort = debugPort || (await pickPort());
  const debugOrigin = `http://127.0.0.1:${resolvedDebugPort}`;
  const tempUserDataDir = userDataDir || (await mkdtemp(path.join(tmpdir(), "markie-win-launch-")));
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
      "Windows packaged app process",
      async () => {
        if (spawnError) {
          throw spawnError;
        }
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
    const artifact = buildWindowsLaunchSmokeArtifact({
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
    killWindowsProcessTree(child.pid);
    if (!userDataDir) {
      await rm(tempUserDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
  }
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dist") options.distDir = argv[++i];
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
    "Usage: node scripts/windows-launch-smoke.mjs [--dist dist] [--timeout-ms 45000] [--json]",
    "",
    "Runs only on Windows. Launches dist/win-unpacked/Markie.exe, connects over CDP,",
    "and verifies the packaged renderer loads enough real Markie UI to be usable.",
  ].join("\n");
}

export async function runWindowsLaunchSmokeCli(
  argv = process.argv.slice(2),
  baseDir = rootDir
) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return { ok: true, help: true };
  }

  const result = await runWindowsLaunchSmoke({ ...options, baseDir });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[windows:launch-smoke] launched ${path.relative(baseDir, result.executable)}`);
    console.log(`[windows:launch-smoke] renderer ok: ${result.probe.title} (${result.probe.readyState})`);
    console.log(`[windows:launch-smoke] evidence: ${path.relative(baseDir, result.artifactPath)}`);
    if (result.screenshot?.path) {
      console.log(`[windows:launch-smoke] screenshot: ${path.relative(baseDir, result.screenshot.path)}`);
    }
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runWindowsLaunchSmokeCli().catch((error) => {
    console.error(`[windows:launch-smoke] failed: ${error.message}`);
    process.exitCode = 1;
  });
}
