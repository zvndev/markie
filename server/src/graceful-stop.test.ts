import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gracefulStop } from "./graceful-stop.ts";

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port })));
}

function get(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/", agent: false }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("a stop lets the request in flight finish, then releases and exits 0", async () => {
  let reply: (() => void) | undefined;
  const { server, port } = await listen((_req, res) => {
    reply = () => res.end("done");
  });
  const steps: string[] = [];
  const exits: number[] = [];
  const stop = gracefulStop({
    name: "test", server, deadlineMs: 2000, log: () => {},
    stopAccepting: () => steps.push("stopAccepting"),
    force: () => steps.push("force"),
    release: () => steps.push("release"),
    exit: (code) => exits.push(code),
  });
  const inFlight = get(port);
  while (!reply) await new Promise((r) => setTimeout(r, 5));
  const stopped = stop("SIGTERM");
  assert.deepEqual(steps, ["stopAccepting"]);
  await assert.rejects(get(port), "a stopping server takes no new connection");
  reply();
  assert.deepEqual(await inFlight, { status: 200, body: "done" });
  await stopped;
  assert.deepEqual(steps, ["stopAccepting", "release"]);
  assert.deepEqual(exits, [0]);
});

test("a request still open at the deadline is cut, and the stop still releases and exits 0", async () => {
  const { server, port } = await listen(() => {
    // never answers
  });
  const steps: string[] = [];
  const exits: number[] = [];
  const stop = gracefulStop({
    name: "test", server, deadlineMs: 100, log: () => {},
    force: () => steps.push("force"),
    release: () => steps.push("release"),
    exit: (code) => exits.push(code),
  });
  const hung = get(port).catch((err: Error) => err);
  await new Promise((r) => setTimeout(r, 20));
  const started = Date.now();
  await stop("SIGTERM");
  assert.ok(Date.now() - started < 1000);
  assert.ok((await hung) instanceof Error, "the hung request was cut");
  assert.deepEqual(steps, ["force", "release"]);
  assert.deepEqual(exits, [0]);
});

test("a second signal while stopping changes nothing, and a failing step does not stop the rest", async () => {
  const { server } = await listen((_req, res) => res.end());
  const exits: number[] = [];
  const lines: string[] = [];
  let released = 0;
  const stop = gracefulStop({
    name: "test", server, log: (line) => lines.push(line),
    stopAccepting: () => {
      throw new Error("boom");
    },
    release: () => {
      released += 1;
    },
    exit: (code) => exits.push(code),
  });
  const first = stop("SIGTERM");
  const second = stop("SIGINT");
  assert.equal(first, second);
  await first;
  assert.equal(released, 1);
  assert.deepEqual(exits, [0]);
  assert.ok(lines.some((line) => line.includes("stopAccepting failed while stopping: boom")));
});
