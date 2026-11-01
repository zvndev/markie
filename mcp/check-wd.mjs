// Reading a Darkmown document the way Markie will, without a window.
//
// An agent cannot run the preview, so a document that stops with [WD201], or prints
// "{ nmae }", or quietly loses its :fetch, looks finished to the agent that wrote it
// and broken to the person who opens it. This compiles with the same pinned compiler
// and the same pre-compile limits the app uses, and reports all three.
//
// FEATURES is a copy of what src/lib/darkmown/security.ts removes from compiled
// output. That sanitizer needs a real HTML parser, and this server takes no
// dependencies, so it reads the output with patterns instead.
// src/lib/darkmown/check-wd-parity.test.ts holds the two to the same answer.
// Self-contained: no imports from outside mcp/ (see the scan.mjs header).
import { basename } from "node:path";
import { DARKMOWN_OUTPUT_LIMIT, validateDarkmownPreviewSource } from "./darkmown-limits.mjs";

const ENTRY_PATH = "site/pages/document.wd";

// The attribute that marks each feature in compiled output, and what to tell the agent.
const FEATURES = [
  [/\sdata-wd-fetch[\s=>-]/, ":fetch does not run: an interactive document has no network access yet."],
  [/\sdata-wd-store[\s=>-]/, ":store does not run: nothing is kept, and it loses its starting value. Use :state."],
  [/\sdata-wd-persist[\s=>-]/, "persist does not run: nothing is kept between openings."],
  [/\sdata-wd-every[\s=>-]/, ":every does not run: an interactive document has no timers yet."],
  [/\sdata-wd-effect[\s=>-]/, ":effect does not run yet."],
  [/\sdata-wd-theme[\s=>-]/, ":theme does not run yet."],
  [/\sdata-wd-url[\s=>-]/, "from-url does not run: the document has no address to read."],
  [/\sdata-wd-(?:each-)?attr[\s=>-]/, "A bound link or picture does not run yet."],
  [/\sdata-wd-(?:each-)?class[\s=>-]/, "A class that switches with state does not run: a .wd has no custom styling yet."],
  [/<a\s(?![^>]*class="wd-skip-link")[^>]*href=/, "A link shows as plain text: an interactive document cannot navigate yet."],
  [/<(?:img|picture)[\s>]/, "A picture does not show: an interactive document cannot load files yet."],
  [/<(?:video|audio|iframe|embed|object)[\s>]/, "Video, audio and embeds do not show yet."],
  [/<(?:svg|math|style|noscript)[\s>]/, "This block of markup does not show."],
  [/<table[\s\S]*?\sstyle="text-align/, "Column alignment colons in a table are dropped."],
  [/<form\s(?![^>]*data-wd-form)/, "A form that posts somewhere does not run: only a :form into state does."],
  [/\sstyle=/, "Inline styles are dropped."],
];

const relabel = (text, name) => text.replaceAll(`/${ENTRY_PATH}`, name).replaceAll(ENTRY_PATH, name);

function bodyOf(html) {
  const start = html.indexOf("<body>");
  const end = html.lastIndexOf("</body>");
  return start === -1 || end === -1 ? html : html.slice(start, end);
}

/**
 * @param {string} source the document's text
 * @param {string} docPath its path, for messages
 * @returns {Promise<{ path: string, ok: boolean, errors: string[], warnings: string[], switchedOff: string[], interactive: boolean, summary: string }>}
 */
export async function checkDarkmown(source, docPath) {
  const name = basename(docPath);
  const finish = (fields) => ({
    path: docPath,
    ok: fields.errors.length === 0 && fields.warnings.length === 0 && fields.switchedOff.length === 0,
    errors: fields.errors,
    warnings: fields.warnings,
    switchedOff: fields.switchedOff,
    interactive: fields.interactive,
    summary: fields.errors.length
      ? `${name} stops with an error in Markie's preview. Fix it, then check again.`
      : fields.warnings.length + fields.switchedOff.length
        ? `${name} compiles, but ${fields.warnings.length + fields.switchedOff.length} thing(s) will not work as written.`
        : `${name} compiles, and everything in it runs in Markie after the reader chooses Trust this document.`,
  });
  try {
    validateDarkmownPreviewSource(source);
    // Loaded on first use: it is the largest module here, and most sessions never check a .wd.
    const { compileFromMemory } = await import("./darkmown-compiler.mjs");
    const compiled = compileFromMemory({ [ENTRY_PATH]: source }, ENTRY_PATH, { cwd: "/" });
    if (compiled.html.length > DARKMOWN_OUTPUT_LIMIT) {
      return finish({ errors: ["This document compiles to more than an interactive preview can show."], warnings: [], switchedOff: [], interactive: false });
    }
    const body = bodyOf(compiled.html);
    return finish({
      errors: [],
      warnings: compiled.warnings.map((warning) => relabel(warning, name)),
      switchedOff: FEATURES.filter(([pattern]) => pattern.test(body)).map(([, message]) => message),
      interactive: compiled.assets.runtime,
    });
  } catch (error) {
    return finish({ errors: [relabel(error instanceof Error ? error.message : String(error), name)], warnings: [], switchedOff: [], interactive: false });
  }
}
