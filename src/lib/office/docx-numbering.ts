/** Original ECMA-376 §17.9 multi-level numbering. The package carries real
 * abstract/instance definitions, not literal bullet text or CSS. Formatting
 * subtrees inside a level (pPr/rPr) are preserved untouched; only the counter
 * semantics needed for display and safe list assignment are modeled.
 */
import { DocxError } from "./docx-types";
import { DOCX_PARAGRAPH_PROPERTY_ORDER, docxPropertyPatch, isWord, patchDocxSource, wordChild, type DocxEditState } from "./docx-edit";
import { appendDocxXml, docxPartSource, ensureDocxPart, relatedDocxPart, type DocxPartsState } from "./docx-parts";
import { parseXml, xmlAttribute, xmlDescendants, type XmlElement } from "./xml";
const encoder = new TextEncoder();
const attribute = (node: XmlElement | undefined, name: string) => node && xmlAttribute(node, name, node.namespace);
export interface DocxNumberingLevel { kind: "bullet" | "numbered"; start: number; restart?: number }
export interface DocxNumbering { id: string; levels: ReadonlyMap<number, DocxNumberingLevel> }
interface Inspection { definitions: ReadonlyMap<string, DocxNumbering>; problem?: string }
const NUMBERED_FORMATS = new Set(["decimal", "decimalZero", "lowerLetter", "upperLetter", "lowerRoman", "upperRoman", "ordinal", "hex"]);
const ABSTRACT_CHILDREN = new Set(["nsid", "multiLevelType", "name", "styleLink", "numStyleLink", "tmpl", "lvl"]);

function boundedInt(raw: string | undefined, min: number, max: number): number | undefined {
  return raw !== undefined && /^\d+$/.test(raw) && Number(raw) >= min && Number(raw) <= max ? Number(raw) : undefined;
}

function parseLevel(node: XmlElement): { level: number; definition: DocxNumberingLevel } | undefined {
  const level = boundedInt(attribute(node, "ilvl"), 0, 8);
  const format = attribute(wordChild(node, "numFmt"), "val");
  const startRaw = attribute(wordChild(node, "start"), "val");
  const restartRaw = attribute(wordChild(node, "lvlRestart"), "val");
  const start = startRaw === undefined ? 1 : boundedInt(startRaw, 0, 999999);
  const restart = restartRaw === undefined ? undefined : boundedInt(restartRaw, 0, 9);
  if (level === undefined || start === undefined || (restartRaw !== undefined && restart === undefined) || wordChild(node, "lvlPicBulletId")) return undefined;
  if (format === "bullet") return { level, definition: { kind: "bullet", start, restart } };
  if (format && NUMBERED_FORMATS.has(format)) return { level, definition: { kind: "numbered", start, restart } };
  return undefined;
}

export function inspectDocxNumbering(state: DocxPartsState): Inspection {
  const name = relatedDocxPart(state, "numbering");
  const source = name && docxPartSource(state, name);
  if (!source) return { definitions: new Map() };
  const root = parseXml(source);
  if (!isWord(root, "numbering") || root.children.length > 2000) return { definitions: new Map(), problem: "Unsupported numbering root or too many lists." };
  const abstracts = new Map<string, ReadonlyMap<number, DocxNumberingLevel>>();
  const definitions = new Map<string, DocxNumbering>();
  if (root.children.some((n) => !isWord(n) || !["abstractNum", "num", "numPicBullet"].includes(n.localName))) {
    return { definitions, problem: "Numbering part contains unsupported top-level content." };
  }
  for (const node of root.children.filter((n) => isWord(n, "abstractNum"))) {
    const id = attribute(node, "abstractNumId");
    const multiLevelType = attribute(wordChild(node, "multiLevelType"), "val");
    if (!id || !/^(?:0|[1-9]\d{0,8})$/.test(id) || abstracts.has(id)
      || node.children.some((c) => !isWord(c) || !ABSTRACT_CHILDREN.has(c.localName))
      || (multiLevelType !== undefined && !["singleLevel", "multilevel", "hybridMultilevel"].includes(multiLevelType))) {
      return { definitions, problem: "List definition is outside the editable numbering subset." };
    }
    const levels = new Map<number, DocxNumberingLevel>();
    for (const levelNode of node.children.filter((n) => isWord(n, "lvl"))) {
      const parsed = parseLevel(levelNode);
      if (!parsed || levels.has(parsed.level)) return { definitions, problem: "List level is missing, duplicated or unsupported." };
      levels.set(parsed.level, parsed.definition);
    }
    if (!levels.size || levels.size > 9) return { definitions, problem: "List definition has no usable levels." };
    abstracts.set(id, levels);
  }
  for (const node of root.children.filter((n) => isWord(n, "num"))) {
    const id = attribute(node, "numId");
    const abstract = abstracts.get(attribute(wordChild(node, "abstractNumId"), "val") || "");
    if (!id || !/^[1-9]\d{0,8}$/.test(id) || definitions.has(id) || !abstract
      || node.children.some((c) => !isWord(c) || !["abstractNumId", "lvlOverride"].includes(c.localName))
      || node.children.filter((c) => isWord(c, "abstractNumId")).length !== 1) {
      return { definitions, problem: "Numbering instance is missing or unsupported." };
    }
    const levels = new Map(abstract);
    for (const override of node.children.filter((n) => isWord(n, "lvlOverride"))) {
      const level = boundedInt(attribute(override, "ilvl"), 0, 8);
      const replacement = wordChild(override, "lvl");
      const startRaw = attribute(wordChild(override, "startOverride"), "val");
      if (level === undefined) return { definitions, problem: "Numbering level override is unsupported." };
      if (replacement) {
        const parsed = parseLevel(replacement);
        if (!parsed || parsed.level !== level) return { definitions, problem: "Numbering level override is unsupported." };
        levels.set(level, parsed.definition);
      } else if (startRaw !== undefined) {
        const start = boundedInt(startRaw, 0, 999999);
        const base = levels.get(level);
        if (start === undefined || !base) return { definitions, problem: "Numbering level override is unsupported." };
        levels.set(level, { ...base, start });
      }
    }
    definitions.set(id, { id, levels });
  }
  return { definitions };
}

export function ensureDocxList<T extends DocxPartsState & DocxEditState>(state: T, kind: "bullet" | "numbered"): { state: T; id: string } {
  const inspected = inspectDocxNumbering(state);
  if (inspected.problem) throw new DocxError("unsupported-numbering", inspected.problem);
  const existing = [...inspected.definitions.values()].find((d) => d.levels.get(0)?.kind === kind);
  if (existing) return { state, id: existing.id };
  const namespace = parseXml(state.source).namespace;
  const ensured = ensureDocxPart(state, "numbering", "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml", `<w:numbering xmlns:w="${namespace}"/>`, namespace);
  const source = docxPartSource(ensured.state, ensured.name)!;
  const root = parseXml(source);
  const abstractId = String(root.children.filter((n) => isWord(n, "abstractNum")).reduce((max, n) => Math.max(max, Number(attribute(n, "abstractNumId"))), -1) + 1);
  const id = String([...inspected.definitions.keys()].reduce((max, value) => Math.max(max, Number(value)), 0) + 1);
  const abstract = `<w:abstractNum xmlns:w="${namespace}" w:abstractNumId="${abstractId}"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${kind === "bullet" ? "bullet" : "decimal"}"/><w:lvlText w:val="${kind === "bullet" ? "•" : "%1."}"/><w:suff w:val="space"/></w:lvl></w:abstractNum>`;
  const num = `<w:num xmlns:w="${namespace}" w:numId="${id}"><w:abstractNumId w:val="${abstractId}"/></w:num>`;
  // Abstract definitions must precede all instance definitions in the schema.
  const firstNum = root.children.find((n) => isWord(n, "num"));
  const withAbstract = firstNum ? source.slice(0, firstNum.start) + abstract + source.slice(firstNum.start) : appendDocxXml(source, abstract);
  const partOverrides = new Map(ensured.state.partOverrides);
  partOverrides.set(ensured.name, encoder.encode(appendDocxXml(withAbstract, num)));
  return { state: { ...state, partOverrides }, id };
}

export function setDocxList<T extends DocxPartsState & DocxEditState>(state: T, paragraphId: string, kind: "bullet" | "numbered" | null): T {
  if (kind !== null && !["bullet", "numbered"].includes(kind)) throw new DocxError("invalid-format", "Unsupported list type.");
  const ensured = kind === null ? { state, id: "" } : ensureDocxList(state, kind);
  const next = ensured.state;
  const root = parseXml(next.source);
  const paragraph = xmlDescendants(root).find((n) => isWord(n, "p") && next.identities.get(n.start) === paragraphId);
  if (!paragraph) throw new DocxError("invalid-edit", "Unknown paragraph identity.");
  const properties = wordChild(paragraph, "pPr");
  const current = wordChild(properties, "numPr");
  const content = kind === null ? "" : `<w:numPr xmlns:w="${paragraph.namespace}"><w:ilvl w:val="0"/><w:numId w:val="${ensured.id}"/></w:numPr>`;
  if (current) return { ...next, ...patchDocxSource(next, [{ start: current.start, end: current.end, text: content }]) };
  if (!content) return next;
  // numPr goes to its schema position; other (possibly unmodeled) paragraph
  // properties keep theirs.
  return { ...next, ...patchDocxSource(next, [docxPropertyPatch(next, paragraph, "pPr", new Map([["numPr", content]]), DOCX_PARAGRAPH_PROPERTY_ORDER)]) };
}
