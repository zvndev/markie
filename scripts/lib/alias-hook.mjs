// Lets a check script import the app's own modules by the "@/..." path the app
// uses everywhere. Bare Node knows nothing about tsconfig paths, so without
// this a script can only reach a file that happens to have no internal imports,
// which is a constraint on what may be verified rather than on what may be
// written.
//
// Loaded with --import; the hook is synchronous and applies to the whole
// process, which is what the ESM resolver needs before it sees the first
// specifier.
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const srcDir = path.resolve(new URL("../../src", import.meta.url).pathname);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const target = path.join(srcDir, specifier.slice(2));
      // The app writes imports without an extension; on disk they are .ts or .tsx.
      for (const candidate of [target, `${target}.ts`, `${target}.tsx`, path.join(target, "index.ts")]) {
        try {
          return nextResolve(pathToFileURL(candidate).href, context);
        } catch {
          // try the next shape
        }
      }
      return nextResolve(specifier, context);
    }

    // A relative extensionless import (buildPDFHTML pulls in
    // "./katex-css.generated") resolves fine for the app's own bundler, but
    // bare Node has nothing to try but the literal specifier. Same retry as
    // the @/ branch above, just without rewriting into src/: relative
    // resolution already anchors to the importing file via context.parentURL.
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      try {
        return nextResolve(specifier, context);
      } catch {
        for (const candidate of [`${specifier}.ts`, `${specifier}.tsx`]) {
          try {
            return nextResolve(candidate, context);
          } catch {
            // try the next shape
          }
        }
      }
    }

    return nextResolve(specifier, context);
  },
});
