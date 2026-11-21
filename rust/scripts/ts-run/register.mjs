// `node --import <this file> script.ts` runs the repo's own TypeScript sources
// unchanged. Node's built-in type stripping refuses parameter properties, which
// the vault code uses, so each .ts file is transpiled with the repo's
// TypeScript. Extensionless relative imports and the "@/" alias resolve to .ts.
// Needs the repo's node_modules (a symlink in a worktree, never committed).
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire, registerHooks } from "node:module";

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
const ts = createRequire(resolvePath(repo, "package.json"))("typescript");

const isFile = (file) => { try { return existsSync(file) && statSync(file).isFile(); } catch { return false; } };

registerHooks({
  resolve(specifier, context, next) {
    let base = null;
    if (specifier.startsWith("@/")) base = resolvePath(repo, "src", specifier.slice(2));
    else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
      base = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
    }
    if (base) {
      for (const file of [base, `${base}.ts`, `${base}.tsx`, resolvePath(base, "index.ts")]) {
        if (isFile(file)) return { url: pathToFileURL(file).href, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith("file:") && /\.tsx?$/.test(url)) {
      const fileName = fileURLToPath(url);
      const out = ts.transpileModule(readFileSync(fileName, "utf8"), {
        fileName,
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, isolatedModules: true },
      });
      return { format: "module", source: out.outputText, shortCircuit: true };
    }
    return next(url, context);
  },
});
