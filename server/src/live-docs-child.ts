// One hosted Live Doc compile, in its own process. live-docs-compile.ts starts
// it with a heap ceiling, an empty environment, Node's permission model and a
// wall-clock limit, and it handles exactly one source before it exits.
//
// The protocol is strict. The parent writes one JSON object, {"source": "…"},
// to stdin and closes it. This process writes exactly one line of JSON to
// stdout and exits 0:
//
//   {"ok":true,"result":{"bodyHtml":"…","seeds":[…],"title":"…","warnings":[…]}}
//   {"ok":false,"error":"<why Darkmown refused the source>"}
//
// Anything else (a crash, an out-of-memory abort, a non-zero exit, a second
// line, a field too many) is a failed compile, which the parent never caches.
// Nothing else may reach stdout: the console is silenced before the compiler
// loads, and only the reply below writes there.
//
// It runs the same pinned compiler, limits and sanitizer as the Mac app's
// interactive preview (src/lib/darkmown/compiler.ts and preview.ts), copied
// into server/src/generated/darkmown/ by scripts/sync-darkmown.mjs. The
// compiler reads only the in-memory file map it is given, includes are refused
// before it runs, and the network globals are removed before it loads. The
// permission model lets this process read only this file, that folder and the
// sanitizer's node_modules, and start no process, worker or addon.
const writeReply = process.stdout.write.bind(process.stdout);
const silent = () => {};
for (const method of Object.keys(console)) {
  if (typeof (console as unknown as Record<string, unknown>)[method] === "function") {
    (console as unknown as Record<string, unknown>)[method] = silent;
  }
}
process.stdout.write = (() => true) as typeof process.stdout.write;

for (const name of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"]) {
  Reflect.deleteProperty(globalThis, name);
}

const { compileFromMemory } = await import("./generated/darkmown/compiler-browser.mjs");
const { DARKMOWN_OUTPUT_LIMIT, validateDarkmownPreviewSource } = await import("./generated/darkmown/darkmown-limits.mjs");
const { sanitizeDarkmownBody } = await import("./generated/darkmown/security.ts");

// The same virtual path the Mac preview compiles at, so warnings and scope ids match.
const ENTRY_PATH = "site/pages/document.wd";
// The parent sends at most 200,000 characters; JSON escaping and UTF-8 stay well inside this.
const INPUT_LIMIT_BYTES = 4 * 1024 * 1024;

export interface LiveDocPage {
  bodyHtml: string;
  seeds: string[];
  title: string;
  warnings: string[];
}

async function readSource(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length;
    if (size > INPUT_LIMIT_BYTES) throw new Error("The Live Doc compiler was sent too much input.");
    chunks.push(chunk as Buffer);
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!input || typeof input !== "object" || Object.keys(input).join(",") !== "source") {
    throw new Error("The Live Doc compiler was sent something other than a source.");
  }
  const { source } = input as { source: unknown };
  if (typeof source !== "string") throw new Error("The Live Doc compiler was sent something other than a source.");
  return source;
}

async function compile(source: string): Promise<LiveDocPage> {
  validateDarkmownPreviewSource(source);
  const compiled = compileFromMemory({ [ENTRY_PATH]: source }, ENTRY_PATH, { cwd: "/" });
  if (compiled.html.length > DARKMOWN_OUTPUT_LIMIT) throw new Error("This Live Doc compiles to a page that is too large to host.");
  const start = compiled.html.indexOf("<body>\n");
  const end = compiled.html.lastIndexOf("\n</body>");
  if (start === -1 || end <= start) throw new Error("Darkmown did not produce a document body.");
  // Hosted pages always run the runtime: they are served on their own
  // origin under a CSP that admits only the pinned runtime (live-docs-page.ts).
  const clean = await sanitizeDarkmownBody(compiled.html.slice(start + "<body>\n".length, end), true);
  const title = compiled.meta.title;
  return {
    bodyHtml: clean.bodyHtml,
    seeds: clean.seeds,
    title: typeof title === "string" ? title : "",
    warnings: [...compiled.warnings, ...clean.warnings],
  };
}

// A Node error (a denied read, a module that will not load) is about this
// process, not the source. It ends the process, so the parent reports a
// failure it does not cache instead of a refusal it would.
const isNodeError = (error: unknown) => {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === "string" && code.startsWith("ERR_");
};

const source = await readSource();
let reply: { ok: true; result: LiveDocPage } | { ok: false; error: string };
try {
  reply = { ok: true, result: await compile(source) };
} catch (error) {
  if (isNodeError(error)) throw error;
  reply = { ok: false, error: (error instanceof Error ? error.message : "The Live Doc compiler failed.").slice(0, 4096) };
}
writeReply(`${JSON.stringify(reply)}\n`, () => process.exit(0));
