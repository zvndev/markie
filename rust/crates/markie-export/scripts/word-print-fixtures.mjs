// Writes the Word print fixtures and Electron's print HTML for each.
//
// Each fixture is built with Electron Markie's own TypeScript (docx.ts and
// docx-print.fixture.ts), saved as .docx under tests/fixtures/word, and its
// `buildDocxPrintHTML` page is written to .autoloop/runs/native-print/word.
// Printing those pages with Electron's printToPDF options gives the
// reference PDFs that tests/office_print.rs measures pagination against.
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const fixtures = resolve(here, "../tests/fixtures/word");
const out = resolve(repo, ".autoloop/runs/native-print/word");
mkdirSync(fixtures, { recursive: true });
mkdirSync(out, { recursive: true });

const { applyDocxOperations, createDocx, exportDocx, openDocx } = await import(resolve(repo, "src/lib/office/docx.ts"));
const { buildDocxPrintHTML, canPrintDocx } = await import(resolve(repo, "src/lib/office/docx-print.ts"));
const { printDocxFixture, printBreakDocxFixture } = await import(resolve(repo, "src/lib/office/docx-print.fixture.ts"));

const lorem = [
  "Markie keeps documents as files you own, on your own disk, in formats other programs open.",
  "A long paragraph wraps across several lines so that a page boundary can fall inside it, which is where orphan and widow rules decide what moves to the next page and what stays behind on this one.",
  "Short line.",
  "Printing a Word document follows the supported view: paragraphs, lists, tables, pictures and explicit page breaks, set in Georgia at twelve points unless a run says otherwise, with each paragraph's spacing and line height.",
  "Tables never split a row across two pages; a row that does not fit moves whole to the next page, taking its borders with it.",
];

/** A document long enough to paginate naturally, with every rule that moves a break. */
async function paginationFixture() {
  let doc = await createDocx("Pagination proof");
  doc = applyDocxOperations(doc, [
    { type: "set-page-layout", layout: { paper: "a4", marginTopPoints: 72, marginRightPoints: 72, marginBottomPoints: 72, marginLeftPoints: 72 } },
    { type: "format-run", runId: doc.paragraphs[0].runs[0].id, style: { bold: true, fontSizePoints: 22 } },
    { type: "format-paragraph", paragraphId: doc.paragraphs[0].id, format: { spacingAfterPoints: 16 } },
  ]);
  const append = (text, format, list) => {
    doc = applyDocxOperations(doc, [{ type: "insert-paragraph", text }]);
    const p = doc.paragraphs.at(-1);
    if (format) doc = applyDocxOperations(doc, [{ type: "format-paragraph", paragraphId: p.id, format }]);
    if (list) doc = applyDocxOperations(doc, [{ type: "set-list", paragraphId: p.id, kind: list }]);
    return doc.paragraphs.at(-1);
  };
  const multiples = [1, 1.15, 1.4, 2, 1.5, 1.08];
  const aligns = ["left", "both", "center", "right"];
  for (let i = 0; i < 46; i++) {
    const text = i % 9 === 4 ? "" : `${i + 1}. ${lorem[i % lorem.length]}${i % 3 === 0 ? " " + lorem[(i + 1) % lorem.length] : ""}`;
    const format = { lineSpacingMultiple: multiples[i % multiples.length], spacingBeforePoints: (i % 4) * 3, spacingAfterPoints: [0, 6, 8, 12, 18][i % 5], alignment: aligns[i % aligns.length] };
    const p = append(text, format, i % 11 === 7 ? "bullet" : i % 11 === 8 ? "numbered" : null);
    if (i % 7 === 2 && p.runs.length) doc = applyDocxOperations(doc, [{ type: "format-run", runId: p.runs[0].id, style: { fontSizePoints: 15, italic: true } }]);
    if (i === 20) {
      const cells = Array.from({ length: 14 }, (_, r) => [`Row ${r + 1}`, lorem[r % lorem.length], r % 3 === 0 ? lorem[(r + 3) % lorem.length] : "Short"]);
      doc = applyDocxOperations(doc, [{ type: "insert-table", afterParagraphId: p.id, rows: 14, columns: 3, cells }]);
    }
  }
  return { document: await openDocx(await exportDocx(doc)) };
}

/** Lines at multiples below 1.4: every one-line paragraph is held to min-height 1.4em. */
async function minHeightFixture() {
  let doc = await createDocx("Tight lines");
  for (let i = 0; i < 70; i++) {
    doc = applyDocxOperations(doc, [{ type: "insert-paragraph", text: i % 6 === 5 ? "" : `Line ${i + 1} ${i % 4 === 0 ? lorem[1] : "single"}` }]);
    const p = doc.paragraphs.at(-1);
    doc = applyDocxOperations(doc, [{ type: "format-paragraph", paragraphId: p.id, format: { lineSpacingMultiple: [1, 0.8, 1.2, 1][i % 4], spacingAfterPoints: [0, 2, 4][i % 3] } }]);
  }
  return { document: await openDocx(await exportDocx(doc)) };
}

const all = {
  "print": printDocxFixture(),
  "break-leading": printBreakDocxFixture("leading"),
  "break-trailing": printBreakDocxFixture("trailing"),
  "break-consecutive": printBreakDocxFixture("consecutive"),
  "break-middle": printBreakDocxFixture("middle"),
  "pagination": paginationFixture(),
  "min-height": minHeightFixture(),
};
for (const [name, pending] of Object.entries(all)) {
  const { document } = await pending;
  if (!canPrintDocx(document)) throw new Error(`${name} is not printable`);
  writeFileSync(resolve(fixtures, `${name}.docx`), await exportDocx(document));
  writeFileSync(resolve(out, `${name}.html`), buildDocxPrintHTML(document, name));
}
console.log(fixtures, out);
