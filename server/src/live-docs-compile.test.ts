// The hosted compile cannot hurt the server: a source over the size or
// complexity limits never starts a worker, a compile that runs too long is
// stopped, one that needs too much memory is stopped, and nothing about a
// stopped compile sticks to the document.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLiveDocCompiler, LIVE_DOC_COMPILER_VERSION, LIVE_DOC_SOURCE_LIMIT } from "./live-docs-compile.ts";

const PROVENANCE = (await import("./generated/darkmown/PROVENANCE.json", { with: { type: "json" } })).default as { version: string; commit: string };

test("a small Live Doc compiles in a worker to sanitized output", async () => {
  const compiler = createLiveDocCompiler();
  const result = await compiler.compile(':state count = 2\n\n# Hi\n\n{ count }\n\n:button "More" -> count++\n');
  assert.ok(result.ok, JSON.stringify(result));
  assert.match(result.page.bodyHtml, /<h1>Hi<\/h1>/);
  assert.match(result.page.bodyHtml, /<button data-wd-action="inc" data-wd-target="count" type="button">More<\/button>/);
  assert.deepEqual(result.page.seeds, ['{"count":2}']);
  assert.deepEqual(result.page.warnings, []);
  assert.equal(compiler.workersStarted(), 1);
});

test("the cache key names the pinned compiler", () => {
  assert.equal(LIVE_DOC_COMPILER_VERSION, `${PROVENANCE.version}+${PROVENANCE.commit.slice(0, 12)}`);
});

test("a source over 200,000 characters is refused without a worker", async () => {
  const compiler = createLiveDocCompiler();
  const result = await compiler.compile("a".repeat(LIVE_DOC_SOURCE_LIMIT + 1));
  assert.deepEqual(result, { ok: false, kind: "refused", message: "Live Docs can be up to 200,000 characters." });
  assert.equal(compiler.workersStarted(), 0);
});

test("the Mac preview's own limits refuse before any worker: 128,000 characters, complexity, includes", async () => {
  const compiler = createLiveDocCompiler();
  for (const [source, message] of [
    ["a".repeat(128_001), /up to 128,000 characters/],
    ["{ x }\n".repeat(500), /complexity budget/],
    ["@include /other.wd\n", /Included files are not available/],
    ["line\n".repeat(5_001), /5,000 lines/],
  ] as const) {
    const result = await compiler.compile(source);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.kind === "refused" && message.test(result.message), `${source.slice(0, 20)}: ${JSON.stringify(result)}`);
  }
  assert.equal(compiler.workersStarted(), 0);
});

test("a compile past its time limit is stopped, and the next try runs again", async () => {
  // One millisecond is shorter than a worker takes to load the compiler, so
  // this stops every compile at the wall clock, deterministically.
  const compiler = createLiveDocCompiler({ timeoutMs: 1 });
  const result = await compiler.compile("# Slow\n");
  assert.deepEqual(result, { ok: false, kind: "failed", message: "This Live Doc took too long to compile, so it was stopped." });
  await compiler.compile("# Slow\n");
  assert.equal(compiler.workersStarted(), 2, "a timeout is not cached against the document");
});

// A Live Doc inside every source limit that still needs more than 12 MB to compile.
const HEAVY = `:state rows = [${Array.from({ length: 900 }, (_, i) => i).join(", ")}]\n@loop rows into r\n{ r } and some longer text for each row { r }\n@endloop\n`;

test("a compile past its memory limit is stopped, while a small one fits", async () => {
  const compiler = createLiveDocCompiler({ resourceLimits: { maxOldGenerationSizeMb: 12, maxYoungGenerationSizeMb: 2 } });
  assert.ok((await compiler.compile("# Light\n")).ok, "the limit leaves room for an ordinary compile");
  const result = await compiler.compile(HEAVY);
  assert.deepEqual(result, { ok: false, kind: "failed", message: "This Live Doc needed too much memory to compile, so it was stopped." });
  // The production limit compiles the same source.
  assert.ok((await createLiveDocCompiler().compile(HEAVY)).ok);
});

test("the largest source the limits accept compiles under the production memory cap", async () => {
  const paragraph = "A long paragraph of ordinary prose that goes on for a while to fill the document with text. ".repeat(10) + "\n\n";
  let source = "# Big\n\n";
  while (source.length + paragraph.length < 127_000) source += paragraph;
  const result = await createLiveDocCompiler().compile(source);
  assert.ok(result.ok, JSON.stringify(!result.ok && result));
});

test("a memory limit too small to start a worker is raised, never a process crash", async () => {
  // 1 MB of old generation aborts the whole Node process at isolate start.
  // The compiler raises it to its floor, so this fails one compile at most.
  const compiler = createLiveDocCompiler({ resourceLimits: { maxOldGenerationSizeMb: 1, maxYoungGenerationSizeMb: 1 } });
  const result = await compiler.compile("# Tiny\n");
  assert.equal(typeof result.ok, "boolean");
});

test("an unchanged source compiles once; concurrent loads share one compile", async () => {
  const compiler = createLiveDocCompiler();
  const results = await Promise.all([compiler.compile("# Same\n"), compiler.compile("# Same\n"), compiler.compile("# Same\n")]);
  assert.ok(results.every((r) => r.ok));
  assert.equal(compiler.workersStarted(), 1);
  await compiler.compile("# Same\n");
  assert.equal(compiler.workersStarted(), 1);
  await compiler.compile("# Changed\n");
  assert.equal(compiler.workersStarted(), 2);
});

test("past the concurrency and queue bounds, a load is told the host is busy", async () => {
  const compiler = createLiveDocCompiler({ maxConcurrent: 1, maxQueued: 1 });
  const results = await Promise.all([1, 2, 3, 4].map((n) => compiler.compile(`# Doc ${n}\n`)));
  const busy = results.filter((r) => !r.ok && r.kind === "busy");
  assert.equal(busy.length, 2);
  assert.equal(results.filter((r) => r.ok).length, 2);
  assert.ok(compiler.workersStarted() <= 2);
});

test("the worker runs with no environment, no network globals and no file system reads by the compiler", async () => {
  const { readFileSync } = await import("node:fs");
  const worker = readFileSync(new URL("./live-docs-worker.ts", import.meta.url), "utf8");
  for (const name of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"]) assert.ok(worker.includes(`"${name}"`), name);
  const compile = readFileSync(new URL("./live-docs-compile.ts", import.meta.url), "utf8");
  assert.match(compile, /new Worker\(WORKER_URL, \{ resourceLimits, env: \{\}/);
  // The pinned compiler bundle reads only the file map it is handed.
  const bundle = readFileSync(new URL("./generated/darkmown/compiler-browser.mjs", import.meta.url), "utf8");
  for (const pattern of [/\bfetch\(/, /\brequire\(/, /\bimport\(/, /node:/, /readFileSync/, /XMLHttpRequest/, /WebSocket/, /new Function/, /\beval\(/]) {
    assert.ok(!pattern.test(bundle), `compiler bundle contains ${pattern}`);
  }
});
