import { replaceDocxText, type DocxDocument, type DocxTextEdit } from "@/lib/office/docx";

export interface WordTextMatch { paragraphId: string; start: number; end: number }
export function findWordText(document: DocxDocument, query: string): WordTextMatch[] {
  if (!query) return [];
  const matches: WordTextMatch[] = [];
  for (const paragraph of document.paragraphs) {
    let offset = 0;
    while (offset <= paragraph.text.length - query.length) {
      const found = paragraph.text.indexOf(query, offset);
      if (found < 0) break;
      matches.push({ paragraphId: paragraph.id, start: found, end: found + query.length });
      offset = found + query.length;
    }
  }
  return matches;
}

/** Replace literal ranges across runs without flattening unaffected formatting. */
export function replaceWordText(document: DocxDocument, query: string, replacement: string, matchIndex?: number): { document: DocxDocument; count: number } {
  if (!document.canEdit) throw new Error("This Word document is read-only.");
  if (/[\t\r\n]/.test(replacement)) throw new Error("Find and replace cannot insert tabs or paragraph breaks.");
  const all = findWordText(document, query);
  const matches = matchIndex === undefined ? all : all[matchIndex] ? [all[matchIndex]] : [];
  const edits: DocxTextEdit[] = [];
  for (const paragraph of document.paragraphs) {
    const ranges = matches.filter((match) => match.paragraphId === paragraph.id).reverse();
    if (!ranges.length) continue;
    const text = paragraph.runs.map((run) => run.text);
    for (const range of ranges) {
      let offset = 0, inserted = false;
      for (let index = 0; index < paragraph.runs.length; index++) {
        const run = paragraph.runs[index], start = offset, end = offset + run.text.length;
        offset = end;
        if (end <= range.start || start >= range.end) continue;
        if (!run.canEdit) throw new Error("A matching range includes unsupported text and was not changed.");
        text[index] = text[index].slice(0, Math.max(0, range.start - start))
          + (!inserted ? replacement : "") + text[index].slice(Math.min(run.text.length, range.end - start));
        inserted = true;
      }
    }
    paragraph.runs.forEach((run, index) => { if (text[index] !== run.text) edits.push({ runId: run.id, text: text[index] }); });
  }
  return { document: edits.length ? replaceDocxText(document, edits) : document, count: matches.length };
}
