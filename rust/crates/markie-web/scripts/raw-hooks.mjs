// Node hooks for the two Vite-only imports Electron's Darkmown modules use:
// `file?raw` (the file's text as the default export) and `.json` (parsed).
// Use after rust/scripts/ts-run/register.mjs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("?raw")) {
      const base = next(specifier.slice(0, -4), context);
      return { url: `${base.url}?raw`, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith("?raw")) {
      const text = readFileSync(fileURLToPath(url.slice(0, -4)), "utf8");
      return { format: "module", source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
    }
    if (url.startsWith("file:") && url.endsWith(".json")) {
      return { format: "module", source: `export default ${readFileSync(fileURLToPath(url), "utf8")};`, shortCircuit: true };
    }
    return next(url, context);
  },
});
