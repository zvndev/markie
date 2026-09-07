// One way to put the renderer's dev server in front of a check script.
//
// Every e2e script here needs the same thing: a dev server on a port it picked,
// running until the script is done with it. They each used to spawn `next dev`
// and then invent their own idea of "up" (a bare fetch that a Next error page
// satisfies just as well as a working renderer) and their own idea of "gone".
// Vite serves index.html directly, so readiness is a real question with a real
// answer: does the document with #root come back. Nothing here polls for
// longer than a dev server that starts in about a second deserves.
//
// The child is signalled through safeKill, so this never kills a process group
// and never matches on a command name. A `pkill -f vite` would take out every
// other project's dev server on the machine, which is not this module's to do.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeKill } from "./safe-kill.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Enough of the tail to show a port clash or a config error, not so much that
// a failing script buries its own message.
const TAIL_LINES = 20;

/**
 * Start the Vite dev server and resolve once it serves the renderer document.
 *
 * @param {object} options
 * @param {number} options.port      Port to bind; strict, so a clash fails loudly.
 * @param {string} [options.cwd]     Defaults to the repo root.
 * @param {object} [options.env]     Merged over process.env.
 * @param {string} [options.log]     Append the server's output to this file.
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ url: string, child: import("node:child_process").ChildProcess, stop: () => void }>}
 */
export async function startRendererDev({ port, cwd = repoRoot, env, log, timeoutMs = 60000 } = {}) {
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`startRendererDev needs a port, got ${JSON.stringify(port)}`);
  }
  const bin = path.join(repoRoot, "node_modules", ".bin", "vite");
  const child = spawn(bin, ["--port", String(port), "--strictPort", "--clearScreen", "false"], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const tail = [];
  const keep = (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      tail.push(line);
      if (tail.length > TAIL_LINES) tail.shift();
    }
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  if (log) {
    const stream = createWriteStream(log, { flags: "a" });
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
    child.on("exit", () => stream.end());
  }

  let exited = null;
  child.on("exit", (code, signal) => { exited = signal ? `signal ${signal}` : `code ${code}`; });
  child.on("error", (err) => { exited = err.message; });

  const stop = () => safeKill(child, "SIGKILL");
  // A script that dies before its own cleanup runs still must not leave a dev
  // server behind; stop() is idempotent, so the script calling it too is fine.
  process.on("exit", stop);

  const url = `http://localhost:${port}`;
  const fail = (why) => {
    stop();
    return new Error(
      `renderer dev server never answered on ${url}: ${why}` +
        (tail.length ? `\n  last output:\n${tail.map((l) => `    ${l}`).join("\n")}` : "")
    );
  };

  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (exited !== null) throw fail(`it exited with ${exited}`);
    try {
      // The timeout matters: something else on the port can accept the socket
      // and never answer, and a fetch with no deadline would hang past ours.
      const res = await fetch(`${url}/`, { signal: AbortSignal.timeout(2000) });
      // A 200 is not enough on its own: the document has to be the renderer's,
      // which is the one carrying the root Vite mounts into.
      if (res.ok && (await res.text()).includes('id="root"')) return { url, child, stop };
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw fail(`timed out after ${Math.round(timeoutMs / 1000)}s${lastError ? ` (${lastError.message})` : ""}`);
}
