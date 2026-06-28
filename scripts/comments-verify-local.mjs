#!/usr/bin/env node
// Local comments verifier: creates an isolated server DB, seeds Alice/Bob/doc
// with the existing setup script, then runs the comments API verifier. With
// --with-e2e it also launches the built Electron app and runs the UI/CDP verifier.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const serverDir = path.join(root, "server");
const require = createRequire(path.join(serverDir, "package.json"));
const WebSocket = require("ws");
const runDir = path.join(root, ".autoloop", "runs");
const node = process.execPath;
const withE2E = process.argv.includes("--with-e2e");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const baseEnv = {
  ...process.env,
  BETTER_AUTH_SECRET:
    process.env.BETTER_AUTH_SECRET ?? "markie-local-comments-verifier-secret-32",
};

await mkdir(runDir, { recursive: true });

const children = [];
const tempPaths = [];

function logPath(name) {
  return path.join(runDir, `${name}-${stamp}.log`);
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

async function runCapture(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? baseEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  const output = `${stdout}${stderr}`;
  if (options.log) await writeFile(options.log, output);
  if (code !== 0) {
    const err = new Error(`${command} ${args.join(" ")} exited ${code}`);
    err.output = output;
    throw err;
  }
  return { stdout, stderr, output };
}

async function waitFor(label, fn, timeoutMs = 30000) {
  const startMs = Date.now();
  let lastError;
  while (Date.now() - startMs < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function cdpConnect() {
  const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
  const page = targets.find(
    (t) =>
      t.type === "page" &&
      !t.url.startsWith("devtools://") &&
      (t.url.startsWith("app://") ||
        t.url.startsWith("http://localhost:3000") ||
        t.url.startsWith("http://127.0.0.1:3000") ||
        t.title?.startsWith("Markie"))
  );
  if (!page) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  let nextId = 1;
  const pending = new Map();
  ws.on("message", (m) => {
    const msg = JSON.parse(m);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const ev = (expression) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (msg) => {
        if (msg.result?.exceptionDetails) {
          reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
        } else {
          resolve(msg.result?.result?.value);
        }
      });
      ws.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        })
      );
    });
  return { ev, close: () => ws.close() };
}

async function bootstrapElectronForComments({ aliceToken, docId }) {
  const cdp = await waitFor("Electron CDP app target", cdpConnect, 30000);
  const server = "http://localhost:8787";
  await waitFor("Electron preload", () => cdp.ev("!!window.electronAPI"), 30000);
  await cdp.ev(`localStorage.setItem("markie.server.v1", ${JSON.stringify(server)})`);
  await cdp.ev(`localStorage.setItem("markie.token.v1", ${JSON.stringify(aliceToken)})`);
  await cdp.ev(
    `window.electronAPI.syncConfig({ token: ${JSON.stringify(aliceToken)}, serverURL: ${JSON.stringify(server)} })`
  );
  const opened = await cdp.ev(
    `window.electronAPI.docOpenShared({ cloudId: ${JSON.stringify(docId)}, suggestedName: "comments-e2e.md" }).then(JSON.stringify)`
  );
  const parsed = JSON.parse(opened);
  if (!parsed.ok) throw new Error(`docOpenShared failed: ${opened}`);
  await waitFor(
    "Alice collab session",
    () => cdp.ev("!!(window.__markieCollab && window.__markieCollab.provider.synced)"),
    30000
  );
  cdp.close();
}

async function main() {
  const dbDir = await mkdtemp(path.join(tmpdir(), "markie-comments-"));
  const userDataDir = await mkdtemp(path.join(tmpdir(), "markie-electron-user-"));
  tempPaths.push(dbDir, userDataDir);
  const dbPath = path.join(dbDir, "markie.db");
  const env = { ...baseEnv, DB_PATH: dbPath, PORT: "8787" };

  await runCapture(node, ["--experimental-strip-types", "src/migrate.ts"], {
    cwd: serverDir,
    env,
    log: logPath("comments-migrate"),
  });

  const server = start("npm", ["run", "start"], {
    cwd: serverDir,
    env,
    log: logPath("comments-server"),
  });
  await waitFor("server health", async () => {
    const res = await fetch("http://localhost:8787/health").catch(() => null);
    return res?.ok;
  });

  const setup = await runCapture(node, ["scripts/collab-e2e-setup.mjs"], {
    env,
    log: logPath("comments-setup"),
  });
  const seed = JSON.parse(setup.stdout);

  const apiLog = logPath("comments-api");
  const api = await runCapture(
    node,
    ["scripts/comments-api-verify.mjs", seed.aliceToken, seed.bobToken, seed.docId],
    { env, log: apiLog }
  );
  process.stdout.write(api.stdout);

  let e2eLog = null;
  if (withE2E) {
    const next = start("npm", ["run", "dev"], {
      env: baseEnv,
      log: logPath("comments-next"),
    });
    await waitFor("Next dev renderer", async () => {
      const res = await fetch("http://localhost:3000").catch(() => null);
      return !!res;
    }, 60000);
    const electronBin = path.join(root, "node_modules", ".bin", "electron");
    const electron = start(
      electronBin,
      [".", "--remote-debugging-port=9222", `--user-data-dir=${userDataDir}`],
      {
        env: { ...baseEnv, NODE_ENV: "development", DB_PATH: dbPath, MARKIE_E2E: "1" },
        log: logPath("comments-electron"),
      }
    );
    await bootstrapElectronForComments(seed);
    e2eLog = logPath("comments-e2e");
    const e2e = await runCapture(
      node,
      ["scripts/comments-e2e-verify.mjs", seed.aliceToken, seed.bobToken, seed.docId],
      { env, log: e2eLog }
    );
    process.stdout.write(e2e.stdout);
    electron.kill();
    next.kill();
  }

  server.kill();
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: withE2E ? "api+e2e" : "api",
        docId: seed.docId,
        logs: { api: apiLog, e2e: e2eLog },
      },
      null,
      2
    )
  );
}

try {
  await main();
} finally {
  for (const child of children) child.kill?.();
  await Promise.all(tempPaths.map((p) => rm(p, { recursive: true, force: true })));
}
