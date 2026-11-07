// The hosted compile cannot hurt the server. Every compile runs in its own
// child process, so a compile that runs out of memory, hangs or misbehaves
// ends that process and nothing else. A source over the size or complexity
// limits never starts a process, a compile that runs too long is killed, one
// that needs too much memory dies alone, and nothing about a stopped compile
// sticks to the document. The child sees no environment and, under Node's
// permission model, cannot read beyond the compiler's own files.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createLiveDocCompiler, interpretLiveDocChildRun, runLiveDocChild, LIVE_DOC_COMPILER_VERSION, LIVE_DOC_HEAP,
  LIVE_DOC_PERMISSION_FLAG, LIVE_DOC_SOURCE_LIMIT, type LiveDocChildRun, type LiveDocCompilerOptions,
} from "./live-docs-compile.ts";

const PROVENANCE = (await import("./generated/darkmown/PROVENANCE.json", { with: { type: "json" } })).default as { version: string; commit: string };

// Every child any test starts, so the last check can prove none outlived its compile.
const spawned: number[] = [];
const onSpawn = (pid: number) => spawned.push(pid);
const compilerFor = (options: LiveDocCompilerOptions = {}) => createLiveDocCompiler({ onSpawn, ...options });

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

// A probe runs in exactly the sandbox a compile gets (runLiveDocChild's
// flags, environment and permissions), but does what a test asks instead of
// compiling. It reads the same {"source": …} input; here the source is a task.
const PROBE = `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const task = JSON.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")).source);
if (task.mode === "hang") for (;;) {}
if (task.mode === "oom") {
  const keep = [];
  for (;;) keep.push(new Array(100_000).fill(Math.random()));
}
if (task.mode === "flood") {
  process.stdout.write("x".repeat(task.bytes));
} else {
  const fs = await import("node:fs");
  const out = { env: Object.keys(process.env), permission: typeof process.permission?.has === "function" };
  const attempt = async (name, run) => {
    try { await run(); out[name] = "allowed"; } catch (error) { out[name] = error.code ?? error.name; }
  };
  for (const [index, file] of task.files.entries()) await attempt("read" + index, () => fs.readFileSync(file));
  await attempt("write", () => fs.writeFileSync(task.write, "x"));
  await attempt("spawn", async () => (await import("node:child_process")).spawnSync(process.execPath, ["-v"]));
  await attempt("worker", async () => new (await import("node:worker_threads")).Worker("0", { eval: true }).terminate());
  await attempt("addon", () => process.dlopen({ exports: {} }, task.addon));
  await attempt("eval", () => eval("1"));
  process.stdout.write(JSON.stringify(out) + "\\n");
}
`;

let scratch = "";
let probe = "";
before(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "live-docs-compile-")));
  probe = path.join(scratch, "probe.mjs");
  writeFileSync(probe, PROBE);
  writeFileSync(path.join(scratch, "secret.txt"), "not for a compile");
});

const runProbe = (task: object, options: { timeoutMs?: number; maxOldSpaceMb?: number; stdoutBytes?: number } = {}) =>
  runLiveDocChild(JSON.stringify(task), {
    script: probe,
    timeoutMs: options.timeoutMs ?? 20_000,
    heap: { maxOldSpaceMb: options.maxOldSpaceMb ?? LIVE_DOC_HEAP.maxOldSpaceMb, maxSemiSpaceMb: LIVE_DOC_HEAP.maxSemiSpaceMb },
    stdoutBytes: options.stdoutBytes,
    onSpawn,
  });

after(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("a small Live Doc compiles in a child process to sanitized output", async () => {
  const compiler = compilerFor();
  const result = await compiler.compile(':state count = 2\n\n# Hi\n\n{ count }\n\n:button "More" -> count++\n');
  assert.ok(result.ok, JSON.stringify(result));
  assert.match(result.page.bodyHtml, /<h1>Hi<\/h1>/);
  assert.match(result.page.bodyHtml, /<button data-wd-action="inc" data-wd-target="count" type="button">More<\/button>/);
  assert.deepEqual(result.page.seeds, ['{"count":2}']);
  assert.deepEqual(result.page.warnings, []);
  assert.equal(compiler.childrenStarted(), 1);
});

test("a source Darkmown rejects comes back as a refusal, and is cached", async () => {
  const compiler = compilerFor();
  const result = await compiler.compile("@loop x\n");
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.kind === "refused" && /Missing @endloop/.test(result.message), JSON.stringify(result));
  await compiler.compile("@loop x\n");
  assert.equal(compiler.childrenStarted(), 1);
});

test("the cache key names the pinned compiler", () => {
  assert.equal(LIVE_DOC_COMPILER_VERSION, `${PROVENANCE.version}+${PROVENANCE.commit.slice(0, 12)}`);
});

test("a source over 200,000 characters is refused without a child", async () => {
  const compiler = compilerFor();
  const result = await compiler.compile("a".repeat(LIVE_DOC_SOURCE_LIMIT + 1));
  assert.deepEqual(result, { ok: false, kind: "refused", message: "Live Docs can be up to 200,000 characters." });
  assert.equal(compiler.childrenStarted(), 0);
});

test("the Mac preview's own limits refuse before any child: 128,000 characters, complexity, includes", async () => {
  const compiler = compilerFor();
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
  assert.equal(compiler.childrenStarted(), 0);
});

test("a compile past its time limit is killed, remembered for a while, then tried again", async () => {
  // One millisecond is shorter than a process takes to load the compiler, so
  // this stops every compile at the wall clock, deterministically.
  const pids: number[] = [];
  const compiler = compilerFor({ timeoutMs: 1, onSpawn: (pid) => { pids.push(pid); onSpawn(pid); } });
  const result = await compiler.compile("# Slow\n");
  assert.deepEqual(result, { ok: false, kind: "failed", message: "This Live Doc took too long to compile, so it was stopped." });
  assert.deepEqual(await compiler.compile("# Slow\n"), result);
  assert.equal(compiler.childrenStarted(), 1, "a reload of a source that just failed starts no new process");
  // Once the failure is old enough, the next load tries again.
  const forgetful = compilerFor({ timeoutMs: 1, failedTtlMs: 0, onSpawn: (pid) => { pids.push(pid); onSpawn(pid); } });
  await forgetful.compile("# Slow\n");
  await forgetful.compile("# Slow\n");
  assert.equal(forgetful.childrenStarted(), 2);
  assert.equal(pids.length, 3);
  for (const pid of pids) assert.equal(isRunning(pid), false, `compile process ${pid} is still running`);
});

test("one owner cannot hold every compile slot, or more than their share of the queue", async () => {
  const compiler = compilerFor({ timeoutMs: UNHURRIED, maxConcurrent: 2, maxQueued: 16, maxRunningPerOwner: 1, maxInFlightPerOwner: 2 });
  const doc = (n: number) => `# Doc ${n}\n\nUnique body ${n} ${Math.random()}\n`;
  // The heavy owner opens five different documents at once: one runs, one
  // waits, and three are told "busy" for them alone.
  const heavy = [0, 1, 2, 3, 4].map((n) => compiler.compile(doc(n), "heavy"));
  // Someone else still gets the second slot straight away.
  const other = await compiler.compile(doc(99), "other");
  assert.ok(other.ok, JSON.stringify(other));
  const results = await Promise.all(heavy);
  assert.equal(results.filter((result) => result.ok).length, 2);
  assert.equal(results.filter((result) => !result.ok && result.kind === "busy").length, 3);
  // Their limit is about what is in flight, so it frees up as compiles finish.
  assert.ok((await compiler.compile(doc(5), "heavy")).ok);
});

test("warnings are not kept with a compiled page", async () => {
  const result = await compilerFor({ timeoutMs: UNHURRIED }).compile(":nope one\n:nope two\n\n# Page\n");
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.page.warnings, []);
});

test("a child that never finishes is killed with SIGKILL at the time limit", async () => {
  const started = Date.now();
  const run = await runProbe({ mode: "hang" }, { timeoutMs: 500 });
  assert.equal(run.end, "timeout");
  assert.equal(run.signal, "SIGKILL");
  assert.ok(Date.now() - started < 10_000, "the kill does not wait for the child");
  assert.ok(run.pid !== undefined);
  assert.equal(isRunning(run.pid), false, "the hung child is gone once the run resolves");
  assert.deepEqual(interpretLiveDocChildRun(run), { ok: false, kind: "failed", message: "This Live Doc took too long to compile, so it was stopped." });
});

test("a hard V8 out-of-memory abort in the child leaves this process alive and its memory untouched", async () => {
  // The kind of failure that aborted the whole test process in CI when
  // compiles ran in worker threads: V8's FatalProcessOutOfMemory, then SIGABRT.
  // The child is allowed far more heap than this process could give away
  // unnoticed, so a heap that was ours would show.
  const before = process.memoryUsage();
  const run = await runProbe({ mode: "oom" }, { maxOldSpaceMb: 192 });
  const afterRun = process.memoryUsage();
  assert.equal(run.end, "exited");
  assert.ok(run.signal === "SIGABRT" || (run.code !== null && run.code !== 0), `${run.code} ${run.signal}`);
  assert.match(run.stderr, /heap out of memory/);
  assert.deepEqual(interpretLiveDocChildRun(run), { ok: false, kind: "failed", message: "This Live Doc needed too much memory to compile, so it was stopped." });
  const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
  assert.ok(afterRun.heapUsed - before.heapUsed < 32 * 1024 * 1024, `this process's heap grew ${mb(afterRun.heapUsed - before.heapUsed)} MB`);
  assert.ok(afterRun.rss - before.rss < 96 * 1024 * 1024, `this process's memory grew ${mb(afterRun.rss - before.rss)} MB`);
  // And this process carries on compiling.
  const next = await compilerFor().compile("# After the crash\n");
  assert.ok(next.ok, JSON.stringify(next));
});

// A Live Doc inside every source limit that needs more than 24 MB of old
// generation to compile, where "# Light" needs about 12 MB. Measured on Node
// 22 and 26 in a child process (2026-11-03): this 1,200-row loop with 600
// characters a row fails at 24 MB every time and compiles at 32 MB. 18 MB sits
// about 6 MB from both, so the memory test below does not ride a boundary.
// The memory tests measure memory, not speed: a slow machine (or an emulated
// one, where a compile takes seconds) must not turn them into timeouts.
const UNHURRIED = 60_000;

const HEAVY = `:state rows = [${Array.from({ length: 1200 }, (_, i) => i).join(", ")}]\n@loop rows into r\n{ r } ${
  "and some longer text for each row ".repeat(18).slice(0, 600)
} { r }\n@endloop\n`;

test("a real compile past its memory limit dies alone, while a small one fits", async () => {
  const compiler = compilerFor({ timeoutMs: UNHURRIED, heap: { maxOldSpaceMb: 18, maxSemiSpaceMb: LIVE_DOC_HEAP.maxSemiSpaceMb } });
  const light = await compiler.compile("# Light\n");
  assert.ok(light.ok, `the limit leaves room for an ordinary compile: ${JSON.stringify(light)}`);
  const result = await compiler.compile(HEAVY);
  assert.deepEqual(result, { ok: false, kind: "failed", message: "This Live Doc needed too much memory to compile, so it was stopped." });
  // Remembered: a reload of the same source starts no new process.
  assert.deepEqual(await compiler.compile(HEAVY), result);
  assert.equal(compiler.childrenStarted(), 2);
  // The production limit compiles the same source.
  const production = await compilerFor({ timeoutMs: UNHURRIED }).compile(HEAVY);
  assert.ok(production.ok, JSON.stringify(production));
});

test("the largest source the limits accept compiles under the production memory cap", async () => {
  const paragraph = "A long paragraph of ordinary prose that goes on for a while to fill the document with text. ".repeat(10) + "\n\n";
  let source = "# Big\n\n";
  while (source.length + paragraph.length < 127_000) source += paragraph;
  const result = await compilerFor({ timeoutMs: UNHURRIED }).compile(source);
  assert.ok(result.ok, JSON.stringify(!result.ok && result));
});

test("a heap too small for Node to start fails that one compile, never the server", async () => {
  // A 1 MB worker heap aborted the whole server process. A child with 1 MB
  // dies before it reads its input, and this process just reports it.
  const result = await compilerFor({ heap: { maxOldSpaceMb: 1, maxSemiSpaceMb: 1 } }).compile("# Tiny\n");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.kind, "failed");
  assert.ok((await compilerFor().compile("# Tiny\n")).ok);
});

test("an unchanged source compiles once; concurrent loads share one compile", async () => {
  const compiler = compilerFor();
  const results = await Promise.all([compiler.compile("# Same\n"), compiler.compile("# Same\n"), compiler.compile("# Same\n")]);
  assert.ok(results.every((r) => r.ok));
  assert.equal(compiler.childrenStarted(), 1);
  await compiler.compile("# Same\n");
  assert.equal(compiler.childrenStarted(), 1);
  await compiler.compile("# Changed\n");
  assert.equal(compiler.childrenStarted(), 2);
});

test("past the concurrency and queue bounds, a load is told the host is busy", async () => {
  const compiler = compilerFor({ maxConcurrent: 1, maxQueued: 1 });
  const results = await Promise.all([1, 2, 3, 4].map((n) => compiler.compile(`# Doc ${n}\n`)));
  const busy = results.filter((r) => !r.ok && r.kind === "busy");
  assert.equal(busy.length, 2);
  assert.equal(results.filter((r) => r.ok).length, 2);
  assert.ok(compiler.childrenStarted() <= 2);
});

test("the child sees no environment, and the permission model keeps it to the compiler's own files", async () => {
  process.env.LIVE_DOC_TEST_SECRET = "must not reach a compile";
  let run: LiveDocChildRun;
  try {
    run = await runProbe({
      files: [
        path.join(scratch, "secret.txt"),
        path.join(import.meta.dirname, "..", "package.json"),
        path.join(import.meta.dirname, "live-docs-compile.ts"),
      ],
      write: path.join(scratch, "written.txt"),
      addon: path.join(scratch, "addon.node"),
    });
  } finally {
    delete process.env.LIVE_DOC_TEST_SECRET;
  }
  assert.equal(run.code, 0, run.stderr);
  const out = JSON.parse(run.stdout) as Record<string, unknown>;
  // macOS itself sets __CF_USER_TEXT_ENCODING in every new process; nothing else may appear.
  const env = (out.env as string[]).filter((name) => !(process.platform === "darwin" && name === "__CF_USER_TEXT_ENCODING"));
  assert.deepEqual(env, [], "the child's environment is empty");
  assert.ok(["--permission", "--experimental-permission"].includes(LIVE_DOC_PERMISSION_FLAG));
  assert.equal(out.permission, true, "the permission model is on in the child");
  assert.equal(out.read0, "ERR_ACCESS_DENIED", "an arbitrary file");
  assert.equal(out.read1, "ERR_ACCESS_DENIED", "the server's package.json");
  assert.equal(out.read2, "ERR_ACCESS_DENIED", "the server's own source");
  assert.equal(out.write, "ERR_ACCESS_DENIED");
  assert.equal(out.spawn, "ERR_ACCESS_DENIED");
  assert.equal(out.worker, "ERR_ACCESS_DENIED");
  assert.ok(out.addon === "ERR_DLOPEN_DISABLED" || out.addon === "ERR_ACCESS_DENIED", String(out.addon));
  assert.equal(out.eval, "EvalError", "no code generation from strings");
  assert.equal(existsSync(path.join(scratch, "written.txt")), false);
});

test("a child that floods stdout is killed at the cap and its output is not trusted", async () => {
  const run = await runProbe({ mode: "flood", bytes: 1024 * 1024 }, { stdoutBytes: 64 * 1024 });
  assert.equal(run.end, "overflow");
  assert.ok(run.stdout.length <= 64 * 1024);
  assert.deepEqual(interpretLiveDocChildRun(run), { ok: false, kind: "failed", message: "The Live Doc compiler returned an invalid result." });
});

test("only exactly one line of the reply protocol is accepted", () => {
  const run = (stdout: string, extra: Partial<LiveDocChildRun> = {}): LiveDocChildRun =>
    ({ pid: 1, end: "exited", code: 0, signal: null, stdout, stderr: "", ...extra });
  const page = { bodyHtml: "<p>Hi</p>", seeds: [], title: "", warnings: [] };
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  assert.deepEqual(interpretLiveDocChildRun(run(line({ ok: true, result: page }))), { ok: true, page });
  assert.deepEqual(interpretLiveDocChildRun(run(line({ ok: false, error: "Bad source" }))), { ok: false, kind: "refused", message: "Bad source" });
  const invalid = { ok: false, kind: "failed", message: "The Live Doc compiler returned an invalid result." };
  for (const stdout of [
    "",
    JSON.stringify({ ok: true, result: page }),
    line({ ok: true, result: page }) + line({ ok: true, result: page }),
    `noise\n${line({ ok: true, result: page })}`,
    line({ ok: true, result: page, extra: 1 }),
    line({ ok: true, result: { ...page, script: "x" } }),
    line({ ok: true, result: { ...page, bodyHtml: 1 } }),
    line({ ok: true, result: { ...page, seeds: [1] } }),
    line({ ok: true, result: [page] }),
    line({ ok: false, error: "x".repeat(4097) }),
    line({ ok: false }),
    line({ ok: "true", result: page }),
    line([]),
    "{ not json }\n",
  ]) {
    assert.deepEqual(interpretLiveDocChildRun(run(stdout)), invalid, stdout.slice(0, 80));
  }
  // A valid-looking reply from a process that did not exit cleanly is not a result.
  assert.deepEqual(interpretLiveDocChildRun(run(line({ ok: true, result: page }), { code: 1 })), { ok: false, kind: "failed", message: "The Live Doc compiler failed." });
  assert.deepEqual(interpretLiveDocChildRun(run(line({ ok: true, result: page }), { code: null, signal: "SIGTERM" })), { ok: false, kind: "failed", message: "The Live Doc compiler stopped before it finished." });
});

test("every sample Live Doc compiles inside the sandbox", async (t) => {
  const samples = path.resolve(import.meta.dirname, "../../docs/document-testing/samples");
  if (!existsSync(samples)) {
    t.skip("the samples are not in this checkout (the server image ships server/ alone)");
    return;
  }
  const compiler = compilerFor({ maxConcurrent: 4 });
  const names = readdirSync(samples).filter((name) => name.endsWith(".wd"));
  assert.ok(names.length > 0);
  const results = await Promise.all(names.map((name) => compiler.compile(readFileSync(path.join(samples, name), "utf8"))));
  results.forEach((result, index) => assert.ok(result.ok, `${names[index]}: ${JSON.stringify(result)}`));
});

test("the child removes the network globals, and the compiler bundle reads only the file map it is handed", () => {
  const child = readFileSync(new URL("./live-docs-child.ts", import.meta.url), "utf8");
  for (const name of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"]) assert.ok(child.includes(`"${name}"`), name);
  const bundle = readFileSync(new URL("./generated/darkmown/compiler-browser.mjs", import.meta.url), "utf8");
  for (const pattern of [/\bfetch\(/, /\brequire\(/, /\bimport\(/, /node:/, /readFileSync/, /XMLHttpRequest/, /WebSocket/, /new Function/, /\beval\(/]) {
    assert.ok(!pattern.test(bundle), `compiler bundle contains ${pattern}`);
  }
});

test("no compile process outlives its compile", () => {
  assert.ok(spawned.length > 10, `only ${spawned.length} children were started`);
  const left = spawned.filter(isRunning);
  assert.deepEqual(left, [], "every child has exited");
});
