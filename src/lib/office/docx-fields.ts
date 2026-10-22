/** Original ECMA-376 §17.16.18 complex-field scan (fldChar begin/separate/end
 * around instrText codes and a cached result). Field codes and results are
 * preserved verbatim. Word regenerates a result when the field updates, so a
 * hand edit there would be silently discarded later: runs inside a field are
 * never text-editable, and paragraphs a field touches refuse structural edits.
 * https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.fieldchar
 */
import { isWord } from "./docx-edit";
import { xmlAttribute, xmlDescendants, type XmlElement } from "./xml";

export interface DocxFieldScan {
  /** Start offsets of runs that belong to a field (code, separator or result). */
  readonly runs: ReadonlySet<number>;
  /** Start offsets of paragraphs that contain field runs or lie inside a field. */
  readonly paragraphs: ReadonlySet<number>;
  /** Start offsets of paragraphs whose paragraph mark is inside an open field. */
  readonly openAfter: ReadonlySet<number>;
  readonly problem?: string;
}

export function scanDocxFields(root: XmlElement): DocxFieldScan {
  const runs = new Set<number>(), paragraphs = new Set<number>(), openAfter = new Set<number>();
  let depth = 0;
  for (const paragraph of xmlDescendants(root).filter((n) => isWord(n, "p"))) {
    for (const run of xmlDescendants(paragraph).filter((n) => isWord(n, "r"))) {
      let inside = depth > 0;
      for (const child of run.children) {
        if (isWord(child, "instrText")) inside = true;
        if (!isWord(child, "fldChar")) continue;
        inside = true;
        const type = xmlAttribute(child, "fldCharType", child.namespace);
        if (type === "begin") depth++;
        else if (type === "end") { if (--depth < 0) return { runs, paragraphs, openAfter, problem: "Field end has no matching field start." }; }
        else if (type !== "separate" || depth === 0) return { runs, paragraphs, openAfter, problem: "Field separator is outside a field." };
      }
      if (inside) { runs.add(run.start); paragraphs.add(paragraph.start); }
    }
    if (depth > 0) { openAfter.add(paragraph.start); paragraphs.add(paragraph.start); }
  }
  if (depth !== 0) return { runs, paragraphs, openAfter, problem: "Field start has no matching field end." };
  return { runs, paragraphs, openAfter };
}
