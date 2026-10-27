// The real server process, started the way the container starts it, then
// stopped the way `docker stop` and Fly stop it. Before the stop handler,
// SIGTERM did nothing to Node as PID 1, so `docker stop` waited out its full
// timeout and then killed it with every database handle open.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));

// A test that fails before its own kill must not leave a server running.
const children: ReturnType<typeof spawn>[] = [];
after(() => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function boot(extraEnv: Record<string, string>) {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "markie-stop-"));
  const dbPath = join(dir, "markie.db");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "development",
    PORT: String(port),
    DB_PATH: dbPath,
    BETTER_AUTH_URL: `http://localhost:${port}`,
    BETTER_AUTH_SECRET: "markie-process-stop-test-secret-32-plus",
    MARKIE_MAIL_LOG: "1",
    ...extraEnv,
  };
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], { cwd: SERVER_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 20_000;
  while (!output.includes("markie-api listening")) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`server did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  return { child, port, dbPath, exited, output: () => output };
}

test("SIGTERM stops the server inside the 3 s deadline, exit 0, with every database handle closed", async () => {
  const server = await boot({});
  const health = await fetch(`http://127.0.0.1:${server.port}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: "markie-api", version: "0.1.0" });
  assert.ok(existsSync(`${server.dbPath}-wal`), "the database runs in WAL mode");

  const started = Date.now();
  server.child.kill("SIGTERM");
  const { code, signal } = await server.exited;
  const took = Date.now() - started;
  assert.equal(signal, null, server.output());
  assert.equal(code, 0, server.output());
  assert.ok(took < 3000, `took ${took} ms`);
  assert.match(server.output(), /markie-api: SIGTERM received, stopping/);
  // SQLite folds the WAL back in and deletes it when the last handle on the
  // file closes. A -wal left behind means a handle was still open at exit.
  assert.equal(existsSync(`${server.dbPath}-wal`), false, "every handle was closed");
});

test("SIGINT, which Fly sends, stops it the same way", async () => {
  const server = await boot({});
  server.child.kill("SIGINT");
  const { code } = await server.exited;
  assert.equal(code, 0, server.output());
  assert.match(server.output(), /markie-api: SIGINT received, stopping/);
});

test("ENABLE_CRONS=false says so at boot; KAMAL_VERSION shows on /health", async () => {
  const server = await boot({ ENABLE_CRONS: "false", KAMAL_VERSION: "0123abcdef" });
  assert.match(server.output(), /ENABLE_CRONS is off/);
  const health = await fetch(`http://127.0.0.1:${server.port}/health`);
  assert.deepEqual(await health.json(), { ok: true, service: "markie-api", version: "0.1.0", commit: "0123abcdef" });
  server.child.kill("SIGTERM");
  assert.equal((await server.exited).code, 0);
});
