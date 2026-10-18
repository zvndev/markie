import type { DocxParagraph, DocxTextEdit } from "@/lib/office/docx";

/** Private input adapter. Source-owned runs stay authoritative; DOM spans are not an editing model. */
export function paragraphInput(paragraph: DocxParagraph, start: number, end: number, text: string, deletion?: "backward" | "forward"): { edits: DocxTextEdit[]; caret: number } {
  const reject = () => { throw new Error("This input cannot safely edit the selected text. Select editable text within one paragraph."); };
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > paragraph.text.length || /[\r\n\t]/.test(text) || paragraph.revisionIds.length) reject();
  const boundaries = [0, ...Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(paragraph.text), (part) => part.index + part.segment.length)];
  if (!boundaries.includes(start) || !boundaries.includes(end)) reject();
  if (start === end && deletion === "backward") start = boundaries[Math.max(0, boundaries.indexOf(start) - 1)];
  else if (start === end && deletion === "forward") end = boundaries[Math.min(boundaries.length - 1, boundaries.indexOf(end) + 1)];
  if (paragraph.text.slice(start, end) === text) return { edits: [], caret: start + text.length };
  const edits: DocxTextEdit[] = [];
  let offset = 0, inserted = false;
  for (const run of paragraph.runs) {
    const from = offset, to = offset + run.text.length; offset = to;
    const overlap = from < end && to > start;
    const insertion = !inserted && (start >= from && start < to || start === paragraph.text.length && to === start);
    if (!overlap && !insertion) continue;
    if (!run.canEdit || run.hyperlinkId || run.pageBreaks.length) reject();
    const next = run.text.slice(0, Math.max(0, start - from)) + (!inserted ? text : "") + run.text.slice(Math.min(run.text.length, Math.max(0, end - from)));
    inserted = true;
    if (next !== run.text) edits.push({ runId: run.id, text: next });
  }
  if (!inserted) reject();
  return { edits, caret: start + text.length };
}
