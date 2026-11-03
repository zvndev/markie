// One hosted Live Doc compile, in its own worker thread (live-docs-compile.ts
// starts it, bounds its memory and time, and throws it away afterwards).
//
// It runs the same pinned compiler, limits and sanitizer as the Mac app's
// interactive preview (src/lib/darkmown/compiler.ts and preview.ts), copied
// into server/src/generated/darkmown/ by scripts/sync-darkmown.mjs. The input
// is one .wd source as text. The compiler reads only the in-memory file map it
// is given, includes are refused before it runs, and this worker removes the
// network globals before the compiler is loaded, so a compile has no file
// system or network to reach. The worker is started with an empty environment,
// so none of the server's secrets are in it either.
import { parentPort } from "node:worker_threads";

for (const name of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"]) {
  Reflect.deleteProperty(globalThis, name);
}

const { compileFromMemory } = await import("./generated/darkmown/compiler-browser.mjs");
const { DARKMOWN_OUTPUT_LIMIT, validateDarkmownPreviewSource } = await import("./generated/darkmown/darkmown-limits.mjs");
const { sanitizeDarkmownBody } = await import("./generated/darkmown/security.ts");

// The same virtual path the Mac preview compiles at, so warnings and scope ids match.
const ENTRY_PATH = "site/pages/document.wd";

export interface LiveDocWorkerResult {
  bodyHtml: string;
  seeds: string[];
  title: string;
  warnings: string[];
}

async function compile(source: string): Promise<LiveDocWorkerResult> {
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

parentPort?.once("message", (source: unknown) => {
  if (typeof source !== "string") {
    parentPort?.postMessage({ ok: false, error: "Nothing to compile." });
    return;
  }
  compile(source).then(
    (result) => parentPort?.postMessage({ ok: true, result }),
    (error: unknown) => parentPort?.postMessage({ ok: false, error: (error instanceof Error ? error.message : "The Live Doc compiler failed.").slice(0, 4096) })
  );
});
