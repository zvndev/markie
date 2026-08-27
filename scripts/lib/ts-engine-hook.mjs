// Lets a plain-Node script import the renderer's TypeScript engine modules
// (src/lib/projects/*) without a bundler and without a new dependency.
//
// Node strips types on its own; what it cannot do is resolve the two things
// the renderer's imports assume: the `@/` alias for src/, and an extensionless
// specifier. This resolve hook supplies both, so the engine keeps the import
// style the app and vitest use and no source file has to be reshaped for the
// convenience of a script.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

// Naming the format saves Node a "reparsing as ES module" warning per file,
// and a .ts file must be named as TypeScript or type stripping never runs.
function formatFor(filePath) {
  return /\.tsx?$/.test(filePath) ? "module-typescript" : "module";
}

function withExtension(filePath) {
  if (path.extname(filePath)) return filePath;
  for (const ext of [".ts", ".tsx", ".mjs", ".js"]) {
    if (existsSync(filePath + ext)) return filePath + ext;
  }
  return filePath;
}

export function installTsEngineHook() {
  if (typeof registerHooks !== "function") {
    throw new Error(
      "This script needs Node 22.15 or newer (module.registerHooks). Current: " + process.version
    );
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith("@/")) {
        const target = withExtension(SRC + specifier.slice(2));
        return { url: pathToFileURL(target).href, format: formatFor(target), shortCircuit: true };
      }
      if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
        const resolved = path.resolve(
          path.dirname(fileURLToPath(context.parentURL)),
          specifier
        );
        const withExt = withExtension(resolved);
        if (withExt !== resolved) {
          return {
            url: pathToFileURL(withExt).href,
            format: formatFor(withExt),
            shortCircuit: true,
          };
        }
      }
      return nextResolve(specifier, context);
    },
  });
}
