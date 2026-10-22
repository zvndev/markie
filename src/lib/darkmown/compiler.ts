import { compileFromMemory } from "./vendor/compiler-browser.mjs";
import { DARKMOWN_OUTPUT_LIMIT, validateDarkmownPreviewSource, type CompiledDarkmownDocument } from "./compiler-types";
export { DARKMOWN_RUNTIME_SOURCE } from "./runtime";
export { DARKMOWN_SOURCE_LIMIT, type CompiledDarkmownDocument } from "./compiler-types";
const ENTRY_PATH = "site/pages/document.wd";

/** Compile exactly the supplied source. No disk, URL or adjacent-file reads. */
export function compileDarkmown(source: string): CompiledDarkmownDocument {
  validateDarkmownPreviewSource(source);
  const compiled = compileFromMemory({ [ENTRY_PATH]: source }, ENTRY_PATH, { cwd: "/" });
  if (compiled.html.length > DARKMOWN_OUTPUT_LIMIT) {
    throw new Error("This interactive preview is too large. Your source remains available to edit and save.");
  }
  const start = compiled.html.indexOf("<body>\n");
  const end = compiled.html.lastIndexOf("\n</body>");
  if (start === -1 || end <= start) throw new Error("Darkmown did not produce a document body.");
  return {
    bodyHtml: compiled.html.slice(start + "<body>\n".length, end),
    title: String(compiled.meta.title || "Interactive document"),
    warnings: [...compiled.warnings],
    requiresRuntime: compiled.assets.runtime,
    hasCode: compiled.assets.hasCode,
  };
}
