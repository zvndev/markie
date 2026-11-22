// Runs Electron Markie's own palette ranking (src/lib/commands.ts
// `filterCommands`) and Library query (src/lib/library-document-query.ts
// `queryLibraryDocuments`) on fixed inputs and writes what they return to
// rust/crates/markie-app/src/fixtures/library-settings-parity.json. The
// Markie RS tests `palette::tests::ranking_matches_electrons_filter_commands`
// and `library::tests::recent_query_matches_electrons_query_library_documents`
// read that file and must produce the same order.
//
//   node --import ./rust/scripts/ts-run/register.mjs rust/scripts/parity/library-settings-parity.mjs
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { filterCommands } from "../../../src/lib/commands.ts";
import { queryLibraryDocuments, libraryDocumentFormat } from "../../../src/lib/library-document-query.ts";

const here = dirname(fileURLToPath(import.meta.url));

// Titles, groups and keywords as page.tsx declares them.
const commands = [
  ["Open File…", "File", ""],
  ["New Markdown document", "File", "md markdown"],
  ["New Word document", "File", "docx office"],
  ["Save", "File", ""],
  ["Save As…", "File", ""],
  ["Duplicate (Fork)", "File", "copy fork duplicate"],
  ["Reveal in Finder", "File", "finder explorer folder show reveal drag locate"],
  ["Export PDF (Dark)", "File", "print"],
  ["Rich Mode", "View", "preview rich wysiwyg formatted view"],
  ["Source Mode", "View", "source raw markdown edit"],
  ["Split Mode", "View", "both side by side"],
  ["Statistics", "View", "words count reading"],
  ["Find…", "View", "search find text"],
  ["Find and Replace…", "View", "search find replace all substitute"],
  ["Copy File Path", "File", "link location terminal clipboard"],
  ["Format Tables", "Format", "align prettify pipes"],
  ["Theme: Paper", "Theme", "template style color font typography Warm print"],
  ["Theme Settings…", "Theme", "color font preset style"],
  ["Settings…", "File", "account sign in sync login"],
  ["Search All Documents…", "File", "find files everywhere full text docx rtf word grep content global"],
  ["Library…", "File", "documents cloud sync files recent projects organize workspace group"],
  ["Keyboard Shortcuts", "Help", "help keys"],
].map(([title, group, keywords], i) => ({ id: String(i), title, group, keywords, run() {} }));
const queries = ["sav", "s", "find", "the", "mode", "fk", "theme", "view", "set", "doc", "x", "sh", "file", "copy", "zzz", "Save"];
const palette = Object.fromEntries(queries.map((q) => [q, filterCommands(commands, q).map((c) => c.title)]));

// Library rows in the panel's order (newest open first).
const rows = [
  ["/w/Notes/Trip.md", 9], ["/w/Notes/budget.xlsx", 8], ["/w/b.docx", 7], ["/w/a.doc", 7], ["/w/Notes/trip plan.txt", 6],
  ["/w/zeta.rtf", 5], ["/w/Alpha.odt", 4], ["/w/data.csv", 3], ["/w/page.html", 2], ["/w/alpha.md", 1], ["/w/x/Beta.wd", 0],
].map(([path, at]) => ({ path, name: path.split("/").pop(), at: 1_700_000_000_000 + at * 1000 }));
const meta = (r) => ({ key: r.path, name: r.name, path: r.path, format: libraryDocumentFormat(r.name), updatedAt: r.at });
const cases = [];
for (const search of ["", "trip", "notes trip", "ALPHA", "w", "plan notes", "nope"]) {
  for (const format of ["all", "markdown", "other", "doc"]) {
    for (const sort of ["default", "recent", "name", "type"]) {
      cases.push({ search, format, sort, paths: queryLibraryDocuments(rows, { search, format, sort }, meta).map((r) => r.path) });
    }
  }
}

const out = resolve(here, "../../crates/markie-app/src/fixtures/library-settings-parity.json");
writeFileSync(out, JSON.stringify({ palette: { commands: commands.map(({ title, group, keywords }) => ({ title, group, keywords })), results: palette }, library: { rows: rows.map(({ path, at }) => ({ path, at })), cases } }, null, 1) + "\n");
console.log(`wrote ${out}: ${queries.length} palette queries, ${cases.length} library cases`);
