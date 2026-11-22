// Regenerates tests/goldens from Electron Markie's own Darkmown code: the
// pinned compiler's output (the input the Rust side sanitizes) and the
// finished preview documents for trusted and untrusted frames, with and
// without links and a picture scope. Run from the worktree root:
//   node --import ./rust/scripts/ts-run/register.mjs --import ./rust/crates/markie-web/scripts/raw-hooks.mjs rust/crates/markie-web/scripts/goldens.mjs
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const fixtures = resolve(here, "../tests/fixtures");
const goldens = resolve(here, "../tests/goldens");
const { compileDarkmown } = await import(resolve(repo, "src/lib/darkmown/compiler.ts"));
const { compileDarkmownPreview } = await import(resolve(repo, "src/lib/darkmown/preview.ts"));

// The worker the preview would start, run in place.
const createWorker = () => {
  const listeners = { message: [], error: [], messageerror: [] };
  return {
    addEventListener: (type, fn) => listeners[type].push(fn),
    removeEventListener: (type, fn) => { listeners[type] = listeners[type].filter((f) => f !== fn); },
    terminate() {},
    postMessage(source) {
      queueMicrotask(() => {
        let data;
        try { data = { ok: true, result: compileDarkmown(source) }; } catch (error) { data = { ok: false, error: error.message }; }
        for (const fn of listeners.message) fn({ data });
      });
    },
  };
};

const BASE = "markie-asset://wd-0123456789abcdef0123456789abcdef";
const variants = {
  untrusted: [false, {}],
  trusted: [true, {}],
  "trusted-dark": [true, { colorScheme: "dark" }],
  "untrusted-links": [false, { links: true, pictureBase: BASE }],
  "trusted-links": [true, { links: true, pictureBase: BASE }],
};
for (const name of readdirSync(fixtures).sort()) {
  if (!name.endsWith(".wd")) continue;
  const source = readFileSync(resolve(fixtures, name), "utf8");
  const stem = name.slice(0, -3);
  let compiled;
  try { compiled = compileDarkmown(source); } catch (error) { compiled = { error: error.message }; }
  writeFileSync(resolve(goldens, `${stem}.compiled.json`), JSON.stringify(compiled, null, 1));
  const out = {};
  for (const [variant, [trusted, options]] of Object.entries(variants)) {
    try { out[variant] = await compileDarkmownPreview(source, trusted, { ...options, createWorker }); }
    catch (error) { out[variant] = { error: error.message }; }
  }
  writeFileSync(resolve(goldens, `${stem}.preview.json`), JSON.stringify(out, null, 1));
}
console.log("goldens written to", goldens);
